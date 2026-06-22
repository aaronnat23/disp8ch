import { getSqlite, initializeDatabase, withSqliteWriteRecovery } from "@/lib/db";
import { collectStartupContext, formatStartupContextForPrompt, type WorkspaceScope } from "@/lib/workspace/files";

export type ChannelSessionStartupSnapshotRecord = {
  sessionId: string;
  agentId: string;
  workspacePath: string;
  startupContext: string;
  sourceFiles: string[];
  createdAt: string;
  updatedAt: string;
};

type ChannelSessionStartupSnapshotRow = {
  session_id: string;
  agent_id: string;
  workspace_path: string;
  startup_context: string;
  source_files_json: string | null;
  created_at: string;
  updated_at: string;
};

function parseSourceFiles(value: string | null): string[] {
  try {
    const parsed = JSON.parse(String(value || "[]")) as unknown;
    return Array.isArray(parsed) ? parsed.map((item) => String(item || "").trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function mapRow(row: ChannelSessionStartupSnapshotRow): ChannelSessionStartupSnapshotRecord {
  return {
    sessionId: row.session_id,
    agentId: row.agent_id,
    workspacePath: row.workspace_path,
    startupContext: row.startup_context,
    sourceFiles: parseSourceFiles(row.source_files_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getChannelSessionStartupSnapshot(params: {
  sessionId: string | null | undefined;
  agentId?: string | null | undefined;
}): ChannelSessionStartupSnapshotRecord | null {
  const sessionId = String(params.sessionId || "").trim();
  const agentId = String(params.agentId || "").trim();
  if (!sessionId) return null;
  initializeDatabase();
  const db = getSqlite();
  const row = (agentId
    ? db.prepare(`
        SELECT session_id, agent_id, workspace_path, startup_context, source_files_json, created_at, updated_at
        FROM channel_session_startup_snapshots
        WHERE session_id = ? AND agent_id = ?
      `).get(sessionId, agentId)
    : db.prepare(`
        SELECT session_id, agent_id, workspace_path, startup_context, source_files_json, created_at, updated_at
        FROM channel_session_startup_snapshots
        WHERE session_id = ?
        ORDER BY updated_at DESC
        LIMIT 1
      `).get(sessionId)) as ChannelSessionStartupSnapshotRow | undefined;
  return row ? mapRow(row) : null;
}

export function invalidateChannelSessionStartupSnapshot(params: {
  sessionId: string | null | undefined;
  agentId?: string | null | undefined;
}): number {
  const sessionId = String(params.sessionId || "").trim();
  const agentId = String(params.agentId || "").trim();
  if (!sessionId) return 0;
  let changes = 0;
  withSqliteWriteRecovery("channel-session-startup-snapshot:delete", (db) => {
    changes = agentId
      ? db.prepare("DELETE FROM channel_session_startup_snapshots WHERE session_id = ? AND agent_id = ?").run(sessionId, agentId).changes
      : db.prepare("DELETE FROM channel_session_startup_snapshots WHERE session_id = ?").run(sessionId).changes;
  });
  return changes;
}

export function getOrCreateChannelSessionStartupSnapshot(params: {
  sessionId: string | null | undefined;
  agentId: string;
  workspacePath?: string;
  includeFiles?: string[] | null;
  maxChars?: number;
}): ChannelSessionStartupSnapshotRecord | null {
  const sessionId = String(params.sessionId || "").trim();
  const agentId = String(params.agentId || "").trim();
  if (!sessionId || !agentId) return null;

  const scope: WorkspaceScope | undefined = params.workspacePath ? { workspacePath: params.workspacePath } : undefined;
  const bundle = collectStartupContext({
    workspacePath: scope?.workspacePath,
    includeFiles: params.includeFiles,
  });
  const startupContext = formatStartupContextForPrompt(bundle, params.maxChars ?? 12000);
  const sourceFiles = bundle.files.map((file) => file.path);
  const workspacePath = scope?.workspacePath || "";
  const existing = getChannelSessionStartupSnapshot({ sessionId, agentId });
  if (
    existing &&
    existing.workspacePath === workspacePath &&
    existing.startupContext === startupContext
  ) {
    return existing;
  }
  const now = new Date().toISOString();

  withSqliteWriteRecovery("channel-session-startup-snapshot:create", (db) => {
    db.prepare(`
      INSERT INTO channel_session_startup_snapshots (
        session_id, agent_id, workspace_path, startup_context, source_files_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, agent_id) DO UPDATE SET
        workspace_path = excluded.workspace_path,
        startup_context = excluded.startup_context,
        source_files_json = excluded.source_files_json,
        updated_at = excluded.updated_at
    `).run(
      sessionId,
      agentId,
      workspacePath,
      startupContext,
      JSON.stringify(sourceFiles),
      now,
      now,
    );
  });

  return getChannelSessionStartupSnapshot({ sessionId, agentId });
}

export function formatChannelSessionStartupSnapshotStatus(params: {
  sessionId: string | null | undefined;
  agentId?: string | null | undefined;
}): string {
  const snapshot = getChannelSessionStartupSnapshot(params);
  if (!snapshot) {
    return [
      "## Session Snapshot",
      "**Active:** no",
      "No frozen startup-file snapshot exists for this chat yet.",
      'Start a normal assistant run, then use "show session snapshot status" again.',
    ].join("\n");
  }
  return [
    "## Session Snapshot",
    "**Active:** yes",
    `**Agent:** ${snapshot.agentId}`,
    `**Created:** ${snapshot.createdAt}`,
    `**Updated:** ${snapshot.updatedAt}`,
    `**Source files:** ${snapshot.sourceFiles.length ? snapshot.sourceFiles.join(", ") : "none"}`,
    "This snapshot freezes startup markdown files for the current WebChat session until you reload it or start a new chat.",
  ].join("\n");
}
