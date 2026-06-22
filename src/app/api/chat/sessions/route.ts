import { NextRequest, NextResponse } from "next/server";
import { getSqlite } from "@/lib/db";
import { requireOperatorAccess } from "@/lib/security/admin";

export const dynamic = "force-dynamic";

function sessionTitle(sessionId: string, firstUser: string | null, override: string | null): string {
  const raw = (override || firstUser || sessionId).trim();
  return raw.length > 90 ? `${raw.slice(0, 90)}...` : raw;
}

function ensureSessionMetaTable() {
  const db = getSqlite();
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_session_meta (
      session_id TEXT PRIMARY KEY,
      title TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}

function listSessions(limit = 200) {
  const db = ensureSessionMetaTable();
  return db
    .prepare(
      `SELECT m.session_id AS id,
              meta.title AS title_override,
              MIN(msg.created_at) AS created_at,
              MAX(msg.created_at) AS updated_at,
              COUNT(msg.id) AS message_count,
              SUM(LENGTH(msg.content)) AS size_chars,
              (SELECT content FROM messages first_msg
                WHERE first_msg.session_id = m.session_id AND first_msg.role = 'user'
                ORDER BY first_msg.created_at ASC LIMIT 1) AS first_user
         FROM (
           SELECT session_id FROM chat_session_meta
           UNION
           SELECT DISTINCT session_id FROM messages
         ) m
         LEFT JOIN chat_session_meta meta ON meta.session_id = m.session_id
         LEFT JOIN messages msg ON msg.session_id = m.session_id
        GROUP BY m.session_id
        ORDER BY COALESCE(MAX(msg.created_at), MAX(m.session_id)) DESC
        LIMIT ?`,
    )
    .all(limit)
    .map((row: any) => ({
      id: row.id,
      title: sessionTitle(row.id, row.first_user ?? null, row.title_override ?? null),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      messageCount: Number(row.message_count || 0),
      sizeChars: Number(row.size_chars || 0),
    }));
}

function exportSession(sessionId: string, format: "json" | "markdown") {
  const db = ensureSessionMetaTable();
  const messages = db
    .prepare("SELECT id, role, content, metadata, created_at FROM messages WHERE session_id = ? ORDER BY created_at ASC")
    .all(sessionId) as Array<{ id: string; role: string; content: string; metadata: string | null; created_at: string }>;
  if (format === "json") {
    return {
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify({ sessionId, messages }, null, 2),
    };
  }
  const body = [
    `# Chat Session ${sessionId}`,
    "",
    ...messages.flatMap((message) => [
      `## ${message.role} — ${message.created_at}`,
      "",
      message.content,
      "",
    ]),
  ].join("\n");
  return { contentType: "text/markdown; charset=utf-8", body };
}

export async function GET(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const { searchParams } = new URL(request.url);
    const exportId = searchParams.get("export");
    if (exportId) {
      const format = searchParams.get("format") === "json" ? "json" : "markdown";
      const payload = exportSession(exportId, format);
      return new NextResponse(payload.body, {
        headers: {
          "Content-Type": payload.contentType,
          "Content-Disposition": `attachment; filename="${exportId}.${format === "json" ? "json" : "md"}"`,
        },
      });
    }
    const limit = Math.max(1, Math.min(500, Number(searchParams.get("limit")) || 200));
    return NextResponse.json({ success: true, data: listSessions(limit) });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const db = ensureSessionMetaTable();
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const sessionId = String(body.sessionId || "").trim();
    const title = String(body.title || "").trim();
    if (!sessionId || !title) return NextResponse.json({ success: false, error: "sessionId and title are required" }, { status: 400 });
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO chat_session_meta (session_id, title, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at`,
    ).run(sessionId, title, now, now);
    return NextResponse.json({ success: true, data: listSessions().find((session) => session.id === sessionId) });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const db = ensureSessionMetaTable();
    const { searchParams } = new URL(request.url);
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const deleteEmpty = searchParams.get("empty") === "1" || body.empty === true;
    const ids = Array.isArray(body.sessionIds)
      ? body.sessionIds.map((id) => String(id || "").trim()).filter(Boolean)
      : String(body.sessionId || searchParams.get("sessionId") || "").trim()
        ? [String(body.sessionId || searchParams.get("sessionId")).trim()]
        : [];

    let targetIds = ids;
    if (deleteEmpty) {
      const rows = db
        .prepare(
          `SELECT m.session_id
             FROM chat_session_meta m
             LEFT JOIN messages msg ON msg.session_id = m.session_id
            GROUP BY m.session_id
           HAVING COUNT(msg.id) = 0`,
        )
        .all() as Array<{ session_id: string }>;
      targetIds = rows.map((row) => row.session_id);
    }
    if (targetIds.length === 0) return NextResponse.json({ success: true, data: { deleted: 0 } });

    const placeholders = targetIds.map(() => "?").join(",");
    const tables = [
      "messages",
      "channel_session_turns",
      "channel_session_settings",
      "channel_session_app_state",
      "session_followups",
      "session_todos",
      "session_compaction_state",
      "channel_session_startup_snapshots",
      "chat_session_meta",
    ];
    let deleted = 0;
    for (const table of tables) {
      try {
        const key = table === "chat_session_meta" ? "session_id" : "session_id";
        const result = db.prepare(`DELETE FROM ${table} WHERE ${key} IN (${placeholders})`).run(...targetIds);
        if (table === "messages" || table === "chat_session_meta") deleted += result.changes;
      } catch {
        // Table may not exist in older DBs.
      }
    }
    return NextResponse.json({ success: true, data: { deleted, sessionIds: targetIds } });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
