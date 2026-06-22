import { NextResponse } from "next/server";
import { getSqlite } from "@/lib/db";
import { getCached, API_TTL } from "@/lib/api-cache";
import { requireOperatorAccess } from "@/lib/security/admin";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;
  try {
    const data = await getCached("usage-bootstrap", async () => {
      const db = getSqlite();

      const now = new Date();
      const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

      let executions = {
        total24h: 0,
        running: 0,
        completed24h: 0,
        failed24h: 0,
      };
      try {
        executions.total24h = (
          db
            .prepare("SELECT COUNT(*) AS c FROM executions WHERE started_at >= ?")
            .get(since24h) as { c: number }
        )?.c ?? 0;
        executions.running = (
          db
            .prepare("SELECT COUNT(*) AS c FROM executions WHERE status = 'running'")
            .get() as { c: number }
        )?.c ?? 0;
        executions.completed24h = (
          db
            .prepare("SELECT COUNT(*) AS c FROM executions WHERE started_at >= ? AND status = 'completed'")
            .get(since24h) as { c: number }
        )?.c ?? 0;
        executions.failed24h = (
          db
            .prepare("SELECT COUNT(*) AS c FROM executions WHERE started_at >= ? AND status = 'failed'")
            .get(since24h) as { c: number }
        )?.c ?? 0;
      } catch {
        /* executions table may not exist yet */
      }

      let agentData = { active: 0, withModel: 0 };
      try {
        agentData.active = (
          db
            .prepare("SELECT COUNT(*) AS c FROM agents WHERE is_active = 1")
            .get() as { c: number }
        )?.c ?? 0;
        agentData.withModel = (
          db
            .prepare("SELECT COUNT(*) AS c FROM agents WHERE is_active = 1 AND model_ref IS NOT NULL AND model_ref != ''")
            .get() as { c: number }
        )?.c ?? 0;
      } catch {
        /* agents table may not exist yet */
      }

      let channels = { connected: [] as string[] };
      try {
        const { runChannelDoctor } =
          require("@/lib/channels/channel-doctor") as {
            runChannelDoctor: () => {
              channels: Array<{ channelName: string; connected: boolean }>;
            };
          };
        const report = runChannelDoctor();
        channels.connected = report.channels
          .filter((c) => c.connected)
          .map((c) => c.channelName);
      } catch {
        /* channel-doctor module may not be available */
      }

      return { executions, agents: agentData, channels };
    }, API_TTL.bootstrap);

    return NextResponse.json({ success: true, data });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: String(err) },
      { status: 500 },
    );
  }
}
