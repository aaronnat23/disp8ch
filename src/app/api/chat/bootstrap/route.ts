import { NextResponse } from "next/server";
import { getSqlite } from "@/lib/db";
import { requireOperatorAccess } from "@/lib/security/admin";
import { getCached, API_TTL } from "@/lib/api-cache";
import fs from "node:fs";
import path from "node:path";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;

    const data = await getCached("chat-bootstrap", async () => {
      const db = getSqlite();

      // ── sessions ──────────────────────────────────────────────────────────
      let sessionCount = 0;
      let recentSessions: Array<{
        id: string;
        title: string;
        updatedAt: string;
        messageCount: number;
      }> = [];
      try {
        const countRow = db
          .prepare("SELECT COUNT(DISTINCT session_id) AS c FROM messages")
          .get() as { c: number } | undefined;
        sessionCount = countRow?.c ?? 0;

        const sessionRows = db
          .prepare(
            `SELECT session_id AS id, MAX(created_at) AS updatedAt, COUNT(*) AS messageCount
             FROM messages
             GROUP BY session_id
             ORDER BY updatedAt DESC
             LIMIT 6`,
          )
          .all() as Array<{ id: string; updatedAt: string; messageCount: number }>;

        const titles = new Map<string, string>();
        if (sessionRows.length > 0) {
          const placeholders = sessionRows.map(() => "?").join(",");
          const titleRows = db
            .prepare(
              `SELECT session_id, content
               FROM messages
               WHERE role = 'user' AND session_id IN (${placeholders})
               GROUP BY session_id
               HAVING MIN(created_at)`,
            )
            .all(...sessionRows.map((r) => r.id)) as Array<{
            session_id: string;
            content: string;
          }>;
          for (const row of titleRows) {
            const snippet = String(row.content || row.session_id).trim();
            titles.set(
              row.session_id,
              snippet.length > 80 ? snippet.slice(0, 80) + "..." : snippet,
            );
          }
        }

        recentSessions = sessionRows.map((row) => ({
          id: row.id,
          title: titles.get(row.id) ?? row.id,
          updatedAt: row.updatedAt,
          messageCount: row.messageCount,
        }));
      } catch {
        /* messages table may not exist yet */
      }

      // ── models ────────────────────────────────────────────────────────────
      let modelCount = 0;
      let modelActive = 0;
      try {
        modelCount = (
          db.prepare("SELECT COUNT(*) AS c FROM models").get() as { c: number }
        )?.c ?? 0;
        modelActive = (
          db
            .prepare("SELECT COUNT(*) AS c FROM models WHERE is_active = 1")
            .get() as { c: number }
        )?.c ?? 0;
      } catch {
        /* models table may not exist yet */
      }

      // ── agents ────────────────────────────────────────────────────────────
      let agentCount = 0;
      let activeAgent: { id: string; name: string } | null = null;
      try {
        agentCount = (
          db.prepare("SELECT COUNT(*) AS c FROM agents").get() as { c: number }
        )?.c ?? 0;
        const defaultAgent = db
          .prepare(
            "SELECT id, name FROM agents WHERE is_default = 1 AND is_active = 1 LIMIT 1",
          )
          .get() as { id: string; name: string } | undefined;
        if (defaultAgent) {
          activeAgent = { id: defaultAgent.id, name: defaultAgent.name };
        } else {
          const first = db
            .prepare(
              "SELECT id, name FROM agents WHERE is_active = 1 LIMIT 1",
            )
            .get() as { id: string; name: string } | undefined;
          if (first) activeAgent = { id: first.id, name: first.name };
        }
      } catch {
        /* agents table may not exist yet */
      }

      // ── workspace ─────────────────────────────────────────────────────────
      let workspaceExists = false;
      try {
        workspaceExists = fs.existsSync(
          path.resolve(process.env.WORKSPACE_DIR || "data/workspace"),
        );
      } catch {
        /* fallback */
      }

      return {
        sessions: { count: sessionCount, recent: recentSessions },
        models: { count: modelCount, active: modelActive },
        agents: { count: agentCount, activeAgent },
        workspace: { exists: workspaceExists },
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
