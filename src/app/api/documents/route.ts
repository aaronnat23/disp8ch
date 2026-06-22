import { NextRequest, NextResponse } from "next/server";
import {
  createDocumentFromCrawl,
  createDocumentFromScrape,
  createDocumentFromUpload,
  listDocuments,
  searchDocuments,
  type ScrapeStrategy,
} from "@/lib/documents/store";
import { rebuildDocumentEmbeddings, searchDocumentsSemantic } from "@/lib/documents/chunks";
import { importGoogleWorkspaceToDocument } from "@/lib/documents/integrations";
import { importMarkdownFolder } from "@/lib/documents/folder-import";
import { requireOperatorAccess } from "@/lib/security/admin";

export const dynamic = "force-dynamic";

function badRequest(message: string) {
  return NextResponse.json({ success: false, error: message }, { status: 400 });
}

function toBoundedNumber(input: unknown, fallback: number, min: number, max: number): number {
  const value = Number(input);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function toStringArray(input: unknown): string[] {
  if (Array.isArray(input)) return input.map((v) => String(v || "").trim()).filter(Boolean);
  if (typeof input === "string") {
    return input
      .split(/\r?\n|,/g)
      .map((v) => v.trim())
      .filter(Boolean);
  }
  return [];
}

function toScrapeStrategy(input: unknown): ScrapeStrategy {
  const value = String(input || "auto").trim().toLowerCase();
  if (value === "static" || value === "dynamic") return value;
  return "auto";
}

async function ensureNodeFileGlobal() {
  if (typeof (globalThis as { File?: unknown }).File !== "undefined") return;
  const bufferMod = await import("node:buffer");
  (globalThis as { File?: unknown }).File = bufferMod.File;
}

export async function GET(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const { searchParams } = new URL(request.url);
    const q = searchParams.get("q")?.trim() || "";
    const semantic = searchParams.get("semantic") === "1" || searchParams.get("mode") === "semantic";
    const notebookId = searchParams.get("notebookId")?.trim() || undefined;
    const limitRaw = Number(searchParams.get("limit") || "20");
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(100, limitRaw)) : 20;

    if (semantic && q) {
      const data = await searchDocumentsSemantic(q, { notebookId, limit });
      return NextResponse.json({ success: true, data });
    }

    const data = q ? searchDocuments(q, limit) : listDocuments().slice(0, limit);
    return NextResponse.json({ success: true, data });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const contentType = request.headers.get("content-type") || "";

    if (contentType.includes("multipart/form-data")) {
      try {
        await ensureNodeFileGlobal();
        const formData = await request.formData();
        const file = formData.get("file") as
          | { size?: number; name?: string; type?: string; arrayBuffer?: () => Promise<ArrayBuffer> }
          | null;

        if (!file || typeof file.arrayBuffer !== "function") {
          return badRequest("Missing file field");
        }

        if (!file.size) {
          return badRequest("Empty files are not supported");
        }

        if (file.size > 50 * 1024 * 1024) {
          return badRequest("File is too large (max 50MB)");
        }

        const buffer = Buffer.from(await file.arrayBuffer());
        const saved = await createDocumentFromUpload({
          fileName: file.name || "document",
          mimeType: file.type || "application/octet-stream",
          buffer,
        });

        return NextResponse.json({ success: true, data: saved }, { status: 201 });
      } catch {
        return badRequest("Multipart parsing is unavailable in this runtime. Use action='upload' JSON payload.");
      }
    }

    const body = (await request.json()) as {
      action?: string;
      url?: string;
      name?: string;
      fileName?: string;
      mimeType?: string;
      contentBase64?: string;
      mode?: string;
      strategy?: string;
      maxPages?: number;
      maxDepth?: number;
      sameDomainOnly?: boolean;
      includeSubdomains?: boolean;
      requestDelayMs?: number;
      seedFromSitemaps?: boolean;
      includePatterns?: string[] | string;
      excludePatterns?: string[] | string;
      modeType?: string;
      query?: string;
      maxResults?: number;
      documentIds?: string[];
      path?: string;
      recursive?: boolean;
      maxFiles?: number;
    };

    const action = String(body.action || "").trim().toLowerCase();
    if (action === "rebuild-embeddings" || action === "rebuild_embeddings") {
      const result = await rebuildDocumentEmbeddings(Array.isArray(body.documentIds) ? body.documentIds : undefined);
      return NextResponse.json({ success: true, data: result });
    }
    if (action === "upload" || body.contentBase64) {
      const fileName = String(body.fileName || body.name || "document").trim();
      const mimeType = String(body.mimeType || "application/octet-stream").trim();
      const rawBase64 = String(body.contentBase64 || "").trim();
      if (!rawBase64) return badRequest("contentBase64 is required for upload action");

      const normalizedBase64 = rawBase64.includes(",") ? rawBase64.split(",").pop() || "" : rawBase64;
      const buffer = Buffer.from(normalizedBase64, "base64");
      if (!buffer.length) return badRequest("Decoded file is empty");
      if (buffer.length > 50 * 1024 * 1024) {
        return badRequest("File is too large (max 50MB)");
      }

      const saved = await createDocumentFromUpload({
        fileName,
        mimeType,
        buffer,
      });

      return NextResponse.json({ success: true, data: saved }, { status: 201 });
    }

    if (action === "google-workspace" || action === "google_workspace") {
      const modeType = String(body.modeType || body.mode || "gmail").trim().toLowerCase();
      if (modeType !== "gmail" && modeType !== "drive") {
        return badRequest("modeType must be gmail or drive for google-workspace action");
      }
      const saved = await importGoogleWorkspaceToDocument({
        mode: modeType,
        query: typeof body.query === "string" ? body.query : undefined,
        maxResults: body.maxResults,
      });
      return NextResponse.json({ success: true, data: saved }, { status: 201 });
    }

    if (action === "import-folder" || action === "import_folder" || action === "folder") {
      const folderPath = String(body.path || "").trim();
      if (!folderPath) return badRequest("path is required for import-folder action");
      const result = await importMarkdownFolder(folderPath, {
        recursive: body.recursive !== false,
        maxFiles: toBoundedNumber(body.maxFiles, 500, 1, 5000),
      });
      return NextResponse.json({ success: true, data: result }, { status: 201 });
    }

    if (action !== "scrape") {
      return badRequest(
        `Unknown action '${action || "(empty)"}'. Use multipart upload, action='upload', action='scrape', action='import-folder', or action='google-workspace'.`,
      );
    }

    const url = String(body.url || "").trim();
    if (!url) return badRequest("url is required for scrape action");

    const mode = String(body.mode || "single").trim().toLowerCase();
    const saved =
      mode === "crawl" || mode === "deep" || mode === "deep-crawl"
        ? await createDocumentFromCrawl({
            url,
            name: body.name,
            options: {
              maxPages: toBoundedNumber(body.maxPages, 20, 1, 80),
              maxDepth: toBoundedNumber(body.maxDepth, 2, 0, 6),
              sameDomainOnly: body.sameDomainOnly !== false,
              includeSubdomains: body.includeSubdomains !== false,
              requestDelayMs: toBoundedNumber(body.requestDelayMs, 120, 0, 3000),
              seedFromSitemaps: body.seedFromSitemaps !== false,
              strategy: toScrapeStrategy(body.strategy),
              includePatterns: toStringArray(body.includePatterns),
              excludePatterns: toStringArray(body.excludePatterns),
            },
          })
        : await createDocumentFromScrape({
            url,
            name: body.name,
            options: {
              strategy: toScrapeStrategy(body.strategy),
            },
          });

    return NextResponse.json({ success: true, data: saved }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
