"use client";

import {
  X, CheckSquare2, Square, Trash2, ClipboardPlus, ClipboardList,
  Workflow, FileText, ImageIcon, Copy, FileAudio, FileVideo
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

type SessionTodoItem = {
  id: string;
  sessionId: string;
  content: string;
  isDone: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

type WorkbenchTab = "todo" | "context" | "objects" | "artifacts" | "trace";

type SessionEntityRef = {
  id?: string | null;
  name?: string | null;
};

type SessionObjectsSnapshot = {
  workflow?: SessionEntityRef | null;
  schedule?: SessionEntityRef | null;
  dataSource?: SessionEntityRef | null;
  task?: SessionEntityRef | null;
  agent?: SessionEntityRef | null;
  organization?: SessionEntityRef | null;
  goal?: SessionEntityRef | null;
  lastDomain?: string | null;
  lastAction?: string | null;
  pendingMutation?: { kind?: string | null; summary?: string | null; createdAt?: number | null } | null;
} | null;

type WorkspacePreviewFile = {
  name: string;
  path: string;
  sizeBytes: number;
  preview: string;
};

type SessionArtifact = {
  id: string;
  kind: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  path: string | null;
  createdAt: string;
  source: string;
  previewText?: string | null;
  status?: string | null;
  workflowId?: string | null;
  executionId?: string | null;
  previewUrl?: string | null;
  href?: string | null;
  metadata?: Record<string, string | number | boolean | null>;
};

type LiveProgressEvent = {
  id: string;
  event: string;
  nodeId?: string;
  nodeType?: string;
  label?: string;
  status?: string;
  durationMs?: number;
  error?: string;
  createdAt: string;
};

type ChannelSessionTurn = {
  clientTurnId: string;
  sessionId: string;
  status: string;
  message: string;
  response: string | null;
  error: string | null;
  metadata: Record<string, unknown> | null;
  provenance: Record<string, unknown> | null;
  streamContent: string;
  progressEvents?: Array<{ eventType: string; data: unknown; createdAt: string }>;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

type EditableAppActionPlan = {
  version: number;
  confidence: number;
  userIntent: string;
  requiresConfirmation: boolean;
  assumptions: string[];
  steps: Array<{
    id: string;
    action: string;
    label: string;
    params: Record<string, unknown>;
    dependsOn?: string[];
  }>;
};

function labelForEntityRef(ref: SessionEntityRef | null | undefined): string | null {
  if (!ref) return null;
  const name = String(ref.name || "").trim();
  const id = String(ref.id || "").trim();
  if (name && id) return `${name} (${id})`;
  return name || id || null;
}

function objectHref(label: string, ref: SessionEntityRef | null | undefined): string | null {
  if (!ref?.id) return null;
  const id = encodeURIComponent(ref.id);
  if (label === "Agent") return `/agents?agentId=${id}`;
  if (label === "Workflow" || label === "Schedule") return `/workflows/${id}`;
  if (label === "Board Task") return "/boards";
  if (label === "Organization" || label === "Goal") return "/hierarchy";
  if (label === "Data Source") return "/documents";
  return null;
}

function parseArtifactJsonPreview(text: string | null | undefined): string | null {
  if (!text) return null;
  try {
    return JSON.stringify(JSON.parse(text), null, 2).slice(0, 6000);
  } catch {
    return null;
  }
}

function parseArtifactCsvPreview(text: string | null | undefined): string[][] {
  if (!text) return [];
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 6)
    .map((line) => line.split(",").map((cell) => cell.trim()).slice(0, 6));
}

export function SessionWorkbench({
  showWorkbench,
  onClose,
  sessionTodos,
  workbenchTab,
  onTabChange,
  currentSession,
  activeAgent,
  agentModelLabel,
  sessionWorkspacePath,
  agentCapabilityLabel,
  activeChannelLabel,
  sessionFastMode,
  sessionToolMode,
  latestPendingPlan,
  workspacePreviewFiles,
  sessionObjects,
  sessionArtifacts,
  recentExecutionBadges,
  latestRoutingTrace,
  latestRoutingTraceJson,
  sessionTurns,
  liveProgressEvents,
  todoInput,
  onTodoInputChange,
  onAddTodo,
  onMutateTodos,
  promotingTodoId,
  onPromoteTodo,
  todos,
}: {
  showWorkbench: boolean;
  onClose: () => void;
  sessionTodos: SessionTodoItem[];
  workbenchTab: WorkbenchTab;
  onTabChange: (tab: WorkbenchTab) => void;
  currentSession: string | null;
  activeAgent: { id: string; name: string; workspacePath: string } | null;
  agentModelLabel: string;
  sessionWorkspacePath: string | null;
  agentCapabilityLabel: string;
  activeChannelLabel: string;
  sessionFastMode: boolean | null;
  sessionToolMode: string;
  latestPendingPlan: EditableAppActionPlan | null;
  workspacePreviewFiles: WorkspacePreviewFile[];
  sessionObjects: SessionObjectsSnapshot;
  sessionArtifacts: SessionArtifact[];
  recentExecutionBadges: string[];
  latestRoutingTrace: Record<string, unknown> | null;
  latestRoutingTraceJson: string;
  sessionTurns: ChannelSessionTurn[];
  liveProgressEvents: LiveProgressEvent[];
  todoInput: string;
  onTodoInputChange: (value: string) => void;
  onAddTodo: () => void;
  onMutateTodos: (payload: Record<string, unknown>) => void;
  promotingTodoId: string | null;
  onPromoteTodo: (item: SessionTodoItem) => void;
  todos: SessionTodoItem[];
}) {
  if (!showWorkbench) return null;

  return (
    <aside className="shrink-0 flex-col border-l bg-card xl:flex xl:w-[320px] flex">
      <div className="border-b px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="text-sm font-semibold">Session Workbench</div>
            <p className="text-xs text-muted-foreground">
              Chat-local tasks, context, and route state.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline">{sessionTodos.filter((item) => !item.isDone).length} open</Badge>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={onClose}
              title="Close workbench"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-5 gap-1 rounded-md border bg-background p-1">
          {([
            ["todo", "Todo"],
            ["context", "Context"],
            ["objects", "Objects"],
            ["artifacts", "Files"],
            ["trace", "Trace"],
          ] as const).map(([tab, label]) => (
            <Button
              key={tab}
              type="button"
              variant={workbenchTab === tab ? "default" : "ghost"}
              size="sm"
              className="h-7 px-1.5 text-xs"
              onClick={() => onTabChange(tab)}
            >
              {label}
            </Button>
          ))}
        </div>
      </div>
      <div className="flex-1 overflow-auto p-4">
        {workbenchTab === "todo" ? (
        <div className="space-y-2">
          {sessionTodos.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No session todo items yet. Agents can use the <code>session_todo</code> tool here.
            </p>
          ) : (
            sessionTodos.map((item) => (
              <div key={item.id} className="rounded-md border px-3 py-2">
                <div className="flex items-start gap-2">
                  <button
                    className="mt-0.5 text-muted-foreground hover:text-foreground"
                    onClick={() => void onMutateTodos({ todoAction: "update", todoId: item.id, isDone: !item.isDone })}
                    title={item.isDone ? "Mark open" : "Mark done"}
                  >
                    {item.isDone ? <CheckSquare2 className="h-4 w-4 text-emerald-600" /> : <Square className="h-4 w-4" />}
                  </button>
                  <div className="min-w-0 flex-1">
                    <p className={`text-sm ${item.isDone ? "text-muted-foreground line-through" : ""}`}>
                      {item.content}
                    </p>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {new Date(item.updatedAt).toLocaleString()}
                    </p>
                  </div>
                  <button
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => void onMutateTodos({ todoAction: "remove", todoId: item.id })}
                    title="Remove todo"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                  <button
                    className="text-muted-foreground hover:text-foreground disabled:opacity-50"
                    onClick={() => void onPromoteTodo(item)}
                    title="Send to Boards"
                    disabled={promotingTodoId === item.id}
                  >
                    <ClipboardPlus className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
        ) : null}

        {workbenchTab === "context" ? (
          <div className="space-y-3">
            {[
              ["Session", currentSession || "new chat"],
              ["Agent", activeAgent?.name || "default"],
              ["Model", agentModelLabel],
              ["Workspace", sessionWorkspacePath || activeAgent?.workspacePath || "default workspace"],
              ["Tools", agentCapabilityLabel],
              ["Channel", activeChannelLabel],
              ["Mode", sessionFastMode === null ? "auto" : sessionFastMode ? "fast" : "standard"],
              ["Tool Mode", sessionToolMode],
            ].map(([label, value]) => (
              <div key={label} className="rounded-md border bg-background px-3 py-2">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
                <div className="mt-1 break-words text-xs font-medium text-foreground">{value}</div>
              </div>
            ))}
            {latestPendingPlan ? (
              <div className="rounded-md border bg-background px-3 py-2">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Pending Plan</div>
                <div className="mt-1 text-xs font-medium text-foreground">{latestPendingPlan.steps.length} steps</div>
                <ol className="mt-2 space-y-1 text-xs text-muted-foreground">
                  {latestPendingPlan.steps.slice(0, 5).map((step, index) => (
                    <li key={`${step.id}-${index}`} className="break-words">
                      {index + 1}. {step.label}
                    </li>
                  ))}
                </ol>
              </div>
            ) : null}
            <div className="rounded-md border bg-background px-3 py-2">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Workspace Context Preview</div>
              {workspacePreviewFiles.length === 0 ? (
                <p className="mt-1 text-xs text-muted-foreground">No small Markdown/text/JSON context files found at the selected trusted workspace root.</p>
              ) : (
                <div className="mt-2 space-y-2">
                  {workspacePreviewFiles.slice(0, 5).map((file) => (
                    <div key={file.path} className="rounded border bg-muted/20 px-2 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-xs font-medium">{file.name}</span>
                        <span className="shrink-0 text-[10px] text-muted-foreground">{file.sizeBytes.toLocaleString()} bytes</span>
                      </div>
                      {file.preview ? (
                        <pre className="mt-1 max-h-20 overflow-auto whitespace-pre-wrap text-[11px] text-muted-foreground">
                          {file.preview}
                        </pre>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : null}

        {workbenchTab === "objects" ? (
          <div className="space-y-3">
            {sessionObjects ? (
              <>
                {([
                  ["Agent", sessionObjects.agent],
                  ["Organization", sessionObjects.organization],
                  ["Goal", sessionObjects.goal],
                  ["Workflow", sessionObjects.workflow],
                  ["Schedule", sessionObjects.schedule],
                  ["Board Task", sessionObjects.task],
                  ["Data Source", sessionObjects.dataSource],
                ] as const).map(([label, ref]) => {
                  const value = labelForEntityRef(ref);
                  const href = objectHref(label, ref);
                  return (
                    <div key={label} className="rounded-md border bg-background px-3 py-2">
                      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
                      <div className="mt-1 break-words text-xs font-medium text-foreground">{value || "none recorded"}</div>
                      {ref?.id ? (
                        <div className="mt-1 break-all font-mono text-[10px] text-muted-foreground">{ref.id}</div>
                      ) : null}
                      {href ? (
                        <a className="mt-2 inline-flex text-[11px] font-medium text-primary hover:underline" href={href}>
                          Open
                        </a>
                      ) : null}
                    </div>
                  );
                })}
                <div className="rounded-md border bg-background px-3 py-2">
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Latest Action</div>
                  <div className="mt-1 text-xs font-medium text-foreground">
                    {sessionObjects.lastDomain || "none"} {sessionObjects.lastAction ? `/ ${sessionObjects.lastAction}` : ""}
                  </div>
                </div>
                {sessionObjects.pendingMutation ? (
                  <div className="rounded-md border bg-background px-3 py-2">
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Pending Mutation</div>
                    <div className="mt-1 text-xs font-medium text-foreground">{sessionObjects.pendingMutation.kind || "pending"}</div>
                    {sessionObjects.pendingMutation.summary ? (
                      <p className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">
                        {sessionObjects.pendingMutation.summary}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </>
            ) : (
              <p className="text-sm text-muted-foreground">No created objects or session app state recorded yet.</p>
            )}
          </div>
        ) : null}

        {workbenchTab === "artifacts" ? (
          <div className="space-y-3">
            {sessionArtifacts.length === 0 ? (
              <p className="text-sm text-muted-foreground">No local files attached to this session yet.</p>
            ) : (
              sessionArtifacts.map((artifact) => {
                const isImage = artifact.kind === "image" || artifact.mimeType.startsWith("image/");
                const isPdf = artifact.mimeType === "application/pdf";
                const isAudio = artifact.mimeType.startsWith("audio/");
                const isVideo = artifact.mimeType.startsWith("video/");
                const previewUrl = artifact.previewUrl || (artifact.source === "chat-upload" && isImage ? `/api/uploads?id=${encodeURIComponent(artifact.id)}` : null);
                const jsonPreview = artifact.mimeType === "application/json" ? parseArtifactJsonPreview(artifact.previewText) : null;
                const csvPreview = artifact.mimeType === "text/csv" ? parseArtifactCsvPreview(artifact.previewText) : [];
                const metadataRows: Array<[string, string]> = [];
                if (artifact.metadata?.extension) metadataRows.push(["ext", String(artifact.metadata.extension)]);
                if (artifact.metadata?.pageCount) metadataRows.push(["pages", String(artifact.metadata.pageCount)]);
                if (artifact.metadata?.title) metadataRows.push(["title", String(artifact.metadata.title)]);
                if (artifact.metadata?.author) metadataRows.push(["author", String(artifact.metadata.author)]);
                if (artifact.metadata?.duration) metadataRows.push(["duration", String(artifact.metadata.duration)]);
                if (artifact.metadata?.codec) metadataRows.push(["codec", String(artifact.metadata.codec)]);
                if (artifact.metadata?.width && artifact.metadata?.height) metadataRows.push(["dimensions", `${artifact.metadata.width}x${artifact.metadata.height}`]);
                if (artifact.metadata?.format) metadataRows.push(["format", String(artifact.metadata.format)]);
                if (artifact.metadata?.hasAlpha != null) metadataRows.push(["alpha", String(artifact.metadata.hasAlpha)]);
                if (artifact.metadata?.binary != null) metadataRows.push(["binary", String(artifact.metadata.binary)]);
                if (artifact.metadata?.modifiedAt) metadataRows.push(["modified", new Date(String(artifact.metadata.modifiedAt)).toLocaleString()]);
                if (artifact.metadata?.sha256) metadataRows.push(["sha256", String(artifact.metadata.sha256).slice(0, 16)]);
                const icon = isImage
                  ? <ImageIcon className="mt-0.5 h-4 w-4 text-muted-foreground" />
                  : isAudio
                    ? <FileAudio className="mt-0.5 h-4 w-4 text-muted-foreground" />
                    : isVideo
                      ? <FileVideo className="mt-0.5 h-4 w-4 text-muted-foreground" />
                  : artifact.kind === "board-task"
                    ? <ClipboardList className="mt-0.5 h-4 w-4 text-muted-foreground" />
                    : artifact.kind === "workflow-output"
                      ? <Workflow className="mt-0.5 h-4 w-4 text-muted-foreground" />
                      : <FileText className="mt-0.5 h-4 w-4 text-muted-foreground" />;
                return (
                  <div key={artifact.id} className="rounded-md border bg-background px-3 py-2">
                    <div className="flex items-start gap-2">
                      {icon}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="truncate text-xs font-medium text-foreground">{artifact.name}</div>
                            <div className="mt-1 truncate text-[11px] text-muted-foreground">
                              {artifact.kind} · {artifact.mimeType} · {artifact.sizeBytes.toLocaleString()} bytes
                            </div>
                          </div>
                          {artifact.status ? <Badge variant="outline" className="h-5 shrink-0 px-1.5 text-[10px]">{artifact.status}</Badge> : null}
                        </div>
                        <div className="mt-1 truncate text-[11px] text-muted-foreground">{artifact.source}</div>
                        {artifact.workflowId || artifact.executionId ? (
                          <div className="mt-1 truncate text-[10px] text-muted-foreground">
                            {artifact.workflowId ? `workflow ${artifact.workflowId}` : ""}{artifact.executionId ? ` · execution ${artifact.executionId}` : ""}
                          </div>
                        ) : null}
                        {artifact.href || artifact.source === "chat-upload" ? (
                          <a href={artifact.href || `/api/uploads?id=${encodeURIComponent(artifact.id)}`} className="mt-1 inline-flex text-[11px] font-medium text-primary hover:underline">
                            Open
                          </a>
                        ) : null}
                        {isPdf || isAudio || isVideo ? (
                          <Badge variant="outline" className="mt-2 h-5 px-1.5 text-[10px]">
                            {isPdf ? "PDF" : isAudio ? "Audio" : "Video"}
                          </Badge>
                        ) : null}
                        {previewUrl ? (
                          <img
                            src={previewUrl}
                            alt={artifact.name}
                            className="mt-2 max-h-44 w-full rounded border object-contain"
                          />
                        ) : null}
                        {metadataRows.length > 0 ? (
                          <div className="mt-2 grid gap-1 rounded border bg-muted/20 p-2 text-[10px] text-muted-foreground sm:grid-cols-2">
                            {metadataRows.map(([label, value]) => (
                              <div key={`${artifact.id}-${label}`} className="min-w-0">
                                <span className="font-medium text-foreground">{label}: </span>
                                <span className="font-mono">{value}</span>
                              </div>
                            ))}
                          </div>
                        ) : null}
                        {jsonPreview ? (
                          <pre className="mt-2 max-h-44 overflow-auto rounded border bg-muted/30 p-2 font-mono text-[11px] leading-relaxed text-foreground">
                            {jsonPreview}
                          </pre>
                        ) : null}
                        {csvPreview.length > 0 ? (
                          <div className="mt-2 max-h-44 overflow-auto rounded border">
                            <table className="w-full text-left text-[11px]">
                              <tbody>
                                {csvPreview.map((row, rowIndex) => (
                                  <tr key={rowIndex} className={rowIndex === 0 ? "bg-muted/50 font-medium" : "border-t"}>
                                    {row.map((cell, cellIndex) => (
                                      <td key={cellIndex} className="max-w-[140px] truncate px-2 py-1" title={cell}>{cell}</td>
                                    ))}
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        ) : null}
                        {artifact.path ? (
                          <div className="mt-1 break-all font-mono text-[10px] text-muted-foreground">{artifact.path}</div>
                        ) : null}
                        {artifact.previewText && !jsonPreview && csvPreview.length === 0 ? (
                          <pre className="mt-2 max-h-44 overflow-auto whitespace-pre-wrap rounded border bg-muted/30 p-2 text-[11px] leading-relaxed text-foreground">
                            {artifact.previewText}
                          </pre>
                        ) : null}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        ) : null}

        {workbenchTab === "trace" ? (
          <div className="space-y-3">
            {recentExecutionBadges.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {recentExecutionBadges.map((badge) => (
                  <Badge key={badge} variant="outline" className="max-w-full truncate">
                    {badge}
                  </Badge>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No route or execution metadata recorded yet.</p>
            )}
            {latestRoutingTrace ? (
              <div className="rounded-md border bg-background p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="text-xs font-semibold">Latest Routing Trace</div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => void navigator.clipboard?.writeText(latestRoutingTraceJson)}
                  >
                    <Copy className="mr-1 h-3.5 w-3.5" />
                    Copy
                  </Button>
                </div>
                <pre className="max-h-96 overflow-auto rounded bg-muted p-2 text-[11px] leading-relaxed">
                  {latestRoutingTraceJson}
                </pre>
              </div>
            ) : null}
            {sessionTurns.length > 0 ? (
              <div className="rounded-md border bg-background p-3">
                <div className="mb-2 text-xs font-semibold">Durable Turns</div>
                <div className="space-y-2">
                  {sessionTurns.slice(0, 6).map((turn) => (
                    <div key={turn.clientTurnId} className="rounded border bg-muted/20 px-2 py-2">
                      <div className="mb-1 flex items-center justify-between gap-2">
                        <Badge variant={turn.status === "failed" ? "destructive" : turn.status === "completed" ? "default" : "secondary"} className="text-[10px]">
                          {turn.status}
                        </Badge>
                        <span className="text-[10px] text-muted-foreground">{new Date(turn.updatedAt).toLocaleTimeString()}</span>
                      </div>
                      <div className="truncate text-xs text-foreground">{turn.message}</div>
                      {turn.streamContent && turn.status !== "completed" ? (
                        <div className="mt-1 max-h-20 overflow-auto whitespace-pre-wrap rounded bg-background px-2 py-1 text-[11px] text-muted-foreground">
                          {turn.streamContent}
                        </div>
                      ) : null}
                      {turn.error ? <div className="mt-1 text-[11px] text-destructive">{turn.error}</div> : null}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            {liveProgressEvents.length > 0 ? (
              <div className="rounded-md border bg-background p-3">
                <div className="mb-2 text-xs font-semibold">Live Workflow Progress</div>
                <div className="space-y-2">
                  {liveProgressEvents.slice(0, 8).map((event) => (
                    <div key={event.id} className="rounded border bg-muted/20 px-2 py-2">
                      <div className="mb-1 flex items-center justify-between gap-2">
                        <Badge variant={event.status === "failed" ? "destructive" : event.event.includes("complete") ? "default" : "secondary"} className="text-[10px]">
                          {event.event.replace("workflow:node:", "")}
                        </Badge>
                        <span className="text-[10px] text-muted-foreground">{new Date(event.createdAt).toLocaleTimeString()}</span>
                      </div>
                      <div className="truncate text-xs text-foreground">{event.label || event.nodeId || "workflow node"}</div>
                      <div className="truncate text-[11px] text-muted-foreground">
                        {event.nodeType || "node"}{event.durationMs != null ? ` · ${Math.round(event.durationMs)}ms` : ""}
                      </div>
                      {event.error ? (
                        <div className="mt-1 max-h-16 overflow-auto rounded bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
                          {event.error}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      {workbenchTab === "todo" ? (
      <div className="border-t p-4">
        <div className="flex gap-2">
          <Input
            value={todoInput}
            onChange={(event) => onTodoInputChange(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && onAddTodo()}
            placeholder="Add a temporary session task"
          />
          <Button onClick={() => void onAddTodo()} disabled={!todoInput.trim() || !currentSession}>
            Add
          </Button>
        </div>
        {sessionTodos.some((item) => item.isDone) ? (
          <Button
            variant="ghost"
            size="sm"
            className="mt-2 px-0 text-xs text-muted-foreground"
            onClick={() => void onMutateTodos({ todoAction: "clear-completed" })}
          >
            Clear completed
          </Button>
        ) : null}
      </div>
      ) : null}
    </aside>
  );
}
