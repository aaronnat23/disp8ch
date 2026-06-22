"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ExternalLink, Square, Activity as ActivityIcon, MonitorPlay } from "lucide-react";
import { useRouter } from "next/navigation";
import { getDesktopBridge } from "@/lib/client/desktop-bridge";

type WorkItem = {
  id: string;
  kind: "background-job" | "workflow";
  title: string;
  detail: string;
  state: "running" | "queued" | "waiting" | "completed" | "failed";
  model?: string | null;
  sessionId?: string | null;
  workflowId?: string | null;
  elapsedMs: number;
  href: string;
  canCancel: boolean;
};

type Snapshot = { items: WorkItem[]; counts: { running: number; completed: number; failed: number } };

function fmtElapsed(ms: number): string {
  if (ms < 1000) return "0s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function stateClass(state: WorkItem["state"]): string {
  if (state === "running") return "border-terminal-red text-terminal-red";
  if (state === "failed") return "border-destructive text-destructive";
  if (state === "completed") return "text-muted-foreground";
  return "text-amber-500 border-amber-500";
}

export function WorkMonitor() {
  const router = useRouter();
  const [snapshot, setSnapshot] = useState<Snapshot>({ items: [], counts: { running: 0, completed: 0, failed: 0 } });
  const [isDesktop, setIsDesktop] = useState(false);

  useEffect(() => {
    setIsDesktop(getDesktopBridge() !== null);
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/work-monitor", { cache: "no-store" });
      const json = await res.json();
      if (json.success) setSnapshot(json.data as Snapshot);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load]);

  const cancel = async (item: WorkItem) => {
    if (item.kind !== "background-job") return;
    const id = item.id.replace("background-job:", "");
    try {
      await fetch(`/api/background-jobs?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      void load();
    } catch {
      /* ignore */
    }
  };

  const openWatch = (item: WorkItem) => {
    const bridge = getDesktopBridge();
    if (bridge && item.sessionId) {
      void bridge.openSessionWindow({ sessionId: item.sessionId });
    } else {
      router.push(item.href);
    }
  };

  const { running, completed, failed } = snapshot.counts;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <ActivityIcon className="h-4 w-4 text-terminal-red" /> Work Monitor
        </CardTitle>
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
          <span className="text-terminal-red">{running} running</span>
          <span>{completed} done</span>
          {failed > 0 ? <span className="text-destructive">{failed} failed</span> : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {snapshot.items.length === 0 ? (
          <div className="py-8 text-center text-xs text-muted-foreground">No active or recent work.</div>
        ) : (
          snapshot.items.map((item) => (
            <div key={item.id} className="flex items-center gap-3 rounded-md border px-3 py-2">
              <Badge variant="outline" className={`shrink-0 text-[10px] uppercase ${stateClass(item.state)}`}>
                {item.state}
              </Badge>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{item.title}</span>
                  {item.model ? <span className="shrink-0 text-[10px] text-muted-foreground">{item.model}</span> : null}
                </div>
                <div className="truncate text-xs text-muted-foreground">{item.detail}</div>
              </div>
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{fmtElapsed(item.elapsedMs)}</span>
              <div className="flex shrink-0 items-center gap-1">
                {item.sessionId ? (
                  <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => openWatch(item)} title={isDesktop ? "Open watch window" : "Open session"}>
                    <MonitorPlay className="h-3.5 w-3.5" />
                  </Button>
                ) : (
                  <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => router.push(item.href)} title="Open">
                    <ExternalLink className="h-3.5 w-3.5" />
                  </Button>
                )}
                {item.canCancel ? (
                  <Button variant="ghost" size="sm" className="h-7 px-2 text-destructive" onClick={() => void cancel(item)} title="Cancel">
                    <Square className="h-3.5 w-3.5" />
                  </Button>
                ) : null}
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
