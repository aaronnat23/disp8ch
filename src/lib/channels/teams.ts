import { logger } from "@/lib/utils/logger";
import { getRetryPolicy, isRetryableChannelError, withRetry } from "@/lib/utils/retry";
import { presentChannelResponse } from "@/lib/channels/presentation";
import { isIP } from "node:net";

const log = logger.child("channel:teams");

/**
 * Microsoft Teams channel — webhook-based (Bot Framework v4 REST).
 * Teams sends activities to our webhook endpoint (/api/channels/teams).
 * We reply by calling the Bot Framework REST API.
 *
 * No persistent connection needed — Teams pushes to us.
 */

type MessageHandler = (data: {
  message: string;
  sender: string;
  senderId: string;
  conversationId: string;
  serviceUrl: string;
  activityId: string;
  channel: "teams";
}) => Promise<void>;

type TeamsRuntimeState = {
  appId: string;
  appPassword: string;
  accessToken: string | null;
  tokenExpiry: number;
  messageHandler: MessageHandler | null;
};

const BLOCKED_TEAMS_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
]);

function normalizeTeamsHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function isBlockedTeamsIpv4(hostname: string): boolean {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    return false;
  }
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return true;
  }
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 192 && b === 0 && c === 0) return true;
  return a >= 224;
}

function isBlockedTeamsIpv6(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === "::1" || normalized === "::") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (normalized.startsWith("fe8") || normalized.startsWith("fe9")
    || normalized.startsWith("fea") || normalized.startsWith("feb")) return true;
  if (normalized.startsWith("ff")) return true;
  const embeddedIpv4 = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1] ?? null;
  return embeddedIpv4 ? isBlockedTeamsIpv4(embeddedIpv4) : false;
}

function isBlockedTeamsHost(hostname: string): boolean {
  if (!hostname) return true;
  if (BLOCKED_TEAMS_HOSTNAMES.has(hostname)) return true;
  if (hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    return true;
  }
  const family = isIP(hostname);
  if (family === 4) return isBlockedTeamsIpv4(hostname);
  if (family === 6) return isBlockedTeamsIpv6(hostname);
  return false;
}

function getAllowedTeamsServiceHosts(): Set<string> {
  return new Set(
    String(process.env.TEAMS_ALLOWED_SERVICE_HOSTS || "")
      .split(",")
      .map((value) => normalizeTeamsHostname(value))
      .filter(Boolean),
  );
}

export function assertAllowedTeamsServiceUrl(rawServiceUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(String(rawServiceUrl || "").trim());
  } catch {
    throw new Error("Invalid Teams serviceUrl");
  }

  if (parsed.protocol !== "https:") {
    throw new Error("Teams serviceUrl must use https");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Teams serviceUrl contains unsupported components");
  }

  const hostname = normalizeTeamsHostname(parsed.hostname);
  if (isBlockedTeamsHost(hostname)) {
    throw new Error("Blocked Teams serviceUrl host");
  }

  const allowedHosts = getAllowedTeamsServiceHosts();
  if (allowedHosts.size > 0 && !allowedHosts.has(hostname)) {
    throw new Error("Teams serviceUrl host is not in TEAMS_ALLOWED_SERVICE_HOSTS");
  }

  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/+$/, "");
}

function getTeamsRuntimeState(): TeamsRuntimeState {
  const scoped = globalThis as typeof globalThis & {
    __disp8chTeamsRuntimeState?: TeamsRuntimeState;
  };
  if (!scoped.__disp8chTeamsRuntimeState) {
    scoped.__disp8chTeamsRuntimeState = {
      appId: "",
      appPassword: "",
      accessToken: null,
      tokenExpiry: 0,
      messageHandler: null,
    };
  }
  return scoped.__disp8chTeamsRuntimeState;
}

export function onTeamsMessage(handler: MessageHandler) {
  getTeamsRuntimeState().messageHandler = handler;
}

export function configureTeams(appId: string, appPassword: string): void {
  const state = getTeamsRuntimeState();
  state.appId = appId;
  state.appPassword = appPassword;
  state.accessToken = null;
  state.tokenExpiry = 0;
  log.info("Teams configured", { appId });
}

async function ensureAccessToken(): Promise<string> {
  const state = getTeamsRuntimeState();
  if (!state.appId || !state.appPassword) {
    throw new Error("Teams not configured — set TEAMS_APP_ID and TEAMS_APP_PASSWORD");
  }

  // Token still valid (with 5 min buffer)
  if (state.accessToken && Date.now() < state.tokenExpiry - 300_000) {
    return state.accessToken;
  }

  // Request new token from Azure AD
  const tokenUrl = "https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token";
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: state.appId,
    client_secret: state.appPassword,
    scope: "https://api.botframework.com/.default",
  });

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Teams token request failed: HTTP ${response.status} ${errText}`);
  }

  const tokenData = (await response.json()) as {
    access_token: string;
    expires_in: number;
  };

  state.accessToken = tokenData.access_token;
  state.tokenExpiry = Date.now() + tokenData.expires_in * 1000;
  return state.accessToken;
}

export type TeamsActivity = {
  type: string;
  id: string;
  timestamp: string;
  serviceUrl: string;
  channelId: string;
  from: { id: string; name?: string };
  conversation: { id: string; conversationType?: string };
  recipient?: { id: string; name?: string };
  text?: string;
};

export async function handleTeamsActivity(activity: TeamsActivity): Promise<string | null> {
  if (activity.type !== "message" || !activity.text?.trim()) {
    return null;
  }

  const state = getTeamsRuntimeState();
  const handler = state.messageHandler;
  if (!handler) {
    log.warn("Teams activity received but no handler registered");
    return null;
  }

  const text = activity.text.trim();
  const sender = activity.from.name || activity.from.id;
  const conversationId = activity.conversation.id;
  const serviceUrl = assertAllowedTeamsServiceUrl(activity.serviceUrl);

  log.info("Teams message received", { sender, conversationId });

  await handler({
    message: text,
    sender,
    senderId: activity.from.id,
    conversationId,
    serviceUrl,
    activityId: activity.id,
    channel: "teams",
  }).catch((err) => {
    log.error("Teams message handler error", { error: String(err) });
  });

  return conversationId;
}

export async function sendTeamsMessage(
  serviceUrl: string,
  conversationId: string,
  text: string,
): Promise<void> {
  const token = await ensureAccessToken();
  const policy = getRetryPolicy();
  const presented = presentChannelResponse("teams", text);
  const safeServiceUrl = assertAllowedTeamsServiceUrl(serviceUrl);
  const url = `${safeServiceUrl}/v3/conversations/${encodeURIComponent(conversationId)}/activities`;

  await withRetry(
    async () => {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: "message",
          text: presented,
          textFormat: "markdown",
        }),
      });
      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        throw new Error(`Teams send failed: HTTP ${response.status} ${errText}`);
      }
    },
    {
      policy,
      shouldRetry: isRetryableChannelError,
      label: "teams.sendMessage",
    },
  );
}

export async function sendTeamsTyping(
  serviceUrl: string,
  conversationId: string,
): Promise<void> {
  const token = await ensureAccessToken();
  const policy = getRetryPolicy();
  const safeServiceUrl = assertAllowedTeamsServiceUrl(serviceUrl);
  const url = `${safeServiceUrl}/v3/conversations/${encodeURIComponent(conversationId)}/activities`;

  await withRetry(
    async () => {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: "typing",
        }),
      });
      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        throw new Error(`Teams typing failed: HTTP ${response.status} ${errText}`);
      }
    },
    {
      policy,
      shouldRetry: isRetryableChannelError,
      label: "teams.typing",
    },
  );
}

export function getTeamsStatus(): { configured: boolean; appId: string } {
  const state = getTeamsRuntimeState();
  return {
    configured: Boolean(state.appId && state.appPassword),
    appId: state.appId,
  };
}
