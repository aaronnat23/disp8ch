import { NextRequest, NextResponse } from "next/server";
import { join, resolve, extname, basename, dirname } from "node:path";
import { readdir, readFile, writeFile, stat, lstat, realpath } from "node:fs/promises";
import { requireOperatorAccess } from "@/lib/security/admin";
import { assertCanonicalPathInsideRoot, assertNoSymlinkedSensitiveTarget, getSensitivePathMatch } from "@/lib/security/path-safety";

const DATA_ROOT = resolve(process.cwd(), "data");
const WORKSPACE_ROOT = resolve(DATA_ROOT, "workspace");
const LOGS_ROOT = resolve(DATA_ROOT, "logs");
const MEMORIES_ROOT = resolve(DATA_ROOT, "memories");

// Extensions allowed to be read/displayed
const TEXT_EXTS = new Set([
  ".md", ".txt", ".json", ".ts", ".tsx", ".js", ".jsx",
  ".py", ".sh", ".yaml", ".yml", ".toml", ".log", ".csv",
  ".html", ".css", ".env.example",
]);

// Paths that are read-only (cannot be written)
function isReadOnly(absPath: string): boolean {
  return absPath.startsWith(LOGS_ROOT) || absPath.startsWith(MEMORIES_ROOT);
}

// Validate path is inside allowed roots and has a safe extension
function validatePath(rel: string): { absPath: string; error?: string } {
  // Reject obvious traversal attempts
  if (rel.includes("..") || rel.includes("\0")) {
    return { absPath: "", error: "Invalid path" };
  }

  // Determine base root from path prefix, stripping the root segment
  let absPath: string;
  if (rel.startsWith("logs/") || rel === "logs") {
    const sub = rel.replace(/^logs\/?/, "");
    absPath = sub ? resolve(LOGS_ROOT, sub) : LOGS_ROOT;
    if (!absPath.startsWith(LOGS_ROOT)) return { absPath: "", error: "Path out of bounds" };
  } else if (rel.startsWith("memories/") || rel === "memories") {
    const sub = rel.replace(/^memories\/?/, "");
    absPath = sub ? resolve(MEMORIES_ROOT, sub) : MEMORIES_ROOT;
    if (!absPath.startsWith(MEMORIES_ROOT)) return { absPath: "", error: "Path out of bounds" };
  } else if (rel.startsWith("workspace/") || rel === "workspace") {
    const sub = rel.replace(/^workspace\/?/, "");
    absPath = sub ? resolve(WORKSPACE_ROOT, sub) : WORKSPACE_ROOT;
    if (!absPath.startsWith(WORKSPACE_ROOT)) return { absPath: "", error: "Path out of bounds" };
  } else {
    // bare path — treat as relative to WORKSPACE_ROOT
    absPath = resolve(WORKSPACE_ROOT, rel);
    if (!absPath.startsWith(WORKSPACE_ROOT)) return { absPath: "", error: "Path out of bounds" };
  }

  const ext = extname(absPath).toLowerCase();
  if (ext && !TEXT_EXTS.has(ext)) {
    return { absPath: "", error: `File type '${ext}' not allowed` };
  }

  return { absPath };
}

async function assertFileApiPathIsSafe(absPath: string, root: string): Promise<string> {
  const canonical = assertCanonicalPathInsideRoot(absPath, root);
  try {
    const targetStat = await lstat(absPath);
    if (targetStat.isSymbolicLink()) {
      throw new Error("Symlink targets are not allowed here");
    }
  } catch (error) {
    const message = String(error);
    if (!message.includes("ENOENT")) {
      throw error;
    }
  }
  const parent = dirname(absPath);
  if (parent && parent !== absPath) {
    try {
      const parentReal = await realpath(parent);
      assertCanonicalPathInsideRoot(parentReal, root);
    } catch (error) {
      const message = String(error);
      if (!message.includes("ENOENT")) {
        throw error;
      }
    }
  }
  return canonical;
}

type FileEntry = {
  name: string;
  path: string;
  type: "file" | "dir";
  size?: number;
  ext?: string;
};

async function listDir(absPath: string, relBase: string): Promise<FileEntry[]> {
  const entries = await readdir(absPath, { withFileTypes: true });
  const result: FileEntry[] = [];

  for (const e of entries) {
    const childRel = relBase ? `${relBase}/${e.name}` : e.name;
    if (e.isDirectory()) {
      // Skip hidden dirs, __pycache__, node_modules etc.
      if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "__pycache__") continue;
      result.push({ name: e.name, path: childRel, type: "dir" });
    } else if (e.isFile()) {
      const ext = extname(e.name).toLowerCase();
      if (!ext || TEXT_EXTS.has(ext)) {
        try {
          const s = await stat(join(absPath, e.name));
          result.push({ name: e.name, path: childRel, type: "file", size: s.size, ext: ext || undefined });
        } catch {
          // skip unreadable
        }
      }
    }
  }
  return result.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export async function GET(req: NextRequest) {
  const denied = await requireOperatorAccess(req);
  if (denied) return denied;
  const { searchParams } = new URL(req.url);
  const action = searchParams.get("action") ?? "list";
  const pathParam = (searchParams.get("path") ?? "").replace(/^\/+/, "");

  if (action === "list") {
    try {
      // Top-level: show workspace, logs, memories roots
      if (!pathParam) {
        const roots: FileEntry[] = [
          { name: "workspace", path: "workspace", type: "dir" },
          { name: "logs", path: "logs", type: "dir" },
          { name: "memories", path: "memories", type: "dir" },
        ];
        return NextResponse.json({ success: true, data: roots });
      }

      let absPath: string;
      let relBase: string;

      if (pathParam === "workspace" || pathParam.startsWith("workspace/")) {
        const sub = pathParam.replace(/^workspace\/?/, "");
        absPath = sub ? resolve(WORKSPACE_ROOT, sub) : WORKSPACE_ROOT;
        if (!absPath.startsWith(WORKSPACE_ROOT)) {
          return NextResponse.json({ success: false, error: "Path out of bounds" }, { status: 400 });
        }
        relBase = pathParam;
      } else if (pathParam === "logs" || pathParam.startsWith("logs/")) {
        const sub = pathParam.replace(/^logs\/?/, "");
        absPath = sub ? resolve(LOGS_ROOT, sub) : LOGS_ROOT;
        if (!absPath.startsWith(LOGS_ROOT)) {
          return NextResponse.json({ success: false, error: "Path out of bounds" }, { status: 400 });
        }
        relBase = pathParam;
      } else if (pathParam === "memories" || pathParam.startsWith("memories/")) {
        const sub = pathParam.replace(/^memories\/?/, "");
        absPath = sub ? resolve(MEMORIES_ROOT, sub) : MEMORIES_ROOT;
        if (!absPath.startsWith(MEMORIES_ROOT)) {
          return NextResponse.json({ success: false, error: "Path out of bounds" }, { status: 400 });
        }
        relBase = pathParam;
      } else {
        return NextResponse.json({ success: false, error: "Unknown root" }, { status: 400 });
      }

      const entries = await listDir(absPath, relBase);
      return NextResponse.json({ success: true, data: entries });
    } catch (err) {
      return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
    }
  }

  if (action === "read") {
    if (!pathParam) {
      return NextResponse.json({ success: false, error: "path required" }, { status: 400 });
    }
    const { absPath, error } = validatePath(pathParam);
    if (error) return NextResponse.json({ success: false, error }, { status: 400 });

    try {
      const root = absPath.startsWith(LOGS_ROOT) ? LOGS_ROOT : absPath.startsWith(MEMORIES_ROOT) ? MEMORIES_ROOT : WORKSPACE_ROOT;
      await assertFileApiPathIsSafe(absPath, root);
      const content = await readFile(absPath, "utf-8");
      const ext = extname(absPath).toLowerCase();
      const language = extToLanguage(ext);
      const readOnly = isReadOnly(absPath);
      return NextResponse.json({ success: true, data: { content, language, readOnly, path: pathParam, name: basename(absPath) } });
    } catch (err) {
      return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
    }
  }

  return NextResponse.json({ success: false, error: "Unknown action" }, { status: 400 });
}

export async function POST(req: NextRequest) {
  const denied = await requireOperatorAccess(req);
  if (denied) return denied;
  const body = await req.json() as { action?: string; path?: string; content?: string };
  const { action, path: pathParam, content } = body;

  if (action === "write") {
    if (!pathParam || content === undefined) {
      return NextResponse.json({ success: false, error: "path and content required" }, { status: 400 });
    }
    const rel = pathParam.replace(/^\/+/, "");
    const { absPath, error } = validatePath(rel);
    if (error) return NextResponse.json({ success: false, error }, { status: 400 });

    if (isReadOnly(absPath)) {
      return NextResponse.json({ success: false, error: "File is read-only" }, { status: 403 });
    }
    const sensitive = getSensitivePathMatch(absPath);
    if (sensitive) {
      return NextResponse.json({ success: false, error: `Sensitive file target blocked: ${sensitive.path} (${sensitive.reason})` }, { status: 403 });
    }

    // Cap file size at 1 MB
    if (content.length > 1_000_000) {
      return NextResponse.json({ success: false, error: "Content too large (max 1 MB)" }, { status: 413 });
    }

    try {
      await assertFileApiPathIsSafe(absPath, WORKSPACE_ROOT);
      assertNoSymlinkedSensitiveTarget(absPath);
      await writeFile(absPath, content, "utf-8");
      return NextResponse.json({ success: true });
    } catch (err) {
      return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
    }
  }

  return NextResponse.json({ success: false, error: "Unknown action" }, { status: 400 });
}

function extToLanguage(ext: string): string {
  const map: Record<string, string> = {
    ".md": "markdown",
    ".ts": "typescript",
    ".tsx": "typescriptreact",
    ".js": "javascript",
    ".jsx": "javascript",
    ".json": "json",
    ".py": "python",
    ".sh": "shell",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".html": "html",
    ".css": "css",
    ".toml": "toml",
    ".log": "plaintext",
    ".txt": "plaintext",
    ".csv": "plaintext",
  };
  return map[ext] ?? "plaintext";
}
