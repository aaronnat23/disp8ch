import { NextResponse } from "next/server";
import { getCached, API_TTL } from "@/lib/api-cache";
import { requireOperatorAccess } from "@/lib/security/admin";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;

    const data = await getCached("activity-bootstrap", async () => {
      // ── running ───────────────────────────────────────────────────────────
      let running = {
        count: 0,
        lanes: [] as Array<{ lane: string; active: number; queued: number }>,
      };
      try {
        const {
          listExecutionLaneSnapshots,
        } = require("@/lib/engine/execution-lanes") as {
          listExecutionLaneSnapshots: () => Array<{
            lane: string;
            active: number;
            queued: number;
          }>;
        };
        const lanes = listExecutionLaneSnapshots?.() ?? [];
        running = {
          count: lanes.reduce((sum, l) => sum + l.active, 0),
          lanes: lanes.map((l) => ({
            lane: l.lane,
            active: l.active,
            queued: l.queued,
          })),
        };
      } catch {
        /* execution lanes may not be available */
      }

      // ── recentEvents ─────────────────────────────────────────────────────
      let recentEvents = {
        count24h: 0,
        byType: {} as Record<string, number>,
      };
      try {
        const {
          readTelemetryStats,
        } = require("@/lib/telemetry") as {
          readTelemetryStats: (hours: number) => {
            totalEvents: number;
            byType: Record<string, number>;
          };
        };
        const stats = readTelemetryStats(24);
        recentEvents = {
          count24h: stats.totalEvents,
          byType: stats.byType,
        };
      } catch {
        /* telemetry module may not be available */
      }

      // ── pendingApprovals ─────────────────────────────────────────────────
      let pendingApprovals = { count: 0 };
      try {
        const {
          listPendingApprovals,
        } = require("@/lib/engine/tools") as {
          listPendingApprovals: () => Array<unknown>;
        };
        const approvals = listPendingApprovals?.() ?? [];
        pendingApprovals = { count: approvals.length };
      } catch {
        /* tools module may not be available */
      }

      return { running, recentEvents, pendingApprovals };
    }, API_TTL.bootstrap);

    return NextResponse.json({ success: true, data });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: String(err) },
      { status: 500 },
    );
  }
}
