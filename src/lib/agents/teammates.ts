import { nanoid } from "nanoid";
import { getSqlite, initializeDatabase } from "@/lib/db";
import { getAgentById, listAgents } from "@/lib/agents/registry";
import { upsertChannelSessionSettings } from "@/lib/channels/session-settings";

export type TeammateMessage = {
  id: string;
  threadId: string;
  fromAgentId: string;
  toAgentId: string;
  subject: string;
  content: string;
  readAt: string | null;
  createdAt: string;
};

function ensureTables() {
  initializeDatabase();
  const db = getSqlite();
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_teammate_sessions (
      agent_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL UNIQUE,
      last_read_at TEXT,
      last_read_message_rowid INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_inbox_messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      from_agent_id TEXT NOT NULL,
      to_agent_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      content TEXT NOT NULL,
      read_at TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_inbox_recipient_unread
      ON agent_inbox_messages(to_agent_id, read_at, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_agent_inbox_thread_created
      ON agent_inbox_messages(thread_id, created_at ASC);
  `);
  const sessionColumns = db.prepare("PRAGMA table_info(agent_teammate_sessions)").all() as Array<{ name: string }>;
  if (!sessionColumns.some((column) => column.name === "last_read_at")) {
    db.exec("ALTER TABLE agent_teammate_sessions ADD COLUMN last_read_at TEXT");
  }
  if (!sessionColumns.some((column) => column.name === "last_read_message_rowid")) {
    db.exec("ALTER TABLE agent_teammate_sessions ADD COLUMN last_read_message_rowid INTEGER NOT NULL DEFAULT 0");
    db.exec(`
      UPDATE agent_teammate_sessions
      SET last_read_message_rowid = COALESCE((
        SELECT MAX(messages.rowid)
        FROM messages
        WHERE messages.session_id = agent_teammate_sessions.session_id
          AND messages.role = 'assistant'
          AND messages.created_at <= COALESCE(agent_teammate_sessions.last_read_at, '')
      ), 0)
    `);
  }
  return db;
}

function safeAgentKey(agentId: string): string {
  return agentId.replace(/[^a-z0-9_-]/gi, "_").slice(0, 64);
}

export function teammateThreadId(a: string, b: string): string {
  return [a || "operator", b || "operator"].sort().map(safeAgentKey).join("__");
}

export function ensureTeammateSession(agentId: string): string {
  const agent = getAgentById(agentId);
  if (!agent) throw new Error(`Agent not found: ${agentId}`);
  const db = ensureTables();
  const existing = db.prepare("SELECT session_id FROM agent_teammate_sessions WHERE agent_id = ?").get(agent.id) as { session_id: string } | undefined;
  if (existing?.session_id) {
    upsertChannelSessionSettings({ sessionId: existing.session_id, agentId: agent.id, workspacePath: agent.workspacePath, modelRef: agent.modelRef });
    db.prepare("UPDATE agent_teammate_sessions SET updated_at = ? WHERE agent_id = ?").run(new Date().toISOString(), agent.id);
    return existing.session_id;
  }
  const sessionId = `teammate_${safeAgentKey(agent.id)}_${nanoid(6)}`;
  const now = new Date().toISOString();
  db.prepare("INSERT INTO agent_teammate_sessions (agent_id, session_id, last_read_at, last_read_message_rowid, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)").run(agent.id, sessionId, now, now, now);
  upsertChannelSessionSettings({ sessionId, agentId: agent.id, workspacePath: agent.workspacePath, modelRef: agent.modelRef });
  db.exec(`CREATE TABLE IF NOT EXISTS chat_session_meta (session_id TEXT PRIMARY KEY, title TEXT, archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  db.prepare("INSERT OR REPLACE INTO chat_session_meta (session_id, title, archived, created_at, updated_at) VALUES (?, ?, 0, ?, ?)").run(sessionId, agent.name, now, now);
  return sessionId;
}

export function sendTeammateMessage(input: { fromAgentId: string; toAgentId: string; subject?: string; content: string; metadata?: Record<string, unknown> }): TeammateMessage {
  const db = ensureTables();
  const fromAgentId = input.fromAgentId.trim() || "operator";
  const toAgentId = input.toAgentId.trim();
  const content = input.content.trim();
  if (!toAgentId || !content) throw new Error("Recipient and content are required");
  for (const participant of [fromAgentId, toAgentId]) {
    if (!["operator", "orchestrator"].includes(participant) && !getAgentById(participant)) {
      throw new Error(`Agent not found: ${participant}`);
    }
  }
  const message: TeammateMessage = {
    id: `inbox_${nanoid(12)}`,
    threadId: teammateThreadId(fromAgentId, toAgentId),
    fromAgentId,
    toAgentId,
    subject: (input.subject?.trim() || "(no subject)").slice(0, 200),
    content: content.slice(0, 64_000),
    readAt: null,
    createdAt: new Date().toISOString(),
  };
  const metadata = input.metadata ? JSON.stringify(input.metadata) : null;
  if (metadata && metadata.length > 16_000) throw new Error("Message metadata exceeds 16,000 characters");
  db.prepare(`INSERT INTO agent_inbox_messages (id, thread_id, from_agent_id, to_agent_id, subject, content, read_at, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`)
    .run(message.id, message.threadId, message.fromAgentId, message.toAgentId, message.subject, message.content, metadata, message.createdAt);
  return message;
}

function mapMessage(row: Record<string, unknown>): TeammateMessage {
  return { id: String(row.id), threadId: String(row.thread_id), fromAgentId: String(row.from_agent_id), toAgentId: String(row.to_agent_id), subject: String(row.subject), content: String(row.content), readAt: row.read_at ? String(row.read_at) : null, createdAt: String(row.created_at) };
}

export function receiveTeammateMessage(recipient: string, consume = true): TeammateMessage | null {
  const db = ensureTables();
  const row = db.prepare("SELECT * FROM agent_inbox_messages WHERE to_agent_id = ? AND read_at IS NULL ORDER BY created_at ASC LIMIT 1").get(recipient) as Record<string, unknown> | undefined;
  if (!row) return null;
  if (consume) db.prepare("UPDATE agent_inbox_messages SET read_at = ? WHERE id = ?").run(new Date().toISOString(), row.id);
  return mapMessage({ ...row, read_at: consume ? new Date().toISOString() : row.read_at });
}

export function listInboxCounts(): Array<{ recipient: string; unread: number }> {
  const rows = ensureTables().prepare("SELECT to_agent_id, COUNT(*) AS unread FROM agent_inbox_messages WHERE read_at IS NULL GROUP BY to_agent_id ORDER BY to_agent_id").all() as Array<{ to_agent_id: string; unread: number }>;
  return rows.map((row) => ({ recipient: row.to_agent_id, unread: Number(row.unread) }));
}

export function listTeammates() {
  const db = ensureTables();
  return listAgents().map((agent) => {
    const mapping = db.prepare("SELECT session_id, last_read_at, last_read_message_rowid FROM agent_teammate_sessions WHERE agent_id = ?").get(agent.id) as { session_id: string; last_read_at: string | null; last_read_message_rowid: number } | undefined;
    const inboxUnread = db.prepare("SELECT COUNT(*) AS count FROM agent_inbox_messages WHERE to_agent_id = 'operator' AND from_agent_id = ? AND read_at IS NULL").get(agent.id) as { count: number };
    const chatUnread = mapping?.session_id
      ? db.prepare("SELECT COUNT(*) AS count FROM messages WHERE session_id = ? AND role = 'assistant' AND rowid > ?").get(mapping.session_id, mapping.last_read_message_rowid ?? 0) as { count: number }
      : { count: 0 };
    const running = db.prepare("SELECT COUNT(*) AS count FROM background_jobs WHERE agent_id = ? AND status = 'running'").get(agent.id) as { count: number };
    const lastInbox = db.prepare(`
      SELECT subject, content, created_at
      FROM agent_inbox_messages
      WHERE (from_agent_id = ? AND to_agent_id = 'operator')
         OR (from_agent_id = 'operator' AND to_agent_id = ?)
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(agent.id, agent.id) as { subject: string; content: string; created_at: string } | undefined;
    const lastChat = mapping?.session_id
      ? db.prepare("SELECT content, created_at FROM messages WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT 1").get(mapping.session_id) as { content: string; created_at: string } | undefined
      : undefined;
    const last = lastChat && (!lastInbox || lastChat.created_at >= lastInbox.created_at)
      ? { subject: "Chat", content: lastChat.content, created_at: lastChat.created_at }
      : lastInbox;
    return {
      id: agent.id,
      name: agent.name,
      isActive: agent.isActive,
      isDefault: agent.isDefault,
      sessionId: mapping?.session_id ?? null,
      unread: Number(inboxUnread?.count ?? 0) + Number(chatUnread?.count ?? 0),
      runningJobs: Number(running?.count ?? 0),
      lastMessage: last ? { subject: last.subject, preview: last.content.slice(0, 120), createdAt: last.created_at } : null,
      hasRoutine: Boolean(agent.heartbeatCron),
    };
  });
}

export function markOperatorThreadRead(agentId: string): number {
  if (!getAgentById(agentId)) throw new Error(`Agent not found: ${agentId}`);
  const db = ensureTables();
  const now = new Date().toISOString();
  const result = db.prepare("UPDATE agent_inbox_messages SET read_at = ? WHERE to_agent_id = 'operator' AND from_agent_id = ? AND read_at IS NULL").run(now, agentId);
  const mapping = db.prepare("SELECT session_id FROM agent_teammate_sessions WHERE agent_id = ?").get(agentId) as { session_id: string } | undefined;
  const lastReadMessageRowid = mapping
    ? Number((db.prepare("SELECT COALESCE(MAX(rowid), 0) AS rowid FROM messages WHERE session_id = ? AND role = 'assistant'").get(mapping.session_id) as { rowid: number }).rowid)
    : 0;
  db.prepare("UPDATE agent_teammate_sessions SET last_read_at = ?, last_read_message_rowid = ?, updated_at = ? WHERE agent_id = ?").run(now, lastReadMessageRowid, now, agentId);
  return Number(result.changes);
}

export function getTeammateAgentForSession(sessionId: string): string | null {
  const row = ensureTables().prepare("SELECT agent_id FROM agent_teammate_sessions WHERE session_id = ?").get(sessionId) as { agent_id: string } | undefined;
  return row?.agent_id ?? null;
}
