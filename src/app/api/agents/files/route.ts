import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getAgentById } from "@/lib/agents/registry";
import {
  ensureWorkspaceScaffold,
  getWorkspaceDir,
  WORKSPACE_EDITABLE_FILE_NAMES,
} from "@/lib/workspace/files";
import { requireOperatorAccess } from "@/lib/security/admin";

export const dynamic = "force-dynamic";

const ALLOWED_NAMES = new Set<string>(WORKSPACE_EDITABLE_FILE_NAMES);

const WriteFileSchema = z.object({
  agentId: z.string().min(1),
  name: z.string().min(1),
  content: z.string(),
});

function resolveAgentWorkspace(agentIdRaw: string): { agentId: string; workspaceDir: string } {
  const agentId = agentIdRaw.trim();
  const agent = getAgentById(agentId);
  if (!agent) {
    throw new Error(`Agent not found: ${agentId}`);
  }
  ensureWorkspaceScaffold({ workspacePath: agent.workspacePath });
  return { agentId: agent.id, workspaceDir: getWorkspaceDir({ workspacePath: agent.workspacePath }) };
}

function mapErrorStatus(error: unknown): number {
  const message = String(error);
  if (message.includes("Agent not found")) return 404;
  if (message.includes("Unsupported file") || message.includes("Unsafe file path")) return 400;
  return 500;
}

function resolveFilePath(workspaceDir: string, nameRaw: string): { name: string; filePath: string } {
  const name = nameRaw.trim();
  if (!ALLOWED_NAMES.has(name)) {
    throw new Error(`Unsupported file "${name}"`);
  }

  const filePath = path.resolve(workspaceDir, name);
  const normalizedRoot = workspaceDir + path.sep;
  if (filePath !== workspaceDir && !filePath.startsWith(normalizedRoot)) {
    throw new Error(`Unsafe file path "${name}"`);
  }
  return { name, filePath };
}

function statFileMeta(filePath: string): { size: number; updatedAtMs: number } | null {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) {
      return null;
    }
    return {
      size: stat.size,
      updatedAtMs: Math.floor(stat.mtimeMs),
    };
  } catch {
    return null;
  }
}

function readFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function buildFileEntry(workspaceDir: string, name: string) {
  const filePath = path.resolve(workspaceDir, name);
  const meta = statFileMeta(filePath);
  return {
    name,
    path: filePath,
    missing: !meta,
    size: meta?.size,
    updatedAtMs: meta?.updatedAtMs,
  };
}

export async function GET(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const { searchParams } = new URL(request.url);
    const agentId = searchParams.get("agentId");
    if (!agentId) {
      return NextResponse.json({ success: false, error: "Missing agentId" }, { status: 400 });
    }

    const { workspaceDir } = resolveAgentWorkspace(agentId);
    const name = searchParams.get("name");

    if (name) {
      const resolved = resolveFilePath(workspaceDir, name);
      const entry = buildFileEntry(workspaceDir, resolved.name);
      if (entry.missing) {
        return NextResponse.json({
          success: true,
          data: {
            agentId,
            workspace: workspaceDir,
            file: entry,
          },
        });
      }

      const content = readFile(resolved.filePath);
      if (content === null) {
        return NextResponse.json(
          { success: false, error: `Failed to read file "${resolved.name}"` },
          { status: 500 },
        );
      }

      return NextResponse.json({
        success: true,
        data: {
          agentId,
          workspace: workspaceDir,
          file: {
            ...entry,
            missing: false,
            content,
          },
        },
      });
    }

    const files = Array.from(ALLOWED_NAMES).map((fileName) => buildFileEntry(workspaceDir, fileName));
    return NextResponse.json({
      success: true,
      data: {
        agentId,
        workspace: workspaceDir,
        files,
      },
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: mapErrorStatus(error) });
  }
}

async function writeFile(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const body = await request.json();
    const parsed = WriteFileSchema.parse(body);
    const { agentId, workspaceDir } = resolveAgentWorkspace(parsed.agentId);
    const { name, filePath } = resolveFilePath(workspaceDir, parsed.name);

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, parsed.content, "utf-8");
    const meta = statFileMeta(filePath);

    return NextResponse.json({
      success: true,
      data: {
        ok: true,
        agentId,
        workspace: workspaceDir,
        file: {
          name,
          path: filePath,
          missing: false,
          size: meta?.size,
          updatedAtMs: meta?.updatedAtMs,
          content: parsed.content,
        },
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: String(error) }, { status: mapErrorStatus(error) });
  }
}

export async function PUT(request: NextRequest) {
  return writeFile(request);
}

export async function POST(request: NextRequest) {
  return writeFile(request);
}
