import { NextRequest, NextResponse } from "next/server";
import { getSqlite, initializeDatabase } from "@/lib/db";
import { requireOperatorAccess } from "@/lib/security/admin";

export const dynamic = "force-dynamic";

type DayPoint = {
  day: string;
  calls: number;
  tokens: number;
  costUsd: number;
};

type LeaderboardItem = {
  key: string;
  calls: number;
  tokens: number;
  costUsd: number;
};

type SpendRow = {
  agent_id: string;
  provider: string;
  model_id: string;
  source: string;
  tokens_used: number;
  cost_usd: number;
  created_at: string;
};

function clampDays(value: string | null): number {
  const parsed = Number(value ?? "14");
  if (!Number.isFinite(parsed)) return 14;
  return Math.min(60, Math.max(1, Math.floor(parsed)));
}

function toNumber(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return parsed;
}

function inferProviderFromModel(model: string): string {
  const lower = model.toLowerCase();
  if (lower.includes("gpt") || lower.includes("o1") || lower.includes("o3")) return "openai";
  if (lower.includes("claude")) return "anthropic";
  if (lower.includes("gemini")) return "google";
  if (lower.includes("llama") || lower.includes("qwen") || lower.includes("mistral")) return "ollama";
  return "unknown";
}

function buildDayKeys(days: number): string[] {
  const keys: string[] = [];
  const now = new Date();
  const midnightUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const day = new Date(midnightUtc - offset * 24 * 60 * 60 * 1000);
    keys.push(day.toISOString().slice(0, 10));
  }
  return keys;
}

function upsertMetric(
  target: Map<string, LeaderboardItem>,
  key: string,
  calls: number,
  tokens: number,
  costUsd: number,
) {
  const prev = target.get(key) ?? { key, calls: 0, tokens: 0, costUsd: 0 };
  prev.calls += calls;
  prev.tokens += tokens;
  prev.costUsd += costUsd;
  target.set(key, prev);
}

export async function GET(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    initializeDatabase();
    const db = getSqlite();
    const { searchParams } = new URL(request.url);
    const days = clampDays(searchParams.get("days"));
    const dayKeys = buildDayKeys(days);
    const daySet = new Set(dayKeys);

    const seriesMap = new Map<string, DayPoint>();
    for (const day of dayKeys) {
      seriesMap.set(day, { day, calls: 0, tokens: 0, costUsd: 0 });
    }

    const minDayIso = `${dayKeys[0]}T00:00:00.000Z`;
    const rows = db
      .prepare(
        "SELECT workflow_id, status, trigger_type, node_results, started_at FROM executions WHERE started_at >= ? ORDER BY started_at DESC",
      )
      .all(minDayIso) as Array<{
        workflow_id: string;
        status: string;
        trigger_type: string;
        node_results: string | null;
        started_at: string;
      }>;

    let executionTotal = 0;
    let executionCompleted = 0;
    let executionFailed = 0;

    const models = new Map<string, LeaderboardItem>();
    const providers = new Map<string, LeaderboardItem>();
    const workflows = new Map<string, LeaderboardItem>();

    let spendRows: SpendRow[] = [];
    try {
      spendRows = db
        .prepare(
          `SELECT agent_id, provider, model_id, source, tokens_used, cost_usd, created_at
             FROM agent_spend_events
            WHERE created_at >= ?
            ORDER BY created_at DESC`,
        )
        .all(minDayIso) as SpendRow[];
    } catch {
      spendRows = [];
    }

    for (const row of spendRows) {
      const day = String(row.created_at || "").slice(0, 10);
      if (!daySet.has(day)) continue;
      const tokensUsed = Math.max(0, Math.round(toNumber(row.tokens_used)));
      const costUsd = Math.max(0, toNumber(row.cost_usd));
      const provider = String(row.provider || "unknown").trim() || "unknown";
      const model = String(row.model_id || "unknown").trim() || "unknown";
      const point = seriesMap.get(day);
      if (!point) continue;
      point.calls += 1;
      point.tokens += tokensUsed;
      point.costUsd += costUsd;
      upsertMetric(providers, provider, 1, tokensUsed, costUsd);
      upsertMetric(models, model, 1, tokensUsed, costUsd);
    }

    for (const row of rows) {
      const day = String(row.started_at || "").slice(0, 10);
      if (!daySet.has(day)) continue;
      executionTotal += 1;
      if (row.status === "completed") executionCompleted += 1;
      if (row.status === "failed") executionFailed += 1;

      let parsedNodeResults: Record<string, unknown> = {};
      try {
        parsedNodeResults = row.node_results ? (JSON.parse(row.node_results) as Record<string, unknown>) : {};
      } catch {
        parsedNodeResults = {};
      }

      for (const nodeValue of Object.values(parsedNodeResults)) {
        if (!nodeValue || typeof nodeValue !== "object") continue;
        const nodeResult = nodeValue as { output?: Record<string, unknown> };
        const output = nodeResult.output ?? {};
        const model = String(output.model ?? "").trim();
        const providerRaw = String(output.provider ?? "").trim();
        const provider = providerRaw || (model ? inferProviderFromModel(model) : "unknown");
        const tokensIn = toNumber(output.tokensIn);
        const tokensOut = toNumber(output.tokensOut);
        const tokensUsed = toNumber(output.tokensUsed) || tokensIn + tokensOut;
        const costUsd = toNumber(output.costUsd);
        const hasApiSignal = Boolean(model) || tokensUsed > 0 || costUsd > 0;
        if (!hasApiSignal) continue;

        const point = seriesMap.get(day);
        if (!point) continue;
        point.calls += 1;
        point.tokens += Math.max(0, Math.round(tokensUsed));
        point.costUsd += Math.max(0, costUsd);

        const roundedTokens = Math.max(0, Math.round(tokensUsed));
        const roundedCost = Math.max(0, costUsd);
        if (model) upsertMetric(models, model, 1, roundedTokens, roundedCost);
        upsertMetric(providers, provider || "unknown", 1, roundedTokens, roundedCost);
        upsertMetric(workflows, row.workflow_id, 1, Math.max(0, Math.round(tokensUsed)), Math.max(0, costUsd));
      }
    }

    const todayKey = dayKeys[dayKeys.length - 1];
    const today = seriesMap.get(todayKey) ?? { day: todayKey, calls: 0, tokens: 0, costUsd: 0 };
    const period = [...seriesMap.values()];
    const periodCalls = period.reduce((sum, point) => sum + point.calls, 0);
    const periodTokens = period.reduce((sum, point) => sum + point.tokens, 0);
    const periodCostUsd = period.reduce((sum, point) => sum + point.costUsd, 0);

    const dailyBudgetUsd = 50;
    const budgetUsedPercent = dailyBudgetUsd > 0 ? Math.min(100, (today.costUsd / dailyBudgetUsd) * 100) : 0;
    const successRate = executionTotal > 0 ? Math.round((executionCompleted / executionTotal) * 100) : 0;

    const sortMetric = (a: LeaderboardItem, b: LeaderboardItem) => {
      if (b.costUsd !== a.costUsd) return b.costUsd - a.costUsd;
      if (b.tokens !== a.tokens) return b.tokens - a.tokens;
      return b.calls - a.calls;
    };

    return NextResponse.json({
      success: true,
      data: {
        generatedAt: new Date().toISOString(),
        days,
        summary: {
          apiCallsToday: today.calls,
          tokensToday: today.tokens,
          costTodayUsd: Number(today.costUsd.toFixed(4)),
          apiCallsPeriod: periodCalls,
          tokensPeriod: periodTokens,
          costPeriodUsd: Number(periodCostUsd.toFixed(4)),
          avgCostPerCallUsd: periodCalls > 0 ? Number((periodCostUsd / periodCalls).toFixed(4)) : 0,
          avgTokensPerCall: periodCalls > 0 ? Math.round(periodTokens / periodCalls) : 0,
          successRate,
          executions: {
            total: executionTotal,
            completed: executionCompleted,
            failed: executionFailed,
          },
          budget: {
            dailyUsd: dailyBudgetUsd,
            usedUsd: Number(today.costUsd.toFixed(4)),
            usedPercent: Number(budgetUsedPercent.toFixed(1)),
          },
        },
        series: period.map((point) => ({
          day: point.day,
          calls: point.calls,
          tokens: point.tokens,
          costUsd: Number(point.costUsd.toFixed(4)),
        })),
        providers: [...providers.values()].sort(sortMetric).slice(0, 12),
        models: [...models.values()].sort(sortMetric).slice(0, 12),
        workflows: [...workflows.values()].sort(sortMetric).slice(0, 12),
      },
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
