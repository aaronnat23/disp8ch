import type { IncomingMessage } from "node:http";
import { WebSocketServer, WebSocket } from "ws";

process.env.WS_NO_BUFFER_UTIL = "1";

const port = Number(process.env.WS_PORT || 3101);
const uiPort = Number(process.env.PORT || 3100);
const authToken = String(process.env.WS_AUTH_TOKEN || "").trim();

function isLoopbackAddress(remoteAddress?: string | null): boolean {
  if (!remoteAddress) return false;
  return remoteAddress === "127.0.0.1" || remoteAddress === "::1" || remoteAddress === "::ffff:127.0.0.1";
}

function requestToken(req: IncomingMessage): string | null {
  const headerToken = req.headers["x-ws-auth"];
  if (typeof headerToken === "string" && headerToken.trim()) return headerToken.trim();
  const authHeader = req.headers.authorization;
  if (typeof authHeader === "string" && authHeader.toLowerCase().startsWith("bearer ")) {
    return authHeader.slice(7).trim();
  }
  try {
    const url = new URL(req.url || "/", `ws://${String(req.headers.host || "localhost")}`);
    return url.searchParams.get("token")?.trim() || null;
  } catch {
    return null;
  }
}

function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]") && Number(url.port || 80) === uiPort;
  } catch {
    return false;
  }
}

function authorize(origin: string | undefined, req: IncomingMessage): { ok: boolean; reason?: string } {
  if (!isLoopbackAddress(req.socket.remoteAddress)) return { ok: false, reason: "Loopback only" };
  if (authToken && requestToken(req) !== authToken) return { ok: false, reason: "WebSocket auth required" };
  if (!originAllowed(origin)) return { ok: false, reason: "Origin rejected" };
  return { ok: true };
}

const wss = new WebSocketServer({
  port,
  host: "127.0.0.1",
  verifyClient: ({ origin, req }, done) => {
    const result = authorize(origin, req);
    done(result.ok, result.ok ? undefined : 403, result.reason || "Forbidden");
  },
});

const clients = new Set<WebSocket>();

wss.on("connection", (ws) => {
  clients.add(ws);
  process.stderr.write(`[desktop-ws] client connected; total=${clients.size}\n`);

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
        return;
      }
      for (const client of clients) {
        if (client !== ws && client.readyState === WebSocket.OPEN) client.send(data.toString());
      }
    } catch {
      // Ignore malformed websocket messages.
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
  });
  ws.on("error", () => {
    clients.delete(ws);
  });
});

process.stderr.write(`[desktop-ws] listening on ws://127.0.0.1:${port}\n`);
