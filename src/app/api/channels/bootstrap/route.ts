import { NextResponse } from "next/server";
import { getSqlite } from "@/lib/db";
import { requireOperatorAccess } from "@/lib/security/admin";
import { getCached, API_TTL } from "@/lib/api-cache";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;

    const data = await getCached("channels-bootstrap", async () => {
      const db = getSqlite();

      // ── channel status ────────────────────────────────────────────────────
      let connectedChannels: string[] = [];
      let channelTotal = 0;
      try {
        const { runChannelDoctor } =
          require("@/lib/channels/channel-doctor") as {
            runChannelDoctor: () => {
              channels: Array<{ channelName: string; connected: boolean }>;
            };
          };
        const report = runChannelDoctor();
        connectedChannels = report.channels
          .filter((c) => c.connected)
          .map((c) => c.channelName);
        channelTotal = report.channels.length;
      } catch {
        /* channel-doctor module may not be available */
      }

      // ── sessions ──────────────────────────────────────────────────────────
      let sessionCount = 0;
      try {
        sessionCount = (
          db
            .prepare("SELECT COUNT(DISTINCT session_id) AS c FROM messages")
            .get() as { c: number }
        )?.c ?? 0;
      } catch {
        /* messages table may not exist yet */
      }

      return {
        channels: { connected: connectedChannels, total: channelTotal },
        sessions: { count: sessionCount },
      };
    }, API_TTL.bootstrap);

    return NextResponse.json({ success: true, data });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: String(err) },
      { status: 500 },
    );
  }
}
