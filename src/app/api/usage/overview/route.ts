import { NextRequest, NextResponse } from "next/server";
import { getSqlite, initializeDatabase } from "@/lib/db";
import { requireOperatorAccess } from "@/lib/security/admin";

export const dynamic = "force-dynamic";

// Consolidated analytics overview for the Usage tab: model spend + workflow
// reliability for a 7/30/90-day window, aggregated from existing tables
// (agent_spend_events, executions, workflows) — no new bookkeeping.
export async function GET(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    initializeDatabase();
    const db = getSqlite();
    const { searchParams } = new URL(request.url);
    const requested = Number(searchParams.get("windowDays"));
    const windowDays = [7, 30, 90].includes(requested) ? requested : 30;
    const windowIso = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

    const spend = db
      .prepare(
        `SELECT COUNT(*) AS calls, COALESCE(SUM(tokens_used),0) AS tokens, COALESCE(SUM(cost_usd),0) AS cost
           FROM agent_spend_events WHERE created_at >= ?`,
      )
      .get(windowIso) as { calls: number; tokens: number; cost: number };

    const topModels = db
      .prepare(
        `SELECT provider, model_id, COUNT(*) AS calls, COALESCE(SUM(tokens_used),0) AS tokens, COALESCE(SUM(cost_usd),0) AS cost
           FROM agent_spend_events WHERE created_at >= ?
          GROUP BY provider, model_id ORDER BY tokens DESC LIMIT 3`,
      )
      .all(windowIso) as Array<{ provider: string; model_id: string; calls: number; tokens: number; cost: number }>;

    const executions = db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
           FROM executions WHERE started_at >= ?`,
      )
      .get(windowIso) as { total: number; failed: number | null };

    const topWorkflows = db
      .prepare(
        `SELECT e.workflow_id, w.name, COUNT(*) AS runs,
                SUM(CASE WHEN e.status = 'failed' THEN 1 ELSE 0 END) AS failed
           FROM executions e LEFT JOIN workflows w ON w.id = e.workflow_id
          WHERE e.started_at >= ?
          GROUP BY e.workflow_id ORDER BY runs DESC LIMIT 3`,
      )
      .all(windowIso) as Array<{ workflow_id: string; name: string | null; runs: number; failed: number | null }>;

    const total = executions.total || 0;
    const failed = executions.failed || 0;
    return NextResponse.json({
      success: true,
      data: {
        windowDays,
        modelCalls: spend.calls,
        tokens: spend.tokens,
        costUsd: Math.round(spend.cost * 10000) / 10000,
        workflowRuns: total,
        errorRate: total > 0 ? Math.round((failed / total) * 100) : 0,
        topModels: topModels.map((row) => ({
          provider: row.provider,
          modelId: row.model_id,
          calls: row.calls,
          tokens: row.tokens,
          costUsd: Math.round(row.cost * 10000) / 10000,
        })),
        topWorkflows: topWorkflows.map((row) => ({
          workflowId: row.workflow_id,
          name: row.name || row.workflow_id,
          runs: row.runs,
          failed: row.failed || 0,
        })),
      },
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
