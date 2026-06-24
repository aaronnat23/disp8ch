"use client";

import { useWorkflowStore } from "@/stores/workflow-store";
import { useExecutionStore } from "@/stores/execution-store";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { X, Plus, Trash2, Wrench } from "lucide-react";
import { NodeTestCard } from "@/components/workflows/node-test-card";
import { useEffect, useState } from "react";
import { MonacoEditor } from "@/components/ui/monaco-editor";
import { getNodeContract } from "@/lib/engine/node-contracts";
import { ContractFieldEditor } from "@/components/workflow/contract-field-editor";
import { validateWorkflowNodeConfig, suggestNodeErrorRepair } from "@/lib/workflows/node-config-schema";
import { useRouter } from "next/navigation";

function MemoryAccessField({
  value,
  onChange,
  allowNone,
}: {
  value: string;
  onChange: (value: string) => void;
  allowNone: boolean;
}) {
  const description = value === "none"
    ? "Uses only this run's inputs and outputs. No durable memory is read or written."
    : value === "agent"
      ? "Uses memory shared by the selected agent across workflows. Workflow-private entries remain hidden."
      : "Uses durable memory saved by this workflow only. Other workflows and the agent-wide MEMORY.md stay hidden.";
  return (
    <div className="space-y-2 rounded-md border border-border/70 bg-muted/20 p-3" data-testid="workflow-memory-access">
      <Label>Memory visibility</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger aria-label="Memory visibility"><SelectValue /></SelectTrigger>
        <SelectContent>
          {allowNone ? <SelectItem value="none">No durable memory</SelectItem> : null}
          <SelectItem value="workflow">This workflow</SelectItem>
          <SelectItem value="agent">This agent</SelectItem>
        </SelectContent>
      </Select>
      <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>
    </div>
  );
}

export function NodeConfigPanel() {
  const router = useRouter();
  const { nodes, selectedNodeId, updateNodeConfig, setSelectedNodeId, currentWorkflow, toggleNodeDisabled } =
    useWorkflowStore();
  const lastRunOverlay = useExecutionStore((s) =>
    selectedNodeId ? s.nodeOverlays[selectedNodeId] ?? null : null,
  );

  const selectedNode = nodes.find((n) => n.id === selectedNodeId);
  const [workflows, setWorkflows] = useState<Array<{ id: string; name: string }>>([]);
  const [agents, setAgents] = useState<Array<{ id: string; name: string; isDefault: boolean; isActive: boolean }>>([]);
  const [testingNode, setTestingNode] = useState(false);
  const [testNodeResult, setTestNodeResult] = useState<{ success: boolean; output?: unknown; error?: string; durationMs?: number } | null>(null);

  useEffect(() => {
    fetch("/api/workflows")
      .then((r) => r.json())
      .then((d) => { if (d.success) setWorkflows(d.data); })
      .catch(() => {});

    fetch("/api/agents")
      .then((r) => r.json())
      .then((d) => {
        if (d.success && d.data?.agents) {
          setAgents(d.data.agents);
        }
      })
      .catch(() => {});
  }, []);

  if (!selectedNode) {
    return (
      <div className="flex h-full w-[300px] items-center justify-center border-l bg-card p-4">
        <p className="text-sm text-muted-foreground">
          Select a node to configure
        </p>
      </div>
    );
  }

  const nodeType = selectedNode.type || "";
  const config = selectedNode.data;

  // Node config validation (Gap 5): surface missing required fields + warnings
  // from the node-config spec, plus repair hints when the last run failed.
  const nodeValidation = validateWorkflowNodeConfig(selectedNode);
  const overlayStatus = (lastRunOverlay as { status?: string } | null)?.status;
  const overlayError = (lastRunOverlay as { error?: unknown } | null)?.error;
  const repairHints =
    overlayStatus === "failed"
      ? suggestNodeErrorRepair({ node: selectedNode, error: overlayError ? String(overlayError) : null }).suggestions
      : [];

  const testableNodeTypes = new Set([
    "http-request",
    "run-code",
    "read-file",
    "date-time",
    "channel-status",
    "document-tool",
    "workflow-template",
    "scheduler-job",
    "json-transform",
    "split-text",
    "regex-extract",
    "compare-text",
  ]);

  const update = (key: string, value: unknown) => {
    updateNodeConfig(selectedNode.id, { [key]: value });
  };

  const testSelectedNode = async () => {
    if (!selectedNode || !currentWorkflow?.id || !testableNodeTypes.has(nodeType)) return;
    setTestingNode(true);
    setTestNodeResult(null);
    try {
      const response = await fetch("/api/workflows/test-node", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflowId: currentWorkflow.id,
          node: selectedNode,
          triggerData: {
            source: "node-config-panel",
            message: "Test node payload",
            input: "Test node payload",
          },
        }),
      });
      const json = await response.json() as { success?: boolean; data?: { nodeResult?: { output?: unknown; duration?: number } | null }; error?: string };
      if (!response.ok || !json.success) {
        setTestNodeResult({ success: false, error: json.error || "Node test failed." });
        return;
      }
      setTestNodeResult({
        success: true,
        output: json.data?.nodeResult?.output,
        durationMs: json.data?.nodeResult?.duration,
      });
    } catch (error) {
      setTestNodeResult({ success: false, error: `Node test failed: ${String(error)}` });
    } finally {
      setTestingNode(false);
    }
  };

  return (
    <div className="flex h-full w-[300px] flex-col border-l bg-card">
      <div className="flex items-center justify-between px-3 py-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">Node Config</span>
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
              nodeValidation.valid
                ? "bg-emerald-500/15 text-emerald-400"
                : "bg-destructive/15 text-destructive"
            }`}
            title={nodeValidation.valid ? "All required config present" : `Missing: ${nodeValidation.missingFields.join(", ")}`}
          >
            {nodeValidation.valid ? "Config OK" : "Missing config"}
          </span>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={() => setSelectedNodeId(null)}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
      <Separator />
      <ScrollArea className="flex-1 p-3">
        <div className="space-y-4">
          {/* Node config validation summary (missing required fields, warnings, repair hints) */}
          {(!nodeValidation.valid || nodeValidation.warnings.length > 0 || repairHints.length > 0) && (
            <div className="space-y-2 rounded-md border border-dashed p-2.5 text-xs">
              {nodeValidation.missingFields.length > 0 && (
                <div className="text-destructive">
                  <span className="font-semibold">Missing required:</span> {nodeValidation.missingFields.join(", ")}
                </div>
              )}
              {nodeValidation.warnings.length > 0 && (
                <div className="text-amber-500">
                  <span className="font-semibold">Warnings:</span> {nodeValidation.warnings.join(" ")}
                </div>
              )}
              {repairHints.length > 0 && (
                <div className="text-muted-foreground">
                  <span className="font-semibold text-foreground">Repair hints:</span>
                  <ul className="ml-4 list-disc">
                    {repairHints.slice(0, 4).map((hint, i) => (
                      <li key={i}>{hint}</li>
                    ))}
                  </ul>
                </div>
              )}
              <Button
                variant="outline"
                size="sm"
                className="h-7 w-full text-[11px]"
                onClick={() => {
                  const issue =
                    nodeValidation.missingFields.length > 0
                      ? `Missing required: ${nodeValidation.missingFields.join(", ")}`
                      : nodeValidation.warnings.length > 0
                        ? `Warnings: ${nodeValidation.warnings.join(" ")}`
                        : repairHints.length > 0
                          ? `Repair hints: ${repairHints.join(" | ")}`
                          : "Review this node's configuration.";
                  const wfName = currentWorkflow?.name ? ` in workflow "${currentWorkflow.name}"` : "";
                  const nodeLabel = String((selectedNode.data as { label?: unknown } | undefined)?.label || nodeType);
                  const prompt = `Fix node "${nodeLabel}" (id ${selectedNode.id}, type ${nodeType})${wfName}. ${issue}. Propose the corrected config and explain it before applying.`;
                  router.push(`/chat?draft=${encodeURIComponent(prompt)}`);
                }}
              >
                <Wrench className="mr-1 h-3 w-3" />
                Ask WebChat to fix this node
              </Button>
            </div>
          )}
          {/* Common: Label + Disable toggle */}
          <div className="space-y-2">
            <Label>Label</Label>
            <Input
              value={(config.label as string) || ""}
              onChange={(e) => update("label", e.target.value)}
            />
          </div>
          {/* Disable toggle — bypasses node at runtime without removing edges. */}
          <div className="flex items-center justify-between gap-2 rounded-md border bg-muted/20 px-2.5 py-2">
            <div className="min-w-0">
              <div className="text-xs font-semibold">Node enabled</div>
              <p className="text-[11px] text-muted-foreground leading-tight">
                {(config.disabled as boolean | undefined)
                  ? "Disabled — node is skipped at runtime; input flows through unchanged."
                  : "Enabled — node runs normally. Toggle off to bypass it for debugging."}
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={!(config.disabled as boolean | undefined)}
              onClick={() => toggleNodeDisabled(selectedNode.id)}
              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors ${
                (config.disabled as boolean | undefined) ? "bg-muted" : "bg-emerald-500"
              }`}
              title={(config.disabled as boolean | undefined) ? "Enable node" : "Disable node (skip at runtime)"}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                  (config.disabled as boolean | undefined) ? "translate-x-0.5" : "translate-x-[18px]"
                }`}
              />
            </button>
          </div>

          {/* Last run output — shown after a workflow run has populated overlays. */}
          {lastRunOverlay ? (
            <div className="space-y-1 rounded-md border bg-muted/20 px-2.5 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold">Last run</span>
                <span
                  className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${
                    lastRunOverlay.status === "completed"
                      ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                      : lastRunOverlay.status === "failed"
                      ? "bg-red-500/15 text-red-700 dark:text-red-300"
                      : lastRunOverlay.status === "skipped"
                      ? "bg-slate-400/20 text-slate-600 dark:text-slate-300"
                      : "bg-sky-500/15 text-sky-700 dark:text-sky-300"
                  }`}
                >
                  {lastRunOverlay.status}
                  {Number.isFinite(lastRunOverlay.durationMs) ? ` · ${lastRunOverlay.durationMs}ms` : ""}
                </span>
              </div>
              {lastRunOverlay.error ? (
                <pre className="overflow-x-auto rounded bg-red-500/5 p-2 text-[10px] text-red-700 dark:text-red-300 whitespace-pre-wrap break-all">
                  {lastRunOverlay.error}
                </pre>
              ) : null}
              {lastRunOverlay.outputPreview ? (
                <pre className="max-h-40 overflow-auto rounded bg-background p-2 text-[10px] whitespace-pre-wrap break-all">
                  {lastRunOverlay.outputPreview}
                </pre>
              ) : null}
            </div>
          ) : null}

          {testableNodeTypes.has(nodeType) ? (
            <div className="space-y-2 rounded-md border bg-muted/20 p-2">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="text-xs font-semibold">Test this node</div>
                  <p className="text-xs text-muted-foreground">Runs this node once with a sample manual payload.</p>
                </div>
                <Button size="sm" variant="outline" onClick={() => void testSelectedNode()} disabled={testingNode || !currentWorkflow?.id}>
                  {testingNode ? "Testing..." : "Test Node"}
                </Button>
              </div>
              <NodeTestCard testing={testingNode} result={testNodeResult} />
            </div>
          ) : null}

          {/* Contract-driven field rendering */}
          {(() => {
            const contract = getNodeContract(nodeType);
            if (!contract || contract.configFields.length === 0) return null;
            // Filter out fields that have dedicated custom UI below to avoid duplication.
            // We render contract fields that are NOT already shown by node-specific sections.
            // Heuristic: skip the "label" field since it's shown in the common section above.
            const ALWAYS_SKIP = new Set(["label"]);
            // Node types that have fully hand-crafted UI — skip contract rendering for them.
            const SKIP_CONTRACT_TYPES = new Set([
              "message-trigger", "webhook-trigger", "cron-trigger", "telegram-trigger",
              "discord-trigger", "claude-agent", "integration-agent", "parallel-agents",
              "call-workflow", "spawn-coding-agent", "if-else", "switch", "delay",
              "set-variables", "filter", "memory-recall", "memory-store", "system-command",
              "http-request", "run-code", "read-file", "write-file", "board-task",
              "document-tool", "workflow-template", "scheduler-job", "google-sheets",
              "notion", "airtable", "date-time", "channel-status", "council",
              "send-whatsapp", "send-telegram", "send-discord", "send-slack",
              "send-bluebubbles", "send-teams", "send-email", "voice-stt", "voice-tts",
              "loop", "aggregate", "merge", "error-handler", "wait-for-input",
              "rate-limiter", "json-transform", "split-text", "regex-extract",
              "compare-text", "database-query", "clipboard", "notification",
              "git-operation", "archive", "sticky-note",
            ]);
            if (SKIP_CONTRACT_TYPES.has(nodeType)) return null;
            const fields = contract.configFields.filter((f) => !ALWAYS_SKIP.has(f.key));
            if (fields.length === 0) return null;
            return (
              <>
                <Separator />
                <div className="space-y-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Node Configuration
                  </div>
                  {fields.map((field) => (
                    <ContractFieldEditor
                      key={field.key}
                      field={field}
                      value={config[field.key] ?? field.defaultValue}
                      onChange={update}
                      disabled={false}
                    />
                  ))}
                </div>
              </>
            );
          })()}

          {nodeType === "sticky-note" && (
            <div className="space-y-2">
              <Label>Note</Label>
              <Textarea
                rows={8}
                value={(config.note as string) || ""}
                onChange={(e) => update("note", e.target.value)}
                placeholder="Document setup steps, assumptions, or why this branch exists."
              />
              <p className="text-xs text-muted-foreground">
                Sticky notes are canvas documentation. If connected, they pass data through unchanged.
              </p>
            </div>
          )}

          {/* Trigger: Message Trigger */}
          {nodeType === "message-trigger" && (
            <>
              <div className="space-y-2">
                <Label>Channel</Label>
                <Select
                  value={(config.channel as string) || "webchat"}
                  onValueChange={(v) => update("channel", v)}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="webchat">WebChat</SelectItem>
                    <SelectItem value="whatsapp">WhatsApp</SelectItem>
                    <SelectItem value="telegram">Telegram</SelectItem>
                    <SelectItem value="discord">Discord</SelectItem>
                    <SelectItem value="google-chat">Google Chat</SelectItem>
                    <SelectItem value="slack">Slack</SelectItem>
                    <SelectItem value="bluebubbles">BlueBubbles</SelectItem>
                    <SelectItem value="teams">Teams</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Route Keywords (optional)</Label>
                <Input
                  placeholder="e.g., task, board, todo (comma-separated)"
                  value={(config.filter as string) || ""}
                  onChange={(e) => update("filter", e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Only route messages containing one of these keywords. Leave blank to match all messages (generic fallback).
                </p>
              </div>
            </>
          )}

          {/* Trigger: Webhook */}
          {nodeType === "webhook-trigger" && (
            <>
              <div className="space-y-2">
                <Label>Path</Label>
                <Input
                  value={(config.path as string) || "/webhook"}
                  onChange={(e) => update("path", e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>Method</Label>
                <Select
                  value={(config.method as string) || "POST"}
                  onValueChange={(v) => update("method", v)}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="GET">GET</SelectItem>
                    <SelectItem value="POST">POST</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </>
          )}

          {/* Trigger: Cron */}
          {nodeType === "cron-trigger" && (
            <>
              <div className="space-y-2">
                <Label>Cron Expression</Label>
                <Input
                  value={(config.expression as string) || "0 * * * *"}
                  onChange={(e) => update("expression", e.target.value)}
                  placeholder="0 * * * * (every hour)"
                />
                <p className="text-xs text-muted-foreground">
                  Format: min hour day month weekday
                </p>
              </div>
              <div className="space-y-2">
                <Label>Timezone</Label>
                <Input
                  value={(config.timezone as string) || "UTC"}
                  onChange={(e) => update("timezone", e.target.value)}
                />
              </div>
            </>
          )}

          {/* Trigger: Telegram / Discord */}
          {(nodeType === "telegram-trigger" || nodeType === "discord-trigger") && (
            <div className="space-y-2">
              <Label>Route Keywords (optional)</Label>
              <Input
                placeholder="e.g., task, board, /start (comma-separated)"
                value={(config.filter as string) || ""}
                onChange={(e) => update("filter", e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Only route messages containing one of these keywords. Leave blank to match all messages.
              </p>
            </div>
          )}

          {/* Agent */}
          {nodeType === "claude-agent" && (
            <>
              <div className="space-y-2">
                <Label>Agent Profile</Label>
                <Select
                  value={(config.agentId as string) || "__default"}
                  onValueChange={(value) => update("agentId", value === "__default" ? "" : value)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Choose agent profile" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__default">Default Agent</SelectItem>
                    {agents
                      .filter((agent) => agent.isActive)
                      .map((agent) => (
                        <SelectItem key={agent.id} value={agent.id}>
                          {agent.name}
                          {agent.isDefault ? " (default)" : ""}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Controls workspace context, model override, and disabled skills for this node.
                </p>
              </div>
              <div className="space-y-2">
                <Label>System Prompt</Label>
                <Textarea
                  rows={6}
                  value={(config.systemPrompt as string) || ""}
                  onChange={(e) => update("systemPrompt", e.target.value)}
                  placeholder="You are a helpful AI assistant..."
                />
                <p className="text-xs text-muted-foreground">
                  Use {"{{trigger.message}}"} to reference inputs
                </p>
              </div>
              <MemoryAccessField
                value={(config.memoryAccess as string) || "agent"}
                onChange={(value) => update("memoryAccess", value)}
                allowNone
              />
              <div className="space-y-2">
                <Label>Max Tokens</Label>
                <Input
                  type="number"
                  min={1}
                  max={8192}
                  value={(config.maxTokens as number) ?? 1024}
                  onChange={(e) => update("maxTokens", parseInt(e.target.value))}
                />
              </div>

              {/* Tool use */}
              <Separator />
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Wrench className="h-3.5 w-3.5 text-muted-foreground" />
                  <Label className="text-sm font-medium">Agent Tools</Label>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Enable tools the LLM can call on its own. The workflow controls
                  structure — the agent controls intelligence.
                </p>

                {/* System tools group */}
                <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide pt-1">System</div>
                {(
                  [
                    { name: "bash_exec",    label: "Shell / Bash",  desc: "Run any command on the machine" },
                    { name: "read_file",    label: "Read File",     desc: "Read files from disk" },
                    { name: "write_file",   label: "Write File",    desc: "Create or edit files on disk" },
                    { name: "list_files",   label: "List Files",    desc: "List directory contents" },
                    { name: "find_files",   label: "Find Files",    desc: "Search files by name/extension" },
                    { name: "system_info",  label: "System Info",   desc: "CPU, RAM, disk, OS details" },
                    { name: "run_python",   label: "Run Python",    desc: "Execute Python 3 code" },
                    { name: "take_screenshot", label: "Screenshot", desc: "Capture the desktop screen" },
                  ] as const
                ).map(({ name, label, desc }) => {
                  const enabled = ((config.enabledTools as string[]) ?? []).includes(name);
                  return (
                    <label key={name} className="flex items-start gap-2.5 cursor-pointer">
                      <input type="checkbox" className="mt-0.5 h-3.5 w-3.5 accent-purple-500"
                        checked={enabled}
                        onChange={(e) => {
                          const current = (config.enabledTools as string[]) ?? [];
                          update("enabledTools", e.target.checked ? [...current, name] : current.filter((t) => t !== name));
                        }}
                      />
                      <div className="min-w-0">
                        <div className="text-xs font-medium leading-none">{label}</div>
                        <div className="text-xs text-muted-foreground mt-0.5">{desc}</div>
                      </div>
                    </label>
                  );
                })}

                {/* Network / data group */}
                <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide pt-1">Network & Data</div>
                {(
                  [
                    { name: "http_request",  label: "HTTP Request",  desc: "Call any public URL / API" },
                    { name: "web_search",    label: "Web Search",    desc: "Search the web (DuckDuckGo)" },
                    { name: "tool_docs_search", label: "Tool Docs Search", desc: "Search separate tool knowledge and usage help" },
                    { name: "memory_search", label: "Memory Search", desc: "Search the user's memory store" },
                    { name: "memory_gpt",    label: "Memory GPT",    desc: "Model-assisted memory ranking" },
                    { name: "session_recall", label: "Session Recall", desc: "Search past conversation sessions" },
                    { name: "memory_get",    label: "Memory Get",    desc: "Read memory file by path/lines" },
                    { name: "documents_list", label: "List Data Sources", desc: "List uploaded, scraped, and connected sources" },
                    { name: "documents_search", label: "Search Data Sources", desc: "Search extracted source content" },
                    { name: "document_get", label: "Get Data Source", desc: "Read one source by id or name" },
                    { name: "document_ingest", label: "Web Ingest", desc: "Scrape a website into Data Sources" },
                    { name: "backup_create", label: "Create Backup", desc: "Create a verified backup snapshot" },
                    { name: "backup_list", label: "List Backups", desc: "List recent backup snapshots" },
                    { name: "backup_verify", label: "Verify Backup", desc: "Verify backup checksums" },
                    { name: "backup_status", label: "Backup Status", desc: "Show automated backup policy status" },
                    { name: "backup_run_policy", label: "Run Backup Policy", desc: "Run scheduled backup policy now" },
                    { name: "board_tasks", label: "Board Tasks", desc: "List/create/update/delete board tasks" },
                    { name: "workflow_templates", label: "Workflow Templates", desc: "List built-in workflow templates" },
                    { name: "workflow_create", label: "Create Workflow", desc: "Create a workflow from a template" },
                    { name: "schedules_list", label: "List Schedules", desc: "Inspect live scheduled workflows" },
                    { name: "image_view",    label: "View Image",    desc: "Read image files for vision" },
                  ] as const
                ).map(({ name, label, desc }) => {
                  const enabled = ((config.enabledTools as string[]) ?? []).includes(name);
                  return (
                    <label key={name} className="flex items-start gap-2.5 cursor-pointer">
                      <input type="checkbox" className="mt-0.5 h-3.5 w-3.5 accent-purple-500"
                        checked={enabled}
                        onChange={(e) => {
                          const current = (config.enabledTools as string[]) ?? [];
                          update("enabledTools", e.target.checked ? [...current, name] : current.filter((t) => t !== name));
                        }}
                      />
                      <div className="min-w-0">
                        <div className="text-xs font-medium leading-none">{label}</div>
                        <div className="text-xs text-muted-foreground mt-0.5">{desc}</div>
                      </div>
                    </label>
                  );
                })}

                {/* Browser / workflow group */}
                <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide pt-1">Browser & Workflow</div>
                {(
                  [
                    { name: "browser_action", label: "Browser Automation", desc: "Playwright: navigate, click, scrape" },
                    { name: "send_message",   label: "Send Message",       desc: "Send to Telegram/Discord/WhatsApp/Slack" },
                    { name: "sessions_yield", label: "Session Yield",      desc: "End this turn and queue hidden follow-up context" },
                    { name: "call_workflow",  label: "Call Workflow",      desc: "Trigger another workflow" },
                  ] as const
                ).map(({ name, label, desc }) => {
                  const enabled = ((config.enabledTools as string[]) ?? []).includes(name);
                  return (
                    <label key={name} className="flex items-start gap-2.5 cursor-pointer">
                      <input type="checkbox" className="mt-0.5 h-3.5 w-3.5 accent-purple-500"
                        checked={enabled}
                        onChange={(e) => {
                          const current = (config.enabledTools as string[]) ?? [];
                          update("enabledTools", e.target.checked ? [...current, name] : current.filter((t) => t !== name));
                        }}
                      />
                      <div className="min-w-0">
                        <div className="text-xs font-medium leading-none">{label}</div>
                        <div className="text-xs text-muted-foreground mt-0.5">{desc}</div>
                      </div>
                    </label>
                  );
                })}

                {/* Schedule Task tool */}
                <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide pt-1">Scheduling</div>
                {(
                  [
                    { name: "schedule_task", label: "Schedule Task", desc: "Schedule a workflow on a cron timer" },
                  ] as const
                ).map(({ name, label, desc }) => {
                  const enabled = ((config.enabledTools as string[]) ?? []).includes(name);
                  return (
                    <label key={name} className="flex items-start gap-2.5 cursor-pointer">
                      <input type="checkbox" className="mt-0.5 h-3.5 w-3.5 accent-purple-500"
                        checked={enabled}
                        onChange={(e) => {
                          const current = (config.enabledTools as string[]) ?? [];
                          update("enabledTools", e.target.checked ? [...current, name] : current.filter((t) => t !== name));
                        }}
                      />
                      <div className="min-w-0">
                        <div className="text-xs font-medium leading-none">{label}</div>
                        <div className="text-xs text-muted-foreground mt-0.5">{desc}</div>
                      </div>
                    </label>
                  );
                })}

                {((config.enabledTools as string[]) ?? []).length > 0 && (
                  <div className="space-y-2 pt-1">
                    <Label className="text-xs">Max tool calls</Label>
                    <div className="flex items-center gap-2">
                      <Input
                        type="number"
                        min={1}
                        max={100}
                        disabled={(config.maxToolCalls as number) === 0}
                        value={(config.maxToolCalls as number) === 0 ? "" : ((config.maxToolCalls as number) ?? 25)}
                        placeholder={(config.maxToolCalls as number) === 0 ? "Unlimited" : "25"}
                        onChange={(e) => update("maxToolCalls", parseInt(e.target.value) || 25)}
                        className="w-24"
                      />
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <input
                          type="checkbox"
                          className="h-3.5 w-3.5 accent-purple-500"
                          checked={(config.maxToolCalls as number) === 0}
                          onChange={(e) => update("maxToolCalls", e.target.checked ? 0 : 25)}
                        />
                        <span className="text-xs text-muted-foreground">Unlimited</span>
                      </label>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {(config.maxToolCalls as number) === 0
                        ? "No limit — loop runs until the model stops calling tools."
                        : "Loop stops after this many tool invocations (prevents runaway agents)."
                      }
                    </p>

                    <Separator className="my-2" />
                    <div className="space-y-2">
                      <Label className="text-xs">Approval Mode</Label>
                      <Select
                        value={(config.approvalMode as string) || ((config.confirmDangerous as boolean) ? "model" : "off")}
                        onValueChange={(v) => {
                          update("approvalMode", v);
                          // Backward-compat mirror for older workflows/configs.
                          update("confirmDangerous", v === "model");
                        }}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Choose approval mode" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="off">Off (no approval prompts)</SelectItem>
                          <SelectItem value="model">Model confirmation (confirm_execution)</SelectItem>
                          <SelectItem value="human">Human approval (API queue)</SelectItem>
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">
                        Human mode queues approvals at <code>/api/tool-approvals</code>.
                      </p>
                    </div>

                    <div className="space-y-2">
                      <Label className="text-xs">Exec Security</Label>
                      <Select
                        value={(config.execSecurity as string) || "full"}
                        onValueChange={(v) => update("execSecurity", v)}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Choose exec security mode" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="full">full (allow all commands)</SelectItem>
                          <SelectItem value="allowlist">allowlist (pattern-based)</SelectItem>
                          <SelectItem value="deny">deny (block exec commands)</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-2">
                      <Label className="text-xs">Exec Ask Mode</Label>
                      <Select
                        value={(config.execAsk as string) || "on-miss"}
                        onValueChange={(v) => update("execAsk", v)}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Choose ask mode" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="off">off (no approval escalation)</SelectItem>
                          <SelectItem value="on-miss">on-miss (ask when allowlist misses)</SelectItem>
                          <SelectItem value="always">always (ask on every exec)</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-2">
                      <Label className="text-xs">Exec Allowlist (one pattern per line)</Label>
                      <Textarea
                        rows={4}
                        value={(config.execAllowlist as string) || ""}
                        onChange={(e) => update("execAllowlist", e.target.value)}
                        placeholder={`git status\ngit diff*\nnpm test`}
                      />
                      <p className="text-xs text-muted-foreground">
                        Supports exact/prefix patterns. A trailing <code>*</code> means prefix match.
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}

          {/* Agent: Generic Integration Agent */}
          {nodeType === "integration-agent" && (
            <>
              <div className="space-y-2">
                <Label>Service Name</Label>
                <Input
                  value={(config.serviceName as string) || "Custom API"}
                  onChange={(e) => update("serviceName", e.target.value)}
                  placeholder="Stripe, HubSpot, Internal API..."
                />
              </div>
              <div className="space-y-2">
                <Label>Objective</Label>
                <Textarea
                  rows={4}
                  value={(config.objective as string) || "{{trigger.message}}"}
                  onChange={(e) => update("objective", e.target.value)}
                  placeholder="Read customer records, create a ticket, then summarize the result"
                />
              </div>
              <div className="space-y-2">
                <Label>Base URL (optional context)</Label>
                <Input
                  value={(config.baseUrl as string) || ""}
                  onChange={(e) => update("baseUrl", e.target.value)}
                  placeholder="https://api.example.com/v1"
                />
              </div>
              <div className="space-y-2">
                <Label>Auth Header</Label>
                <Input
                  value={(config.authHeaderName as string) || "Authorization"}
                  onChange={(e) => update("authHeaderName", e.target.value)}
                  placeholder="Authorization"
                />
              </div>
              <div className="space-y-2">
                <Label>Auth Scheme</Label>
                <Select
                  value={(config.authScheme as string) || "Bearer"}
                  onValueChange={(v) => update("authScheme", v)}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Bearer">Bearer</SelectItem>
                    <SelectItem value="Basic">Basic</SelectItem>
                    <SelectItem value="Token">Token</SelectItem>
                    <SelectItem value="None">None</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Auth Token / Secret Ref (optional)</Label>
                <Input
                  type="password"
                  value={(config.authToken as string) || ""}
                  onChange={(e) => update("authToken", e.target.value)}
                  placeholder="secret:MY_API_KEY or raw token"
                />
              </div>
              <div className="space-y-2">
                <Label>Temperature</Label>
                <Input
                  type="number"
                  min={0}
                  max={1}
                  step={0.1}
                  value={(config.temperature as number) ?? 0.2}
                  onChange={(e) => update("temperature", parseFloat(e.target.value))}
                />
              </div>
              <div className="space-y-2">
                <Label>Max Tokens</Label>
                <Input
                  type="number"
                  min={1}
                  max={8192}
                  value={(config.maxTokens as number) ?? 1200}
                  onChange={(e) => update("maxTokens", parseInt(e.target.value))}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                This node uses the agent runtime with HTTP tool access. Use it when disp8ch doesn&apos;t have a dedicated node yet.
              </p>
            </>
          )}

          {/* Agent: Parallel Workers */}
          {nodeType === "parallel-agents" && (
            <>
              <div className="space-y-2">
                <Label>Shared Task Template</Label>
                <Textarea
                  rows={3}
                  value={(config.taskTemplate as string) || "{{trigger.message}}"}
                  onChange={(e) => update("taskTemplate", e.target.value)}
                  placeholder="{{trigger.message}}"
                />
                <p className="text-xs text-muted-foreground">
                  Used by all workers unless a worker-specific task template is set.
                </p>
              </div>
              <div className="space-y-2">
                <Label>Max Parallel Workers</Label>
                <Input
                  type="number"
                  min={1}
                  max={10}
                  value={(config.maxParallel as number) ?? 2}
                  onChange={(e) => update("maxParallel", parseInt(e.target.value, 10) || 1)}
                />
              </div>
              <Separator />
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label className="text-sm font-medium">Worker Definitions</Label>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      const current = Array.isArray(config.workers)
                        ? (config.workers as Array<Record<string, unknown>>)
                        : [];
                      update("workers", [
                        ...current,
                        {
                          roleKey: `worker${current.length + 1}`,
                          label: `Worker ${current.length + 1}`,
                          agentId: "",
                          taskTemplate: "{{trigger.message}}",
                          systemPrompt:
                            "You are a specialized worker. Complete your assigned task and return concise findings.",
                          temperature: 0.4,
                          maxTokens: 900,
                        },
                      ]);
                    }}
                  >
                    <Plus className="mr-1 h-3.5 w-3.5" />
                    Add Worker
                  </Button>
                </div>
                {(Array.isArray(config.workers) ? (config.workers as Array<Record<string, unknown>>) : []).map(
                  (worker, index) => {
                    const roleKey = String(worker.roleKey || `worker${index + 1}`);
                    const workerLabel = String(worker.label || `Worker ${index + 1}`);
                    return (
                      <div key={`${roleKey}-${index}`} className="space-y-2 rounded-md border p-2">
                        <div className="flex items-center justify-between">
                          <div className="text-xs font-semibold text-muted-foreground">{workerLabel}</div>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 text-muted-foreground"
                            onClick={() => {
                              const current = Array.isArray(config.workers)
                                ? (config.workers as Array<Record<string, unknown>>)
                                : [];
                              update(
                                "workers",
                                current.filter((_, workerIndex) => workerIndex !== index),
                              );
                            }}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">Role Key</Label>
                          <Input
                            value={roleKey}
                            onChange={(event) => {
                              const current = Array.isArray(config.workers)
                                ? [...(config.workers as Array<Record<string, unknown>>)]
                                : [];
                              current[index] = { ...current[index], roleKey: event.target.value };
                              update("workers", current);
                            }}
                          />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">Label</Label>
                          <Input
                            value={workerLabel}
                            onChange={(event) => {
                              const current = Array.isArray(config.workers)
                                ? [...(config.workers as Array<Record<string, unknown>>)]
                                : [];
                              current[index] = { ...current[index], label: event.target.value };
                              update("workers", current);
                            }}
                          />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">Agent Profile</Label>
                          <Select
                            value={String(worker.agentId || "__default")}
                            onValueChange={(value) => {
                              const current = Array.isArray(config.workers)
                                ? [...(config.workers as Array<Record<string, unknown>>)]
                                : [];
                              current[index] = {
                                ...current[index],
                                agentId: value === "__default" ? "" : value,
                              };
                              update("workers", current);
                            }}
                          >
                            <SelectTrigger>
                              <SelectValue placeholder="Choose agent profile" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__default">Default Agent</SelectItem>
                              {agents
                                .filter((agent) => agent.isActive)
                                .map((agent) => (
                                  <SelectItem key={agent.id} value={agent.id}>
                                    {agent.name}
                                    {agent.isDefault ? " (default)" : ""}
                                  </SelectItem>
                                ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">Task Template (optional)</Label>
                          <Textarea
                            rows={2}
                            value={String(worker.taskTemplate || "")}
                            onChange={(event) => {
                              const current = Array.isArray(config.workers)
                                ? [...(config.workers as Array<Record<string, unknown>>)]
                                : [];
                              current[index] = { ...current[index], taskTemplate: event.target.value };
                              update("workers", current);
                            }}
                            placeholder="Leave blank to use shared task template"
                          />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">System Prompt</Label>
                          <Textarea
                            rows={3}
                            value={String(worker.systemPrompt || "")}
                            onChange={(event) => {
                              const current = Array.isArray(config.workers)
                                ? [...(config.workers as Array<Record<string, unknown>>)]
                                : [];
                              current[index] = { ...current[index], systemPrompt: event.target.value };
                              update("workers", current);
                            }}
                          />
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <div className="space-y-1">
                            <Label className="text-xs">Max Tokens</Label>
                            <Input
                              type="number"
                              min={1}
                              max={8192}
                              value={Number(worker.maxTokens || 900)}
                              onChange={(event) => {
                                const current = Array.isArray(config.workers)
                                  ? [...(config.workers as Array<Record<string, unknown>>)]
                                  : [];
                                current[index] = {
                                  ...current[index],
                                  maxTokens: parseInt(event.target.value, 10) || 900,
                                };
                                update("workers", current);
                              }}
                            />
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs">Temperature</Label>
                            <Input
                              type="number"
                              min={0}
                              max={2}
                              step={0.1}
                              value={Number(worker.temperature || 0.4)}
                              onChange={(event) => {
                                const current = Array.isArray(config.workers)
                                  ? [...(config.workers as Array<Record<string, unknown>>)]
                                  : [];
                                current[index] = {
                                  ...current[index],
                                  temperature: parseFloat(event.target.value) || 0.4,
                                };
                                update("workers", current);
                              }}
                            />
                          </div>
                        </div>
                      </div>
                    );
                  },
                )}
              </div>
            </>
          )}

          {/* Call Workflow */}
          {nodeType === "call-workflow" && (
            <>
              <div className="space-y-2">
                <Label>Target Workflow</Label>
                <Select
                  value={(config.workflowId as string) || ""}
                  onValueChange={(v) => update("workflowId", v)}
                >
                  <SelectTrigger><SelectValue placeholder="Select workflow" /></SelectTrigger>
                  <SelectContent>
                    {workflows.map((w) => (
                      <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Input Data (JSON, optional)</Label>
                <Textarea
                  rows={3}
                  value={typeof config.inputData === "object" ? JSON.stringify(config.inputData, null, 2) : (config.inputData as string) || ""}
                  onChange={(e) => {
                    try { update("inputData", JSON.parse(e.target.value)); }
                    catch { update("inputData", e.target.value); }
                  }}
                  placeholder="{}"
                />
              </div>
            </>
          )}

          {/* Spawn Coding Agent */}
          {nodeType === "spawn-coding-agent" && (
            <>
              <div className="space-y-2">
                <Label>Agent</Label>
                <Select
                  value={(config.agent as string) || "claude"}
                  onValueChange={(v) => update("agent", v)}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="claude">Claude Code</SelectItem>
                    <SelectItem value="gemini">Gemini CLI</SelectItem>
                    <SelectItem value="codex">Codex CLI</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-2">
                  <Label>Mode</Label>
                  <Select
                    value={(config.mode as string) || "run"}
                    onValueChange={(v) => update("mode", v)}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="run">Run (one-shot)</SelectItem>
                      <SelectItem value="session">Session (persistent)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Permission Mode</Label>
                  <Select
                    value={(config.permissionMode as string) || "approve-reads"}
                    onValueChange={(v) => update("permissionMode", v)}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="approve-reads">Approve Reads (default)</SelectItem>
                      <SelectItem value="approve-all">Approve All (auto)</SelectItem>
                      <SelectItem value="deny-all">Deny All (read-only)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-2">
                <Label>Task</Label>
                <Textarea
                  rows={4}
                  value={(config.task as string) || ""}
                  onChange={(e) => update("task", e.target.value)}
                  placeholder="{'{{message.text}}'} — templates supported"
                />
              </div>
              <div className="space-y-2">
                <Label>System Prompt (role, optional)</Label>
                <Textarea
                  rows={2}
                  value={(config.systemPrompt as string) || ""}
                  onChange={(e) => update("systemPrompt", e.target.value)}
                  placeholder="You are a senior TypeScript engineer..."
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-2">
                  <Label>Max Budget (USD)</Label>
                  <Input
                    type="number"
                    min={0}
                    step={0.01}
                    value={(config.maxBudgetUsd as number) ?? 0.10}
                    onChange={(e) => update("maxBudgetUsd", Number(e.target.value))}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Timeout (ms)</Label>
                  <Input
                    type="number"
                    min={5000}
                    max={300000}
                    step={5000}
                    value={(config.timeoutMs as number) || 120000}
                    onChange={(e) => update("timeoutMs", Number(e.target.value))}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label>Model Override (Claude only, optional)</Label>
                <Input
                  value={(config.model as string) || ""}
                  onChange={(e) => update("model", e.target.value)}
                  placeholder="sonnet, opus, haiku..."
                />
              </div>
              <div className="space-y-2">
                <Label>Working Directory (optional)</Label>
                <Input
                  value={(config.cwd as string) || ""}
                  onChange={(e) => update("cwd", e.target.value)}
                  placeholder="/path/to/project"
                />
              </div>
            </>
          )}

          {/* Logic: If/Else */}
          {nodeType === "if-else" && (
            <div className="space-y-2">
              <Label>Condition</Label>
              <Textarea
                rows={3}
                value={(config.condition as string) || ""}
                onChange={(e) => update("condition", e.target.value)}
                placeholder='trigger.message contains "urgent"'
              />
              <p className="text-xs text-muted-foreground">
                Sandboxed expression. Green handle = true, Red = false.
              </p>
            </div>
          )}

          {/* Logic: Switch */}
          {nodeType === "switch" && (
            <>
              <div className="space-y-2">
                <Label>Expression</Label>
                <Input
                  value={(config.expression as string) || ""}
                  onChange={(e) => update("expression", e.target.value)}
                  placeholder="trigger.message"
                />
              </div>
              <div className="space-y-2">
                <Label>Cases</Label>
                {((config.cases as string[]) || []).map((c, i) => (
                  <div key={i} className="flex gap-1">
                    <Input
                      value={c}
                      onChange={(e) => {
                        const cases = [...((config.cases as string[]) || [])];
                        cases[i] = e.target.value;
                        update("cases", cases);
                      }}
                      placeholder={`Case ${i + 1}`}
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      onClick={() => {
                        const cases = [...((config.cases as string[]) || [])];
                        cases.splice(i, 1);
                        update("cases", cases);
                      }}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                ))}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => update("cases", [...((config.cases as string[]) || []), ""])}
                >
                  <Plus className="mr-1 h-3 w-3" />
                  Add Case
                </Button>
              </div>
            </>
          )}

          {/* Logic: Delay */}
          {nodeType === "delay" && (
            <div className="space-y-2">
              <Label>Duration (ms)</Label>
              <Input
                type="number"
                min={0}
                max={300000}
                value={(config.duration as number) ?? 1000}
                onChange={(e) => update("duration", parseInt(e.target.value))}
              />
            </div>
          )}

          {/* Logic: Set Variables */}
          {nodeType === "set-variables" && (
            <div className="space-y-2">
              <Label>Assignments</Label>
              {((config.assignments as Array<{ key: string; value: string }>) || []).map((a, i) => (
                <div key={i} className="flex gap-1 items-start">
                  <Input
                    value={a.key}
                    placeholder="key"
                    onChange={(e) => {
                      const arr = [...((config.assignments as Array<{ key: string; value: string }>) || [])];
                      arr[i] = { ...arr[i], key: e.target.value };
                      update("assignments", arr);
                    }}
                    className="w-24"
                  />
                  <Input
                    value={a.value}
                    placeholder="value (supports {{templates}})"
                    onChange={(e) => {
                      const arr = [...((config.assignments as Array<{ key: string; value: string }>) || [])];
                      arr[i] = { ...arr[i], value: e.target.value };
                      update("assignments", arr);
                    }}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0"
                    onClick={() => {
                      const arr = [...((config.assignments as Array<{ key: string; value: string }>) || [])];
                      arr.splice(i, 1);
                      update("assignments", arr);
                    }}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              ))}
              <Button
                variant="outline"
                size="sm"
                onClick={() => update("assignments", [...((config.assignments as Array<{ key: string; value: string }>) || []), { key: "", value: "" }])}
              >
                <Plus className="mr-1 h-3 w-3" />
                Add Variable
              </Button>
            </div>
          )}

          {/* Logic: Filter */}
          {nodeType === "filter" && (
            <>
              <div className="space-y-2">
                <Label>Condition</Label>
                <Textarea
                  rows={3}
                  value={(config.condition as string) || "true"}
                  onChange={(e) => update("condition", e.target.value)}
                  placeholder="trigger.message.length > 10"
                />
                <p className="text-xs text-muted-foreground">
                  If false, execution stops. Use expr-eval syntax.
                </p>
              </div>
              <div className="space-y-2">
                <Label>Stop Message (optional)</Label>
                <Input
                  value={(config.stopMessage as string) || ""}
                  onChange={(e) => update("stopMessage", e.target.value)}
                  placeholder="Filter condition not met"
                />
              </div>
            </>
          )}

          {/* Memory: Recall */}
          {nodeType === "memory-recall" && (
            <>
              <div className="space-y-2">
                <Label>Query</Label>
                <Input
                  value={(config.query as string) || "{{trigger.message}}"}
                  onChange={(e) => update("query", e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>Search Mode</Label>
                <Select
                  value={(config.mode as string) || "search"}
                  onValueChange={(v) => update("mode", v)}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="search">Standard Search</SelectItem>
                    <SelectItem value="gpt">GPT-ranked Search</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Limit</Label>
                <Input
                  type="number"
                  min={1}
                  max={50}
                  value={(config.limit as number) ?? 5}
                  onChange={(e) => update("limit", parseInt(e.target.value))}
                />
              </div>
              <MemoryAccessField
                value={(config.memoryAccess as string) || "agent"}
                onChange={(value) => update("memoryAccess", value)}
                allowNone={false}
              />
            </>
          )}

          {/* Memory: Store */}
          {nodeType === "memory-store" && (
            <>
              <div className="space-y-2">
                <Label>Extract Mode</Label>
                <Select
                  value={(config.extractMode as string) || "auto"}
                  onValueChange={(v) => update("extractMode", v)}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Auto</SelectItem>
                    <SelectItem value="manual">Manual</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {(config.extractMode as string) === "manual" && (
                <div className="space-y-2">
                  <Label>Content</Label>
                  <Textarea
                    rows={4}
                    value={(config.manualContent as string) || ""}
                    onChange={(e) => {
                      update("manualContent", e.target.value);
                      update("content", e.target.value);
                    }}
                    placeholder="Memory content to store..."
                  />
                </div>
              )}
              <MemoryAccessField
                value={(config.memoryAccess as string) || "agent"}
                onChange={(value) => update("memoryAccess", value)}
                allowNone={false}
              />
            </>
          )}

          {/* Tool: System Command */}
          {nodeType === "system-command" && (
            <>
              <div className="space-y-2">
                <Label>Action</Label>
                <Select
                  value={(config.action as string) || "pc-specs"}
                  onValueChange={(v) => update("action", v)}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="pc-specs">PC Specs</SelectItem>
                    <SelectItem value="list-files">List Files</SelectItem>
                    <SelectItem value="move-files">Move Files</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {(config.action as string) === "list-files" && (
                <>
                  <div className="space-y-2">
                    <Label>Path</Label>
                    <Input value={(config.path as string) || "."} onChange={(e) => update("path", e.target.value)} />
                  </div>
                  <div className="space-y-2">
                    <Label>Max Entries</Label>
                    <Input type="number" min={1} max={200} value={(config.maxEntries as number) ?? 20} onChange={(e) => update("maxEntries", parseInt(e.target.value))} />
                  </div>
                </>
              )}
              {(config.action as string) === "move-files" && (
                <>
                  <div className="space-y-2">
                    <Label>Source Path</Label>
                    <Input value={(config.sourcePath as string) || "."} onChange={(e) => update("sourcePath", e.target.value)} />
                  </div>
                  <div className="space-y-2">
                    <Label>Target Path</Label>
                    <Input value={(config.targetPath as string) || ""} onChange={(e) => update("targetPath", e.target.value)} />
                  </div>
                  <div className="space-y-2">
                    <Label>Allowed Root (optional safety boundary)</Label>
                    <Input value={(config.allowedRoot as string) || ""} onChange={(e) => update("allowedRoot", e.target.value)} />
                  </div>
                  <div className="space-y-2">
                    <Label>File Names (optional; defaults to upstream files)</Label>
                    <Textarea rows={2} value={(config.fileNames as string) || ""} onChange={(e) => update("fileNames", e.target.value)} placeholder="one file per line, or leave blank to use {{run.result.files}}" />
                  </div>
                </>
              )}
            </>
          )}

          {/* Tool: HTTP Request */}
          {nodeType === "http-request" && (
            <>
              <div className="space-y-2">
                <Label>URL</Label>
                <Input value={(config.url as string) || ""} onChange={(e) => update("url", e.target.value)} placeholder="https://api.example.com/data" />
              </div>
              <div className="space-y-2">
                <Label>Method</Label>
                <Select value={(config.method as string) || "GET"} onValueChange={(v) => update("method", v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => (
                      <SelectItem key={m} value={m}>{m}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Headers (JSON)</Label>
                <Textarea rows={2} value={(config.headers as string) || ""} onChange={(e) => update("headers", e.target.value)} placeholder='{"Authorization": "Bearer {{vars.token}}"}' />
              </div>
              <div className="space-y-2">
                <Label>Body</Label>
                <Textarea rows={3} value={(config.body as string) || ""} onChange={(e) => update("body", e.target.value)} placeholder='{"key": "{{trigger.message}}"}' />
              </div>
            </>
          )}

          {/* Tool: Run Code */}
          {nodeType === "run-code" && (
            <>
              <div className="space-y-2">
                <Label>JavaScript</Label>
                <div className="overflow-hidden rounded-md border border-border">
                  <MonacoEditor
                    value={(config.code as string) || "result = input;"}
                    onChange={(v) => update("code", v)}
                    language="javascript"
                    height="200px"
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Available: <code>input</code> (last node output), <code>result</code> (return value)
                </p>
              </div>
              <div className="space-y-2">
                <Label>Timeout (ms)</Label>
                <Input type="number" min={100} max={30000} value={(config.timeout as number) ?? 5000} onChange={(e) => update("timeout", parseInt(e.target.value))} />
              </div>
            </>
          )}

          {/* Tool: Read File */}
          {nodeType === "read-file" && (
            <>
              <div className="space-y-2">
                <Label>File Path</Label>
                <Input value={(config.path as string) || ""} onChange={(e) => update("path", e.target.value)} placeholder="./data/file.txt" />
              </div>
              <div className="space-y-2">
                <Label>Encoding</Label>
                <Select value={(config.encoding as string) || "utf-8"} onValueChange={(v) => update("encoding", v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="utf-8">UTF-8</SelectItem>
                    <SelectItem value="ascii">ASCII</SelectItem>
                    <SelectItem value="base64">Base64</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </>
          )}

          {/* Tool: Write File */}
          {nodeType === "write-file" && (
            <>
              <div className="space-y-2">
                <Label>File Path</Label>
                <Input value={(config.path as string) || ""} onChange={(e) => update("path", e.target.value)} placeholder="./data/output.txt" />
              </div>
              <div className="space-y-2">
                <Label>Content (optional, supports templates)</Label>
                <Textarea rows={3} value={(config.content as string) || ""} onChange={(e) => update("content", e.target.value)} placeholder="{{claude.response}}" />
              </div>
              <div className="space-y-2">
                <Label>Mode</Label>
                <Select value={(config.mode as string) || "overwrite"} onValueChange={(v) => update("mode", v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="overwrite">Overwrite</SelectItem>
                    <SelectItem value="append">Append</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </>
          )}

          {/* Tool: Board Task */}
          {nodeType === "board-task" && (
            <>
              <div className="space-y-2">
                <Label>Action</Label>
                <Select value={(config.action as string) || "list"} onValueChange={(v) => update("action", v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="list">List Tasks</SelectItem>
                    <SelectItem value="get">Get Task</SelectItem>
                    <SelectItem value="create">Create Task</SelectItem>
                    <SelectItem value="update">Update Task</SelectItem>
                    <SelectItem value="delete">Delete Task</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Board ID</Label>
                <Input value={(config.boardId as string) || "main-board"} onChange={(e) => update("boardId", e.target.value)} placeholder="main-board" />
              </div>
              <div className="space-y-2">
                <Label>Task ID (optional)</Label>
                <Input value={(config.taskId as string) || ""} onChange={(e) => update("taskId", e.target.value)} placeholder="Use for get/update/delete" />
              </div>
              <div className="space-y-2">
                <Label>Title / Query</Label>
                <Input value={(config.title as string) || ""} onChange={(e) => update("title", e.target.value)} placeholder='Task title or {{trigger.message}}' />
              </div>
              <div className="space-y-2">
                <Label>Description</Label>
                <Textarea rows={3} value={(config.description as string) || ""} onChange={(e) => update("description", e.target.value)} placeholder="{{claude.response}}" />
              </div>
              <div className="space-y-2">
                <Label>Status (optional)</Label>
                <Select value={(config.status as string) || "__none"} onValueChange={(v) => update("status", v === "__none" ? "" : v)}>
                  <SelectTrigger><SelectValue placeholder="No status filter" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">No status filter</SelectItem>
                    <SelectItem value="inbox">Inbox</SelectItem>
                    <SelectItem value="in_progress">In Progress</SelectItem>
                    <SelectItem value="review">Review</SelectItem>
                    <SelectItem value="done">Done</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Priority (optional)</Label>
                <Select value={(config.priority as string) || "__none"} onValueChange={(v) => update("priority", v === "__none" ? "" : v)}>
                  <SelectTrigger><SelectValue placeholder="No priority" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">No priority</SelectItem>
                    <SelectItem value="low">Low</SelectItem>
                    <SelectItem value="medium">Medium</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Limit</Label>
                <Input type="number" min={1} max={25} value={(config.limit as number) ?? 10} onChange={(e) => update("limit", parseInt(e.target.value))} />
              </div>
            </>
          )}

          {/* Tool: Document Tool */}
          {nodeType === "document-tool" && (
            <>
              <div className="space-y-2">
                <Label>Action</Label>
                <Select value={(config.action as string) || "list"} onValueChange={(v) => update("action", v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="list">List Data Sources</SelectItem>
                    <SelectItem value="search">Search Data Sources</SelectItem>
                    <SelectItem value="get">Get Data Source</SelectItem>
                    <SelectItem value="scrape">Scrape Website</SelectItem>
                    <SelectItem value="delete">Delete Data Source</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Query / Source Name</Label>
                <Input value={(config.query as string) || ""} onChange={(e) => update("query", e.target.value)} placeholder="functools or exact source name" />
              </div>
              <div className="space-y-2">
                <Label>Data Source ID (optional)</Label>
                <Input value={(config.documentId as string) || ""} onChange={(e) => update("documentId", e.target.value)} placeholder="source id" />
              </div>
              <div className="space-y-2">
                <Label>URL (for scrape)</Label>
                <Input value={(config.url as string) || ""} onChange={(e) => update("url", e.target.value)} placeholder="https://docs.python.org/3/" />
              </div>
              <div className="space-y-2">
                <Label>Strategy</Label>
                <Select value={(config.strategy as string) || "static"} onValueChange={(v) => update("strategy", v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Auto</SelectItem>
                    <SelectItem value="static">Static</SelectItem>
                    <SelectItem value="dynamic">Dynamic</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Max Pages</Label>
                <Input type="number" min={1} max={50} value={(config.maxPages as number) ?? 12} onChange={(e) => update("maxPages", parseInt(e.target.value))} />
              </div>
              <div className="space-y-2">
                <Label>Max Depth</Label>
                <Input type="number" min={0} max={5} value={(config.maxDepth as number) ?? 1} onChange={(e) => update("maxDepth", parseInt(e.target.value))} />
              </div>
            </>
          )}

          {/* Tool: Workflow Template */}
          {nodeType === "workflow-template" && (
            <>
              <div className="space-y-2">
                <Label>Action</Label>
                <Select value={(config.action as string) || "list-templates"} onValueChange={(v) => update("action", v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="list-templates">List Templates</SelectItem>
                    <SelectItem value="list-workflows">List Workflows</SelectItem>
                    <SelectItem value="create-from-template">Create From Template</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Template Key / Name</Label>
                <Input value={(config.template as string) || ""} onChange={(e) => update("template", e.target.value)} placeholder="research assistant" />
              </div>
              <div className="space-y-2">
                <Label>Workflow Name</Label>
                <Input value={(config.name as string) || ""} onChange={(e) => update("name", e.target.value)} placeholder="My new workflow" />
              </div>
              <div className="space-y-2">
                <Label>Description</Label>
                <Textarea rows={3} value={(config.description as string) || ""} onChange={(e) => update("description", e.target.value)} placeholder="Optional workflow description" />
              </div>
            </>
          )}

          {/* Tool: Scheduler */}
          {nodeType === "scheduler-job" && (
            <>
              <div className="space-y-2">
                <Label>Action</Label>
                <Select value={(config.action as string) || "list"} onValueChange={(v) => update("action", v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="list">List Schedules</SelectItem>
                    <SelectItem value="run">Run Workflow Now</SelectItem>
                    <SelectItem value="resync">Resync Scheduler</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Workflow ID (optional)</Label>
                <Input value={(config.workflowId as string) || ""} onChange={(e) => update("workflowId", e.target.value)} placeholder="workflow id" />
              </div>
              <div className="space-y-2">
                <Label>Workflow Name (optional)</Label>
                <Input value={(config.workflowName as string) || ""} onChange={(e) => update("workflowName", e.target.value)} placeholder="Scheduled Health Check" />
              </div>
            </>
          )}

          {/* Integration: Google Sheets */}
          {nodeType === "google-sheets" && (
            <>
              <div className="space-y-2">
                <Label>Action</Label>
                <Select value={(config.action as string) || "read"} onValueChange={(v) => update("action", v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="read">Read Range</SelectItem>
                    <SelectItem value="append">Append Rows</SelectItem>
                    <SelectItem value="update">Update Range</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Spreadsheet ID</Label>
                <Input value={(config.spreadsheetId as string) || ""} onChange={(e) => update("spreadsheetId", e.target.value)} placeholder="Google Sheet ID" />
              </div>
              <div className="space-y-2">
                <Label>Range</Label>
                <Input value={(config.range as string) || "Sheet1!A:Z"} onChange={(e) => update("range", e.target.value)} placeholder="Sheet1!A:Z" />
              </div>
              <div className="space-y-2">
                <Label>Values JSON</Label>
                <Textarea rows={4} value={(config.valuesJson as string) || "[]"} onChange={(e) => update("valuesJson", e.target.value)} placeholder='[["Name","Status"],["Acme","Active"]]' />
              </div>
            </>
          )}

          {/* Integration: Notion */}
          {nodeType === "notion" && (
            <>
              <div className="space-y-2">
                <Label>Action</Label>
                <Select value={(config.action as string) || "query-database"} onValueChange={(v) => update("action", v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="query-database">Query Database</SelectItem>
                    <SelectItem value="get-page">Get Page</SelectItem>
                    <SelectItem value="create-page">Create Page</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Notion API Key / Secret Ref</Label>
                <Input type="password" value={(config.apiKey as string) || ""} onChange={(e) => update("apiKey", e.target.value)} placeholder="secret:NOTION_API_KEY" />
              </div>
              <div className="space-y-2">
                <Label>Database ID</Label>
                <Input value={(config.databaseId as string) || ""} onChange={(e) => update("databaseId", e.target.value)} placeholder="Database ID for query/create" />
              </div>
              <div className="space-y-2">
                <Label>Page ID</Label>
                <Input value={(config.pageId as string) || ""} onChange={(e) => update("pageId", e.target.value)} placeholder="Page ID for get" />
              </div>
              <div className="space-y-2">
                <Label>Query JSON</Label>
                <Textarea rows={4} value={(config.queryJson as string) || "{}"} onChange={(e) => update("queryJson", e.target.value)} placeholder='{"page_size":10}' />
              </div>
              <div className="space-y-2">
                <Label>Properties JSON</Label>
                <Textarea rows={5} value={(config.propertiesJson as string) || "{}"} onChange={(e) => update("propertiesJson", e.target.value)} placeholder='{"Name":{"title":[{"text":{"content":"New task"}}]}}' />
              </div>
            </>
          )}

          {/* Integration: Airtable */}
          {nodeType === "airtable" && (
            <>
              <div className="space-y-2">
                <Label>Action</Label>
                <Select value={(config.action as string) || "list-records"} onValueChange={(v) => update("action", v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="list-records">List Records</SelectItem>
                    <SelectItem value="create-record">Create Record</SelectItem>
                    <SelectItem value="update-record">Update Record</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Airtable API Key / PAT</Label>
                <Input type="password" value={(config.apiKey as string) || ""} onChange={(e) => update("apiKey", e.target.value)} placeholder="secret:AIRTABLE_API_KEY" />
              </div>
              <div className="space-y-2">
                <Label>Base ID</Label>
                <Input value={(config.baseId as string) || ""} onChange={(e) => update("baseId", e.target.value)} placeholder="appXXXXXXXXXXXXXX" />
              </div>
              <div className="space-y-2">
                <Label>Table</Label>
                <Input value={(config.table as string) || ""} onChange={(e) => update("table", e.target.value)} placeholder="Tasks" />
              </div>
              <div className="space-y-2">
                <Label>Record ID (for update)</Label>
                <Input value={(config.recordId as string) || ""} onChange={(e) => update("recordId", e.target.value)} placeholder="recXXXXXXXXXXXXXX" />
              </div>
              <div className="space-y-2">
                <Label>Fields JSON</Label>
                <Textarea rows={5} value={(config.fieldsJson as string) || "{}"} onChange={(e) => update("fieldsJson", e.target.value)} placeholder='{"Name":"Acme","Status":"Active"}' />
              </div>
              <div className="space-y-2">
                <Label>Max Records</Label>
                <Input type="number" min={1} max={100} value={(config.maxRecords as number) ?? 20} onChange={(e) => update("maxRecords", parseInt(e.target.value))} />
              </div>
            </>
          )}

          {/* Tool: Date & Time */}
          {nodeType === "date-time" && (
            <>
              <div className="space-y-2">
                <Label>Operation</Label>
                <Select value={(config.operation as string) || "now"} onValueChange={(v) => update("operation", v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="now">Now</SelectItem>
                    <SelectItem value="format">Format Existing Date</SelectItem>
                    <SelectItem value="add">Shift Date</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {(config.operation as string) !== "now" && (
                <div className="space-y-2">
                  <Label>Input Date (optional)</Label>
                  <Input
                    value={(config.input as string) || ""}
                    onChange={(e) => update("input", e.target.value)}
                    placeholder="{{trigger.triggeredAt}} or 2026-03-12T10:00:00Z"
                  />
                </div>
              )}
              {(config.operation as string) === "add" && (
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-2">
                    <Label>Amount</Label>
                    <Input
                      type="number"
                      value={(config.amount as number) ?? 1}
                      onChange={(e) => update("amount", parseInt(e.target.value, 10) || 0)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Unit</Label>
                    <Select value={(config.unit as string) || "days"} onValueChange={(v) => update("unit", v)}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="minutes">Minutes</SelectItem>
                        <SelectItem value="hours">Hours</SelectItem>
                        <SelectItem value="days">Days</SelectItem>
                        <SelectItem value="weeks">Weeks</SelectItem>
                        <SelectItem value="months">Months</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )}
              <div className="space-y-2">
                <Label>Timezone</Label>
                <Input value={(config.timezone as string) || "UTC"} onChange={(e) => update("timezone", e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Locale</Label>
                <Input value={(config.locale as string) || "en-US"} onChange={(e) => update("locale", e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Output Style</Label>
                <Select value={(config.outputStyle as string) || "datetime"} onValueChange={(v) => update("outputStyle", v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="datetime">Date + Time</SelectItem>
                    <SelectItem value="date">Date Only</SelectItem>
                    <SelectItem value="time">Time Only</SelectItem>
                    <SelectItem value="iso">ISO String</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </>
          )}

          {/* Tool: Channel Status */}
          {nodeType === "channel-status" && (
            <div className="space-y-2">
              <Label>Output Format</Label>
              <Select value={(config.format as string) || "summary"} onValueChange={(v) => update("format", v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="summary">Summary</SelectItem>
                  <SelectItem value="json">JSON</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Tool: Council */}
          {nodeType === "council" && (
            <>
              <div className="space-y-2">
                <Label>Topic</Label>
                <Textarea
                  rows={3}
                  value={(config.topic as string) || "{{trigger.message}}"}
                  onChange={(e) => update("topic", e.target.value)}
                  placeholder="{{trigger.message}}"
                />
              </div>
              <div className="space-y-2">
                <Label>Decision Mode</Label>
                <Select value={(config.decisionMode as string) || "majority"} onValueChange={(v) => update("decisionMode", v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="majority">Majority</SelectItem>
                    <SelectItem value="consensus">Consensus</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Options (one per line)</Label>
                <Textarea
                  rows={4}
                  value={(config.optionsText as string) || "Approve\nRevise\nReject"}
                  onChange={(e) => update("optionsText", e.target.value)}
                  placeholder={"Approve\nRevise\nReject"}
                />
              </div>
              <div className="space-y-2">
                <Label>Agent IDs (optional, comma or newline separated)</Label>
                <Textarea
                  rows={3}
                  value={(config.agentIds as string) || ""}
                  onChange={(e) => update("agentIds", e.target.value)}
                  placeholder="Leave blank to use active agents"
                />
              </div>
            </>
          )}

          {/* Channel: Webhook Response */}
          {nodeType === "webhook-response" && (
            <>
              <div className="space-y-2">
                <Label>Status Code</Label>
                <Input
                  type="number"
                  min={100}
                  max={599}
                  value={(config.statusCode as number) ?? 200}
                  onChange={(e) => update("statusCode", parseInt(e.target.value || "200", 10))}
                />
              </div>
              <div className="space-y-2">
                <Label>Response Body</Label>
                <Textarea
                  rows={5}
                  value={(config.body as string) || "{\"success\":true}"}
                  onChange={(e) => update("body", e.target.value)}
                  placeholder='{"received": "{{body.event}}"}'
                />
              </div>
              <div className="space-y-2">
                <Label>Headers</Label>
                <Textarea
                  rows={3}
                  value={(config.headers as string) || "{}"}
                  onChange={(e) => update("headers", e.target.value)}
                  placeholder='{"x-workflow": "handled"}'
                />
              </div>
            </>
          )}

          {/* Channel: Send WhatsApp */}
          {nodeType === "send-whatsapp" && (
            <>
              <div className="space-y-2">
                <Label>To (optional)</Label>
                <Input value={(config.to as string) || ""} onChange={(e) => update("to", e.target.value)} placeholder="Defaults to sender" />
              </div>
              <div className="space-y-2">
                <Label>Message (optional, supports templates)</Label>
                <Textarea rows={3} value={(config.message as string) || ""} onChange={(e) => update("message", e.target.value)} placeholder="{{run.result.report}}" />
              </div>
            </>
          )}

          {/* Channel: Send Telegram */}
          {nodeType === "send-telegram" && (
            <>
              <div className="space-y-2">
                <Label>Chat ID (optional)</Label>
                <Input value={(config.to as string) || ""} onChange={(e) => update("to", e.target.value)} placeholder="Defaults to trigger sender" />
              </div>
              <div className="space-y-2">
                <Label>Message (optional, supports templates)</Label>
                <Textarea rows={3} value={(config.message as string) || ""} onChange={(e) => update("message", e.target.value)} placeholder="{{run.result.report}}" />
              </div>
            </>
          )}

          {/* Channel: Send Discord */}
          {nodeType === "send-discord" && (
            <>
              <div className="space-y-2">
                <Label>Channel ID</Label>
                <Input value={(config.channelId as string) || ""} onChange={(e) => update("channelId", e.target.value)} placeholder="Discord channel ID" />
              </div>
              <div className="space-y-2">
                <Label>Message (optional, supports templates)</Label>
                <Textarea rows={3} value={(config.message as string) || ""} onChange={(e) => update("message", e.target.value)} placeholder="{{run.result.report}}" />
              </div>
            </>
          )}

          {/* Channel: Send Slack */}
          {nodeType === "send-slack" && (
            <>
              <div className="space-y-2">
                <Label>Channel ID</Label>
                <Input value={(config.channelId as string) || ""} onChange={(e) => update("channelId", e.target.value)} placeholder="Slack channel ID" />
              </div>
              <div className="space-y-2">
                <Label>Message (optional, supports templates)</Label>
                <Textarea rows={3} value={(config.message as string) || ""} onChange={(e) => update("message", e.target.value)} placeholder="{{run.result.report}}" />
              </div>
              <div className="space-y-2">
                <Label>Block Kit JSON (optional)</Label>
                <Textarea
                  rows={5}
                  value={(config.blocksJson as string) || ""}
                  onChange={(e) => update("blocksJson", e.target.value)}
                  placeholder='[{"type":"section","text":{"type":"mrkdwn","text":"*Launch status*\\nPilot approved."}}]'
                />
                <p className="text-xs text-muted-foreground">
                  When provided, Slack sends this Block Kit payload and uses the message field as fallback text.
                </p>
              </div>
            </>
          )}

          {/* Channel: Send BlueBubbles */}
          {nodeType === "send-bluebubbles" && (
            <>
              <div className="space-y-2">
                <Label>Chat GUID</Label>
                <Input value={(config.chatGuid as string) || ""} onChange={(e) => update("chatGuid", e.target.value)} placeholder="BlueBubbles chat GUID" />
              </div>
              <div className="space-y-2">
                <Label>Message (optional, supports templates)</Label>
                <Textarea rows={3} value={(config.message as string) || ""} onChange={(e) => update("message", e.target.value)} placeholder="{{run.result.report}}" />
              </div>
            </>
          )}

          {/* Channel: Send Teams */}
          {nodeType === "send-teams" && (
            <>
              <div className="space-y-2">
                <Label>Conversation ID</Label>
                <Input value={(config.conversationId as string) || ""} onChange={(e) => update("conversationId", e.target.value)} placeholder="Teams conversation ID" />
              </div>
              <div className="space-y-2">
                <Label>Service URL</Label>
                <Input value={(config.serviceUrl as string) || ""} onChange={(e) => update("serviceUrl", e.target.value)} placeholder="https://smba.trafficmanager.net/..." />
              </div>
              <div className="space-y-2">
                <Label>Message (optional, supports templates)</Label>
                <Textarea rows={3} value={(config.message as string) || ""} onChange={(e) => update("message", e.target.value)} placeholder="{{run.result.report}}" />
              </div>
            </>
          )}

          {/* Channel: Send Email */}
          {nodeType === "send-email" && (
            <>
              <div className="space-y-2">
                <Label>SMTP Host</Label>
                <Input value={(config.host as string) || "smtp.gmail.com"} onChange={(e) => update("host", e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Port</Label>
                <Input type="number" value={(config.port as number) ?? 587} onChange={(e) => update("port", parseInt(e.target.value))} />
              </div>
              <div className="space-y-2">
                <Label>Username</Label>
                <Input value={(config.user as string) || ""} onChange={(e) => update("user", e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Password</Label>
                <Input type="password" value={(config.pass as string) || ""} onChange={(e) => update("pass", e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>To</Label>
                <Input value={(config.to as string) || ""} onChange={(e) => update("to", e.target.value)} placeholder="recipient@example.com" />
              </div>
              <div className="space-y-2">
                <Label>Subject</Label>
                <Input value={(config.subject as string) || ""} onChange={(e) => update("subject", e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Body (supports templates)</Label>
                <Textarea rows={3} value={(config.body as string) || ""} onChange={(e) => update("body", e.target.value)} placeholder="{{claude.response}}" />
              </div>
            </>
          )}

          {/* Voice: STT */}
          {nodeType === "voice-stt" && (
            <>
              <div className="space-y-2">
                <Label>Language (optional)</Label>
                <Input value={(config.language as string) || ""} onChange={(e) => update("language", e.target.value)} placeholder="en, es, fr... (auto-detect if blank)" />
              </div>
            </>
          )}

          {/* Voice: TTS */}
          {nodeType === "voice-tts" && (
            <>
              <div className="space-y-2">
                <Label>Voice</Label>
                <Select value={(config.voice as string) || "alloy"} onValueChange={(v) => update("voice", v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {["alloy", "echo", "fable", "onyx", "nova", "shimmer"].map((v) => (
                      <SelectItem key={v} value={v}>{v}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Speed</Label>
                <Input type="number" min={0.25} max={4} step={0.25} value={(config.speed as number) ?? 1.0} onChange={(e) => update("speed", parseFloat(e.target.value))} />
              </div>
            </>
          )}

          {/* Loop */}
          {nodeType === "loop" && (
            <div className="space-y-2">
              <Label>Source Path (optional)</Label>
              <Input
                value={(config.sourcePath as string) || ""}
                onChange={(e) => update("sourcePath", e.target.value)}
                placeholder="Auto-detects first array in input"
              />
              <p className="text-xs text-muted-foreground">
                Key name of the array to iterate (e.g., &quot;items&quot;, &quot;chunks&quot;). Leave blank to auto-detect.
              </p>
            </div>
          )}

          {/* Aggregate */}
          {nodeType === "aggregate" && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                Collects each upstream output into a single array. Place after a loop to combine results.
              </p>
            </div>
          )}

          {/* Merge */}
          {nodeType === "merge" && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                Combines outputs from multiple branches into a single path. Connect multiple incoming edges.
              </p>
            </div>
          )}

          {/* Error Handler */}
          {nodeType === "error-handler" && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                Catches errors from upstream nodes. Green handle = success path, Red handle = error path.
              </p>
            </div>
          )}

          {/* Wait for Input */}
          {nodeType === "wait-for-input" && (
            <>
              <div className="space-y-2">
                <Label>Prompt Message</Label>
                <Textarea
                  rows={3}
                  value={(config.prompt as string) || "Waiting for your input..."}
                  onChange={(e) => update("prompt", e.target.value)}
                  placeholder="What would you like to do?"
                />
              </div>
              <div className="space-y-2">
                <Label>Timeout (ms)</Label>
                <Input
                  type="number"
                  min={5000}
                  max={300000}
                  value={(config.timeout as number) ?? 60000}
                  onChange={(e) => update("timeout", parseInt(e.target.value))}
                />
              </div>
            </>
          )}

          {/* Rate Limiter */}
          {nodeType === "rate-limiter" && (
            <>
              <div className="space-y-2">
                <Label>Key</Label>
                <Input value={(config.key as string) || "default"} onChange={(e) => update("key", e.target.value)} placeholder="Unique rate limit key" />
              </div>
              <div className="space-y-2">
                <Label>Max Calls</Label>
                <Input type="number" min={1} max={1000} value={(config.maxCalls as number) ?? 10} onChange={(e) => update("maxCalls", parseInt(e.target.value))} />
              </div>
              <div className="space-y-2">
                <Label>Window (ms)</Label>
                <Input type="number" min={1000} max={3600000} value={(config.windowMs as number) ?? 60000} onChange={(e) => update("windowMs", parseInt(e.target.value))} />
              </div>
            </>
          )}

          {/* JSON Transform */}
          {nodeType === "json-transform" && (
            <>
              <div className="space-y-2">
                <Label>Transform Expression</Label>
                <Textarea
                  rows={6}
                  value={(config.expression as string) || "result = input;"}
                  onChange={(e) => update("expression", e.target.value)}
                  className="font-mono text-xs"
                  placeholder="result = input.items.map(i => i.name);"
                />
                <p className="text-xs text-muted-foreground">
                  Available: <code>input</code> (last node output), set <code>result</code> to return.
                </p>
              </div>
            </>
          )}

          {/* Split Text */}
          {nodeType === "split-text" && (
            <>
              <div className="space-y-2">
                <Label>Text (optional, supports templates)</Label>
                <Textarea
                  rows={2}
                  value={(config.text as string) || ""}
                  onChange={(e) => update("text", e.target.value)}
                  placeholder="Auto-uses response/content from upstream"
                />
              </div>
              <div className="space-y-2">
                <Label>Split Mode</Label>
                <Select value={(config.mode as string) || "separator"} onValueChange={(v) => update("mode", v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="separator">By Separator</SelectItem>
                    <SelectItem value="characters">By Character Count</SelectItem>
                    <SelectItem value="words">By Word Count</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {(config.mode as string) === "separator" || !(config.mode as string) ? (
                <div className="space-y-2">
                  <Label>Separator</Label>
                  <Input value={(config.separator as string) || "\\n"} onChange={(e) => update("separator", e.target.value)} />
                </div>
              ) : (
                <div className="space-y-2">
                  <Label>Chunk Size</Label>
                  <Input type="number" min={1} value={(config.chunkSize as number) ?? 1000} onChange={(e) => update("chunkSize", parseInt(e.target.value))} />
                </div>
              )}
            </>
          )}

          {/* Regex Extract */}
          {nodeType === "regex-extract" && (
            <>
              <div className="space-y-2">
                <Label>Text (optional)</Label>
                <Textarea rows={2} value={(config.text as string) || ""} onChange={(e) => update("text", e.target.value)} placeholder="Auto-uses response/content from upstream" />
              </div>
              <div className="space-y-2">
                <Label>Pattern (regex)</Label>
                <Input value={(config.pattern as string) || ""} onChange={(e) => update("pattern", e.target.value)} placeholder="(https?://[^\s]+)" />
              </div>
              <div className="space-y-2">
                <Label>Flags</Label>
                <Input value={(config.flags as string) || "g"} onChange={(e) => update("flags", e.target.value)} placeholder="g, gi, gm" />
              </div>
            </>
          )}

          {/* Compare Text */}
          {nodeType === "compare-text" && (
            <>
              <div className="space-y-2">
                <Label>Text A</Label>
                <Textarea rows={3} value={(config.textA as string) || ""} onChange={(e) => update("textA", e.target.value)} placeholder="First text (supports {{templates}})" />
              </div>
              <div className="space-y-2">
                <Label>Text B</Label>
                <Textarea rows={3} value={(config.textB as string) || ""} onChange={(e) => update("textB", e.target.value)} placeholder="Second text (supports {{templates}})" />
              </div>
            </>
          )}

          {/* Database Query */}
          {nodeType === "database-query" && (
            <>
              <div className="space-y-2">
                <Label>SQL Query</Label>
                <Textarea
                  rows={4}
                  value={(config.query as string) || ""}
                  onChange={(e) => update("query", e.target.value)}
                  className="font-mono text-xs"
                  placeholder="SELECT * FROM workflows LIMIT 10"
                />
              </div>
              <div className="space-y-2">
                <Label>Database Path (optional)</Label>
                <Input value={(config.dbPath as string) || ""} onChange={(e) => update("dbPath", e.target.value)} placeholder="Defaults to data/disp8ch.db" />
              </div>
            </>
          )}

          {/* Clipboard */}
          {nodeType === "clipboard" && (
            <>
              <div className="space-y-2">
                <Label>Action</Label>
                <Select value={(config.action as string) || "read"} onValueChange={(v) => update("action", v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="read">Read Clipboard</SelectItem>
                    <SelectItem value="write">Write to Clipboard</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {(config.action as string) === "write" && (
                <div className="space-y-2">
                  <Label>Content (supports templates)</Label>
                  <Textarea rows={3} value={(config.content as string) || ""} onChange={(e) => update("content", e.target.value)} placeholder="{{claude.response}}" />
                </div>
              )}
            </>
          )}

          {/* Notification */}
          {nodeType === "notification" && (
            <>
              <div className="space-y-2">
                <Label>Title</Label>
                <Input value={(config.title as string) || "disp8ch"} onChange={(e) => update("title", e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Message (supports templates)</Label>
                <Textarea rows={2} value={(config.message as string) || ""} onChange={(e) => update("message", e.target.value)} placeholder="{{claude.response}}" />
              </div>
            </>
          )}

          {/* Git Operation */}
          {nodeType === "git-operation" && (
            <>
              <div className="space-y-2">
                <Label>Action</Label>
                <Select value={(config.action as string) || "status"} onValueChange={(v) => update("action", v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="status">Status (porcelain)</SelectItem>
                    <SelectItem value="log">Log (last 20)</SelectItem>
                    <SelectItem value="diff">Diff (summary)</SelectItem>
                    <SelectItem value="diff-full">Diff (full)</SelectItem>
                    <SelectItem value="branch">Branches</SelectItem>
                    <SelectItem value="remote-url">Remote URLs</SelectItem>
                    <SelectItem value="stash">Stash List</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Repository Path</Label>
                <Input value={(config.repoPath as string) || "."} onChange={(e) => update("repoPath", e.target.value)} />
              </div>
            </>
          )}

          {/* Archive */}
          {nodeType === "archive" && (
            <>
              <div className="space-y-2">
                <Label>Action</Label>
                <Select value={(config.action as string) || "create"} onValueChange={(v) => update("action", v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="create">Create Archive</SelectItem>
                    <SelectItem value="extract">Extract Archive</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Archive Path</Label>
                <Input value={(config.archivePath as string) || ""} onChange={(e) => update("archivePath", e.target.value)} placeholder="./output.zip" />
              </div>
              <div className="space-y-2">
                <Label>Source/Destination Path</Label>
                <Input value={(config.sourcePath as string) || ""} onChange={(e) => update("sourcePath", e.target.value)} placeholder="./folder-to-zip" />
              </div>
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
