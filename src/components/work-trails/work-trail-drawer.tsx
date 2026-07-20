"use client";

import { useEffect, useState } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetBody } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import Link from "next/link";
import { WorkTrailStrip, type WorkTrailEventLite } from "./work-trail-strip";
import { WorkTrailOutcomeCard } from "./work-trail-outcome-card";

type TrailEvent = WorkTrailEventLite & { id: string; createdAt: string; objectAvailable?: boolean | null; objectState?: string | null };
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
  pending: "border-border text-muted-foreground",
  executing: "border-terminal-red/50 text-terminal-red",
  completed: "border-foreground/40 text-foreground",
  failed: "border-terminal-red text-terminal-red",
  cancelled: "border-border text-muted-foreground",
};

const EVENT_TONE: Record<string, string> = {
  step_failed: "text-terminal-red",
  cancelled: "text-muted-foreground",
  supervised_run_started: "text-terminal-red",
  criterion_evaluated: "text-terminal-red",
  deployment_created: "text-terminal-red",
  live_session_started: "text-terminal-red",
};

function eventHref(event: TrailEvent, trailId: string): string | null {
  if (event.objectAvailable === false) return null;
  if (!event.objectId) return null;
  const trail = `trail=${encodeURIComponent(trailId)}`;
  if (event.surface === "files") return `/files?project=${encodeURIComponent(event.objectId)}&${trail}`;
  if (event.surface === "sources") return `/documents?notebook=${encodeURIComponent(event.objectId)}&${trail}`;
  if (event.surface === "workflows") return `/workflows?run=${encodeURIComponent(event.objectId)}&${trail}`;
  if (event.surface === "design") return `/designs?artifact=${encodeURIComponent(event.objectId)}&${trail}`;
  if (event.surface === "deployments") return `/designs?deployment=${encodeURIComponent(event.objectId)}&${trail}`;
  if (event.surface === "boards") return `/boards?task=${encodeURIComponent(event.objectId)}&${trail}`;
  if (event.surface === "council") return `/council?session=${encodeURIComponent(event.objectId)}&${trail}`;
  if (event.surface === "sessions") return `/chat?liveSession=${encodeURIComponent(event.objectId)}&${trail}`;
  if (event.surface === "hierarchy") return `/hierarchy?object=${encodeURIComponent(event.objectId)}&${trail}`;
  return null;
}

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

  const resultEvent = [...events].reverse().find((event) =>
    ["deployment_created", "deployment_updated", "supervised_run_completed", "project_attached", "artifact_created"].includes(event.eventType)
    && Boolean(eventHref(event, trailId || "")),
  );

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
      <SheetContent widthClassName="w-full sm:max-w-2xl">
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

              <WorkTrailOutcomeCard
                trail={trail}
                events={events}
                resultHref={resultEvent ? eventHref(resultEvent, trail.id) : null}
              />

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
                        {eventHref(e, trail.id) ? <Link href={eventHref(e, trail.id)!} className="text-[10px] text-terminal-red hover:underline">Open linked object{e.objectState === "revoked" ? " (revoked)" : ""}</Link> : e.objectId ? <div className="text-[10px] text-muted-foreground">{e.objectState === "missing" ? "Linked object was deleted or is unavailable" : "Linked object unavailable from this surface"}</div> : null}
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
