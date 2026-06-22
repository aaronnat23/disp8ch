import { NextResponse } from "next/server";
import { getSqlite } from "@/lib/db";
import { requireOperatorAccess } from "@/lib/security/admin";
import { getCached, API_TTL } from "@/lib/api-cache";
import fs from "node:fs";
import path from "node:path";
import { resolveAtomicMemoryDir } from "@/lib/memory/simple";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;

    const data = await getCached("memory-bootstrap", async () => {
      const db = getSqlite();
      const memDir = resolveAtomicMemoryDir("default");

      // ── stats ─────────────────────────────────────────────────────────────
      let totalMemories = 0;
      let storageBytes = 0;
      try {
        if (fs.existsSync(memDir)) {
          const files = fs
            .readdirSync(memDir)
            .filter((f) => f.endsWith(".md"));
          totalMemories = files.length;
          for (const f of files) {
            try {
              storageBytes += fs.statSync(path.join(memDir, f)).size;
            } catch {
              /* skip unreadable files */
            }
          }
        }
      } catch {
        /* memory directory may not exist */
      }

      let vectorIndexed = 0;
      try {
        vectorIndexed = (
          db
            .prepare("SELECT COUNT(*) AS c FROM memory_embeddings")
            .get() as { c: number }
        )?.c ?? 0;
      } catch {
        /* memory_embeddings table may not exist yet */
      }

      // ── journal ───────────────────────────────────────────────────────────
      let journalCount = 0;
      let journalLatest: { id: string; type: string; ts: string } | null = null;
      try {
        const workspaceDir = path.resolve(
          process.env.WORKSPACE_DIR || "data/workspace",
        );
        const journalDir = path.join(workspaceDir, "memory");
        if (fs.existsSync(journalDir)) {
          const journalFiles = fs
            .readdirSync(journalDir)
            .filter(
              (f) =>
                f.endsWith(".md") && /^\d{4}-\d{2}-\d{2}\.md$/.test(f),
            )
            .sort()
            .reverse();
          journalCount = journalFiles.length;
          if (journalFiles.length > 0) {
            const latestFile = journalFiles[0];
            const dateStr = path.basename(latestFile, ".md");
            const stats = fs.statSync(path.join(journalDir, latestFile));
            journalLatest = {
              id: dateStr,
              type: "journal",
              ts: new Date(stats.mtimeMs).toISOString(),
            };
          }
        }
      } catch {
        /* journal directory may not exist */
      }

      return {
        stats: { totalMemories, vectorIndexed, storageBytes },
        journal: { count: journalCount, latest: journalLatest },
      };
    }, API_TTL.bootstrap);

    return NextResponse.json({ success: true, data });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: String(err) },
      { status: 500 },
    );
  }
}
