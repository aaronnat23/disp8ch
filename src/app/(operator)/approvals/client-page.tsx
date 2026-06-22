"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  CheckCircle2,
  Clock,
  RefreshCw,
  ShieldCheck,
  ShieldX,
  Star,
  XCircle,
} from "lucide-react";
import { usePolling } from "@/lib/client/use-polling";
import { useAfterUseful } from "@/lib/client/use-after-useful";

interface PendingToolApproval {
  id: string;
  name: string;
  args: Record<string, unknown>;
  mode: string;
  reasons: string[];
  createdAtMs: number;
  expiresAtMs: number;
  agentId?: string;
  execSecurity?: string;
  execAsk?: string;
  execAllowlist?: string[];
}

interface TaskApproval {
  id: string;
  taskId: string;
  approverType: "user" | "agent";
  approverId: string | null;
  status: "pending" | "approved" | "rejected" | "revision_requested";
  decisionNote: string | null;
  decidedAt: string | null;
  createdAt: string;
}

interface BoardTaskSummary {
  id: string;
  title: string;
  boardName?: string | null;
  goalName?: string | null;
}

type HistoryEntry = {
  id: string;
  kind: "tool" | "task";
  name: string;
  decision: "approve" | "deny" | "always" | "approved" | "rejected" | "revision_requested";
  ts: number;
};

const APPROVALS_UI_STATE_KEY = "disp8ch:approvals-ui-state";

function ExpiryCountdown({ expiresAtMs }: { expiresAtMs: number }) {
  const [remaining, setRemaining] = useState(() => Math.max(0, expiresAtMs - Date.now()));

  useEffect(() => {
    const t = setInterval(() => setRemaining(Math.max(0, expiresAtMs - Date.now())), 500);
    return () => clearInterval(t);
  }, [expiresAtMs]);

  const secs = Math.ceil(remaining / 1000);
  const pct = Math.max(0, (remaining / (5 * 60 * 1000)) * 100);
  const urgent = secs < 30;

  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full rounded-full transition-all ${urgent ? "bg-red-500" : "bg-yellow-500"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className={`text-xs tabular-nums ${urgent ? "text-red-400" : "text-yellow-400"}`}>{secs}s</span>
    </div>
  );
}

function ExecPolicyChips({ approval }: { approval: PendingToolApproval }) {
  const chips: Array<{ label: string; variant: "outline" | "secondary" | "destructive" | "default" }> = [];
  if (approval.execSecurity) chips.push({ label: `security: ${approval.execSecurity}`, variant: "outline" });
  if (approval.execAsk) chips.push({ label: `ask: ${approval.execAsk}`, variant: "outline" });
  if (approval.agentId) chips.push({ label: `agent: ${approval.agentId.slice(0, 8)}...`, variant: "secondary" });
  if (!chips.length) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {chips.map((chip) => (
        <Badge key={chip.label} variant={chip.variant} className="text-[10px] font-mono">
          {chip.label}
        </Badge>
      ))}
      {(approval.execAllowlist?.length ?? 0) > 0 ? (
        <Badge variant="outline" className="text-[10px] font-mono">
          allowlist: {approval.execAllowlist!.join(", ")}
        </Badge>
      ) : null}
    </div>
  );
}

export default function ApprovalsPage() {
  const [toolApprovals, setToolApprovals] = useState<PendingToolApproval[]>([]);
  const [taskApprovals, setTaskApprovals] = useState<TaskApproval[]>([]);
  const [taskTitles, setTaskTitles] = useState<Record<string, BoardTaskSummary>>({});
  const [loading, setLoading] = useState(true);
  const [resolving, setResolving] = useState<Record<string, boolean>>({});
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [hideGettingStarted, setHideGettingStarted] = useState(false);

  const load = useCallback(async () => {
    try {
      const [toolsRes, taskRes, boardRes] = await Promise.all([
        fetch("/api/tool-approvals"),
        fetch("/api/governance?action=task-approvals&status=pending&limit=100"),
        fetch("/api/boards/tasks"),
      ]);
      const [toolsJson, taskJson, boardJson] = (await Promise.all([
        toolsRes.json(),
        taskRes.json(),
        boardRes.json(),
      ])) as [
        { success: boolean; data?: PendingToolApproval[] },
        { success: boolean; data?: TaskApproval[] },
        { success: boolean; data?: BoardTaskSummary[] },
      ];
      if (toolsJson.success) setToolApprovals(toolsJson.data ?? []);
      if (taskJson.success) setTaskApprovals(taskJson.data ?? []);
      if (boardJson.success) {
        const next: Record<string, BoardTaskSummary> = {};
        for (const task of boardJson.data ?? []) {
          next[task.id] = task;
        }
        setTaskTitles(next);
      }
    } catch {
      // no-op
    } finally {
      setLoading(false);
    }
  }, []);

  useAfterUseful(() => { void load(); }, [load]);

  usePolling(
    async () => { await load(); },
    [load],
    { intervalMs: 2000, enabled: true, pauseWhenHidden: true, backoffOnError: true, immediate: false },
  );

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(APPROVALS_UI_STATE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { hideGettingStarted?: boolean };
      setHideGettingStarted(Boolean(parsed.hideGettingStarted));
    } catch {
      // localStorage is optional; ignore malformed state.
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(APPROVALS_UI_STATE_KEY, JSON.stringify({ hideGettingStarted }));
    } catch {
      // localStorage is optional.
    }
  }, [hideGettingStarted]);

  const rememberDecision = (entry: HistoryEntry) => {
    setHistory((current) => [entry, ...current].slice(0, 20));
  };

  const resolveTool = async (approval: PendingToolApproval, decision: "approve" | "deny" | "always") => {
    setResolving((current) => ({ ...current, [approval.id]: true }));
    try {
      await fetch("/api/tool-approvals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: approval.id, decision: decision === "always" ? "approve" : decision }),
      });
      rememberDecision({
        id: approval.id,
        kind: "tool",
        name: approval.name,
        decision,
        ts: Date.now(),
      });
      await load();
    } finally {
      setResolving((current) => ({ ...current, [approval.id]: false }));
    }
  };

  const resolveTask = async (
    approval: TaskApproval,
    decision: "approved" | "rejected" | "revision_requested",
  ) => {
    setResolving((current) => ({ ...current, [approval.id]: true }));
    try {
      await fetch("/api/governance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "resolve-task-approval",
          id: approval.id,
          decision,
        }),
      });
      rememberDecision({
        id: approval.id,
        kind: "task",
        name: taskTitles[approval.taskId]?.title || approval.taskId,
        decision,
        ts: Date.now(),
      });
      await load();
    } finally {
      setResolving((current) => ({ ...current, [approval.id]: false }));
    }
  };

  const totalPending = toolApprovals.length + taskApprovals.length;

  return (
        <main className="flex-1 overflow-auto p-6" data-perf-ready="approvals">
          <div className="mb-6 flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold">Approvals</h1>
              <p className="text-sm text-muted-foreground">
                Review pending task-plan, risky tool, hierarchy, and dynamic-workflow approvals. Empty means no human sign-off is waiting.
              </p>
            </div>
            <div className="flex items-center gap-2">
              {totalPending > 0 ? (
                <Badge variant="destructive" className="animate-pulse">
                  {totalPending} pending
                </Badge>
              ) : null}
              <Badge variant="outline">{taskApprovals.length} task</Badge>
              <Badge variant="outline">{toolApprovals.length} tool</Badge>
              <Button variant="ghost" size="sm" onClick={() => void load()}>
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>

          {!loading && totalPending === 0 ? (
            hideGettingStarted ? (
              <div className="mb-6 flex items-center justify-between gap-3 rounded-md border border-dashed px-3 py-2">
                <p className="text-sm text-muted-foreground">No pending approvals.</p>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setHideGettingStarted(false)}
                >
                  Show Tips
                </Button>
              </div>
            ) : (
              <div className="mb-6 rounded-md border bg-muted/20 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                      Getting Started
                    </div>
                    <p className="mt-2 text-sm font-medium">Keep this tab: it is the app's safety queue.</p>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      It is needed when a task plan needs review, a high-risk tool call asks for permission, a hierarchy policy requires sign-off,
                      or a dynamic workflow worker pauses for approval. An empty page means the queue is clear.
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setHideGettingStarted(true)}
                  >
                    Hide Tips
                  </Button>
                </div>
              </div>
            )
          ) : null}

          <div className="mb-6 space-y-3">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Task Plan Approvals</div>
            {loading ? (
              <Card>
                <CardContent className="p-6 text-sm text-muted-foreground">Loading approvals...</CardContent>
              </Card>
            ) : taskApprovals.length === 0 ? (
              <Card>
                <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
                  <ShieldCheck className="h-10 w-10 text-muted-foreground/40" />
                  <p className="text-sm font-medium">No pending task approvals</p>
                  <p className="text-xs text-muted-foreground">
                    Crew plan gates and human review requests will appear here.
                  </p>
                </CardContent>
              </Card>
            ) : (
              taskApprovals.map((approval) => {
                const task = taskTitles[approval.taskId];
                return (
                  <Card key={approval.id} className="border-blue-500/30">
                    <CardHeader className="px-5 pb-3 pt-4">
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0 flex-1">
                          <CardTitle className="flex items-center gap-2 text-base">
                            <ShieldCheck className="h-4 w-4 shrink-0 text-blue-400" />
                            <span>{task?.title || approval.taskId}</span>
                            <Badge variant="outline" className="text-[10px]">
                              task plan
                            </Badge>
                          </CardTitle>
                          <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                            <span>{new Date(approval.createdAt).toLocaleString()}</span>
                            <span>Task: {approval.taskId}</span>
                            <span>
                              Approver: {approval.approverType}
                              {approval.approverId ? `:${approval.approverId}` : ""}
                            </span>
                            {task?.boardName ? <span>Board: {task.boardName}</span> : null}
                            {task?.goalName ? <span>Goal: {task.goalName}</span> : null}
                          </div>
                        </div>
                        <div className="flex shrink-0 flex-wrap gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            className="border-red-500/40 text-red-400 hover:bg-red-500/10"
                            disabled={resolving[approval.id]}
                            onClick={() => void resolveTask(approval, "rejected")}
                          >
                            <ShieldX className="mr-1.5 h-3.5 w-3.5" />
                            Reject
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="border-yellow-500/40 text-yellow-400 hover:bg-yellow-500/10"
                            disabled={resolving[approval.id]}
                            onClick={() => void resolveTask(approval, "revision_requested")}
                          >
                            <Clock className="mr-1.5 h-3.5 w-3.5" />
                            Request Revision
                          </Button>
                          <Button
                            size="sm"
                            className="bg-green-600 text-white hover:bg-green-700"
                            disabled={resolving[approval.id]}
                            onClick={() => void resolveTask(approval, "approved")}
                          >
                            <ShieldCheck className="mr-1.5 h-3.5 w-3.5" />
                            Approve
                          </Button>
                        </div>
                      </div>
                    </CardHeader>
                  </Card>
                );
              })
            )}
          </div>

          <div className="mb-6 space-y-3">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Tool Approvals</div>
            {loading ? (
              <Card>
                <CardContent className="p-6 text-sm text-muted-foreground">Loading approvals...</CardContent>
              </Card>
            ) : toolApprovals.length === 0 ? (
              <Card>
                <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
                  <ShieldCheck className="h-10 w-10 text-muted-foreground/40" />
                  <p className="text-sm font-medium">No pending tool approvals</p>
                  <p className="text-xs text-muted-foreground">
                    Requests appear here when an agent tool requires human sign-off.
                  </p>
                </CardContent>
              </Card>
            ) : (
              toolApprovals.map((approval) => (
                <Card key={approval.id} className="border-yellow-500/30">
                  <CardHeader className="px-5 pb-3 pt-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0 flex-1">
                        <CardTitle className="flex items-center gap-2 text-base">
                          <ShieldCheck className="h-4 w-4 shrink-0 text-yellow-400" />
                          <span className="font-mono">{approval.name}</span>
                          <Badge variant="outline" className="text-[10px] shrink-0">
                            {approval.mode}
                          </Badge>
                        </CardTitle>
                        <div className="mt-1 flex items-center gap-3">
                          <span className="text-xs text-muted-foreground">
                            Requested {Math.round((Date.now() - approval.createdAtMs) / 1000)}s ago
                          </span>
                          <ExpiryCountdown expiresAtMs={approval.expiresAtMs} />
                        </div>
                        <ExecPolicyChips approval={approval} />
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-2">
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            className="border-red-500/40 text-red-400 hover:bg-red-500/10"
                            disabled={resolving[approval.id]}
                            onClick={() => void resolveTool(approval, "deny")}
                          >
                            <ShieldX className="mr-1.5 h-3.5 w-3.5" />
                            Deny
                          </Button>
                          <Button
                            size="sm"
                            className="bg-green-600 text-white hover:bg-green-700"
                            disabled={resolving[approval.id]}
                            onClick={() => void resolveTool(approval, "approve")}
                          >
                            <ShieldCheck className="mr-1.5 h-3.5 w-3.5" />
                            Allow Once
                          </Button>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          className="w-full border-blue-500/40 text-blue-400 hover:bg-blue-500/10"
                          disabled={resolving[approval.id]}
                          onClick={() => void resolveTool(approval, "always")}
                        >
                          <Star className="mr-1.5 h-3.5 w-3.5" />
                          Always Allow
                        </Button>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3 px-5 pb-4">
                    {approval.reasons.length > 0 ? (
                      <div className="rounded-md border bg-yellow-500/5 px-3 py-2">
                        <p className="mb-1 text-xs font-medium text-yellow-400">Why approval is needed</p>
                        {approval.reasons.map((reason, index) => (
                          <p key={`${approval.id}-reason-${index}`} className="text-xs text-muted-foreground">
                            {reason}
                          </p>
                        ))}
                      </div>
                    ) : null}
                    {Object.keys(approval.args).length > 0 ? (
                      <div>
                        <p className="mb-1.5 text-xs font-medium text-muted-foreground">Arguments</p>
                        <pre className="overflow-x-auto rounded-md bg-muted/50 p-3 text-xs">
                          {JSON.stringify(approval.args, null, 2)}
                        </pre>
                      </div>
                    ) : null}
                  </CardContent>
                </Card>
              ))
            )}
          </div>

          {history.length > 0 ? (
            <Card>
              <CardHeader className="px-5 pb-3 pt-4">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Clock className="h-4 w-4 text-muted-foreground" />
                  Recent decisions (this session)
                </CardTitle>
              </CardHeader>
              <CardContent className="px-5 pb-4">
                <div className="divide-y">
                  {history.map((entry) => (
                    <div key={`${entry.id}-${entry.ts}`} className="flex items-center justify-between py-2">
                      <div className="flex items-center gap-2">
                        {entry.decision === "deny" || entry.decision === "rejected" ? (
                          <XCircle className="h-3.5 w-3.5 text-red-500" />
                        ) : entry.decision === "always" ? (
                          <Star className="h-3.5 w-3.5 text-blue-400" />
                        ) : entry.decision === "revision_requested" ? (
                          <Clock className="h-3.5 w-3.5 text-yellow-400" />
                        ) : (
                          <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
                        )}
                        <span className="text-sm">{entry.name}</span>
                        <Badge variant="outline" className="text-[10px]">
                          {entry.kind}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-3">
                        <Badge
                          variant={
                            entry.decision === "deny" || entry.decision === "rejected"
                              ? "destructive"
                              : entry.decision === "revision_requested"
                                ? "outline"
                                : "default"
                          }
                          className="text-[10px]"
                        >
                          {entry.decision}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          {new Date(entry.ts).toLocaleTimeString()}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          ) : null}
        </main>
  );
}
