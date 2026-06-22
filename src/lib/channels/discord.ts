import { logger } from "@/lib/utils/logger";
import { getRetryPolicy, isRetryableChannelError, withRetry } from "@/lib/utils/retry";
import { presentChannelResponse } from "@/lib/channels/presentation";
import { cacheChannelImage } from "@/lib/channels/media-cache";

const log = logger.child("channel:discord");

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
  guildId: string;
  channel: "discord";
  attachments?: ChannelAttachment[];
}) => Promise<void>;

type DiscordRuntimeState = {
  clientInstance: import("discord.js").Client | null;
  messageHandler: MessageHandler | null;
};

function getDiscordRuntimeState(): DiscordRuntimeState {
  const scoped = globalThis as typeof globalThis & {
    __disp8chDiscordRuntimeState?: DiscordRuntimeState;
  };
  if (!scoped.__disp8chDiscordRuntimeState) {
    scoped.__disp8chDiscordRuntimeState = {
      clientInstance: null,
      messageHandler: null,
    };
  }
  return scoped.__disp8chDiscordRuntimeState;
}

export function onDiscordMessage(handler: MessageHandler) {
  getDiscordRuntimeState().messageHandler = handler;
}

export async function startDiscord(token: string): Promise<{ username: string }> {
  const state = getDiscordRuntimeState();

  if (state.clientInstance) {
    await stopDiscord();
  }

  const { Client, GatewayIntentBits } = await import("discord.js");

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
  });

  client.on("messageCreate", async (msg) => {
    // Skip bot messages
    if (msg.author.bot) return;

    const message = msg.content;
    const sender = msg.author.username;
    const senderId = msg.author.id;
    const channelId = msg.channel.id;
    const guildId = msg.guild?.id || "";

    const attachments: ChannelAttachment[] = [];
    if (msg.attachments && typeof msg.attachments.size === "number" && msg.attachments.size > 0) {
      const attArray = [...msg.attachments.values()];
      const imageAttachments = attArray.filter(
        (a) =>
          a.contentType?.startsWith("image/") ||
          a.url?.match(/\.(png|jpg|jpeg|gif|webp)(\?|$)/i),
      );
      const otherAttachments = attArray.filter(
        (a) =>
          !a.contentType?.startsWith("image/") &&
          !a.url?.match(/\.(png|jpg|jpeg|gif|webp)(\?|$)/i),
      );

      for (const att of imageAttachments) {
        const cachedPath = await cacheChannelImage(att.url, "discord", msg.id);
        attachments.push({
          type: "image",
          url: att.url,
          localPath: cachedPath || undefined,
          name: att.name || undefined,
          size: att.size,
        });
      }
      for (const att of otherAttachments) {
        attachments.push({
          type: "file",
          url: att.url,
          name: att.name || undefined,
          size: att.size,
        });
      }
    }

    log.info("Discord message received", { sender, channelId, guildId });

    // Check if this message is in a bound coding-agent thread — route to that session
    try {
      const { resolveDiscordThreadSession, setCurrentDiscordContext } =
        await import("@/lib/sessions/coding-agent-registry") as
          typeof import("@/lib/sessions/coding-agent-registry");
      const boundSessionId = resolveDiscordThreadSession(channelId);
      if (boundSessionId) {
        setCurrentDiscordContext({ channelId, guildId });
        await handleBoundThreadMessage(message, boundSessionId, channelId).catch((err) => {
          log.error("Discord bound-thread handler error", { error: String(err) });
        });
        setCurrentDiscordContext(null);
        return;
      }
    } catch { /* registry not available — fall through */ }

    const handler = getDiscordRuntimeState().messageHandler;
    if (handler) {
      const effectiveMessage = message || (attachments.length > 0 ? "[Attachment]" : "");
      const atts = attachments.length > 0 ? attachments : undefined;
      // Set Discord context so sessions_spawn can create threads
      try {
        const { setCurrentDiscordContext } =
          await import("@/lib/sessions/coding-agent-registry") as
            typeof import("@/lib/sessions/coding-agent-registry");
        setCurrentDiscordContext({ channelId, guildId });
        await handler({ message: effectiveMessage, sender, senderId, channelId, guildId, channel: "discord", attachments: atts }).catch((err) => {
          log.error("Discord message handler error", { error: String(err) });
        });
        setCurrentDiscordContext(null);
      } catch {
        await handler({ message: effectiveMessage, sender, senderId, channelId, guildId, channel: "discord", attachments: atts }).catch((err) => {
          log.error("Discord message handler error", { error: String(err) });
        });
      }
    }
  });

  client.on("error", (err) => {
    log.error("Discord client error", { error: String(err) });
  });

  await client.login(token);
  state.clientInstance = client;

  const username = client.user?.username || "";
  log.info("Discord bot started", { username });

  return { username };
}

export async function stopDiscord(): Promise<void> {
  const state = getDiscordRuntimeState();
  if (state.clientInstance) {
    state.clientInstance.destroy();
    state.clientInstance = null;
    log.info("Discord bot stopped");
  }
}

export async function sendDiscordTyping(channelId: string): Promise<void> {
  const { clientInstance } = getDiscordRuntimeState();
  if (!clientInstance) return;
  try {
    const channel = clientInstance.channels.cache.get(channelId);
    if (channel && channel.isTextBased() && "sendTyping" in channel) {
      await (channel as import("discord.js").TextChannel).sendTyping();
    }
  } catch {
    // Ignore — typing indicator is best-effort
  }
}

export async function sendDiscordMessage(channelId: string, text: string): Promise<void> {
  const { clientInstance } = getDiscordRuntimeState();
  if (!clientInstance) {
    throw new Error("Discord bot not started");
  }
  const presented = presentChannelResponse("discord", text);

  const channel = clientInstance.channels.cache.get(channelId);
  if (!channel || !channel.isSendable()) {
    throw new Error(`Channel ${channelId} not found or not a sendable channel`);
  }

  const MAX_LENGTH = 2000;
  const policy = getRetryPolicy();
  if (presented.length <= MAX_LENGTH) {
    await withRetry(
      async () => {
        await channel.send(presented);
      },
      { policy, shouldRetry: isRetryableChannelError, label: "discord.sendMessage" },
    );
    return;
  }

  // Split at newline boundaries to keep chunks readable
  const chunks: string[] = [];
  let remaining = presented;
  while (remaining.length > MAX_LENGTH) {
    let splitAt = remaining.lastIndexOf("\n", MAX_LENGTH);
    if (splitAt <= 0) splitAt = MAX_LENGTH;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);

  for (const chunk of chunks) {
    await withRetry(
      async () => {
        await channel.send(chunk);
      },
      { policy, shouldRetry: isRetryableChannelError, label: "discord.sendChunk" },
    );
  }
}

export function getDiscordStatus(): { connected: boolean; username: string } {
  const { clientInstance } = getDiscordRuntimeState();
  return {
    connected: clientInstance !== null && clientInstance.isReady(),
    username: clientInstance?.user?.username || "",
  };
}

/**
 * Create a Discord thread in the given channel for a coding-agent session.
 * Returns the thread's channel ID (used as the binding key), or null on failure.
 */
export async function createCodingAgentDiscordThread(
  parentChannelId: string,
  label: string,
  sessionId: string,
): Promise<string | null> {
  const { clientInstance } = getDiscordRuntimeState();
  if (!clientInstance) return null;

  try {
    const channel = clientInstance.channels.cache.get(parentChannelId);
    if (!channel) return null;

    // TextChannel supports threads
    const tc = channel as import("discord.js").TextChannel;
    if (typeof tc.threads?.create !== "function") return null;

    const threadName = `[Agent] ${label}`.slice(0, 100);
    const thread = await tc.threads.create({
      name: threadName,
      autoArchiveDuration: 60, // auto-archive after 1h of inactivity
      reason: `Coding agent session: ${sessionId}`,
    });

    await thread.send(
      `🤖 **Coding Agent Thread**\nSession: \`${sessionId}\`\nLabel: ${label}\n\nSend messages here to steer this session.`,
    );

    log.info("Created coding agent Discord thread", { threadId: thread.id, sessionId, label });
    return thread.id;
  } catch (err) {
    log.error("Failed to create coding agent Discord thread", { error: String(err) });
    return null;
  }
}

/**
 * Handle a message from a bound coding-agent thread — resume the session with the message.
 */
async function handleBoundThreadMessage(
  message: string,
  sessionId: string,
  threadChannelId: string,
): Promise<void> {
  const { clientInstance } = getDiscordRuntimeState();
  if (!clientInstance) return;

  log.info("Routing message to bound coding agent session", { sessionId, threadChannelId });

  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);

    const { findClaudeBinary } =
      await import("@/lib/sessions/coding-agent-registry") as
        typeof import("@/lib/sessions/coding-agent-registry");
    const claudeBin = findClaudeBinary();

    const { stdout } = await execFileAsync(
      claudeBin,
      ["--print", "--output-format", "json", "--resume", sessionId, message],
      { cwd: process.cwd(), timeout: 120000, maxBuffer: 4 * 1024 * 1024 },
    );

    let reply = stdout.trim();
    try {
      const parsed = JSON.parse(stdout) as { result?: string; is_error?: boolean };
      reply = parsed.result ?? stdout.trim();
      if (parsed.is_error) reply = `Error: ${reply}`;
    } catch { /* raw text */ }

    // Touch session last-used
    const { touchCodingAgentSession } =
      await import("@/lib/sessions/coding-agent-registry") as
        typeof import("@/lib/sessions/coding-agent-registry");
    touchCodingAgentSession(sessionId);

    // Send reply to the thread
    await sendDiscordMessage(threadChannelId, reply || "(no response)");
  } catch (err) {
    log.error("Bound thread session error", { error: String(err), sessionId });
    await sendDiscordMessage(threadChannelId, `Error routing to session: ${String(err)}`).catch(() => undefined);
  }
}
