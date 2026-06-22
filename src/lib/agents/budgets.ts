import { getSqlite, initializeDatabase, withSqliteWriteRecovery } from "@/lib/db";
import type { AgentRecord } from "@/lib/agents/registry";
import { logger } from "@/lib/utils/logger";

export type AgentBudgetSummary = {
  agentId: string;
  spendCapUsd: number | null;
  spendWindowDays: number;
  budgetAction: "warn" | "block";
  spentUsd: number;
  remainingUsd: number | null;
  usagePercent: number | null;
  recentCalls: number;
  lastSpendAt: string | null;
  overCap: boolean;
  warningLevel: "ok" | "near" | "over";
};

type AgentSpendEvent = {
  agentId: string;
  provider: string;
  modelId: string;
  source: string;
  referenceId?: string | null;
  tokensUsed?: number;
  costUsd?: number;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  taskId?: string | null;
  goalId?: string | null;
  billingCode?: string | null;
};

function ensureAgentSpendEventsTable() {
  initializeDatabase();
  const db = getSqlite();
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_spend_events (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      model_id TEXT NOT NULL,
      source TEXT NOT NULL,
      reference_id TEXT,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      metadata TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_agent_spend_events_agent_time
      ON agent_spend_events(agent_id, created_at DESC);
  `);
  const colRows = db.prepare("PRAGMA table_info(agent_spend_events)").all() as Array<{ name: string }>;
  const cols = new Set(colRows.map((row) => row.name));
  if (!cols.has("task_id")) db.exec("ALTER TABLE agent_spend_events ADD COLUMN task_id TEXT");
  if (!cols.has("goal_id")) db.exec("ALTER TABLE agent_spend_events ADD COLUMN goal_id TEXT");
  if (!cols.has("billing_code")) db.exec("ALTER TABLE agent_spend_events ADD COLUMN billing_code TEXT");
  if (!cols.has("entity_type")) db.exec("ALTER TABLE agent_spend_events ADD COLUMN entity_type TEXT");
  if (!cols.has("entity_id")) db.exec("ALTER TABLE agent_spend_events ADD COLUMN entity_id TEXT");
  return db;
}

function clampMoney(value: number): number {
  return Number(value.toFixed(6));
}

function safeParseMetadata(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Ignore parse errors.
  }
  return {};
}

function windowStartIso(days: number): string {
  const start = new Date();
  start.setUTCDate(start.getUTCDate() - Math.max(0, days - 1));
  start.setUTCHours(0, 0, 0, 0);
  return start.toISOString();
}

function summarizeAgent(agent: AgentRecord): AgentBudgetSummary {
  const db = ensureAgentSpendEventsTable();
  const windowIso = windowStartIso(agent.spendWindowDays);
  const row = db
    .prepare(
      `
        SELECT
          COUNT(*) AS recent_calls,
          COALESCE(SUM(cost_usd), 0) AS spent_usd,
          MAX(created_at) AS last_spend_at
        FROM agent_spend_events
        WHERE agent_id = ? AND created_at >= ?
      `,
    )
    .get(agent.id, windowIso) as
    | { recent_calls: number; spent_usd: number; last_spend_at: string | null }
    | undefined;

  const spentUsd = clampMoney(Number(row?.spent_usd || 0));
  const cap = agent.spendCapUsd;
  const remainingUsd = cap === null ? null : clampMoney(Math.max(0, cap - spentUsd));
  const usagePercent =
    cap === null || cap <= 0 ? null : Number(Math.min(999.9, (spentUsd / cap) * 100).toFixed(1));
  const overCap = cap !== null ? spentUsd >= cap : false;
  const warningLevel: AgentBudgetSummary["warningLevel"] =
    overCap ? "over" : usagePercent !== null && usagePercent >= 80 ? "near" : "ok";

  return {
    agentId: agent.id,
    spendCapUsd: cap,
    spendWindowDays: agent.spendWindowDays,
    budgetAction: agent.budgetAction,
    spentUsd,
    remainingUsd,
    usagePercent,
    recentCalls: Number(row?.recent_calls || 0),
    lastSpendAt: row?.last_spend_at || null,
    overCap,
    warningLevel,
  };
}

export type MonthlyBudgetResult = {
  budgetExceeded: boolean;
  agentPaused: boolean;
  budgetWarning: boolean;
  spentPercent: number | null;
  message: string | null;
};

export function recordAgentSpendEvent(event: AgentSpendEvent): MonthlyBudgetResult | null {
  const db = ensureAgentSpendEventsTable();
  const createdAt = event.createdAt || new Date().toISOString();
  const id = `${event.agentId}:${event.source}:${event.referenceId || createdAt}:${createdAt}`;
  withSqliteWriteRecovery("agent spend event", (database) =>
    database
      .prepare(
        `
          INSERT OR REPLACE INTO agent_spend_events
            (id, agent_id, provider, model_id, source, reference_id, tokens_used, cost_usd, metadata, created_at,
             task_id, goal_id, billing_code, entity_type, entity_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            CASE WHEN ? IS NOT NULL THEN 'task' ELSE NULL END,
            ?)
        `,
      )
      .run(
        id,
        event.agentId,
        event.provider || "unknown",
        event.modelId || "unknown",
        event.source || "workflow",
        event.referenceId || null,
        Math.max(0, Math.round(Number(event.tokensUsed || 0))),
        Math.max(0, Number(event.costUsd || 0)),
        JSON.stringify(event.metadata || {}),
        createdAt,
        event.taskId ?? null,
        event.goalId ?? null,
        event.billingCode ?? null,
        event.taskId ?? null,
        event.taskId ?? null,
      ),
  );

  // Update monthly budget tracking on the agents table
  let monthlyResult: MonthlyBudgetResult | null = null;
  if (event.costUsd && event.costUsd > 0) {
    monthlyResult = updateAgentMonthlySpend(event.agentId, event.costUsd);
  }

  void db;
  return monthlyResult;
}

function updateAgentMonthlySpend(agentId: string, costUsd: number): MonthlyBudgetResult {
  try {
    const db = getSqlite();
    const costCents = Math.round(costUsd * 100);

    const agent = db.prepare(
      "SELECT budget_monthly_cents, spent_monthly_cents, budget_reset_at, is_active FROM agents WHERE id = ?",
    ).get(agentId) as { budget_monthly_cents: number | null; spent_monthly_cents: number | null; budget_reset_at: string | null; is_active: number } | undefined;

    if (!agent) return { budgetExceeded: false, agentPaused: false, budgetWarning: false, spentPercent: null, message: null };

    if (agent.budget_reset_at) {
      const resetDate = new Date(agent.budget_reset_at);
      if (new Date() >= resetDate) {
        db.prepare(
          "UPDATE agents SET spent_monthly_cents = ?, budget_reset_at = datetime('now', '+1 month') WHERE id = ?",
        ).run(costCents, agentId);
        return { budgetExceeded: false, agentPaused: false, budgetWarning: false, spentPercent: null, message: null };
      }
    } else if (agent.budget_monthly_cents) {
      db.prepare(
        "UPDATE agents SET budget_reset_at = datetime('now', '+1 month') WHERE id = ? AND budget_reset_at IS NULL",
      ).run(agentId);
    }

    db.prepare(
      "UPDATE agents SET spent_monthly_cents = COALESCE(spent_monthly_cents, 0) + ? WHERE id = ?",
    ).run(costCents, agentId);

    const updated = db.prepare(
      "SELECT budget_monthly_cents, spent_monthly_cents, is_active FROM agents WHERE id = ?",
    ).get(agentId) as { budget_monthly_cents: number | null; spent_monthly_cents: number; is_active: number } | undefined;

    if (!updated || !updated.budget_monthly_cents) {
      return { budgetExceeded: false, agentPaused: false, budgetWarning: false, spentPercent: null, message: null };
    }

    const spentPercent = updated.budget_monthly_cents > 0
      ? Math.round((updated.spent_monthly_cents / updated.budget_monthly_cents) * 100)
      : 0;

    if (updated.spent_monthly_cents >= updated.budget_monthly_cents) {
      if (updated.is_active) {
        db.prepare("UPDATE agents SET is_active = 0 WHERE id = ?").run(agentId);
        logger.warn("Agent auto-paused — budget exhausted", {
          agentId,
          spentCents: updated.spent_monthly_cents,
          budgetCents: updated.budget_monthly_cents,
        });
      }
      return {
        budgetExceeded: true,
        agentPaused: true,
        budgetWarning: false,
        spentPercent: Math.min(spentPercent, 999),
        message: `Agent auto-paused: spent ${(updated.spent_monthly_cents / 100).toFixed(2)} USD of ${(updated.budget_monthly_cents / 100).toFixed(2)} USD monthly budget`,
      };
    }

    if (spentPercent >= 80) {
      return {
        budgetExceeded: false,
        agentPaused: false,
        budgetWarning: true,
        spentPercent,
        message: `Agent budget at ${spentPercent}%: ${(updated.spent_monthly_cents / 100).toFixed(2)} / ${(updated.budget_monthly_cents / 100).toFixed(2)} USD`,
      };
    }

    return { budgetExceeded: false, agentPaused: false, budgetWarning: false, spentPercent, message: null };
  } catch {
    return { budgetExceeded: false, agentPaused: false, budgetWarning: false, spentPercent: null, message: null };
  }
}

export type GoalSpendSummary = {
  goalId: string;
  totalCostUsd: number;
  totalTokens: number;
  eventCount: number;
  agentBreakdown: Array<{ agentId: string; costUsd: number; tokens: number; calls: number }>;
  lastSpendAt: string | null;
};

export function getSpendByGoal(goalId: string, windowDays = 30): GoalSpendSummary {
  const db = ensureAgentSpendEventsTable();
  const windowIso = windowStartIso(windowDays);
  const summary = db.prepare(
    `SELECT COALESCE(SUM(cost_usd), 0) AS total_cost, COALESCE(SUM(tokens_used), 0) AS total_tokens,
            COUNT(*) AS event_count, MAX(created_at) AS last_spend_at
     FROM agent_spend_events WHERE goal_id = ? AND created_at >= ?`
  ).get(goalId, windowIso) as { total_cost: number; total_tokens: number; event_count: number; last_spend_at: string | null };

  const breakdown = db.prepare(
    `SELECT agent_id, COALESCE(SUM(cost_usd), 0) AS cost_usd,
            COALESCE(SUM(tokens_used), 0) AS tokens, COUNT(*) AS calls
     FROM agent_spend_events WHERE goal_id = ? AND created_at >= ?
     GROUP BY agent_id ORDER BY cost_usd DESC LIMIT 20`
  ).all(goalId, windowIso) as Array<{ agent_id: string; cost_usd: number; tokens: number; calls: number }>;

  return {
    goalId,
    totalCostUsd: clampMoney(Number(summary.total_cost || 0)),
    totalTokens: Number(summary.total_tokens || 0),
    eventCount: Number(summary.event_count || 0),
    agentBreakdown: breakdown.map(r => ({
      agentId: r.agent_id,
      costUsd: clampMoney(Number(r.cost_usd || 0)),
      tokens: Number(r.tokens || 0),
      calls: Number(r.calls || 0),
    })),
    lastSpendAt: summary.last_spend_at,
  };
}

export function getAgentBudgetSummary(agent: AgentRecord): AgentBudgetSummary {
  return summarizeAgent(agent);
}

export function getAgentBudgetSummaries(agents: AgentRecord[]): Record<string, AgentBudgetSummary> {
  const output: Record<string, AgentBudgetSummary> = {};
  for (const agent of agents) {
    output[agent.id] = summarizeAgent(agent);
  }
  return output;
}

export function getAgentBudgetDecision(agent: AgentRecord): {
  allowed: boolean;
  summary: AgentBudgetSummary;
  message: string | null;
} {
  const summary = summarizeAgent(agent);
  if (!summary.overCap) {
    return { allowed: true, summary, message: null };
  }

  const capText = summary.spendCapUsd === null ? "unlimited" : `$${summary.spendCapUsd.toFixed(2)}`;
  const spentText = `$${summary.spentUsd.toFixed(4)}`;
  const message =
    `Agent budget ${summary.budgetAction === "block" ? "limit reached" : "warning"}: ` +
    `${spentText} spent in the last ${summary.spendWindowDays} day(s) against ${capText}.`;

  return {
    allowed: summary.budgetAction !== "block",
    summary,
    message,
  };
}

export type AgentCostSummary = {
  agentId: string;
  totalCostUsd: number;
  totalTokens: number;
  eventCount: number;
  lastSpendAt: string | null;
};

export type CostAnalyticsSummary = {
  totalCostUsd: number;
  totalTokens: number;
  eventCount: number;
  byAgent: AgentCostSummary[];
  byGoal: Array<{ goalId: string; costUsd: number; tokens: number; calls: number }>;
  byDay: Array<{ date: string; costUsd: number; tokens: number }>;
};

export function getCostAnalytics(windowDays: number): CostAnalyticsSummary {
  const db = ensureAgentSpendEventsTable();
  const windowIso = windowStartIso(windowDays);

  const total = db
    .prepare(
      `SELECT COALESCE(SUM(cost_usd),0) AS total_cost, COALESCE(SUM(tokens_used),0) AS total_tokens, COUNT(*) AS event_count
       FROM agent_spend_events WHERE created_at >= ?`,
    )
    .get(windowIso) as { total_cost: number; total_tokens: number; event_count: number };

  const byAgent = db
    .prepare(
      `SELECT agent_id, COALESCE(SUM(cost_usd),0) AS total_cost, COALESCE(SUM(tokens_used),0) AS total_tokens,
              COUNT(*) AS event_count, MAX(created_at) AS last_spend_at
       FROM agent_spend_events WHERE created_at >= ?
       GROUP BY agent_id ORDER BY total_cost DESC LIMIT 50`,
    )
    .all(windowIso) as Array<{
    agent_id: string;
    total_cost: number;
    total_tokens: number;
    event_count: number;
    last_spend_at: string | null;
  }>;

  const byGoal = db
    .prepare(
      `SELECT goal_id, COALESCE(SUM(cost_usd),0) AS cost_usd, COALESCE(SUM(tokens_used),0) AS tokens, COUNT(*) AS calls
       FROM agent_spend_events WHERE created_at >= ? AND goal_id IS NOT NULL
       GROUP BY goal_id ORDER BY cost_usd DESC LIMIT 20`,
    )
    .all(windowIso) as Array<{ goal_id: string; cost_usd: number; tokens: number; calls: number }>;

  const byDay = db
    .prepare(
      `SELECT DATE(created_at) AS date, COALESCE(SUM(cost_usd),0) AS cost_usd, COALESCE(SUM(tokens_used),0) AS tokens
       FROM agent_spend_events WHERE created_at >= ?
       GROUP BY DATE(created_at) ORDER BY date ASC`,
    )
    .all(windowIso) as Array<{ date: string; cost_usd: number; tokens: number }>;

  return {
    totalCostUsd: clampMoney(Number(total.total_cost || 0)),
    totalTokens: Number(total.total_tokens || 0),
    eventCount: Number(total.event_count || 0),
    byAgent: byAgent.map((r) => ({
      agentId: r.agent_id,
      totalCostUsd: clampMoney(Number(r.total_cost || 0)),
      totalTokens: Number(r.total_tokens || 0),
      eventCount: Number(r.event_count || 0),
      lastSpendAt: r.last_spend_at,
    })),
    byGoal: byGoal.map((r) => ({
      goalId: r.goal_id,
      costUsd: clampMoney(Number(r.cost_usd || 0)),
      tokens: Number(r.tokens || 0),
      calls: Number(r.calls || 0),
    })),
    byDay: byDay.map((r) => ({
      date: r.date,
      costUsd: clampMoney(Number(r.cost_usd || 0)),
      tokens: Number(r.tokens || 0),
    })),
  };
}

export function listAgentSpendEvents(agentId: string, limit = 20): Array<Record<string, unknown>> {
  const db = ensureAgentSpendEventsTable();
  const rows = db
    .prepare(
      `
        SELECT provider, model_id, source, reference_id, tokens_used, cost_usd, metadata, created_at
        FROM agent_spend_events
        WHERE agent_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      `,
    )
    .all(agentId, Math.max(1, Math.min(100, Math.floor(limit)))) as Array<{
      provider: string;
      model_id: string;
      source: string;
      reference_id: string | null;
      tokens_used: number;
      cost_usd: number;
      metadata: string | null;
      created_at: string;
    }>;

  return rows.map((row) => ({
    provider: row.provider,
    modelId: row.model_id,
    source: row.source,
    referenceId: row.reference_id,
    tokensUsed: row.tokens_used,
    costUsd: clampMoney(Number(row.cost_usd || 0)),
    metadata: safeParseMetadata(row.metadata),
    createdAt: row.created_at,
  }));
}
