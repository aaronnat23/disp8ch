import { logger } from "@/lib/utils/logger";

const log = logger.child("ws:broadcast");

const WS_PORT = parseInt(process.env.WS_PORT || "3101", 10);
const WS_AUTH_TOKEN = String(process.env.WS_AUTH_TOKEN || "").trim();
const WS_URL = (() => {
  const url = new URL(`ws://localhost:${WS_PORT}`);
  if (WS_AUTH_TOKEN) {
    url.searchParams.set("token", WS_AUTH_TOKEN);
  }
  return url.toString();
})();

type RealtimeSocket = {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event?: Event) => void): void;
};

let ws: RealtimeSocket | null = null;
let connecting = false;
const queue: string[] = [];
let reconnectAfter = 0;
let consecutiveSendFailures = 0;
let broadcastDisabled = false;

function getRealtimeWebSocketCtor():
  | (new (url: string) => RealtimeSocket)
  | null {
  if (typeof WebSocket === "function") {
    return WebSocket as unknown as new (url: string) => RealtimeSocket;
  }
  log.warn("Global WebSocket client is unavailable; disabling realtime broadcast");
  broadcastDisabled = true;
  return null;
}

function safeSend(client: RealtimeSocket, message: string): boolean {
  try {
    client.send(message);
    consecutiveSendFailures = 0;
    return true;
  } catch (error) {
    consecutiveSendFailures += 1;
    const backoffMs = Math.min(60_000, 2_000 * consecutiveSendFailures);
    reconnectAfter = Date.now() + backoffMs;
    log.warn("WS send failed; dropping realtime event", { error: String(error) });
    try {
      client.close(1011, "send failure");
    } catch {
      // Ignore close failures.
    }
    if (client === ws) ws = null;
    connecting = false;
    return false;
  }
}

function getClient(): RealtimeSocket | null {
  if (broadcastDisabled) return null;
  if (ws && ws.readyState === WebSocket.OPEN) return ws;
  if (connecting) return null;
  if (Date.now() < reconnectAfter) return null;

  const WebSocketCtor = getRealtimeWebSocketCtor();
  if (!WebSocketCtor) return null;

  connecting = true;
  let client: RealtimeSocket;
  try {
    client = new WebSocketCtor(WS_URL);
  } catch (error) {
    connecting = false;
    log.warn("Failed to create WS client for broadcast", { error: String(error) });
    return null;
  }

  client.addEventListener("open", () => {
    ws = client;
    connecting = false;
    reconnectAfter = 0;
    consecutiveSendFailures = 0;
    while (queue.length > 0) {
      const msg = queue.shift();
      if (msg && client.readyState === WebSocket.OPEN) {
        if (!safeSend(client, msg)) break;
      }
    }
  });

  client.addEventListener("close", () => {
    ws = null;
    connecting = false;
  });

  client.addEventListener("error", () => {
    ws = null;
    connecting = false;
  });

  return null;
}

export function broadcastEvent(type: string, data: unknown): void {
  if (broadcastDisabled) return;
  const msg = JSON.stringify({ type, data });
  const client = getClient();
  if (client && client.readyState === WebSocket.OPEN) {
    safeSend(client, msg);
  } else if (queue.length < 100) {
    queue.push(msg);
  }
}
