import { NextResponse } from "next/server";
import { getSqlite } from "@/lib/db";
import { requireOperatorAccess } from "@/lib/security/admin";
import { getCached, API_TTL } from "@/lib/api-cache";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;

    const data = await getCached("agents-bootstrap", async () => {
      const db = getSqlite();

      // ── agents ────────────────────────────────────────────────────────────
      let agents: Array<{
        id: string;
        name: string;
        isActive: boolean;
        isDefault: boolean;
        role: string | null;
        modelId: string | null;
      }> = [];
      let agentCount = 0;
      let agentActiveCount = 0;
      try {
        const agentRows = db
          .prepare(
            `SELECT id, name, is_active, is_default, model_ref
             FROM agents
             ORDER BY is_default DESC, name ASC`,
          )
          .all() as Array<{
          id: string;
          name: string;
          is_active: number;
          is_default: number;
          model_ref: string | null;
        }>;

        // Fetch roles in one query
        const roles = new Map<string, string>();
        try {
          const roleRows = db
            .prepare("SELECT agent_id, role_type FROM agent_roles")
            .all() as Array<{ agent_id: string; role_type: string }>;
          for (const r of roleRows) {
            roles.set(r.agent_id, r.role_type);
          }
        } catch {
          /* agent_roles table may not exist yet */
        }

        agents = agentRows.map((r) => {
          const isActive = r.is_active !== 0;
          if (isActive) agentActiveCount += 1;
          return {
            id: r.id,
            name: r.name,
            isActive,
            isDefault: r.is_default !== 0,
            role: roles.get(r.id) ?? null,
            modelId: r.model_ref ?? null,
          };
        });
        agentCount = agentRows.length;
      } catch {
        /* agents table may not exist yet */
      }

      // ── roles ─────────────────────────────────────────────────────────────
      let roleCount = 0;
      try {
        roleCount = (
          db
            .prepare("SELECT COUNT(*) AS c FROM agent_roles")
            .get() as { c: number }
        )?.c ?? 0;
      } catch {
        /* agent_roles table may not exist yet */
      }

      return {
        agents,
        count: agentCount,
        activeCount: agentActiveCount,
        roles: { count: roleCount },
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
