import { nanoid } from "nanoid";
import { getSqlite, initializeDatabase } from "@/lib/db";
import { recordHierarchyActivityEvent } from "@/lib/hierarchy/activity";

export type HierarchyBudgetPolicy = {
  id: string;
  organizationId: string | null;
  goalId: string | null;
  agentId: string | null;
  scope: "organization" | "goal" | "agent" | "global" | string;
  softLimitUsd: number | null;
  hardLimitUsd: number | null;
  requireApprovalAboveUsd: number | null;
  period: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type HierarchyApprovalPolicy = {
  id: string;
  organizationId: string | null;
  scope: string;
  actionPattern: string;
  approverAgentId: string | null;
  requireHuman: boolean;
  minRisk: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

type BudgetRow = {
  id: string;
  organization_id: string | null;
  goal_id: string | null;
  agent_id: string | null;
  scope: string;
  soft_limit_usd: number | null;
  hard_limit_usd: number | null;
  require_approval_above_usd: number | null;
  period: string;
  is_active: number;
  created_at: string;
  updated_at: string;
};

type ApprovalRow = {
  id: string;
  organization_id: string | null;
  scope: string;
  action_pattern: string;
  approver_agent_id: string | null;
  require_human: number;
  min_risk: string;
  is_active: number;
  created_at: string;
  updated_at: string;
};

function ensurePolicyTables() {
  initializeDatabase();
  return getSqlite();
}

function mapBudget(row: BudgetRow): HierarchyBudgetPolicy {
  return {
    id: row.id,
    organizationId: row.organization_id ?? null,
    goalId: row.goal_id ?? null,
    agentId: row.agent_id ?? null,
    scope: row.scope,
    softLimitUsd: row.soft_limit_usd === null ? null : Number(row.soft_limit_usd),
    hardLimitUsd: row.hard_limit_usd === null ? null : Number(row.hard_limit_usd),
    requireApprovalAboveUsd: row.require_approval_above_usd === null ? null : Number(row.require_approval_above_usd),
    period: row.period,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapApproval(row: ApprovalRow): HierarchyApprovalPolicy {
  return {
    id: row.id,
    organizationId: row.organization_id ?? null,
    scope: row.scope,
    actionPattern: row.action_pattern,
    approverAgentId: row.approver_agent_id ?? null,
    requireHuman: row.require_human === 1,
    minRisk: row.min_risk,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function upsertHierarchyBudgetPolicy(input: {
  id?: string;
  organizationId?: string | null;
  goalId?: string | null;
  agentId?: string | null;
  scope?: "organization" | "goal" | "agent" | "global" | string;
  softLimitUsd?: number | null;
  hardLimitUsd?: number | null;
  requireApprovalAboveUsd?: number | null;
  period?: string;
  isActive?: boolean;
}): HierarchyBudgetPolicy {
  const db = ensurePolicyTables();
  const now = new Date().toISOString();
  const id = input.id ?? nanoid(12);
  const existing = db.prepare("SELECT * FROM hierarchy_budget_policies WHERE id = ?").get(id) as BudgetRow | undefined;
  const scope = input.scope ?? existing?.scope ?? (input.agentId ? "agent" : input.goalId ? "goal" : input.organizationId ? "organization" : "global");
  db.prepare(`
    INSERT INTO hierarchy_budget_policies (
      id, organization_id, goal_id, agent_id, scope, soft_limit_usd, hard_limit_usd,
      require_approval_above_usd, period, is_active, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      organization_id = excluded.organization_id,
      goal_id = excluded.goal_id,
      agent_id = excluded.agent_id,
      scope = excluded.scope,
      soft_limit_usd = excluded.soft_limit_usd,
      hard_limit_usd = excluded.hard_limit_usd,
      require_approval_above_usd = excluded.require_approval_above_usd,
      period = excluded.period,
      is_active = excluded.is_active,
      updated_at = excluded.updated_at
  `).run(
    id,
    input.organizationId ?? existing?.organization_id ?? null,
    input.goalId ?? existing?.goal_id ?? null,
    input.agentId ?? existing?.agent_id ?? null,
    scope,
    input.softLimitUsd ?? existing?.soft_limit_usd ?? null,
    input.hardLimitUsd ?? existing?.hard_limit_usd ?? null,
    input.requireApprovalAboveUsd ?? existing?.require_approval_above_usd ?? null,
    input.period ?? existing?.period ?? "monthly",
    input.isActive === undefined ? existing?.is_active ?? 1 : input.isActive ? 1 : 0,
    existing?.created_at ?? now,
    now,
  );
  const policy = getHierarchyBudgetPolicy(id)!;
  recordHierarchyActivityEvent({
    organizationId: policy.organizationId,
    goalId: policy.goalId,
    agentId: policy.agentId,
    eventType: "budget_policy.updated",
    title: "Budget policy updated",
    summary: `${policy.scope} budget policy updated.`,
    status: policy.isActive ? "active" : "inactive",
    metadata: { policy },
  });
  return policy;
}

export function getHierarchyBudgetPolicy(id: string): HierarchyBudgetPolicy | null {
  const db = ensurePolicyTables();
  const row = db.prepare("SELECT * FROM hierarchy_budget_policies WHERE id = ?").get(id) as BudgetRow | undefined;
  return row ? mapBudget(row) : null;
}

export function listHierarchyBudgetPolicies(input?: {
  organizationId?: string | null;
  goalId?: string | null;
  agentId?: string | null;
  scope?: string | null;
  includeInactive?: boolean;
}): HierarchyBudgetPolicy[] {
  const db = ensurePolicyTables();
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (!input?.includeInactive) clauses.push("is_active = 1");
  if (input?.organizationId) { clauses.push("organization_id = ?"); values.push(input.organizationId); }
  if (input?.goalId) { clauses.push("goal_id = ?"); values.push(input.goalId); }
  if (input?.agentId) { clauses.push("agent_id = ?"); values.push(input.agentId); }
  if (input?.scope) { clauses.push("scope = ?"); values.push(input.scope); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db.prepare(`SELECT * FROM hierarchy_budget_policies ${where} ORDER BY updated_at DESC`).all(...values) as BudgetRow[];
  return rows.map(mapBudget);
}

export function resolveHierarchyBudgetPolicy(input: {
  organizationId?: string | null;
  goalId?: string | null;
  agentId?: string | null;
}): HierarchyBudgetPolicy | null {
  const candidates = [
    ...listHierarchyBudgetPolicies({ agentId: input.agentId }),
    ...listHierarchyBudgetPolicies({ goalId: input.goalId }),
    ...listHierarchyBudgetPolicies({ organizationId: input.organizationId }),
    ...listHierarchyBudgetPolicies({}),
  ];
  return candidates.find((policy) =>
    (policy.agentId && policy.agentId === input.agentId) ||
    (policy.goalId && policy.goalId === input.goalId) ||
    (policy.organizationId && policy.organizationId === input.organizationId) ||
    policy.scope === "global"
  ) ?? null;
}

export function evaluateHierarchyBudget(input: {
  organizationId?: string | null;
  goalId?: string | null;
  agentId?: string | null;
  estimatedCostUsd?: number | null;
  currentSpendUsd?: number | null;
}): {
  policy: HierarchyBudgetPolicy | null;
  allowed: boolean;
  requiresApproval: boolean;
  warning: boolean;
  reason: string | null;
} {
  const policy = resolveHierarchyBudgetPolicy(input);
  if (!policy) return { policy: null, allowed: true, requiresApproval: false, warning: false, reason: null };
  const estimated = Number(input.estimatedCostUsd ?? 0);
  const current = Number(input.currentSpendUsd ?? 0);
  const total = current + estimated;
  if (policy.hardLimitUsd !== null && total >= policy.hardLimitUsd) {
    recordHierarchyActivityEvent({
      organizationId: input.organizationId ?? policy.organizationId,
      goalId: input.goalId ?? policy.goalId,
      agentId: input.agentId ?? policy.agentId,
      eventType: "budget.blocked",
      title: "Budget hard limit blocked action",
      summary: `Estimated spend $${total.toFixed(4)} reached hard limit $${policy.hardLimitUsd.toFixed(2)}.`,
      status: "blocked",
      costUsd: estimated,
      metadata: { policyId: policy.id, currentSpendUsd: current },
    });
    return { policy, allowed: false, requiresApproval: false, warning: false, reason: "Budget hard limit reached." };
  }
  if (policy.requireApprovalAboveUsd !== null && estimated >= policy.requireApprovalAboveUsd) {
    return { policy, allowed: true, requiresApproval: true, warning: false, reason: "Estimated cost requires approval." };
  }
  if (policy.softLimitUsd !== null && total >= policy.softLimitUsd) {
    recordHierarchyActivityEvent({
      organizationId: input.organizationId ?? policy.organizationId,
      goalId: input.goalId ?? policy.goalId,
      agentId: input.agentId ?? policy.agentId,
      eventType: "budget.warning",
      title: "Budget soft limit warning",
      summary: `Estimated spend $${total.toFixed(4)} reached soft limit $${policy.softLimitUsd.toFixed(2)}.`,
      status: "warning",
      costUsd: estimated,
      metadata: { policyId: policy.id, currentSpendUsd: current },
    });
    return { policy, allowed: true, requiresApproval: true, warning: true, reason: "Budget soft limit reached." };
  }
  return { policy, allowed: true, requiresApproval: false, warning: false, reason: null };
}

export type HierarchyBudgetGateResult = {
  policyId: string | null;
  allowed: boolean;
  requiresApproval: boolean;
  warning: boolean;
  reason: string | null;
  /** User-facing message when blocked or approval is required; null when clear. */
  message: string | null;
};

/**
 * Enforcement wrapper around {@link evaluateHierarchyBudget}. Use this at
 * execution entry points (council runs, organization execution, expensive
 * workflow/agent-tool runs) where an org/goal/agent scope is known.
 *
 * - Records `budget.warning` / `budget.blocked` ledger events (via evaluate).
 * - Records a pending `budget.approval_required` ledger event so it surfaces in
 *   Hierarchy activity/approvals when approval is needed.
 * - Returns a clear `message` to relay to the user when blocked or pending.
 */
export function enforceHierarchyBudgetGate(input: {
  organizationId?: string | null;
  goalId?: string | null;
  agentId?: string | null;
  estimatedCostUsd?: number | null;
  currentSpendUsd?: number | null;
  action?: string;
}): HierarchyBudgetGateResult {
  const evaluation = evaluateHierarchyBudget(input);
  const action = input.action ?? "this action";

  if (!evaluation.allowed) {
    return {
      policyId: evaluation.policy?.id ?? null,
      allowed: false,
      requiresApproval: false,
      warning: false,
      reason: evaluation.reason,
      message: `Blocked: ${action} would exceed the budget hard limit${evaluation.policy?.hardLimitUsd != null ? ` ($${evaluation.policy.hardLimitUsd.toFixed(2)})` : ""}. Raise the limit or reduce scope.`,
    };
  }

  if (evaluation.requiresApproval) {
    recordHierarchyActivityEvent({
      organizationId: input.organizationId ?? evaluation.policy?.organizationId ?? null,
      goalId: input.goalId ?? evaluation.policy?.goalId ?? null,
      agentId: input.agentId ?? evaluation.policy?.agentId ?? null,
      eventType: "budget.approval_required",
      title: "Budget approval required",
      summary: `${action} needs approval before running (estimated $${Number(input.estimatedCostUsd ?? 0).toFixed(4)}).`,
      status: "pending",
      costUsd: Number(input.estimatedCostUsd ?? 0),
      metadata: { policyId: evaluation.policy?.id ?? null, warning: evaluation.warning },
    });
    return {
      policyId: evaluation.policy?.id ?? null,
      allowed: true,
      requiresApproval: true,
      warning: evaluation.warning,
      reason: evaluation.reason,
      message: `Approval required before running ${action}${evaluation.warning ? " (soft budget limit reached)" : ""}. It has been queued for approval in Hierarchy activity.`,
    };
  }

  return {
    policyId: evaluation.policy?.id ?? null,
    allowed: true,
    requiresApproval: false,
    warning: false,
    reason: null,
    message: null,
  };
}

export function upsertHierarchyApprovalPolicy(input: {
  id?: string;
  organizationId?: string | null;
  scope?: string;
  actionPattern?: string;
  approverAgentId?: string | null;
  requireHuman?: boolean;
  minRisk?: string;
  isActive?: boolean;
}): HierarchyApprovalPolicy {
  const db = ensurePolicyTables();
  const now = new Date().toISOString();
  const id = input.id ?? nanoid(12);
  const existing = db.prepare("SELECT * FROM hierarchy_approval_policies WHERE id = ?").get(id) as ApprovalRow | undefined;
  db.prepare(`
    INSERT INTO hierarchy_approval_policies (
      id, organization_id, scope, action_pattern, approver_agent_id, require_human, min_risk, is_active, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      organization_id = excluded.organization_id,
      scope = excluded.scope,
      action_pattern = excluded.action_pattern,
      approver_agent_id = excluded.approver_agent_id,
      require_human = excluded.require_human,
      min_risk = excluded.min_risk,
      is_active = excluded.is_active,
      updated_at = excluded.updated_at
  `).run(
    id,
    input.organizationId ?? existing?.organization_id ?? null,
    input.scope ?? existing?.scope ?? "organization",
    input.actionPattern ?? existing?.action_pattern ?? "*",
    input.approverAgentId ?? existing?.approver_agent_id ?? null,
    input.requireHuman === undefined ? existing?.require_human ?? 0 : input.requireHuman ? 1 : 0,
    input.minRisk ?? existing?.min_risk ?? "medium",
    input.isActive === undefined ? existing?.is_active ?? 1 : input.isActive ? 1 : 0,
    existing?.created_at ?? now,
    now,
  );
  const policy = getHierarchyApprovalPolicy(id)!;
  recordHierarchyActivityEvent({
    organizationId: policy.organizationId,
    eventType: "approval_policy.updated",
    title: "Approval policy updated",
    summary: `${policy.scope} approval policy updated.`,
    status: policy.isActive ? "active" : "inactive",
    metadata: { policy },
  });
  return policy;
}

export function getHierarchyApprovalPolicy(id: string): HierarchyApprovalPolicy | null {
  const db = ensurePolicyTables();
  const row = db.prepare("SELECT * FROM hierarchy_approval_policies WHERE id = ?").get(id) as ApprovalRow | undefined;
  return row ? mapApproval(row) : null;
}

export function listHierarchyApprovalPolicies(input?: {
  organizationId?: string | null;
  scope?: string | null;
  includeInactive?: boolean;
}): HierarchyApprovalPolicy[] {
  const db = ensurePolicyTables();
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (!input?.includeInactive) clauses.push("is_active = 1");
  if (input?.organizationId) { clauses.push("organization_id = ?"); values.push(input.organizationId); }
  if (input?.scope) { clauses.push("scope = ?"); values.push(input.scope); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db.prepare(`SELECT * FROM hierarchy_approval_policies ${where} ORDER BY updated_at DESC`).all(...values) as ApprovalRow[];
  return rows.map(mapApproval);
}
