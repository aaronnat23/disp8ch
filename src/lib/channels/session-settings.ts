import { getSqlite, initializeDatabase } from "@/lib/db";

export type ChannelSessionSettings = {
  sessionId: string;
  fastMode: boolean | null;
  agentId: string | null;
  modelRef: string | null;
  workspacePath: string | null;
  toolMode: "default" | "restricted" | "full";
  createdAt: string;
  updatedAt: string;
};

type ChannelSessionSettingsRow = {
  session_id: string;
  fast_mode: number | null;
  agent_id: string | null;
  model_ref: string | null;
  workspace_path: string | null;
  tool_mode: string | null;
  created_at: string;
  updated_at: string;
};

function normalizeText(value: unknown): string | null {
  const text = String(value || "").trim();
  return text || null;
}

function normalizeToolMode(value: unknown): ChannelSessionSettings["toolMode"] {
  return value === "restricted" || value === "full" ? value : "default";
}

function rowToSettings(row: ChannelSessionSettingsRow): ChannelSessionSettings {
  return {
    sessionId: row.session_id,
    fastMode:
      row.fast_mode === 1 ? true : row.fast_mode === 0 ? false : null,
    agentId: normalizeText(row.agent_id),
    modelRef: normalizeText(row.model_ref),
    workspacePath: normalizeText(row.workspace_path),
    toolMode: normalizeToolMode(row.tool_mode),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getChannelSessionSettings(
  sessionId: string,
): ChannelSessionSettings | null {
  initializeDatabase();
  const db = getSqlite();
  const row = db
    .prepare(
      "SELECT session_id, fast_mode, agent_id, model_ref, workspace_path, tool_mode, created_at, updated_at FROM channel_session_settings WHERE session_id = ?",
    )
    .get(sessionId) as ChannelSessionSettingsRow | undefined;
  return row ? rowToSettings(row) : null;
}

export function resolveChannelSessionFastMode(
  sessionId: string | null | undefined,
): boolean | null {
  if (!sessionId) return null;
  return getChannelSessionSettings(sessionId)?.fastMode ?? null;
}

export function resolveChannelSessionModelRef(
  sessionId: string | null | undefined,
): string | null {
  if (!sessionId) return null;
  return getChannelSessionSettings(sessionId)?.modelRef ?? null;
}

export function resolveChannelSessionAgentId(
  sessionId: string | null | undefined,
): string | null {
  if (!sessionId) return null;
  return getChannelSessionSettings(sessionId)?.agentId ?? null;
}

export function upsertChannelSessionSettings(params: {
  sessionId: string;
  fastMode?: boolean | null;
  agentId?: string | null;
  modelRef?: string | null;
  workspacePath?: string | null;
  toolMode?: ChannelSessionSettings["toolMode"] | null;
}): ChannelSessionSettings {
  initializeDatabase();
  const db = getSqlite();
  const existing = getChannelSessionSettings(params.sessionId);
  const now = new Date().toISOString();
  const fastMode = params.fastMode === undefined ? existing?.fastMode ?? null : params.fastMode;
  const agentId = params.agentId === undefined ? existing?.agentId ?? null : normalizeText(params.agentId);
  const modelRef = params.modelRef === undefined ? existing?.modelRef ?? null : normalizeText(params.modelRef);
  const workspacePath = params.workspacePath === undefined ? existing?.workspacePath ?? null : normalizeText(params.workspacePath);
  const toolMode = params.toolMode === undefined || params.toolMode === null
    ? existing?.toolMode ?? "default"
    : normalizeToolMode(params.toolMode);
  db.prepare(
    `
      INSERT INTO channel_session_settings (
        session_id, fast_mode, agent_id, model_ref, workspace_path, tool_mode, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        fast_mode = excluded.fast_mode,
        agent_id = excluded.agent_id,
        model_ref = excluded.model_ref,
        workspace_path = excluded.workspace_path,
        tool_mode = excluded.tool_mode,
        updated_at = excluded.updated_at
    `,
  ).run(
    params.sessionId,
    fastMode === null ? null : fastMode ? 1 : 0,
    agentId,
    modelRef,
    workspacePath,
    toolMode,
    now,
    now,
  );
  return getChannelSessionSettings(params.sessionId) ?? {
    sessionId: params.sessionId,
    fastMode,
    agentId,
    modelRef,
    workspacePath,
    toolMode,
    createdAt: now,
    updatedAt: now,
  };
}

export function clearChannelSessionSettings(sessionId: string): void {
  initializeDatabase();
  const db = getSqlite();
  db.prepare("DELETE FROM channel_session_settings WHERE session_id = ?").run(sessionId);
}
