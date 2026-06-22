import { existsSync } from "node:fs";
import path from "node:path";
import { logger } from "@/lib/utils/logger";
import { getChannelAccessMode, getChannelAccessOverview } from "@/lib/channels/access";
import { getRuntimeModelAvailability } from "@/lib/agents/model-availability";
import { resolveSecretValue } from "@/lib/secrets/store";

const log = logger.child("channels:doctor");

type ChannelDiagnosticResult = {
  channelId: string;
  channelName: string;
  connected: boolean;
  issues: string[];
  repairSteps: string[];
  severity: "ok" | "warning" | "error";
  webhookPath?: string;
  routeSourcePath?: string;
  routeSourcePresent?: boolean;
};

type ChannelDoctorReport = {
  overallStatus: "healthy" | "degraded" | "broken";
  accessMode: string;
  pendingPairings: number;
  modelAvailable: boolean;
  channels: ChannelDiagnosticResult[];
  summary: string;
};

function checkEnvKey(key: string): boolean {
  const value = String(process.env[key] || "").trim();
  return value.length > 0 && value !== "undefined" && value !== "null";
}

function checkSecretOrEnvKey(key: string): boolean {
  const secret = String(resolveSecretValue(key) ?? "").trim();
  return (secret.length > 0 && secret !== "undefined" && secret !== "null") || checkEnvKey(key);
}

function applyWebhookRouteCheck(result: ChannelDiagnosticResult, webhookPath: string) {
  const routeSourcePath = path.join(process.cwd(), "src", "app", ...webhookPath.split("/").filter(Boolean), "route.ts");
  const routeSourcePresent = existsSync(routeSourcePath);
  result.webhookPath = webhookPath;
  result.routeSourcePath = routeSourcePath;
  result.routeSourcePresent = routeSourcePresent;
  if (!routeSourcePresent) {
    result.connected = false;
    result.issues.push(`Webhook route source is missing for ${webhookPath}`);
    result.repairSteps.push(`Restore ${path.relative(process.cwd(), routeSourcePath)} so the webhook can receive events`);
    result.severity = "error";
  }
}

function diagnoseTelegram(): ChannelDiagnosticResult {
  const result: ChannelDiagnosticResult = {
    channelId: "telegram",
    channelName: "Telegram",
    connected: false,
    issues: [],
    repairSteps: [],
    severity: "ok",
  };
  if (!checkSecretOrEnvKey("TELEGRAM_BOT_TOKEN")) {
    result.issues.push("TELEGRAM_BOT_TOKEN is not set");
    result.repairSteps.push("Add TELEGRAM_BOT_TOKEN to Settings > Channels or your .env.local file");
    result.repairSteps.push("Get a bot token from @BotFather on Telegram");
    result.severity = "error";
  } else {
    result.connected = true;
  }
  return result;
}

function diagnoseDiscord(): ChannelDiagnosticResult {
  const result: ChannelDiagnosticResult = {
    channelId: "discord",
    channelName: "Discord",
    connected: false,
    issues: [],
    repairSteps: [],
    severity: "ok",
  };
  if (!checkEnvKey("DISCORD_BOT_TOKEN")) {
    result.issues.push("DISCORD_BOT_TOKEN is not set");
    result.repairSteps.push("Add DISCORD_BOT_TOKEN to Settings > Channels or your .env.local file");
    result.repairSteps.push("Create a bot at https://discord.com/developers/applications, add to your server, and copy the token");
    result.repairSteps.push("Ensure the bot has message content intent enabled in Developer Portal");
    result.severity = "error";
  } else {
    result.connected = true;
  }
  return result;
}

function diagnoseWhatsApp(): ChannelDiagnosticResult {
  const result: ChannelDiagnosticResult = {
    channelId: "whatsapp",
    channelName: "WhatsApp",
    connected: false,
    issues: [],
    repairSteps: [],
    severity: "ok",
  };
  const globalThisAny = globalThis as Record<string, unknown>;
  const runtimeState = globalThisAny.__disp8chWhatsAppState as { ready?: boolean; paired?: boolean } | undefined;
  if (!runtimeState?.paired && !runtimeState?.ready) {
    result.issues.push("WhatsApp session not paired");
    result.repairSteps.push("Go to Settings > Channels > WhatsApp and scan the QR code");
    result.repairSteps.push("Keep the phone connected and WhatsApp open during pairing");
    result.repairSteps.push("After pairing, restart the dev server if the session does not activate");
    result.severity = "warning";
  } else {
    result.connected = true;
  }
  return result;
}

function diagnoseSlack(): ChannelDiagnosticResult {
  const result: ChannelDiagnosticResult = {
    channelId: "slack",
    channelName: "Slack",
    connected: false,
    issues: [],
    repairSteps: [],
    severity: "ok",
  };
  const missingKeys: string[] = [];
  if (!checkEnvKey("SLACK_BOT_TOKEN")) missingKeys.push("SLACK_BOT_TOKEN");
  if (!checkEnvKey("SLACK_APP_TOKEN")) missingKeys.push("SLACK_APP_TOKEN");
  if (missingKeys.length > 0) {
    result.issues.push(`Missing Slack credentials: ${missingKeys.join(", ")}`);
    result.repairSteps.push("Add SLACK_BOT_TOKEN and SLACK_APP_TOKEN to Settings > Channels");
    result.repairSteps.push("Create a Slack app at https://api.slack.com/apps, enable Socket Mode, and copy tokens");
    result.repairSteps.push("Bot token needs chat:write and channels:history scopes; app token needs connections:write");
    result.severity = "error";
  } else {
    result.connected = true;
  }
  return result;
}

function diagnoseBlueBubbles(): ChannelDiagnosticResult {
  const result: ChannelDiagnosticResult = {
    channelId: "bluebubbles",
    channelName: "BlueBubbles",
    connected: false,
    issues: [],
    repairSteps: [],
    severity: "ok",
  };
  if (!checkEnvKey("BLUEBUBBLES_PASSWORD")) {
    result.issues.push("BLUEBUBBLES_PASSWORD is not set");
    result.repairSteps.push("Install BlueBubbles server on a Mac with iMessage");
    result.repairSteps.push("Add BLUEBUBBLES_PASSWORD and BLUEBUBBLES_SERVER_URL to Settings > Channels");
    result.repairSteps.push("The server URL should be the HTTP address of your BlueBubbles server");
    result.severity = "error";
  } else {
    result.connected = true;
  }
  return result;
}

function diagnoseGoogleChat(): ChannelDiagnosticResult {
  const result: ChannelDiagnosticResult = {
    channelId: "googlechat",
    channelName: "Google Chat",
    connected: false,
    issues: [],
    repairSteps: [],
    severity: "ok",
  };
  applyWebhookRouteCheck(result, "/api/channels/google-chat");
  const hasGoogleCreds = checkEnvKey("GOOGLE_CLIENT_ID") && checkEnvKey("GOOGLE_CLIENT_SECRET");
  const hasGoogleToken = checkEnvKey("GOOGLE_REFRESH_TOKEN");
  if (!hasGoogleCreds) {
    result.issues.push("Google OAuth credentials (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET) are not set");
    result.repairSteps.push("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in Settings > Channels");
    result.repairSteps.push("Create OAuth credentials at https://console.cloud.google.com, enable Chat API");
    result.severity = "error";
  } else if (!hasGoogleToken) {
    result.issues.push("Google refresh token is missing — OAuth flow not completed");
    result.repairSteps.push("Go to Settings > Google and complete the OAuth authorization flow");
    result.repairSteps.push("Run: dpc auth google");
    result.severity = "warning";
  } else {
    result.connected = result.routeSourcePresent !== false;
    result.issues.push("Google Chat uses webhook ingress — ensure your app is reachable from the internet");
    result.repairSteps.push(`Webhook endpoint: ${result.webhookPath}`);
    if (result.severity !== "error") result.severity = "warning";
  }
  return result;
}

function diagnoseTeams(): ChannelDiagnosticResult {
  const result: ChannelDiagnosticResult = {
    channelId: "teams",
    channelName: "Microsoft Teams",
    connected: false,
    issues: [],
    repairSteps: [],
    severity: "ok",
  };
  applyWebhookRouteCheck(result, "/api/channels/teams");
  const missingKeys: string[] = [];
  if (!checkEnvKey("TEAMS_APP_ID")) missingKeys.push("TEAMS_APP_ID");
  if (!checkEnvKey("TEAMS_APP_PASSWORD")) missingKeys.push("TEAMS_APP_PASSWORD");
  if (missingKeys.length > 0) {
    result.issues.push(`Missing Teams credentials: ${missingKeys.join(", ")}`);
    result.repairSteps.push("Register a bot in Azure Bot Framework at https://dev.botframework.com");
    result.repairSteps.push("Add TEAMS_APP_ID and TEAMS_APP_PASSWORD to Settings > Channels");
    result.repairSteps.push("Configure the messaging endpoint to your app's /api/channels/teams URL");
    result.repairSteps.push("Install the bot into your Teams tenant");
    result.severity = "error";
  } else {
    result.connected = result.routeSourcePresent !== false;
    result.issues.push(`Teams uses webhook ingress — ensure ${result.webhookPath} is publicly reachable`);
    result.repairSteps.push(`Webhook endpoint: ${result.webhookPath}`);
    if (result.severity !== "error") result.severity = "warning";
  }
  return result;
}

function checkModelAvailability(): boolean {
  try {
    const { getSqlite } = require("@/lib/db") as { getSqlite: () => import("better-sqlite3").Database };
    return getRuntimeModelAvailability(getSqlite()).available;
  } catch {
    return getRuntimeModelAvailability().available;
  }
}

export function runChannelDoctor(): ChannelDoctorReport {
  log.info("Running channel doctor");
  const accessOverview = getChannelAccessOverview();
  const modelAvailable = checkModelAvailability();

  const channelResults = [
    diagnoseTelegram(),
    diagnoseDiscord(),
    diagnoseWhatsApp(),
    diagnoseSlack(),
    diagnoseBlueBubbles(),
    diagnoseGoogleChat(),
    diagnoseTeams(),
  ];

  const errors = channelResults.filter((r) => r.severity === "error");
  const warnings = channelResults.filter((r) => r.severity === "warning" && r.issues.length > 0);
  const connected = channelResults.filter((r) => r.connected);

  let overallStatus: ChannelDoctorReport["overallStatus"] = "healthy";
  if (errors.length > 0) {
    overallStatus = connected.length === 0 ? "broken" : "degraded";
  } else if (warnings.length > 0) {
    overallStatus = "degraded";
  }

  if (!modelAvailable) {
    overallStatus = "broken";
  }

  const summaryLines: string[] = [
    `Overall: ${overallStatus}`,
    `Access mode: ${accessOverview.mode}`,
    `Channels configured: ${connected.length}/7`,
    `Pending pairings: ${accessOverview.pending.length}`,
    `Model available: ${modelAvailable ? "yes" : "no"}`,
  ];
  if (!modelAvailable) {
    summaryLines.push("Fix: Add at least one active model in Settings > Models before channels can reply");
  }
  if (accessOverview.pending.length > 0) {
    summaryLines.push(`Action: ${accessOverview.pending.length} pairing request(s) waiting — run "list pending pairing requests"`);
  }

  return {
    overallStatus,
    accessMode: accessOverview.mode,
    pendingPairings: accessOverview.pending.length,
    modelAvailable,
    channels: channelResults,
    summary: summaryLines.join("\n"),
  };
}

export function formatChannelDoctorReport(report: ChannelDoctorReport): string {
  const lines: string[] = [
    "## Channel health report",
    "",
    report.summary,
    "",
    "### Channel details",
    "",
  ];

  for (const ch of report.channels) {
    const statusIcon = ch.severity === "ok" || ch.connected
      ? (ch.severity === "warning" ? "⚠" : "✓")
      : "✗";
    lines.push(`**${statusIcon} ${ch.channelName}**: ${ch.connected ? "ready" : "not ready"}`);
    if (ch.webhookPath) {
      lines.push(`  - Endpoint: ${ch.webhookPath}`);
    }
    if (typeof ch.routeSourcePresent === "boolean" && ch.routeSourcePath) {
      const relativeRouteSource = path.relative(process.cwd(), ch.routeSourcePath);
      lines.push(`  - Route source: ${ch.routeSourcePresent ? "present" : "missing"} (${relativeRouteSource})`);
    }
    if (ch.issues.length > 0) {
      for (const issue of ch.issues) {
        lines.push(`  - Issue: ${issue}`);
      }
    }
    if (ch.repairSteps.length > 0 && ch.severity !== "ok") {
      for (const step of ch.repairSteps) {
        lines.push(`  - Fix: ${step}`);
      }
    }
  }

  lines.push("");
  lines.push("### Repair commands");
  lines.push('- `show setup for extension Telegram` — Telegram setup guide');
  lines.push('- `show setup for extension Discord` — Discord setup guide');
  lines.push('- `show setup for extension WhatsApp` — WhatsApp pairing guide');
  lines.push('- `show setup for extension Slack` — Slack setup guide');
  lines.push('- `show setup for extension BlueBubbles` — BlueBubbles setup guide');
  lines.push('- `show setup for extension GoogleChat` — Google Chat setup guide');
  lines.push('- `show setup for extension Teams` — Microsoft Teams setup guide');
  lines.push('- `list pending pairing requests` — Manage WhatsApp/channel pairing');
  lines.push('- `show channels` — Channel connection overview');

  return lines.join("\n");
}
