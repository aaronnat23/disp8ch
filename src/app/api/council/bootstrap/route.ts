import { NextResponse } from "next/server";
import { getSqlite } from "@/lib/db";
import { requireOperatorAccess } from "@/lib/security/admin";
import { getCached, API_TTL } from "@/lib/api-cache";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;

    const data = await getCached("council-bootstrap", async () => {
      const db = getSqlite();

      // ── sessions ──────────────────────────────────────────────────────────
      let sessionCount = 0;
      let recentSessions: Array<{ id: string; topic: string; createdAt: string }> = [];
      try {
        sessionCount = (
          db
            .prepare("SELECT COUNT(*) AS c FROM council_sessions")
            .get() as { c: number }
        )?.c ?? 0;

        const rows = db
          .prepare(
            `SELECT id, topic, created_at
             FROM council_sessions
             ORDER BY created_at DESC
             LIMIT 6`,
          )
          .all() as Array<{ id: string; topic: string; created_at: string }>;
        recentSessions = rows.map((r) => ({
          id: r.id,
          topic: r.topic,
          createdAt: r.created_at,
        }));
      } catch {
        /* council_sessions table may not exist yet */
      }

      // ── templates ─────────────────────────────────────────────────────────
      let templateCount = 0;
      try {
        templateCount = (
          db
            .prepare("SELECT COUNT(*) AS c FROM council_templates")
            .get() as { c: number }
        )?.c ?? 0;
      } catch {
        /* council_templates table may not exist yet */
      }

      return {
        sessions: { count: sessionCount, recent: recentSessions },
        templates: { count: templateCount },
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
