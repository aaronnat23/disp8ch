import { logger } from "@/lib/utils/logger";
import { getRetryPolicy, isRetryableChannelError, withRetry } from "@/lib/utils/retry";
import { presentChannelResponse } from "@/lib/channels/presentation";

const log = logger.child("channel:bluebubbles");

type MessageHandler = (data: {
  message: string;
  sender: string;
  senderId: string;
  chatGuid: string;
  channel: "bluebubbles";
}) => Promise<void>;

type BlueBubblesRuntimeState = {
  serverUrl: string;
  password: string;
  polling: boolean;
  pollTimer: ReturnType<typeof setInterval> | null;
  lastMessageTimestamp: number;
  messageHandler: MessageHandler | null;
};

function getBlueBubblesRuntimeState(): BlueBubblesRuntimeState {
  const scoped = globalThis as typeof globalThis & {
    __disp8chBlueBubblesRuntimeState?: BlueBubblesRuntimeState;
  };
  if (!scoped.__disp8chBlueBubblesRuntimeState) {
    scoped.__disp8chBlueBubblesRuntimeState = {
      serverUrl: "",
      password: "",
      polling: false,
      pollTimer: null,
      lastMessageTimestamp: Date.now(),
      messageHandler: null,
    };
  }
  return scoped.__disp8chBlueBubblesRuntimeState;
}

export function onBlueBubblesMessage(handler: MessageHandler) {
  getBlueBubblesRuntimeState().messageHandler = handler;
}

function buildUrl(state: BlueBubblesRuntimeState, path: string): string {
  const base = state.serverUrl.replace(/\/+$/, "");
  return `${base}/api/v1${path}?password=${encodeURIComponent(state.password)}`;
}

async function pollMessages(): Promise<void> {
  const state = getBlueBubblesRuntimeState();
  if (!state.polling || !state.messageHandler) return;

  try {
    const url = buildUrl(state, "/message");
    const params = new URLSearchParams({
      after: String(state.lastMessageTimestamp),
      sort: "DESC",
      limit: "20",
    });

    const response = await fetch(`${url}&${params.toString()}`);
    if (!response.ok) return;

    const body = (await response.json()) as {
      status: number;
      data: Array<{
        guid: string;
        text: string | null;
        isFromMe: boolean;
        handle?: { address?: string };
        chats?: Array<{ guid?: string }>;
        dateCreated: number;
      }>;
    };

    if (!body.data || !Array.isArray(body.data)) return;

    // Process messages newest-first, but we only want new ones
    const newMessages = body.data
      .filter((msg) => !msg.isFromMe && msg.text && msg.dateCreated > state.lastMessageTimestamp)
      .reverse(); // oldest first for processing order

    for (const msg of newMessages) {
      const sender = msg.handle?.address || "unknown";
      const chatGuid = msg.chats?.[0]?.guid || "";
      const text = msg.text || "";

      if (!text.trim()) continue;

      log.info("BlueBubbles message received", { sender, chatGuid });

      state.lastMessageTimestamp = Math.max(state.lastMessageTimestamp, msg.dateCreated);

      await state.messageHandler({ message: text, sender, senderId: sender, chatGuid, channel: "bluebubbles" }).catch(
        (err) => {
          log.error("BlueBubbles message handler error", { error: String(err) });
        },
      );
    }

    // Update timestamp even if no messages (prevents re-processing window)
    if (body.data.length > 0) {
      const maxTimestamp = Math.max(...body.data.map((m) => m.dateCreated));
      state.lastMessageTimestamp = Math.max(state.lastMessageTimestamp, maxTimestamp);
    }
  } catch (err) {
    log.error("BlueBubbles poll error", { error: String(err) });
  }
}

export async function startBlueBubbles(
  serverUrl: string,
  password: string,
): Promise<{ connected: boolean }> {
  const state = getBlueBubblesRuntimeState();

  if (state.polling) {
    await stopBlueBubbles();
  }

  state.serverUrl = serverUrl;
  state.password = password;
  state.lastMessageTimestamp = Date.now();
  state.polling = true;

  // Verify connection by fetching server info
  try {
    const infoUrl = buildUrl(state, "/server/info");
    const response = await fetch(infoUrl);
    if (!response.ok) {
      throw new Error(`BlueBubbles server returned HTTP ${response.status}`);
    }
    log.info("BlueBubbles connected", { serverUrl });
  } catch (err) {
    state.polling = false;
    throw new Error(`Cannot reach BlueBubbles server: ${String(err)}`);
  }

  // Start polling every 3 seconds
  state.pollTimer = setInterval(() => {
    pollMessages().catch(() => {});
  }, 3000);

  return { connected: true };
}

export async function stopBlueBubbles(): Promise<void> {
  const state = getBlueBubblesRuntimeState();
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
  state.polling = false;
  state.serverUrl = "";
  state.password = "";
  log.info("BlueBubbles disconnected");
}

export async function sendBlueBubblesMessage(chatGuid: string, text: string): Promise<void> {
  const state = getBlueBubblesRuntimeState();
  if (!state.polling) {
    throw new Error("BlueBubbles not connected");
  }

  const policy = getRetryPolicy();
  const presented = presentChannelResponse("bluebubbles", text);

  await withRetry(
    async () => {
      const url = buildUrl(state, "/message/text");
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chatGuid,
          message: presented,
          method: "private-api",
        }),
      });
      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        throw new Error(`BlueBubbles send failed: HTTP ${response.status} ${errText}`);
      }
    },
    {
      policy,
      shouldRetry: isRetryableChannelError,
      label: "bluebubbles.sendMessage",
    },
  );
}

export function getBlueBubblesStatus(): { connected: boolean; serverUrl: string } {
  const state = getBlueBubblesRuntimeState();
  return { connected: state.polling, serverUrl: state.serverUrl };
}
