"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { DataMapper } from "@/components/workflow/data-mapper";
import { buildFieldPickerItems } from "@/lib/engine/workflow-data-paths";
import type { ExecutionRecord, NodeResult } from "@/types/execution";
import type { WorkflowPolicy } from "@/types/execution";
import type { WorkflowEdge, WorkflowNode } from "@/types/workflow";
import {
  Braces,
  GitBranch,
  PanelRightClose,
  PanelRightOpen,
  History,
  KeyRound,
  Layers,
  ListTree,
  ShieldCheck,
  Pin,
  RefreshCcw,
  Wrench,
  type LucideIcon,
} from "lucide-react";

type PanelKey = "pinned" | "credentials" | "versions" | "trace" | "mapper" | "agent-tools" | "concurrency" | "policy";

type PinnedNodeData = {
  workflowId: string;
  nodeId: string;
  dataJson: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

type WorkflowVersion = {
  id: string;
  workflowId: string;
  version: number;
  name: string;
  description: string | null;
  createdAt: string;
};

type WorkflowCredential = {
  id: string;
  name: string;
  serviceType: string;
  secretRef: string;
  createdAt: string;
  updatedAt: string;
};

type WorkflowAgentTool = {
  id: string;
  workflowId: string;
  toolName: string;
  description: string;
  inputSchemaJson: string;
  approvalPolicy: string;
  enabled: boolean;
  createdAt: string;
};

type ExecutionTrace = {
  executionId: string;
  workflowId: string;
  workflowName: string;
  status: string;
  triggerType: string;
  startedAt: string;
  completedAt: string | null;
  error: string | null;
  nodes: Array<{ nodeId: string; output: unknown; duration: number | null; error: string | null }>;
  children: Array<{ id: string; workflowId: string; workflowName: string; status: string; startedAt: string }>;
};

type ApiResult<T> = { success?: boolean; data?: T; error?: string };

type WorkflowAdvancedPanelProps = {
  workflowId: string;
  workflowName: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  selectedNodeId: string | null;
  nodeResults?: Record<string, NodeResult>;
  currentExecution: ExecutionRecord | null;
  onWorkflowReload: () => Promise<void>;
};

const panelTabs: Array<{ key: PanelKey; label: string; icon: LucideIcon }> = [
  { key: "pinned", label: "Pinned data", icon: Pin },
  { key: "credentials", label: "Credentials", icon: KeyRound },
  { key: "versions", label: "Versions", icon: History },
  { key: "trace", label: "Trace drawer", icon: ListTree },
  { key: "mapper", label: "Data mapper", icon: Braces },
  { key: "agent-tools", label: "Agent tools", icon: Wrench },
  { key: "concurrency", label: "Concurrency", icon: Layers },
  { key: "policy", label: "Run policy", icon: ShieldCheck },
];

async function apiJson<T>(url: string, init?: RequestInit): Promise<ApiResult<T>> {
  const response = await fetch(url, init);
  const text = await response.text();
  const json = text ? (JSON.parse(text) as ApiResult<T>) : {};
  if (!response.ok || json.success === false) {
    throw new Error(json.error || response.statusText || "Request failed");
  }
  return json;
}

function formatJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "{}";
  }
}

function parseJsonDraft(draft: string): unknown {
  const trimmed = draft.trim();
  if (!trimmed) return {};
  return JSON.parse(trimmed);
}

function compactDate(value: string | null | undefined) {
  if (!value) return "never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export function WorkflowAdvancedPanel({
  workflowId,
  workflowName,
  nodes,
  edges,
  selectedNodeId,
  nodeResults,
  currentExecution,
  onWorkflowReload,
}: WorkflowAdvancedPanelProps) {
  // Collapsed by default so the canvas stays full-width (n8n-style). The thin
  // rail expands the panel on demand.
  const [collapsed, setCollapsed] = useState(true);
  const [activePanel, setActivePanel] = useState<PanelKey>("pinned");
  const [pins, setPins] = useState<PinnedNodeData[]>([]);
  const [versions, setVersions] = useState<WorkflowVersion[]>([]);
  const [credentials, setCredentials] = useState<WorkflowCredential[]>([]);
  const [agentTools, setAgentTools] = useState<WorkflowAgentTool[]>([]);
  const [executions, setExecutions] = useState<ExecutionRecord[]>([]);
  const [trace, setTrace] = useState<ExecutionTrace | null>(null);
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const [pinDraft, setPinDraft] = useState("{}");
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [credentialDraft, setCredentialDraft] = useState({ name: "", serviceType: "http", secretValue: "" });
  const [concurrencyMode, setConcurrencyMode] = useState<"skip" | "queue">("skip");
  const [concurrencyMax, setConcurrencyMax] = useState(1);
  const [queuedCount, setQueuedCount] = useState(0);
  const [policy, setPolicy] = useState<WorkflowPolicy>({
    budget: { maxRunsPerDay: null, maxCostPerDayUsd: null, autoDisable: false },
    escalation: {
      onFailure: false,
      onBudgetBlocked: false,
      maxNotificationsPerDay: null,
      quietHours: null,
    },
  });
  const [policyUsage, setPolicyUsage] = useState({ runCount: 0, costUsd: 0, notificationCount: 0 });
  const [agentToolDraft, setAgentToolDraft] = useState({
    toolName: "",
    description: "",
    inputSchemaJson: '{\n  "type": "object",\n  "properties": {}\n}',
  });

  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedNodeId) ?? null,
    [nodes, selectedNodeId],
  );
  const currentPin = useMemo(
    () => pins.find((pin) => pin.nodeId === selectedNodeId) ?? null,
    [pins, selectedNodeId],
  );
  const selectedNodeResult = selectedNodeId ? nodeResults?.[selectedNodeId] : undefined;
  const mapperItems = useMemo(
    () => (selectedNodeId ? buildFieldPickerItems(selectedNodeId, nodes, edges, nodeResults) : []),
    [selectedNodeId, nodes, edges, nodeResults],
  );

  const loadResources = useCallback(async () => {
    if (!workflowId) return;
    const [pinsJson, versionsJson, credentialsJson, toolsJson, executionsJson] = await Promise.all([
      apiJson<PinnedNodeData[]>(`/api/workflows/pin-data?workflowId=${encodeURIComponent(workflowId)}`),
      apiJson<WorkflowVersion[]>(`/api/workflows/versions?workflowId=${encodeURIComponent(workflowId)}`),
      apiJson<WorkflowCredential[]>("/api/workflows/credentials"),
      apiJson<WorkflowAgentTool[]>(`/api/workflows/agent-tools?workflowId=${encodeURIComponent(workflowId)}`),
      apiJson<ExecutionRecord[]>(`/api/execute?workflowId=${encodeURIComponent(workflowId)}`),
    ]);
    setPins(pinsJson.data ?? []);
    setVersions(versionsJson.data ?? []);
    setCredentials(credentialsJson.data ?? []);
    setAgentTools(toolsJson.data ?? []);
    setExecutions(executionsJson.data ?? []);
  }, [workflowId]);

  const loadTrace = useCallback(async (executionId: string | null) => {
    if (!executionId) {
      setTrace(null);
      return;
    }
    const json = await apiJson<ExecutionTrace>(`/api/execute?action=trace&executionId=${encodeURIComponent(executionId)}`);
    setTrace(json.data ?? null);
  }, []);

  useEffect(() => {
    void loadResources().catch((error) => setNotice(String(error)));
  }, [loadResources]);

  useEffect(() => {
    if (!workflowId) return;
    apiJson<{ concurrency: { mode: "skip" | "queue"; maxConcurrent: number }; queuedCount: number }>(
      `/api/workflows/queue?configWorkflowId=${encodeURIComponent(workflowId)}`,
    )
      .then((json) => {
        if (!json.data) return;
        setConcurrencyMode(json.data.concurrency.mode);
        setConcurrencyMax(json.data.concurrency.maxConcurrent);
        setQueuedCount(json.data.queuedCount);
      })
      .catch(() => {});
  }, [workflowId]);

  useEffect(() => {
    if (!workflowId) return;
    apiJson<{
      policy: WorkflowPolicy | null;
      usage: { runCount: number; costUsd: number; notificationCount: number };
    }>(`/api/workflows/policy?workflowId=${encodeURIComponent(workflowId)}`)
      .then((json) => {
        const next = json.data;
        if (!next) return;
        setPolicy({
          budget: {
            maxRunsPerDay: next.policy?.budget?.maxRunsPerDay ?? null,
            maxCostPerDayUsd: next.policy?.budget?.maxCostPerDayUsd ?? null,
            autoDisable: Boolean(next.policy?.budget?.autoDisable),
          },
          escalation: {
            onFailure: Boolean(next.policy?.escalation?.onFailure),
            onBudgetBlocked: Boolean(next.policy?.escalation?.onBudgetBlocked),
            maxNotificationsPerDay: next.policy?.escalation?.maxNotificationsPerDay ?? null,
            quietHours: next.policy?.escalation?.quietHours ?? null,
          },
        });
        setPolicyUsage(next.usage);
      })
      .catch(() => {});
  }, [workflowId]);

  const saveConcurrency = useCallback(async () => {
    setBusy(true);
    try {
      await apiJson("/api/workflows", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: workflowId,
          concurrency: { mode: concurrencyMode, maxConcurrent: concurrencyMax },
        }),
      });
      setNotice("Concurrency settings saved.");
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }, [workflowId, concurrencyMode, concurrencyMax]);

  const savePolicy = useCallback(async () => {
    setBusy(true);
    try {
      await apiJson("/api/workflows", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: workflowId, policy }),
      });
      setNotice("Run policy saved.");
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }, [workflowId, policy]);

  useEffect(() => {
    const nextTraceId = currentExecution?.id ?? executions[0]?.id ?? null;
    if (currentExecution?.id) {
      setSelectedTraceId(currentExecution.id);
      return;
    }
    setSelectedTraceId((existing) => existing ?? nextTraceId);
  }, [currentExecution?.id, executions]);

  useEffect(() => {
    void loadTrace(selectedTraceId).catch((error) => setNotice(String(error)));
  }, [loadTrace, selectedTraceId]);

  useEffect(() => {
    if (currentPin) {
      try {
        setPinDraft(JSON.stringify(JSON.parse(currentPin.dataJson), null, 2));
      } catch {
        setPinDraft(currentPin.dataJson || "{}");
      }
      return;
    }
    if (selectedNodeResult?.output) {
      setPinDraft(formatJson(selectedNodeResult.output));
      return;
    }
    setPinDraft("{}");
  }, [currentPin, selectedNodeResult?.output, selectedNodeId]);

  useEffect(() => {
    if (agentToolDraft.toolName || !workflowName) return;
    const safeName = workflowName.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
    setAgentToolDraft((draft) => ({ ...draft, toolName: safeName ? `run_${safeName}` : "run_workflow" }));
  }, [agentToolDraft.toolName, workflowName]);

  const withBusy = async (operation: () => Promise<void>) => {
    setBusy(true);
    setNotice(null);
    try {
      await operation();
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  };

  const savePin = () => withBusy(async () => {
    if (!selectedNodeId) throw new Error("Select a node before saving pinned data.");
    const data = parseJsonDraft(pinDraft);
    await apiJson("/api/workflows/pin-data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workflowId, nodeId: selectedNodeId, data }),
    });
    await loadResources();
    setNotice("Pinned data saved.");
  });

  const disablePin = () => withBusy(async () => {
    if (!selectedNodeId) throw new Error("Select a node first.");
    await apiJson("/api/workflows/pin-data", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workflowId, nodeId: selectedNodeId, enabled: false }),
    });
    await loadResources();
    setNotice("Pinned data disabled.");
  });

  const deletePin = () => withBusy(async () => {
    if (!selectedNodeId) throw new Error("Select a node first.");
    await apiJson(`/api/workflows/pin-data?workflowId=${encodeURIComponent(workflowId)}&nodeId=${encodeURIComponent(selectedNodeId)}`, {
      method: "DELETE",
    });
    await loadResources();
    setNotice("Pinned data deleted.");
  });

  const createCredential = () => withBusy(async () => {
    await apiJson("/api/workflows/credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "create", ...credentialDraft }),
    });
    setCredentialDraft({ name: "", serviceType: "http", secretValue: "" });
    await loadResources();
    setNotice("Credential saved.");
  });

  const testCredential = (id: string) => withBusy(async () => {
    const json = await apiJson<{ ok: boolean; status: string }>("/api/workflows/credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "test", id }),
    });
    setNotice(json.data?.status ?? "Credential tested.");
  });

  const deleteCredential = (id: string) => withBusy(async () => {
    await apiJson("/api/workflows/credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete", id }),
    });
    await loadResources();
    setNotice("Credential deleted.");
  });

  const snapshotVersion = () => withBusy(async () => {
    await apiJson("/api/workflows/versions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "snapshot",
        workflowId,
        name: `Manual snapshot - ${new Date().toISOString()}`,
        nodes,
        edges,
        metadata: { source: "workflow-editor" },
      }),
    });
    await loadResources();
    setNotice("Workflow version snapshot created.");
  });

  const restoreVersion = (versionId: string) => withBusy(async () => {
    await apiJson("/api/workflows/versions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "restore", versionId }),
    });
    await onWorkflowReload();
    await loadResources();
    setNotice("Workflow version restored.");
  });

  const createAgentTool = () => withBusy(async () => {
    JSON.parse(agentToolDraft.inputSchemaJson);
    await apiJson("/api/workflows/agent-tools", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "create",
        workflowId,
        toolName: agentToolDraft.toolName,
        description: agentToolDraft.description || `Run workflow ${workflowName}`,
        inputSchemaJson: agentToolDraft.inputSchemaJson,
        approvalPolicy: "inherit",
      }),
    });
    await loadResources();
    setNotice("Agent tool created. Enable it when ready.");
  });

  const toggleAgentTool = (tool: WorkflowAgentTool, enabled: boolean) => withBusy(async () => {
    await apiJson("/api/workflows/agent-tools", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "update", id: tool.id, enabled }),
    });
    await loadResources();
  });

  const deleteAgentTool = (id: string) => withBusy(async () => {
    await apiJson("/api/workflows/agent-tools", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete", id }),
    });
    await loadResources();
    setNotice("Agent tool deleted.");
  });

  const copyTemplate = (templatePath: string) => {
    const template = `{{${templatePath}}}`;
    if (navigator.clipboard) {
      void navigator.clipboard.writeText(template).catch(() => null);
    }
    setNotice(`Copied ${template}`);
  };

  const renderPanel = () => {
    if (activePanel === "pinned") {
      return (
        <div className="space-y-3">
          <div className="rounded-md border bg-muted/20 p-2 text-xs">
            <div className="font-semibold">Selected node</div>
            <div className="mt-1 text-muted-foreground">
              {selectedNode ? `${String(selectedNode.data?.label || selectedNode.id)} (${selectedNode.id})` : "Select a node to pin test output."}
            </div>
          </div>
          <div className="space-y-2">
            <Label>Pinned data JSON</Label>
            <Textarea
              rows={8}
              value={pinDraft}
              onChange={(event) => setPinDraft(event.target.value)}
              className="font-mono text-xs"
              placeholder='{"ok": true}'
            />
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => void savePin()} disabled={busy || !selectedNodeId}>Pin data</Button>
              <Button size="sm" variant="outline" onClick={() => void disablePin()} disabled={busy || !currentPin?.enabled}>Disable pin</Button>
              <Button size="sm" variant="outline" onClick={() => void deletePin()} disabled={busy || !currentPin}>Remove pin</Button>
            </div>
          </div>
          <Separator />
          <div className="space-y-2">
            <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Pinned nodes</div>
            {pins.length === 0 ? (
              <div className="text-xs text-muted-foreground">No pinned node data yet.</div>
            ) : pins.map((pin) => (
              <div key={pin.nodeId} className="rounded-md border p-2 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono">{pin.nodeId}</span>
                  <Badge variant={pin.enabled ? "default" : "outline"}>{pin.enabled ? "enabled" : "disabled"}</Badge>
                </div>
                <div className="mt-1 text-muted-foreground">Updated {compactDate(pin.updatedAt)}</div>
              </div>
            ))}
          </div>
        </div>
      );
    }

    if (activePanel === "credentials") {
      return (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label>Name</Label>
              <Input value={credentialDraft.name} onChange={(event) => setCredentialDraft((draft) => ({ ...draft, name: event.target.value }))} placeholder="OpenAI key" />
            </div>
            <div className="space-y-1">
              <Label>Service</Label>
              <Input value={credentialDraft.serviceType} onChange={(event) => setCredentialDraft((draft) => ({ ...draft, serviceType: event.target.value }))} placeholder="http" />
            </div>
          </div>
          <div className="space-y-1">
            <Label>Secret</Label>
            <Input type="password" value={credentialDraft.secretValue} onChange={(event) => setCredentialDraft((draft) => ({ ...draft, secretValue: event.target.value }))} placeholder="Paste secret value" />
          </div>
          <Button size="sm" onClick={() => void createCredential()} disabled={busy || !credentialDraft.name || !credentialDraft.secretValue}>Add credential</Button>
          <Separator />
          {credentials.length === 0 ? (
            <div className="text-xs text-muted-foreground">No workflow credentials saved.</div>
          ) : credentials.map((credential) => (
            <div key={credential.id} className="rounded-md border p-2 text-xs">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="font-semibold">{credential.name}</div>
                  <div className="text-muted-foreground">{credential.serviceType} - {credential.secretRef}</div>
                </div>
                <div className="flex gap-1">
                  <Button size="sm" variant="outline" onClick={() => void testCredential(credential.id)} disabled={busy}>Test</Button>
                  <Button size="sm" variant="outline" onClick={() => void deleteCredential(credential.id)} disabled={busy}>Remove</Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      );
    }

    if (activePanel === "versions") {
      return (
        <div className="space-y-3">
          <Button size="sm" onClick={() => void snapshotVersion()} disabled={busy}>Snapshot current workflow</Button>
          {versions.length === 0 ? (
            <div className="text-xs text-muted-foreground">No workflow versions yet.</div>
          ) : versions.map((version) => (
            <div key={version.id} className="rounded-md border p-2 text-xs">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="font-semibold">v{version.version} - {version.name}</div>
                  <div className="text-muted-foreground">{compactDate(version.createdAt)}</div>
                </div>
                <Button size="sm" variant="outline" onClick={() => void restoreVersion(version.id)} disabled={busy}>Restore</Button>
              </div>
            </div>
          ))}
        </div>
      );
    }

    if (activePanel === "trace") {
      return (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs text-muted-foreground">{executions.length} recent executions</div>
            <Button size="sm" variant="outline" onClick={() => void loadResources()} disabled={busy}>
              <RefreshCcw className="mr-1 h-3.5 w-3.5" />
              Refresh
            </Button>
          </div>
          <div className="max-h-28 space-y-1 overflow-auto">
            {executions.map((execution) => (
              <button
                type="button"
                key={execution.id}
                className={`block w-full rounded-md border px-2 py-1 text-left text-xs ${selectedTraceId === execution.id ? "bg-primary text-primary-foreground" : "bg-background"}`}
                onClick={() => setSelectedTraceId(execution.id)}
              >
                <span className="font-mono">{execution.id}</span> - {execution.status} - {compactDate(execution.startedAt)}
              </button>
            ))}
          </div>
          {trace ? (
            <div className="space-y-2">
              <div className="rounded-md border bg-muted/20 p-2 text-xs">
                <div className="font-semibold">{trace.workflowName}</div>
                <div className="text-muted-foreground">{trace.status} - {trace.triggerType} - {compactDate(trace.startedAt)}</div>
                {trace.error ? <div className="mt-1 text-red-600 dark:text-red-300">{trace.error}</div> : null}
              </div>
              {trace.nodes.map((node) => (
                <div key={node.nodeId} className="rounded-md border p-2 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono">{node.nodeId}</span>
                    <Badge variant={node.error ? "destructive" : "outline"}>{node.error ? "error" : `${node.duration ?? 0}ms`}</Badge>
                  </div>
                  <pre className="mt-2 max-h-28 overflow-auto rounded bg-background p-2 text-[10px] whitespace-pre-wrap break-all">
                    {node.error || formatJson(node.output)}
                  </pre>
                </div>
              ))}
              {trace.children.length > 0 ? (
                <div className="rounded-md border p-2 text-xs">
                  <div className="font-semibold">Child workflow executions</div>
                  {trace.children.map((child) => (
                    <div key={child.id} className="mt-1 text-muted-foreground">{child.workflowName} - {child.status}</div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="text-xs text-muted-foreground">Run the workflow to populate the trace drawer.</div>
          )}
        </div>
      );
    }

    if (activePanel === "concurrency") {
      return (
        <div className="space-y-3">
          <div className="rounded-md border bg-muted/20 p-2 text-xs text-muted-foreground">
            Controls what happens when this workflow is triggered while it is already running. Skip cancels the
            duplicate start; Queue holds it (FIFO) and starts it when a slot frees up.
          </div>
          <div className="space-y-2">
            <Label>When already running</Label>
            <select
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              value={concurrencyMode}
              onChange={(event) => setConcurrencyMode(event.target.value === "queue" ? "queue" : "skip")}
            >
              <option value="skip">Skip duplicate starts (default)</option>
              <option value="queue">Queue and run in order (FIFO)</option>
            </select>
          </div>
          {concurrencyMode === "queue" ? (
            <div className="space-y-2">
              <Label>Max concurrent runs</Label>
              <Input
                type="number"
                min={1}
                max={10}
                value={concurrencyMax}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  setConcurrencyMax(Number.isFinite(next) ? Math.max(1, Math.min(10, Math.floor(next))) : 1);
                }}
              />
              <div className="text-xs text-muted-foreground">
                {queuedCount > 0 ? `${queuedCount} start(s) currently queued.` : "Nothing queued right now."}
                {" "}Queued starts survive restarts and can be removed from the Executions tab.
              </div>
            </div>
          ) : null}
          <Button size="sm" disabled={busy || !workflowId} onClick={() => void saveConcurrency()}>
            Save concurrency
          </Button>
        </div>
      );
    }
    if (activePanel === "policy") {
      const budget = policy.budget ?? {};
      const escalation = policy.escalation ?? {};
      const updateBudget = (updates: NonNullable<WorkflowPolicy["budget"]>) => {
        setPolicy((current) => ({ ...current, budget: { ...(current.budget ?? {}), ...updates } }));
      };
      const updateEscalation = (updates: NonNullable<WorkflowPolicy["escalation"]>) => {
        setPolicy((current) => ({ ...current, escalation: { ...(current.escalation ?? {}), ...updates } }));
      };
      const numberValue = (value: string, integer = false) => {
        if (!value.trim()) return null;
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed <= 0) return null;
        return integer ? Math.floor(parsed) : parsed;
      };
      return (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-2 text-center text-xs">
            <div className="border p-2">
              <div className="font-semibold">{policyUsage.runCount}</div>
              <div className="text-muted-foreground">runs today</div>
            </div>
            <div className="border p-2">
              <div className="font-semibold">${policyUsage.costUsd.toFixed(4)}</div>
              <div className="text-muted-foreground">cost today</div>
            </div>
            <div className="border p-2">
              <div className="font-semibold">{policyUsage.notificationCount}</div>
              <div className="text-muted-foreground">alerts today</div>
            </div>
          </div>
          <div className="space-y-2">
            <Label>Maximum runs per day</Label>
            <Input
              type="number"
              min={1}
              placeholder="Unlimited"
              value={budget.maxRunsPerDay ?? ""}
              onChange={(event) => updateBudget({ maxRunsPerDay: numberValue(event.target.value, true) })}
            />
          </div>
          <div className="space-y-2">
            <Label>Maximum cost per day (USD)</Label>
            <Input
              type="number"
              min={0.0001}
              step={0.01}
              placeholder="Unlimited"
              value={budget.maxCostPerDayUsd ?? ""}
              onChange={(event) => updateBudget({ maxCostPerDayUsd: numberValue(event.target.value) })}
            />
          </div>
          <div className="flex items-center justify-between gap-3 border p-2">
            <div>
              <div className="text-sm font-medium">Disable on breach</div>
              <div className="text-xs text-muted-foreground">Turn off scheduled starts after a cap is reached.</div>
            </div>
            <Switch checked={Boolean(budget.autoDisable)} onCheckedChange={(checked) => updateBudget({ autoDisable: checked })} />
          </div>
          <Separator />
          <div className="text-sm font-semibold">Escalation</div>
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="policy-failure-alert">Alert on failure</Label>
            <Switch id="policy-failure-alert" checked={Boolean(escalation.onFailure)} onCheckedChange={(checked) => updateEscalation({ onFailure: checked })} />
          </div>
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="policy-budget-alert">Alert on blocked run</Label>
            <Switch id="policy-budget-alert" checked={Boolean(escalation.onBudgetBlocked)} onCheckedChange={(checked) => updateEscalation({ onBudgetBlocked: checked })} />
          </div>
          <div className="space-y-2">
            <Label>Maximum alerts per day</Label>
            <Input
              type="number"
              min={1}
              placeholder="Unlimited"
              value={escalation.maxNotificationsPerDay ?? ""}
              onChange={(event) => updateEscalation({ maxNotificationsPerDay: numberValue(event.target.value, true) })}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-2">
              <Label>Quiet hours start</Label>
              <Input
                type="time"
                value={escalation.quietHours?.start ?? ""}
                onChange={(event) => updateEscalation({
                  quietHours: event.target.value
                    ? { start: event.target.value, end: escalation.quietHours?.end || "07:00", timezone: escalation.quietHours?.timezone ?? null }
                    : null,
                })}
              />
            </div>
            <div className="space-y-2">
              <Label>Quiet hours end</Label>
              <Input
                type="time"
                value={escalation.quietHours?.end ?? ""}
                onChange={(event) => updateEscalation({
                  quietHours: event.target.value
                    ? { start: escalation.quietHours?.start || "22:00", end: event.target.value, timezone: escalation.quietHours?.timezone ?? null }
                    : null,
                })}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Quiet-hours timezone</Label>
            <Input
              placeholder="System timezone"
              value={escalation.quietHours?.timezone ?? ""}
              onChange={(event) => {
                const timezone = event.target.value;
                updateEscalation({
                  quietHours: escalation.quietHours
                    ? { ...escalation.quietHours, timezone: timezone || null }
                    : { start: "22:00", end: "07:00", timezone: timezone || null },
                });
              }}
            />
          </div>
          <Button size="sm" disabled={busy || !workflowId} onClick={() => void savePolicy()}>
            Save run policy
          </Button>
        </div>
      );
    }
    if (activePanel === "mapper") {
      return (
        <div className="space-y-3">
          <div className="rounded-md border bg-muted/20 p-2 text-xs text-muted-foreground">
            Copy template paths from upstream nodes into prompts, URLs, bodies, and code.
          </div>
          {selectedNodeId && mapperItems.length > 0 ? (
            <DataMapper
              currentNodeId={selectedNodeId}
              nodes={nodes}
              edges={edges}
              nodeResults={nodeResults}
              onInsertTemplate={copyTemplate}
              className="rounded-md bg-background"
            />
          ) : (
            <div className="text-xs text-muted-foreground">
              {selectedNodeId ? "No upstream fields are available for the selected node yet." : "Select a node to open the data mapper."}
            </div>
          )}
        </div>
      );
    }

    return (
      <div className="space-y-3">
        <div className="rounded-md border bg-muted/20 p-2 text-xs text-muted-foreground">
          Expose this workflow as a callable tool for agents. Disabled tools stay hidden from agent execution until enabled.
        </div>
        <div className="space-y-2">
          <Label>Tool name</Label>
          <Input value={agentToolDraft.toolName} onChange={(event) => setAgentToolDraft((draft) => ({ ...draft, toolName: event.target.value }))} placeholder="run_customer_lookup" />
        </div>
        <div className="space-y-2">
          <Label>Description</Label>
          <Textarea rows={2} value={agentToolDraft.description} onChange={(event) => setAgentToolDraft((draft) => ({ ...draft, description: event.target.value }))} placeholder="What this workflow does and when an agent should call it." />
        </div>
        <div className="space-y-2">
          <Label>Input schema JSON</Label>
          <Textarea rows={5} value={agentToolDraft.inputSchemaJson} onChange={(event) => setAgentToolDraft((draft) => ({ ...draft, inputSchemaJson: event.target.value }))} className="font-mono text-xs" />
        </div>
        <Button size="sm" onClick={() => void createAgentTool()} disabled={busy || !agentToolDraft.toolName}>Create agent tool</Button>
        <Separator />
        {agentTools.length === 0 ? (
          <div className="text-xs text-muted-foreground">No agent tools for this workflow yet.</div>
        ) : agentTools.map((tool) => (
          <div key={tool.id} className="rounded-md border p-2 text-xs">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="font-semibold">{tool.toolName}</div>
                <div className="text-muted-foreground">{tool.description}</div>
                <div className="mt-1 text-muted-foreground">Approval: {tool.approvalPolicy}</div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Switch checked={tool.enabled} onCheckedChange={(enabled) => void toggleAgentTool(tool, enabled)} disabled={busy} />
                <Button size="sm" variant="outline" onClick={() => void deleteAgentTool(tool.id)} disabled={busy}>Remove</Button>
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  };

  if (collapsed) {
    return (
      <aside className="flex h-full w-10 shrink-0 flex-col items-center gap-2 border-l bg-card py-2">
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          title="Open Workflow Control"
          aria-label="Open Workflow Control"
          className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <PanelRightOpen className="h-4 w-4" />
        </button>
        <span
          className="mt-1 select-none text-[10px] font-medium uppercase tracking-widest text-muted-foreground"
          style={{ writingMode: "vertical-rl" }}
        >
          Workflow Control
        </span>
        <GitBranch className="mt-auto h-4 w-4 text-muted-foreground/60" />
      </aside>
    );
  }

  return (
    <aside className="flex h-full w-[360px] shrink-0 flex-col border-l bg-card">
      <div className="border-b px-3 py-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="text-sm font-semibold">Workflow Control</div>
            <div className="text-xs text-muted-foreground">Visual debugging plus agent publishing</div>
          </div>
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            title="Collapse panel"
            aria-label="Collapse Workflow Control"
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <PanelRightClose className="h-4 w-4" />
          </button>
        </div>
        {notice ? (
          <button type="button" className="mt-2 text-left text-xs text-muted-foreground" onClick={() => setNotice(null)}>
            {notice}
          </button>
        ) : null}
      </div>
      <div className="grid grid-cols-2 gap-1 border-b p-2">
        {panelTabs.map((tab) => {
          const Icon = tab.icon;
          const active = activePanel === tab.key;
          return (
            <button
              type="button"
              key={tab.key}
              onClick={() => setActivePanel(tab.key)}
              className={`flex h-8 items-center justify-start gap-1.5 rounded-md px-2 text-xs ${
                active ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:text-foreground"
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              <span className="truncate">{tab.label}</span>
            </button>
          );
        })}
      </div>
      <ScrollArea className="flex-1">
        <div className="p-3">{renderPanel()}</div>
      </ScrollArea>
    </aside>
  );
}
