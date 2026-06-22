import { NextResponse } from "next/server";
import { getSqlite } from "@/lib/db";
import { getCached, API_TTL } from "@/lib/api-cache";
import { requireOperatorAccess } from "@/lib/security/admin";

export const dynamic = "force-dynamic";

function toNumber(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return parsed;
}

function todayStart(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
    .toISOString();
}

function monthStart(monthOffset: number): string {
  const d = new Date();
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + monthOffset;
  return new Date(Date.UTC(year, month, 1)).toISOString();
}

export async function GET(request: Request) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;
  try {
    const data = await getCached("metrics-bootstrap", async () => {
      const db = getSqlite();

      let costs = { todayUsd: 0, thisMonthUsd: 0, lastMonthUsd: 0 };
      let modelCalls = { today: 0, thisMonth: 0 };
      let executions = { today: 0, thisMonth: 0 };
      let callsThisMonth = 0;

      const todayIso = todayStart();
      const thisMonthIso = monthStart(0);
      const lastMonthIso = monthStart(-1);

      try {
        // Fetch today's executions
        const todayRows = db
          .prepare(
            "SELECT node_results, started_at FROM executions WHERE started_at >= ? ORDER BY started_at DESC",
          )
          .all(todayIso) as Array<{
          node_results: string | null;
          started_at: string;
        }>;

        for (const row of todayRows) {
          executions.today += 1;
          let parsed: Record<string, unknown> = {};
          try {
            parsed = row.node_results
              ? (JSON.parse(row.node_results) as Record<string, unknown>)
              : {};
          } catch {
            /* malformed JSON */
          }

          for (const nodeValue of Object.values(parsed)) {
            if (!nodeValue || typeof nodeValue !== "object") continue;
            const nr = nodeValue as {
              output?: Record<string, unknown>;
            };
            const output = nr.output ?? {};
            const costUsd = toNumber(output.costUsd);
            const model = String(output.model ?? "").trim();
            if (model) {
              modelCalls.today += 1;
            }
            costs.todayUsd += Math.max(0, costUsd);
          }
        }

        // Fetch this month's executions (which includes today)
        if (thisMonthIso < todayIso) {
          const monthRows = db
            .prepare(
              "SELECT node_results, started_at FROM executions WHERE started_at >= ? AND started_at < ? ORDER BY started_at DESC",
            )
            .all(thisMonthIso, todayIso) as Array<{
            node_results: string | null;
            started_at: string;
          }>;

          for (const row of monthRows) {
            executions.thisMonth += 1;
            let parsed: Record<string, unknown> = {};
            try {
              parsed = row.node_results
                ? (JSON.parse(row.node_results) as Record<string, unknown>)
                : {};
            } catch {
              /* malformed JSON */
            }

            for (const nodeValue of Object.values(parsed)) {
              if (!nodeValue || typeof nodeValue !== "object") continue;
              const nr = nodeValue as {
                output?: Record<string, unknown>;
              };
              const output = nr.output ?? {};
              const costUsd = toNumber(output.costUsd);
              const model = String(output.model ?? "").trim();
              if (model) {
                callsThisMonth += 1;
              }
              costs.thisMonthUsd += Math.max(0, costUsd);
            }
          }
        }

        // Include today's counts in this month
        executions.thisMonth += executions.today;
        costs.thisMonthUsd += costs.todayUsd;
        modelCalls.thisMonth = callsThisMonth + modelCalls.today;

        // Last month
        try {
          const lastMonthRows = db
            .prepare(
              "SELECT node_results FROM executions WHERE started_at >= ? AND started_at < ?",
            )
            .all(lastMonthIso, thisMonthIso) as Array<{
            node_results: string | null;
          }>;

          for (const row of lastMonthRows) {
            let parsed: Record<string, unknown> = {};
            try {
              parsed = row.node_results
                ? (JSON.parse(row.node_results) as Record<string, unknown>)
                : {};
            } catch {
              /* malformed JSON */
            }

            for (const nodeValue of Object.values(parsed)) {
              if (!nodeValue || typeof nodeValue !== "object") continue;
              const nr = nodeValue as {
                output?: Record<string, unknown>;
              };
              const output = nr.output ?? {};
              const costUsd = toNumber(output.costUsd);
              costs.lastMonthUsd += Math.max(0, costUsd);
            }
          }
        } catch {
          /* last month query may fail */
        }

        // Round all costs
        costs.todayUsd = Math.round(costs.todayUsd * 10000) / 10000;
        costs.thisMonthUsd = Math.round(costs.thisMonthUsd * 10000) / 10000;
        costs.lastMonthUsd = Math.round(costs.lastMonthUsd * 10000) / 10000;
      } catch {
        /* executions table may not exist or queries may fail */
      }

      return { costs, modelCalls, executions };
    }, API_TTL.bootstrap);

    return NextResponse.json({ success: true, data });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: String(err) },
      { status: 500 },
    );
  }
}
