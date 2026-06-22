"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Progress } from "@/components/ui/progress";

// ── Types ─────────────────────────────────────────────────────────────────────
type FileStat = {
  name: string;
  chars: number;
  lines: number;
  severity: "ok" | "warn" | "critical";
  missing: boolean;
};

type WorkspaceReport = {
  agentId: string;
  agentName: string;
  workspacePath: string;
  totalChars: number;
  totalSeverity: "ok" | "warn" | "critical";
  files: FileStat[];
};

type CronReport = {
  workflowId: string;
  workflowName: string;
  isLive: boolean;
  expression: string;
};

type DbReport = {
  staleExecutions: number;
  lockedTasks: number;
  pendingApprovals: number;
};

type MaintenanceReport = {
  generatedAt: string;
  overallSeverity: "ok" | "warn" | "critical";
  workspace: WorkspaceReport[];
  cron: CronReport[];
  db: DbReport;
  suggestions: string[];
};

type LearningQuality = {
  promotedCount: number;
  dismissedCount: number;
  proposedCount: number;
  totalReviewed: number;
  promotedToDismissedRatio: number | null;
  staleCandidates: Array<{ id: string; title: string; createdAt: string; daysSinceCreated: number }>;
  staleCandidateCount: number;
  guardBlockCount: number;
  feedbackEnabled: boolean;
  capturePreferences: boolean;
  capturePlaybooks: boolean;
  learningMode: string;
  llmReviewEnabled: boolean;
};

type BackupStatus = {
  enabled: boolean;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  nextRunAt: string | null;
  scheduled: boolean;
  config: {
    backup_replication_mode: string;
    backup_replication_target: string | null;
    backup_retention_count: number;
    backup_cron: string;
  };
  latestBackup: { id: string; createdAt: string; sizeBytes: number } | null;
  setupWarnings: string[];
};

type PluginHealthRow = {
  name: string;
  type: "extension" | "skill" | "mcp";
  status: "active" | "stale" | "disabled" | "error";
  hint: string | null;
  url: string;
};

type HookReport = {
  enabled: boolean;
  directory: string;
  supportedEvents: string[];
  eventGroups?: Array<{ event: string; hookCount: number; enabledCount: number }>;
  hooks: Array<{
    fileName: string;
    path: string;
    sizeBytes: number;
    updatedAt: string;
    handler: string;
    eventHints: string[];
    enabled: boolean;
    stateUpdatedAt: string | null;
    eventSummary: string;
    eventFriendly: string;
    lastRun: {
      eventType: string | null;
      status: string;
      error: string | null;
      durationMs: number | null;
      ranAt: string | null;
    } | null;
  }>;
};

const MAINTENANCE_UI_STATE_KEY = "disp8ch:maintenance-ui-state";

// ── Helpers ───────────────────────────────────────────────────────────────────
const FILE_WARN_CHARS = 8_000;
const FILE_CRITICAL_CHARS = 20_000;

function fmtChars(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${n}`;
}

function severityBadge(s: "ok" | "warn" | "critical") {
  if (s === "critical")
    return <Badge className="bg-terminal-red text-white text-[10px] uppercase tracking-wider">CRITICAL</Badge>;
  if (s === "warn")
    return <Badge className="bg-yellow-500 text-black text-[10px] uppercase tracking-wider">WARN</Badge>;
  return <Badge className="bg-green-600 text-white text-[10px] uppercase tracking-wider">OK</Badge>;
}

function overallBadge(s: "ok" | "warn" | "critical") {
  if (s === "critical")
    return (
      <Badge className="bg-terminal-red text-white text-sm px-3 py-1 uppercase tracking-widest">
        CRITICAL — Action Required
      </Badge>
    );
  if (s === "warn")
    return (
      <Badge className="bg-yellow-500 text-black text-sm px-3 py-1 uppercase tracking-widest">
        WARNINGS Detected
      </Badge>
    );
  return (
    <Badge className="bg-green-600 text-white text-sm px-3 py-1 uppercase tracking-widest">
      HEALTHY
    </Badge>
  );
}

function fileBar(chars: number) {
  const pct = Math.min(100, (chars / FILE_CRITICAL_CHARS) * 100);
  const color =
    chars >= FILE_CRITICAL_CHARS
      ? "bg-terminal-red"
      : chars >= FILE_WARN_CHARS
        ? "bg-yellow-500"
        : "bg-green-600";
  return (
    <div className="relative h-1.5 w-full overflow-hidden bg-muted">
      <div className={`h-full transition-all ${color}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function MaintenancePage() {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [report, setReport] = useState<MaintenanceReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resyncing, setResyncing] = useState(false);
  const [resyncMsg, setResyncMsg] = useState<string | null>(null);
  const [hideGettingStarted, setHideGettingStarted] = useState(false);
  const [hookReport, setHookReport] = useState<HookReport | null>(null);
  const [hookDryRun, setHookDryRun] = useState<string | null>(null);
  const [learningQuality, setLearningQuality] = useState<LearningQuality | null>(null);
  const [backupStatus, setBackupStatus] = useState<BackupStatus | null>(null);
  const [backupRunning, setBackupRunning] = useState(false);
  const [backupMsg, setBackupMsg] = useState<string | null>(null);
  const [bpMode, setBpMode] = useState("off");
  const [bpTarget, setBpTarget] = useState("");
  const [bpRetention, setBpRetention] = useState("5");
  const [bpCron, setBpCron] = useState("0 2 * * *");
  const [bpEnabled, setBpEnabled] = useState(false);
  const [bpSaving, setBpSaving] = useState(false);
  const [pluginHealth, setPluginHealth] = useState<PluginHealthRow[]>([]);

  const fetchReport = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const res = await fetch(isRefresh ? "/api/maintenance?scope=all&detail=full" : "/api/maintenance");
      const json = (await res.json()) as { success: boolean; data?: MaintenanceReport; error?: string };
      if (!json.success) throw new Error(json.error ?? "Unknown error");
      setReport(json.data ?? null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void fetchReport();
  }, [fetchReport]);

  const fetchHooks = useCallback(async () => {
    try {
      const res = await fetch("/api/hooks");
      const json = await res.json() as { success?: boolean; data?: HookReport };
      if (json.success && json.data) setHookReport(json.data);
    } catch {
      setHookReport(null);
    }
  }, []);

  const fetchLearningQuality = useCallback(async () => {
    try {
      const res = await fetch("/api/learning?action=quality-report");
      const json = await res.json() as { success?: boolean; data?: LearningQuality };
      if (json.success && json.data) setLearningQuality(json.data);
    } catch { /* ignore */ }
  }, []);

  const fetchBackupStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/backups?action=status");
      const json = await res.json() as { success?: boolean; data?: BackupStatus };
      if (json.success && json.data) {
        setBackupStatus(json.data);
        const cfg = json.data.config;
        setBpMode(cfg.backup_replication_mode ?? "off");
        setBpTarget(cfg.backup_replication_target ?? "");
        setBpRetention(String(cfg.backup_retention_count ?? 5));
        setBpCron(cfg.backup_cron ?? "0 2 * * *");
        setBpEnabled(json.data.enabled);
      }
    } catch { /* ignore */ }
  }, []);

  const fetchPluginHealth = useCallback(async () => {
    try {
      const [extRes, skillRes, cfgRes] = await Promise.all([
        fetch("/api/extensions").then((r) => r.json()),
        fetch("/api/skills?action=steward").then((r) => r.json()),
        fetch("/api/config").then((r) => r.json()),
      ]);
      const rows: PluginHealthRow[] = [];
      if (extRes.success && Array.isArray(extRes.data?.extensions)) {
        for (const ext of extRes.data.extensions as Array<{ id: string; name: string; globallyEnabled: boolean; installSource?: string }>) {
          rows.push({
            name: ext.name ?? ext.id,
            type: "extension",
            status: ext.globallyEnabled ? "active" : "disabled",
            hint: ext.installSource ?? null,
            url: "/extensions",
          });
        }
      }
      if (skillRes.success) {
        const allSkills = [
          ...(Array.isArray(skillRes.data?.mostUsed) ? (skillRes.data.mostUsed as Array<{ label?: string; id?: string; stewardStatus?: string }>) : []),
          ...(Array.isArray(skillRes.data?.unused) ? (skillRes.data.unused as Array<{ label?: string; id?: string; stewardStatus?: string }>) : []),
        ];
        for (const sk of allSkills) {
          const st = (sk.stewardStatus ?? "active") as string;
          rows.push({
            name: sk.label ?? sk.id ?? "skill",
            type: "skill",
            status: st === "stale" || st === "archived" ? "stale" : "active",
            hint: st !== "active" ? st : null,
            url: "/skills",
          });
        }
      }
      if (cfgRes.success && cfgRes.data?.mcp_servers) {
        try {
          const mcpList = JSON.parse(String(cfgRes.data.mcp_servers)) as Array<{ name?: string; url?: string; enabled?: boolean }>;
          for (const srv of mcpList) {
            rows.push({
              name: srv.name ?? srv.url ?? "mcp-server",
              type: "mcp",
              status: srv.enabled === false ? "disabled" : "active",
              hint: srv.url ?? null,
              url: "/mcp",
            });
          }
        } catch { /* ignore */ }
      }
      setPluginHealth(rows);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    void fetchHooks();
    void fetchLearningQuality();
    void fetchBackupStatus();
    void fetchPluginHealth();
  }, [fetchHooks, fetchLearningQuality, fetchBackupStatus, fetchPluginHealth]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(MAINTENANCE_UI_STATE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { hideGettingStarted?: boolean };
      setHideGettingStarted(Boolean(parsed.hideGettingStarted));
    } catch {
      // localStorage is optional; ignore malformed state.
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        MAINTENANCE_UI_STATE_KEY,
        JSON.stringify({ hideGettingStarted }),
      );
    } catch {
      // localStorage is optional.
    }
  }, [hideGettingStarted]);

  async function resyncCron() {
    setResyncing(true);
    setResyncMsg(null);
    try {
      const res = await fetch("/api/cron", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "resync" }),
      });
      const json = (await res.json()) as { success: boolean; error?: string };
      setResyncMsg(json.success ? "Cron scheduler resynced." : (json.error ?? "Failed"));
      await fetchReport(true);
    } catch (e) {
      setResyncMsg(String(e));
    } finally {
      setResyncing(false);
    }
  }

  async function dryRunHooks() {
    setHookDryRun("Running dry-run...");
    try {
      const res = await fetch("/api/hooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "debug:dry-run",
          payload: { sourceTab: "maintenance" },
        }),
      });
      const json = await res.json() as { success?: boolean; data?: { hookCount?: number; elapsedMs?: number }; error?: string };
      if (!json.success) throw new Error(json.error || "Hook dry-run failed");
      setHookDryRun(`Dry-run sent to ${json.data?.hookCount ?? 0} hook(s) in ${json.data?.elapsedMs ?? 0}ms.`);
      await fetchHooks();
    } catch (error) {
      setHookDryRun(String(error));
    }
  }

  async function setHookEnabled(path: string, enabled: boolean) {
    try {
      const res = await fetch("/api/hooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set-enabled", path, enabled }),
      });
      const json = await res.json() as { success?: boolean; error?: string };
      if (!json.success) throw new Error(json.error || "Hook update failed");
      await fetchHooks();
    } catch (error) {
      setHookDryRun(String(error));
    }
  }

  async function runBackupNow() {
    setBackupRunning(true);
    setBackupMsg(null);
    try {
      const res = await fetch("/api/backups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "run-policy" }),
      });
      const json = await res.json() as { success?: boolean; data?: { verified?: boolean; backupId?: string }; error?: string };
      setBackupMsg(json.success ? `Backup complete: ${json.data?.backupId ?? "done"} (verified: ${json.data?.verified ? "yes" : "no"})` : (json.error ?? "Failed"));
      await fetchBackupStatus();
    } catch (e) {
      setBackupMsg(String(e));
    } finally {
      setBackupRunning(false);
    }
  }

  async function saveBackupConfig() {
    setBpSaving(true);
    setBackupMsg(null);
    try {
      const res = await fetch("/api/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          backup_enabled: bpEnabled ? 1 : 0,
          backup_cron: bpCron,
          backup_retention_count: parseInt(bpRetention, 10) || 5,
          backup_replication_mode: bpMode,
          backup_replication_target: bpTarget || null,
        }),
      });
      const json = await res.json() as { success?: boolean; error?: string };
      setBackupMsg(json.success ? "Saved." : (json.error ?? "Failed"));
      await fetchBackupStatus();
    } catch (e) {
      setBackupMsg(String(e));
    } finally {
      setBpSaving(false);
    }
  }

  return (
        <main className="flex-1 overflow-auto p-6 space-y-6" data-perf-ready="maintenance">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h1 className="text-2xl font-bold">Maintenance</h1>
              <p className="text-sm text-muted-foreground">
                Workspace file budgets, scheduler health, database integrity, and system health.
              </p>
            </div>
          </div>

          {/* ── Jump-to Section Links ── */}
          <div className="flex flex-wrap gap-2">
            {[
              { label: "Hooks", id: "hooks" },
              { label: "Learning", id: "learning" },
              { label: "Backup", id: "backup" },
              { label: "Plugins", id: "plugins" },
              { label: "Workspace", id: "workspace" },
              { label: "Cron", id: "cron" },
              { label: "Database", id: "database" },
            ].map((section) => (
              <a
                key={section.id}
                href={`#${section.id}`}
                className="rounded-full border bg-background px-2.5 py-0.5 text-xs hover:bg-muted transition-colors"
              >
                {section.label}
              </a>
            ))}
          </div>

          {/* ── Controls ── */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              {report && overallBadge(report.overallSeverity)}
              {report && (
                <span className="text-[11px] text-muted-foreground font-mono">
                  Last scan: {new Date(report.generatedAt).toLocaleTimeString()}
                </span>
              )}
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => fetchReport(true)}
              disabled={loading || refreshing}
              className="uppercase tracking-wider text-xs"
            >
              {refreshing ? "Scanning…" : "Run Scan"}
            </Button>
          </div>

          {/* ── Error ── */}
          {error && (
            <Card className="border-terminal-red">
              <CardContent className="pt-4 text-terminal-red text-xs font-mono">{error}</CardContent>
            </Card>
          )}

          {/* ── Loading skeleton ── */}
          {loading && !report && (
            <div className="text-muted-foreground text-xs font-mono animate-pulse">Running maintenance scan…</div>
          )}

          {report && (
            hideGettingStarted ? (
              <div className="flex items-center justify-between gap-3 rounded-md border border-dashed px-3 py-2">
                <p className="text-sm text-muted-foreground">Maintenance tips hidden.</p>
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
              <div className="rounded-md border bg-muted/20 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                      Getting Started
                    </div>
                    <p className="mt-2 text-sm font-medium">Run this tab when agents feel slow or scheduled workflows look stale.</p>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      The scan flags oversized workspace files, cron workflows that are not live, stale executions,
                      locked tasks, and pending approvals. A healthy scan can legitimately have no suggestions.
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
          )}

          <Card id="hooks">
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <CardTitle className="text-sm">Hook Management</CardTitle>
                  <p className="mt-1 text-xs text-muted-foreground">Local workspace hooks, subscribed event hints, and dry-run checks.</p>
                </div>
                <div className="flex items-center gap-2">
                  {hookReport ? (
                    <Badge variant={hookReport.enabled ? "default" : "secondary"}>
                      {hookReport.enabled ? "enabled" : "disabled"}
                    </Badge>
                  ) : null}
                  <Button size="sm" variant="outline" onClick={() => void dryRunHooks()}>
                    Dry Run
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {hookReport ? (
                <>
                  <div className="break-all rounded-md border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                    {hookReport.directory}
                  </div>
                  {hookReport.eventGroups && hookReport.eventGroups.length > 0 ? (
                    <div className="rounded-md border bg-muted/20 px-3 py-2">
                      <div className="mb-2 text-[10px] uppercase tracking-wide text-muted-foreground">Event Groups</div>
                      <div className="flex flex-wrap gap-1">
                        {hookReport.eventGroups.map((group) => (
                          <Badge key={group.event} variant="outline" className="text-[10px]">
                            {group.event}: {group.enabledCount}/{group.hookCount}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  {hookReport.hooks.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No local hook files found yet.</p>
                  ) : (
                    <div className="space-y-2">
                      {hookReport.hooks.map((hook) => (
                        <div key={hook.path} className="rounded-md border px-3 py-2">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="min-w-0">
                              <div className="truncate text-sm font-medium">{hook.fileName}</div>
                              <div className="text-[11px] text-muted-foreground">
                                {hook.handler} handler · {hook.sizeBytes} bytes · {new Date(hook.updatedAt).toLocaleString()}
                              </div>
                              {!hook.enabled ? (
                                <div className="mt-1 text-[11px] text-muted-foreground">
                                  Disabled locally; runtime events will skip this hook.
                                </div>
                              ) : null}
                              {hook.lastRun ? (
                                <div className="mt-2 flex flex-wrap items-center gap-2">
                                  <Badge variant="outline" className="text-[10px]">
                                    {hook.eventFriendly}
                                  </Badge>
                                  {hook.lastRun.status ? (
                                    <Badge variant={hook.lastRun.status === "ok" ? "default" : "destructive"} className="text-[10px]">
                                      {hook.lastRun.status}
                                    </Badge>
                                  ) : null}
                                  <span className="text-[10px] text-muted-foreground">
                                    {hook.lastRun.ranAt ? new Date(hook.lastRun.ranAt).toLocaleString() : "never"}
                                  </span>
                                  {hook.lastRun.durationMs != null ? (
                                    <span className="text-[10px] text-muted-foreground">{hook.lastRun.durationMs}ms</span>
                                  ) : null}
                                </div>
                              ) : null}
                              {hook.lastRun?.error ? (
                                <div className="mt-1 rounded bg-destructive/10 px-2 py-1 text-[10px] text-destructive">
                                  {hook.lastRun.error}
                                </div>
                              ) : null}
                            </div>
                            <div className="flex shrink-0 items-center gap-2">
                              <Button
                                size="sm"
                                variant={hook.enabled ? "outline" : "default"}
                                className="h-7 px-2 text-[11px]"
                                onClick={() => void setHookEnabled(hook.path, !hook.enabled)}
                              >
                                {hook.enabled ? "Disable" : "Enable"}
                              </Button>
                              <Badge variant={hook.enabled ? "default" : "secondary"}>
                                {hook.enabled ? "enabled" : "disabled"}
                              </Badge>
                              {hook.lastRun ? (
                                <Badge variant={hook.lastRun.status === "failed" ? "destructive" : "outline"}>{hook.lastRun.status}</Badge>
                              ) : null}
                              <Badge variant="outline">{hook.eventHints.length || "any"} event hints</Badge>
                            </div>
                          </div>
                          {hook.eventHints.length > 0 ? (
                            <div className="mt-2 flex flex-wrap gap-1">
                              {hook.eventHints.map((event) => <Badge key={event} variant="secondary" className="text-[10px]">{event}</Badge>)}
                            </div>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="flex flex-wrap gap-1">
                    {hookReport.supportedEvents.map((event) => (
                      <Badge key={event} variant="outline" className="text-[10px]">{event}</Badge>
                    ))}
                  </div>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">Hook status has not loaded yet.</p>
              )}
              {hookDryRun ? <p className="text-xs text-muted-foreground">{hookDryRun}</p> : null}
            </CardContent>
          </Card>

          {/* ── Learning Quality Report ── */}
          <Card id="learning">
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <CardTitle className="text-sm">Self-Learning Quality</CardTitle>
                  <p className="mt-1 text-xs text-muted-foreground">Candidate pipeline health, capture settings, and guard block rate.</p>
                </div>
                <div className="flex items-center gap-2">
                  {learningQuality && (
                    <Badge variant="outline" className="text-[10px]">{learningQuality.learningMode}</Badge>
                  )}
                  <Button size="sm" variant="outline" onClick={() => void fetchLearningQuality()}>Refresh</Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {learningQuality ? (
                <>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    {[
                      { label: "Promoted", value: learningQuality.promotedCount, color: "text-green-500" },
                      { label: "Dismissed", value: learningQuality.dismissedCount, color: "text-muted-foreground" },
                      { label: "Proposed", value: learningQuality.proposedCount, color: learningQuality.proposedCount > 10 ? "text-yellow-500" : "text-foreground" },
                      { label: "Guard Blocks", value: learningQuality.guardBlockCount, color: learningQuality.guardBlockCount > 0 ? "text-yellow-500" : "text-foreground" },
                    ].map((m) => (
                      <div key={m.label} className="rounded-md border px-3 py-2 space-y-1">
                        <div className={`text-xl font-mono font-bold ${m.color}`}>{m.value}</div>
                        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{m.label}</div>
                      </div>
                    ))}
                  </div>
                  {learningQuality.promotedToDismissedRatio !== null && (
                    <p className="text-xs text-muted-foreground">
                      Promote/dismiss ratio: <span className="font-mono text-foreground">{learningQuality.promotedToDismissedRatio}:1</span>
                      {learningQuality.promotedToDismissedRatio < 1 && " — more dismissals than promotions; consider tuning capture filters."}
                    </p>
                  )}
                  {learningQuality.staleCandidateCount > 0 && (
                    <div className="rounded-md border border-yellow-500/30 bg-yellow-500/5 px-3 py-2 space-y-1">
                      <div className="text-[10px] uppercase tracking-wider text-yellow-500">Stale Proposed (&gt;7 days)</div>
                      <div className="space-y-0.5 max-h-28 overflow-y-auto">
                        {learningQuality.staleCandidates.map((c) => (
                          <div key={c.id} className="flex items-center justify-between text-[11px] font-mono">
                            <span className="truncate text-muted-foreground">{c.title}</span>
                            <span className="ml-2 shrink-0 text-yellow-500">{c.daysSinceCreated}d</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="flex flex-wrap gap-2">
                    {[
                      { label: "Feedback", active: learningQuality.feedbackEnabled },
                      { label: "Preferences", active: learningQuality.capturePreferences },
                      { label: "Playbooks", active: learningQuality.capturePlaybooks },
                      { label: "LLM Review", active: learningQuality.llmReviewEnabled },
                    ].map((item) => (
                      <Badge key={item.label} variant={item.active ? "default" : "secondary"} className="text-[10px]">
                        {item.label}: {item.active ? "on" : "off"}
                      </Badge>
                    ))}
                  </div>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">Loading learning quality…</p>
              )}
            </CardContent>
          </Card>

          {/* ── Backup Setup Wizard ── */}
          <Card id="backup">
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <CardTitle className="text-sm">Backup Setup</CardTitle>
                  <p className="mt-1 text-xs text-muted-foreground">Configure scheduled backups and off-machine replication.</p>
                </div>
                <div className="flex items-center gap-2">
                  {backupStatus && (
                    <Badge variant={backupStatus.enabled ? "default" : "secondary"} className="text-[10px]">
                      {backupStatus.enabled ? "enabled" : "disabled"}
                    </Badge>
                  )}
                  <Button size="sm" variant="outline" onClick={() => void runBackupNow()} disabled={backupRunning}>
                    {backupRunning ? "Running…" : "Run Now"}
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {backupStatus?.setupWarnings?.some((w) => w.includes("local-only") || w.includes("no off-machine")) && (
                <div className="rounded-md border border-yellow-500/40 bg-yellow-500/5 px-3 py-2 text-xs text-yellow-600 dark:text-yellow-400">
                  ⚠ No off-machine replication target configured. Your backups are local-only — configure a mirror or rsync target below.
                </div>
              )}
              {backupStatus && (
                <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground font-mono">
                  <span>Last run: {backupStatus.lastRunAt ? new Date(backupStatus.lastRunAt).toLocaleString() : "never"}</span>
                  <span>Last success: {backupStatus.lastSuccessAt ? new Date(backupStatus.lastSuccessAt).toLocaleString() : "never"}</span>
                  {backupStatus.nextRunAt && <span>Next: {new Date(backupStatus.nextRunAt).toLocaleString()}</span>}
                  {backupStatus.latestBackup && <span>Latest: {backupStatus.latestBackup.id.slice(0, 16)} · {(backupStatus.latestBackup.sizeBytes / 1024).toFixed(0)} KB</span>}
                </div>
              )}
              {backupStatus?.lastError && (
                <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-[11px] font-mono text-destructive">
                  Last error: {backupStatus.lastError}
                </div>
              )}
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label className="text-xs">Replication Mode</Label>
                  <Select value={bpMode} onValueChange={setBpMode}>
                    <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="off">Off (local only)</SelectItem>
                      <SelectItem value="mirror-copy">Mirror Copy (local path)</SelectItem>
                      <SelectItem value="rsync">rsync (remote)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Target Path / Remote</Label>
                  <Input className="h-8 text-xs" placeholder="/backup/path or user@host:/path" value={bpTarget} onChange={(e) => setBpTarget(e.target.value)} disabled={bpMode === "off"} />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Retention Count</Label>
                  <Input className="h-8 text-xs" type="number" min="1" max="100" value={bpRetention} onChange={(e) => setBpRetention(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Cron Schedule</Label>
                  <Input className="h-8 text-xs font-mono" placeholder="0 2 * * *" value={bpCron} onChange={(e) => setBpCron(e.target.value)} />
                </div>
              </div>
              <div className="flex items-center gap-3">
                <Button size="sm" onClick={() => { setBpEnabled((v) => !v); }} variant={bpEnabled ? "default" : "outline"} className="text-xs">
                  {bpEnabled ? "Scheduled: on" : "Scheduled: off"}
                </Button>
                <Button size="sm" onClick={() => void saveBackupConfig()} disabled={bpSaving} className="text-xs">
                  {bpSaving ? "Saving…" : "Save Config"}
                </Button>
              </div>
              {backupMsg && <p className="text-xs font-mono text-muted-foreground">{backupMsg}</p>}
              <details className="rounded-md border">
                <summary className="cursor-pointer px-3 py-2 text-xs font-mono uppercase tracking-wider text-muted-foreground select-none">
                  Restore Drill Instructions
                </summary>
                <ol className="px-4 py-3 space-y-1.5 text-[11px] text-muted-foreground list-decimal list-inside">
                  <li>Stop the disp8ch server (<code>Ctrl+C</code> or kill the process).</li>
                  <li>Identify the backup you want to restore: <code>GET /api/backups</code> or <code>ls data/backups/</code>.</li>
                  <li>Call <code>POST /api/backups {"{"} action: &quot;restore&quot;, id: &quot;&lt;backup-id&gt;&quot;, dryRun: true {"}"}</code> first to preview the restore plan.</li>
                  <li>If the dry-run looks correct, repeat with <code>dryRun: false</code> to apply.</li>
                  <li>Restart the server. The restored DB and workspace files will be active immediately.</li>
                  <li>Verify health: <code>GET /api/health</code> and run a quick WebChat message.</li>
                </ol>
              </details>
            </CardContent>
          </Card>

          {/* ── Plugin Lifecycle Health ── */}
          <Card id="plugins">
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <CardTitle className="text-sm">Plugin Lifecycle</CardTitle>
                  <p className="mt-1 text-xs text-muted-foreground">Unified health overview of extensions, skills, and MCP servers.</p>
                </div>
                <Button size="sm" variant="outline" onClick={() => void fetchPluginHealth()}>Refresh</Button>
              </div>
            </CardHeader>
            <CardContent>
              {pluginHealth.length === 0 ? (
                <p className="text-sm text-muted-foreground">No plugins discovered yet.</p>
              ) : (
                <div className="space-y-1.5">
                  {pluginHealth.map((row, i) => (
                    <div key={i} className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-xs">
                      <div className="flex items-center gap-2 min-w-0">
                        <Badge variant="outline" className={`text-[10px] shrink-0 ${row.type === "extension" ? "border-violet-500 text-violet-400" : row.type === "mcp" ? "border-cyan-500 text-cyan-400" : "border-pink-500 text-pink-400"}`}>
                          {row.type}
                        </Badge>
                        <span className="font-medium truncate">{row.name}</span>
                        {row.hint && <span className="hidden sm:block text-muted-foreground truncate max-w-[200px]">{row.hint}</span>}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <Badge className={`text-[10px] ${row.status === "active" ? "bg-green-600/20 text-green-500 border-green-600" : row.status === "error" ? "bg-red-600/20 text-red-500 border-red-600" : row.status === "stale" ? "bg-yellow-500/20 text-yellow-500 border-yellow-500" : "bg-muted text-muted-foreground"}`} variant="outline">
                          {row.status}
                        </Badge>
                        <a href={row.url} className="text-[10px] text-muted-foreground underline hover:text-foreground">manage</a>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {report && (
            <>
              {/* ── Suggestions ── */}
              {report.suggestions.length > 0 ? (
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-xs uppercase tracking-widest text-muted-foreground">
                      {"// Suggestions"}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-1.5">
                    {report.suggestions.map((s, i) => {
                      const isCrit = s.startsWith("[CRITICAL]");
                      const isWarn = s.startsWith("[WARN]");
                      return (
                        <div
                          key={i}
                          className={`text-xs font-mono px-3 py-2 border-l-2 ${
                            isCrit
                              ? "border-terminal-red text-terminal-red bg-terminal-red/5"
                              : isWarn
                                ? "border-yellow-500 text-yellow-600 dark:text-yellow-400 bg-yellow-500/5"
                                : "border-muted-foreground text-muted-foreground"
                          }`}
                        >
                          {s}
                        </div>
                      );
                    })}
                  </CardContent>
                </Card>
              ) : (
                <Card>
                  <CardContent className="py-4">
                    <p className="text-xs font-mono text-muted-foreground">
                      No maintenance suggestions for the latest scan.
                    </p>
                  </CardContent>
                </Card>
              )}

              {/* ── Workspace File Bloat ── */}
              <Card id="workspace">
                <CardHeader className="pb-2">
                  <CardTitle className="text-xs uppercase tracking-widest text-muted-foreground">
                    {"// Workspace Files \u2014 Bootstrap Budget Audit"}
                  </CardTitle>
                  <p className="text-[11px] text-muted-foreground font-mono mt-1">
                    Warn ≥ {(FILE_WARN_CHARS / 1000).toFixed(0)}k chars · Critical ≥{" "}
                    {(FILE_CRITICAL_CHARS / 1000).toFixed(0)}k chars per file. Large files slow context loading.
                  </p>
                </CardHeader>
                <CardContent className="space-y-6">
                  {report.workspace.map((ws) => (
                    <div key={ws.agentId} className="space-y-2">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-mono font-bold uppercase tracking-wider">
                          {ws.agentName}
                        </span>
                        {severityBadge(ws.totalSeverity)}
                        <span className="text-[11px] text-muted-foreground font-mono ml-auto">
                          Total: {fmtChars(ws.totalChars)} chars
                        </span>
                      </div>
                      <div className="space-y-1">
                        {ws.files
                          .filter((f) => !f.missing)
                          .map((f) => (
                            <div key={f.name} className="grid grid-cols-[140px_1fr_80px_60px] items-center gap-3">
                              <span
                                className={`text-[11px] font-mono ${
                                  f.severity === "critical"
                                    ? "text-terminal-red"
                                    : f.severity === "warn"
                                      ? "text-yellow-600 dark:text-yellow-400"
                                      : "text-muted-foreground"
                                }`}
                              >
                                {f.name}
                              </span>
                              <div>{fileBar(f.chars)}</div>
                              <span className="text-[10px] font-mono text-right text-muted-foreground">
                                {fmtChars(f.chars)} chars
                              </span>
                              <span className="text-[10px] font-mono text-right text-muted-foreground">
                                {f.lines} lines
                              </span>
                            </div>
                          ))}
                        {ws.files.every((f) => f.missing) && (
                          <p className="text-[11px] text-muted-foreground font-mono">No workspace files found.</p>
                        )}
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>

              {/* ── Cron Health ── */}
              <Card id="cron">
                <CardHeader className="pb-2 flex flex-row items-center justify-between">
                  <CardTitle className="text-xs uppercase tracking-widest text-muted-foreground">
                    {"// Cron Scheduler Health"}
                  </CardTitle>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={resyncCron}
                    disabled={resyncing}
                    className="text-xs uppercase tracking-wider h-7 px-2"
                  >
                    {resyncing ? "Resyncing…" : "Resync"}
                  </Button>
                </CardHeader>
                {resyncMsg && (
                  <div className="px-6 pb-2 text-[11px] font-mono text-muted-foreground">{resyncMsg}</div>
                )}
                <CardContent>
                  {report.cron.length === 0 ? (
                    <p className="text-[11px] text-muted-foreground font-mono">
                      No cron-trigger workflows found.
                    </p>
                  ) : (
                    <div className="space-y-1">
                      {report.cron.map((c, i) => (
                        <div
                          key={i}
                          className="flex items-center gap-3 text-[11px] font-mono py-1 border-b border-border last:border-0"
                        >
                          <span
                            className={`h-2 w-2 shrink-0 ${c.isLive ? "bg-green-500" : "bg-yellow-500"}`}
                          />
                          <span className="flex-1 truncate">{c.workflowName}</span>
                          <span className="text-muted-foreground">{c.expression || "—"}</span>
                          <Badge
                            className={`text-[9px] uppercase tracking-wider ${
                              c.isLive
                                ? "bg-green-600/20 text-green-600 border-green-600"
                                : "bg-yellow-500/20 text-yellow-600 border-yellow-500"
                            }`}
                            variant="outline"
                          >
                            {c.isLive ? "LIVE" : "NOT LIVE"}
                          </Badge>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* ── DB Integrity ── */}
              <Card id="database">
                <CardHeader className="pb-2">
                  <CardTitle className="text-xs uppercase tracking-widest text-muted-foreground">
                    {"// Database Integrity"}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-3 gap-4">
                    <div className="space-y-1">
                      <div
                        className={`text-2xl font-mono font-bold ${
                          report.db.staleExecutions > 0 ? "text-yellow-500" : "text-foreground"
                        }`}
                      >
                        {report.db.staleExecutions}
                      </div>
                      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                        Stale Executions
                      </div>
                      <div className="text-[10px] text-muted-foreground font-mono">
                        Running &gt;30 min
                      </div>
                    </div>
                    <div className="space-y-1">
                      <div
                        className={`text-2xl font-mono font-bold ${
                          report.db.lockedTasks > 0 ? "text-yellow-500" : "text-foreground"
                        }`}
                      >
                        {report.db.lockedTasks}
                      </div>
                      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                        Locked Tasks
                      </div>
                      <div className="text-[10px] text-muted-foreground font-mono">
                        Execution-locked
                      </div>
                    </div>
                    <div className="space-y-1">
                      <div
                        className={`text-2xl font-mono font-bold ${
                          report.db.pendingApprovals > 0 ? "text-yellow-500" : "text-foreground"
                        }`}
                      >
                        {report.db.pendingApprovals}
                      </div>
                      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                        Pending Approvals
                      </div>
                      <div className="text-[10px] text-muted-foreground font-mono">
                        Tool approvals queue
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* ── Tips ── */}
              <Card className="border-dashed">
                <CardHeader className="pb-2">
                  <CardTitle className="text-xs uppercase tracking-widest text-muted-foreground">
                    {"// Spring Cleaning Tips"}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-[11px] font-mono text-muted-foreground">
                  <p>
                    <span className="text-foreground">SOUL.md / USER.md</span> — Keep under 8k chars. Remove
                    outdated preferences. Keep core personality + must-know facts only.
                  </p>
                  <p>
                    <span className="text-foreground">MEMORY.md</span> — Archive old entries to dated files in{" "}
                    <code>memory/YYYY-MM-DD.md</code>. Mark stale entries{" "}
                    <code>status=deleted</code>.
                  </p>
                  <p>
                    <span className="text-foreground">HEARTBEAT.md</span> — Keep this file short (&lt;1k chars).
                    It&apos;s loaded on every heartbeat run.
                  </p>
                  <p>
                    <span className="text-foreground">BOOT.md</span> — Should be a compact checklist only. Move
                    detailed instructions to TOOLS.md or IDENTITY.md.
                  </p>
                  <p>
                    <span className="text-foreground">Cron not live?</span> — Hit <strong>Resync</strong> above, or
                    send <code>POST /api/cron &#123; action:&quot;resync&quot; &#125;</code> after creating new
                    cron workflows.
                  </p>
                  <p>
                    <span className="text-foreground">Stale executions?</span> — Check{" "}
                    <a href="/activity" className="text-terminal-red underline">
                      /activity
                    </a>{" "}
                    and the logs for errors. Restart the server if a workflow hung silently.
                  </p>
                </CardContent>
              </Card>
            </>
          )}
        </main>
  );
}
