import { getSqlite, withSqliteWriteRecovery } from "@/lib/db";

export type AgentRuntimeState = {
  agentId: string;
  sessionId: string | null;
  stateJson: Record<string, unknown> | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedTokens: number;
  totalCostUsd: number;
  lastRunId: string | null;
  lastRunStatus: string | null;
  lastError: string | null;
  updatedAt: string;
};

export function getAgentRuntimeState(agentId: string): AgentRuntimeState | null {
  try {
    const db = getSqlite();
    const row = db
      .prepare(
        `SELECT agent_id, session_id, state_json, total_input_tokens, total_output_tokens,
                total_cached_tokens, total_cost_usd, last_run_id, last_run_status, last_error, updated_at
         FROM agent_runtime_state WHERE agent_id = ?`,
      )
      .get(agentId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return mapRow(row);
  } catch {
    return null;
  }
}

export function upsertAgentRuntimeState(update: {
  agentId: string;
  sessionId?: string | null;
  stateJson?: Record<string, unknown> | null;
  deltaInputTokens?: number;
  deltaOutputTokens?: number;
  deltaCachedTokens?: number;
  deltaCostUsd?: number;
  lastRunId?: string | null;
  lastRunStatus?: string | null;
  lastError?: string | null;
}): void {
  withSqliteWriteRecovery("agent runtime state upsert", (db) => {
    const existing = db
      .prepare(
        `SELECT total_input_tokens, total_output_tokens, total_cached_tokens, total_cost_usd
         FROM agent_runtime_state WHERE agent_id = ?`,
      )
      .get(update.agentId) as
      | {
          total_input_tokens: number;
          total_output_tokens: number;
          total_cached_tokens: number;
          total_cost_usd: number;
        }
      | undefined;

    const now = new Date().toISOString();
    if (!existing) {
      db.prepare(
        `INSERT INTO agent_runtime_state
           (agent_id, session_id, state_json, total_input_tokens, total_output_tokens, total_cached_tokens, total_cost_usd, last_run_id, last_run_status, last_error, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        update.agentId,
        update.sessionId ?? null,
        update.stateJson != null ? JSON.stringify(update.stateJson) : null,
        update.deltaInputTokens ?? 0,
        update.deltaOutputTokens ?? 0,
        update.deltaCachedTokens ?? 0,
        update.deltaCostUsd ?? 0,
        update.lastRunId ?? null,
        update.lastRunStatus ?? null,
        update.lastError ?? null,
        now,
      );
    } else {
      const fields: string[] = [];
      const params: unknown[] = [];

      if (update.sessionId !== undefined) {
        fields.push("session_id = ?");
        params.push(update.sessionId);
      }
      if (update.stateJson !== undefined) {
        fields.push("state_json = ?");
        params.push(update.stateJson != null ? JSON.stringify(update.stateJson) : null);
      }
      if ((update.deltaInputTokens ?? 0) !== 0) {
        fields.push("total_input_tokens = total_input_tokens + ?");
        params.push(update.deltaInputTokens);
      }
      if ((update.deltaOutputTokens ?? 0) !== 0) {
        fields.push("total_output_tokens = total_output_tokens + ?");
        params.push(update.deltaOutputTokens);
      }
      if ((update.deltaCachedTokens ?? 0) !== 0) {
        fields.push("total_cached_tokens = total_cached_tokens + ?");
        params.push(update.deltaCachedTokens);
      }
      if ((update.deltaCostUsd ?? 0) !== 0) {
        fields.push("total_cost_usd = total_cost_usd + ?");
        params.push(update.deltaCostUsd);
      }
      if (update.lastRunId !== undefined) {
        fields.push("last_run_id = ?");
        params.push(update.lastRunId);
      }
      if (update.lastRunStatus !== undefined) {
        fields.push("last_run_status = ?");
        params.push(update.lastRunStatus);
      }
      if (update.lastError !== undefined) {
        fields.push("last_error = ?");
        params.push(update.lastError);
      }

      fields.push("updated_at = ?");
      params.push(now);
      params.push(update.agentId);

      if (fields.length > 1) {
        db.prepare(`UPDATE agent_runtime_state SET ${fields.join(", ")} WHERE agent_id = ?`).run(
          ...params,
        );
      }
    }
  });
}

export function listAgentRuntimeStates(agentIds: string[]): AgentRuntimeState[] {
  if (agentIds.length === 0) return [];
  try {
    const db = getSqlite();
    const placeholders = agentIds.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT agent_id, session_id, state_json, total_input_tokens, total_output_tokens,
                total_cached_tokens, total_cost_usd, last_run_id, last_run_status, last_error, updated_at
         FROM agent_runtime_state WHERE agent_id IN (${placeholders})`,
      )
      .all(...agentIds) as Array<Record<string, unknown>>;
    return rows.map(mapRow);
  } catch {
    return [];
  }
}

function mapRow(row: Record<string, unknown>): AgentRuntimeState {
  let stateJson: Record<string, unknown> | null = null;
  if (typeof row.state_json === "string") {
    try {
      stateJson = JSON.parse(row.state_json) as Record<string, unknown>;
    } catch {
      /* ignore */
    }
  }
  return {
    agentId: String(row.agent_id),
    sessionId: row.session_id != null ? String(row.session_id) : null,
    stateJson,
    totalInputTokens: Number(row.total_input_tokens || 0),
    totalOutputTokens: Number(row.total_output_tokens || 0),
    totalCachedTokens: Number(row.total_cached_tokens || 0),
    totalCostUsd: Number(row.total_cost_usd || 0),
    lastRunId: row.last_run_id != null ? String(row.last_run_id) : null,
    lastRunStatus: row.last_run_status != null ? String(row.last_run_status) : null,
    lastError: row.last_error != null ? String(row.last_error) : null,
    updatedAt: String(row.updated_at),
  };
}
