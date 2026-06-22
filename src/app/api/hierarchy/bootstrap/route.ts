import { NextResponse } from "next/server";
import { getSqlite } from "@/lib/db";
import { requireOperatorAccess } from "@/lib/security/admin";
import { getCached, API_TTL } from "@/lib/api-cache";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;

    const data = await getCached("hierarchy-bootstrap", async () => {
      const db = getSqlite();

      // ── organizations ─────────────────────────────────────────────────────
      let orgCount = 0;
      let activeOrg: { id: string; name: string } | null = null;
      try {
        orgCount = (
          db
            .prepare("SELECT COUNT(*) AS c FROM hierarchy_organizations")
            .get() as { c: number }
        )?.c ?? 0;
        const active = db
          .prepare(
            "SELECT id, name FROM hierarchy_organizations WHERE is_active = 1 LIMIT 1",
          )
          .get() as { id: string; name: string } | undefined;
        if (active) {
          activeOrg = { id: active.id, name: active.name };
        } else {
          const first = db
            .prepare(
              "SELECT id, name FROM hierarchy_organizations LIMIT 1",
            )
            .get() as { id: string; name: string } | undefined;
          if (first) activeOrg = { id: first.id, name: first.name };
        }
      } catch {
        /* hierarchy_organizations table may not exist yet */
      }

      // ── goals ─────────────────────────────────────────────────────────────
      let goalCount = 0;
      try {
        goalCount = (
          db
            .prepare("SELECT COUNT(*) AS c FROM hierarchy_goals")
            .get() as { c: number }
        )?.c ?? 0;
      } catch {
        /* hierarchy_goals table may not exist yet */
      }

      // ── agents ────────────────────────────────────────────────────────────
      let agentCount = 0;
      let agentActiveCount = 0;
      try {
        agentCount = (
          db.prepare("SELECT COUNT(*) AS c FROM agents").get() as { c: number }
        )?.c ?? 0;
        agentActiveCount = (
          db
            .prepare("SELECT COUNT(*) AS c FROM agents WHERE is_active = 1")
            .get() as { c: number }
        )?.c ?? 0;
      } catch {
        /* agents table may not exist yet */
      }

      return {
        organizations: { count: orgCount, active: activeOrg },
        goals: { count: goalCount },
        agents: { count: agentCount, activeCount: agentActiveCount },
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
