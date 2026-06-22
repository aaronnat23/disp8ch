import type { IncomingMessage } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { getConfiguredAllowedOriginHostnames, isAllowedBrowserOrigin } from "@/lib/security/origin";
import { isLoopbackHostname, isLoopbackRemoteAddress } from "@/lib/security/admin";
import { getUserFromCookieHeader } from "@/lib/security/session";
import { timingSafeStringEqual } from "@/lib/security/timing-safe";

// Keep ws on the pure-JS path. The optional native helper is not required for
// this lightweight local event server and has caused runtime shape mismatches.
process.env.WS_NO_BUFFER_UTIL = "1";

const PORT = parseInt(process.env.WS_PORT || "3101", 10);
const allowedOriginHostnames = getConfiguredAllowedOriginHostnames();
const configuredWsAuthToken = String(process.env.WS_AUTH_TOKEN || "").trim();

function parseRequestToken(req: IncomingMessage): string | null {
  const headerToken = req.headers["x-ws-auth"];
  if (typeof headerToken === "string" && headerToken.trim()) {
    return headerToken.trim();
  }
  const authHeader = req.headers.authorization;
  if (typeof authHeader === "string" && authHeader.toLowerCase().startsWith("bearer ")) {
    return authHeader.slice(7).trim();
  }
  try {
    const url = new URL(req.url || "/", `ws://${String(req.headers.host || "localhost")}`);
    const queryToken = url.searchParams.get("token");
    return queryToken?.trim() || null;
  } catch {
    return null;
  }
}

async function isAuthorizedSocket(origin: string | undefined, req: IncomingMessage): Promise<{ ok: boolean; reason?: string }> {
  const remoteLoopback = isLoopbackRemoteAddress(req.socket.remoteAddress);
  const host = String(req.headers.host || "");
  const token = parseRequestToken(req);
  if (configuredWsAuthToken && timingSafeStringEqual(token, configuredWsAuthToken)) {
    return { ok: true };
  }

  if (!origin) {
    if (configuredWsAuthToken) {
      return { ok: false, reason: "WebSocket auth required" };
    }
    return remoteLoopback ? { ok: true } : { ok: false, reason: "WebSocket auth required" };
  }

  if (
    !isAllowedBrowserOrigin({
      origin,
      requestHost: host,
      allowedOriginHostnames,
    })
  ) {
    return { ok: false, reason: "Origin rejected" };
  }

  if (remoteLoopback && isLoopbackHostname(host) && !configuredWsAuthToken) {
    return { ok: true };
  }

  const sessionUser = await getUserFromCookieHeader(
    typeof req.headers.cookie === "string" ? req.headers.cookie : null,
  );
  if (sessionUser) {
    return { ok: true };
  }

  return { ok: false, reason: "WebSocket auth required" };
}

const wss = new WebSocketServer({
  port: PORT,
  verifyClient: ({ origin, req }, done) => {
    void isAuthorizedSocket(origin, req).then((result) => {
      if (result.ok) {
        done(true);
        return;
      }
      done(false, 403, result.reason || "Forbidden");
    }).catch(() => {
      done(false, 403, "Forbidden");
    });
  },
});

const clients = new Set<WebSocket>();

wss.on("connection", (ws) => {
  clients.add(ws);
  process.stderr.write(`[WS] Client connected. Total: ${clients.size}\n`);

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
        return;
      }

      // Broadcast to all other clients
      for (const client of clients) {
        if (client !== ws && client.readyState === WebSocket.OPEN) {
          client.send(data.toString());
        }
      }
    } catch {
      // Ignore malformed messages
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    process.stderr.write(`[WS] Client disconnected. Total: ${clients.size}\n`);
  });

  ws.on("error", () => {
    clients.delete(ws);
  });
});

process.stderr.write(`[WS] WebSocket server running on ws://localhost:${PORT}\n`);

export function broadcast(event: string, data: unknown) {
  const msg = JSON.stringify({ type: event, data });
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}
