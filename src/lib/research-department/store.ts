import { nanoid } from "nanoid";
import { getSqlite, initializeDatabase } from "@/lib/db";
import {
  DEFAULT_RESEARCH_SAFETY,
  type ResearchDeliveryConfig,
  type ResearchDepartmentDetail,
  type ResearchDepartmentMember,
  type ResearchDepartmentRecord,
  type ResearchDepartmentRole,
  type ResearchDepartmentTier,
  type ResearchDepartmentWorkflowKind,
  type ResearchDepartmentWorkflowLink,
  type ResearchSafetyConfig,
  type ResearchSourceConfig,
} from "./types";

interface DepartmentRow {
  id: string;
  name: string;
  slug: string;
  tier: string;
  focus_area: string;
  keywords_json: string;
  source_config_json: string;
  vault_root: string;
  delivery_config_json: string;
  safety_config_json: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export function ensureResearchDepartmentTables() {
  initializeDatabase();
  const db = getSqlite();
  db.exec(`
    CREATE TABLE IF NOT EXISTS research_departments (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      tier TEXT NOT NULL,
      focus_area TEXT NOT NULL,
      keywords_json TEXT NOT NULL DEFAULT '[]',
      source_config_json TEXT NOT NULL DEFAULT '{}',
      vault_root TEXT NOT NULL,
      delivery_config_json TEXT NOT NULL DEFAULT '{}',
      safety_config_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS research_department_members (
      department_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      role TEXT NOT NULL,
      PRIMARY KEY (department_id, role)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS research_department_workflows (
      department_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      PRIMARY KEY (department_id, workflow_id)
    )
  `);
  // Backfill the safety column on older installs.
  try {
    db.exec("ALTER TABLE research_departments ADD COLUMN safety_config_json TEXT NOT NULL DEFAULT '{}'");
  } catch (error) {
    if (!String(error).includes("duplicate column name")) throw error;
  }
  return db;
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function rowToRecord(row: DepartmentRow): ResearchDepartmentRecord {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    tier: row.tier as ResearchDepartmentTier,
    focusArea: row.focus_area,
    keywords: parseJson<string[]>(row.keywords_json, []),
    sourceConfig: parseJson<ResearchSourceConfig>(row.source_config_json, {
      keywords: [],
      rssFeeds: [],
      arxivCategories: [],
      competitorUrls: [],
    }),
    vaultRoot: row.vault_root,
    deliveryConfig: parseJson<ResearchDeliveryConfig>(row.delivery_config_json, { channel: "webchat" }),
    safetyConfig: parseJson<ResearchSafetyConfig>(row.safety_config_json, DEFAULT_RESEARCH_SAFETY),
    status: row.status === "paused" ? "paused" : "active",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface InsertDepartmentInput {
  name: string;
  slug: string;
  tier: ResearchDepartmentTier;
  focusArea: string;
  keywords: string[];
  sourceConfig: ResearchSourceConfig;
  vaultRoot: string;
  deliveryConfig: ResearchDeliveryConfig;
  safetyConfig: ResearchSafetyConfig;
}

export function insertDepartment(input: InsertDepartmentInput): ResearchDepartmentRecord {
  const db = ensureResearchDepartmentTables();
  const now = new Date().toISOString();
  const id = `rd-${nanoid(8)}`;
  db.prepare(
    `INSERT INTO research_departments
      (id, name, slug, tier, focus_area, keywords_json, source_config_json, vault_root, delivery_config_json, safety_config_json, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
  ).run(
    id,
    input.name,
    input.slug,
    input.tier,
    input.focusArea,
    JSON.stringify(input.keywords),
    JSON.stringify(input.sourceConfig),
    input.vaultRoot,
    JSON.stringify(input.deliveryConfig),
    JSON.stringify(input.safetyConfig),
    now,
    now,
  );
  return getDepartment(id)!;
}

export function slugExists(slug: string): boolean {
  const db = ensureResearchDepartmentTables();
  const row = db.prepare("SELECT id FROM research_departments WHERE slug = ?").get(slug) as { id: string } | undefined;
  return Boolean(row);
}

export function listDepartments(): ResearchDepartmentRecord[] {
  const db = ensureResearchDepartmentTables();
  const rows = db.prepare("SELECT * FROM research_departments ORDER BY created_at DESC").all() as DepartmentRow[];
  return rows.map(rowToRecord);
}

export function getDepartment(id: string): ResearchDepartmentRecord | null {
  const db = ensureResearchDepartmentTables();
  const row = db.prepare("SELECT * FROM research_departments WHERE id = ?").get(id) as DepartmentRow | undefined;
  return row ? rowToRecord(row) : null;
}

export function getDepartmentDetail(id: string): ResearchDepartmentDetail | null {
  const record = getDepartment(id);
  if (!record) return null;
  return { ...record, members: listMembers(id), workflows: listWorkflowLinks(id) };
}

export function updateDepartmentStatus(id: string, status: "active" | "paused"): void {
  const db = ensureResearchDepartmentTables();
  db.prepare("UPDATE research_departments SET status = ?, updated_at = ? WHERE id = ?").run(status, new Date().toISOString(), id);
}

export function updateDepartmentFields(
  id: string,
  fields: Partial<Pick<ResearchDepartmentRecord, "name" | "focusArea" | "sourceConfig" | "deliveryConfig" | "safetyConfig" | "keywords">>,
): void {
  const db = ensureResearchDepartmentTables();
  const existing = getDepartment(id);
  if (!existing) return;
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE research_departments SET name = ?, focus_area = ?, keywords_json = ?, source_config_json = ?, delivery_config_json = ?, safety_config_json = ?, updated_at = ? WHERE id = ?`,
  ).run(
    fields.name ?? existing.name,
    fields.focusArea ?? existing.focusArea,
    JSON.stringify(fields.keywords ?? existing.keywords),
    JSON.stringify(fields.sourceConfig ?? existing.sourceConfig),
    JSON.stringify(fields.deliveryConfig ?? existing.deliveryConfig),
    JSON.stringify(fields.safetyConfig ?? existing.safetyConfig),
    now,
    id,
  );
}

export function deleteDepartmentRecord(id: string): void {
  const db = ensureResearchDepartmentTables();
  db.prepare("DELETE FROM research_departments WHERE id = ?").run(id);
  db.prepare("DELETE FROM research_department_members WHERE department_id = ?").run(id);
  db.prepare("DELETE FROM research_department_workflows WHERE department_id = ?").run(id);
}

// ── Members ──────────────────────────────────────────────────────────────────

export function addMember(departmentId: string, role: ResearchDepartmentRole, agentId: string): void {
  const db = ensureResearchDepartmentTables();
  db.prepare(
    "INSERT OR REPLACE INTO research_department_members (department_id, agent_id, role) VALUES (?, ?, ?)",
  ).run(departmentId, agentId, role);
}

export interface DepartmentUsageRollup {
  windowDays: number;
  tokens: number;
  costUsd: number;
  calls: number;
  perAgent: Array<{ agentId: string; role: string; tokens: number; costUsd: number; calls: number }>;
  /** Ready-to-inject brief line, e.g. "Usage: 18,200 tokens / $0.04 this week." */
  line: string;
}

/**
 * Roll up real token/cost spend for a department's member agents over a window,
 * from the shared agent_spend_events ledger. Used to ground the Briefer's
 * weekly-usage line from persisted spend events — no synthetic numbers.
 */
export function getDepartmentWeeklyUsage(departmentId: string, windowDays = 7): DepartmentUsageRollup {
  const db = ensureResearchDepartmentTables();
  const members = listMembers(departmentId);
  const sinceIso = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const perAgent: DepartmentUsageRollup["perAgent"] = [];
  let tokens = 0;
  let costUsd = 0;
  let calls = 0;
  for (const m of members) {
    let row: { tokens?: number; cost?: number; calls?: number } | undefined;
    try {
      row = db
        .prepare(
          "SELECT COALESCE(SUM(tokens_used),0) AS tokens, COALESCE(SUM(cost_usd),0) AS cost, COUNT(*) AS calls FROM agent_spend_events WHERE agent_id = ? AND created_at >= ?",
        )
        .get(m.agentId, sinceIso) as { tokens?: number; cost?: number; calls?: number };
    } catch {
      row = { tokens: 0, cost: 0, calls: 0 };
    }
    const t = Number(row?.tokens || 0);
    const c = Number(row?.cost || 0);
    const n = Number(row?.calls || 0);
    tokens += t;
    costUsd += c;
    calls += n;
    perAgent.push({ agentId: m.agentId, role: m.role, tokens: t, costUsd: c, calls: n });
  }
  const line = `Usage: ${tokens.toLocaleString("en-US")} tokens / $${costUsd.toFixed(2)} across ${calls} call(s) in the last ${windowDays} day(s).`;
  return { windowDays, tokens, costUsd: Number(costUsd.toFixed(4)), calls, perAgent, line };
}

export function listMembers(departmentId: string): ResearchDepartmentMember[] {
  const db = ensureResearchDepartmentTables();
  const rows = db
    .prepare("SELECT department_id, agent_id, role FROM research_department_members WHERE department_id = ?")
    .all(departmentId) as Array<{ department_id: string; agent_id: string; role: string }>;
  return rows.map((r) => ({ departmentId: r.department_id, agentId: r.agent_id, role: r.role as ResearchDepartmentRole }));
}

// ── Workflow links ───────────────────────────────────────────────────────────

export function addWorkflowLink(departmentId: string, workflowId: string, kind: ResearchDepartmentWorkflowKind): void {
  const db = ensureResearchDepartmentTables();
  db.prepare(
    "INSERT OR REPLACE INTO research_department_workflows (department_id, workflow_id, kind) VALUES (?, ?, ?)",
  ).run(departmentId, workflowId, kind);
}

export function listWorkflowLinks(departmentId: string): ResearchDepartmentWorkflowLink[] {
  const db = ensureResearchDepartmentTables();
  const rows = db
    .prepare("SELECT department_id, workflow_id, kind FROM research_department_workflows WHERE department_id = ?")
    .all(departmentId) as Array<{ department_id: string; workflow_id: string; kind: string }>;
  return rows.map((r) => ({ departmentId: r.department_id, workflowId: r.workflow_id, kind: r.kind as ResearchDepartmentWorkflowKind }));
}
