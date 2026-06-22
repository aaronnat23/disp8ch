"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/app/empty-state";
import { RunCard } from "@/components/dynamic-workflows/run-card";
import { cn } from "@/lib/utils";
import type {
  DynamicWorkflowRunRecord,
  DynamicWorkflowPhaseRecord,
  DynamicWorkflowWorkerRecord,
} from "@/lib/dynamic-workflows/types";
import { RefreshCw, Loader2 } from "lucide-react";

type RunListProps = {
  className?: string;
  onViewRun?: (runId: string) => void;
};

type RunFilter = "all" | "running" | "completed" | "failed";

type ApiRun = DynamicWorkflowRunRecord & {
  phases?: DynamicWorkflowPhaseRecord[];
  workers?: DynamicWorkflowWorkerRecord[];
};

const FILTERS: Array<{ value: RunFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "running", label: "Running" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
];

const FILTER_MATCHES: Record<RunFilter, (r: DynamicWorkflowRunRecord) => boolean> = {
  all: () => true,
  running: (r) => r.status === "running" || r.status === "queued" || r.status === "awaiting_approval",
  completed: (r) => r.status === "completed",
  failed: (r) => r.status === "failed" || r.status === "cancelled",
};

export function RunList({ className, onViewRun }: RunListProps) {
  const [runs, setRuns] = useState<ApiRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [filter, setFilter] = useState<RunFilter>("all");
  const [actionRunningId, setActionRunningId] = useState<string | null>(null);

  const fetchRuns = useCallback(async () => {
    setLoading(true);
    setFetchError(null);
    try {
      const res = await fetch("/api/dynamic-workflows");
      const json = await res.json() as { success?: boolean; data?: ApiRun[]; error?: string };
      if (!json.success) {
        setFetchError(json.error ?? "Failed to load runs");
        setRuns([]);
        return;
      }
      setRuns(json.data ?? []);
    } catch (err) {
      setFetchError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRuns();
  }, [fetchRuns]);

  const handleApiAction = async (
    runId: string,
    action: "pause" | "resume" | "cancel"
  ) => {
    setActionRunningId(runId);
    try {
      const res = await fetch(`/api/dynamic-workflows`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, runId }),
      });
      const json = await res.json() as { success?: boolean; error?: string };
      if (json.success) {
        fetchRuns();
      }
    } catch {
      // best effort on UI action
    } finally {
      setActionRunningId(null);
    }
  };

  const filteredRuns = runs.filter((r) => FILTER_MATCHES[filter](r));

  const filterCounts: Record<RunFilter, number> = {
    all: runs.length,
    running: runs.filter(FILTER_MATCHES.running).length,
    completed: runs.filter(FILTER_MATCHES.completed).length,
    failed: runs.filter(FILTER_MATCHES.failed).length,
  };

  return (
    <div className={cn("space-y-4", className)}>
      {/* Filter bar + refresh */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {FILTERS.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              className={cn(
                "rounded border px-2.5 py-1 font-mono text-xs transition-colors",
                filter === value
                  ? "border-terminal-red bg-terminal-red/10 text-terminal-red"
                  : "border-border text-muted-foreground hover:border-muted-foreground hover:text-foreground"
              )}
              onClick={() => setFilter(value)}
            >
              {label}
              {filterCounts[value] > 0 ? ` ${filterCounts[value]}` : ""}
            </button>
          ))}
        </div>

        <Button
          variant="outline"
          size="sm"
          className="h-7"
          onClick={fetchRuns}
          disabled={loading}
        >
          <RefreshCw
            className={cn("mr-1 h-3 w-3", loading && "animate-spin")}
          />
          Refresh
        </Button>
      </div>

      {/* Loading */}
      {loading && runs.length === 0 ? (
        <div className="flex min-h-[180px] items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading dynamic runs...
        </div>
      ) : fetchError ? (
        <EmptyState
          title="Could not load runs"
          description={fetchError}
          action={
            <Button variant="outline" onClick={fetchRuns}>
              <RefreshCw className="mr-2 h-4 w-4" />
              Retry
            </Button>
          }
        />
      ) : filteredRuns.length === 0 ? (
        <EmptyState
          title={
            runs.length === 0
              ? "No dynamic workflow runs yet"
              : `No ${filter} runs`
          }
          description={
            runs.length === 0
              ? "Start one from WebChat or use a harness template."
              : "Adjust the filter to see other runs."
          }
          action={
            runs.length === 0 ? (
              <Button variant="outline" onClick={fetchRuns}>
                <RefreshCw className="mr-2 h-4 w-4" />
                Refresh
              </Button>
            ) : null
          }
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filteredRuns.map((run) => (
            <RunCard
              key={run.id}
              run={run}
              onView={onViewRun}
              onPause={
                actionRunningId === run.id ? undefined : (id) => handleApiAction(id, "pause")
              }
              onResume={
                actionRunningId === run.id ? undefined : (id) => handleApiAction(id, "resume")
              }
              onCancel={
                actionRunningId === run.id ? undefined : (id) => handleApiAction(id, "cancel")
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
