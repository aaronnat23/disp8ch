import { NextResponse } from "next/server";
import { getSqlite } from "@/lib/db";
import { requireOperatorAccess } from "@/lib/security/admin";
import { getCached, API_TTL } from "@/lib/api-cache";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;

    const data = await getCached("boards-bootstrap", async () => {
      const db = getSqlite();

      // ── boards ────────────────────────────────────────────────────────────
      let boards: Array<{
        id: string;
        name: string;
        description: string | null;
        taskCount: number;
        isActive: boolean;
      }> = [];
      try {
        const boardRows = db
          .prepare(
            `SELECT b.id, b.name, b.description, b.is_active,
                    COUNT(t.id) AS task_count
             FROM boards b
             LEFT JOIN board_tasks t ON t.board_id = b.id
             GROUP BY b.id
             ORDER BY b.updated_at DESC`,
          )
          .all() as Array<{
          id: string;
          name: string;
          description: string | null;
          is_active: number;
          task_count: number;
        }>;
        boards = boardRows.map((r) => ({
          id: r.id,
          name: r.name,
          description: r.description,
          taskCount: Number(r.task_count ?? 0),
          isActive: r.is_active !== 0,
        }));
      } catch {
        /* boards table may not exist yet */
      }

      // ── tasks ─────────────────────────────────────────────────────────────
      let tasks = {
        total: 0,
        inbox: 0,
        inProgress: 0,
        review: 0,
        done: 0,
        blocked: 0,
      };
      try {
        const totalRow = db
          .prepare("SELECT COUNT(*) AS c FROM board_tasks")
          .get() as { c: number };
        tasks.total = totalRow?.c ?? 0;

        const byStatus = db
          .prepare(
            `SELECT status, COUNT(*) AS c
             FROM board_tasks
             GROUP BY status`,
          )
          .all() as Array<{ status: string; c: number }>;

        for (const row of byStatus) {
          const count = row.c ?? 0;
          switch (row.status) {
            case "inbox":
              tasks.inbox = count;
              break;
            case "in_progress":
              tasks.inProgress = count;
              break;
            case "review":
              tasks.review = count;
              break;
            case "done":
              tasks.done = count;
              break;
            case "blocked":
              tasks.blocked = count;
              break;
          }
        }
      } catch {
        /* board_tasks table may not exist yet */
      }

      return { boards, tasks };
    }, API_TTL.bootstrap);

    return NextResponse.json({ success: true, data });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: String(err) },
      { status: 500 },
    );
  }
}
