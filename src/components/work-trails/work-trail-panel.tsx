"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { GitBranch } from "lucide-react";
import { cn } from "@/lib/utils";
import { WorkTrailDrawer } from "./work-trail-drawer";

type TrailRow = {
  id: string;
  userMessage: string;
  status: string;
  createdAt: string;
  eventCount: number;
};

const STATUS_TONE: Record<string, string> = {
  pending: "border-amber-500/40 text-amber-300",
  executing: "border-sky-500/40 text-sky-300",
  completed: "border-emerald-500/40 text-emerald-300",
  failed: "border-red-500/40 text-red-300",
  cancelled: "border-slate-500/40 text-slate-300",
};

/**
 * Activity-tab panel: a calm list of recent cross-tab work trails. One row per
 * trail (prompt + status + step count); full timeline opens in the drawer.
 */
export function WorkTrailPanel() {
  const [trails, setTrails] = useState<TrailRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const refresh = () => {
    fetch("/api/work-trails?limit=30")
      .then((r) => r.json())
      .then((json) => { if (json?.success) setTrails(json.data as TrailRow[]); })
      .catch(() => {})
      .finally(() => setLoaded(true));
  };

  useEffect(() => { refresh(); }, []);

  return (
    <Card className="mb-6">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 py-3">
        <CardTitle className="inline-flex items-center gap-2 text-base">
          <GitBranch className="h-4 w-4 text-terminal-red" />
          Cross-Tab Work Trails
        </CardTitle>
        <Button variant="outline" size="sm" className="h-7 text-[11px]" onClick={refresh}>Refresh</Button>
      </CardHeader>
      <CardContent>
        {!loaded ? (
          <p className="text-sm text-muted-foreground">Loading trails…</p>
        ) : trails.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No work trails yet. Ask WebChat to build something across tabs (org + council + workflow + board) and confirm the plan — the trail appears here.
          </p>
        ) : (
          <div className="space-y-2">
            {trails.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setOpenId(t.id)}
                className="flex w-full items-center justify-between gap-3 rounded-lg border border-border bg-card/50 px-3 py-2 text-left transition-colors hover:border-terminal-red/50"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm">{t.userMessage.slice(0, 100) || "(prompt)"}</div>
                  <div className="text-[11px] text-muted-foreground">{new Date(t.createdAt).toLocaleString()} · {t.eventCount} events</div>
                </div>
                <Badge variant="outline" className={cn("shrink-0 text-[10px] capitalize", STATUS_TONE[t.status] ?? "")}>{t.status}</Badge>
              </button>
            ))}
          </div>
        )}
      </CardContent>
      <WorkTrailDrawer trailId={openId} open={Boolean(openId)} onOpenChange={(o) => { if (!o) setOpenId(null); }} />
    </Card>
  );
}
