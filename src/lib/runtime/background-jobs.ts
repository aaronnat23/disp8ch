import { execFile, spawn, type ChildProcess } from "node:child_process";
import { nanoid } from "nanoid";
import { getSqlite, initializeDatabase } from "@/lib/db";
import { enqueueWakeup } from "@/lib/governance/wakeup-queue";
import { broadcastEvent } from "@/lib/ws/broadcast";
import { persistChannelEvent, persistChannelMessage } from "@/lib/channels/transcript";
import { scheduleSessionIndex } from "@/lib/memory/session-watcher";
import { createProvenance } from "@/lib/provenance";
import { presentChannelResponse } from "@/lib/channels/presentation";
import { routeToWorkflowWithDetails } from "@/lib/channels/router";
import { logger } from "@/lib/utils/logger";

const log = logger.child("runtime:background-jobs");
const MAX_CAPTURE_CHARS = 64_000;
const DEFAULT_ASYNC_DELEGATION_MAX_CONCURRENT = 3;
const MAX_ASYNC_DELEGATION_MAX_CONCURRENT = 16;

export type BackgroundJobStatus = "running" | "completed" | "failed";

export type BackgroundJobRecord = {
  id: string;
  toolName: string;
  commandPreview: string;
  cwd: string | null;
  sessionId: string | null;
  agentId: string | null;
  notifyOnComplete: boolean;
  status: BackgroundJobStatus;
  pid: number | null;
  startedAt: string;
  completedAt: string | null;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  metadata: Record<string, unknown> | null;
};

type SpawnBackgroundJobParams = {
  toolName: "bash_exec" | "run_python" | "sessions_spawn";
  commandPreview: string;
  spawnCommand: string;
  spawnArgs: string[];
  cwd?: string | null;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number | null;
  sessionId?: string | null;
  agentId?: string | null;
  notifyOnComplete?: boolean;
  metadata?: Record<string, unknown> | null;
};

export type SpawnManagedBackgroundJobParams = {
  toolName: "sessions_spawn";
  commandPreview: string;
  run: () => Promise<string>;
  cwd?: string | null;
  timeoutMs?: number | null;
  sessionId?: string | null;
  agentId?: string | null;
  notifyOnComplete?: boolean;
  metadata?: Record<string, unknown> | null;
};

type RunningProcessJobState = {
  kind: "process";
  child: ChildProcess;
  stdout: string;
  stderr: string;
  timeoutTimer: ReturnType<typeof setTimeout> | null;
  timedOut: boolean;
};

type RunningManagedJobState = {
  kind: "managed";
  stdout: string;
  stderr: string;
  timeoutTimer: ReturnType<typeof setTimeout> | null;
  timedOut: boolean;
};

type RunningJobState = RunningProcessJobState | RunningManagedJobState;

function metadataString(metadata: Record<string, unknown> | null, key: string): string {
  const value = metadata?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function isDelegationJob(job: BackgroundJobRecord): boolean {
  const kind = metadataString(job.metadata, "kind");
  return kind === "coding-agent-delegation" || kind === "model-delegation";
}

function isCodingAgentJob(job: BackgroundJobRecord): boolean {
  return metadataString(job.metadata, "kind") === "coding-agent-delegation";
}

function clampAsyncDelegationLimit(value: unknown): number | null {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.max(1, Math.min(MAX_ASYNC_DELEGATION_MAX_CONCURRENT, Math.floor(numeric)));
}

export function getAsyncDelegationMaxConcurrent(): number {
  const envLimit = clampAsyncDelegationLimit(
    process.env.DISP8CH_MAX_ASYNC_DELEGATIONS ?? process.env.DISP8CH_MAX_ASYNC_DELEGATION_CHILDREN,
  );
  if (envLimit) return envLimit;

  try {
    initializeDatabase();
    const row = getSqlite()
      .prepare("SELECT async_delegation_max_concurrent FROM app_config WHERE id = 'default'")
      .get() as { async_delegation_max_concurrent?: unknown } | undefined;
    return clampAsyncDelegationLimit(row?.async_delegation_max_concurrent) ?? DEFAULT_ASYNC_DELEGATION_MAX_CONCURRENT;
  } catch {
    return DEFAULT_ASYNC_DELEGATION_MAX_CONCURRENT;
  }
}

function countRunningAsyncDelegations(): number {
  return Number(
    (
      getSqlite()
        .prepare("SELECT COUNT(*) AS count FROM background_jobs WHERE status = 'running' AND tool_name = 'sessions_spawn'")
        .get() as { count?: number } | undefined
    )?.count ?? 0,
  );
}

export function getAsyncDelegationCapacitySnapshot(): { running: number; maxConcurrent: number } {
  initializeDatabase();
  reconcileRecoveredBackgroundJobs();
  return {
    running: countRunningAsyncDelegations(),
    maxConcurrent: getAsyncDelegationMaxConcurrent(),
  };
}

function assertAsyncDelegationCapacity(
  params: Pick<SpawnBackgroundJobParams, "toolName" | "metadata">,
): { running: number; maxConcurrent: number } | null {
  if (params.toolName !== "sessions_spawn") return null;
  const kind = metadataString(params.metadata ?? null, "kind");
  if (kind !== "coding-agent-delegation" && kind !== "model-delegation") return null;

  const maxConcurrent = getAsyncDelegationMaxConcurrent();
  const running = countRunningAsyncDelegations();
  if (running >= maxConcurrent) {
    throw new Error(
      `Async delegation limit reached (${running}/${maxConcurrent} running). ` +
      "Wait for a background subagent to finish, run the task synchronously, " +
      "or raise Settings > Config > Async Subagent Concurrency / DISP8CH_MAX_ASYNC_DELEGATIONS.",
    );
  }
  return { running, maxConcurrent };
}

function extractCodingAgentOutput(stdout: string): { result: string; sessionId: string | null; isError: boolean | null } {
  const trimmed = stdout.trim();
  if (!trimmed) return { result: "", sessionId: null, isError: null };
  try {
    const parsed = JSON.parse(trimmed) as { result?: unknown; session_id?: unknown; is_error?: unknown };
    return {
      result: typeof parsed.result === "string" ? parsed.result : trimmed,
      sessionId: typeof parsed.session_id === "string" ? parsed.session_id : null,
      isError: typeof parsed.is_error === "boolean" ? parsed.is_error : null,
    };
  } catch {
    return { result: trimmed, sessionId: null, isError: null };
  }
}

function buildCompletionBody(job: BackgroundJobRecord): string {
  if (!isDelegationJob(job)) {
    return [
      `Background process ${job.id} completed.`,
      `Tool: ${job.toolName}`,
      `Command: ${job.commandPreview}`,
      `Exit code: ${job.exitCode ?? "unknown"}`,
      job.stdout.trim() ? `Output:\n${clipCapture(job.stdout.trim())}` : "",
      job.stderr.trim() ? `Stderr:\n${clipCapture(job.stderr.trim())}` : "",
    ].filter(Boolean).join("\n\n");
  }

  const output = extractCodingAgentOutput(job.stdout);
  const status = job.exitCode === 0 && output.isError !== true ? "completed" : "failed";
  const started = job.startedAt;
  const completed = job.completedAt ?? new Date().toISOString();
  return [
    "[ASYNC DELEGATION COMPLETE]",
    `Delegation ID: ${job.id}`,
    `Status: ${status}`,
    `Agent: ${metadataString(job.metadata, "codingAgent") || metadataString(job.metadata, "provider") || "unknown"}`,
    `Mode: ${metadataString(job.metadata, "mode") || "run"}`,
    `Permission mode: ${metadataString(job.metadata, "permissionMode") || "unknown"}`,
    `Model: ${metadataString(job.metadata, "model") || "default"}`,
    `Working directory: ${job.cwd || metadataString(job.metadata, "cwd") || "unknown"}`,
    `Dispatched: ${started}`,
    `Completed: ${completed}`,
    "",
    "Original goal:",
    metadataString(job.metadata, "goal") || job.commandPreview,
    metadataString(job.metadata, "context")
      ? `\nContext provided:\n${metadataString(job.metadata, "context")}`
      : "",
    output.sessionId ? `\nExternal session ID: ${output.sessionId}` : "",
    output.result ? `\nResult:\n${clipCapture(output.result)}` : "",
    job.stderr.trim() ? `\nStderr:\n${clipCapture(job.stderr.trim())}` : "",
  ].filter(Boolean).join("\n");
}

function buildDelegationAssistantFollowup(job: BackgroundJobRecord): string {
  const output = extractCodingAgentOutput(job.stdout);
  const status = job.exitCode === 0 && output.isError !== true ? "completed" : "failed";
  const lines = [
    status === "completed" ? "Async delegation completed." : "Async delegation failed.",
    `- Delegation ID: ${job.id}`,
    `- Agent: ${metadataString(job.metadata, "codingAgent") || metadataString(job.metadata, "provider") || "unknown"}`,
    `- Status: ${status}`,
    output.result ? `\nResult:\n${clipCapture(output.result)}` : "",
  ];
  if (status !== "completed" && job.stderr.trim()) {
    lines.push(`\nStderr:\n${clipCapture(job.stderr.trim())}`);
  }
  return lines.filter(Boolean).join("\n");
}

type JobsGlobal = typeof globalThis & {
  __disp8chBackgroundJobs?: Map<string, RunningJobState>;
};

const jobsGlobal = globalThis as JobsGlobal;
if (!jobsGlobal.__disp8chBackgroundJobs) {
  jobsGlobal.__disp8chBackgroundJobs = new Map();
}
const runningJobs = jobsGlobal.__disp8chBackgroundJobs;

function clipCapture(value: string): string {
  if (value.length <= MAX_CAPTURE_CHARS) return value;
  return value.slice(value.length - MAX_CAPTURE_CHARS);
}

function mapBackgroundJobRow(row: Record<string, unknown>): BackgroundJobRecord {
  return {
    id: String(row.id),
    toolName: String(row.tool_name),
    commandPreview: String(row.command_preview),
    cwd: row.cwd ? String(row.cwd) : null,
    sessionId: row.session_id ? String(row.session_id) : null,
    agentId: row.agent_id ? String(row.agent_id) : null,
    notifyOnComplete: Number(row.notify_on_complete) === 1,
    status: String(row.status) as BackgroundJobStatus,
    pid: row.pid === null || row.pid === undefined
      ? null
      : Number.isFinite(Number(row.pid)) ? Number(row.pid) : null,
    startedAt: String(row.started_at),
    completedAt: row.completed_at ? String(row.completed_at) : null,
    exitCode: row.exit_code === null || row.exit_code === undefined ? null : Number(row.exit_code),
    stdout: String(row.stdout || ""),
    stderr: String(row.stderr || ""),
    metadata: row.metadata ? JSON.parse(String(row.metadata)) as Record<string, unknown> : null,
  };
}

function updateJobOutput(id: string, stdout: string, stderr: string): void {
  const db = getSqlite();
  db.prepare("UPDATE background_jobs SET stdout = ?, stderr = ? WHERE id = ?").run(stdout, stderr, id);
}

function terminateChildProcess(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  const pid = child.pid;
  if (!pid) {
    child.kill(signal);
    return;
  }
  if (process.platform === "win32") {
    execFile("taskkill", ["/pid", String(pid), "/t", "/f"], () => {
      try {
        child.kill(signal);
      } catch {
        // The process may already be gone.
      }
    });
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    child.kill(signal);
  }
}

async function triggerCompletionFollowup(job: BackgroundJobRecord): Promise<void> {
  if (!job.sessionId || !job.notifyOnComplete) return;

  const completionBody = buildCompletionBody(job);

  const createdAt = new Date().toISOString();
  const provenance = createProvenance("channel", "channel:webchat:background-job", {
    channel: "webchat",
    sessionId: job.sessionId,
    sender: "system",
    agentId: job.agentId ?? undefined,
    routeSource: "background-job",
    backgroundJobId: job.id,
  });

  persistChannelEvent({
    sessionId: job.sessionId,
    content: completionBody,
    metadata: {
      eventType: "background-process-complete",
      backgroundJobId: job.id,
      toolName: job.toolName,
      exitCode: job.exitCode,
      delegationKind: isCodingAgentJob(job) ? "coding-agent" : isDelegationJob(job) ? "provider-agent" : undefined,
    },
    provenance,
    agentId: job.agentId,
    createdAt,
  });
  scheduleSessionIndex(job.sessionId, job.agentId || undefined);
  broadcastEvent("webchat:message", {
    sessionId: job.sessionId,
    role: "system",
    content: completionBody,
    metadata: {
      eventType: "background-process-complete",
      backgroundJobId: job.id,
      exitCode: job.exitCode,
      delegationKind: isCodingAgentJob(job) ? "coding-agent" : isDelegationJob(job) ? "provider-agent" : undefined,
    },
    createdAt,
  });

  if (!job.agentId) return;

  if (isDelegationJob(job)) {
    const response = buildDelegationAssistantFollowup(job);
    const metadata: Record<string, unknown> = {
      routeSource: "background-job",
      backgroundJobId: job.id,
      delegationKind: isCodingAgentJob(job) ? "coding-agent" : "provider-agent",
    };
    persistChannelMessage({
      sessionId: job.sessionId,
      role: "assistant",
      content: response,
      metadata,
      provenance: {
        ...provenance,
        routeSource: "background-job",
      },
      agentId: job.agentId,
      createdAt: new Date().toISOString(),
    });
    scheduleSessionIndex(job.sessionId, job.agentId);
    broadcastEvent("webchat:message", {
      sessionId: job.sessionId,
      role: "assistant",
      content: response,
      metadata,
      createdAt: new Date().toISOString(),
    });
    return;
  }

  const syntheticMessage = [
    `[SYSTEM: Background process ${job.id} completed (exit code ${job.exitCode ?? "unknown"}).]`,
    completionBody,
  ].filter(Boolean).join("\n");

  const routed = await routeToWorkflowWithDetails({
    triggerNodeType: "message-trigger",
    channel: "webchat",
    agentId: job.agentId,
    provenance,
    internalBaseUrl: `http://127.0.0.1:${process.env.PORT ?? 3100}`,
    triggerData: {
      message: syntheticMessage,
      sender: "system",
      channel: "webchat",
      sessionId: job.sessionId,
      timestamp: createdAt,
    },
  });

  const response = presentChannelResponse(
    "webchat",
    routed.response ?? "Background process completed.",
  );
  const metadata: Record<string, unknown> = {
    routeSource: routed.source,
    backgroundJobId: job.id,
  };
  if (routed.workflowId) metadata.workflowId = routed.workflowId;
  if (routed.workflowName) metadata.workflowName = routed.workflowName;

  persistChannelMessage({
    sessionId: job.sessionId,
    role: "assistant",
    content: response,
    metadata,
    provenance: {
      ...provenance,
      workflowId: routed.workflowId ?? undefined,
      workflowName: routed.workflowName ?? undefined,
      routeSource: routed.source,
    },
    agentId: job.agentId,
    createdAt: new Date().toISOString(),
  });
  scheduleSessionIndex(job.sessionId, job.agentId);
  broadcastEvent("webchat:message", {
    sessionId: job.sessionId,
    role: "assistant",
    content: response,
    metadata,
    createdAt: new Date().toISOString(),
  });
}

function reconcileRecoveredBackgroundJobs(): void {
  initializeDatabase();

  const db = getSqlite();
  const rows = db.prepare(
    "SELECT * FROM background_jobs WHERE status = 'running' ORDER BY started_at ASC",
  ).all() as Array<Record<string, unknown>>;

  for (const row of rows) {
    const job = mapBackgroundJobRow(row);
    if (runningJobs.has(job.id)) continue;

    const recoveredStderr = clipCapture(
      [job.stderr.trim(), "Background job was interrupted before completion because the app restarted or the worker exited."]
        .filter(Boolean)
        .join("\n"),
    );
    const completedAt = new Date().toISOString();
    db.prepare(
      `UPDATE background_jobs
       SET status = 'failed', completed_at = ?, exit_code = NULL, stderr = ?
       WHERE id = ? AND status = 'running'`,
    ).run(completedAt, recoveredStderr, job.id);

    const recoveredJob = getBackgroundJob(job.id);
    if (!recoveredJob) continue;
    broadcastEvent("background:job", { event: "completed", job: recoveredJob });
    if (!recoveredJob.notifyOnComplete) continue;
    void triggerCompletionFollowup(recoveredJob).catch((error) => {
      log.warn("Recovered background job follow-up failed", { id: recoveredJob.id, error: String(error) });
    });
  }
}

async function finalizeJob(id: string, exitCode: number | null): Promise<void> {
  initializeDatabase();
  const state = runningJobs.get(id);
  if (!state) return;
  runningJobs.delete(id);
  if (state.timeoutTimer) {
    clearTimeout(state.timeoutTimer);
  }

  const stdout = clipCapture(state.stdout);
  const stderr = clipCapture(state.stderr);
  const completedAt = new Date().toISOString();
  const status: BackgroundJobStatus = exitCode === 0 ? "completed" : "failed";
  const db = getSqlite();
  db.prepare(
    `UPDATE background_jobs
     SET status = ?, completed_at = ?, exit_code = ?, stdout = ?, stderr = ?
     WHERE id = ?`,
  ).run(status, completedAt, exitCode, stdout, stderr, id);
  const job = getBackgroundJob(id);
  if (!job) return;

  await cleanupBackgroundJobArtifacts(job);

  broadcastEvent("background:job", { event: "completed", job });
  if (job.agentId && job.notifyOnComplete) {
    enqueueWakeup({
      agentId: job.agentId,
      source: "background-job",
      triggerDetail: job.commandPreview,
      idempotencyKey: `background-job:${job.id}`,
      payload: {
        backgroundJobId: job.id,
        toolName: job.toolName,
        sessionId: job.sessionId,
        exitCode: job.exitCode,
      },
    });
  }

  try {
    await triggerCompletionFollowup(job);
  } catch (error) {
    log.warn("Background job follow-up failed", { id, error: String(error) });
  }
}

async function cleanupBackgroundJobArtifacts(job: BackgroundJobRecord): Promise<void> {
  if (!isCodingAgentJob(job)) return;
  const worktreePath = metadataString(job.metadata, "worktreePath");
  const cleanup = metadataString(job.metadata, "cleanup");
  const parentCwd = metadataString(job.metadata, "parentCwd") || job.cwd || undefined;
  if (!worktreePath || cleanup !== "delete") return;
  await new Promise<void>((resolve) => {
    execFile("git", ["worktree", "remove", "--force", worktreePath], { cwd: parentCwd }, (error) => {
      if (error) {
        log.warn("Background coding-agent worktree cleanup failed", { id: job.id, worktreePath, error: String(error) });
      }
      resolve();
    });
  });
}

export function spawnBackgroundJob(params: SpawnBackgroundJobParams): BackgroundJobRecord {
  initializeDatabase();
  reconcileRecoveredBackgroundJobs();
  const asyncCapacity = assertAsyncDelegationCapacity(params);
  const db = getSqlite();
  const id = `bg_${nanoid(10)}`;
  const startedAt = new Date().toISOString();
  const metadata = asyncCapacity
    ? {
        ...(params.metadata ?? {}),
        asyncDelegationRunningAtDispatch: asyncCapacity.running,
        asyncDelegationMaxConcurrent: asyncCapacity.maxConcurrent,
      }
    : params.metadata;
  const child = spawn(params.spawnCommand, params.spawnArgs, {
    cwd: params.cwd ?? undefined,
    env: params.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  const pid = Number.isFinite(child.pid) ? child.pid ?? null : null;

  db.prepare(
    `INSERT INTO background_jobs (
      id, tool_name, command_preview, cwd, session_id, agent_id, notify_on_complete,
      status, pid, started_at, stdout, stderr, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, '', '', ?)`,
  ).run(
    id,
    params.toolName,
    params.commandPreview,
    params.cwd ?? null,
    params.sessionId ?? null,
    params.agentId ?? null,
    params.notifyOnComplete ? 1 : 0,
    pid,
    startedAt,
    metadata ? JSON.stringify(metadata) : null,
  );

  const timeoutMs = Number(params.timeoutMs);
  const state: RunningProcessJobState = {
    kind: "process",
    child,
    stdout: "",
    stderr: "",
    timeoutTimer: null,
    timedOut: false,
  };
  runningJobs.set(id, state);

  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    state.timeoutTimer = setTimeout(() => {
      const current = runningJobs.get(id);
      if (!current) return;
      current.timedOut = true;
      current.stderr = clipCapture(
        [current.stderr.trim(), `Background job timed out after ${Math.round(timeoutMs / 1000)}s.`]
          .filter(Boolean)
          .join("\n"),
      );
      updateJobOutput(id, current.stdout, current.stderr);
      if (current.kind === "process") {
        try {
          terminateChildProcess(current.child, "SIGTERM");
        } catch (error) {
          log.warn("Failed to terminate timed-out background job", { id, error: String(error) });
        }
      }
    }, timeoutMs);
    state.timeoutTimer.unref?.();
  }

  child.stdout?.on("data", (chunk: Buffer | string) => {
    state.stdout = clipCapture(state.stdout + String(chunk));
    updateJobOutput(id, state.stdout, state.stderr);
  });
  child.stderr?.on("data", (chunk: Buffer | string) => {
    state.stderr = clipCapture(state.stderr + String(chunk));
    updateJobOutput(id, state.stdout, state.stderr);
  });
  child.on("close", (code) => {
    void finalizeJob(id, code === null ? null : Number(code));
  });
  child.on("error", (error) => {
    state.stderr = clipCapture(`${state.stderr}\n${String(error)}`.trim());
    updateJobOutput(id, state.stdout, state.stderr);
    void finalizeJob(id, 1);
  });

  const job = getBackgroundJob(id);
  if (!job) {
    throw new Error(`Failed to load background job ${id}`);
  }
  broadcastEvent("background:job", { event: "started", job });
  return job;
}

export function listBackgroundJobs(options?: {
  sessionId?: string | null;
  agentId?: string | null;
  limit?: number;
  status?: BackgroundJobStatus | null;
}): BackgroundJobRecord[] {
  initializeDatabase();
  reconcileRecoveredBackgroundJobs();
  const db = getSqlite();
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (options?.sessionId) {
    conditions.push("session_id = ?");
    values.push(options.sessionId);
  }
  if (options?.agentId) {
    conditions.push("agent_id = ?");
    values.push(options.agentId);
  }
  if (options?.status) {
    conditions.push("status = ?");
    values.push(options.status);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = Math.max(1, Math.min(200, Number(options?.limit) || 50));
  const rows = db.prepare(
    `SELECT * FROM background_jobs ${where} ORDER BY started_at DESC LIMIT ?`,
  ).all(...values, limit) as Array<Record<string, unknown>>;
  return rows.map(mapBackgroundJobRow);
}

export function getBackgroundJob(id: string): BackgroundJobRecord | null {
  initializeDatabase();
  reconcileRecoveredBackgroundJobs();
  const row = getSqlite()
    .prepare("SELECT * FROM background_jobs WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;
  return row ? mapBackgroundJobRow(row) : null;
}

export function terminateBackgroundJob(id: string): BackgroundJobRecord | null {
  initializeDatabase();
  reconcileRecoveredBackgroundJobs();
  const state = runningJobs.get(id);
  if (!state) return getBackgroundJob(id);
  state.stderr = clipCapture(
    [state.stderr.trim(), "Background job was terminated by the operator."]
      .filter(Boolean)
      .join("\n"),
  );
  updateJobOutput(id, state.stdout, state.stderr);
  if (state.kind === "process") {
    try {
      terminateChildProcess(state.child, "SIGTERM");
    } catch (error) {
      log.warn("Failed to terminate background job", { id, error: String(error) });
    }
  } else {
    void finalizeJob(id, 1);
  }
  return getBackgroundJob(id);
}

export function spawnManagedBackgroundJob(params: SpawnManagedBackgroundJobParams): BackgroundJobRecord {
  initializeDatabase();
  reconcileRecoveredBackgroundJobs();
  const asyncCapacity = assertAsyncDelegationCapacity(params);
  const db = getSqlite();
  const id = `bg_${nanoid(10)}`;
  const startedAt = new Date().toISOString();
  const metadata = asyncCapacity
    ? {
        ...(params.metadata ?? {}),
        asyncDelegationRunningAtDispatch: asyncCapacity.running,
        asyncDelegationMaxConcurrent: asyncCapacity.maxConcurrent,
      }
    : params.metadata;

  db.prepare(
    `INSERT INTO background_jobs (
      id, tool_name, command_preview, cwd, session_id, agent_id, notify_on_complete,
      status, pid, started_at, stdout, stderr, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', NULL, ?, '', '', ?)`,
  ).run(
    id,
    params.toolName,
    params.commandPreview,
    params.cwd ?? null,
    params.sessionId ?? null,
    params.agentId ?? null,
    params.notifyOnComplete ? 1 : 0,
    startedAt,
    metadata ? JSON.stringify(metadata) : null,
  );

  const state: RunningManagedJobState = {
    kind: "managed",
    stdout: "",
    stderr: "",
    timeoutTimer: null,
    timedOut: false,
  };
  runningJobs.set(id, state);

  const timeoutMs = Number(params.timeoutMs);
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    state.timeoutTimer = setTimeout(() => {
      if (runningJobs.get(id) !== state) return;
      state.timedOut = true;
      state.stderr = `Background job timed out after ${Math.round(timeoutMs / 1000)}s.`;
      updateJobOutput(id, state.stdout, state.stderr);
      void finalizeJob(id, 1);
    }, timeoutMs);
    state.timeoutTimer.unref?.();
  }

  void params.run()
    .then((output) => {
      if (runningJobs.get(id) !== state) return;
      state.stdout = clipCapture(String(output || ""));
      updateJobOutput(id, state.stdout, state.stderr);
      void finalizeJob(id, 0);
    })
    .catch((error) => {
      if (runningJobs.get(id) !== state) return;
      state.stderr = clipCapture(error instanceof Error ? error.message : String(error));
      updateJobOutput(id, state.stdout, state.stderr);
      void finalizeJob(id, 1);
    });

  const job = getBackgroundJob(id);
  if (!job) throw new Error(`Failed to load background job ${id}`);
  broadcastEvent("background:job", { event: "started", job });
  return job;
}
