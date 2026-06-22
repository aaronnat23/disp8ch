"use client";

import { useEffect, useState } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetBody } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { WorkTrailStrip, type WorkTrailEventLite } from "./work-trail-strip";

type TrailEvent = WorkTrailEventLite & { id: string; createdAt: string };
type TrailRecord = {
  id: string;
  userMessage: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  planJson: string | null;
  intentJson: string;
};

const STATUS_TONE: Record<string, string> = {
  pending: "border-amber-500/40 text-amber-300",
  executing: "border-sky-500/40 text-sky-300",
  completed: "border-emerald-500/40 text-emerald-300",
  failed: "border-red-500/40 text-red-300",
  cancelled: "border-slate-500/40 text-slate-300",
};

const EVENT_TONE: Record<string, string> = {
  step_failed: "text-red-300",
  cancelled: "text-slate-400",
  council_completed: "text-violet-300",
  workflow_created: "text-sky-300",
  workflow_scheduled: "text-sky-300",
  board_task_created: "text-emerald-300",
  object_created: "text-emerald-300",
  object_linked: "text-teal-300",
};

/**
 * Full work-trail detail: the compact trail strip, a per-event timeline, and the
 * raw plan JSON (collapsed). Fetches on open from /api/work-trails?id=.
 */
export function WorkTrailDrawer({
  trailId,
  open,
  onOpenChange,
}: {
  trailId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [trail, setTrail] = useState<TrailRecord | null>(null);
  const [events, setEvents] = useState<TrailEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [showPlan, setShowPlan] = useState(false);

  useEffect(() => {
    if (!open || !trailId) return;
    let cancelled = false;
    setLoading(true);
    fetch(`/api/work-trails?id=${encodeURIComponent(trailId)}`)
      .then((r) => r.json())
      .then((json) => {
        if (cancelled || !json?.success) return;
        setTrail(json.data.trail as TrailRecord);
        setEvents(json.data.events as TrailEvent[]);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, trailId]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent widthClassName="w-full sm:max-w-xl">
        <SheetHeader>
          <SheetTitle className="text-base">Work Trail</SheetTitle>
          <SheetDescription>
            {trail ? trail.userMessage.slice(0, 160) : "Cross-tab plan trail"}
          </SheetDescription>
        </SheetHeader>
        <SheetBody className="space-y-4">
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading trail…</p>
          ) : !trail ? (
            <p className="text-sm text-muted-foreground">Trail not found.</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline" className={cn("text-[10px] capitalize", STATUS_TONE[trail.status] ?? "")}>{trail.status}</Badge>
                <span className="text-[11px] text-muted-foreground">{new Date(trail.createdAt).toLocaleString()}</span>
                <span className="font-mono text-[10px] text-muted-foreground">{trail.id}</span>
              </div>

              <WorkTrailStrip events={events} />

              <div>
                <div className="mb-1.5 text-[10px] font-mono uppercase tracking-widest text-muted-foreground">Timeline</div>
                <ol className="space-y-1.5">
                  {events.map((e) => (
                    <li key={e.id} className="flex items-start gap-2 text-xs">
                      <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
                      <div className="min-w-0">
                        <div className={cn("font-mono", EVENT_TONE[e.eventType] ?? "text-foreground")}>
                          {e.eventType}
                          {e.objectName ? <span className="text-muted-foreground"> · {e.objectName}</span> : null}
                        </div>
                        {e.summary ? <div className="truncate text-muted-foreground">{e.summary}</div> : null}
                        <div className="text-[10px] text-muted-foreground/70">{new Date(e.createdAt).toLocaleTimeString()}</div>
                      </div>
                    </li>
                  ))}
                  {events.length === 0 ? <li className="text-xs text-muted-foreground">No events recorded.</li> : null}
                </ol>
              </div>

              {trail.planJson ? (
                <div>
                  <button
                    type="button"
                    className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground transition-colors hover:text-terminal-red"
                    onClick={() => setShowPlan((v) => !v)}
                  >
                    {showPlan ? "Hide" : "Show"} raw plan JSON
                  </button>
                  {showPlan ? (
                    <pre className="mt-1.5 max-h-72 overflow-auto rounded border border-border bg-muted/30 p-2 text-[10px] leading-relaxed">
                      {(() => { try { return JSON.stringify(JSON.parse(trail.planJson), null, 2); } catch { return trail.planJson; } })()}
                    </pre>
                  ) : null}
                </div>
              ) : null}
            </>
          )}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}
