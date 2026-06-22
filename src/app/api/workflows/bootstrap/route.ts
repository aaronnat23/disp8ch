import { NextResponse } from "next/server";
import { getSqlite } from "@/lib/db";
import { requireOperatorAccess } from "@/lib/security/admin";
import { getCached, API_TTL } from "@/lib/api-cache";
import { listWorkflowTemplateCatalog } from "@/lib/workflows/template-catalog";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;

    const data = await getCached("workflows-bootstrap", async () => {
      const db = getSqlite();

      // ── workflows ─────────────────────────────────────────────────────────
      let workflowCount = 0;
      let workflowActive = 0;
      let recentWorkflows: Array<{
        id: string;
        name: string;
        isActive: boolean;
        updatedAt: string;
      }> = [];
      try {
        workflowCount = (
          db
            .prepare("SELECT COUNT(*) AS c FROM workflows")
            .get() as { c: number }
        )?.c ?? 0;
        workflowActive = (
          db
            .prepare("SELECT COUNT(*) AS c FROM workflows WHERE is_active = 1")
            .get() as { c: number }
        )?.c ?? 0;
        const rows = db
          .prepare(
            `SELECT id, name, is_active, updated_at
             FROM workflows
             ORDER BY updated_at DESC
             LIMIT 6`,
          )
          .all() as Array<{
          id: string;
          name: string;
          is_active: number;
          updated_at: string;
        }>;
        recentWorkflows = rows.map((r) => ({
          id: r.id,
          name: r.name,
          isActive: r.is_active !== 0,
          updatedAt: r.updated_at,
        }));
      } catch {
        /* workflows table may not exist yet */
      }

      // ── templates ─────────────────────────────────────────────────────────
      let templateCount = 0;
      try {
        templateCount = listWorkflowTemplateCatalog().length;
      } catch {
        /* template catalog may not be available */
      }

      // ── organizations ─────────────────────────────────────────────────────
      let orgCount = 0;
      let orgActiveName: string | null = null;
      try {
        orgCount = (
          db
            .prepare("SELECT COUNT(*) AS c FROM hierarchy_organizations")
            .get() as { c: number }
        )?.c ?? 0;
        const activeOrg = db
          .prepare(
            "SELECT name FROM hierarchy_organizations WHERE is_active = 1 LIMIT 1",
          )
          .get() as { name: string } | undefined;
        orgActiveName = activeOrg?.name ?? null;
      } catch {
        /* hierarchy_organizations table may not exist yet */
      }

      return {
        workflows: {
          count: workflowCount,
          active: workflowActive,
          recent: recentWorkflows,
        },
        templates: { count: templateCount },
        organizations: { count: orgCount, activeName: orgActiveName },
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
