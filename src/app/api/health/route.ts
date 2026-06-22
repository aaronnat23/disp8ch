import fs from "node:fs";
import { NextResponse } from "next/server";
import { requireOperatorAccess } from "@/lib/security/admin";
import { initializeDatabase, getSqlite } from "@/lib/db";
import { ensureWorkspaceScaffold, getWorkspaceDir, getWorkspaceMemoryDir } from "@/lib/workspace/files";
import { getWhatsAppStatus } from "@/lib/channels/whatsapp";
import { getTelegramStatus } from "@/lib/channels/telegram";
import { getDiscordStatus } from "@/lib/channels/discord";
import { getStoredToken } from "@/lib/google-oauth";
import { getRuntimeModelAvailability } from "@/lib/agents/model-availability";
import pkg from "../../../../package.json";

export const dynamic = "force-dynamic";

type HealthCheck = {
  name: string;
  status: "ok" | "warn" | "fail";
  details: string;
};

export async function GET(request: Request) {
  // Health stays publicly reachable, but detailed internals (filesystem/data
  // paths, channel/model/account details, install metadata) are only returned
  // to an authenticated operator. Loopback/local_only counts as operator.
  const operatorDenied = await requireOperatorAccess(request);
  const detailed = operatorDenied === null;
  const checks: HealthCheck[] = [];
  let onboardingDone = false;
  let dataDir = process.env.DATABASE_PATH || "./data/disp8ch.db";

  try {
    initializeDatabase();
    const db = getSqlite();
    const appConfig = db.prepare("SELECT onboarding_done FROM app_config WHERE id = 'default'").get() as { onboarding_done?: number } | undefined;
    onboardingDone = appConfig?.onboarding_done === 1;
    dataDir = process.env.DATABASE_PATH || "./data/disp8ch.db";

    checks.push({ name: "database", status: "ok", details: "Database initialized" });

    const modelAvailability = getRuntimeModelAvailability(db);
    checks.push({
      name: "models",
      status: modelAvailability.available ? "ok" : "warn",
      details: modelAvailability.details,
    });

    const wfCount = (db.prepare("SELECT COUNT(*) as c FROM workflows WHERE is_active = 1").get() as { c: number }).c;
    checks.push({
      name: "workflows",
      status: wfCount > 0 ? "ok" : "warn",
      details: wfCount > 0 ? `${wfCount} active workflow(s)` : "No active workflows",
    });
  } catch (error) {
    checks.push({ name: "database", status: "fail", details: String(error) });
  }

  try {
    ensureWorkspaceScaffold();
    const workspaceDir = getWorkspaceDir();
    const memoryDir = getWorkspaceMemoryDir();
    checks.push({
      name: "workspace",
      status: fs.existsSync(workspaceDir) ? "ok" : "fail",
      details: workspaceDir,
    });
    checks.push({
      name: "workspace-memory",
      status: fs.existsSync(memoryDir) ? "ok" : "fail",
      details: memoryDir,
    });
  } catch (error) {
    checks.push({ name: "workspace", status: "fail", details: String(error) });
  }

  try {
    const telegram = getTelegramStatus();
    const discord = getDiscordStatus();
    const whatsapp = getWhatsAppStatus();
    checks.push({
      name: "channels",
      status: "ok",
      details: `telegram=${telegram.connected ? "connected" : "off"}, discord=${discord.connected ? "connected" : "off"}, whatsapp=${whatsapp.connected ? "connected" : "off"}`,
    });
  } catch (error) {
    checks.push({ name: "channels", status: "warn", details: String(error) });
  }

  try {
    const googleOAuth = getStoredToken();
    if (googleOAuth) {
      const nowSec = Math.floor(Date.now() / 1000);
      const expired = googleOAuth.expires_at ? googleOAuth.expires_at < nowSec : true;
      checks.push({
        name: "google-oauth",
        status: expired ? "warn" : "ok",
        details: `email=${googleOAuth.email || "unknown"}, ${expired ? "token expired" : "token valid"}`,
      });
    } else {
      checks.push({
        name: "google-oauth",
        status: "warn",
        details: "Not configured (run 'dpc auth google' to set up)",
      });
    }
  } catch {
    checks.push({ name: "google-oauth", status: "warn", details: "Unable to check" });
  }

  const healthy = checks.every((c) => c.status !== "fail");

  // Public (unauthenticated) view: liveness only, with check names + statuses
  // but no detail strings, paths, ports, or install metadata.
  if (!detailed) {
    const publicChecks = checks.map((c) => ({ name: c.name, status: c.status }));
    return NextResponse.json({
      ok: healthy,
      version: (pkg as { version?: string }).version || "0.0.0",
      onboardingDone,
      checks: publicChecks,
      success: true,
      data: { healthy, checks: publicChecks, timestamp: new Date().toISOString() },
    });
  }

  return NextResponse.json({
    ok: healthy,
    version: (pkg as { version?: string }).version || "0.0.0",
    database: checks.find((check) => check.name === "database")?.status || "unknown",
    dataDir,
    wsPort: Number(process.env.WS_PORT || 3101),
    onboardingDone,
    installChannel: process.env.DISP8CH_INSTALL_CHANNEL || "unknown",
    platform: process.platform,
    checks,
    success: true,
    data: {
      healthy,
      checks,
      timestamp: new Date().toISOString(),
    },
  });
}
