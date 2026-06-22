import { getSqlite, initializeDatabase } from "@/lib/db";

export type ChannelDirectoryEntry = {
  channel: string;
  recipient: string;
  sessionId: string;
  label: string;
  lastSeenAt: string;
};

type MessageDirectoryRow = {
  session_id: string;
  metadata: string | null;
  provenance: string | null;
  created_at: string;
};

function inferRecipient(channel: string, sessionId: string): string | null {
  const prefix = `${channel}:`;
  if (!sessionId.startsWith(prefix)) return null;
  return sessionId.slice(prefix.length) || null;
}

function inferLabel(row: MessageDirectoryRow, recipient: string): string {
  try {
    const metadata = row.metadata ? JSON.parse(row.metadata) as Record<string, unknown> : null;
    const sender = String(metadata?.sender || "").trim();
    if (sender) return `${sender} (${recipient})`;
  } catch {
    // ignore malformed metadata
  }
  return recipient;
}

export function listRecentChannelTargets(channelRaw?: string | null, limit = 25): ChannelDirectoryEntry[] {
  initializeDatabase();
  const channel = String(channelRaw || "").trim().toLowerCase();
  const rows = getSqlite()
    .prepare(`
      SELECT session_id, metadata, provenance, MAX(created_at) AS created_at
      FROM messages
      WHERE role = 'user'
      GROUP BY session_id
      ORDER BY created_at DESC
      LIMIT ?
    `)
    .all(Math.max(1, Math.min(limit, 100))) as MessageDirectoryRow[];

  const entries: ChannelDirectoryEntry[] = [];
  for (const row of rows) {
    const sessionId = String(row.session_id || "").trim();
    const inferredChannel = sessionId.includes(":") ? sessionId.split(":")[0].toLowerCase() : "";
    if (!inferredChannel || inferredChannel === "webchat") continue;
    if (channel && inferredChannel !== channel) continue;
    const recipient = inferRecipient(inferredChannel, sessionId);
    if (!recipient) continue;
    entries.push({
      channel: inferredChannel,
      recipient,
      sessionId,
      label: inferLabel(row, recipient),
      lastSeenAt: row.created_at,
    });
  }
  return entries;
}

export function resolveChannelRecipient(channelRaw: string, recipientRaw: string): string | null {
  const channel = String(channelRaw || "").trim().toLowerCase();
  const recipient = String(recipientRaw || "").trim();
  if (!channel || !recipient) return null;
  const entries = listRecentChannelTargets(channel, 50);
  const direct = entries.find((entry) => entry.recipient === recipient);
  if (direct) return direct.recipient;
  const lowered = recipient.toLowerCase();
  const exactLabel = entries.find((entry) => entry.label.toLowerCase() === lowered);
  if (exactLabel) return exactLabel.recipient;
  const partial = entries.filter((entry) => entry.label.toLowerCase().includes(lowered));
  if (partial.length === 1) return partial[0].recipient;
  return null;
}
