"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Clock,
  Play,
  RefreshCw,
  Timer,
  Zap,
  CheckCircle2,
  XCircle,
  RotateCcw,
  ToggleLeft,
  ToggleRight,
  AlertCircle,
  Webhook,
  Copy,
  Eye,
  EyeOff,
  Trash2,
  Plus,
  ExternalLink,
  MessageSquare,
  MousePointer,
  KeyRound,
} from "lucide-react";
import Link from "next/link";
import { GuidedAutomationModal } from "@/components/automations/guided-automation-modal";
import { usePolling } from "@/lib/client/use-polling";
import { useAfterUseful } from "@/lib/client/use-after-useful";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

// ─── Cron types ──────────────────────────────────────────────────────────────

interface CronJob {
  workflowId: string;
  workflowName: string;
  workflowDescription: string;
  workflowActive: boolean;
  nodeId: string;
  label: string;
  expression: string;
  timezone: string;
  isLive: boolean;
  nextRunAt: string | null;
  lastRun: { id: string; status: string; createdAt: string } | null;
  recentRuns: Array<{ id: string; status: string; createdAt: string; completedAt: string | null; error: string | null }>;
  profile: {
    label: string;
    priority: string;
    overlapPolicy: string;
    timeoutMinutes: number;
    agentId: string | null;
    workspacePath: string | null;
    deliveryRoute: string;
    retryPolicy: string;
    silenceOnSuccess: boolean;
    skillOverrides?: string[];
    extensionOverrides?: string[];
  };
}

interface CronSummary {
  totalJobs: number;
  activeJobs: number;
  liveCount: number;
}

// ─── Webhook types ────────────────────────────────────────────────────────────

interface WebhookAutomation {
  id: string;
  name: string;
  url: string;
  absoluteUrl: string;
  workflowId: string;
  workflowName: string;
  workflowActive: boolean;
  createdAt: string;
  isActive: boolean;
  hasWebhookTrigger: boolean;
  lastExecution: null | {
    id: string;
    status: string;
    startedAt: string;
    completedAt: string | null;
    error: string | null;
  };
}

interface WebhookSummary {
  total: number;
  active: number;
  inactive: number;
}

interface WorkflowOption {
  id: string;
  name: string;
}

interface SecretReveal {
  webhookId: string;
  webhookName: string;
  url: string;
  secret: string;
  isRotate: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const AUTOMATIONS_UI_STATE_KEY = "disp8ch-scheduler-ui-state";

function cronLabel(expr: string): string {
  const clean = expr.trim();
  const map: Record<string, string> = {
    "* * * * *": "Every minute",
    "*/5 * * * *": "Every 5 minutes",
    "*/10 * * * *": "Every 10 minutes",
    "*/15 * * * *": "Every 15 minutes",
    "*/30 * * * *": "Every 30 minutes",
    "0 * * * *": "Every hour",
    "0 */2 * * *": "Every 2 hours",
    "0 */6 * * *": "Every 6 hours",
    "0 */12 * * *": "Every 12 hours",
    "0 9 * * *": "Daily at 9:00 AM",
    "0 8 * * *": "Daily at 8:00 AM",
    "0 0 * * *": "Daily at midnight",
    "0 12 * * *": "Daily at noon",
    "0 18 * * *": "Daily at 6:00 PM",
    "0 9 * * 1": "Mondays at 9:00 AM",
    "0 9 * * 1-5": "Weekdays at 9:00 AM",
    "0 0 * * 0": "Weekly on Sunday",
    "0 0 1 * *": "Monthly on the 1st",
  };
  return map[clean] || clean;
}

function relativeTime(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 5000) return "just now";
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return new Date(iso).toLocaleDateString();
}

function signingBashExample(url: string): string {
  return `BODY='{"event":"test","source":"manual"}'
TIMESTAMP="$(date +%s)"
NONCE="$(uuidgen)"
SIGNATURE="$(printf '%s.%s' "$TIMESTAMP" "$BODY" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" -hex | sed 's/^.* //')"

curl -X POST "${url}" \\
  -H "content-type: application/json" \\
  -H "x-webhook-timestamp: $TIMESTAMP" \\
  -H "x-webhook-nonce: $NONCE" \\
  -H "x-webhook-signature: $SIGNATURE" \\
  --data "$BODY"`;
}

function signingNodeExample(url: string): string {
  return `import crypto from "node:crypto";
const secret = process.env.WEBHOOK_SECRET;
const body = JSON.stringify({ event: "test", source: "manual" });
const timestamp = Math.floor(Date.now() / 1000).toString();
const nonce = crypto.randomUUID();
const sig = crypto.createHmac("sha256", secret)
  .update(\`\${timestamp}.\${body}\`).digest("hex");

await fetch("${url}", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-webhook-timestamp": timestamp,
    "x-webhook-nonce": nonce,
    "x-webhook-signature": sig,
  },
  body,
});`;
}

// ─── CopyButton ───────────────────────────────────────────────────────────────

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const doCopy = () => {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };
  return (
    <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={doCopy}>
      <Copy className="mr-1 h-3 w-3" />
      {copied ? "Copied!" : label}
    </Button>
  );
}

// ─── SecretRevealDialog ───────────────────────────────────────────────────────

function SecretRevealDialog({ reveal, onClose }: { reveal: SecretReveal; onClose: () => void }) {
  const [showSecret, setShowSecret] = useState(false);
  const absUrl = typeof window !== "undefined"
    ? `${window.location.origin}${reveal.url}`
    : reveal.url;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{reveal.isRotate ? "Secret Rotated" : "Webhook Created"}</DialogTitle>
          <DialogDescription>
            {reveal.isRotate
              ? "The old secret is immediately invalid. Copy the new secret now — it will not be shown again."
              : "Copy the secret now — it will not be shown again after you close this dialog."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          <div className="space-y-1">
            <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">Webhook URL</div>
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded bg-muted px-3 py-2 text-xs break-all">{absUrl}</code>
              <CopyButton text={absUrl} label="Copy URL" />
            </div>
          </div>
          <div className="space-y-1">
            <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
              Signing Secret <span className="text-amber-400">(shown once)</span>
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded bg-amber-500/10 border border-amber-500/30 px-3 py-2 text-xs break-all text-amber-300 font-mono">
                {showSecret ? reveal.secret : "•".repeat(Math.min(reveal.secret.length, 48))}
              </code>
              <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => setShowSecret((s) => !s)}>
                {showSecret ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </Button>
              <CopyButton text={reveal.secret} label="Copy Secret" />
            </div>
          </div>
          <div className="space-y-1">
            <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">Bash Signing Example</div>
            <div className="relative">
              <pre className="overflow-x-auto rounded bg-muted p-3 text-[11px] text-muted-foreground">{signingBashExample(absUrl)}</pre>
              <div className="absolute right-2 top-2">
                <CopyButton text={signingBashExample(absUrl)} label="Copy" />
              </div>
            </div>
          </div>
          <div className="space-y-1">
            <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">Node.js Signing Example</div>
            <div className="relative">
              <pre className="overflow-x-auto rounded bg-muted p-3 text-[11px] text-muted-foreground">{signingNodeExample(absUrl)}</pre>
              <div className="absolute right-2 top-2">
                <CopyButton text={signingNodeExample(absUrl)} label="Copy" />
              </div>
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Set <code className="bg-muted px-1 rounded">WEBHOOK_SECRET</code> in your integration environment. Use timestamp+nonce to prevent replay attacks.
          </p>
          <div className="flex justify-end">
            <Button onClick={onClose}>Done</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function SchedulerPage() {
  // Cron state
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [cronSummary, setCronSummary] = useState<CronSummary>({ totalJobs: 0, activeJobs: 0, liveCount: 0 });
  const [cronLoading, setCronLoading] = useState(true);
  const [running, setRunning] = useState<Record<string, boolean>>({});
  const [toggling, setToggling] = useState<Record<string, boolean>>({});
  const [resyncing, setResyncing] = useState(false);
  const [hideGettingStarted, setHideGettingStarted] = useState(false);
  const [savingProfile, setSavingProfile] = useState<Record<string, boolean>>({});

  // Webhook state
  const [webhooks, setWebhooks] = useState<WebhookAutomation[]>([]);
  const [webhookSummary, setWebhookSummary] = useState<WebhookSummary>({ total: 0, active: 0, inactive: 0 });
  const [webhooksLoading, setWebhooksLoading] = useState(true);
  const [webhookError, setWebhookError] = useState<string | null>(null);
  const [webhookActionBusy, setWebhookActionBusy] = useState<Record<string, boolean>>({});

  // Create webhook form
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [showGuided, setShowGuided] = useState(false);
  const [createWorkflowId, setCreateWorkflowId] = useState("");
  const [createName, setCreateName] = useState("");
  const [createActive, setCreateActive] = useState(true);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [workflowOptions, setWorkflowOptions] = useState<WorkflowOption[]>([]);

  // Signing example expansion
  const [expandedSigning, setExpandedSigning] = useState<string | null>(null);

  // Secret reveal dialog
  const [secretReveal, setSecretReveal] = useState<SecretReveal | null>(null);

  // ── Cron loader ─────────────────────────────────────────────────────────────

  const loadCron = useCallback(async () => {
    try {
      const res = await fetch("/api/cron");
      const json = await res.json() as { success: boolean; data: { summary: CronSummary; jobs: CronJob[] } };
      if (json.success) {
        setCronSummary(json.data.summary);
        setJobs(json.data.jobs);
      }
    } catch {
      // no-op
    } finally {
      setCronLoading(false);
    }
  }, []);

  // ── Webhook loader ───────────────────────────────────────────────────────────

  const loadWebhooks = useCallback(async () => {
    try {
      const res = await fetch("/api/webhooks");
      const json = await res.json() as { success: boolean; data: { summary: WebhookSummary; webhooks: WebhookAutomation[] } };
      if (json.success) {
        setWebhookSummary(json.data.summary);
        setWebhooks(json.data.webhooks);
        setWebhookError(null);
      } else {
        setWebhookError("Failed to load webhooks");
      }
    } catch {
      setWebhookError("Could not reach /api/webhooks");
    } finally {
      setWebhooksLoading(false);
    }
  }, []);

  const loadAll = useCallback(async () => {
    await Promise.all([loadCron(), loadWebhooks()]);
  }, [loadCron, loadWebhooks]);

  useAfterUseful(() => { void loadAll(); }, [loadAll]);

  usePolling(
    async () => { await loadCron(); },
    [loadCron],
    { intervalMs: 5000, enabled: true, pauseWhenHidden: true, backoffOnError: true, immediate: false },
  );

  usePolling(
    async () => { await loadWebhooks(); },
    [loadWebhooks],
    { intervalMs: 12000, enabled: true, pauseWhenHidden: true, backoffOnError: true, immediate: false },
  );

  // Persist getting-started state
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(AUTOMATIONS_UI_STATE_KEY);
      if (raw) setHideGettingStarted(Boolean((JSON.parse(raw) as { hideGettingStarted?: boolean }).hideGettingStarted));
    } catch { /* keep default */ }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(AUTOMATIONS_UI_STATE_KEY, JSON.stringify({ hideGettingStarted }));
    } catch { /* ignore */ }
  }, [hideGettingStarted]);

  // Load workflow options for create form
  useEffect(() => {
    if (!showCreateForm) return;
    void fetch("/api/workflows?pageSize=200")
      .then((r) => r.json())
      .then((json: { success?: boolean; data?: { workflows?: WorkflowOption[] }; workflows?: WorkflowOption[] }) => {
        const list: WorkflowOption[] =
          json.data?.workflows ?? (json.workflows as WorkflowOption[] | undefined) ?? [];
        setWorkflowOptions(list.filter((w) => w.id && w.name));
        if (list.length > 0 && !createWorkflowId) setCreateWorkflowId(list[0]!.id);
      })
      .catch(() => { /* ignore */ });
  }, [showCreateForm]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Cron actions ──────────────────────────────────────────────────────────────

  const runNow = async (workflowId: string) => {
    setRunning((r) => ({ ...r, [workflowId]: true }));
    try {
      await fetch("/api/cron", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "run", workflowId }),
      });
      setTimeout(() => void loadCron(), 1200);
    } finally {
      setTimeout(() => setRunning((r) => ({ ...r, [workflowId]: false })), 1500);
    }
  };

  const toggleCron = async (workflowId: string) => {
    setToggling((t) => ({ ...t, [workflowId]: true }));
    try {
      await fetch("/api/cron", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "toggle", workflowId }),
      });
      await loadCron();
    } finally {
      setToggling((t) => ({ ...t, [workflowId]: false }));
    }
  };

  const resync = async () => {
    setResyncing(true);
    try {
      await fetch("/api/cron", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "resync" }),
      });
      await loadCron();
    } finally {
      setResyncing(false);
    }
  };

  const updateProfile = async (workflowId: string, profile: Partial<CronJob["profile"]>) => {
    setSavingProfile((current) => ({ ...current, [workflowId]: true }));
    try {
      await fetch("/api/cron", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "profile", workflowId, profile }),
      });
      await loadCron();
    } finally {
      setSavingProfile((current) => ({ ...current, [workflowId]: false }));
    }
  };

  // ── Webhook actions ───────────────────────────────────────────────────────────

  const webhookAction = async (payload: Record<string, unknown>): Promise<{ success: boolean; data: Record<string, unknown> }> => {
    const res = await fetch("/api/webhooks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return res.json() as Promise<{ success: boolean; data: Record<string, unknown> }>;
  };

  const toggleWebhook = async (id: string, currentActive: boolean) => {
    setWebhookActionBusy((b) => ({ ...b, [id]: true }));
    try {
      await webhookAction({ action: "toggle", id, isActive: !currentActive });
      await loadWebhooks();
    } finally {
      setWebhookActionBusy((b) => ({ ...b, [id]: false }));
    }
  };

  const rotateSecret = async (wh: WebhookAutomation) => {
    if (!confirm(`Rotate secret for "${wh.name}"? The old secret will stop working immediately.`)) return;
    setWebhookActionBusy((b) => ({ ...b, [wh.id]: true }));
    try {
      const result = await webhookAction({ action: "rotate-secret", id: wh.id });
      if (result.success) {
        setSecretReveal({
          webhookId: wh.id,
          webhookName: wh.name,
          url: wh.url,
          secret: result.data.secret as string,
          isRotate: true,
        });
        await loadWebhooks();
      }
    } finally {
      setWebhookActionBusy((b) => ({ ...b, [wh.id]: false }));
    }
  };

  const deleteWebhook = async (wh: WebhookAutomation) => {
    if (!confirm(`Delete webhook "${wh.name}"? This cannot be undone.`)) return;
    setWebhookActionBusy((b) => ({ ...b, [wh.id]: true }));
    try {
      await webhookAction({ action: "delete", id: wh.id });
      await loadWebhooks();
    } finally {
      setWebhookActionBusy((b) => ({ ...b, [wh.id]: false }));
    }
  };

  const createWebhook = async () => {
    if (!createWorkflowId || !createName.trim()) {
      setCreateError("Workflow and name are required.");
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      const result = await webhookAction({ action: "create", workflowId: createWorkflowId, name: createName.trim(), isActive: createActive });
      if (result.success) {
        setSecretReveal({
          webhookId: result.data.id as string,
          webhookName: result.data.workflowName as string,
          url: result.data.url as string,
          secret: result.data.secret as string,
          isRotate: false,
        });
        setShowCreateForm(false);
        setCreateName("");
        setCreateWorkflowId("");
        setCreateActive(true);
        await loadWebhooks();
      } else {
        setCreateError(String(result.data?.error ?? "Create failed"));
      }
    } catch (err) {
      setCreateError(String(err));
    } finally {
      setCreating(false);
    }
  };

  // ── Layout ────────────────────────────────────────────────────────────────────

  const groupedByWorkflow = jobs.reduce<Record<string, CronJob[]>>((acc, job) => {
    if (!acc[job.workflowId]) acc[job.workflowId] = [];
    acc[job.workflowId].push(job);
    return acc;
  }, {});

  return (
    <main className="flex-1 overflow-auto p-6" data-perf-ready="scheduler">
      {/* Secret reveal dialog */}
      {secretReveal && (
        <SecretRevealDialog reveal={secretReveal} onClose={() => setSecretReveal(null)} />
      )}

      {/* Guided automation modal */}
      <GuidedAutomationModal open={showGuided} onClose={() => setShowGuided(false)} onCreated={() => void loadAll()} />

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Automations</h1>
          <p className="text-sm text-muted-foreground">
            Manage time-based and event-based workflow triggers.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => setShowGuided(true)}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Create automation
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowCreateForm((v) => !v)}
          >
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            New Webhook
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void resync()}
            disabled={resyncing}
          >
            <RotateCcw className={`mr-1.5 h-3.5 w-3.5 ${resyncing ? "animate-spin" : ""}`} />
            Resync Cron
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void loadAll()}>
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* ── Summary cards ──────────────────────────────────────────────────── */}
      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Card>
          <CardContent className="flex items-center gap-4 p-4">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-violet-500/10">
              <Timer className="h-5 w-5 text-violet-400" />
            </div>
            <div>
              <div className="text-2xl font-bold">{cronSummary.totalJobs}</div>
              <div className="text-xs text-muted-foreground">Total cron jobs</div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-4 p-4">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-green-500/10">
              <Zap className="h-5 w-5 text-green-400" />
            </div>
            <div>
              <div className="text-2xl font-bold">{cronSummary.activeJobs}</div>
              <div className="text-xs text-muted-foreground">Active cron jobs</div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-4 p-4">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-500/10">
              <Clock className="h-5 w-5 text-blue-400" />
            </div>
            <div>
              <div className="text-2xl font-bold">{cronSummary.liveCount}</div>
              <div className="text-xs text-muted-foreground">Live cron jobs</div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-4 p-4">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-500/10">
              <Webhook className="h-5 w-5 text-amber-400" />
            </div>
            <div>
              <div className="text-2xl font-bold">
                {webhooksLoading ? "—" : webhookSummary.active}
              </div>
              <div className="text-xs text-muted-foreground">Active webhooks</div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ── Create Webhook Form ─────────────────────────────────────────────── */}
      {showCreateForm && (
        <Card className="mb-6 border-amber-500/30">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <Plus className="h-4 w-4 text-amber-400" />
              Create Webhook Automation
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-[1fr,1fr,auto,auto]">
              <div>
                <label className="text-[10px] uppercase tracking-wide text-muted-foreground block mb-1">Workflow</label>
                <select
                  className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                  value={createWorkflowId}
                  onChange={(e) => setCreateWorkflowId(e.target.value)}
                >
                  {workflowOptions.length === 0 && <option value="">Loading workflows…</option>}
                  {workflowOptions.map((w) => (
                    <option key={w.id} value={w.id}>{w.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-wide text-muted-foreground block mb-1">Webhook Name</label>
                <input
                  className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                  placeholder="e.g. GitHub Issues"
                  value={createName}
                  onChange={(e) => setCreateName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void createWebhook(); }}
                />
              </div>
              <div className="flex items-end gap-2">
                <label className="flex items-center gap-2 pb-1 text-xs text-muted-foreground">
                  <input type="checkbox" checked={createActive} onChange={(e) => setCreateActive(e.target.checked)} />
                  Active
                </label>
              </div>
              <div className="flex items-end gap-2">
                <Button size="sm" onClick={() => void createWebhook()} disabled={creating}>
                  {creating ? "Creating…" : "Create"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => { setShowCreateForm(false); setCreateError(null); }}>
                  Cancel
                </Button>
              </div>
            </div>
            {createError && (
              <p className="text-xs text-destructive flex items-center gap-1">
                <AlertCircle className="h-3.5 w-3.5" /> {createError}
              </p>
            )}
            <p className="text-[11px] text-muted-foreground">
              The webhook URL and signing secret will be shown once after creation. Use a <code className="bg-muted px-1 rounded">webhook-trigger</code> node in the workflow to consume trigger data.
            </p>
          </CardContent>
        </Card>
      )}

      {/* ── Cron Schedules section ─────────────────────────────────────────── */}
      <Card className="mb-6">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Clock className="h-4 w-4" />
            Cron Schedules
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {cronLoading ? (
            <p className="p-6 text-sm text-muted-foreground">Loading automations…</p>
          ) : jobs.length === 0 ? (
            <div className="p-5 space-y-4">
              {!hideGettingStarted ? (
                <>
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-[10px] font-mono uppercase tracking-widest text-slate-400">GETTING STARTED — CRON</div>
                    <Button variant="ghost" size="sm" onClick={() => setHideGettingStarted(true)}>Hide Tips</Button>
                  </div>
                  <p className="text-sm text-slate-300 max-w-2xl">
                    Cron schedules run workflows on a time-based schedule. Add a <code className="rounded bg-muted px-1 text-xs">cron-trigger</code> node to any workflow and it will appear here automatically.
                  </p>
                  <div className="grid gap-2 sm:grid-cols-3 text-[11px]">
                    <div className="border border-slate-700/60 p-3 space-y-1">
                      <div className="font-mono uppercase tracking-wide text-slate-400">Step 1 — Add a Cron Trigger</div>
                      <div className="text-slate-400">Open a workflow in the editor, drag a <strong className="text-slate-300">cron-trigger</strong> node onto the canvas, and set the expression (e.g. <code className="text-slate-300">0 9 * * *</code> for daily at 9am).</div>
                    </div>
                    <div className="border border-slate-700/60 p-3 space-y-1">
                      <div className="font-mono uppercase tracking-wide text-slate-400">Step 2 — Resync</div>
                      <div className="text-slate-400">After saving the workflow, click <strong className="text-slate-300">Resync Cron</strong> on this page to load it into the live scheduler.</div>
                    </div>
                    <div className="border border-slate-700/60 p-3 space-y-1">
                      <div className="font-mono uppercase tracking-wide text-slate-400">Chat Shortcuts</div>
                      <div className="text-slate-400">In any channel: <strong className="text-slate-300">list schedules</strong> to see all jobs, <strong className="text-slate-300">run now &quot;Workflow Name&quot;</strong> to fire one immediately.</div>
                    </div>
                  </div>
                </>
              ) : (
                <Button variant="outline" size="sm" onClick={() => setHideGettingStarted(false)}>Show Tips</Button>
              )}
              <Button variant="outline" size="sm" asChild className="mt-1">
                <Link href="/workflows">Go to Workflows</Link>
              </Button>
            </div>
          ) : (
            <div className="divide-y">
              {Object.values(groupedByWorkflow).map((wfJobs) => {
                const first = wfJobs[0]!;
                const wfId = first.workflowId;
                const isToggling = toggling[wfId];
                const isRunning = running[wfId];
                const profile = first.profile;

                return (
                  <div key={wfId} className="px-5 py-4">
                    <div className="flex items-center justify-between gap-4 mb-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <button
                          onClick={() => void toggleCron(wfId)}
                          disabled={isToggling}
                          className="shrink-0"
                          title={first.workflowActive ? "Deactivate workflow" : "Activate workflow"}
                        >
                          {first.workflowActive ? (
                            <ToggleRight className="h-6 w-6 text-green-400" />
                          ) : (
                            <ToggleLeft className="h-6 w-6 text-muted-foreground" />
                          )}
                        </button>
                        <div className="min-w-0">
                          <Link href={`/workflows/${wfId}`} className="text-sm font-semibold hover:text-primary truncate block">
                            {first.workflowName}
                          </Link>
                          {first.workflowDescription && (
                            <p className="text-xs text-muted-foreground truncate">{first.workflowDescription}</p>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {first.lastRun && (
                          <span className="text-xs text-muted-foreground">
                            Last: {relativeTime(first.lastRun.createdAt)}
                            {first.lastRun.status === "completed" ? (
                              <CheckCircle2 className="inline ml-1 h-3 w-3 text-green-500" />
                            ) : first.lastRun.status === "failed" ? (
                              <XCircle className="inline ml-1 h-3 w-3 text-red-500" />
                            ) : null}
                          </span>
                        )}
                        <Button
                          size="sm"
                          variant="outline"
                          className="border-green-500/30 text-green-400 hover:bg-green-500/10"
                          disabled={isRunning}
                          onClick={() => void runNow(wfId)}
                        >
                          <Play className={`mr-1.5 h-3 w-3 ${isRunning ? "animate-pulse" : ""}`} />
                          {isRunning ? "Running…" : "Run Now"}
                        </Button>
                      </div>
                    </div>

                    <div className="mb-3 grid gap-2 rounded-md border bg-muted/20 p-3 text-xs md:grid-cols-[1.2fr,0.8fr,1fr,0.8fr]">
                      <label>
                        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Run Profile</span>
                        <input
                          className="mt-1 h-8 w-full rounded-md border bg-background px-2"
                          value={profile.label}
                          disabled={savingProfile[wfId]}
                          onChange={(event) => {
                            const value = event.target.value;
                            setJobs((current) => current.map((job) => job.workflowId === wfId ? { ...job, profile: { ...job.profile, label: value } } : job));
                          }}
                          onBlur={(event) => void updateProfile(wfId, { label: event.target.value })}
                        />
                      </label>
                      <label>
                        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Priority</span>
                        <select
                          className="mt-1 h-8 w-full rounded-md border bg-background px-2"
                          value={profile.priority}
                          disabled={savingProfile[wfId]}
                          onChange={(event) => void updateProfile(wfId, { priority: event.target.value })}
                        >
                          <option value="low">Low</option>
                          <option value="normal">Normal</option>
                          <option value="high">High</option>
                        </select>
                      </label>
                      <label>
                        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Overlap</span>
                        <select
                          className="mt-1 h-8 w-full rounded-md border bg-background px-2"
                          value={profile.overlapPolicy}
                          disabled={savingProfile[wfId]}
                          onChange={(event) => void updateProfile(wfId, { overlapPolicy: event.target.value })}
                        >
                          <option value="allow">Allow overlap</option>
                          <option value="skip-if-running">Skip if running</option>
                        </select>
                      </label>
                      <label>
                        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Timeout</span>
                        <input
                          type="number"
                          min={1}
                          max={1440}
                          className="mt-1 h-8 w-full rounded-md border bg-background px-2"
                          value={profile.timeoutMinutes}
                          disabled={savingProfile[wfId]}
                          onChange={(event) => {
                            const value = Math.max(1, Math.min(1440, Number(event.target.value) || 1));
                            setJobs((current) => current.map((job) => job.workflowId === wfId ? { ...job, profile: { ...job.profile, timeoutMinutes: value } } : job));
                          }}
                          onBlur={(event) => void updateProfile(wfId, { timeoutMinutes: Number(event.target.value) || 60 })}
                        />
                      </label>
                    </div>

                    <div className="mb-3 grid gap-2 rounded-md border bg-background p-3 text-xs md:grid-cols-[1fr,1.2fr,0.8fr,0.8fr,0.8fr,0.8fr,0.8fr]">
                      <label>
                        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Agent Override</span>
                        <input
                          className="mt-1 h-8 w-full rounded-md border bg-background px-2"
                          value={profile.agentId ?? ""}
                          placeholder="inherit workflow"
                          disabled={savingProfile[wfId]}
                          onChange={(event) => {
                            const value = event.target.value;
                            setJobs((current) => current.map((job) => job.workflowId === wfId ? { ...job, profile: { ...job.profile, agentId: value || null } } : job));
                          }}
                          onBlur={(event) => void updateProfile(wfId, { agentId: event.target.value.trim() || null })}
                        />
                      </label>
                      <label>
                        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Workspace Override</span>
                        <input
                          className="mt-1 h-8 w-full rounded-md border bg-background px-2"
                          value={profile.workspacePath ?? ""}
                          placeholder="inherit local workspace"
                          disabled={savingProfile[wfId]}
                          onChange={(event) => {
                            const value = event.target.value;
                            setJobs((current) => current.map((job) => job.workflowId === wfId ? { ...job, profile: { ...job.profile, workspacePath: value || null } } : job));
                          }}
                          onBlur={(event) => void updateProfile(wfId, { workspacePath: event.target.value.trim() || null })}
                        />
                      </label>
                      <label>
                        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Delivery</span>
                        <select
                          className="mt-1 h-8 w-full rounded-md border bg-background px-2"
                          value={profile.deliveryRoute}
                          disabled={savingProfile[wfId]}
                          onChange={(event) => void updateProfile(wfId, { deliveryRoute: event.target.value })}
                        >
                          <option value="none">None</option>
                          <option value="webchat">WebChat note</option>
                          <option value="board">Board task</option>
                        </select>
                      </label>
                      <label>
                        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Retry</span>
                        <select
                          className="mt-1 h-8 w-full rounded-md border bg-background px-2"
                          value={profile.retryPolicy}
                          disabled={savingProfile[wfId]}
                          onChange={(event) => void updateProfile(wfId, { retryPolicy: event.target.value })}
                        >
                          <option value="none">None</option>
                          <option value="once">Once</option>
                          <option value="twice">Twice</option>
                        </select>
                      </label>
                      <label>
                        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Skill Overrides</span>
                        <input
                          type="text"
                          className="mt-1 h-8 w-full rounded-md border bg-background px-2"
                          value={profile.skillOverrides?.join(", ") || ""}
                          placeholder="skill-id-1, skill-id-2"
                          disabled={savingProfile[wfId]}
                          onChange={(event) => {
                            const overrides = event.target.value.split(",").map((s) => s.trim()).filter(Boolean);
                            setJobs((current) => current.map((job) => job.workflowId === wfId ? { ...job, profile: { ...job.profile, skillOverrides: overrides } } : job));
                          }}
                          onBlur={(event) => void updateProfile(wfId, { skillOverrides: event.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
                        />
                      </label>
                      <label>
                        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Extension Overrides</span>
                        <input
                          type="text"
                          className="mt-1 h-8 w-full rounded-md border bg-background px-2"
                          value={profile.extensionOverrides?.join(", ") || ""}
                          placeholder="extension-id-1"
                          disabled={savingProfile[wfId]}
                          onChange={(event) => {
                            const overrides = event.target.value.split(",").map((s) => s.trim()).filter(Boolean);
                            setJobs((current) => current.map((job) => job.workflowId === wfId ? { ...job, profile: { ...job.profile, extensionOverrides: overrides } } : job));
                          }}
                          onBlur={(event) => void updateProfile(wfId, { extensionOverrides: event.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
                        />
                      </label>
                      <label className="flex items-end gap-2">
                        <input
                          type="checkbox"
                          className="mb-2 h-4 w-4"
                          checked={profile.silenceOnSuccess}
                          disabled={savingProfile[wfId]}
                          onChange={(event) => void updateProfile(wfId, { silenceOnSuccess: event.target.checked })}
                        />
                        <span className="pb-1 text-xs text-muted-foreground">Silence success</span>
                      </label>
                    </div>

                    <div className="mb-3 rounded-md border bg-muted/10 p-3 text-xs">
                      <div className="mb-2 flex flex-wrap items-center gap-2">
                        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Effective Overrides</span>
                        <Badge variant="outline">agent: {profile.agentId || "inherit"}</Badge>
                        <Badge variant="outline">workspace: {profile.workspacePath ? "custom" : "inherit"}</Badge>
                        <Badge variant="outline">delivery: {profile.deliveryRoute}</Badge>
                        <Badge variant="outline">retry: {profile.retryPolicy}</Badge>
                        {profile.skillOverrides?.length ? (
                          <Badge variant="outline" className="text-[10px] border-amber-500/40 text-amber-400">+{profile.skillOverrides.length} skills</Badge>
                        ) : null}
                        {profile.extensionOverrides?.length ? (
                          <Badge variant="outline" className="text-[10px] border-cyan-500/40 text-cyan-400">+{profile.extensionOverrides.length} extensions</Badge>
                        ) : null}
                      </div>
                      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Recent Runs</div>
                      {first.recentRuns.length > 0 ? (
                        <div className="mt-2 space-y-1">
                          {first.recentRuns.slice(0, 3).map((run) => (
                            <div key={run.id} className="flex items-center gap-2 rounded border bg-background px-2 py-1">
                              <Badge variant={run.status === "failed" ? "destructive" : run.status === "completed" ? "default" : "secondary"} className="text-[10px]">
                                {run.status}
                              </Badge>
                              <span className="font-mono text-[11px] text-muted-foreground">{run.id}</span>
                              <span className="ml-auto text-[11px] text-muted-foreground">{relativeTime(run.createdAt)}</span>
                              {run.error ? <span className="max-w-[220px] truncate text-[11px] text-destructive" title={run.error}>{run.error}</span> : null}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-[11px] text-muted-foreground">No cron run history recorded yet.</p>
                      )}
                    </div>

                    <div className="space-y-2 pl-9">
                      {wfJobs.map((job) => (
                        <div key={job.nodeId} className="flex items-center gap-3 rounded-md border bg-muted/30 px-3 py-2">
                          <div className={`h-2 w-2 rounded-full shrink-0 ${job.isLive ? "bg-green-500 animate-pulse" : "bg-muted-foreground/40"}`} />
                          <div className="flex-1 min-w-0">
                            <span className="text-xs font-medium">{job.label}</span>
                            <span className="text-xs text-muted-foreground ml-2">{cronLabel(job.expression)}</span>
                          </div>
                          <code className="text-xs text-cyan-400 bg-muted px-2 py-0.5 rounded font-mono">{job.expression}</code>
                          {job.nextRunAt ? (
                            <span className="text-[10px] text-muted-foreground">
                              Next: {new Date(job.nextRunAt).toLocaleString()}
                              {new Date(job.nextRunAt).getTime() - Date.now() < 3600000 ? (
                                <span className="ml-1 font-medium text-amber-400">({Math.round((new Date(job.nextRunAt).getTime() - Date.now()) / 60000)}m)</span>
                              ) : null}
                            </span>
                          ) : job.isLive ? (
                            <span className="text-[10px] text-muted-foreground">Running</span>
                          ) : null}
                          <Badge variant="outline" className="text-[10px] shrink-0">{job.timezone}</Badge>
                          <Badge variant={job.isLive ? "default" : "secondary"} className="text-[10px] shrink-0">
                            {job.isLive ? "live" : "inactive"}
                          </Badge>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Webhooks section ───────────────────────────────────────────────── */}
      <Card className="mb-6">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Webhook className="h-4 w-4 text-amber-400" />
            Webhooks
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {webhooksLoading ? (
            <p className="p-6 text-sm text-muted-foreground">Loading webhooks…</p>
          ) : webhookError ? (
            <div className="p-5 flex items-center gap-2 text-sm text-amber-400">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {webhookError}
            </div>
          ) : webhooks.length === 0 ? (
            <div className="p-5 space-y-3">
              <p className="text-sm text-muted-foreground">
                No webhook automations yet. Click <strong>New Webhook</strong> above to create one.
              </p>
              <p className="text-[11px] text-muted-foreground max-w-xl">
                Webhooks let external systems (GitHub, Stripe, custom integrations) trigger your workflows via a signed HTTP request. Each webhook has its own URL and HMAC-SHA256 secret.
              </p>
            </div>
          ) : (
            <div className="divide-y">
              {webhooks.map((wh) => {
                const busy = webhookActionBusy[wh.id];
                const absUrl = typeof window !== "undefined" ? `${window.location.origin}${wh.url}` : wh.url;
                const isExpanded = expandedSigning === wh.id;

                return (
                  <div key={wh.id} className="px-5 py-4 space-y-3">
                    {/* Row header */}
                    <div className="flex items-center gap-3">
                      <button
                        onClick={() => void toggleWebhook(wh.id, wh.isActive)}
                        disabled={busy}
                        className="shrink-0"
                        title={wh.isActive ? "Disable webhook" : "Enable webhook"}
                      >
                        {wh.isActive ? (
                          <ToggleRight className="h-6 w-6 text-green-400" />
                        ) : (
                          <ToggleLeft className="h-6 w-6 text-muted-foreground" />
                        )}
                      </button>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-semibold">{wh.name}</span>
                          <Badge variant={wh.isActive ? "default" : "secondary"} className="text-[10px]">
                            {wh.isActive ? "active" : "disabled"}
                          </Badge>
                          {!wh.hasWebhookTrigger && (
                            <Badge variant="outline" className="text-[10px] border-amber-500/40 text-amber-400">
                              no webhook-trigger node
                            </Badge>
                          )}
                          {!wh.workflowActive && (
                            <Badge variant="outline" className="text-[10px] border-red-500/40 text-red-400">
                              workflow inactive
                            </Badge>
                          )}
                        </div>
                        <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-2">
                          <Link href={`/workflows/${wh.workflowId}`} className="hover:text-primary flex items-center gap-1">
                            <ExternalLink className="h-3 w-3" />
                            {wh.workflowName}
                          </Link>
                          <span>·</span>
                          <span>Created {relativeTime(wh.createdAt)}</span>
                          {wh.lastExecution && (
                            <>
                              <span>·</span>
                              <span>
                                Last delivery: {relativeTime(wh.lastExecution.startedAt)}{" "}
                                {wh.lastExecution.status === "completed" ? (
                                  <CheckCircle2 className="inline h-3 w-3 text-green-500" />
                                ) : wh.lastExecution.status === "failed" ? (
                                  <XCircle className="inline h-3 w-3 text-red-500" />
                                ) : null}
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <CopyButton text={absUrl} label="Copy URL" />
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          onClick={() => setExpandedSigning(isExpanded ? null : wh.id)}
                        >
                          <KeyRound className="mr-1 h-3 w-3" />
                          {isExpanded ? "Hide" : "Sign"}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs text-amber-400 hover:text-amber-300"
                          disabled={busy}
                          onClick={() => void rotateSecret(wh)}
                          title="Rotate secret"
                        >
                          <RotateCcw className="h-3 w-3" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs text-red-400 hover:text-red-300"
                          disabled={busy}
                          onClick={() => void deleteWebhook(wh)}
                          title="Delete endpoint"
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>

                    {/* URL bar */}
                    <div className="flex items-center gap-2 rounded-md bg-muted/30 px-3 py-2">
                      <code className="flex-1 text-[11px] font-mono text-cyan-400 truncate">{absUrl}</code>
                    </div>

                    {/* Signing example */}
                    {isExpanded && (
                      <div className="space-y-2">
                        <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">Bash Signing Example</div>
                        <div className="relative">
                          <pre className="overflow-x-auto rounded bg-muted p-3 text-[11px] text-muted-foreground">{signingBashExample(absUrl)}</pre>
                          <div className="absolute right-2 top-2">
                            <CopyButton text={signingBashExample(absUrl)} label="Copy" />
                          </div>
                        </div>
                        <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">Node.js Signing Example</div>
                        <div className="relative">
                          <pre className="overflow-x-auto rounded bg-muted p-3 text-[11px] text-muted-foreground">{signingNodeExample(absUrl)}</pre>
                          <div className="absolute right-2 top-2">
                            <CopyButton text={signingNodeExample(absUrl)} label="Copy" />
                          </div>
                        </div>
                        <p className="text-[11px] text-muted-foreground">
                          Set <code className="bg-muted px-1 rounded">WEBHOOK_SECRET</code> to the value shown when you created or last rotated the webhook. The app validates HMAC-SHA256 using <code className="bg-muted px-1 rounded">timestamp.body</code> when timestamp is present. This URL is only reachable at the local app address — use a tunnel (e.g. ngrok) for external integrations.
                        </p>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Other Triggers ─────────────────────────────────────────────────── */}
      <Card className="mb-6">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2 text-muted-foreground">
            Other Triggers
            <Badge variant="outline" className="text-[10px]">informational</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-md border border-dashed border-slate-700/60 p-4 space-y-2">
              <div className="flex items-center gap-2">
                <MessageSquare className="h-4 w-4 text-blue-400" />
                <span className="text-sm font-medium">Message Triggers</span>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Start workflows when a message arrives on a connected channel (Telegram, Discord, Slack, etc). Managed via <code className="bg-muted px-1 rounded">message-trigger</code>, <code className="bg-muted px-1 rounded">telegram-trigger</code>, and <code className="bg-muted px-1 rounded">discord-trigger</code> nodes in the workflow editor.
              </p>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" asChild>
                  <Link href="/channels">Channels</Link>
                </Button>
                <Button variant="outline" size="sm" asChild>
                  <Link href="/workflows">Workflows</Link>
                </Button>
              </div>
            </div>
            <div className="rounded-md border border-dashed border-slate-700/60 p-4 space-y-2">
              <div className="flex items-center gap-2">
                <MousePointer className="h-4 w-4 text-purple-400" />
                <span className="text-sm font-medium">Manual / API Triggers</span>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Start workflows explicitly: via <code className="bg-muted px-1 rounded">manual-trigger</code> node in the editor, WebChat commands, Board task launches, or direct API execution calls. No recurring schedule — useful for testing and on-demand runs.
              </p>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" asChild>
                  <Link href="/workflows">Workflows</Link>
                </Button>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── Cron reference ─────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs text-muted-foreground">Cron Expression Quick Reference</CardTitle>
        </CardHeader>
        <CardContent className="pb-4">
          <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-xs md:grid-cols-3">
            {[
              ["* * * * *", "Every minute"],
              ["*/5 * * * *", "Every 5 minutes"],
              ["0 * * * *", "Every hour"],
              ["0 9 * * *", "Daily at 9 AM"],
              ["0 9 * * 1-5", "Weekdays at 9 AM"],
              ["0 0 * * 0", "Weekly (Sunday midnight)"],
              ["0 0 1 * *", "Monthly (1st)"],
              ["0 8,12,18 * * *", "3x daily (8, 12, 18)"],
              ["*/30 9-17 * * 1-5", "Every 30m business hours"],
            ].map(([expr, label]) => (
              <div key={expr} className="flex items-center gap-2 py-0.5">
                <code className="text-cyan-400 font-mono w-36 shrink-0">{expr}</code>
                <span className="text-muted-foreground">{label}</span>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Format: <code className="bg-muted px-1 rounded">minute hour day-of-month month day-of-week</code>.
            Chat shortcut: <code className="bg-muted px-1 rounded">schedule &quot;Daily Report&quot; to run at 0 9 * * *</code>
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
