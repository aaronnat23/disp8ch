"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useExecutionStore } from "@/stores/execution-store";
import { useNavigationApiAbort } from "@/lib/client/use-navigation-api-abort";

export function Providers({ children }: { children: React.ReactNode }) {
  const {
    setWsConnected,
    appendStreamToken,
    finalizeStream,
    addLogEntry,
    setActiveNodeId,
  } = useExecutionStore();
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const pathname = usePathname();
  useNavigationApiAbort(pathname);

  useEffect(() => {
    let isUnmounted = false;

    const clearReconnectTimer = () => {
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };

    const connect = () => {
      if (isUnmounted) return;
      clearReconnectTimer();

      const protocol = window.location.protocol === "https:" ? "wss" : "ws";
      const fallbackPort = (() => {
        const currentPort = parseInt(window.location.port || "3100", 10);
        return Number.isNaN(currentPort) ? "3101" : String(currentPort + 1);
      })();
      const wsPort = fallbackPort;

      const ws = new WebSocket(`${protocol}://${window.location.hostname}:${wsPort}`);
      wsRef.current = ws;

      ws.onopen = () => {
        setWsConnected(true);
      };

      ws.onerror = () => {
        setWsConnected(false);
      };

      ws.onclose = () => {
        setWsConnected(false);
        if (!isUnmounted) {
          clearReconnectTimer();
          reconnectTimerRef.current = window.setTimeout(connect, 2000);
        }
      };

      ws.onmessage = (event: MessageEvent) => {
        try {
          const msg = JSON.parse(event.data as string) as {
            type: string;
            data?: Record<string, unknown>;
          };

          if (msg.type === "stream:token" && msg.data) {
            const nodeId = msg.data.nodeId as string;
            const token = msg.data.token as string;
            appendStreamToken(nodeId, token);
          } else if (msg.type === "node:active" && msg.data) {
            setActiveNodeId(msg.data.nodeId as string);
          } else if (msg.type === "execution:log" && msg.data) {
            addLogEntry({
              timestamp: (msg.data.timestamp as string) || new Date().toISOString(),
              nodeId: (msg.data.nodeId as string) || "",
              nodeName: (msg.data.nodeName as string) || "",
              message: (msg.data.message as string) || "",
              type: (msg.data.type as "info" | "error" | "success" | "streaming") || "info",
            });
          } else if (msg.type === "stream:end" && msg.data) {
            finalizeStream(msg.data.nodeId as string);
          }
        } catch {
          // Ignore malformed messages
        }
      };
    };

    const needsLiveExecution =
      pathname.startsWith("/workflows") ||
      pathname.startsWith("/boards") ||
      pathname.startsWith("/activity");

    if (!needsLiveExecution) {
      wsRef.current?.close();
      wsRef.current = null;
      setWsConnected(false);
      return () => {
        isUnmounted = true;
        clearReconnectTimer();
      };
    }

    connect();

    return () => {
      isUnmounted = true;
      setWsConnected(false);
      clearReconnectTimer();
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [pathname, setWsConnected, appendStreamToken, finalizeStream, addLogEntry, setActiveNodeId]);

  return (
    <TooltipProvider>
      {children}
    </TooltipProvider>
  );
}
