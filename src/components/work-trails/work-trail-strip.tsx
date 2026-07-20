"use client";

import { cn } from "@/lib/utils";
import { ArrowRight } from "lucide-react";

export type WorkTrailEventLite = {
  eventType: string;
  surface: string | null;
  objectType: string | null;
  objectName: string | null;
  objectId?: string | null;
  summary: string | null;
};

const OBJECT_EVENTS = new Set([
  "object_created",
  "object_linked",
  "council_completed",
  "workflow_created",
  "workflow_scheduled",
  "board_task_created",
  "artifact_created",
  "project_attached",
  "supervised_run_created",
  "supervised_run_started",
  "supervised_run_completed",
  "criterion_evaluated",
  "evidence_recorded",
  "validation_completed",
  "deployment_created",
  "deployment_updated",
  "deployment_rolled_back",
  "feedback_received",
  "feedback_classified",
  "live_session_started",
  "live_session_stopped",
  "live_session_saved",
]);

function verbFor(eventType: string, objectType: string | null): string {
  switch (eventType) {
    case "council_completed": return "Ran council";
    case "workflow_created": return "Created workflow";
    case "workflow_scheduled": return "Scheduled workflow";
    case "board_task_created": return "Created board task";
    case "object_linked": return `Linked ${objectType ?? "object"}`;
    case "artifact_created": return "Created artifact";
    case "project_attached": return "Connected project";
    case "supervised_run_created": return "Created supervised run";
    case "supervised_run_started": return "Started supervised run";
    case "supervised_run_completed": return "Verified supervised run";
    case "criterion_evaluated": return "Evaluated criterion";
    case "evidence_recorded": return "Recorded evidence";
    case "validation_completed": return "Completed validation";
    case "deployment_created": return "Published deployment";
    case "deployment_updated": return "Updated deployment";
    case "deployment_rolled_back": return "Rolled back deployment";
    case "feedback_received": return "Received feedback";
    case "feedback_classified": return "Classified feedback";
    case "live_session_started": return "Started live session";
    case "live_session_stopped": return "Completed live session";
    case "live_session_saved": return "Saved live session";
    default: return `Created ${objectType ?? "object"}`;
  }
}

/**
 * Compact "Prompt -> Org -> Council -> Workflow -> Task" trail. Pure renderer;
 * details belong in the drawer. Hidden when there are no object events.
 */
export function WorkTrailStrip({
  events,
  className,
  onOpen,
}: {
  events: WorkTrailEventLite[];
  className?: string;
  onOpen?: () => void;
}) {
  const objectEvents = events.filter((e) => OBJECT_EVENTS.has(e.eventType));
  if (objectEvents.length === 0) return null;

  return (
    <div className={cn("rounded-lg border border-border bg-card/60 px-3 py-2", className)}>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">Work trail</span>
        {onOpen ? (
          <button type="button" onClick={onOpen} className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground transition-colors hover:text-terminal-red">
            Details
          </button>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        <span className="rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono">Prompt</span>
        {objectEvents.slice(0, 8).map((e, i) => (
          <span key={i} className="inline-flex items-center gap-1.5">
            <ArrowRight className="h-3 w-3 text-muted-foreground/50" />
            <span className="max-w-[220px] truncate rounded border border-border bg-card px-1.5 py-0.5" title={`${verbFor(e.eventType, e.objectType)}${e.objectName ? `: ${e.objectName}` : ""}`}>
              {verbFor(e.eventType, e.objectType)}
              {e.objectName ? `: ${e.objectName}` : ""}
            </span>
          </span>
        ))}
        {objectEvents.length > 8 ? <span className="text-muted-foreground">+{objectEvents.length - 8} more</span> : null}
      </div>
    </div>
  );
}
