import { NextResponse } from "next/server";
import { getSqlite } from "@/lib/db";
import { getCached, API_TTL } from "@/lib/api-cache";
import { requireOperatorAccess } from "@/lib/security/admin";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;
  try {
    const data = await getCached("dashboard-bootstrap", async () => {
      const db = getSqlite();

      let workflows = { count: 0, active: 0 };
      try {
        workflows.count = (
          db.prepare("SELECT COUNT(*) AS c FROM workflows").get() as { c: number }
        )?.c ?? 0;
        workflows.active = (
          db
            .prepare("SELECT COUNT(*) AS c FROM workflows WHERE is_active = 1")
            .get() as { c: number }
        )?.c ?? 0;
      } catch {
        /* workflows table may not exist yet */
      }

      let agentData = { count: 0, active: 0 };
      try {
        agentData.count = (
          db.prepare("SELECT COUNT(*) AS c FROM agents").get() as { c: number }
        )?.c ?? 0;
        agentData.active = (
          db
            .prepare("SELECT COUNT(*) AS c FROM agents WHERE is_active = 1")
            .get() as { c: number }
        )?.c ?? 0;
      } catch {
        /* agents table may not exist yet */
      }

      let boards = { count: 0 };
      try {
        boards.count = (
          db.prepare("SELECT COUNT(*) AS c FROM boards").get() as { c: number }
        )?.c ?? 0;
      } catch {
        /* boards table may not exist yet */
      }

      let tasks: {
        total: number;
        open: number;
        byStatus: Record<string, number>;
      } = { total: 0, open: 0, byStatus: {} };
      try {
        const totalRow = db
          .prepare("SELECT COUNT(*) AS c FROM board_tasks")
          .get() as { c: number };
        tasks.total = totalRow?.c ?? 0;

        const byStatus = db
          .prepare(
            "SELECT status, COUNT(*) AS c FROM board_tasks GROUP BY status",
          )
          .all() as Array<{ status: string; c: number }>;

        for (const row of byStatus) {
          tasks.byStatus[row.status] = row.c ?? 0;
          if (row.status !== "done") {
            tasks.open += row.c ?? 0;
          }
        }
      } catch {
        /* board_tasks table may not exist yet */
      }

      let orgs: { count: number; activeName: string | null } = {
        count: 0,
        activeName: null,
      };
      try {
        orgs.count = (
          db
            .prepare("SELECT COUNT(*) AS c FROM hierarchy_organizations")
            .get() as { c: number }
        )?.c ?? 0;
        const activeOrg = db
          .prepare(
            "SELECT name FROM hierarchy_organizations WHERE is_active = 1 LIMIT 1",
          )
          .get() as { name: string } | undefined;
        orgs.activeName = activeOrg?.name ?? null;
      } catch {
        /* hierarchy_organizations table may not exist yet */
      }

      let models = { count: 0, active: 0 };
      try {
        models.count = (
          db.prepare("SELECT COUNT(*) AS c FROM models").get() as { c: number }
        )?.c ?? 0;
        models.active = (
          db
            .prepare("SELECT COUNT(*) AS c FROM models WHERE is_active = 1")
            .get() as { c: number }
        )?.c ?? 0;
      } catch {
        /* models table may not exist yet */
      }

      return {
        workflows,
        agents: agentData,
        boards,
        tasks,
        orgs,
        models,
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
