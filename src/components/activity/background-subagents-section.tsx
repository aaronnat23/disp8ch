"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface BgJob {
  id: string;
  category: "coding-agent" | "shell";
  label: string;
  backend: string;
  status: "running" | "completed" | "failed";
  startedAt: string;
  completedAt: string | null;
  sessionId: string | null;
  exitCode: number | null;
  timeoutMs: number | null;
  resultPreview: string;
}

const RECENT_JOB_WINDOW_MS = 24 * 60 * 60 * 1000;

function elapsed(startedAt: string, completedAt: string | null): string {
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const s = Math.max(0, Math.round((end - start) / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function statusBadge(status: BgJob["status"]) {
  if (status === "running") return <Badge>running</Badge>;
  if (status === "failed") return <Badge variant="destructive">failed</Badge>;
  return <Badge variant="secondary">done</Badge>;
}

/**
 * Operator visibility for the async background subagents that already run via
 * sessions_spawn / bash_exec / run_python. Hidden when there are no recent jobs;
 * auto-expands while a job is running or failed. Reuses the existing completion
 * re-entry path — this is a view + cancel surface, not a second notifier.
 */
export function BackgroundSubagentsSection() {
  const [jobs, setJobs] = useState<BgJob[]>([]);
  const [capacity, setCapacity] = useState<{ running: number; maxConcurrent: number }>({ running: 0, maxConcurrent: 0 });
  const [expanded, setExpanded] = useState(false);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [viewing, setViewing] = useState<BgJob | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/background-jobs?limit=20");
      const json = await res.json();
      if (json.success && json.data) {
        const now = Date.now();
        const list: BgJob[] = json.data.jobs.filter((job: BgJob | null) => {
          if (!job) return false;
          if (job.status === "running") return true;
          const completed = Date.parse(job.completedAt || job.startedAt);
          return Number.isFinite(completed) && now - completed <= RECENT_JOB_WINDOW_MS;
        });
        setJobs(list);
        setCapacity(json.data.capacity);
        // Auto-expand while something is running or recently failed.
        if (list.some((j) => j.status === "running" || j.status === "failed")) setExpanded(true);
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 4000);
    return () => clearInterval(t);
  }, [load]);

  const cancel = useCallback(
    async (id: string) => {
      setCancelling(id);
      try {
        await fetch(`/api/background-jobs?id=${encodeURIComponent(id)}`, { method: "DELETE" });
        await load();
      } finally {
        setCancelling(null);
      }
    },
    [load],
  );

  // Hidden entirely when there are no current/recent jobs (no always-on noise).
  if (jobs.length === 0) return null;

  return (
    <Card className="border-border">
      <CardHeader className="cursor-pointer py-3" onClick={() => setExpanded((v) => !v)}>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm">
            {expanded ? "▾" : "▸"} Background subagents
            <Badge variant="outline">{capacity.running} / {capacity.maxConcurrent} running</Badge>
          </CardTitle>
          <Link href="/settings" onClick={(e) => e.stopPropagation()} className="text-xs text-muted-foreground underline">
            Concurrency in Settings
          </Link>
        </div>
      </CardHeader>
      {expanded && (
        <CardContent className="space-y-2 text-xs">
          {jobs.map((job) => (
            <div key={job.id} className="flex items-center justify-between gap-2 rounded border border-border p-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <Badge variant="outline">{job.category === "coding-agent" ? "coding agent" : "shell/python"}</Badge>
                  {statusBadge(job.status)}
                  <span className="truncate font-mono text-muted-foreground">{job.backend}</span>
                </div>
                <div className="mt-1 truncate font-mono text-[11px]" title={job.label}>{job.label}</div>
                <div className="mt-0.5 text-[10px] text-muted-foreground">
                  {elapsed(job.startedAt, job.completedAt)} elapsed
                  {job.timeoutMs ? ` · timeout ${Math.round(job.timeoutMs / 1000)}s` : ""}
                  {job.sessionId ? ` · session ${job.sessionId.slice(0, 10)}` : ""}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {job.sessionId && (
                  <Link href={`/chat?sessionId=${encodeURIComponent(job.sessionId)}`}>
                    <Button size="sm" variant="ghost" className="h-7 px-2 text-xs">Conversation</Button>
                  </Link>
                )}
                {job.status !== "running" && job.resultPreview && (
                  <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setViewing(job)}>Result</Button>
                )}
                {job.status === "running" && (
                  <Button size="sm" variant="destructive" className="h-7 px-2 text-xs" disabled={cancelling === job.id} onClick={() => void cancel(job.id)}>
                    {cancelling === job.id ? "…" : "Cancel"}
                  </Button>
                )}
              </div>
            </div>
          ))}
          {viewing && (
            <div className="rounded border border-border bg-black/30 p-2">
              <div className="mb-1 flex items-center justify-between">
                <span className="font-mono">{viewing.label}</span>
                <Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => setViewing(null)}>Close</Button>
              </div>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[11px]">{viewing.resultPreview}</pre>
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}
