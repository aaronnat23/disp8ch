import { logger } from "@/lib/utils/logger";
import { createChannelActivityController } from "@/lib/channels/activity";
import { evaluateChannelAccess } from "@/lib/channels/access";
import {
  resolveChannelResponseWithFallback,
  resolveExplicitWorkflowNoMatchText,
} from "@/lib/channels/fallback-assistant";
import { routeToWorkflowWithDetails } from "@/lib/channels/router";
import { runByTheWayQuestion } from "@/lib/channels/btw";
import { defaultChannelAgentId, persistChannelMessage } from "@/lib/channels/transcript";
import { scheduleSessionIndex } from "@/lib/memory/session-watcher";
import { createProvenance, type ProvenanceRecord } from "@/lib/provenance";
import { presentChannelResponse, type PresentationChannel } from "@/lib/channels/presentation";
import {
  createTelegramReplyStream,
  onTelegramMessage,
  sendTelegramMessage,
  sendTelegramTyping,
  startTelegram,
} from "@/lib/channels/telegram";
import {
  onDiscordMessage,
  sendDiscordMessage,
  sendDiscordTyping,
  startDiscord,
} from "@/lib/channels/discord";
import {
  connectWhatsApp,
  onWhatsAppMessage,
  sendWhatsAppMessage,
  sendWhatsAppPaused,
  sendWhatsAppTyping,
} from "@/lib/channels/whatsapp";
import {
  onSlackMessage,
  sendSlackMessage,
  startSlack,
} from "@/lib/channels/slack";
import {
  onBlueBubblesMessage,
  sendBlueBubblesMessage,
  startBlueBubbles,
} from "@/lib/channels/bluebubbles";
import {
  configureTeams,
  onTeamsMessage,
  sendTeamsMessage,
  sendTeamsTyping,
} from "@/lib/channels/teams";
import { resolveSecretValue } from "@/lib/secrets/store";

const log = logger.child("channels:runtime");

type ChannelRuntimeGlobal = typeof globalThis & {
  __disp8chChannelBootstrapPromise?: Promise<void> | null;
};

const runtimeGlobal = globalThis as ChannelRuntimeGlobal;

async function enforceChannelSenderAccess(params: {
  channel: string;
  subjectKey: string;
  subjectLabel?: string | null;
  reply: (message: string) => Promise<unknown>;
}): Promise<boolean> {
  const decision = evaluateChannelAccess({
    channel: params.channel,
    subjectKey: params.subjectKey,
    subjectLabel: params.subjectLabel,
  });
  if (decision.allowed) return true;
  log.info("Channel sender blocked", {
    channel: params.channel,
    subjectKey: params.subjectKey,
    reason: decision.reason,
  });
  if (decision.replyMessage) {
    await params.reply(decision.replyMessage).catch((error) => {
      log.warn("Channel access reply failed", {
        channel: params.channel,
        subjectKey: params.subjectKey,
        error: String(error),
      });
    });
  }
  return false;
}

function persistConversation(params: {
  sessionId: string;
  channel: string;
  sender: string;
  userMessage: string;
  assistantMessage: string;
  userMetadata?: Record<string, unknown>;
  assistantMetadata?: Record<string, unknown>;
  provenance?: Partial<ProvenanceRecord> | null;
  createdAt: string;
}): void {
  const agentId = defaultChannelAgentId();
  persistChannelMessage({
    sessionId: params.sessionId,
    role: "user",
    content: params.userMessage,
    metadata: { channel: params.channel, sender: params.sender, ...(params.userMetadata ?? {}) },
    provenance: params.provenance,
    agentId,
    createdAt: params.createdAt,
  });
  persistChannelMessage({
    sessionId: params.sessionId,
    role: "assistant",
    content: params.assistantMessage,
    metadata: { channel: params.channel, ...(params.assistantMetadata ?? {}) },
    provenance: params.provenance,
    agentId,
    createdAt: params.createdAt,
  });
  scheduleSessionIndex(params.sessionId, agentId);
}

async function maybeHandleByTheWayMessage(params: {
  rawMessage: string;
  sessionId: string;
  channel: PresentationChannel;
  send: (message: string) => Promise<unknown>;
}): Promise<boolean> {
  const btw = await runByTheWayQuestion({
    rawMessage: params.rawMessage,
    sessionId: params.sessionId,
  });
  if (!btw) return false;
  const response = presentChannelResponse(params.channel, btw.response || "No answer.");
  await params.send(response).catch(() => {});
  return true;
}

async function deliverResolvedChannelReply(params: {
  routed: Awaited<ReturnType<typeof routeToWorkflowWithDetails>>;
  rawMessage: string;
  sessionId: string;
  channel: PresentationChannel;
  sender: string;
  senderMetadata?: Record<string, unknown>;
  agentId?: string;
  createdAt: string;
  send: (message: string) => Promise<unknown>;
  onEmit?: (event: string, data: unknown) => void;
}): Promise<void> {
  const explicitWorkflowNoMatchText = resolveExplicitWorkflowNoMatchText({
    rawMessage: params.rawMessage,
    routed: params.routed,
  });
  if (explicitWorkflowNoMatchText) {
    const response = presentChannelResponse(params.channel, explicitWorkflowNoMatchText);
    const provenance = createProvenance("channel", `channel:${params.channel}`, {
      channel: params.channel,
      sessionId: params.sessionId,
      sender: params.sender,
      routeSource: params.routed.source,
    });
    persistConversation({
      sessionId: params.sessionId,
      channel: params.channel,
      sender: params.sender,
      userMessage: params.rawMessage,
      assistantMessage: response,
      userMetadata: params.senderMetadata,
      assistantMetadata: {
        ...(params.senderMetadata ?? {}),
        routeSource: params.routed.source,
      },
      provenance,
      createdAt: params.createdAt,
    });
    await params.send(response).catch(() => {});
    return;
  }

  const resolved = await resolveChannelResponseWithFallback({
    routed: params.routed,
    rawMessage: params.rawMessage,
    sessionId: params.sessionId,
    agentId: params.agentId ?? defaultChannelAgentId(),
    onEmit: params.onEmit,
  });
  if (!resolved.responseText) return;

  const response = presentChannelResponse(params.channel, resolved.responseText);
  const provenance = createProvenance("channel", `channel:${params.channel}`, {
    channel: params.channel,
    sessionId: params.sessionId,
    sender: params.sender,
    workflowId: params.routed.workflowId ?? undefined,
    workflowName: params.routed.workflowName ?? undefined,
    routeSource: resolved.routeSource,
  });

  persistConversation({
    sessionId: params.sessionId,
    channel: params.channel,
    sender: params.sender,
    userMessage: params.rawMessage,
    assistantMessage: response,
    userMetadata: params.senderMetadata,
    assistantMetadata: {
      ...(params.senderMetadata ?? {}),
      workflowId: params.routed.workflowId,
      workflowName: params.routed.workflowName,
      routeSource: resolved.routeSource,
      ...(resolved.fallbackAssistant ? { fallbackAssistant: resolved.fallbackAssistant } : {}),
      ...(resolved.sessionSnapshot ? { sessionSnapshot: resolved.sessionSnapshot } : {}),
    },
    provenance,
    createdAt: params.createdAt,
  });

  await params.send(response).catch(() => {});
}

function isEnabled(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

async function withChannelActivity(params: {
  label: string;
  start: () => Promise<void>;
  stop?: () => Promise<void>;
  keepaliveMs?: number;
  maxConsecutiveFailures?: number;
  maxDurationMs?: number;
  task: () => Promise<void>;
}): Promise<void> {
  const controller = createChannelActivityController({
    label: params.label,
    start: params.start,
    stop: params.stop,
    keepaliveMs: params.keepaliveMs,
    maxConsecutiveFailures: params.maxConsecutiveFailures ?? 2,
    maxDurationMs: params.maxDurationMs ?? 90_000,
    onStartFailure: (error, failureCount) => {
      const payload = {
        label: params.label,
        failureCount,
        error: String(error),
      };
      if (failureCount >= (params.maxConsecutiveFailures ?? 2)) {
        log.warn("Channel activity start failed", payload);
        return;
      }
      log.debug("Channel activity start failed", payload);
    },
    onStopFailure: (error) => {
      log.debug("Channel activity stop failed", {
        label: params.label,
        error: String(error),
      });
    },
  });
  await controller.run(params.task);
}

export function bindTelegramHandler(): void {
  onTelegramMessage(async (data) => {
    await withChannelActivity({
      label: `telegram:${data.chatId}`,
      start: () => sendTelegramTyping(data.chatId),
      keepaliveMs: 4000,
      task: async () => {
        const allowed = await enforceChannelSenderAccess({
          channel: "telegram",
          subjectKey: data.senderId || data.sender,
          subjectLabel: data.sender,
          reply: (message) => sendTelegramMessage(data.chatId, message),
        });
        if (!allowed) return;
        const now = new Date().toISOString();
        if (await maybeHandleByTheWayMessage({
          rawMessage: data.message,
          sessionId: `telegram:${data.chatId}`,
          channel: "telegram",
          send: (message) => sendTelegramMessage(data.chatId, message),
        })) {
          return;
        }
        const ingressProvenance = createProvenance("channel", "channel:telegram", {
          channel: "telegram",
          sessionId: `telegram:${data.chatId}`,
          sender: data.sender,
          routeSource: "telegram-runtime",
        });
        const replyStream = createTelegramReplyStream(data.chatId);
        const onEmit = (event: string, payload: unknown) => {
          if (event !== "stream:token") return;
          const token = typeof payload === "object" && payload !== null && "token" in payload
            ? String((payload as { token?: unknown }).token ?? "")
            : "";
          if (token) {
            void replyStream.pushToken(token);
          }
        };
        const result = await routeToWorkflowWithDetails({
          triggerNodeType: "telegram-trigger",
          channel: "telegram",
          provenance: ingressProvenance,
          triggerData: {
            message: data.message,
            sender: data.sender,
            senderId: data.senderId,
            chatId: data.chatId,
            channel: "telegram",
            timestamp: now,
            attachments: data.attachments,
          },
          onEmit,
        });
        await deliverResolvedChannelReply({
          routed: result,
          rawMessage: data.message,
          sessionId: `telegram:${data.chatId}`,
          channel: "telegram",
          sender: data.sender,
          senderMetadata: { chatId: data.chatId, senderId: data.senderId, attachments: data.attachments },
          createdAt: now,
          send: (message) => replyStream.finalize(message),
          onEmit,
        });
      },
    });
  });
}

export function bindDiscordHandler(): void {
  onDiscordMessage(async (data) => {
    await withChannelActivity({
      label: `discord:${data.channelId}`,
      start: () => sendDiscordTyping(data.channelId),
      keepaliveMs: 8000,
      task: async () => {
        const allowed = await enforceChannelSenderAccess({
          channel: "discord",
          subjectKey: data.senderId || data.sender,
          subjectLabel: data.sender,
          reply: (message) => sendDiscordMessage(data.channelId, message),
        });
        if (!allowed) return;
        const now = new Date().toISOString();
        if (await maybeHandleByTheWayMessage({
          rawMessage: data.message,
          sessionId: `discord:${data.channelId}`,
          channel: "discord",
          send: (message) => sendDiscordMessage(data.channelId, message),
        })) {
          return;
        }
        const ingressProvenance = createProvenance("channel", "channel:discord", {
          channel: "discord",
          sessionId: `discord:${data.channelId}`,
          sender: data.sender,
          routeSource: "discord-runtime",
        });
        const result = await routeToWorkflowWithDetails({
          triggerNodeType: "discord-trigger",
          channel: "discord",
          provenance: ingressProvenance,
          triggerData: {
            message: data.message,
            sender: data.sender,
            senderId: data.senderId,
            channelId: data.channelId,
            guildId: data.guildId,
            channel: "discord",
            timestamp: now,
            attachments: data.attachments,
          },
        });
        await deliverResolvedChannelReply({
          routed: result,
          rawMessage: data.message,
          sessionId: `discord:${data.channelId}`,
          channel: "discord",
          sender: data.sender,
          senderMetadata: {
            channelId: data.channelId,
            guildId: data.guildId,
            senderId: data.senderId,
            attachments: data.attachments,
          },
          createdAt: now,
          send: (message) => sendDiscordMessage(data.channelId, message),
        });
      },
    });
  });
}

export function bindWhatsAppHandler(): void {
  onWhatsAppMessage(async (data) => {
    await withChannelActivity({
      label: `whatsapp:${data.sender}`,
      start: () => sendWhatsAppTyping(data.sender),
      stop: () => sendWhatsAppPaused(data.sender),
      keepaliveMs: 4000,
      task: async () => {
        const allowed = await enforceChannelSenderAccess({
          channel: "whatsapp",
          subjectKey: data.senderId || data.sender,
          subjectLabel: data.sender,
          reply: (message) => sendWhatsAppMessage(data.sender, message),
        });
        if (!allowed) return;
        const now = new Date().toISOString();
        if (await maybeHandleByTheWayMessage({
          rawMessage: data.message,
          sessionId: `whatsapp:${data.sender}`,
          channel: "whatsapp",
          send: (message) => sendWhatsAppMessage(data.sender, message),
        })) {
          return;
        }
        const ingressProvenance = createProvenance("channel", "channel:whatsapp", {
          channel: "whatsapp",
          sessionId: `whatsapp:${data.sender}`,
          sender: data.sender,
          routeSource: "whatsapp-runtime",
        });
        const result = await routeToWorkflowWithDetails({
          triggerNodeType: "message-trigger",
          channel: "whatsapp",
          provenance: ingressProvenance,
          triggerData: {
            message: data.message,
            sender: data.sender,
            senderId: data.senderId,
            channel: "whatsapp",
            timestamp: now,
          },
        });
        await deliverResolvedChannelReply({
          routed: result,
          rawMessage: data.message,
          sessionId: `whatsapp:${data.sender}`,
          channel: "whatsapp",
          sender: data.sender,
          senderMetadata: { sender: data.sender, senderId: data.senderId },
          createdAt: now,
          send: (message) => sendWhatsAppMessage(data.sender, message),
        });
      },
    });
  });
}

export function bindSlackHandler(): void {
  onSlackMessage(async (data) => {
    const allowed = await enforceChannelSenderAccess({
      channel: "slack",
      subjectKey: data.senderId || data.sender,
      subjectLabel: data.sender,
      reply: (message) => sendSlackMessage(data.channelId, message),
    });
    if (!allowed) return;
    const now = new Date().toISOString();
    if (await maybeHandleByTheWayMessage({
      rawMessage: data.message,
      sessionId: `slack:${data.channelId}`,
      channel: "slack",
      send: (message) => sendSlackMessage(data.channelId, message),
    })) {
      return;
    }
    const ingressProvenance = createProvenance("channel", "channel:slack", {
      channel: "slack",
      sessionId: `slack:${data.channelId}`,
      sender: data.sender,
      routeSource: "slack-runtime",
    });
    const result = await routeToWorkflowWithDetails({
      triggerNodeType: "slack-trigger",
      channel: "slack",
      provenance: ingressProvenance,
      triggerData: {
        message: data.message,
        sender: data.sender,
        senderId: data.senderId,
        channelId: data.channelId,
        channel: "slack",
        timestamp: now,
        attachments: data.attachments,
      },
    });
    await deliverResolvedChannelReply({
      routed: result,
      rawMessage: data.message,
      sessionId: `slack:${data.channelId}`,
      channel: "slack",
      sender: data.sender,
      senderMetadata: { channelId: data.channelId, senderId: data.senderId, attachments: data.attachments },
      createdAt: now,
      send: (message) => sendSlackMessage(data.channelId, message),
    });
  });
}

export function bindBlueBubblesHandler(): void {
  onBlueBubblesMessage(async (data) => {
    const allowed = await enforceChannelSenderAccess({
      channel: "bluebubbles",
      subjectKey: data.senderId || data.sender,
      subjectLabel: data.sender,
      reply: (message) => sendBlueBubblesMessage(data.chatGuid, message),
    });
    if (!allowed) return;
    const now = new Date().toISOString();
    if (await maybeHandleByTheWayMessage({
      rawMessage: data.message,
      sessionId: `bluebubbles:${data.chatGuid}`,
      channel: "bluebubbles",
      send: (message) => sendBlueBubblesMessage(data.chatGuid, message),
    })) {
      return;
    }
    const ingressProvenance = createProvenance("channel", "channel:bluebubbles", {
      channel: "bluebubbles",
      sessionId: `bluebubbles:${data.chatGuid}`,
      sender: data.sender,
      routeSource: "bluebubbles-runtime",
    });
    const result = await routeToWorkflowWithDetails({
      triggerNodeType: "bluebubbles-trigger",
      channel: "bluebubbles",
      provenance: ingressProvenance,
      triggerData: {
        message: data.message,
        sender: data.sender,
        senderId: data.senderId,
        chatGuid: data.chatGuid,
        channel: "bluebubbles",
        timestamp: now,
      },
    });
    await deliverResolvedChannelReply({
      routed: result,
      rawMessage: data.message,
      sessionId: `bluebubbles:${data.chatGuid}`,
      channel: "bluebubbles",
      sender: data.sender,
      senderMetadata: { chatGuid: data.chatGuid, senderId: data.senderId },
      createdAt: now,
      send: (message) => sendBlueBubblesMessage(data.chatGuid, message),
    });
  });
}

export function bindTeamsHandler(): void {
  onTeamsMessage(async (data) => {
    await withChannelActivity({
      label: `teams:${data.conversationId}`,
      start: () => sendTeamsTyping(data.serviceUrl, data.conversationId),
      keepaliveMs: 4000,
      task: async () => {
        const allowed = await enforceChannelSenderAccess({
          channel: "teams",
          subjectKey: data.senderId || data.sender,
          subjectLabel: data.sender,
          reply: (message) => sendTeamsMessage(data.serviceUrl, data.conversationId, message),
        });
        if (!allowed) return;
        const now = new Date().toISOString();
        if (await maybeHandleByTheWayMessage({
          rawMessage: data.message,
          sessionId: `teams:${data.conversationId}`,
          channel: "teams",
          send: (message) => sendTeamsMessage(data.serviceUrl, data.conversationId, message),
        })) {
          return;
        }
        const ingressProvenance = createProvenance("channel", "channel:teams", {
          channel: "teams",
          sessionId: `teams:${data.conversationId}`,
          sender: data.sender,
          routeSource: "teams-runtime",
        });
        const result = await routeToWorkflowWithDetails({
          triggerNodeType: "teams-trigger",
          channel: "teams",
          provenance: ingressProvenance,
          triggerData: {
            message: data.message,
            sender: data.sender,
            senderId: data.senderId,
            conversationId: data.conversationId,
            serviceUrl: data.serviceUrl,
            channel: "teams",
            timestamp: now,
          },
        });
        await deliverResolvedChannelReply({
          routed: result,
          rawMessage: data.message,
          sessionId: `teams:${data.conversationId}`,
          channel: "teams",
          sender: data.sender,
          senderMetadata: {
            conversationId: data.conversationId,
            serviceUrl: data.serviceUrl,
            senderId: data.senderId,
          },
          createdAt: now,
          send: (message) => sendTeamsMessage(data.serviceUrl, data.conversationId, message),
        });
      },
    });
  });
}

async function bootstrapChannelsFromEnvInternal(): Promise<void> {
  const telegramToken = String(resolveSecretValue("TELEGRAM_BOT_TOKEN") ?? process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
  const discordToken = String(process.env.DISCORD_BOT_TOKEN ?? "").trim();
  const whatsappAutoConnect = isEnabled(String(process.env.WHATSAPP_AUTO_CONNECT ?? ""));
  const slackBotToken = String(process.env.SLACK_BOT_TOKEN ?? "").trim();
  const slackAppToken = String(process.env.SLACK_APP_TOKEN ?? "").trim();
  const blueBubblesUrl = String(process.env.BLUEBUBBLES_URL ?? "").trim();
  const blueBubblesPassword = String(process.env.BLUEBUBBLES_PASSWORD ?? "").trim();
  const teamsAppId = String(process.env.TEAMS_APP_ID ?? "").trim();
  const teamsAppPassword = String(process.env.TEAMS_APP_PASSWORD ?? "").trim();

  if (telegramToken) {
    bindTelegramHandler();
    await startTelegram(telegramToken);
  }

  if (discordToken) {
    bindDiscordHandler();
    await startDiscord(discordToken);
  }

  if (whatsappAutoConnect) {
    bindWhatsAppHandler();
    await connectWhatsApp();
  }

  if (slackBotToken && slackAppToken) {
    bindSlackHandler();
    await startSlack(slackBotToken, slackAppToken);
  }

  if (blueBubblesUrl && blueBubblesPassword) {
    bindBlueBubblesHandler();
    await startBlueBubbles(blueBubblesUrl, blueBubblesPassword);
  }

  if (teamsAppId && teamsAppPassword) {
    configureTeams(teamsAppId, teamsAppPassword);
    bindTeamsHandler();
  }
}

export async function bootstrapChannelsFromEnv(): Promise<void> {
  if (!runtimeGlobal.__disp8chChannelBootstrapPromise) {
    runtimeGlobal.__disp8chChannelBootstrapPromise = bootstrapChannelsFromEnvInternal().catch((error) => {
      runtimeGlobal.__disp8chChannelBootstrapPromise = null;
      log.error("Channel bootstrap failed", { error: String(error) });
      throw error;
    });
  }

  try {
    await runtimeGlobal.__disp8chChannelBootstrapPromise;
  } catch {
    // Startup should stay non-fatal even if a channel token is invalid.
  }
}
