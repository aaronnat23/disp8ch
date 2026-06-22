import fs from "node:fs";
import { NextRequest, NextResponse } from "next/server";
import { initializeDatabase, getSqlite } from "@/lib/db";
import { listAgents, getDefaultAgent } from "@/lib/agents/registry";
import { listRunningExecutions } from "@/lib/engine/runtime-tracker";
import { listExecutionLaneSnapshots } from "@/lib/engine/execution-lanes";
import { listScheduledCronJobs } from "@/lib/cron/manager";
import { getTelegramStatus } from "@/lib/channels/telegram";
import { getDiscordStatus } from "@/lib/channels/discord";
import { getWhatsAppStatus } from "@/lib/channels/whatsapp";
import { getStoredToken } from "@/lib/google-oauth";
import { listLogFiles, parseLogLine, tailLogFile } from "@/lib/logs/file-logs";
import { getWorkspaceDir, getWorkspaceMemoryDir } from "@/lib/workspace/files";
import { getMachineSpecs } from "@/lib/system/specs";
import { requireAdminAccess } from "@/lib/security/admin";
import { readCappedJson, RequestBodyTooLargeError } from "@/lib/security/body";
import { getRuntimeModelAvailability } from "@/lib/agents/model-availability";

export const dynamic = "force-dynamic";

type HealthCheck = {
  name: string;
  status: "ok" | "warn" | "fail";
  details: string;
};

function readJsonSafe(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function buildHealthSnapshot() {
  const checks: HealthCheck[] = [];

  try {
    initializeDatabase();
    const db = getSqlite();
    checks.push({ name: "database", status: "ok", details: "Database initialized" });

    const modelAvailability = getRuntimeModelAvailability(db);
    checks.push({
      name: "models",
      status: modelAvailability.available ? "ok" : "warn",
      details: modelAvailability.details,
    });

    const workflowCount = (db.prepare("SELECT COUNT(*) as c FROM workflows WHERE is_active = 1").get() as { c: number }).c;
    checks.push({
      name: "workflows",
      status: workflowCount > 0 ? "ok" : "warn",
      details: workflowCount > 0 ? `${workflowCount} active workflow(s)` : "No active workflows",
    });
  } catch (error) {
    checks.push({ name: "database", status: "fail", details: String(error) });
  }

  try {
    const workspacePath = getWorkspaceDir();
    const memoryPath = getWorkspaceMemoryDir();
    checks.push({
      name: "workspace",
      status: fs.existsSync(workspacePath) ? "ok" : "fail",
      details: workspacePath,
    });
    checks.push({
      name: "workspace-memory",
      status: fs.existsSync(memoryPath) ? "ok" : "fail",
      details: memoryPath,
    });
  } catch (error) {
    checks.push({ name: "workspace", status: "fail", details: String(error) });
  }

  try {
    const telegram = getTelegramStatus();
    const discord = getDiscordStatus();
    const whatsapp = getWhatsAppStatus();
    checks.push({
      name: "channels",
      status: "ok",
      details: `telegram=${telegram.connected ? "connected" : "off"}, discord=${discord.connected ? "connected" : "off"}, whatsapp=${whatsapp.connected ? "connected" : "off"}`,
    });
  } catch (error) {
    checks.push({ name: "channels", status: "warn", details: String(error) });
  }

  try {
    const googleOAuth = getStoredToken();
    if (!googleOAuth) {
      checks.push({ name: "google-oauth", status: "warn", details: "Not configured" });
    } else {
      const nowSec = Math.floor(Date.now() / 1000);
      const expired = googleOAuth.expires_at ? googleOAuth.expires_at < nowSec : true;
      checks.push({
        name: "google-oauth",
        status: expired ? "warn" : "ok",
        details: `${googleOAuth.email || "unknown"} (${expired ? "expired" : "valid"})`,
      });
    }
  } catch {
    checks.push({ name: "google-oauth", status: "warn", details: "Unable to check token" });
  }

  return {
    ok: checks.every((check) => check.status !== "fail"),
    checks,
    ts: Date.now(),
  };
}

function listModels() {
  initializeDatabase();
  const db = getSqlite();
  try {
    db.prepare("SELECT base_url FROM models LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE models ADD COLUMN base_url TEXT");
  }
  try {
    db.prepare("SELECT fast_mode FROM models LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE models ADD COLUMN fast_mode INTEGER DEFAULT 0");
  }

  return db
    .prepare(
      "SELECT id, provider, model_id, name, is_active, priority, max_tokens, base_url, fast_mode FROM models ORDER BY priority DESC, created_at DESC",
    )
    .all()
    .map((row) => {
      const typed = row as {
        id: string;
        provider: string;
        model_id: string;
        name: string;
        is_active: number;
        priority: number;
        max_tokens: number | null;
        base_url: string | null;
        fast_mode?: number | null;
      };
      return {
        id: typed.id,
        provider: typed.provider,
        modelId: typed.model_id,
        name: typed.name,
        isActive: typed.is_active === 1,
        priority: typed.priority,
        maxTokens: typed.max_tokens,
        baseUrl: typed.base_url,
        fastMode: typed.fast_mode === 1,
      };
    });
}

function readSafeConfig() {
  initializeDatabase();
  const db = getSqlite();
  const row = db
    .prepare(
      `SELECT timezone, onboarding_done, telemetry_enabled, hooks_enabled, memory_flush_enabled,
              lane_main_max_concurrent, lane_cron_max_concurrent, lane_subflow_max_concurrent
         FROM app_config WHERE id = 'default'`,
    )
    .get() as
    | {
      timezone: string;
      onboarding_done: number;
      telemetry_enabled: number;
      hooks_enabled: number;
      memory_flush_enabled: number;
      lane_main_max_concurrent: number;
      lane_cron_max_concurrent: number;
      lane_subflow_max_concurrent: number;
    }
    | undefined;

  if (!row) return null;
  return {
    timezone: row.timezone,
    onboardingDone: row.onboarding_done === 1,
    telemetryEnabled: row.telemetry_enabled === 1,
    hooksEnabled: row.hooks_enabled === 1,
    memoryFlushEnabled: row.memory_flush_enabled === 1,
    lanes: {
      main: row.lane_main_max_concurrent,
      cron: row.lane_cron_max_concurrent,
      subflow: row.lane_subflow_max_concurrent,
    },
  };
}

function readTailLogs(limit = 120) {
  const files = listLogFiles();
  if (files.length === 0) {
    return {
      file: null as string | null,
      entries: [] as Array<ReturnType<typeof parseLogLine>>,
      truncated: false,
    };
  }
  const tail = tailLogFile({ fileName: files[0], maxBytes: 1024 * 1024 });
  const entries = tail.text
    .split(/\r?\n/)
    .filter(Boolean)
    .map(parseLogLine)
    .slice(-Math.max(20, Math.min(400, Math.floor(limit))));
  return {
    file: tail.absolutePath,
    entries,
    truncated: tail.truncated,
  };
}

function buildSystemPresence() {
  const agents = listAgents();
  const defaultAgent = getDefaultAgent();
  const running = listRunningExecutions();
  const lanes = listExecutionLaneSnapshots();
  const schedulerJobs = listScheduledCronJobs();
  const telegram = getTelegramStatus();
  const discord = getDiscordStatus();
  const whatsapp = getWhatsAppStatus();

  return {
    ok: true,
    ts: Date.now(),
    pid: process.pid,
    uptimeSeconds: Math.floor(process.uptime()),
    defaultAgentId: defaultAgent.id,
    agents: agents.map((agent) => ({
      agentId: agent.id,
      name: agent.name,
      enabled: agent.isActive,
      isDefault: agent.isDefault,
      modelRef: agent.modelRef,
    })),
    channels: {
      telegram: { connected: telegram.connected, username: telegram.username || null },
      discord: { connected: discord.connected, username: discord.username || null },
      whatsapp: { connected: whatsapp.connected, phoneNumber: whatsapp.phoneNumber || null },
    },
    scheduler: {
      jobs: schedulerJobs.length,
      list: schedulerJobs,
    },
    running: {
      active: running.length,
      executions: running,
      lanes,
    },
    machine: getMachineSpecs(),
  };
}

function buildDebugSnapshot() {
  const presence = buildSystemPresence();
  const health = buildHealthSnapshot();
  const models = listModels();
  const config = readSafeConfig();
  const logs = readTailLogs(120);
  const automationRuns = readAutomationRuns();
  const durableTurns = readDurableTurns();
  return {
    status: presence,
    health,
    heartbeat: {
      ts: Date.now(),
      uptimeMs: Math.round(process.uptime() * 1000),
      nodeVersion: process.version,
      env: process.env.NODE_ENV || "development",
    },
    machine: getMachineSpecs(),
    models,
    config,
    automationRuns,
    durableTurns,
    logs,
    eventLog: logs.entries.slice(-40).map((entry) => ({
      event: entry.subsystem || "log",
      ts: entry.time || new Date().toISOString(),
      payload: {
        level: entry.level,
        message: entry.message,
      },
    })),
  };
}

function readAutomationRuns(limit = 12) {
  initializeDatabase();
  const db = getSqlite();
  const rows = db
    .prepare(
      `SELECT e.id, e.workflow_id, e.status, e.trigger_type, e.trigger_data, e.provenance,
              e.started_at, e.completed_at, e.error, w.name AS workflow_name
         FROM executions e
         LEFT JOIN workflows w ON w.id = e.workflow_id
         ORDER BY e.started_at DESC
         LIMIT ?`,
    )
    .all(Math.max(1, Math.min(50, limit))) as Array<{
      id: string;
      workflow_id: string;
      status: string;
      trigger_type: string;
      trigger_data: string | null;
      provenance: string | null;
      started_at: string;
      completed_at: string | null;
      error: string | null;
      workflow_name: string | null;
    }>;
  return rows.map((row) => {
    const triggerData = readJsonSafe(row.trigger_data);
    const provenance = readJsonSafe(row.provenance);
    const createdObjects: Array<{ type: string; id: string; label: string | null }> = [];
    try {
      const tasks = db
        .prepare("SELECT id, title FROM board_tasks WHERE execution_run_id = ? OR workflow_id = ? ORDER BY updated_at DESC LIMIT 5")
        .all(row.id, row.workflow_id) as Array<{ id: string; title: string | null }>;
      for (const task of tasks) createdObjects.push({ type: "board-task", id: task.id, label: task.title });
    } catch {
      // optional board columns may not exist on older DBs
    }
    return {
      id: row.id,
      workflowId: row.workflow_id,
      workflowName: row.workflow_name ?? row.workflow_id,
      status: row.status,
      triggerType: row.trigger_type,
      sessionId: String(triggerData?.sessionId ?? provenance?.sessionId ?? "").trim() || null,
      routeSource: provenance?.routeSource ?? null,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      error: row.error,
      createdObjects,
    };
  });
}

function readDurableTurns(limit = 20) {
  initializeDatabase();
  const db = getSqlite();
  const rows = db
    .prepare(
      `SELECT client_turn_id, session_id, status, message, response, error, attempts,
              worker_id, lease_expires_at, length(COALESCE(stream_content, '')) AS stream_len,
              created_at, updated_at, completed_at
       FROM channel_session_turns
       ORDER BY updated_at DESC
       LIMIT ?`,
    )
    .all(Math.max(1, Math.min(100, limit))) as Array<{
      client_turn_id: string;
      session_id: string;
      status: string;
      message: string;
      response: string | null;
      error: string | null;
      attempts: number;
      worker_id: string | null;
      lease_expires_at: string | null;
      stream_len: number;
      created_at: string;
      updated_at: string;
      completed_at: string | null;
    }>;
  const summaryRows = db
    .prepare("SELECT status, COUNT(*) AS count FROM channel_session_turns GROUP BY status")
    .all() as Array<{ status: string; count: number }>;
  return {
    summary: Object.fromEntries(summaryRows.map((row) => [row.status, row.count])),
    turns: rows.map((row) => ({
      clientTurnId: row.client_turn_id,
      sessionId: row.session_id,
      status: row.status,
      message: row.message,
      responsePreview: row.response ? row.response.slice(0, 180) : null,
      error: row.error,
      attempts: row.attempts,
      workerId: row.worker_id,
      leaseExpiresAt: row.lease_expires_at,
      streamBytes: row.stream_len,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
    })),
  };
}

function recoverStaleDurableTurns() {
  initializeDatabase();
  const db = getSqlite();
  const now = new Date().toISOString();
  const result = db.prepare(
    `UPDATE channel_session_turns
     SET status = 'queued', worker_id = NULL, lease_expires_at = NULL, updated_at = ?
     WHERE status = 'processing'
       AND (lease_expires_at IS NULL OR lease_expires_at < ?)`,
  ).run(now, now);
  return { recovered: result.changes, turns: readDurableTurns(20) };
}

type RpcBody = {
  method?: unknown;
  params?: unknown;
};

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export async function GET(request: NextRequest) {
  try {
    const denied = await requireAdminAccess(request);
    if (denied) return denied;
    return NextResponse.json({
      success: true,
      data: buildDebugSnapshot(),
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const denied = await requireAdminAccess(request);
    if (denied) return denied;
    const body = await readCappedJson<RpcBody>(request, 64 * 1024);
    const method = String(body.method || "").trim();
    const params = asObject(body.params);

    if (!method) {
      return NextResponse.json({ success: false, error: "Missing method" }, { status: 400 });
    }

    switch (method) {
      case "system-presence":
        return NextResponse.json({ success: true, data: buildSystemPresence() });
      case "health":
        return NextResponse.json({ success: true, data: buildHealthSnapshot() });
      case "models.list":
        return NextResponse.json({ success: true, data: listModels() });
      case "agents.list":
        return NextResponse.json({ success: true, data: listAgents() });
      case "scheduler.jobs":
        return NextResponse.json({ success: true, data: listScheduledCronJobs() });
      case "execute.running":
        return NextResponse.json({
          success: true,
          data: {
            running: listRunningExecutions(),
            lanes: listExecutionLaneSnapshots(),
          },
        });
      case "turns.list":
        return NextResponse.json({ success: true, data: readDurableTurns(Number(params.limit ?? 20) || 20) });
      case "turns.recover-stale":
        return NextResponse.json({ success: true, data: recoverStaleDurableTurns() });
      case "config.read":
        return NextResponse.json({ success: true, data: readSafeConfig() });
      case "logs.tail": {
        const limitRaw = Number(params.limit ?? 120);
        const limit = Number.isFinite(limitRaw) ? Math.max(20, Math.min(400, Math.floor(limitRaw))) : 120;
        return NextResponse.json({ success: true, data: readTailLogs(limit) });
      }
      case "debug.snapshots":
        return NextResponse.json({ success: true, data: buildDebugSnapshot() });
      default:
        return NextResponse.json(
          {
            success: false,
            error:
              `Unknown method: ${method}. Available methods: ` +
              "system-presence, health, models.list, agents.list, scheduler.jobs, execute.running, turns.list, turns.recover-stale, config.read, logs.tail, debug.snapshots",
          },
          { status: 400 },
        );
    }
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 413 });
    }
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
