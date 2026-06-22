/**
 * Hierarchy approval-chain enforcement (V156 Gap 3).
 *
 * Approval *policies* (defined in policies.ts) describe when a hierarchy/org
 * action needs sign-off. This module enforces them at execution time:
 *   - resolve the most specific active policy by org / scope / action pattern / risk
 *   - when approval is required, create (or reuse) a pending approval request
 *   - assign the configured approver agent where present
 *   - record a ledger event so the request surfaces in Hierarchy activity
 *
 * Requests are hierarchy/action-scoped (not board-task-scoped, which is what
 * governance/task-approvals covers), so they get their own lightweight table.
 */

import { nanoid } from "nanoid";
import { getSqlite, initializeDatabase } from "@/lib/db";
import { listHierarchyApprovalPolicies, type HierarchyApprovalPolicy } from "@/lib/hierarchy/policies";
import { recordHierarchyActivityEvent } from "@/lib/hierarchy/activity";

export type RiskLevel = "low" | "medium" | "high";
const RISK_ORDER: Record<RiskLevel, number> = { low: 1, medium: 2, high: 3 };

export type HierarchyApprovalRequest = {
  id: string;
  organizationId: string | null;
  goalId: string | null;
  agentId: string | null;
  action: string;
  risk: string;
  status: "pending" | "approved" | "rejected";
  requireHuman: boolean;
  approverAgentId: string | null;
  policyId: string | null;
  summary: string | null;
  decisionNote: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type RequestRow = {
  id: string;
  organization_id: string | null;
  goal_id: string | null;
  agent_id: string | null;
  action: string;
  risk: string;
  status: string;
  require_human: number;
  approver_agent_id: string | null;
  policy_id: string | null;
  summary: string | null;
  decision_note: string | null;
  decided_at: string | null;
  created_at: string;
  updated_at: string;
};

function ensureTables() {
  initializeDatabase();
  const db = getSqlite();
  db.exec(`
    CREATE TABLE IF NOT EXISTS hierarchy_approval_requests (
      id TEXT PRIMARY KEY,
      organization_id TEXT,
      goal_id TEXT,
      agent_id TEXT,
      action TEXT NOT NULL,
      risk TEXT NOT NULL DEFAULT 'medium',
      status TEXT NOT NULL DEFAULT 'pending',
      require_human INTEGER NOT NULL DEFAULT 1,
      approver_agent_id TEXT,
      policy_id TEXT,
      summary TEXT,
      decision_note TEXT,
      decided_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_hierarchy_approval_requests_org ON hierarchy_approval_requests(organization_id);
    CREATE INDEX IF NOT EXISTS idx_hierarchy_approval_requests_status ON hierarchy_approval_requests(status);
  `);
  return db;
}

function mapRequest(row: RequestRow): HierarchyApprovalRequest {
  return {
    id: row.id,
    organizationId: row.organization_id ?? null,
    goalId: row.goal_id ?? null,
    agentId: row.agent_id ?? null,
    action: row.action,
    risk: row.risk,
    status: (row.status as HierarchyApprovalRequest["status"]) ?? "pending",
    requireHuman: row.require_human === 1,
    approverAgentId: row.approver_agent_id ?? null,
    policyId: row.policy_id ?? null,
    summary: row.summary ?? null,
    decisionNote: row.decision_note ?? null,
    decidedAt: row.decided_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeRisk(value: string | null | undefined): RiskLevel {
  const v = String(value ?? "medium").toLowerCase();
  return v === "low" || v === "high" ? v : "medium";
}

/** Glob-ish action match: "*" matches all; otherwise exact / prefix* / *substring*. */
function actionMatches(pattern: string, action: string): boolean {
  const p = String(pattern || "*").trim().toLowerCase();
  const a = String(action || "").trim().toLowerCase();
  if (p === "*" || p === "") return true;
  if (p === a) return true;
  if (p.endsWith("*") && a.startsWith(p.slice(0, -1))) return true;
  if (p.startsWith("*") && a.endsWith(p.slice(1))) return true;
  return a.includes(p.replace(/\*/g, ""));
}

/**
 * Resolve the most specific active approval policy that applies to an action.
 * Org-scoped policies are preferred over global; an action's risk must be at or
 * above the policy's minimum risk to apply.
 */
export function resolveHierarchyApprovalPolicy(input: {
  organizationId?: string | null;
  action: string;
  risk?: RiskLevel;
}): HierarchyApprovalPolicy | null {
  const risk = normalizeRisk(input.risk);
  const orgScoped = input.organizationId
    ? listHierarchyApprovalPolicies({ organizationId: input.organizationId })
    : [];
  const global = listHierarchyApprovalPolicies({}).filter((p) => !p.organizationId);
  const candidates = [...orgScoped, ...global];
  return (
    candidates.find(
      (policy) =>
        policy.isActive &&
        RISK_ORDER[risk] >= RISK_ORDER[normalizeRisk(policy.minRisk)] &&
        actionMatches(policy.actionPattern, input.action),
    ) ?? null
  );
}

export type HierarchyApprovalDecision = {
  required: boolean;
  request: HierarchyApprovalRequest | null;
  policy: HierarchyApprovalPolicy | null;
  message: string | null;
};

/**
 * Enforce approval policy for a hierarchy/org action. When a matching policy
 * applies, create or reuse a pending approval request and surface it in the
 * activity ledger. Returns `required:false` when no policy applies.
 */
export function requireHierarchyApproval(input: {
  organizationId?: string | null;
  goalId?: string | null;
  agentId?: string | null;
  action: string;
  risk?: RiskLevel;
  summary?: string;
}): HierarchyApprovalDecision {
  const policy = resolveHierarchyApprovalPolicy({
    organizationId: input.organizationId,
    action: input.action,
    risk: input.risk,
  });
  if (!policy) {
    return { required: false, request: null, policy: null, message: null };
  }

  const db = ensureTables();
  const risk = normalizeRisk(input.risk);

  // Reuse an existing pending request for the same org+action to avoid duplicates.
  const existing = db
    .prepare(
      "SELECT * FROM hierarchy_approval_requests WHERE action = ? AND status = 'pending' AND (organization_id IS ? OR organization_id = ?) ORDER BY created_at DESC LIMIT 1",
    )
    .get(input.action, input.organizationId ?? null, input.organizationId ?? null) as RequestRow | undefined;

  if (existing) {
    return {
      required: true,
      request: mapRequest(existing),
      policy,
      message: `Approval already pending for ${input.action}.`,
    };
  }

  const now = new Date().toISOString();
  const id = nanoid(12);
  db.prepare(
    `INSERT INTO hierarchy_approval_requests
       (id, organization_id, goal_id, agent_id, action, risk, status, require_human, approver_agent_id, policy_id, summary, decision_note, decided_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, NULL, NULL, ?, ?)`,
  ).run(
    id,
    input.organizationId ?? null,
    input.goalId ?? null,
    input.agentId ?? null,
    input.action,
    risk,
    policy.requireHuman ? 1 : 0,
    policy.approverAgentId ?? null,
    policy.id,
    input.summary ?? null,
    now,
    now,
  );

  recordHierarchyActivityEvent({
    organizationId: input.organizationId ?? policy.organizationId ?? null,
    goalId: input.goalId ?? null,
    agentId: input.agentId ?? null,
    eventType: "approval.requested",
    title: "Approval requested",
    summary: input.summary ?? `${input.action} requires approval before running.`,
    status: "pending",
    metadata: {
      requestId: id,
      action: input.action,
      risk,
      requireHuman: policy.requireHuman,
      approverAgentId: policy.approverAgentId ?? null,
      policyId: policy.id,
    },
  });

  const request = getHierarchyApprovalRequest(id)!;
  const who = policy.approverAgentId
    ? `assigned to agent ${policy.approverAgentId}`
    : policy.requireHuman
      ? "awaiting human approval"
      : "queued for review";
  return {
    required: true,
    request,
    policy,
    message: `${input.action} requires approval (${who}). It is queued in Hierarchy activity.`,
  };
}

export function getHierarchyApprovalRequest(id: string): HierarchyApprovalRequest | null {
  const db = ensureTables();
  const row = db.prepare("SELECT * FROM hierarchy_approval_requests WHERE id = ?").get(id) as RequestRow | undefined;
  return row ? mapRequest(row) : null;
}

export function listHierarchyApprovalRequests(input?: {
  organizationId?: string | null;
  status?: HierarchyApprovalRequest["status"];
  limit?: number;
}): HierarchyApprovalRequest[] {
  const db = ensureTables();
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (input?.organizationId) { clauses.push("organization_id = ?"); values.push(input.organizationId); }
  if (input?.status) { clauses.push("status = ?"); values.push(input.status); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = Math.max(1, Math.min(200, Math.floor(Number(input?.limit ?? 50))));
  const rows = db.prepare(`SELECT * FROM hierarchy_approval_requests ${where} ORDER BY created_at DESC LIMIT ?`).all(...values, limit) as RequestRow[];
  return rows.map(mapRequest);
}

export function resolveHierarchyApprovalRequest(input: {
  id: string;
  decision: "approved" | "rejected";
  decisionNote?: string;
}): HierarchyApprovalRequest {
  const db = ensureTables();
  const existing = getHierarchyApprovalRequest(input.id);
  if (!existing) throw new Error(`Approval request not found: ${input.id}`);
  const now = new Date().toISOString();
  db.prepare(
    "UPDATE hierarchy_approval_requests SET status = ?, decision_note = ?, decided_at = ?, updated_at = ? WHERE id = ?",
  ).run(input.decision, input.decisionNote ?? null, now, now, input.id);

  recordHierarchyActivityEvent({
    organizationId: existing.organizationId,
    goalId: existing.goalId,
    agentId: existing.agentId,
    eventType: `approval.${input.decision}`,
    title: `Approval ${input.decision}`,
    summary: `${existing.action} was ${input.decision}.`,
    status: input.decision === "approved" ? "approved" : "rejected",
    metadata: { requestId: input.id, action: existing.action },
  });
  return getHierarchyApprovalRequest(input.id)!;
}
