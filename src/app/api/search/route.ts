import { NextResponse } from "next/server";
import { getSqlite } from "@/lib/db";
import { requireOperatorAccess } from "@/lib/security/admin";

export async function GET(request: Request) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;
  const { searchParams } = new URL(request.url);
  const query = searchParams.get("q")?.trim();
  if (!query) return NextResponse.json({ success: false, error: "q required" });

  const db = getSqlite();
  const like = `%${query}%`;
  const results: Array<{ type: string; id: string; title: string; subtitle: string; href: string }> = [];

  // Workflows
  try {
    const workflows = db.prepare("SELECT id, name FROM workflows WHERE name LIKE ? LIMIT 8").all(like) as Array<{ id: string; name: string }>;
    for (const w of workflows) {
      results.push({ type: "workflow", id: w.id, title: w.name, subtitle: "workflow", href: `/workflows/${w.id}` });
    }
  } catch { /* table may not exist */ }

  // Agents
  try {
    const agents = db.prepare("SELECT id, name, model_ref FROM agents WHERE name LIKE ? LIMIT 8").all(like) as Array<{ id: string; name: string; model_ref: string | null }>;
    for (const a of agents) {
      results.push({ type: "agent", id: a.id, title: a.name, subtitle: a.model_ref || "agent", href: `/agents?agentId=${encodeURIComponent(a.id)}` });
    }
  } catch { /* table may not exist */ }

  // Board tasks
  try {
    const tasks = db.prepare("SELECT id, title, status, board_id FROM board_tasks WHERE title LIKE ? LIMIT 8").all(like) as Array<{ id: string; title: string; status: string; board_id: string }>;
    for (const t of tasks) {
      results.push({ type: "board-task", id: t.id, title: t.title, subtitle: `${t.status} · board ${t.board_id}`, href: "/boards" });
    }
  } catch { /* table may not exist */ }

  // Skills
  try {
    const skills = db.prepare("SELECT skill_id, name FROM skill_steward_state WHERE name LIKE ? AND status != 'archived' LIMIT 8").all(like) as Array<{ skill_id: string; name: string }>;
    for (const s of skills) {
      results.push({ type: "skill", id: s.skill_id, title: s.name, subtitle: "skill", href: "/skills" });
    }
  } catch { /* table may not exist */ }

  // Chat sessions
  try {
    const sessions = db.prepare("SELECT id, channel, sender_label FROM channel_sessions WHERE id LIKE ? OR channel LIKE ? LIMIT 5").all(like, like) as Array<{ id: string; channel: string; sender_label: string }>;
    for (const s of sessions) {
      results.push({ type: "chat", id: s.id, title: s.channel || "chat", subtitle: s.sender_label || "session", href: "/chat" });
    }
  } catch { /* table may not exist */ }

  return NextResponse.json({
    success: true,
    data: { query, total: results.length, results: results.slice(0, 20) },
  });
}
