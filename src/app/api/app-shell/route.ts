import { NextResponse } from "next/server";
import { getSqlite } from "@/lib/db";
import { getCached, API_TTL } from "@/lib/api-cache";
import { requireOperatorAccess } from "@/lib/security/admin";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;
  try {
    const data = await getCached("app-shell", async () => {
    const db = getSqlite();

    // Lightweight counts only — no full transcript/telemetry/doc loads
    const agentCount = (db.prepare("SELECT COUNT(*) as c FROM agents WHERE is_active = 1").get() as { c: number })?.c ?? 0;
    const workflowCount = (db.prepare("SELECT COUNT(*) as c FROM workflows WHERE is_active = 1").get() as { c: number })?.c ?? 0;
    const boardTaskCount = (db.prepare("SELECT COUNT(*) as c FROM board_tasks").get() as { c: number })?.c ?? 0;
    
    let orgName: string | null = null;
    let orgCount = 0;
    try {
      orgCount = (db.prepare("SELECT COUNT(*) as c FROM hierarchy_organizations").get() as { c: number })?.c ?? 0;
      const activeOrg = db.prepare("SELECT name FROM hierarchy_organizations WHERE is_active = 1 LIMIT 1").get() as { name: string } | undefined;
      orgName = activeOrg?.name ?? null;
    } catch { /* table may not exist */ }

    let docCount = 0;
    try { docCount = (db.prepare("SELECT COUNT(*) as c FROM documents").get() as { c: number })?.c ?? 0; } catch { /* may not exist */ }

    let channelStatus: Record<string, unknown> = {};
    try {
      const { getChannelStatusSummary } = await import("@/lib/channels/runtime") as { getChannelStatusSummary?: () => Record<string, unknown> };
      channelStatus = getChannelStatusSummary?.() ?? {};
    } catch { /* runtime may not export this */ }

    let runningExecutions = 0;
    try {
      runningExecutions = (db.prepare("SELECT COUNT(*) as c FROM executions WHERE status = 'running'").get() as { c: number })?.c ?? 0;
    } catch { /* table may not exist */ }

    const data = {
      agents: agentCount,
      workflows: workflowCount,
      boardTasks: boardTaskCount,
      organizations: orgCount,
      activeOrg: orgName,
      documents: docCount,
      channels: channelStatus,
      runningExecutions,
      timestamp: new Date().toISOString(),
    };

    return data;
  }, API_TTL.appShell);

    return NextResponse.json({ success: true, data });
  } catch (err) {
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}
