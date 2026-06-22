import { logger } from "@/lib/utils/logger";
import { getRetryPolicy, isRetryableChannelError, withRetry } from "@/lib/utils/retry";
import { presentChannelResponse } from "@/lib/channels/presentation";
import { prepareTelegramHtmlChunks } from "@/lib/channels/telegram-format";
import { cacheChannelImage } from "@/lib/channels/media-cache";

const log = logger.child("channel:telegram");

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
  chatId: string;
  channel: "telegram";
  attachments?: ChannelAttachment[];
}) => Promise<void>;

type TelegramRuntimeState = {
  botInstance: import("grammy").Bot | null;
  botUsername: string;
  botToken: string;
  messageHandler: MessageHandler | null;
  typingFailureCount: number;
  typingSuspendedUntil: number;
};

function getTelegramRuntimeState(): TelegramRuntimeState {
  const scoped = globalThis as typeof globalThis & {
    __disp8chTelegramRuntimeState?: TelegramRuntimeState;
  };
  if (!scoped.__disp8chTelegramRuntimeState) {
    scoped.__disp8chTelegramRuntimeState = {
      botInstance: null,
      botUsername: "",
      botToken: "",
      messageHandler: null,
      typingFailureCount: 0,
      typingSuspendedUntil: 0,
    };
  }
  return scoped.__disp8chTelegramRuntimeState;
}

function computeTypingBackoffMs(failureCount: number): number {
  return Math.min(300_000, 1000 * (2 ** Math.max(0, failureCount - 1)));
}

function isRetryableTypingError(error: unknown): boolean {
  const message = String(error || "").toLowerCase();
  return message.includes("401") || message.includes("unauthorized") || message.includes("429") || message.includes("too many requests");
}

export function onTelegramMessage(handler: MessageHandler) {
  getTelegramRuntimeState().messageHandler = handler;
}

export async function startTelegram(token: string): Promise<{ username: string }> {
  const state = getTelegramRuntimeState();

  if (state.botInstance) {
    await stopTelegram();
  }

  state.botToken = token;

  const { Bot } = await import("grammy");
  const bot = new Bot(token);

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text || "";
    const sender = ctx.from?.username || ctx.from?.first_name || String(ctx.from?.id || "");
    const senderId = String(ctx.from?.id || "");
    const chatId = String(ctx.chat.id);

    log.info("Telegram message received", { sender, chatId });

    const handler = getTelegramRuntimeState().messageHandler;
    if (handler) {
      await handler({ message: text, sender, senderId, chatId, channel: "telegram" }).catch((err) => {
        log.error("Telegram message handler error", { error: String(err) });
      });
    }
  });

  bot.on("message:photo", async (ctx) => {
    const message = ctx.message;
    if (!message.photo || !Array.isArray(message.photo) || message.photo.length === 0) return;

    const largestPhoto = message.photo[message.photo.length - 1];
    const caption = message.caption || "";
    const sender = ctx.from?.username || ctx.from?.first_name || String(ctx.from?.id || "");
    const senderId = String(ctx.from?.id || "");
    const chatId = String(ctx.chat.id);

    let text = caption || "[Image]";
    const attachments: ChannelAttachment[] = [];

    try {
      const fileRes = await fetch(
        `https://api.telegram.org/bot${token}/getFile?file_id=${largestPhoto.file_id}`,
      );
      const fileData = (await fileRes.json()) as { ok?: boolean; result?: { file_path?: string } };
      if (fileData.ok && fileData.result?.file_path) {
        const downloadUrl = `https://api.telegram.org/file/bot${token}/${fileData.result.file_path}`;
        const cachedPath = await cacheChannelImage(downloadUrl, "telegram", String(message.message_id));
        attachments.push({
          type: "image",
          url: downloadUrl,
          localPath: cachedPath || undefined,
          caption: caption || undefined,
        });
        text = caption || "[Image]";
      }
    } catch (err) {
      log.warn("Telegram photo download failed", { error: String(err) });
      text = caption || "[Image (could not download)]";
    }

    log.info("Telegram photo received", { sender, chatId, caption: caption || "(none)" });

    const handler = getTelegramRuntimeState().messageHandler;
    if (handler) {
      await handler({
        message: text,
        sender,
        senderId,
        chatId,
        channel: "telegram",
        attachments: attachments.length > 0 ? attachments : undefined,
      }).catch((err) => {
        log.error("Telegram photo handler error", { error: String(err) });
      });
    }
  });

  bot.on("message:document", async (ctx) => {
    const message = ctx.message;
    if (!message.document) return;

    const doc = message.document;
    const docName = doc.file_name || "document";
    const caption = message.caption || "";
    const sender = ctx.from?.username || ctx.from?.first_name || String(ctx.from?.id || "");
    const senderId = String(ctx.from?.id || "");
    const chatId = String(ctx.chat.id);

    const attachments: ChannelAttachment[] = [];
    attachments.push({
      type: "document",
      name: docName,
      mimeType: doc.mime_type,
      fileId: doc.file_id,
      fileSize: doc.file_size,
    });

    log.info("Telegram document received", { sender, chatId, docName });

    const handler = getTelegramRuntimeState().messageHandler;
    if (handler) {
      await handler({
        message: caption || `[Document: ${docName}]`,
        sender,
        senderId,
        chatId,
        channel: "telegram",
        attachments,
      }).catch((err) => {
        log.error("Telegram document handler error", { error: String(err) });
      });
    }
  });

  // Get bot info
  const me = await bot.api.getMe();
  state.botUsername = me.username || "";

  // Start bot in the background
  bot.start({
    onStart: () => {
      log.info("Telegram bot started", { username: state.botUsername });
    },
  }).catch((err) => {
    const currentState = getTelegramRuntimeState();
    // stopTelegram() aborts Grammy's long-poll delay. That is an expected
    // shutdown path, and a stale bot must never clear a newer replacement.
    if (currentState.botInstance !== bot) return;
    if (!String(err).toLowerCase().includes("aborted delay")) {
      log.error("Telegram bot error", { error: String(err) });
    }
    currentState.botInstance = null;
    currentState.botUsername = "";
  });

  state.botInstance = bot;
  return { username: state.botUsername };
}

export async function stopTelegram(): Promise<void> {
  const state = getTelegramRuntimeState();
  if (state.botInstance) {
    await state.botInstance.stop();
    state.botInstance = null;
    state.botUsername = "";
    state.botToken = "";
    log.info("Telegram bot stopped");
  }
}

export async function sendTelegramTyping(chatId: string): Promise<void> {
  const state = getTelegramRuntimeState();
  const { botInstance } = state;
  if (!botInstance) return;
  if (state.typingSuspendedUntil > Date.now()) {
    return;
  }
  try {
    await botInstance.api.sendChatAction(Number(chatId), "typing");
    if (state.typingFailureCount > 0) {
      log.info("Telegram typing recovered", {
        chatId,
        failures: state.typingFailureCount,
      });
    }
    state.typingFailureCount = 0;
    state.typingSuspendedUntil = 0;
  } catch (error) {
    if (isRetryableTypingError(error)) {
      state.typingFailureCount += 1;
      const backoffMs = computeTypingBackoffMs(state.typingFailureCount);
      state.typingSuspendedUntil = Date.now() + backoffMs;
      log.warn("Telegram typing failed; backing off", {
        chatId,
        backoffMs,
        failures: state.typingFailureCount,
        error: String(error),
      });
      return;
    }
    log.debug("Telegram typing failed", {
      chatId,
      error: String(error),
    });
  }
}

export async function sendTelegramMessage(chatId: string, text: string): Promise<void> {
  const { botInstance } = getTelegramRuntimeState();
  if (!botInstance) {
    throw new Error("Telegram bot not started");
  }
  const policy = getRetryPolicy();
  const presented = presentChannelResponse("telegram", text);
  const chunks = prepareTelegramHtmlChunks(presented);
  for (const chunk of chunks) {
    await withRetry(
      () =>
        botInstance!.api.sendMessage(chatId, chunk, {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        }),
      {
        policy,
        shouldRetry: isRetryableChannelError,
        label: "telegram.sendMessage",
      },
    );
  }
}

type TelegramMessageRef = {
  message_id?: number;
};

export type TelegramReplyStreamStats = {
  tokenCount: number;
  streamedChars: number;
  edits: number;
  chunksSent: number;
  startedAt: number;
  firstSendAt: number | null;
  finalizedAt: number | null;
};

export type TelegramReplyStream = {
  pushToken: (token: string) => Promise<void>;
  finalize: (text: string) => Promise<void>;
  hasStreamed: () => boolean;
  getStats: () => TelegramReplyStreamStats;
};

function isTelegramMessageNotModified(error: unknown): boolean {
  const message = String(error || "").toLowerCase();
  return message.includes("message is not modified");
}

export function createTelegramReplyStream(
  chatId: string,
  options?: {
    editIntervalMs?: number;
    minCharsBeforeFirstSend?: number;
  },
): TelegramReplyStream {
  const { botInstance } = getTelegramRuntimeState();
  if (!botInstance) {
    throw new Error("Telegram bot not started");
  }

  const policy = getRetryPolicy();
  const editIntervalMs = Math.max(500, options?.editIntervalMs ?? 1000);
  const minCharsBeforeFirstSend = Math.max(1, options?.minCharsBeforeFirstSend ?? 18);
  const stats: TelegramReplyStreamStats = {
    tokenCount: 0,
    streamedChars: 0,
    edits: 0,
    chunksSent: 0,
    startedAt: Date.now(),
    firstSendAt: null,
    finalizedAt: null,
  };
  let buffer = "";
  let messageId: number | null = null;
  let lastRendered = "";
  let lastEditAt = 0;
  let pendingEdit: Promise<void> = Promise.resolve();
  let finalized = false;

  const renderPreview = (text: string): string => {
    const presented = presentChannelResponse("telegram", text);
    const chunks = prepareTelegramHtmlChunks(presented);
    return chunks[0] || "";
  };

  const sendInitial = async (rendered: string): Promise<void> => {
    const sent = await withRetry(
      () =>
        botInstance!.api.sendMessage(chatId, rendered, {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        }) as Promise<TelegramMessageRef>,
      {
        policy,
        shouldRetry: isRetryableChannelError,
        label: "telegram.stream.sendMessage",
      },
    );
    messageId = typeof sent.message_id === "number" ? sent.message_id : null;
    stats.firstSendAt = Date.now();
    stats.chunksSent += 1;
    lastRendered = rendered;
    lastEditAt = Date.now();
  };

  const editExisting = async (rendered: string): Promise<void> => {
    if (!messageId || rendered === lastRendered) return;
    try {
      await withRetry(
        () =>
          botInstance!.api.editMessageText(chatId, messageId!, rendered, {
            parse_mode: "HTML",
            link_preview_options: { is_disabled: true },
          }),
        {
          policy,
          shouldRetry: (error) => isTelegramMessageNotModified(error) ? false : isRetryableChannelError(error),
          label: "telegram.stream.editMessageText",
        },
      );
      stats.edits += 1;
      lastRendered = rendered;
      lastEditAt = Date.now();
    } catch (error) {
      if (!isTelegramMessageNotModified(error)) throw error;
    }
  };

  const flushPreview = async (force = false): Promise<void> => {
    if (finalized || buffer.trim().length < minCharsBeforeFirstSend) return;
    const rendered = renderPreview(buffer);
    if (!rendered) return;
    if (!messageId) {
      await sendInitial(rendered);
      return;
    }
    const elapsed = Date.now() - lastEditAt;
    if (!force && elapsed < editIntervalMs) return;
    await editExisting(rendered);
  };

  const enqueue = (task: () => Promise<void>): Promise<void> => {
    pendingEdit = pendingEdit.then(task).catch((error) => {
      log.warn("Telegram progressive reply update failed", {
        chatId,
        error: String(error),
      });
    });
    return pendingEdit;
  };

  return {
    async pushToken(token: string) {
      if (finalized) return;
      const next = String(token || "");
      if (!next) return;
      buffer += next;
      stats.tokenCount += 1;
      stats.streamedChars += next.length;
      await enqueue(() => flushPreview(false));
    },
    async finalize(text: string) {
      finalized = true;
      await pendingEdit;
      const presented = presentChannelResponse("telegram", text);
      const chunks = prepareTelegramHtmlChunks(presented);
      if (chunks.length === 0) return;

      if (!messageId) {
        for (const chunk of chunks) {
          await withRetry(
            () =>
              botInstance!.api.sendMessage(chatId, chunk, {
                parse_mode: "HTML",
                link_preview_options: { is_disabled: true },
              }),
            {
              policy,
              shouldRetry: isRetryableChannelError,
              label: "telegram.stream.finalSendMessage",
            },
          );
          stats.chunksSent += 1;
          stats.firstSendAt = stats.firstSendAt ?? Date.now();
        }
      } else {
        await editExisting(chunks[0]!);
        for (const chunk of chunks.slice(1)) {
          await withRetry(
            () =>
              botInstance!.api.sendMessage(chatId, chunk, {
                parse_mode: "HTML",
                link_preview_options: { is_disabled: true },
              }),
            {
              policy,
              shouldRetry: isRetryableChannelError,
              label: "telegram.stream.finalExtraChunk",
            },
          );
          stats.chunksSent += 1;
        }
      }
      stats.finalizedAt = Date.now();
    },
    hasStreamed() {
      return stats.firstSendAt !== null;
    },
    getStats() {
      return { ...stats };
    },
  };
}

export function getTelegramStatus(): { connected: boolean; username: string } {
  const state = getTelegramRuntimeState();
  return { connected: state.botInstance !== null, username: state.botUsername };
}
