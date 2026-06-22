import crypto from "node:crypto";
import { getSqlite, withSqliteWriteRecovery } from "@/lib/db";
import type {
  DynamicWorkflowCommandRecord,
  DynamicWorkflowEventRecord,
  DynamicWorkflowPhaseRecord,
  DynamicWorkflowPhaseStatus,
  DynamicWorkflowRunRecord,
  DynamicWorkflowRunStatus,
  DynamicWorkflowWorkerRecord,
  DynamicWorkflowWorkerStatus,
  PopulatedDynamicWorkflowRun,
} from "@/lib/dynamic-workflows/types";

function nowIso(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Table creation
// ---------------------------------------------------------------------------

export function ensureDynamicWorkflowTables(): void {
  const db = getSqlite();

  // Dynamic workflows core tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS dynamic_workflow_runs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      source_type TEXT,
      source_ref TEXT,
      organization_id TEXT,
      goal_id TEXT,
      board_task_id TEXT,
      manager_agent_id TEXT,
      model_ref TEXT,
      max_concurrency INTEGER NOT NULL DEFAULT 4,
      max_workers INTEGER NOT NULL DEFAULT 16,
      approval_policy TEXT NOT NULL DEFAULT 'auto',
      budget_limit_usd REAL,
      estimated_cost_usd REAL,
      actual_cost_usd REAL,
      plan_json TEXT NOT NULL DEFAULT '{}',
      saved_command_name TEXT,
      created_by_session_id TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_dwr_status ON dynamic_workflow_runs(status);
    CREATE INDEX IF NOT EXISTS idx_dwr_created_at ON dynamic_workflow_runs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_dwr_goal_id ON dynamic_workflow_runs(goal_id);
    CREATE INDEX IF NOT EXISTS idx_dwr_organization_id ON dynamic_workflow_runs(organization_id);
    CREATE INDEX IF NOT EXISTS idx_dwr_source_type ON dynamic_workflow_runs(source_type);

    CREATE TABLE IF NOT EXISTS dynamic_workflow_phases (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      phase_index INTEGER NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      instructions TEXT,
      depends_on_phase_ids TEXT,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES dynamic_workflow_runs(id)
    );

    CREATE INDEX IF NOT EXISTS idx_dwp_run_id ON dynamic_workflow_phases(run_id, phase_index);
    CREATE INDEX IF NOT EXISTS idx_dwp_status ON dynamic_workflow_phases(run_id, status);

    CREATE TABLE IF NOT EXISTS dynamic_workflow_workers (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      phase_id TEXT NOT NULL,
      worker_index INTEGER NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      agent_kind TEXT NOT NULL DEFAULT 'internal',
      agent_id TEXT,
      model_ref TEXT,
      prompt TEXT NOT NULL DEFAULT '',
      tool_policy_json TEXT,
      result_summary TEXT,
      result_json TEXT,
      error TEXT,
      cached_result_key TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cost_usd REAL,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES dynamic_workflow_runs(id),
      FOREIGN KEY(phase_id) REFERENCES dynamic_workflow_phases(id)
    );

    CREATE INDEX IF NOT EXISTS idx_dww_phase_id ON dynamic_workflow_workers(phase_id, worker_index);
    CREATE INDEX IF NOT EXISTS idx_dww_run_id ON dynamic_workflow_workers(run_id);
    CREATE INDEX IF NOT EXISTS idx_dww_status ON dynamic_workflow_workers(run_id, status);

    CREATE TABLE IF NOT EXISTS dynamic_workflow_events (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      phase_id TEXT,
      worker_id TEXT,
      event_type TEXT NOT NULL,
      title TEXT,
      detail TEXT,
      payload_json TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES dynamic_workflow_runs(id)
    );

    CREATE INDEX IF NOT EXISTS idx_dwe_run_id ON dynamic_workflow_events(run_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_dwe_event_type ON dynamic_workflow_events(run_id, event_type);

    CREATE TABLE IF NOT EXISTS dynamic_workflow_commands (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      plan_template_json TEXT NOT NULL DEFAULT '{}',
      default_model_ref TEXT,
      default_max_concurrency INTEGER NOT NULL DEFAULT 4,
      created_from_run_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_dwc_name ON dynamic_workflow_commands(name);
  `);

  // MCP approval wiring for dynamic workflow worker pauses
  const { ensureMcpApprovalTables } = require("./mcp-approval");
  ensureMcpApprovalTables();
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function mapRunRow(row: Record<string, unknown>): DynamicWorkflowRunRecord {
  return {
    id: row.id as string,
    name: row.name as string,
    description: (row.description as string) ?? null,
    status: row.status as DynamicWorkflowRunStatus,
    sourceType: (row.source_type as DynamicWorkflowRunRecord["sourceType"]) ?? null,
    sourceRef: (row.source_ref as string) ?? null,
    organizationId: (row.organization_id as string) ?? null,
    goalId: (row.goal_id as string) ?? null,
    boardTaskId: (row.board_task_id as string) ?? null,
    managerAgentId: (row.manager_agent_id as string) ?? null,
    modelRef: (row.model_ref as string) ?? null,
    maxConcurrency: row.max_concurrency as number,
    maxWorkers: row.max_workers as number,
    approvalPolicy: row.approval_policy as string,
    budgetLimitUsd: (row.budget_limit_usd as number) ?? null,
    estimatedCostUsd: (row.estimated_cost_usd as number) ?? null,
    actualCostUsd: (row.actual_cost_usd as number) ?? null,
    planJson: row.plan_json as string,
    savedCommandName: (row.saved_command_name as string) ?? null,
    createdBySessionId: (row.created_by_session_id as string) ?? null,
    error: (row.error as string) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    startedAt: (row.started_at as string) ?? null,
    completedAt: (row.completed_at as string) ?? null,
  };
}

function mapPhaseRow(row: Record<string, unknown>): DynamicWorkflowPhaseRecord {
  return {
    id: row.id as string,
    runId: row.run_id as string,
    phaseIndex: row.phase_index as number,
    name: row.name as string,
    status: row.status as DynamicWorkflowPhaseStatus,
    instructions: (row.instructions as string) ?? null,
    dependsOnPhaseIds: (row.depends_on_phase_ids as string) ?? null,
    startedAt: (row.started_at as string) ?? null,
    completedAt: (row.completed_at as string) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function mapWorkerRow(row: Record<string, unknown>): DynamicWorkflowWorkerRecord {
  return {
    id: row.id as string,
    runId: row.run_id as string,
    phaseId: row.phase_id as string,
    workerIndex: row.worker_index as number,
    role: row.role as string,
    status: row.status as DynamicWorkflowWorkerStatus,
    agentKind: row.agent_kind as DynamicWorkflowWorkerRecord["agentKind"],
    agentId: (row.agent_id as string) ?? null,
    modelRef: (row.model_ref as string) ?? null,
    prompt: row.prompt as string,
    toolPolicyJson: (row.tool_policy_json as string) ?? null,
    resultSummary: (row.result_summary as string) ?? null,
    resultJson: (row.result_json as string) ?? null,
    error: (row.error as string) ?? null,
    cachedResultKey: (row.cached_result_key as string) ?? null,
    inputTokens: (row.input_tokens as number) ?? null,
    outputTokens: (row.output_tokens as number) ?? null,
    costUsd: (row.cost_usd as number) ?? null,
    startedAt: (row.started_at as string) ?? null,
    completedAt: (row.completed_at as string) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function mapEventRow(row: Record<string, unknown>): DynamicWorkflowEventRecord {
  return {
    id: row.id as string,
    runId: row.run_id as string,
    phaseId: (row.phase_id as string) ?? null,
    workerId: (row.worker_id as string) ?? null,
    eventType: row.event_type as string,
    title: (row.title as string) ?? null,
    detail: (row.detail as string) ?? null,
    payloadJson: (row.payload_json as string) ?? null,
    createdAt: row.created_at as string,
  };
}

function mapCommandRow(row: Record<string, unknown>): DynamicWorkflowCommandRecord {
  return {
    id: row.id as string,
    name: row.name as string,
    description: (row.description as string) ?? null,
    planTemplateJson: row.plan_template_json as string,
    defaultModelRef: (row.default_model_ref as string) ?? null,
    defaultMaxConcurrency: row.default_max_concurrency as number,
    createdFromRunId: (row.created_from_run_id as string) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

// ---------------------------------------------------------------------------
// SELECT helpers
// ---------------------------------------------------------------------------

const SELECT_RUN = `
  SELECT id, name, description, status, source_type, source_ref,
    organization_id, goal_id, board_task_id, manager_agent_id,
    model_ref, max_concurrency, max_workers, approval_policy,
    budget_limit_usd, estimated_cost_usd, actual_cost_usd,
    plan_json, saved_command_name, created_by_session_id, error,
    created_at, updated_at, started_at, completed_at
  FROM dynamic_workflow_runs
`;

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export function upsertDynamicWorkflowRun(run: DynamicWorkflowRunRecord): DynamicWorkflowRunRecord {
  ensureDynamicWorkflowTables();
  const now = nowIso();

  withSqliteWriteRecovery("dynamic-workflows:upsertRun", (db) => {
    db.prepare(`
      INSERT INTO dynamic_workflow_runs (
        id, name, description, status, source_type, source_ref,
        organization_id, goal_id, board_task_id, manager_agent_id,
        model_ref, max_concurrency, max_workers, approval_policy,
        budget_limit_usd, estimated_cost_usd, actual_cost_usd,
        plan_json, saved_command_name, created_by_session_id, error,
        created_at, updated_at, started_at, completed_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?
      )
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        status = excluded.status,
        source_type = excluded.source_type,
        source_ref = excluded.source_ref,
        organization_id = excluded.organization_id,
        goal_id = excluded.goal_id,
        board_task_id = excluded.board_task_id,
        manager_agent_id = excluded.manager_agent_id,
        model_ref = excluded.model_ref,
        max_concurrency = excluded.max_concurrency,
        max_workers = excluded.max_workers,
        approval_policy = excluded.approval_policy,
        budget_limit_usd = excluded.budget_limit_usd,
        estimated_cost_usd = excluded.estimated_cost_usd,
        actual_cost_usd = excluded.actual_cost_usd,
        plan_json = excluded.plan_json,
        saved_command_name = excluded.saved_command_name,
        created_by_session_id = excluded.created_by_session_id,
        error = excluded.error,
        updated_at = excluded.updated_at,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at
    `).run(
      run.id,
      run.name,
      run.description ?? null,
      run.status,
      run.sourceType ?? null,
      run.sourceRef ?? null,
      run.organizationId ?? null,
      run.goalId ?? null,
      run.boardTaskId ?? null,
      run.managerAgentId ?? null,
      run.modelRef ?? null,
      run.maxConcurrency,
      run.maxWorkers,
      run.approvalPolicy,
      run.budgetLimitUsd ?? null,
      run.estimatedCostUsd ?? null,
      run.actualCostUsd ?? null,
      run.planJson,
      run.savedCommandName ?? null,
      run.createdBySessionId ?? null,
      run.error ?? null,
      run.createdAt || now,
      now,
      run.startedAt ?? null,
      run.completedAt ?? null,
    );
  });

  return getDynamicWorkflowRun(run.id)!;
}

export function getDynamicWorkflowRun(id: string): DynamicWorkflowRunRecord | undefined {
  ensureDynamicWorkflowTables();
  const row = getSqlite()
    .prepare(`${SELECT_RUN} WHERE id = ?`)
    .get(id) as Record<string, unknown> | undefined;
  return row ? mapRunRow(row) : undefined;
}

export function updateDynamicWorkflowRunSavedCommand(runId: string, commandName: string | null): void {
  ensureDynamicWorkflowTables();
  const now = nowIso();
  withSqliteWriteRecovery("dynamic-workflows:updateRunSavedCommand", (db) => {
    db.prepare(`
      UPDATE dynamic_workflow_runs SET saved_command_name = ?, updated_at = ? WHERE id = ?
    `).run(commandName ?? null, now, runId);
  });
}

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

export function upsertDynamicWorkflowPhase(phase: DynamicWorkflowPhaseRecord): DynamicWorkflowPhaseRecord {
  ensureDynamicWorkflowTables();
  const now = nowIso();

  withSqliteWriteRecovery("dynamic-workflows:upsertPhase", (db) => {
    db.prepare(`
      INSERT INTO dynamic_workflow_phases (
        id, run_id, phase_index, name, status, instructions,
        depends_on_phase_ids, started_at, completed_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        run_id = excluded.run_id,
        phase_index = excluded.phase_index,
        name = excluded.name,
        status = excluded.status,
        instructions = excluded.instructions,
        depends_on_phase_ids = excluded.depends_on_phase_ids,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at,
        updated_at = excluded.updated_at
    `).run(
      phase.id,
      phase.runId,
      phase.phaseIndex,
      phase.name,
      phase.status,
      phase.instructions ?? null,
      phase.dependsOnPhaseIds ?? null,
      phase.startedAt ?? null,
      phase.completedAt ?? null,
      phase.createdAt || now,
      now,
    );
  });

  return getDynamicWorkflowPhases(phase.runId).find((p) => p.id === phase.id)!;
}

export function getDynamicWorkflowPhases(runId: string): DynamicWorkflowPhaseRecord[] {
  ensureDynamicWorkflowTables();
  const rows = getSqlite()
    .prepare(`
      SELECT * FROM dynamic_workflow_phases
      WHERE run_id = ?
      ORDER BY phase_index ASC
    `)
    .all(runId) as Array<Record<string, unknown>>;
  return rows.map(mapPhaseRow);
}

// ---------------------------------------------------------------------------
// Workers
// ---------------------------------------------------------------------------

export function upsertDynamicWorkflowWorker(worker: DynamicWorkflowWorkerRecord): DynamicWorkflowWorkerRecord {
  ensureDynamicWorkflowTables();
  const now = nowIso();

  withSqliteWriteRecovery("dynamic-workflows:upsertWorker", (db) => {
    db.prepare(`
      INSERT INTO dynamic_workflow_workers (
        id, run_id, phase_id, worker_index, role, status, agent_kind,
        agent_id, model_ref, prompt, tool_policy_json,
        result_summary, result_json, error, cached_result_key,
        input_tokens, output_tokens, cost_usd,
        started_at, completed_at, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?
      )
      ON CONFLICT(id) DO UPDATE SET
        run_id = excluded.run_id,
        phase_id = excluded.phase_id,
        worker_index = excluded.worker_index,
        role = excluded.role,
        status = excluded.status,
        agent_kind = excluded.agent_kind,
        agent_id = excluded.agent_id,
        model_ref = excluded.model_ref,
        prompt = excluded.prompt,
        tool_policy_json = excluded.tool_policy_json,
        result_summary = excluded.result_summary,
        result_json = excluded.result_json,
        error = excluded.error,
        cached_result_key = excluded.cached_result_key,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        cost_usd = excluded.cost_usd,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at,
        updated_at = excluded.updated_at
    `).run(
      worker.id,
      worker.runId,
      worker.phaseId,
      worker.workerIndex,
      worker.role,
      worker.status,
      worker.agentKind,
      worker.agentId ?? null,
      worker.modelRef ?? null,
      worker.prompt,
      worker.toolPolicyJson ?? null,
      worker.resultSummary ?? null,
      worker.resultJson ?? null,
      worker.error ?? null,
      worker.cachedResultKey ?? null,
      worker.inputTokens ?? null,
      worker.outputTokens ?? null,
      worker.costUsd ?? null,
      worker.startedAt ?? null,
      worker.completedAt ?? null,
      worker.createdAt || now,
      now,
    );
  });

  return getDynamicWorkflowWorker(worker.id)!;
}

export function getDynamicWorkflowWorkers(
  runId: string,
  phaseId?: string,
): DynamicWorkflowWorkerRecord[] {
  ensureDynamicWorkflowTables();

  if (phaseId) {
    const rows = getSqlite()
      .prepare(`
        SELECT * FROM dynamic_workflow_workers
        WHERE run_id = ? AND phase_id = ?
        ORDER BY worker_index ASC
      `)
      .all(runId, phaseId) as Array<Record<string, unknown>>;
    return rows.map(mapWorkerRow);
  }

  const rows = getSqlite()
    .prepare(`
      SELECT * FROM dynamic_workflow_workers
      WHERE run_id = ?
      ORDER BY phase_id, worker_index ASC
    `)
    .all(runId) as Array<Record<string, unknown>>;
  return rows.map(mapWorkerRow);
}

export function getDynamicWorkflowWorker(id: string): DynamicWorkflowWorkerRecord | undefined {
  ensureDynamicWorkflowTables();
  const row = getSqlite()
    .prepare("SELECT * FROM dynamic_workflow_workers WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;
  return row ? mapWorkerRow(row) : undefined;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export function createDynamicWorkflowEvent(event: DynamicWorkflowEventRecord): DynamicWorkflowEventRecord {
  ensureDynamicWorkflowTables();

  withSqliteWriteRecovery("dynamic-workflows:createEvent", (db) => {
    db.prepare(`
      INSERT INTO dynamic_workflow_events (
        id, run_id, phase_id, worker_id, event_type,
        title, detail, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.runId,
      event.phaseId ?? null,
      event.workerId ?? null,
      event.eventType,
      event.title ?? null,
      event.detail ?? null,
      event.payloadJson ?? null,
      event.createdAt,
    );
  });

  return event;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export function getDynamicWorkflowCommand(name: string): DynamicWorkflowCommandRecord | undefined {
  ensureDynamicWorkflowTables();
  const row = getSqlite()
    .prepare("SELECT * FROM dynamic_workflow_commands WHERE name = ?")
    .get(name) as Record<string, unknown> | undefined;
  return row ? mapCommandRow(row) : undefined;
}

export function listDynamicWorkflowCommands(): DynamicWorkflowCommandRecord[] {
  ensureDynamicWorkflowTables();
  const rows = getSqlite()
    .prepare("SELECT * FROM dynamic_workflow_commands ORDER BY name ASC")
    .all() as Array<Record<string, unknown>>;
  return rows.map(mapCommandRow);
}

export function createDynamicWorkflowCommand(
  cmd: Omit<DynamicWorkflowCommandRecord, "createdAt" | "updatedAt">,
): DynamicWorkflowCommandRecord {
  ensureDynamicWorkflowTables();
  const now = nowIso();

  withSqliteWriteRecovery("dynamic-workflows:createCommand", (db) => {
    db.prepare(`
      INSERT INTO dynamic_workflow_commands (
        id, name, description, plan_template_json,
        default_model_ref, default_max_concurrency,
        created_from_run_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      cmd.id,
      cmd.name,
      cmd.description ?? null,
      cmd.planTemplateJson,
      cmd.defaultModelRef ?? null,
      cmd.defaultMaxConcurrency,
      cmd.createdFromRunId ?? null,
      now,
      now,
    );
  });

  const row = getSqlite()
    .prepare("SELECT * FROM dynamic_workflow_commands WHERE id = ?")
    .get(cmd.id) as Record<string, unknown> | undefined;
  if (!row) throw new Error("Command was not saved");
  return mapCommandRow(row);
}

export function deleteDynamicWorkflowCommand(name: string): boolean {
  ensureDynamicWorkflowTables();
  const db = getSqlite();
  const result = db.prepare("DELETE FROM dynamic_workflow_commands WHERE name = ?").run(name);
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// User-spec aliases (create-only variants for createRun, createPhase, etc.)
// ---------------------------------------------------------------------------

export function createRun(
  run: Omit<DynamicWorkflowRunRecord, "id" | "createdAt" | "updatedAt">,
): DynamicWorkflowRunRecord {
  ensureDynamicWorkflowTables();
  const id = crypto.randomUUID();
  const now = nowIso();

  withSqliteWriteRecovery("dynamic-workflows:createRun", (db) => {
    db.prepare(`
      INSERT INTO dynamic_workflow_runs (
        id, name, description, status, source_type, source_ref,
        organization_id, goal_id, board_task_id, manager_agent_id,
        model_ref, max_concurrency, max_workers, approval_policy,
        budget_limit_usd, estimated_cost_usd, actual_cost_usd,
        plan_json, saved_command_name, created_by_session_id, error,
        created_at, updated_at, started_at, completed_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?
      )
    `).run(
      id,
      run.name,
      run.description ?? null,
      run.status,
      run.sourceType ?? null,
      run.sourceRef ?? null,
      run.organizationId ?? null,
      run.goalId ?? null,
      run.boardTaskId ?? null,
      run.managerAgentId ?? null,
      run.modelRef ?? null,
      run.maxConcurrency,
      run.maxWorkers,
      run.approvalPolicy,
      run.budgetLimitUsd ?? null,
      run.estimatedCostUsd ?? null,
      run.actualCostUsd ?? null,
      run.planJson,
      run.savedCommandName ?? null,
      run.createdBySessionId ?? null,
      run.error ?? null,
      now,
      now,
      run.startedAt ?? null,
      run.completedAt ?? null,
    );
  });

  return getDynamicWorkflowRun(id)!;
}

export const getRun = getDynamicWorkflowRun;

export function updateRunStatus(
  id: string,
  status: DynamicWorkflowRunStatus,
  extra?: Partial<DynamicWorkflowRunRecord>,
): void {
  ensureDynamicWorkflowTables();
  const now = nowIso();

  withSqliteWriteRecovery("dynamic-workflows:updateRunStatus", (db) => {
    const sets: string[] = ["status = ?", "updated_at = ?"];
    const vals: unknown[] = [status, now];

    if (extra?.startedAt !== undefined) {
      sets.push("started_at = ?");
      vals.push(extra.startedAt ?? null);
    }
    if (extra?.completedAt !== undefined) {
      sets.push("completed_at = ?");
      vals.push(extra.completedAt ?? null);
    }
    if (extra?.actualCostUsd !== undefined) {
      sets.push("actual_cost_usd = ?");
      vals.push(extra.actualCostUsd ?? null);
    }
    if (extra?.estimatedCostUsd !== undefined) {
      sets.push("estimated_cost_usd = ?");
      vals.push(extra.estimatedCostUsd ?? null);
    }
    if (extra?.error !== undefined) {
      sets.push("error = ?");
      vals.push(extra.error ?? null);
    }

    vals.push(id);
    db.prepare(
      `UPDATE dynamic_workflow_runs SET ${sets.join(", ")} WHERE id = ?`,
    ).run(...vals);
  });
}

export function listRuns(
  filters?: {
    status?: DynamicWorkflowRunStatus;
    goalId?: string;
    organizationId?: string;
    limit?: number;
    offset?: number;
  },
): DynamicWorkflowRunRecord[] {
  ensureDynamicWorkflowTables();

  const clauses: string[] = [];
  const vals: unknown[] = [];

  if (filters?.status) {
    clauses.push("status = ?");
    vals.push(filters.status);
  }
  if (filters?.goalId) {
    clauses.push("goal_id = ?");
    vals.push(filters.goalId);
  }
  if (filters?.organizationId) {
    clauses.push("organization_id = ?");
    vals.push(filters.organizationId);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = Math.max(1, Math.min(200, filters?.limit ?? 50));
  const offset = Math.max(0, filters?.offset ?? 0);

  const rows = getSqlite()
    .prepare(`
      ${SELECT_RUN}
      ${where}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `)
    .all(...vals, limit, offset) as Array<Record<string, unknown>>;

  return rows.map(mapRunRow);
}

export function createPhase(
  phase: Omit<DynamicWorkflowPhaseRecord, "id" | "createdAt" | "updatedAt">,
): DynamicWorkflowPhaseRecord {
  ensureDynamicWorkflowTables();
  const id = crypto.randomUUID();
  const now = nowIso();

  withSqliteWriteRecovery("dynamic-workflows:createPhase", (db) => {
    db.prepare(`
      INSERT INTO dynamic_workflow_phases (
        id, run_id, phase_index, name, status, instructions,
        depends_on_phase_ids, started_at, completed_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      phase.runId,
      phase.phaseIndex,
      phase.name,
      phase.status,
      phase.instructions ?? null,
      phase.dependsOnPhaseIds ?? null,
      phase.startedAt ?? null,
      phase.completedAt ?? null,
      now,
      now,
    );
  });

  const row = getSqlite()
    .prepare("SELECT * FROM dynamic_workflow_phases WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;
  if (!row) throw new Error("Phase was not saved");
  return mapPhaseRow(row);
}

export function updatePhaseStatus(
  id: string,
  status: DynamicWorkflowPhaseStatus,
  extra?: Partial<DynamicWorkflowPhaseRecord>,
): void {
  ensureDynamicWorkflowTables();
  const now = nowIso();

  withSqliteWriteRecovery("dynamic-workflows:updatePhaseStatus", (db) => {
    const sets: string[] = ["status = ?", "updated_at = ?"];
    const vals: unknown[] = [status, now];

    if (extra?.startedAt !== undefined) {
      sets.push("started_at = ?");
      vals.push(extra.startedAt ?? null);
    }
    if (extra?.completedAt !== undefined) {
      sets.push("completed_at = ?");
      vals.push(extra.completedAt ?? null);
    }

    vals.push(id);
    db.prepare(
      `UPDATE dynamic_workflow_phases SET ${sets.join(", ")} WHERE id = ?`,
    ).run(...vals);
  });
}

export const getPhasesForRun = getDynamicWorkflowPhases;

export function createWorker(
  worker: Omit<DynamicWorkflowWorkerRecord, "id" | "createdAt" | "updatedAt">,
): DynamicWorkflowWorkerRecord {
  ensureDynamicWorkflowTables();
  const id = crypto.randomUUID();
  const now = nowIso();

  withSqliteWriteRecovery("dynamic-workflows:createWorker", (db) => {
    db.prepare(`
      INSERT INTO dynamic_workflow_workers (
        id, run_id, phase_id, worker_index, role, status, agent_kind,
        agent_id, model_ref, prompt, tool_policy_json,
        result_summary, result_json, error, cached_result_key,
        input_tokens, output_tokens, cost_usd,
        started_at, completed_at, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?
      )
    `).run(
      id,
      worker.runId,
      worker.phaseId,
      worker.workerIndex,
      worker.role,
      worker.status,
      worker.agentKind,
      worker.agentId ?? null,
      worker.modelRef ?? null,
      worker.prompt,
      worker.toolPolicyJson ?? null,
      worker.resultSummary ?? null,
      worker.resultJson ?? null,
      worker.error ?? null,
      worker.cachedResultKey ?? null,
      worker.inputTokens ?? null,
      worker.outputTokens ?? null,
      worker.costUsd ?? null,
      worker.startedAt ?? null,
      worker.completedAt ?? null,
      now,
      now,
    );
  });

  const row = getSqlite()
    .prepare("SELECT * FROM dynamic_workflow_workers WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;
  if (!row) throw new Error("Worker was not saved");
  return mapWorkerRow(row);
}

export function updateWorker(
  id: string,
  updates: Partial<DynamicWorkflowWorkerRecord>,
): void {
  ensureDynamicWorkflowTables();
  const now = nowIso();

  const setEntries: Array<[string, string, unknown]> = [];

  if (updates.status !== undefined) {
    setEntries.push(["status", "status = ?", updates.status]);
  }
  if (updates.agentId !== undefined) {
    setEntries.push(["agent_id", "agent_id = ?", updates.agentId ?? null]);
  }
  if (updates.modelRef !== undefined) {
    setEntries.push(["model_ref", "model_ref = ?", updates.modelRef ?? null]);
  }
  if (updates.toolPolicyJson !== undefined) {
    setEntries.push(["tool_policy_json", "tool_policy_json = ?", updates.toolPolicyJson ?? null]);
  }
  if (updates.resultSummary !== undefined) {
    setEntries.push(["result_summary", "result_summary = ?", updates.resultSummary ?? null]);
  }
  if (updates.resultJson !== undefined) {
    setEntries.push(["result_json", "result_json = ?", updates.resultJson ?? null]);
  }
  if (updates.error !== undefined) {
    setEntries.push(["error", "error = ?", updates.error ?? null]);
  }
  if (updates.cachedResultKey !== undefined) {
    setEntries.push(["cached_result_key", "cached_result_key = ?", updates.cachedResultKey ?? null]);
  }
  if (updates.inputTokens !== undefined) {
    setEntries.push(["input_tokens", "input_tokens = ?", updates.inputTokens ?? null]);
  }
  if (updates.outputTokens !== undefined) {
    setEntries.push(["output_tokens", "output_tokens = ?", updates.outputTokens ?? null]);
  }
  if (updates.costUsd !== undefined) {
    setEntries.push(["cost_usd", "cost_usd = ?", updates.costUsd ?? null]);
  }
  if (updates.startedAt !== undefined) {
    setEntries.push(["started_at", "started_at = ?", updates.startedAt ?? null]);
  }
  if (updates.completedAt !== undefined) {
    setEntries.push(["completed_at", "completed_at = ?", updates.completedAt ?? null]);
  }

  if (setEntries.length === 0) return;

  const clauses = setEntries.map((e) => e[1]);
  const values = setEntries.map((e) => e[2]);

  withSqliteWriteRecovery("dynamic-workflows:updateWorker", (db) => {
    db.prepare(
      `UPDATE dynamic_workflow_workers SET ${clauses.join(", ")}, updated_at = ? WHERE id = ?`,
    ).run(...values, now, id);
  });
}

export function getWorkersForPhase(phaseId: string): DynamicWorkflowWorkerRecord[] {
  ensureDynamicWorkflowTables();
  const rows = getSqlite()
    .prepare(`
      SELECT * FROM dynamic_workflow_workers
      WHERE phase_id = ?
      ORDER BY worker_index ASC
    `)
    .all(phaseId) as Array<Record<string, unknown>>;
  return rows.map(mapWorkerRow);
}

export const getWorkersForRun = getDynamicWorkflowWorkers;

export const createEvent = createDynamicWorkflowEvent;

export function getEventsForRun(
  runId: string,
  limit?: number,
): DynamicWorkflowEventRecord[] {
  ensureDynamicWorkflowTables();
  const effectiveLimit = Math.max(1, Math.min(1000, limit ?? 100));

  const rows = getSqlite()
    .prepare(`
      SELECT * FROM dynamic_workflow_events
      WHERE run_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `)
    .all(runId, effectiveLimit) as Array<Record<string, unknown>>;

  return rows.map(mapEventRow).reverse();
}

export function saveCommand(
  cmd: Omit<DynamicWorkflowCommandRecord, "id" | "createdAt" | "updatedAt">,
): DynamicWorkflowCommandRecord {
  ensureDynamicWorkflowTables();
  const now = nowIso();

  const existing = getSqlite()
    .prepare("SELECT id, created_at FROM dynamic_workflow_commands WHERE name = ?")
    .get(cmd.name) as { id: string; created_at: string } | undefined;

  if (existing) {
    const id = existing.id;
    withSqliteWriteRecovery("dynamic-workflows:saveCommand", (db) => {
      db.prepare(`
        UPDATE dynamic_workflow_commands SET
          description = ?, plan_template_json = ?,
          default_model_ref = ?, default_max_concurrency = ?,
          created_from_run_id = ?, updated_at = ?
        WHERE id = ?
      `).run(
        cmd.description ?? null,
        cmd.planTemplateJson,
        cmd.defaultModelRef ?? null,
        cmd.defaultMaxConcurrency,
        cmd.createdFromRunId ?? null,
        now,
        id,
      );
    });

    const row = getSqlite()
      .prepare("SELECT * FROM dynamic_workflow_commands WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    if (!row) throw new Error("Command was not saved");
    return mapCommandRow(row);
  }

  const id = crypto.randomUUID();
  withSqliteWriteRecovery("dynamic-workflows:saveCommand", (db) => {
    db.prepare(`
      INSERT INTO dynamic_workflow_commands (
        id, name, description, plan_template_json,
        default_model_ref, default_max_concurrency,
        created_from_run_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      cmd.name,
      cmd.description ?? null,
      cmd.planTemplateJson,
      cmd.defaultModelRef ?? null,
      cmd.defaultMaxConcurrency,
      cmd.createdFromRunId ?? null,
      now,
      now,
    );
  });

  const row = getSqlite()
    .prepare("SELECT * FROM dynamic_workflow_commands WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;
  if (!row) throw new Error("Command was not saved");
  return mapCommandRow(row);
}

export const getCommand = getDynamicWorkflowCommand;
export const listCommands = listDynamicWorkflowCommands;
export const deleteCommand = deleteDynamicWorkflowCommand;
export const updateRunSavedCommandName = updateDynamicWorkflowRunSavedCommand;

export function getPopulatedRun(id: string): PopulatedDynamicWorkflowRun | null {
  const run = getDynamicWorkflowRun(id);
  if (!run) return null;

  const phases = getDynamicWorkflowPhases(id);
  const workers = getDynamicWorkflowWorkers(id);

  return { ...run, phases, workers };
}

export function deleteRun(id: string): void {
  ensureDynamicWorkflowTables();

  withSqliteWriteRecovery("dynamic-workflows:deleteRun", (db) => {
    db.prepare("DELETE FROM dynamic_workflow_events WHERE run_id = ?").run(id);
    db.prepare("DELETE FROM dynamic_workflow_workers WHERE run_id = ?").run(id);
    db.prepare("DELETE FROM dynamic_workflow_phases WHERE run_id = ?").run(id);
    db.prepare("DELETE FROM dynamic_workflow_runs WHERE id = ?").run(id);
  });
}
