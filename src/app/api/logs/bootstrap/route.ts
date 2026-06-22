import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { getCached, API_TTL } from "@/lib/api-cache";
import { requireOperatorAccess } from "@/lib/security/admin";

export const dynamic = "force-dynamic";

const LOGS_DIR = path.resolve(process.env.LOGS_PATH || "./data/logs");

export async function GET(request: Request) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;
  try {
    const data = await getCached("logs-bootstrap", async () => {
      let logs = { count24h: 0, errorCount24h: 0, warnCount24h: 0 };
      let recentErrors: Array<{ ts: string; message: string }> = [];
      const now = new Date();
      const since24h = now.getTime() - 24 * 60 * 60 * 1000;

      try {
        if (!fs.existsSync(LOGS_DIR)) {
          return { logs, recentErrors };
        }

        const files = fs
          .readdirSync(LOGS_DIR)
          .filter((f) => f.endsWith(".log") || f.endsWith(".jsonl"))
          .sort()
          .reverse();

        // Read up to 5 most recent log files for the last 24h
        for (const file of files.slice(0, 5)) {
          let content = "";
          try {
            content = fs.readFileSync(path.join(LOGS_DIR, file), "utf-8");
          } catch {
            continue;
          }

          const lines = content.split("\n").filter(Boolean);
          for (const line of lines) {
            // Try JSONL format first
            let parsed: Record<string, unknown> | null = null;
            try {
              parsed = JSON.parse(line) as Record<string, unknown>;
            } catch {
              /* plain text line */
            }

            if (parsed) {
              const ts = String(parsed.timestamp ?? parsed.ts ?? "");
              const lineTime = new Date(ts).getTime();
              if (!Number.isNaN(lineTime) && lineTime >= since24h) {
                logs.count24h += 1;
                const level = String(parsed.level ?? "").toLowerCase();
                if (level === "error") {
                  logs.errorCount24h += 1;
                  if (recentErrors.length < 10) {
                    recentErrors.push({
                      ts: ts || new Date().toISOString(),
                      message: String(parsed.message ?? parsed.msg ?? "").slice(0, 200),
                    });
                  }
                } else if (level === "warn" || level === "warning") {
                  logs.warnCount24h += 1;
                }
              }
            } else {
              // Plain text fallback: count lines with error/warn keywords
              const lower = line.toLowerCase();
              if (
                lower.includes("[error]") ||
                lower.includes(" error ") ||
                lower.startsWith("error")
              ) {
                logs.errorCount24h += 1;
                if (recentErrors.length < 10) {
                  recentErrors.push({
                    ts: new Date().toISOString(),
                    message: line.slice(0, 200),
                  });
                }
              } else if (
                lower.includes("[warn") ||
                lower.includes(" warn ") ||
                lower.startsWith("warn")
              ) {
                logs.warnCount24h += 1;
              }
              logs.count24h += 1;
            }
          }
        }
      } catch {
        /* logs directory may not exist or may be unreadable */
      }

      return { logs, recentErrors };
    }, API_TTL.bootstrap);

    return NextResponse.json({ success: true, data });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: String(err) },
      { status: 500 },
    );
  }
}
