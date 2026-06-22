import { NextResponse } from "next/server";
import { getSqlite } from "@/lib/db";
import { getCached, API_TTL } from "@/lib/api-cache";
import { requireOperatorAccess } from "@/lib/security/admin";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;
  try {
    const data = await getCached("settings-bootstrap", async () => {
      const db = getSqlite();

      let providers = { configured: 0 };
      let modelCount = 0;
      try {
        const rows = db
          .prepare("SELECT DISTINCT provider FROM models")
          .all() as Array<{ provider: string }>;
        providers.configured = rows.length;

        modelCount = (
          db.prepare("SELECT COUNT(*) AS c FROM models").get() as { c: number }
        )?.c ?? 0;
      } catch {
        /* models table may not exist yet */
      }

      let secrets = { count: 0 };
      try {
        secrets.count = (
          db
            .prepare("SELECT COUNT(*) AS c FROM app_secrets")
            .get() as { c: number }
        )?.c ?? 0;
      } catch {
        /* app_secrets table may not exist yet */
      }

      let channels: { connected: string[]; total: number } = {
        connected: [],
        total: 0,
      };
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
        channels.total = report.channels.length;
      } catch {
        /* channel-doctor module may not be available */
      }

      return { providers, secrets, channels, modelCount };
    }, API_TTL.bootstrap);

    return NextResponse.json({ success: true, data });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: String(err) },
      { status: 500 },
    );
  }
}
