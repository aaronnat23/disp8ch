import { NextResponse } from "next/server";
import { getSqlite } from "@/lib/db";
import { requireOperatorAccess } from "@/lib/security/admin";
import { getCached, API_TTL } from "@/lib/api-cache";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;

    const data = await getCached("documents-bootstrap", async () => {
      const db = getSqlite();

      // ── documents ─────────────────────────────────────────────────────────
      let docCount = 0;
      let recentUpload: string | null = null;
      try {
        docCount = (
          db
            .prepare("SELECT COUNT(*) AS c FROM documents")
            .get() as { c: number }
        )?.c ?? 0;

        const recent = db
          .prepare(
            `SELECT source_url, source_type
             FROM documents
             WHERE source_type = 'upload'
             ORDER BY created_at DESC
             LIMIT 1`,
          )
          .get() as { source_url: string | null; source_type: string } | undefined;
        if (recent?.source_url) {
          recentUpload = recent.source_url.length > 120
            ? recent.source_url.slice(0, 120)
            : recent.source_url;
        }
      } catch {
        /* documents table may not exist yet */
      }

      // ── collections ───────────────────────────────────────────────────────
      let collectionCount = 0;
      try {
        collectionCount = (
          db
            .prepare("SELECT COUNT(*) AS c FROM collection_files")
            .get() as { c: number }
        )?.c ?? 0;
      } catch {
        /* collection_files table may not exist yet */
      }

      return {
        documents: { count: docCount, recentUpload },
        collections: { count: collectionCount },
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
