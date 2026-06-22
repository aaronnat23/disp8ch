import path from "node:path";
import { nanoid } from "nanoid";
import { getSqlite, initializeDatabase } from "@/lib/db";
import { unscheduleAgentHeartbeat } from "@/lib/governance/heartbeat";
import { ensureWorkspaceScaffold, getWorkspaceDir, normalizeWorkspacePath } from "@/lib/workspace/files";

export interface AgentRecord {
  id: string;
  name: string;
  workspacePath: string;
  modelRef: string | null;
  /** Per-agent API key — overrides the model record's api_key when set */
  modelApiKey: string | null;
  /** Per-agent base URL — overrides the model record's base_url when set */
  modelBaseUrl: string | null;
  /** Per-agent default system prompt — used when a node's systemPrompt is blank */
  systemPrompt: string | null;
  /** Per-agent temperature (0–1) */
  temperature: number | null;
  /** Per-agent max tokens default */
  maxTokens: number | null;
  disabledTools: string[];
  enabledToolsets: string[];
  enabledExtensions: string[];
  enabledSkills: string[];
  execAllowlist: string[];
  heartbeatCron: string | null;
  spendCapUsd: number | null;
  spendWindowDays: number;
  budgetAction: "warn" | "block";
  budgetMonthlyCents: number | null;
  spentMonthlyCents: number;
  budgetResetAt: string | null;
  isDefault: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

interface AgentRow {
  id: string;
  name: string;
  workspace_path: string;
  model_ref: string | null;
  model_api_key: string | null;
  model_base_url: string | null;
  system_prompt: string | null;
  temperature: number | null;
  max_tokens: number | null;
  disabled_tools: string | null;
  enabled_toolsets: string | null;
  enabled_extensions: string | null;
  enabled_skills: string | null;
  exec_allowlist: string | null;
  heartbeat_cron: string | null;
  spend_cap_usd: number | null;
  spend_window_days: number | null;
  budget_action: string | null;
  budget_monthly_cents: number | null;
  spent_monthly_cents: number | null;
  budget_reset_at: string | null;
  is_default: number;
  is_active: number;
  created_at: string;
  updated_at: string;
}

interface CreateAgentInput {
  id?: string;
  name: string;
  workspacePath?: string;
  modelRef?: string | null;
  modelApiKey?: string | null;
  modelBaseUrl?: string | null;
  systemPrompt?: string | null;
  temperature?: number | null;
  maxTokens?: number | null;
  disabledTools?: string[];
  enabledToolsets?: string[];
  enabledExtensions?: string[];
  enabledSkills?: string[];
  execAllowlist?: string[];
  heartbeatCron?: string | null;
  spendCapUsd?: number | null;
  spendWindowDays?: number;
  budgetAction?: "warn" | "block";
  budgetMonthlyCents?: number | null;
  spentMonthlyCents?: number;
  budgetResetAt?: string | null;
  isDefault?: boolean;
}

interface UpdateAgentInput {
  name?: string;
  workspacePath?: string;
  modelRef?: string | null;
  modelApiKey?: string | null;
  modelBaseUrl?: string | null;
  systemPrompt?: string | null;
  temperature?: number | null;
  maxTokens?: number | null;
  disabledTools?: string[];
  enabledToolsets?: string[];
  enabledExtensions?: string[];
  enabledSkills?: string[];
  execAllowlist?: string[];
  heartbeatCron?: string | null;
  spendCapUsd?: number | null;
  spendWindowDays?: number;
  budgetAction?: "warn" | "block";
  budgetMonthlyCents?: number | null;
  spentMonthlyCents?: number;
  budgetResetAt?: string | null;
  isDefault?: boolean;
  isActive?: boolean;
}

export const DEFAULT_AGENT_ID = "main";

function syncHierarchySnapshotSoon(): void {
  void import("@/lib/hierarchy/organizations")
    .then((module) => module.syncActiveHierarchyOrganizationSnapshot())
    .catch(() => {
      // Ignore snapshot sync failures so agent CRUD stays available.
    });
}

function normalizeAgentId(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || `agent-${nanoid(6).toLowerCase()}`;
}

function parseStringArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const item of parsed) {
      const name = String(item || "").trim();
      if (!name) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
    return out;
  } catch {
    return [];
  }
}

function normalizeSpendCap(value: unknown): number | null {
  if (value === null || typeof value === "undefined" || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Number(parsed.toFixed(6));
}

function normalizeSpendWindowDays(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 30;
  return Math.min(365, Math.max(1, Math.round(parsed)));
}

function normalizeBudgetAction(value: unknown): "warn" | "block" {
  return value === "block" ? "block" : "warn";
}

function rowToAgent(row: AgentRow): AgentRecord {
  const storedWorkspacePath = row.workspace_path.replace(/\\/g, "/");
  const normalizedPath =
    row.id === DEFAULT_AGENT_ID && storedWorkspacePath === `agents/${DEFAULT_AGENT_ID}`
      ? defaultWorkspaceForAgent(row.id)
      : normalizeWorkspacePath(row.workspace_path, row.id);
  if (normalizedPath !== row.workspace_path) {
    try {
      getSqlite().prepare("UPDATE agents SET workspace_path = ? WHERE id = ?").run(normalizedPath, row.id);
    } catch {
      // best-effort repair; don't block reading
    }
  }
  return {
    id: row.id,
    name: row.name,
    workspacePath: normalizedPath,
    modelRef: row.model_ref ?? null,
    modelApiKey: row.model_api_key ?? null,
    modelBaseUrl: row.model_base_url ?? null,
    systemPrompt: row.system_prompt ?? null,
    temperature: row.temperature != null ? Number(row.temperature) : null,
    maxTokens: row.max_tokens != null ? Number(row.max_tokens) : null,
    disabledTools: parseStringArray(row.disabled_tools),
    enabledToolsets: parseStringArray(row.enabled_toolsets),
    enabledExtensions: parseStringArray(row.enabled_extensions),
    enabledSkills: parseStringArray(row.enabled_skills),
    execAllowlist: parseStringArray(row.exec_allowlist),
    heartbeatCron: row.heartbeat_cron ?? null,
    spendCapUsd: normalizeSpendCap(row.spend_cap_usd),
    spendWindowDays: normalizeSpendWindowDays(row.spend_window_days),
    budgetAction: normalizeBudgetAction(row.budget_action),
    budgetMonthlyCents: row.budget_monthly_cents ?? null,
    spentMonthlyCents: row.spent_monthly_cents ?? 0,
    budgetResetAt: row.budget_reset_at ?? null,
    isDefault: row.is_default === 1,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function defaultWorkspaceForAgent(agentId: string): string {
  if (agentId === DEFAULT_AGENT_ID) return "data/workspace";
  return path.join("agents", agentId);
}

export function ensureAgentsTable() {
  initializeDatabase();
  const db = getSqlite();
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      model_ref TEXT,
      disabled_tools TEXT NOT NULL DEFAULT '[]',
      enabled_toolsets TEXT NOT NULL DEFAULT '[]',
      enabled_extensions TEXT NOT NULL DEFAULT '[]',
      enabled_skills TEXT NOT NULL DEFAULT '[]',
      spend_cap_usd REAL,
      spend_window_days INTEGER NOT NULL DEFAULT 30,
      budget_action TEXT NOT NULL DEFAULT 'warn',
      is_default INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  try {
    db.exec("ALTER TABLE agents ADD COLUMN enabled_toolsets TEXT NOT NULL DEFAULT '[]'");
  } catch (error) {
    if (!String(error).includes("duplicate column name")) throw error;
  }
  try {
    db.exec("ALTER TABLE agents ADD COLUMN enabled_extensions TEXT NOT NULL DEFAULT '[]'");
  } catch (error) {
    if (!String(error).includes("duplicate column name")) throw error;
  }
  try {
    db.exec("ALTER TABLE agents ADD COLUMN enabled_skills TEXT NOT NULL DEFAULT '[]'");
  } catch (error) {
    if (!String(error).includes("duplicate column name")) throw error;
  }
  try {
    db.exec("ALTER TABLE agents ADD COLUMN spend_cap_usd REAL");
  } catch (error) {
    if (!String(error).includes("duplicate column name")) throw error;
  }
  try {
    db.exec("ALTER TABLE agents ADD COLUMN spend_window_days INTEGER NOT NULL DEFAULT 30");
  } catch (error) {
    if (!String(error).includes("duplicate column name")) throw error;
  }
  try {
    db.exec("ALTER TABLE agents ADD COLUMN budget_action TEXT NOT NULL DEFAULT 'warn'");
  } catch (error) {
    if (!String(error).includes("duplicate column name")) throw error;
  }
  try {
    db.exec("ALTER TABLE agents ADD COLUMN exec_allowlist TEXT NOT NULL DEFAULT '[]'");
  } catch (error) {
    if (!String(error).includes("duplicate column name")) throw error;
  }
  try {
    db.exec("ALTER TABLE agents ADD COLUMN model_api_key TEXT");
  } catch (error) {
    if (!String(error).includes("duplicate column name")) throw error;
  }
  try {
    db.exec("ALTER TABLE agents ADD COLUMN model_base_url TEXT");
  } catch (error) {
    if (!String(error).includes("duplicate column name")) throw error;
  }
  try {
    db.exec("ALTER TABLE agents ADD COLUMN system_prompt TEXT");
  } catch (error) {
    if (!String(error).includes("duplicate column name")) throw error;
  }
  try {
    db.exec("ALTER TABLE agents ADD COLUMN temperature REAL");
  } catch (error) {
    if (!String(error).includes("duplicate column name")) throw error;
  }
  try {
    db.exec("ALTER TABLE agents ADD COLUMN max_tokens INTEGER");
  } catch (error) {
    if (!String(error).includes("duplicate column name")) throw error;
  }
  try {
    db.exec("ALTER TABLE agents ADD COLUMN budget_monthly_cents INTEGER DEFAULT NULL");
  } catch (error) {
    if (!String(error).includes("duplicate column name")) throw error;
  }
  try {
    db.exec("ALTER TABLE agents ADD COLUMN spent_monthly_cents INTEGER DEFAULT 0");
  } catch (error) {
    if (!String(error).includes("duplicate column name")) throw error;
  }
  try {
    db.exec("ALTER TABLE agents ADD COLUMN budget_reset_at TEXT");
  } catch (error) {
    if (!String(error).includes("duplicate column name")) throw error;
  }
  return db;
}

function ensureDefaultAgent() {
  const db = ensureAgentsTable();
  const now = new Date().toISOString();
  const rows = db.prepare("SELECT * FROM agents ORDER BY created_at ASC").all() as AgentRow[];

  if (rows.length === 0) {
    const workspacePath = defaultWorkspaceForAgent(DEFAULT_AGENT_ID);
    ensureWorkspaceScaffold({ workspacePath });
    db.prepare(`
      INSERT INTO agents
        (id, name, workspace_path, model_ref, disabled_tools, enabled_toolsets, enabled_extensions, enabled_skills, exec_allowlist, spend_cap_usd, spend_window_days, budget_action, is_default, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, '[]', '[]', '[]', '[]', NULL, 30, 'warn', 1, 1, ?, ?)
    `).run(
      DEFAULT_AGENT_ID,
	      "Main Agent",
	      workspacePath,
      null,
      "[]",
      now,
      now,
    );
    return;
  }

  const hasDefault = rows.some((row) => row.is_default === 1);
  if (!hasDefault) {
    const fallbackId = rows.find((row) => row.id === DEFAULT_AGENT_ID)?.id || rows[0].id;
    db.prepare("UPDATE agents SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END").run(fallbackId);
  }
}

export function listAgents(): AgentRecord[] {
  ensureDefaultAgent();
  const db = ensureAgentsTable();
  const rows = db
    .prepare("SELECT * FROM agents ORDER BY is_default DESC, created_at ASC")
    .all() as AgentRow[];
  return rows.map(rowToAgent);
}

export function getAgentById(agentId: string): AgentRecord | null {
  ensureDefaultAgent();
  const db = ensureAgentsTable();
  const row = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as AgentRow | undefined;
  return row ? rowToAgent(row) : null;
}

export function getDefaultAgent(): AgentRecord {
  ensureDefaultAgent();
  const db = ensureAgentsTable();
  const row = db
    .prepare("SELECT * FROM agents WHERE is_default = 1 ORDER BY created_at ASC LIMIT 1")
    .get() as AgentRow | undefined;
  if (row) return rowToAgent(row);

  const fallback = db
    .prepare("SELECT * FROM agents ORDER BY created_at ASC LIMIT 1")
    .get() as AgentRow | undefined;
  if (fallback) return rowToAgent(fallback);

  // Should never happen because ensureDefaultAgent inserts one, but keep safe fallback.
  return {
    id: DEFAULT_AGENT_ID,
    name: "Main Agent",
    workspacePath: defaultWorkspaceForAgent(DEFAULT_AGENT_ID),
    modelRef: null,
    modelApiKey: null,
    modelBaseUrl: null,
    systemPrompt: null,
    temperature: null,
    maxTokens: null,
    disabledTools: [],
    enabledToolsets: [],
    enabledExtensions: [],
    enabledSkills: [],
    execAllowlist: [],
    heartbeatCron: null,
    spendCapUsd: null,
    spendWindowDays: 30,
    budgetAction: "warn",
    budgetMonthlyCents: null,
    spentMonthlyCents: 0,
    budgetResetAt: null,
    isDefault: true,
    isActive: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export function createAgent(input: CreateAgentInput): AgentRecord {
  ensureDefaultAgent();
  const db = ensureAgentsTable();
  const now = new Date().toISOString();
  const id = normalizeAgentId(input.id || input.name);

  const existing = db.prepare("SELECT id FROM agents WHERE id = ?").get(id) as { id: string } | undefined;
  if (existing) {
    throw new Error(`Agent already exists: ${id}`);
  }

  const workspacePath = normalizeWorkspacePath(input.workspacePath || defaultWorkspaceForAgent(id), id);
  ensureWorkspaceScaffold({ workspacePath });

  if (input.isDefault) {
    db.prepare("UPDATE agents SET is_default = 0").run();
  }

  const heartbeatCron = input.heartbeatCron ?? null;

  db.prepare(`
    INSERT INTO agents
      (id, name, workspace_path, model_ref, model_api_key, model_base_url, system_prompt, temperature, max_tokens,
       disabled_tools, enabled_toolsets, enabled_extensions, enabled_skills, exec_allowlist, heartbeat_cron, spend_cap_usd, spend_window_days, budget_action, budget_monthly_cents, spent_monthly_cents, budget_reset_at, is_default, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(
    id,
    input.name.trim() || id,
    workspacePath,
    input.modelRef ?? null,
    input.modelApiKey ?? null,
    input.modelBaseUrl ?? null,
    input.systemPrompt ?? null,
    input.temperature ?? null,
    input.maxTokens ?? null,
    JSON.stringify(input.disabledTools ?? []),
    JSON.stringify(input.enabledToolsets ?? []),
    JSON.stringify(input.enabledExtensions ?? []),
    JSON.stringify(input.enabledSkills ?? []),
    JSON.stringify(input.execAllowlist ?? []),
    heartbeatCron,
    normalizeSpendCap(input.spendCapUsd),
    normalizeSpendWindowDays(input.spendWindowDays),
    normalizeBudgetAction(input.budgetAction),
    input.budgetMonthlyCents ?? null,
    input.spentMonthlyCents ?? 0,
    input.budgetResetAt ?? null,
    input.isDefault ? 1 : 0,
    now,
    now,
  );

  if (heartbeatCron) {
    void import("@/lib/governance/heartbeat").then(m => {
      m.scheduleAgentHeartbeat(id, heartbeatCron);
    }).catch(() => {});
  }

  const created = getAgentById(id)!;
  syncHierarchySnapshotSoon();
  return created;
}

export function updateAgent(agentId: string, input: UpdateAgentInput): AgentRecord {
  ensureDefaultAgent();
  const db = ensureAgentsTable();
  const existing = getAgentById(agentId);
  if (!existing) {
    throw new Error(`Agent not found: ${agentId}`);
  }

  const now = new Date().toISOString();
  const workspacePath = normalizeWorkspacePath(input.workspacePath || existing.workspacePath, agentId);
  ensureWorkspaceScaffold({ workspacePath });

  const nextDisabledTools = input.disabledTools ?? existing.disabledTools;
  const nextEnabledToolsets = input.enabledToolsets ?? existing.enabledToolsets;
  const nextEnabledExtensions = input.enabledExtensions ?? existing.enabledExtensions;
  const nextEnabledSkills = input.enabledSkills ?? existing.enabledSkills;
  const nextExecAllowlist = input.execAllowlist ?? existing.execAllowlist;
  const heartbeatCronChanged = Object.prototype.hasOwnProperty.call(input, "heartbeatCron");
  const nextHeartbeatCron = heartbeatCronChanged ? (input.heartbeatCron ?? null) : existing.heartbeatCron;
  const nextSpendCapUsd =
    Object.prototype.hasOwnProperty.call(input, "spendCapUsd")
      ? normalizeSpendCap(input.spendCapUsd)
      : existing.spendCapUsd;
  const nextSpendWindowDays =
    typeof input.spendWindowDays === "number"
      ? normalizeSpendWindowDays(input.spendWindowDays)
      : existing.spendWindowDays;
  const nextBudgetAction =
    typeof input.budgetAction === "string"
      ? normalizeBudgetAction(input.budgetAction)
      : existing.budgetAction;
  const nextIsDefault = input.isDefault ?? existing.isDefault;
  const nextIsActive = input.isActive ?? existing.isActive;

  if (nextIsDefault) {
    db.prepare("UPDATE agents SET is_default = 0").run();
  }

  const nextModelApiKey = Object.prototype.hasOwnProperty.call(input, "modelApiKey")
    ? (input.modelApiKey ?? null) : existing.modelApiKey;
  const nextModelBaseUrl = Object.prototype.hasOwnProperty.call(input, "modelBaseUrl")
    ? (input.modelBaseUrl ?? null) : existing.modelBaseUrl;
  const nextSystemPrompt = Object.prototype.hasOwnProperty.call(input, "systemPrompt")
    ? (input.systemPrompt ?? null) : existing.systemPrompt;
  const nextTemperature = Object.prototype.hasOwnProperty.call(input, "temperature")
    ? (input.temperature ?? null) : existing.temperature;
  const nextMaxTokens = Object.prototype.hasOwnProperty.call(input, "maxTokens")
    ? (input.maxTokens ?? null) : existing.maxTokens;

  db.prepare(`
    UPDATE agents
    SET name = ?, workspace_path = ?, model_ref = ?, model_api_key = ?, model_base_url = ?, system_prompt = ?, temperature = ?, max_tokens = ?,
        disabled_tools = ?, enabled_toolsets = ?, enabled_extensions = ?, enabled_skills = ?, exec_allowlist = ?,
        heartbeat_cron = ?, spend_cap_usd = ?, spend_window_days = ?, budget_action = ?, is_default = ?, is_active = ?, updated_at = ?
    WHERE id = ?
  `).run(
    (input.name || existing.name).trim() || existing.id,
    workspacePath,
    input.modelRef !== undefined ? input.modelRef : existing.modelRef,
    nextModelApiKey,
    nextModelBaseUrl,
    nextSystemPrompt,
    nextTemperature,
    nextMaxTokens,
    JSON.stringify(nextDisabledTools),
    JSON.stringify(nextEnabledToolsets),
    JSON.stringify(nextEnabledExtensions),
    JSON.stringify(nextEnabledSkills),
    JSON.stringify(nextExecAllowlist),
    nextHeartbeatCron,
    nextSpendCapUsd,
    nextSpendWindowDays,
    nextBudgetAction,
    nextIsDefault ? 1 : 0,
    nextIsActive ? 1 : 0,
    now,
    agentId,
  );

  if (heartbeatCronChanged) {
    void import("@/lib/governance/heartbeat").then(m => {
      if (nextHeartbeatCron) m.scheduleAgentHeartbeat(agentId, nextHeartbeatCron);
      else m.unscheduleAgentHeartbeat(agentId);
    }).catch(() => {});
  }

  ensureDefaultAgent();
  const updated = getAgentById(agentId)!;
  syncHierarchySnapshotSoon();
  return updated;
}

export function deleteAgent(agentId: string): void {
  ensureDefaultAgent();
  const db = ensureAgentsTable();
  const existing = getAgentById(agentId);
  if (!existing) return;
  if (existing.isDefault) {
    throw new Error("Default agent cannot be deleted");
  }

  unscheduleAgentHeartbeat(agentId);
  db.prepare("DELETE FROM agents WHERE id = ?").run(agentId);
  // Clean up governance tables that reference this agent
  try { db.prepare("DELETE FROM agent_runtime_state WHERE agent_id = ?").run(agentId); } catch { /* ignore */ }
  try { db.prepare("DELETE FROM heartbeat_run_events WHERE agent_id = ?").run(agentId); } catch { /* ignore */ }
  ensureDefaultAgent();
  syncHierarchySnapshotSoon();
}

export function setAgentDisabledTools(agentId: string, disabledTools: string[]): AgentRecord {
  return updateAgent(agentId, { disabledTools });
}

export function setAgentExtensions(agentId: string, enabledExtensions: string[]): AgentRecord {
  return updateAgent(agentId, { enabledExtensions });
}

export function setAgentEnabledSkills(agentId: string, enabledSkills: string[]): AgentRecord {
  return updateAgent(agentId, { enabledSkills });
}

export function setAgentExecAllowlist(agentId: string, execAllowlist: string[]): AgentRecord {
  return updateAgent(agentId, { execAllowlist });
}

export function pruneExtensionReferences(extensionId: string): void {
  ensureDefaultAgent();
  const agents = listAgents();
  const skillPrefix = `${extensionId}:`;
  for (const agent of agents) {
    const nextExtensions = agent.enabledExtensions.filter((entry) => entry !== extensionId);
    const nextSkills = agent.enabledSkills.filter((entry) => !entry.startsWith(skillPrefix));
    if (
      nextExtensions.length === agent.enabledExtensions.length &&
      nextSkills.length === agent.enabledSkills.length
    ) {
      continue;
    }
    updateAgent(agent.id, {
      enabledExtensions: nextExtensions,
      enabledSkills: nextSkills,
    });
  }
}

export function pruneSkillPackReferences(skillPackId: string): void {
  ensureDefaultAgent();
  const agents = listAgents();
  const exactId = `external:${skillPackId}`;
  const prefix = `${exactId}:`;
  for (const agent of agents) {
    const nextSkills = agent.enabledSkills.filter((entry) => entry !== exactId && !entry.startsWith(prefix));
    if (nextSkills.length === agent.enabledSkills.length) {
      continue;
    }
    updateAgent(agent.id, {
      enabledSkills: nextSkills,
    });
  }
}
