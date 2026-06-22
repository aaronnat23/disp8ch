import { NextResponse } from "next/server";
import { getSqlite } from "@/lib/db";
import { requireOperatorAccess } from "@/lib/security/admin";
import { getCached, API_TTL } from "@/lib/api-cache";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;

    const data = await getCached("tags-bootstrap", async () => {
      const db = getSqlite();

      // ── tags ──────────────────────────────────────────────────────────────
      let tagCount = 0;
      const byScope: Record<string, number> = {};
      try {
        tagCount = (
          db
            .prepare("SELECT COUNT(*) AS c FROM tags")
            .get() as { c: number }
        )?.c ?? 0;

        const scopeRows = db
          .prepare("SELECT scope, COUNT(*) AS c FROM tags GROUP BY scope")
          .all() as Array<{ scope: string; c: number }>;
        for (const row of scopeRows) {
          byScope[row.scope] = row.c ?? 0;
        }
      } catch {
        /* tags table may not exist yet */
      }

      return { tags: { count: tagCount, byScope } };
    }, API_TTL.bootstrap);

    return NextResponse.json({ success: true, data });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: String(err) },
      { status: 500 },
    );
  }
}
