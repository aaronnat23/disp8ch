import { NextRequest, NextResponse } from "next/server";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import { initializeDatabase, getSqlite } from "@/lib/db";
import { requireOperatorAccess } from "@/lib/security/admin";

export const dynamic = "force-dynamic";

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const ALLOWED_MIME_PREFIXES = ["image/", "text/", "audio/", "video/"];
const ALLOWED_MIME_TYPES = new Set(["application/pdf", "application/json", "text/csv"]);

function safeName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "upload";
}

function extractPdfMetadata(buffer: Buffer): Record<string, string | number | boolean | null> {
  const text = buffer.toString("latin1", 0, Math.min(buffer.length, 2_000_000));
  const pages = Math.max(0, (text.match(/\/Type\s*\/Page\b/g) || []).length);
  const readInfo = (key: string) => {
    const match = text.match(new RegExp(`/${key}\\s*\\(([^)]{1,300})\\)`));
    return match?.[1]?.replace(/\\([()\\])/g, "$1") ?? null;
  };
  return {
    pageCount: pages || null,
    title: readInfo("Title"),
    author: readInfo("Author"),
  };
}

function buildUploadMetadata(fileName: string, mimeType: string, sizeBytes: number, buffer: Buffer): Record<string, string | number | boolean | null> {
  const extension = path.extname(fileName).replace(/^\./, "").toLowerCase() || null;
  const base: Record<string, string | number | boolean | null> = {
    extension,
    mimeType,
    sizeBytes,
  };
  if (mimeType === "application/pdf") {
    return { ...base, ...extractPdfMetadata(buffer) };
  }
  if (mimeType.startsWith("audio/")) {
    return { ...base, mediaType: "audio" };
  }
  if (mimeType.startsWith("video/")) {
    return { ...base, mediaType: "video" };
  }
  return base;
}

export async function GET(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    initializeDatabase();
    const { searchParams } = new URL(request.url);
    const id = String(searchParams.get("id") || "").trim();
    if (!id) {
      return NextResponse.json({ success: false, error: "Missing upload id" }, { status: 400 });
    }
    const row = getSqlite()
      .prepare("SELECT file_name, mime_type, size_bytes, path FROM chat_attachments WHERE id = ?")
      .get(id) as { file_name: string; mime_type: string; size_bytes: number; path: string } | undefined;
    if (!row) {
      return NextResponse.json({ success: false, error: "Upload not found" }, { status: 404 });
    }
    const uploadRoot = path.resolve(process.cwd(), "data", "uploads", "chat");
    const resolved = path.resolve(row.path);
    if (!resolved.startsWith(`${uploadRoot}${path.sep}`)) {
      return NextResponse.json({ success: false, error: "Upload path is outside the chat upload root" }, { status: 403 });
    }
    const buffer = await readFile(resolved);
    return new NextResponse(buffer, {
      headers: {
        "Content-Type": row.mime_type || "application/octet-stream",
        "Content-Length": String(row.size_bytes || buffer.length),
        "Cache-Control": "private, max-age=60",
        "Content-Disposition": `inline; filename="${safeName(row.file_name)}"`,
      },
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    initializeDatabase();
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ success: false, error: "file required" }, { status: 400 });
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json({ success: false, error: "File is larger than 8 MB" }, { status: 400 });
    }
    const mimeType = file.type || "application/octet-stream";
    const allowed = ALLOWED_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix)) || ALLOWED_MIME_TYPES.has(mimeType);
    if (!allowed) {
      return NextResponse.json({ success: false, error: `Unsupported upload type: ${mimeType}` }, { status: 400 });
    }
    const sessionId = String(form.get("sessionId") || "").trim() || null;
    const id = nanoid(12);
    const uploadDir = path.join(process.cwd(), "data", "uploads", "chat");
    await mkdir(uploadDir, { recursive: true });
    const fileName = safeName(file.name || "upload");
    const localPath = path.join(uploadDir, `${id}-${fileName}`);
    const buffer = Buffer.from(await file.arrayBuffer());
    await writeFile(localPath, buffer);

    const now = new Date().toISOString();
    const metadata = buildUploadMetadata(fileName, mimeType, file.size, buffer);
    getSqlite().prepare(
      `INSERT INTO chat_attachments(id, session_id, file_name, mime_type, size_bytes, path, metadata, created_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, sessionId, fileName, mimeType, file.size, localPath, JSON.stringify(metadata), now);
    return NextResponse.json({
      success: true,
      data: { id, sessionId, fileName, mimeType, sizeBytes: file.size, path: localPath, metadata, createdAt: now },
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
