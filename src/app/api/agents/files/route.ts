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
import { PROTECTED_PROFILE_FILE_NAMES } from "@/lib/security/profile-file-guard";
import {
  deleteProfileRevision,
  getProfileRevision,
  listProfileRevisions,
  profileContentHash,
  recordProfileRevision,
} from "@/lib/governance/profile-revisions";

export const dynamic = "force-dynamic";

const ALLOWED_NAMES = new Set<string>(WORKSPACE_EDITABLE_FILE_NAMES);

const WriteFileSchema = z.object({
  agentId: z.string().min(1).max(128),
  name: z.string().min(1).max(128),
  content: z.string().max(1_000_000),
  confirmed: z.literal(true),
  expectedContentHash: z.string().regex(/^[a-f0-9]{64}$/i),
});

const RollbackSchema = z.object({
  action: z.literal("rollback"),
  agentId: z.string().min(1).max(128),
  revisionId: z.string().min(1).max(128),
  expectedContentHash: z.string().regex(/^[a-f0-9]{64}$/i),
  confirmed: z.literal(true),
});

const PROTECTED_PROFILE_NAMES = new Set<string>(PROTECTED_PROFILE_FILE_NAMES);
const profileFileLocks = new Map<string, Promise<void>>();

async function withProfileFileLock<T>(filePath: string, operation: () => Promise<T> | T): Promise<T> {
  const previous = profileFileLocks.get(filePath) ?? Promise.resolve();
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.catch(() => {}).then(() => gate);
  profileFileLocks.set(filePath, tail);
  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
    if (profileFileLocks.get(filePath) === tail) profileFileLocks.delete(filePath);
  }
}

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

function assertSafeWritableFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) {
    throw new Error("Unsafe file path: workspace files must be regular, non-linked files");
  }
}

function atomicWriteFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(temporaryPath, content, "utf-8");
    fs.renameSync(temporaryPath, filePath);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
}

function buildFileEntry(workspaceDir: string, name: string) {
  const filePath = path.resolve(workspaceDir, name);
  const meta = statFileMeta(filePath);
  const content = meta ? readFile(filePath) : null;
  return {
    name,
    path: filePath,
    missing: !meta,
    size: meta?.size,
    updatedAtMs: meta?.updatedAtMs,
    contentHash: profileContentHash(content ?? ""),
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

    const { agentId: resolvedAgentId, workspaceDir } = resolveAgentWorkspace(agentId);
    const name = searchParams.get("name");

    if (searchParams.get("revisions") === "1") {
      if (name) resolveFilePath(workspaceDir, name);
      return NextResponse.json({
        success: true,
        data: { revisions: listProfileRevisions(resolvedAgentId, name, 30) },
      });
    }

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

    return await withProfileFileLock(filePath, () => {
    assertSafeWritableFile(filePath);
    const existingContent = readFile(filePath);
    if (fs.existsSync(filePath) && existingContent === null) {
      throw new Error(`Failed to read file "${name}" before writing`);
    }
    const beforeContent = existingContent ?? "";
    if (profileContentHash(beforeContent) !== parsed.expectedContentHash) {
      return NextResponse.json({
        success: false,
        error: "This startup profile changed after it was loaded. Reload it, review the newer content, and try again.",
        code: "profile_conflict",
      }, { status: 409 });
    }
    if (beforeContent === parsed.content) {
      const meta = statFileMeta(filePath);
      return NextResponse.json({
        success: true,
        data: {
          ok: true,
          unchanged: true,
          agentId,
          workspace: workspaceDir,
          file: {
            name,
            path: filePath,
            missing: false,
            size: meta?.size,
            updatedAtMs: meta?.updatedAtMs,
            content: beforeContent,
            contentHash: profileContentHash(beforeContent),
            revision: null,
          },
        },
      });
    }
    const revision = PROTECTED_PROFILE_NAMES.has(name)
      ? recordProfileRevision({
          agentId,
          fileName: name,
          beforeContent,
          afterContent: parsed.content,
          source: "edit",
          rolledBackFromRevisionId: null,
        })
      : null;
    try {
      atomicWriteFile(filePath, parsed.content);
    } catch (error) {
      if (revision) deleteProfileRevision(revision.id);
      throw error;
    }
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
          contentHash: profileContentHash(parsed.content),
          revision,
        },
      },
    });
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
  const body = await request.clone().json().catch(() => null);
  if (body?.action !== "rollback") return writeFile(request);
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const parsed = RollbackSchema.parse(body);
    const { agentId, workspaceDir } = resolveAgentWorkspace(parsed.agentId);
    const revision = getProfileRevision(parsed.revisionId);
    if (!revision || revision.agentId !== agentId) {
      return NextResponse.json({ success: false, error: "Profile revision not found" }, { status: 404 });
    }
    const { filePath } = resolveFilePath(workspaceDir, revision.fileName);
    return await withProfileFileLock(filePath, () => {
    assertSafeWritableFile(filePath);
    const existingContent = readFile(filePath);
    if (fs.existsSync(filePath) && existingContent === null) {
      throw new Error(`Failed to read file "${revision.fileName}" before rollback`);
    }
    const beforeContent = existingContent ?? "";
    if (profileContentHash(beforeContent) !== parsed.expectedContentHash) {
      return NextResponse.json({
        success: false,
        error: "This startup profile changed after version history was opened. Reload it, review the newer content, and try again.",
        code: "profile_conflict",
      }, { status: 409 });
    }
    if (beforeContent === revision.beforeContent) {
      return NextResponse.json({ success: true, data: { revision: null, content: beforeContent, unchanged: true } });
    }
    const rollback = recordProfileRevision({
      agentId,
      fileName: revision.fileName,
      beforeContent,
      afterContent: revision.beforeContent,
      source: "rollback",
      rolledBackFromRevisionId: revision.id,
    });
    try {
      atomicWriteFile(filePath, revision.beforeContent);
    } catch (error) {
      deleteProfileRevision(rollback.id);
      throw error;
    }
    return NextResponse.json({ success: true, data: { revision: rollback, content: revision.beforeContent } });
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: String(error) }, { status: mapErrorStatus(error) });
  }
}
