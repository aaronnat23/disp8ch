import { logger } from "@/lib/utils/logger";
import { getRetryPolicy, isRetryableChannelError, withRetry } from "@/lib/utils/retry";
import { presentChannelResponse } from "@/lib/channels/presentation";
import { buildSlackBlocksFallbackText, parseSlackBlocksJson } from "@/lib/channels/slack-blocks";
import { prepareSlackMrkdwnChunks } from "@/lib/channels/slack-format";
import { cacheChannelImage } from "@/lib/channels/media-cache";

const log = logger.child("channel:slack");

interface ChannelAttachment {
  type: "image" | "document" | "file";
  url?: string;
  localPath?: string;
  name?: string;
  caption?: string;
  mimeType?: string;
  fileId?: string;
  fileSize?: number;
  size?: number;
}

type MessageHandler = (data: {
  message: string;
  sender: string;
  senderId: string;
  channelId: string;
  channel: "slack";
  attachments?: ChannelAttachment[];
}) => Promise<void>;

type SlackRuntimeState = {
  webClient: import("@slack/web-api").WebClient | null;
  socketClient: import("@slack/socket-mode").SocketModeClient | null;
  botName: string;
  botToken: string;
  messageHandler: MessageHandler | null;
};

function getSlackRuntimeState(): SlackRuntimeState {
  const scoped = globalThis as typeof globalThis & {
    __disp8chSlackRuntimeState?: SlackRuntimeState;
  };
  if (!scoped.__disp8chSlackRuntimeState) {
    scoped.__disp8chSlackRuntimeState = {
      webClient: null,
      socketClient: null,
      botName: "",
      botToken: "",
      messageHandler: null,
    };
  }
  return scoped.__disp8chSlackRuntimeState!;
}

export function onSlackMessage(handler: MessageHandler) {
  getSlackRuntimeState().messageHandler = handler;
}

export async function startSlack(
  botToken: string,
  appToken: string,
): Promise<{ botName: string }> {
  const state = getSlackRuntimeState();

  if (state.socketClient) {
    await stopSlack();
  }

  const { WebClient } = await import("@slack/web-api");
  const { SocketModeClient } = await import("@slack/socket-mode");

  const web = new WebClient(botToken);
  const socket = new SocketModeClient({ appToken });

  // Listen for message events
  socket.on("message", async ({ event, body, ack }) => {
    await ack();

    const slackEvent = event as {
      bot_id?: string;
      subtype?: string;
      text?: string;
      user?: string;
      channel?: string;
      files?: Array<{
        id?: string;
        name?: string;
        title?: string;
        mimetype?: string;
        filetype?: string;
        url_private?: string;
        size?: number;
      }>;
    };

    // Skip bot messages, subtypes (edits, joins, etc.)
    if (slackEvent.bot_id || slackEvent.subtype) return;

    const text = String(slackEvent.text || "");
    const sender = String(slackEvent.user || "unknown");
    const channelId = String(slackEvent.channel || "");

    // Process Slack files
    const attachments: ChannelAttachment[] = [];
    if (slackEvent.files && Array.isArray(slackEvent.files) && slackEvent.files.length > 0) {
      for (const file of slackEvent.files) {
        const isImage =
          file.mimetype?.startsWith("image/") || file.filetype === "image";
        if (isImage && file.url_private) {
          const cachedPath = await cacheChannelImage(
            file.url_private,
            "slack",
            String(slackEvent.channel || ""),
            { Authorization: `Bearer ${state.botToken}` },
          );
          attachments.push({
            type: "image",
            url: file.url_private,
            localPath: cachedPath || undefined,
            name: file.title || file.name || "image",
            size: file.size,
          });
        } else if (file.url_private) {
          attachments.push({
            type: "file",
            url: file.url_private,
            name: file.title || file.name || "file",
            size: file.size,
            mimeType: file.mimetype,
          });
        }
      }
    }

    // Skip if there's no text and no files
    if (!text && attachments.length === 0) return;

    let effectiveMessage = text;
    if (!effectiveMessage && attachments.length > 0) {
      const imageCount = attachments.filter((a) => a.type === "image").length;
      const otherCount = attachments.length - imageCount;
      const parts: string[] = [];
      if (imageCount > 0) parts.push(`${imageCount} image${imageCount > 1 ? "s" : ""}`);
      if (otherCount > 0) parts.push(`${otherCount} file${otherCount > 1 ? "s" : ""}`);
      effectiveMessage = `[${parts.join(", ")}]`;
    }

    log.info("Slack message received", { sender, channelId });

    const handler = getSlackRuntimeState().messageHandler;
    if (handler) {
      await handler({
        message: effectiveMessage,
        sender,
        senderId: sender,
        channelId,
        channel: "slack",
        attachments: attachments.length > 0 ? attachments : undefined,
      }).catch((err) => {
        log.error("Slack message handler error", { error: String(err) });
      });
    }
  });

  // Get bot info
  const auth = await web.auth.test();
  state.botName = String(auth.user || "");

  await socket.start();

  state.webClient = web;
  state.socketClient = socket;
  state.botToken = botToken;
  log.info("Slack bot started", { botName: state.botName });

  return { botName: state.botName };
}

export async function stopSlack(): Promise<void> {
  const state = getSlackRuntimeState();
  if (state.socketClient) {
    await state.socketClient.disconnect();
    state.socketClient = null;
    state.webClient = null;
    state.botName = "";
    log.info("Slack bot stopped");
  }
}

export async function sendSlackMessage(
  channelId: string,
  text: string,
  options?: { blocks?: unknown },
): Promise<void> {
  const { webClient } = getSlackRuntimeState();
  if (!webClient) {
    throw new Error("Slack bot not started");
  }
  const policy = getRetryPolicy();
  const blocks = parseSlackBlocksJson(options?.blocks);
  const fallbackText = buildSlackBlocksFallbackText(blocks, text);
  const presented = presentChannelResponse("slack", fallbackText);
  if (blocks.length > 0) {
    await withRetry(
      () =>
        webClient!.chat.postMessage({
          channel: channelId,
          text: presented,
          blocks: blocks as never[],
        }),
      {
        policy,
        shouldRetry: isRetryableChannelError,
        label: "slack.postMessage.blocks",
      },
    );
    return;
  }
  const chunks = prepareSlackMrkdwnChunks(presented);
  for (const chunk of chunks) {
    await withRetry(
      () =>
        webClient!.chat.postMessage({
          channel: channelId,
          text: chunk,
        }),
      {
        policy,
        shouldRetry: isRetryableChannelError,
        label: "slack.postMessage",
      },
    );
  }
}

export function getSlackStatus(): { connected: boolean; botName: string } {
  const state = getSlackRuntimeState();
  return { connected: state.socketClient !== null, botName: state.botName };
}
