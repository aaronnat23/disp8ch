import { NextRequest, NextResponse } from "next/server";
import { parseLogLine, listLogFiles, tailLogFile, type UiLogLevel } from "@/lib/logs/file-logs";
import { requireAdminAccess } from "@/lib/security/admin";

export const dynamic = "force-dynamic";

const ALLOWED_LEVELS = new Set<UiLogLevel>(["trace", "debug", "info", "warn", "error", "fatal"]);

function parsePositiveInt(raw: string | null, fallback: number, min: number, max: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function parseLevelFilter(raw: string | null): Set<UiLogLevel> | null {
  if (!raw) return null;
  const out = new Set<UiLogLevel>();
  for (const chunk of raw.split(",")) {
    const lowered = chunk.trim().toLowerCase() as UiLogLevel;
    if (!ALLOWED_LEVELS.has(lowered)) continue;
    out.add(lowered);
  }
  return out.size > 0 ? out : null;
}

export async function GET(request: NextRequest) {
  try {
    const denied = await requireAdminAccess(request);
    if (denied) return denied;
    const { searchParams } = new URL(request.url);
    const availableFiles = listLogFiles();
    if (availableFiles.length === 0) {
      return NextResponse.json({
        success: true,
        data: {
          file: null,
          entries: [],
          availableFiles: [],
          truncated: false,
        },
      });
    }

    const fileName = searchParams.get("file") || availableFiles[0];
    const maxBytes = parsePositiveInt(searchParams.get("maxBytes"), 2 * 1024 * 1024, 32 * 1024, 5 * 1024 * 1024);
    const limit = parsePositiveInt(searchParams.get("limit"), 400, 20, 2000);
    const query = (searchParams.get("q") || "").trim().toLowerCase();
    const levelFilter = parseLevelFilter(searchParams.get("levels"));

    const tail = tailLogFile({ fileName, maxBytes });
    const lines = tail.text
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter(Boolean);

    const entries = lines
      .map(parseLogLine)
      .filter((entry) => {
        if (levelFilter && (!entry.level || !levelFilter.has(entry.level))) {
          return false;
        }
        if (!query) return true;
        const haystack = `${entry.message} ${entry.subsystem || ""} ${entry.raw}`.toLowerCase();
        return haystack.includes(query);
      })
      .slice(-limit);

    return NextResponse.json({
      success: true,
      data: {
        file: tail.absolutePath,
        fileName,
        entries,
        availableFiles,
        truncated: tail.truncated,
      },
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
