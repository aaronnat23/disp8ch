import { getSqlite, initializeDatabase } from "@/lib/db";
import { recordTelemetryEvent } from "@/lib/telemetry";
import { broadcastEvent } from "@/lib/ws/broadcast";
import type { ApprovalPolicy, NodeApprovalChoice, NodeResult, WorkflowApprovalMode, WorkflowPolicy } from "@/types/execution";

type UsageRow = {
  run_count: number;
  cost_usd: number;
  notification_count: number;
};

export type WorkflowPolicyDecision =
  | { allowed: true; policy: WorkflowPolicy | null; dayKey: string }
  | {
      allowed: false;
      policy: WorkflowPolicy;
      dayKey: string;
      reason: "run-cap" | "cost-cap";
      message: string;
      usage: { runCount: number; costUsd: number };
    };

function positiveNumber(value: unknown, integer = false): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return integer ? Math.max(1, Math.floor(parsed)) : parsed;
}

function timeString(value: unknown): string | null {
  const text = String(value || "").trim();
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(text) ? text : null;
}

export function normalizeWorkflowPolicy(raw: unknown): WorkflowPolicy | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const budgetRaw = value.budget && typeof value.budget === "object" && !Array.isArray(value.budget)
    ? value.budget as Record<string, unknown>
    : {};
  const escalationRaw = value.escalation && typeof value.escalation === "object" && !Array.isArray(value.escalation)
    ? value.escalation as Record<string, unknown>
    : {};
  const quietRaw = escalationRaw.quietHours && typeof escalationRaw.quietHours === "object" && !Array.isArray(escalationRaw.quietHours)
    ? escalationRaw.quietHours as Record<string, unknown>
    : null;
  const quietStart = quietRaw ? timeString(quietRaw.start) : null;
  const quietEnd = quietRaw ? timeString(quietRaw.end) : null;

  const budget = {
    maxRunsPerDay: positiveNumber(budgetRaw.maxRunsPerDay, true),
    maxCostPerDayUsd: positiveNumber(budgetRaw.maxCostPerDayUsd),
    autoDisable: Boolean(budgetRaw.autoDisable),
  };
  const escalation = {
    onFailure: Boolean(escalationRaw.onFailure),
    onBudgetBlocked: Boolean(escalationRaw.onBudgetBlocked),
    maxNotificationsPerDay: positiveNumber(escalationRaw.maxNotificationsPerDay, true),
    quietHours: quietStart && quietEnd
      ? {
          start: quietStart,
          end: quietEnd,
          timezone: String(quietRaw?.timezone || "").trim() || null,
        }
      : null,
  };

  const approval = normalizeApprovalPolicy(value.approval);

  const hasBudget = budget.maxRunsPerDay !== null || budget.maxCostPerDayUsd !== null || budget.autoDisable;
  const hasEscalation = escalation.onFailure || escalation.onBudgetBlocked ||
    escalation.maxNotificationsPerDay !== null || escalation.quietHours !== null;
  return hasBudget || hasEscalation || approval
    ? {
        budget: hasBudget ? budget : null,
        escalation: hasEscalation ? escalation : null,
        approval,
      }
    : null;
}

const APPROVAL_MODES: WorkflowApprovalMode[] = ["balanced", "strict", "custom"];
const NODE_CHOICES: NodeApprovalChoice[] = ["auto", "human", "deny"];

export function normalizeApprovalPolicy(raw: unknown): ApprovalPolicy | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const mode = APPROVAL_MODES.includes(value.mode as WorkflowApprovalMode)
    ? (value.mode as WorkflowApprovalMode)
    : null;
  let nodes: Record<string, NodeApprovalChoice> | undefined;
  if (value.nodes && typeof value.nodes === "object" && !Array.isArray(value.nodes)) {
    const entries: Record<string, NodeApprovalChoice> = {};
    for (const [nodeId, choice] of Object.entries(value.nodes as Record<string, unknown>)) {
      const id = String(nodeId || "").trim();
      if (id && NODE_CHOICES.includes(choice as NodeApprovalChoice)) {
        entries[id] = choice as NodeApprovalChoice;
      }
    }
    if (Object.keys(entries).length > 0) nodes = entries;
  }
  if (!mode && !nodes) return null;
  return { mode: mode ?? "balanced", nodes };
}

/**
 * Reads the explicit approval policy for a workflow id, or null when the
 * workflow has none. A null result means "legacy / compat" — the executor guard
 * still enforces the hardline floor, unknown-deny, and the unattended
 * destructive floor, but does not require interactive approval for ordinary
 * sends/writes so existing workflows keep working.
 */
export function getWorkflowApprovalPolicyOrNull(workflowId: string): ApprovalPolicy | null {
  try {
    initializeDatabase();
    const db = getSqlite();
    const row = db.prepare("SELECT policy FROM workflows WHERE id = ?").get(workflowId) as { policy: string | null } | undefined;
    const policy = parsePolicy(row?.policy);
    return policy?.approval ?? null;
  } catch {
    return null;
  }
}

/** Reads the effective approval policy for a workflow id, defaulting to balanced. */
export function getWorkflowApprovalPolicy(workflowId: string): ApprovalPolicy {
  return getWorkflowApprovalPolicyOrNull(workflowId) ?? { mode: "balanced" };
}

function parsePolicy(raw: string | null | undefined): WorkflowPolicy | null {
  if (!raw) return null;
  try {
    return normalizeWorkflowPolicy(JSON.parse(raw));
  } catch {
    return null;
  }
}

function localDateParts(date: Date, timezone?: string | null) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone || undefined,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return {
      dayKey: `${values.year}-${values.month}-${values.day}`,
      minuteOfDay: Number(values.hour) * 60 + Number(values.minute),
    };
  } catch {
    return {
      dayKey: date.toISOString().slice(0, 10),
      minuteOfDay: date.getUTCHours() * 60 + date.getUTCMinutes(),
    };
  }
}

function usageRow(workflowId: string, dayKey: string): UsageRow {
  const db = getSqlite();
  return (db.prepare(
    "SELECT run_count, cost_usd, notification_count FROM workflow_policy_usage WHERE workflow_id = ? AND day_key = ?",
  ).get(workflowId, dayKey) as UsageRow | undefined) ?? {
    run_count: 0,
    cost_usd: 0,
    notification_count: 0,
  };
}

export function reserveWorkflowPolicyRun(workflowId: string, now = new Date()): WorkflowPolicyDecision {
  initializeDatabase();
  const db = getSqlite();
  const row = db.prepare("SELECT policy FROM workflows WHERE id = ?").get(workflowId) as { policy: string | null } | undefined;
  const policy = parsePolicy(row?.policy);
  const timezone = policy?.escalation?.quietHours?.timezone ?? null;
  const { dayKey } = localDateParts(now, timezone);
  if (!policy?.budget) return { allowed: true, policy, dayKey };

  return db.transaction((): WorkflowPolicyDecision => {
    const usage = usageRow(workflowId, dayKey);
    const runCap = policy.budget?.maxRunsPerDay ?? null;
    const costCap = policy.budget?.maxCostPerDayUsd ?? null;
    let reason: "run-cap" | "cost-cap" | null = null;
    if (runCap !== null && usage.run_count >= runCap) reason = "run-cap";
    else if (costCap !== null && usage.cost_usd >= costCap) reason = "cost-cap";

    if (reason) {
      if (policy.budget?.autoDisable) {
        db.prepare("UPDATE workflows SET is_active = 0, updated_at = ? WHERE id = ?").run(now.toISOString(), workflowId);
      }
      const message = reason === "run-cap"
        ? `Workflow daily run limit reached (${usage.run_count}/${runCap}).`
        : `Workflow daily cost limit reached ($${usage.cost_usd.toFixed(4)}/$${costCap?.toFixed(4)}).`;
      return {
        allowed: false,
        policy,
        dayKey,
        reason,
        message,
        usage: { runCount: usage.run_count, costUsd: usage.cost_usd },
      };
    }

    db.prepare(`
      INSERT INTO workflow_policy_usage (workflow_id, day_key, run_count, cost_usd, notification_count, updated_at)
      VALUES (?, ?, 1, 0, 0, ?)
      ON CONFLICT(workflow_id, day_key) DO UPDATE SET
        run_count = run_count + 1,
        updated_at = excluded.updated_at
    `).run(workflowId, dayKey, now.toISOString());
    return { allowed: true, policy, dayKey };
  })();
}

function resultCost(nodeResults: Record<string, NodeResult>): number {
  return Object.values(nodeResults).reduce((sum, result) => {
    const output = result.output ?? {};
    const raw = Number(output.costUsd ?? output.cost_usd ?? output.cost ?? 0);
    return sum + (Number.isFinite(raw) && raw > 0 ? raw : 0);
  }, 0);
}

export function recordWorkflowPolicyCompletion(input: {
  workflowId: string;
  dayKey: string;
  nodeResults: Record<string, NodeResult>;
  completedAt?: Date;
}) {
  const costUsd = resultCost(input.nodeResults);
  if (costUsd <= 0) return 0;
  initializeDatabase();
  const db = getSqlite();
  const now = (input.completedAt ?? new Date()).toISOString();
  db.prepare(`
    INSERT INTO workflow_policy_usage (workflow_id, day_key, run_count, cost_usd, notification_count, updated_at)
    VALUES (?, ?, 0, ?, 0, ?)
    ON CONFLICT(workflow_id, day_key) DO UPDATE SET
      cost_usd = cost_usd + excluded.cost_usd,
      updated_at = excluded.updated_at
  `).run(input.workflowId, input.dayKey, costUsd, now);
  return costUsd;
}

function isQuietNow(policy: WorkflowPolicy, now: Date): boolean {
  const quiet = policy.escalation?.quietHours;
  if (!quiet) return false;
  const { minuteOfDay } = localDateParts(now, quiet.timezone);
  const [startHour, startMinute] = quiet.start.split(":").map(Number);
  const [endHour, endMinute] = quiet.end.split(":").map(Number);
  const start = startHour * 60 + startMinute;
  const end = endHour * 60 + endMinute;
  if (start === end) return true;
  return start < end
    ? minuteOfDay >= start && minuteOfDay < end
    : minuteOfDay >= start || minuteOfDay < end;
}

export function escalateWorkflowPolicy(input: {
  workflowId: string;
  executionId: string;
  policy: WorkflowPolicy | null;
  dayKey: string;
  condition: "failure" | "budget-blocked";
  message: string;
  now?: Date;
}): boolean {
  const escalation = input.policy?.escalation;
  if (!escalation) return false;
  if (input.condition === "failure" && !escalation.onFailure) return false;
  if (input.condition === "budget-blocked" && !escalation.onBudgetBlocked) return false;
  const now = input.now ?? new Date();
  if (isQuietNow(input.policy!, now)) return false;

  initializeDatabase();
  const db = getSqlite();
  const sent = db.transaction(() => {
    const usage = usageRow(input.workflowId, input.dayKey);
    const cap = escalation.maxNotificationsPerDay ?? null;
    if (cap !== null && usage.notification_count >= cap) return false;
    db.prepare(`
      INSERT INTO workflow_policy_usage (workflow_id, day_key, run_count, cost_usd, notification_count, updated_at)
      VALUES (?, ?, 0, 0, 1, ?)
      ON CONFLICT(workflow_id, day_key) DO UPDATE SET
        notification_count = notification_count + 1,
        updated_at = excluded.updated_at
    `).run(input.workflowId, input.dayKey, now.toISOString());
    return true;
  })();
  if (!sent) return false;

  const data = {
    workflowId: input.workflowId,
    executionId: input.executionId,
    condition: input.condition,
    message: input.message,
    createdAt: now.toISOString(),
  };
  broadcastEvent("workflow:policy:escalation", data);
  recordTelemetryEvent("workflow.policy_escalation", data);
  return true;
}

export function getWorkflowPolicyState(workflowId: string) {
  initializeDatabase();
  const db = getSqlite();
  const row = db.prepare("SELECT policy FROM workflows WHERE id = ?").get(workflowId) as { policy: string | null } | undefined;
  const policy = parsePolicy(row?.policy);
  const { dayKey } = localDateParts(new Date(), policy?.escalation?.quietHours?.timezone);
  const usage = usageRow(workflowId, dayKey);
  return {
    policy,
    dayKey,
    usage: {
      runCount: usage.run_count,
      costUsd: usage.cost_usd,
      notificationCount: usage.notification_count,
    },
  };
}
