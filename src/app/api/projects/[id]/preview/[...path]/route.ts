import { promises as fs } from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { getConnectedProject } from "@/lib/projects/store";
import { requireOperatorAccess } from "@/lib/security/admin";

export const dynamic = "force-dynamic";

const MAX_PREVIEW_FILE_BYTES = 5 * 1024 * 1024;
const SECRET_NAME = /^(?:\.env(?:\..*)?|id_rsa|id_ed25519|credentials(?:\.json)?|secrets?\.json|.*\.(?:pem|key|p12|pfx|jks))$/i;
const SECRET_CONTENT = /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{20,}|\bAKIA[0-9A-Z]{16}\b)/;

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function contentType(filePath: string): string {
  return ({
    ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
    ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
    ".xml": "application/xml; charset=utf-8", ".webmanifest": "application/manifest+json",
  } as Record<string, string>)[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

async function rejectSymlinks(root: string, relativePath: string): Promise<void> {
  let cursor = root;
  for (const segment of relativePath.split(/[\\/]+/).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    if ((await fs.lstat(cursor)).isSymbolicLink()) throw new Error("Preview blocked a symbolic link.");
  }
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string; path: string[] }> }) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;
  try {
    const { id, path: requestedRoutePath } = await params;
    const project = getConnectedProject(id);
    if (!project) throw new Error("Connected project not found.");
    const [encodedOutput, ...requestedParts] = requestedRoutePath || [];
    if (!encodedOutput) throw new Error("Preview output is required.");
    const outputPath = Buffer.from(encodedOutput, "base64url").toString("utf8");
    if (!outputPath.trim() || path.isAbsolute(outputPath) || outputPath.includes("\0")) throw new Error("Preview output must be a project-relative directory.");

    const canonicalRoot = await fs.realpath(project.canonicalRoot);
    await rejectSymlinks(canonicalRoot, outputPath);
    const outputRoot = await fs.realpath(path.resolve(canonicalRoot, outputPath));
    if (!inside(canonicalRoot, outputRoot) || outputRoot === canonicalRoot || !(await fs.stat(outputRoot)).isDirectory()) throw new Error("Preview output must be a contained project subdirectory.");

    const requestedPath = requestedParts.length ? requestedParts.join("/") : "index.html";
    if (path.isAbsolute(requestedPath) || requestedPath.includes("\0") || requestedPath.split("/").some((part) => part === ".." || SECRET_NAME.test(part))) throw new Error("Preview path is not allowed.");
    await rejectSymlinks(outputRoot, requestedPath);
    const target = await fs.realpath(path.resolve(outputRoot, requestedPath));
    if (!inside(outputRoot, target)) throw new Error("Preview path escape blocked.");
    const stat = await fs.stat(target);
    if (!stat.isFile() || stat.size > MAX_PREVIEW_FILE_BYTES) throw new Error("Preview file is not readable.");
    const content = await fs.readFile(target);
    if (content.length < 2_000_000 && SECRET_CONTENT.test(content.toString("utf8"))) throw new Error("Preview blocked possible embedded secret content.");

    return new NextResponse(new Uint8Array(content), {
      headers: {
        "cache-control": "no-store",
        "content-security-policy": "default-src 'self' data: blob:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
        "content-type": contentType(target),
        "x-content-type-options": "nosniff",
        "x-disp8ch-preview": "local-project-output",
      },
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 400 });
  }
}
