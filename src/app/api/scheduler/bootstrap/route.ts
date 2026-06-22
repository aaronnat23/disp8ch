import { NextResponse } from "next/server";
import { getSqlite } from "@/lib/db";
import { requireOperatorAccess } from "@/lib/security/admin";
import { getCached, API_TTL } from "@/lib/api-cache";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;

    const data = await getCached("scheduler-bootstrap", async () => {
      const db = getSqlite();

      // ── jobs ──────────────────────────────────────────────────────────────
      let jobsTotal = 0;
      let jobsActive = 0;
      let jobsLive = 0;
      try {
        jobsTotal = (
          db
            .prepare(
              `SELECT COUNT(*) AS c FROM workflow_nodes
               WHERE type = 'cron-trigger'`,
            )
            .get() as { c: number }
        )?.c ?? 0;

        jobsActive = (
          db
            .prepare(
              `SELECT COUNT(*) AS c FROM workflow_nodes wn
               JOIN workflows w ON w.id = wn.workflow_id
               WHERE wn.type = 'cron-trigger' AND w.is_active = 1`,
            )
            .get() as { c: number }
        )?.c ?? 0;

        let liveJobs: Array<{ workflowId: string }> = [];
        try {
          const { listScheduledCronJobs } =
            require("@/lib/cron/manager") as {
              listScheduledCronJobs: () => Array<{ workflowId: string }>;
            };
          liveJobs = listScheduledCronJobs?.() ?? [];
        } catch {
          /* cron manager may not be available */
        }
        jobsLive = liveJobs.length;
      } catch {
        /* workflow_nodes table may not exist yet */
      }

      // ── executions (recent 24h) ───────────────────────────────────────────
      let recent24h = 0;
      try {
        recent24h = (
          db
            .prepare(
              `SELECT COUNT(*) AS c FROM executions
               WHERE started_at >= datetime('now', '-24 hours')`,
            )
            .get() as { c: number }
        )?.c ?? 0;
      } catch {
        /* executions table may not exist yet */
      }

      return {
        jobs: { total: jobsTotal, active: jobsActive, live: jobsLive },
        executions: { recent24h },
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
