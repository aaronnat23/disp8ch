import { NextResponse } from "next/server";
import { getSqlite } from "@/lib/db";
import { requireOperatorAccess } from "@/lib/security/admin";
import { getCached, API_TTL } from "@/lib/api-cache";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;

    const data = await getCached("approvals-bootstrap", async () => {
      const db = getSqlite();

      // ── pending ───────────────────────────────────────────────────────────
      let pending = 0;
      try {
        pending = (
          db
            .prepare(
              "SELECT COUNT(*) AS c FROM task_approvals WHERE status = 'pending'",
            )
            .get() as { c: number }
        )?.c ?? 0;
      } catch {
        /* task_approvals table may not exist yet */
      }

      // ── total 24h ─────────────────────────────────────────────────────────
      let total24h = 0;
      try {
        total24h = (
          db
            .prepare(
              `SELECT COUNT(*) AS c FROM task_approvals
               WHERE created_at >= datetime('now', '-24 hours')`,
            )
            .get() as { c: number }
        )?.c ?? 0;
      } catch {
        /* task_approvals table may not exist yet */
      }

      return { pending, total24h };
    }, API_TTL.bootstrap);

    return NextResponse.json({ success: true, data });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: String(err) },
      { status: 500 },
    );
  }
}
