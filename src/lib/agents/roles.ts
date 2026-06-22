import { getSqlite, initializeDatabase } from "@/lib/db";
import { getDefaultAgent, listAgents } from "@/lib/agents/registry";

export type AgentRoleType =
  | "orchestrator"
  | "operations"
  | "specialist"
  | "worker"
  | "support";

export interface AgentRoleRecord {
  agentId: string;
  roleType: AgentRoleType;
  roleTitle: string;
  roleDescription: string;
  reportsTo: string | null;
  capabilities: string[];
  voteWeight: number;
  createdAt: string;
  updatedAt: string;
}

interface AgentRoleRow {
  agent_id: string;
  role_type: string;
  role_title: string;
  role_description: string;
  reports_to: string | null;
  capabilities: string | null;
  vote_weight?: number | null;
  created_at: string;
  updated_at: string;
}

interface UpdateRoleInput {
  roleType?: AgentRoleType;
  roleTitle?: string;
  roleDescription?: string;
  reportsTo?: string | null;
  capabilities?: string[];
  voteWeight?: number;
}

export type ChainOfCommandValidation = {
  ok: boolean;
  errors: string[];
};

const ROLE_ORDER: AgentRoleType[] = [
  "orchestrator",
  "operations",
  "specialist",
  "worker",
  "support",
];

function ensureAgentRolesTable() {
  initializeDatabase();
  const db = getSqlite();
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_roles (
      agent_id TEXT PRIMARY KEY,
      role_type TEXT NOT NULL DEFAULT 'worker',
      role_title TEXT NOT NULL DEFAULT '',
      role_description TEXT NOT NULL DEFAULT '',
      reports_to TEXT,
      capabilities TEXT NOT NULL DEFAULT '[]',
      vote_weight INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  const roleCols = db.prepare("PRAGMA table_info(agent_roles)").all() as Array<{ name: string }>;
  const roleColNames = new Set(roleCols.map((column) => column.name));
  if (!roleColNames.has("vote_weight")) {
    db.exec("ALTER TABLE agent_roles ADD COLUMN vote_weight INTEGER NOT NULL DEFAULT 1");
  }
  return db;
}

function normalizeRoleType(value: unknown): AgentRoleType {
  const candidate = String(value ?? "").trim().toLowerCase();
  if (ROLE_ORDER.includes(candidate as AgentRoleType)) {
    return candidate as AgentRoleType;
  }
  return "worker";
}

function normalizeCapabilities(values: unknown): string[] {
  const raw = Array.isArray(values)
    ? values
    : typeof values === "string"
      ? values.split(/,|\n/g)
      : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    const capability = String(value ?? "").trim();
    if (!capability) continue;
    const key = capability.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(capability);
  }
  return out;
}

function parseCapabilities(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return normalizeCapabilities(parsed);
  } catch {
    return [];
  }
}

function normalizeVoteWeight(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(1, Math.min(9, Math.round(parsed)));
}

function rowToRole(row: AgentRoleRow): AgentRoleRecord {
  return {
    agentId: row.agent_id,
    roleType: normalizeRoleType(row.role_type),
    roleTitle: String(row.role_title ?? ""),
    roleDescription: String(row.role_description ?? ""),
    reportsTo: row.reports_to ? String(row.reports_to) : null,
    capabilities: parseCapabilities(row.capabilities),
    voteWeight: normalizeVoteWeight(row.vote_weight),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function defaultTitleForRole(roleType: AgentRoleType): string {
  if (roleType === "orchestrator") return "Orchestrator";
  if (roleType === "operations") return "Operations Lead";
  if (roleType === "specialist") return "Specialist";
  if (roleType === "support") return "Support Agent";
  return "Worker Agent";
}

function saveRole(record: AgentRoleRecord) {
  const db = ensureAgentRolesTable();
  db.prepare(`
    INSERT INTO agent_roles
      (agent_id, role_type, role_title, role_description, reports_to, capabilities, vote_weight, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent_id) DO UPDATE SET
      role_type = excluded.role_type,
      role_title = excluded.role_title,
      role_description = excluded.role_description,
      reports_to = excluded.reports_to,
      capabilities = excluded.capabilities,
      vote_weight = excluded.vote_weight,
      updated_at = excluded.updated_at
  `).run(
    record.agentId,
    record.roleType,
    record.roleTitle,
    record.roleDescription,
    record.reportsTo,
    JSON.stringify(record.capabilities),
    normalizeVoteWeight(record.voteWeight),
    record.createdAt,
    record.updatedAt,
  );
}

function ensureRoleRows(): AgentRoleRecord[] {
  const agents = listAgents();
  const db = ensureAgentRolesTable();
  const now = new Date().toISOString();

  const rows = db.prepare("SELECT * FROM agent_roles ORDER BY updated_at DESC").all() as AgentRoleRow[];
  const existing = new Map(rows.map((row) => [row.agent_id, rowToRole(row)]));
  const validAgentIds = new Set(agents.map((agent) => agent.id));

  // Remove stale role rows for deleted agents.
  for (const role of existing.values()) {
    if (!validAgentIds.has(role.agentId)) {
      db.prepare("DELETE FROM agent_roles WHERE agent_id = ?").run(role.agentId);
      existing.delete(role.agentId);
    }
  }

  const defaultAgent = getDefaultAgent();
  const existingOrchestrators = [...existing.values()].filter((role) => role.roleType === "orchestrator");
  const orchestratorId = existingOrchestrators[0]?.agentId || defaultAgent.id;

  // Create missing role rows.
  for (const agent of agents) {
    if (existing.has(agent.id)) continue;
    const roleType: AgentRoleType = agent.id === orchestratorId ? "orchestrator" : "worker";
    const role: AgentRoleRecord = {
      agentId: agent.id,
      roleType,
      roleTitle: defaultTitleForRole(roleType),
      roleDescription: "",
      reportsTo: roleType === "orchestrator" ? null : orchestratorId,
      capabilities: [],
      voteWeight: 1,
      createdAt: now,
      updatedAt: now,
    };
    saveRole(role);
    existing.set(agent.id, role);
  }

  // Ensure exactly one orchestrator and valid reports-to links.
  let foundOrchestrator = false;
  for (const agent of agents) {
    const role = existing.get(agent.id);
    if (!role) continue;
    const next = { ...role };
    if (next.roleType === "orchestrator") {
      if (!foundOrchestrator) {
        foundOrchestrator = true;
      } else {
        next.roleType = "operations";
      }
      next.reportsTo = null;
    } else {
      if (next.reportsTo && !validAgentIds.has(next.reportsTo)) {
        next.reportsTo = orchestratorId;
      }
      if (!next.reportsTo && orchestratorId !== next.agentId) {
        next.reportsTo = orchestratorId;
      }
      if (next.reportsTo === next.agentId) {
        next.reportsTo = orchestratorId === next.agentId ? null : orchestratorId;
      }
    }
    if (!next.roleTitle.trim()) {
      next.roleTitle = defaultTitleForRole(next.roleType);
    }
    if (
      next.roleType !== role.roleType ||
      next.reportsTo !== role.reportsTo ||
      next.roleTitle !== role.roleTitle
    ) {
      next.updatedAt = now;
      saveRole(next);
      existing.set(agent.id, next);
    }
  }

  const byAgentId = new Map(existing);
  return agents
    .map((agent) => byAgentId.get(agent.id))
    .filter((role): role is AgentRoleRecord => Boolean(role));
}

export function listAgentRoles(): AgentRoleRecord[] {
  return ensureRoleRows();
}

export function getChainOfCommand(agentId: string): AgentRoleRecord[] {
  const roles = ensureRoleRows();
  const byAgentId = new Map(roles.map((role) => [role.agentId, role]));
  const chain: AgentRoleRecord[] = [];
  const seen = new Set<string>();
  let cursor = byAgentId.get(agentId)?.reportsTo ?? null;
  while (cursor) {
    if (seen.has(cursor)) break;
    seen.add(cursor);
    const manager = byAgentId.get(cursor);
    if (!manager) break;
    chain.push(manager);
    cursor = manager.reportsTo;
  }
  return chain;
}

export function validateChainOfCommand(rolesInput: AgentRoleRecord[] = ensureRoleRows()): ChainOfCommandValidation {
  const roles = rolesInput;
  const agentsById = new Map(listAgents().map((agent) => [agent.id, agent]));
  const roleByAgentId = new Map(roles.map((role) => [role.agentId, role]));
  const errors: string[] = [];
  const orchestrators = roles.filter((role) => role.roleType === "orchestrator");

  if (orchestrators.length === 0) {
    errors.push("At least one orchestrator is required.");
  }
  for (const role of orchestrators) {
    if (role.reportsTo) {
      errors.push(`Root orchestrator ${role.agentId} cannot report to another agent.`);
    }
  }

  for (const role of roles) {
    if (role.roleType !== "orchestrator" && !role.reportsTo) {
      errors.push(`Agent ${role.agentId} must report to exactly one manager.`);
    }
    if (role.reportsTo === role.agentId) {
      errors.push(`Agent ${role.agentId} cannot report to itself.`);
    }
    if (role.reportsTo && !roleByAgentId.has(role.reportsTo)) {
      errors.push(`Agent ${role.agentId} reports to missing manager ${role.reportsTo}.`);
    }
    const manager = role.reportsTo ? agentsById.get(role.reportsTo) : null;
    const agent = agentsById.get(role.agentId);
    if (agent?.isActive && manager && !manager.isActive) {
      errors.push(`Active agent ${role.agentId} cannot report to inactive manager ${role.reportsTo}.`);
    }
  }

  for (const role of roles) {
    const seen = new Set<string>();
    let cursor: string | null = role.agentId;
    while (cursor) {
      if (seen.has(cursor)) {
        errors.push(`Reporting cycle detected at agent ${cursor}.`);
        break;
      }
      seen.add(cursor);
      cursor = roleByAgentId.get(cursor)?.reportsTo ?? null;
    }
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

export function updateAgentRole(agentId: string, input: UpdateRoleInput): AgentRoleRecord {
  const roles = ensureRoleRows();
  const role = roles.find((entry) => entry.agentId === agentId);
  if (!role) {
    throw new Error(`Agent not found: ${agentId}`);
  }

  const validAgentIds = new Set(roles.map((entry) => entry.agentId));
  const now = new Date().toISOString();

  const nextRoleType = input.roleType ?? role.roleType;
  const requestedReportsTo =
    input.reportsTo !== undefined
      ? (input.reportsTo ? String(input.reportsTo).trim() : null)
      : role.reportsTo;

  let nextReportsTo = requestedReportsTo;
  if (nextRoleType === "orchestrator") {
    nextReportsTo = null;
  } else if (nextReportsTo && !validAgentIds.has(nextReportsTo)) {
    nextReportsTo = null;
  }
  if (nextReportsTo === agentId) {
    nextReportsTo = null;
  }

  const next: AgentRoleRecord = {
    ...role,
    roleType: nextRoleType,
    roleTitle:
      input.roleTitle !== undefined
        ? String(input.roleTitle).trim().slice(0, 120)
        : role.roleTitle,
    roleDescription:
      input.roleDescription !== undefined
        ? String(input.roleDescription).trim().slice(0, 600)
        : role.roleDescription,
    reportsTo: nextReportsTo,
    capabilities:
      input.capabilities !== undefined
        ? normalizeCapabilities(input.capabilities)
        : role.capabilities,
    voteWeight:
      input.voteWeight !== undefined
        ? normalizeVoteWeight(input.voteWeight)
        : normalizeVoteWeight(role.voteWeight),
    updatedAt: now,
  };

  if (!next.roleTitle.trim()) {
    next.roleTitle = defaultTitleForRole(next.roleType);
  }

  const proposedRoles = roles.map((entry) => (entry.agentId === agentId ? next : entry));
  const validation = validateChainOfCommand(proposedRoles);
  if (!validation.ok) {
    throw new Error(`Invalid chain of command: ${validation.errors.join(" ")}`);
  }

  saveRole(next);

  if (next.roleType === "orchestrator") {
    // Demote previous orchestrators and point orphaned rows to the new orchestrator.
    for (const entry of roles) {
      if (entry.agentId === next.agentId) continue;
      if (entry.roleType !== "orchestrator" && entry.reportsTo) continue;
      const patched: AgentRoleRecord = {
        ...entry,
        roleType: entry.roleType === "orchestrator" ? "operations" : entry.roleType,
        reportsTo: next.agentId,
        updatedAt: now,
      };
      if (!patched.roleTitle.trim()) {
        patched.roleTitle = defaultTitleForRole(patched.roleType);
      }
      saveRole(patched);
    }
  }

  const refreshed = listAgentRoles().find((entry) => entry.agentId === agentId);
  if (!refreshed) {
    throw new Error(`Agent role not found after update: ${agentId}`);
  }
  void import("@/lib/hierarchy/organizations")
    .then((module) => module.syncActiveHierarchyOrganizationSnapshot())
    .catch(() => {
      // Ignore snapshot sync failures so role updates still complete.
    });
  return refreshed;
}
