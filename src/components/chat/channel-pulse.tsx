"use client";

import { useState, useEffect } from "react";
import { Badge } from "@/components/ui/badge";
import { Activity, CheckCircle2, XCircle, PauseCircle, Loader2 } from "lucide-react";
import { usePolling } from "@/lib/client/use-polling";

type ChannelState = {
  channel: string;
  label: string;
  status: "connected" | "disconnected" | "off" | "error";
  pendingRequests?: number;
  message?: string;
};

export function ChannelPulse() {
  const [channels, setChannels] = useState<ChannelState[]>([]);
  const [collapsed, setCollapsed] = useState(true);

  const refreshPulse = async () => {
    try {
      const res = await fetch("/api/channels?action=status");
      const data = await res.json();
      if (data.success && data.data) {
        const states: ChannelState[] = [];
        const channelList = ["telegram", "discord", "slack", "whatsapp", "teams", "bluebubbles", "google-chat", "webchat"];
        for (const c of channelList) {
          const info = data.data[c];
          states.push({
            channel: c,
            label: c === "bluebubbles" ? "iMessage" : c === "google-chat" ? "Google Chat" : c.charAt(0).toUpperCase() + c.slice(1),
            status: info?.connected ? "connected" : info?.error ? "error" : info?.enabled ? "disconnected" : "off",
            pendingRequests: info?.pendingPairingCount,
            message: info?.error || info?.message,
          });
        }
        setChannels(states);
      }
    } catch { /* silent */ }
  };

  useEffect(() => {
    refreshPulse();
  }, []);

  usePolling(
    refreshPulse,
    [],
    { intervalMs: 30000, enabled: true, pauseWhenHidden: true, immediate: false },
  );

  const statusIcon = (s: string) => {
    if (s === "connected") return <CheckCircle2 className="h-3 w-3 text-emerald-500" />;
    if (s === "error") return <XCircle className="h-3 w-3 text-destructive" />;
    if (s === "disconnected") return <Loader2 className="h-3 w-3 text-amber-500 animate-spin" />;
    return <PauseCircle className="h-3 w-3 text-muted-foreground" />;
  };

  const connectedCount = channels.filter(c => c.status === "connected").length;
  const problemCount = channels.filter(c => c.status === "error" || c.status === "disconnected").length;

  return (
    <div className="border-b px-3 py-1.5">
      <button
        type="button"
        onClick={() => setCollapsed(!collapsed)}
        className="flex w-full items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <Activity className="h-3 w-3" />
        <span>
          {connectedCount}/{channels.length} channels connected
          {problemCount > 0 ? <span className="text-destructive"> · {problemCount} need attention</span> : null}
        </span>
        <span className="ml-auto">{collapsed ? "\u25B8" : "\u25BE"}</span>
      </button>
      {!collapsed ? (
        <div className="mt-1 flex flex-wrap gap-1.5 pb-1">
          {channels.map((c) => (
            <a
              key={c.channel}
              href="/channels"
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors ${
                c.status === "connected" ? "border-emerald-500/30 text-emerald-400" :
                c.status === "error" ? "border-destructive/30 text-destructive" :
                c.status === "disconnected" ? "border-amber-500/30 text-amber-400" :
                "border-muted-foreground/20 text-muted-foreground"
              }`}
              title={c.message || `Status: ${c.status}`}
            >
              {statusIcon(c.status)}
              <span>{c.label}</span>
              {c.pendingRequests ? <Badge variant="secondary" className="h-4 px-1 text-[9px]">{c.pendingRequests}</Badge> : null}
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}
