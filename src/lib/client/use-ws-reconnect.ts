"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type ConnectionState = "connected" | "reconnecting" | "disconnected";

export interface UseWsReconnectOptions {
  wsUrl: string;
  onMessage?: (event: MessageEvent) => void;
  onReconnect?: () => void;
  enabled?: boolean;
}

export function useWsReconnect(opts: UseWsReconnectOptions) {
  const { wsUrl, onMessage, onReconnect, enabled = true } = opts;
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const wsRef = useRef<WebSocket | null>(null);
  const attemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const maxBackoff = 30_000;

  const connect = useCallback(() => {
    if (!enabled) return;
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnectionState("connected");
      attemptRef.current = 0;
      onReconnect?.();
    };

    ws.onclose = () => {
      if (enabled && wsRef.current === ws) {
        setConnectionState("reconnecting");
        const delay = Math.min(1000 * Math.pow(2, attemptRef.current), maxBackoff);
        attemptRef.current++;
        reconnectTimerRef.current = setTimeout(connect, delay);
      }
    };

    ws.onerror = () => { ws.close(); };

    ws.onmessage = (event) => {
      onMessage?.(event);
    };
  }, [wsUrl, onMessage, onReconnect, enabled]);

  useEffect(() => {
    connect();
    return () => {
      wsRef.current?.close();
      clearTimeout(reconnectTimerRef.current);
    };
  }, [connect]);

  return {
    connectionState,
    isConnected: connectionState === "connected",
    reconnect: connect,
  };
}
