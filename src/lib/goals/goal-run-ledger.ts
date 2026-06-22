import { nanoid } from "nanoid";
import { getSqlite, initializeDatabase, withSqliteWriteRecovery } from "@/lib/db";

export type GoalRunStatus =
  | "queued"
  | "running"
  | "done"
  | "review"
  | "blocked"
  | "paused"
  | "failed";

export type GoalRunRecord = {
  id: string;
  goalId: string;
  taskId: string | null;
  sessionId: string;
  status: GoalRunStatus;
  turnIndex: number;
  maxTurns: number;
  workerId: string | null;
  modelProvider: string | null;
  modelId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  lastJudgedAt: string | null;
  lastVerdict: string | null;
  lastReason: string | null;
  consecutiveParseFailures: number;
  consecutiveSameBlockers: number;
  toolsUsed: string[];
  deliverables: string[];
  evidenceSummary: string | null;
  createdAt: string;
  updatedAt: string;
};

export type GoalJudgmentRecord = {
  id: string;
  goalId: string;
  taskId: string | null;
  runId: string;
  verdict: "done" | "continue" | "blocked" | "parse_failure";
  reason: string;
  missingCriteria: string[];
  satisfiedCriteria: string[];
  rawResponse: string | null;
  createdAt: string;
};

type GoalRunRow = {
  id: string;
  goal_id: string;
  task_id: string | null;
  session_id: string;
  status: GoalRunStatus;
  turn_index: number | null;
  max_turns: number | null;
  worker_id: string | null;
  model_provider: string | null;
  model_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  last_judged_at: string | null;
  last_verdict: string | null;
  last_reason: string | null;
  consecutive_parse_failures: number | null;
  consecutive_same_blockers: number | null;
  tools_used_json: string | null;
  deliverables_json: string | null;
  evidence_summary: string | null;
  created_at: string;
  updated_at: string;
};

type GoalJudgmentRow = {
  id: string;
  goal_id: string;
  task_id: string | null;
  run_id: string;
  verdict: GoalJudgmentRecord["verdict"];
  reason: string;
  missing_criteria_json: string | null;
  satisfied_criteria_json: string | null;
  raw_response: string | null;
  created_at: string;
};

function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.map((item) => String(item)).filter((item) => item.trim().length > 0)
      : [];
  } catch {
    return [];
  }
}

function runFromRow(row: GoalRunRow): GoalRunRecord {
  return {
    id: row.id,
    goalId: row.goal_id,
    taskId: row.task_id,
    sessionId: row.session_id,
    status: row.status,
    turnIndex: row.turn_index ?? 0,
    maxTurns: row.max_turns ?? 20,
    workerId: row.worker_id,
    modelProvider: row.model_provider,
    modelId: row.model_id,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    lastJudgedAt: row.last_judged_at,
    lastVerdict: row.last_verdict,
    lastReason: row.last_reason,
    consecutiveParseFailures: row.consecutive_parse_failures ?? 0,
    consecutiveSameBlockers: row.consecutive_same_blockers ?? 0,
    toolsUsed: parseJsonArray(row.tools_used_json),
    deliverables: parseJsonArray(row.deliverables_json),
    evidenceSummary: row.evidence_summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function judgmentFromRow(row: GoalJudgmentRow): GoalJudgmentRecord {
  return {
    id: row.id,
    goalId: row.goal_id,
    taskId: row.task_id,
    runId: row.run_id,
    verdict: row.verdict,
    reason: row.reason,
    missingCriteria: parseJsonArray(row.missing_criteria_json),
    satisfiedCriteria: parseJsonArray(row.satisfied_criteria_json),
    rawResponse: row.raw_response,
    createdAt: row.created_at,
  };
}

export function createGoalRun(input: {
  goalId: string;
  taskId?: string | null;
  sessionId: string;
  maxTurns?: number;
  workerId?: string | null;
  modelProvider?: string | null;
  modelId?: string | null;
}): GoalRunRecord {
  initializeDatabase();
  const now = new Date().toISOString();
  const id = nanoid(16);
  withSqliteWriteRecovery("standing-goal-run:create", (writer) => {
    writer.prepare(`
      INSERT INTO standing_goal_runs (
        id, goal_id, task_id, session_id, status, turn_index, max_turns,
        worker_id, model_provider, model_id, tools_used_json, deliverables_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?, '[]', '[]', ?, ?)
    `).run(
      id,
      input.goalId,
      input.taskId ?? null,
      input.sessionId,
      Math.max(1, Math.min(200, Math.floor(input.maxTurns ?? 20))),
      input.workerId ?? null,
      input.modelProvider ?? null,
      input.modelId ?? null,
      now,
      now,
    );
  });
  return getGoalRun(id) ?? {
    id,
    goalId: input.goalId,
    taskId: input.taskId ?? null,
    sessionId: input.sessionId,
    status: "queued",
    turnIndex: 0,
    maxTurns: input.maxTurns ?? 20,
    workerId: input.workerId ?? null,
    modelProvider: input.modelProvider ?? null,
    modelId: input.modelId ?? null,
    startedAt: null,
    completedAt: null,
    lastJudgedAt: null,
    lastVerdict: null,
    lastReason: null,
    consecutiveParseFailures: 0,
    consecutiveSameBlockers: 0,
    toolsUsed: [],
    deliverables: [],
    evidenceSummary: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function getGoalRun(id: string): GoalRunRecord | null {
  initializeDatabase();
  const row = getSqlite().prepare("SELECT * FROM standing_goal_runs WHERE id = ?").get(id) as GoalRunRow | undefined;
  return row ? runFromRow(row) : null;
}

export function updateGoalRun(
  id: string,
  patch: Partial<{
    status: GoalRunStatus;
    turnIndex: number;
    startedAt: string | null;
    completedAt: string | null;
    lastJudgedAt: string | null;
    lastVerdict: string | null;
    lastReason: string | null;
    consecutiveParseFailures: number;
    consecutiveSameBlockers: number;
    toolsUsed: string[];
    deliverables: string[];
    evidenceSummary: string | null;
  }>,
): GoalRunRecord | null {
  initializeDatabase();
  const columns: string[] = [];
  const values: unknown[] = [];
  const columnMap: Array<[keyof typeof patch, string, (value: unknown) => unknown]> = [
    ["status", "status", (value) => value],
    ["turnIndex", "turn_index", (value) => value],
    ["startedAt", "started_at", (value) => value],
    ["completedAt", "completed_at", (value) => value],
    ["lastJudgedAt", "last_judged_at", (value) => value],
    ["lastVerdict", "last_verdict", (value) => value],
    ["lastReason", "last_reason", (value) => value],
    ["consecutiveParseFailures", "consecutive_parse_failures", (value) => value],
    ["consecutiveSameBlockers", "consecutive_same_blockers", (value) => value],
    ["toolsUsed", "tools_used_json", (value) => JSON.stringify(Array.isArray(value) ? value : [])],
    ["deliverables", "deliverables_json", (value) => JSON.stringify(Array.isArray(value) ? value : [])],
    ["evidenceSummary", "evidence_summary", (value) => value],
  ];
  for (const [key, column, normalize] of columnMap) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      columns.push(`${column} = ?`);
      values.push(normalize(patch[key]));
    }
  }
  if (columns.length === 0) return getGoalRun(id);
  columns.push("updated_at = ?");
  values.push(new Date().toISOString(), id);
  withSqliteWriteRecovery("standing-goal-run:update", (writer) => {
    writer.prepare(`UPDATE standing_goal_runs SET ${columns.join(", ")} WHERE id = ?`).run(...values);
  });
  return getGoalRun(id);
}

export function appendGoalJudgment(input: {
  runId: string;
  goalId: string;
  taskId?: string | null;
  verdict: GoalJudgmentRecord["verdict"];
  reason: string;
  missingCriteria?: string[];
  satisfiedCriteria?: string[];
  rawResponse?: string | null;
}): GoalJudgmentRecord {
  initializeDatabase();
  const id = nanoid(16);
  const now = new Date().toISOString();
  withSqliteWriteRecovery("standing-goal-judgment:append", (writer) => {
    writer.prepare(`
      INSERT INTO standing_goal_judgments (
        id, goal_id, task_id, run_id, verdict, reason,
        missing_criteria_json, satisfied_criteria_json, raw_response, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.goalId,
      input.taskId ?? null,
      input.runId,
      input.verdict,
      input.reason,
      JSON.stringify(input.missingCriteria ?? []),
      JSON.stringify(input.satisfiedCriteria ?? []),
      input.rawResponse ?? null,
      now,
    );
  });
  return {
    id,
    goalId: input.goalId,
    taskId: input.taskId ?? null,
    runId: input.runId,
    verdict: input.verdict,
    reason: input.reason,
    missingCriteria: input.missingCriteria ?? [],
    satisfiedCriteria: input.satisfiedCriteria ?? [],
    rawResponse: input.rawResponse ?? null,
    createdAt: now,
  };
}

export function listGoalRuns(goalId: string, limit = 20): GoalRunRecord[] {
  initializeDatabase();
  const rows = getSqlite().prepare(`
    SELECT * FROM standing_goal_runs
    WHERE goal_id = ?
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(goalId, Math.max(1, Math.min(200, Math.floor(limit)))) as GoalRunRow[];
  return rows.map(runFromRow);
}

export function listGoalJudgments(goalId: string, limit = 20): GoalJudgmentRecord[] {
  initializeDatabase();
  const rows = getSqlite().prepare(`
    SELECT * FROM standing_goal_judgments
    WHERE goal_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(goalId, Math.max(1, Math.min(200, Math.floor(limit)))) as GoalJudgmentRow[];
  return rows.map(judgmentFromRow);
}

export function getActiveGoalRun(goalId: string): GoalRunRecord | null {
  initializeDatabase();
  const row = getSqlite().prepare(`
    SELECT * FROM standing_goal_runs
    WHERE goal_id = ? AND status IN ('queued', 'running', 'review')
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(goalId) as GoalRunRow | undefined;
  return row ? runFromRow(row) : null;
}
