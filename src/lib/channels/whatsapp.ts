import { logger } from "@/lib/utils/logger";
import path from "node:path";
import fs from "node:fs";
import { getRetryPolicy, isRetryableChannelError, withRetry } from "@/lib/utils/retry";
import { chunkMessage } from "@/lib/channels/chunk";
import { presentChannelResponse } from "@/lib/channels/presentation";

const log = logger.child("whatsapp");

const AUTH_DIR = path.resolve("./data/whatsapp-auth");

export interface WhatsAppStatus {
  connected: boolean;
  phoneNumber?: string;
  qr?: string;
}

type WhatsAppInboundMessage = {
  conversation?: string | null;
  extendedTextMessage?: { text?: string | null } | null;
  imageMessage?: { caption?: string | null } | null;
  videoMessage?: { caption?: string | null } | null;
  documentMessage?: { caption?: string | null; fileName?: string | null } | null;
  buttonsResponseMessage?: { selectedDisplayText?: string | null } | null;
  listResponseMessage?: {
    title?: string | null;
    singleSelectReply?: { selectedRowId?: string | null } | null;
  } | null;
  locationMessage?: {
    degreesLatitude?: number | null;
    degreesLongitude?: number | null;
    name?: string | null;
    address?: string | null;
  } | null;
  liveLocationMessage?: {
    degreesLatitude?: number | null;
    degreesLongitude?: number | null;
    caption?: string | null;
  } | null;
};

type MessageHandler = (data: {
  message: string;
  sender: string;
  senderId: string;
  channel: "whatsapp";
}) => Promise<void>;

type QrHandler = (qr: string) => void;

type WhatsAppRuntimeState = {
  sock: import("@whiskeysockets/baileys").WASocket | null;
  statusState: WhatsAppStatus;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectAttempts: number;
  messageHandler: MessageHandler | null;
  qrHandler: QrHandler | null;
};

function getWhatsAppRuntimeState(): WhatsAppRuntimeState {
  const scoped = globalThis as typeof globalThis & {
    __disp8chWhatsAppRuntimeState?: WhatsAppRuntimeState;
  };
  if (!scoped.__disp8chWhatsAppRuntimeState) {
    scoped.__disp8chWhatsAppRuntimeState = {
      sock: null,
      statusState: { connected: false },
      reconnectTimer: null,
      reconnectAttempts: 0,
      messageHandler: null,
      qrHandler: null,
    };
  }
  return scoped.__disp8chWhatsAppRuntimeState;
}

export function onWhatsAppMessage(handler: MessageHandler) {
  getWhatsAppRuntimeState().messageHandler = handler;
}

export function onWhatsAppQr(handler: QrHandler) {
  getWhatsAppRuntimeState().qrHandler = handler;
}

export function getWhatsAppStatus(): WhatsAppStatus {
  return getWhatsAppRuntimeState().statusState;
}

function formatCoordinates(latitude: number | null | undefined, longitude: number | null | undefined): string {
  if (typeof latitude !== "number" || typeof longitude !== "number") return "";
  return `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
}

export function extractWhatsAppMessageText(message: WhatsAppInboundMessage | null | undefined): string {
  if (!message) return "";

  const text =
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.documentMessage?.caption ||
    message.documentMessage?.fileName ||
    message.buttonsResponseMessage?.selectedDisplayText ||
    message.listResponseMessage?.title ||
    message.listResponseMessage?.singleSelectReply?.selectedRowId ||
    "";
  if (text) return text.trim();

  if (message.locationMessage) {
    const label = [message.locationMessage.name, message.locationMessage.address].filter(Boolean).join(" - ");
    const coords = formatCoordinates(
      message.locationMessage.degreesLatitude,
      message.locationMessage.degreesLongitude,
    );
    return `Shared location${label ? `: ${label}` : ""}${coords ? ` (${coords})` : ""}`.trim();
  }

  if (message.liveLocationMessage) {
    const coords = formatCoordinates(
      message.liveLocationMessage.degreesLatitude,
      message.liveLocationMessage.degreesLongitude,
    );
    const caption = message.liveLocationMessage.caption?.trim();
    return `Shared live location${caption ? `: ${caption}` : ""}${coords ? ` (${coords})` : ""}`.trim();
  }

  return "";
}

export async function connectWhatsApp(): Promise<void> {
  const runtime = getWhatsAppRuntimeState();
  fs.mkdirSync(AUTH_DIR, { recursive: true });

  const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
  } = await import("@whiskeysockets/baileys");

  // eslint-disable-next-line react-hooks/rules-of-hooks
  const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  runtime.sock = makeWASocket({
    version,
    auth: authState,
    printQRInTerminal: false,
    logger: {
      level: "silent",
      trace: () => {},
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      fatal: () => {},
      child: () => ({
        level: "silent",
        trace: () => {},
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
        fatal: () => {},
        child: () => ({} as ReturnType<typeof logger.child>),
      }),
    } as unknown as Parameters<typeof makeWASocket>[0]["logger"],
  });

  runtime.sock.ev.on("creds.update", saveCreds);

  runtime.sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;
    const runtime = getWhatsAppRuntimeState();

    if (qr) {
      runtime.statusState = { ...runtime.statusState, qr };
      if (runtime.qrHandler) runtime.qrHandler(qr);
      log.info("WhatsApp QR code generated");
    }

    if (connection === "open") {
      runtime.statusState = { connected: true, phoneNumber: runtime.sock?.user?.id };
      runtime.reconnectAttempts = 0;
      log.info("WhatsApp connected", { phone: runtime.statusState.phoneNumber });
    }

    if (connection === "close") {
      runtime.statusState = { connected: false };
      const reason = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode;
      const shouldReconnect = reason !== DisconnectReason.loggedOut;

      log.warn("WhatsApp disconnected", { reason, shouldReconnect });

      if (shouldReconnect) {
        const delay = Math.min(1000 * Math.pow(2, runtime.reconnectAttempts), 30000);
        runtime.reconnectAttempts++;
        if (runtime.reconnectTimer) clearTimeout(runtime.reconnectTimer);
        runtime.reconnectTimer = setTimeout(() => {
          connectWhatsApp().catch((err) => {
            log.error("WhatsApp reconnect failed", { error: String(err) });
          });
        }, delay);
      }
    }
  });

  runtime.sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const text = extractWhatsAppMessageText(msg.message);
      if (!text) continue;

      const sender = msg.key.remoteJid || "";
      log.info("WhatsApp message received", { sender });

      const handler = getWhatsAppRuntimeState().messageHandler;
      if (handler) {
        await handler({
          message: text,
          sender,
          senderId: sender,
          channel: "whatsapp",
        }).catch((err) => {
          log.error("WhatsApp message handler error", { error: String(err) });
        });
      }
    }
  });
}

export async function disconnectWhatsApp(): Promise<void> {
  const state = getWhatsAppRuntimeState();
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  if (state.sock) {
    await state.sock.logout().catch(() => {});
    state.sock = null;
  }
  state.statusState = { connected: false };
  log.info("WhatsApp disconnected");
}

export function resetWhatsAppAuth(): void {
  try {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors; a fresh auth session can still be started.
  }
  getWhatsAppRuntimeState().statusState = { connected: false };
  log.info("WhatsApp auth state cleared");
}

export async function sendWhatsAppTyping(jid: string): Promise<void> {
  const { sock, statusState } = getWhatsAppRuntimeState();
  if (!sock || !statusState.connected) return;
  try {
    await sock.sendPresenceUpdate("composing", jid);
  } catch {
    // Ignore — typing indicator is best-effort
  }
}

export async function sendWhatsAppPaused(jid: string): Promise<void> {
  const { sock, statusState } = getWhatsAppRuntimeState();
  if (!sock || !statusState.connected) return;
  try {
    await sock.sendPresenceUpdate("paused", jid);
  } catch {
    // Ignore
  }
}

export async function sendWhatsAppMessage(
  to: string,
  message: string
): Promise<{ messageId: string; status: string }> {
  const { sock, statusState } = getWhatsAppRuntimeState();
  if (!sock || !statusState.connected) {
    return { messageId: "", status: "not_connected" };
  }

  const jid = to.includes("@") ? to : `${to}@s.whatsapp.net`;
  const policy = getRetryPolicy();
  const presented = presentChannelResponse("whatsapp", message);
  const chunks = chunkMessage(presented, 4000);

  try {
    let lastMessageId = "";
    for (const chunk of chunks) {
      const result = await withRetry(
        () => sock!.sendMessage(jid, { text: chunk }),
        {
          policy,
          shouldRetry: isRetryableChannelError,
          label: "whatsapp.sendMessage",
        },
      );
      lastMessageId = result?.key?.id || lastMessageId;
    }
    return { messageId: lastMessageId || `wa_${Date.now()}`, status: "sent" };
  } catch (error) {
    log.error("WhatsApp send failed", { to, error: String(error) });
    return { messageId: "", status: `error: ${String(error)}` };
  }
}

// Legacy alias
export function getWhatsAppState(): WhatsAppStatus {
  return getWhatsAppRuntimeState().statusState;
}
