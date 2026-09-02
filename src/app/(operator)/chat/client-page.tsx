"use client";

import { memo, useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { notifyCompletion } from "@/lib/client/completion-notifications";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import dynamic from "next/dynamic";
import { ChatMarkdown } from "@/components/chat/chat-markdown";
import { StreamingMarkdown } from "@/components/chat/streaming-markdown";
import { MessageActions } from "@/components/chat/message-actions";
import { ToolCallCard } from "@/components/chat/tool-call-card";
import { LiveAgentActivity } from "@/components/chat/live-agent-activity";
import { SessionSidebar, type ChatTeammateListItem } from "@/components/chat/session-sidebar";
import { ComposerContextStrip } from "@/components/chat/composer-context";

const MessageExecutionCardsDynamic = dynamic(
  () => import("@/components/chat/message-execution-cards").then((m) => ({ default: m.MessageExecutionCards })),
  { ssr: false, loading: () => null },
);
const PendingAppActionPlanEditorDynamic = dynamic(
  () => import("@/components/chat/pending-plan-editor").then((m) => ({ default: m.PendingAppActionPlanEditor })),
  { ssr: false, loading: () => null },
);
const ToolApprovalCardDynamic = dynamic(
  () => import("@/components/chat/tool-approval-card").then((m) => ({ default: m.ToolApprovalCard })),
  { ssr: false, loading: () => null },
);
const SessionWorkbenchDynamic = dynamic(
  () => import("@/components/chat/session-workbench").then((m) => ({ default: m.SessionWorkbench })),
  { ssr: false, loading: () => null },
);
const ChannelPulseDynamic = dynamic(
  () => import("@/components/chat/channel-pulse").then((m) => ({ default: m.ChannelPulse })),
  { ssr: false, loading: () => null },
);
const LivePlanPanelDynamic = dynamic(
  () => import("@/components/chat/live-plan-panel").then((m) => ({ default: m.LivePlanPanel })),
  { ssr: false, loading: () => null },
);
const LiveSessionPanelDynamic = dynamic(
  () => import("@/components/chat/live-session-panel").then((m) => ({ default: m.LiveSessionPanel })),
  { ssr: false, loading: () => null },
);
import { ArrowLeft, Send, Plus, MessageSquare, Loader2, Mic, Volume2, VolumeX, Download, Trash2, PanelRightClose, PanelRightOpen, ClipboardPlus, X, FileUp, Wrench, Zap, ZapOff, Clock } from "lucide-react";
import { nanoid } from "nanoid";
import type { ChatMessage } from "@/types/channel";
import { getCommandPaletteEntries } from "@/lib/channels/routing-spec";
import { estimateCost, formatCost } from "@/lib/agents/cost-estimator";
import { getModelContextWindow } from "@/lib/agents/context-windows";
import { APP_TTL, cachedJson, invalidateCache } from "@/lib/client/app-data-cache";
import { scheduleAfterUseful } from "@/lib/client/use-after-useful";
import { usePolling } from "@/lib/client/use-polling";

const THINKING_PATTERNS = [
  /<think>([\s\S]*?)<\/think>/gi,
  /<thinking>([\s\S]*?)<\/thinking>/gi,
  /<\|channel>thought\s+([\s\S]*?)<channel\|>/gi,
  /<\|turn\|>thinking\s+([\s\S]*?)<turn\|>/gi,
];

function extractThinking(text: string): { thinking: string[]; clean: string } {
  let clean = text;
  const thinking: string[] = [];
  for (const pattern of THINKING_PATTERNS) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      thinking.push(match[1].trim());
      clean = clean.replace(match[0], "");
    }
  }
  return { thinking, clean };
}

function stripJunkFromToken(rawToken: string): string {
  let clean = rawToken;
  clean = clean.replace(/<function_calls>[\s\S]*?<\/function_calls>/g, "");
  clean = clean.replace(/<function_call>[\s\S]*?<\/function_call>/g, "");
  clean = clean.replace(/<(?:thi|thin|think|thin|th|t|fu|fun|func|funct|functi|functio|function|funct|func)(?![a-z])/gi, "");
  clean = clean.replace(/<\|(?:cha|chan|chann|channe|channel|tur|turn|tu)(?![a-z|>])/gi, "");
  return clean;
}

type SessionTodoItem = {
  id: string;
  sessionId: string;
  content: string;
  isDone: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

type ChatModelRecord = {
  id: string;
  provider: string;
  modelId: string;
  name: string;
  isActive: boolean;
  fastMode?: boolean;
};

type ChatAgentRecord = {
  id: string;
  name: string;
  workspacePath: string;
  modelRef: string | null;
  enabledToolsets?: string[];
  enabledExtensions?: string[];
  enabledSkills?: string[];
  isDefault?: boolean;
  isActive?: boolean;
};

type ToolMode = "default" | "restricted" | "full";
type WorkbenchTab = "todo" | "context" | "objects" | "artifacts" | "trace";

type ChatSessionListItem = {
  id: string;
  title: string;
  fastMode: boolean | null;
  channel?: string;
  senderLabel?: string;
  deliveryState?: string;
  messageCount?: number;
  lastMessageAt?: string | null;
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

type ChatSessionSettings = {
  sessionId: string;
  fastMode: boolean | null;
  agentId: string | null;
  modelRef: string | null;
  workspacePath: string | null;
  toolMode: ToolMode;
};

type TrustedWorkspace = {
  path: string;
  label: string;
  source: string;
  updatedAt: string;
};

type WorkspacePreviewFile = {
  name: string;
  path: string;
  sizeBytes: number;
  preview: string;
};

type ChatAttachment = {
  id: string;
  sessionId: string | null;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  path: string;
  createdAt: string;
  previewUrl?: string | null;
  metadata?: Record<string, string | number | boolean | null>;
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

type EditableAppActionStep = {
  id: string;
  action: string;
  label: string;
  params: Record<string, unknown>;
  dependsOn?: string[];
};

type EditableAppActionPlan = {
  version: number;
  confidence: number;
  userIntent: string;
  requiresConfirmation: boolean;
  assumptions: string[];
  steps: EditableAppActionStep[];
};

const APP_ACTIONS = [
  "create_agents",
  "create_organization",
  "run_council",
  "create_board_task",
  "assign_skill_to_agent",
  "attach_extension_to_agent",
  "create_workflow_from_template",
  "schedule_workflow",
  "connect_channel",
  "recommend_templates",
  "summarize_state",
  "link_board_task_to_agent",
] as const;

function readPendingAppActionPlanLocal(value: unknown): EditableAppActionPlan | null {
  if (!value || typeof value !== "object") return null;
  const plan = value as Record<string, unknown>;
  if (!Array.isArray(plan.steps)) return null;
  return {
    version: Number(plan.version) || 1,
    confidence: Number(plan.confidence) || 0.7,
    userIntent: String(plan.userIntent || ""),
    requiresConfirmation: plan.requiresConfirmation !== false,
    assumptions: Array.isArray(plan.assumptions) ? plan.assumptions.map(String) : [],
    steps: (plan.steps as Array<Record<string, unknown>>).map((step, index) => ({
      id: String(step.id || `step-${index + 1}`),
      action: String(step.action || "summarize_state"),
      label: String(step.label || `Step ${index + 1}`),
      params: (step.params && typeof step.params === "object" && !Array.isArray(step.params) ? step.params : {}) as Record<string, unknown>,
      dependsOn: Array.isArray(step.dependsOn) ? step.dependsOn.map(String).filter(Boolean) : undefined,
    })),
  };
}

function formatEditedPlanResponse(summary: string): string {
  return [
    "## Pending confirmation",
    summary,
    "",
    'Reply with "confirm" to apply this change or "cancel" to skip it.',
  ].join("\n");
}

function readNumericMetadata(message: ChatMessage, key: "tokensUsed" | "costUsd" | "tokens"): number | null {
  const value = message.metadata?.[key] as unknown;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

type MessageRowProps = {
  msg: ChatMessage;
  isEditing: boolean;
  editValue: string;
  loading: boolean;
  lastAssistantMessageId: string | null;
  onEditStart: (message: ChatMessage) => void;
  onEditValueChange: (value: string) => void;
  onEditEnd: () => void;
  onSend: (messageText?: string, options?: { force?: boolean }) => Promise<void>;
  onRegenerateAssistant: (messageId: string) => void;
  onPendingPlanSaved: (messageId: string, plan: EditableAppActionPlan, summary: string) => void;
};

const MessageRow = memo(function MessageRow({
  msg,
  isEditing,
  editValue,
  loading,
  lastAssistantMessageId,
  onEditStart,
  onEditValueChange,
  onEditEnd,
  onSend,
  onRegenerateAssistant,
  onPendingPlanSaved,
}: MessageRowProps) {
  const isAppPlanPending =
    msg.role === "assistant" &&
    String(msg.provenance?.routeSource ?? msg.metadata?.routeSource ?? "") === "app-action-planner" &&
    msg.content.includes('Reply with "confirm"');
  const tokensUsed = readNumericMetadata(msg, "tokensUsed");
  const costUsd = readNumericMetadata(msg, "costUsd");

  return (
    <div
      className={`flex ${
        msg.role === "user"
          ? "justify-end"
          : msg.role === "system"
            ? "justify-center"
            : "justify-start"
      }`}
    >
      <div
        data-message-role={msg.role}
        className={`min-w-0 max-w-[86%] overflow-hidden rounded-md px-5 py-3 ${
          msg.role === "user"
            ? "group border border-terminal-red/70 bg-terminal-red/10 text-foreground shadow-[inset_3px_0_0_var(--terminal-red)]"
            : msg.role === "system"
              ? "border border-dashed bg-background text-foreground"
              : "group bg-muted"
        }`}
      >
        {msg.role === "system" && msg.metadata?.eventType ? (
          <div className="mb-2 flex items-center gap-2">
            <Badge variant="outline">{String(msg.metadata.eventType)}</Badge>
            {msg.metadata.channel ? <Badge variant="secondary">{String(msg.metadata.channel)}</Badge> : null}
          </div>
        ) : null}
        {msg.role !== "user" ? (
          <>
            <ChatMarkdown content={msg.content} />
            {msg.role === "assistant" && msg.content.trim().length > 0 ? (
              <MessageActions
                content={msg.content}
                onRegenerate={() => onRegenerateAssistant(msg.id)}
              />
            ) : null}
          </>
        ) : isEditing ? (
          <div className="flex gap-2">
            <textarea
              value={editValue}
              onChange={(e) => onEditValueChange(e.target.value)}
              className="flex-1 rounded-md border bg-background px-2 py-1 text-sm text-foreground resize-none"
              rows={2}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void onSend(editValue, { force: true });
                  onEditEnd();
                }
                if (e.key === "Escape") onEditEnd();
              }}
              autoFocus
            />
            <Button size="sm" onClick={() => { void onSend(editValue, { force: true }); onEditEnd(); }}>Send</Button>
          </div>
        ) : (
          <div>
            <div className="mb-1.5 font-display text-[10px] font-semibold uppercase text-terminal-red">You</div>
            <p className="whitespace-pre-wrap text-[15px] leading-6 text-foreground">{msg.content}</p>
          </div>
        )}
        {msg.role === "user" && !isEditing && (
          <button
            className="mt-1 text-[10px] text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity"
            onClick={() => onEditStart(msg)}
          >
            Edit
          </button>
        )}
        <MessageExecutionCardsDynamic message={msg} />
        {msg.role === "assistant" && lastAssistantMessageId === msg.id ? (
          <ToolApprovalCardDynamic sessionId={msg.sessionId} />
        ) : null}
        {isAppPlanPending && lastAssistantMessageId === msg.id ? (
          <PendingAppActionPlanEditorDynamic
            message={msg}
            loading={loading}
            onConfirm={() => void onSend("confirm", { force: true })}
            onCancel={() => void onSend("cancel", { force: true })}
            onSaved={onPendingPlanSaved}
          />
        ) : null}
        {tokensUsed !== null || costUsd !== null ? (
          <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
            {tokensUsed !== null ? <Badge variant="secondary">{tokensUsed} tokens</Badge> : null}
            {costUsd !== null ? <Badge variant="secondary">${costUsd.toFixed(4)}</Badge> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
});

const CHAT_QUICK_COMMAND_DEFINITIONS = [
  { label: "show commands", commands: ["show command palette", "show commands"] },
  { label: "check channel health", commands: ["check channel health"] },
  { label: "show channels", commands: ["show channels"] },
  { label: "list workflows", commands: ["list workflows"] },
  { label: "list agents", commands: ["list agents"] },
  { label: "show dashboard", commands: ["show dashboard"] },
] as const;

const COMMAND_PALETTE_ENTRIES = getCommandPaletteEntries();
const CHAT_QUICK_COMMANDS = CHAT_QUICK_COMMAND_DEFINITIONS.map((definition) => {
  const commands = definition.commands as readonly string[];
  const entry = COMMAND_PALETTE_ENTRIES.find((candidate) => commands.includes(candidate.command));
  return {
    label: definition.label,
    message: entry?.examplePhrase || definition.label,
    title: entry?.label || definition.label,
  };
});

function modelRefForRecord(model: ChatModelRecord): string {
  return `${model.provider}:${model.modelId}`;
}

function labelForEntityRef(ref: SessionEntityRef | null | undefined): string | null {
  if (!ref) return null;
  const name = String(ref.name || "").trim();
  const id = String(ref.id || "").trim();
  if (name && id) return `${name} (${id})`;
  return name || id || null;
}

function approxTokens(text: string): number {
  return Math.max(0, Math.ceil(text.trim().length / 4));
}

function modelLookupId(modelRef: string): string {
  const parts = modelRef.split(":");
  return parts.at(-1) || modelRef;
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

export default function ChatPage() {
  const searchParams = useSearchParams();
  const requestedSessionId = String(searchParams.get("sessionId") || searchParams.get("session") || "").trim();
  const [hydrated, setHydrated] = useState(false);
  const [chatViewMode, setChatViewMode] = useState<"simple" | "operator">("simple");
  const [mobileSessionOpen, setMobileSessionOpen] = useState(false);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [sessionLoadError, setSessionLoadError] = useState("");
  const [sessionReloadToken, setSessionReloadToken] = useState(0);
  const [sessions, setSessions] = useState<ChatSessionListItem[]>([]);
  const [currentSession, setCurrentSession] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const DRAFT_KEY = "disp8ch:composer-draft:";
  const handleComposerChange = (val: string) => {
    setInput(val);
    try {
      if (currentSession) localStorage.setItem(`${DRAFT_KEY}${currentSession}`, val);
    } catch {}
  };
  const [loading, setLoading] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const [liveSessionOpen, setLiveSessionOpen] = useState(false);
  const [voiceMode, setVoiceMode] = useState(false);
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const appliedQueryDraftRef = useRef("");
  const appliedQuerySessionRef = useRef("");
  const hiddenDuringRunRef = useRef(false);
  const [scrollPinned, setScrollPinned] = useState(true);
  const scrollPinnedRef = useRef(true);
  const nearBottomCounterRef = useRef(0);
  const userUnpinnedRef = useRef(false);
  const NEAR_BOTTOM_THRESHOLD = 80;
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const currentSessionRef = useRef<string | null>(null);
  const skillReviewInFlightRef = useRef<Set<string>>(new Set());
  const turnsFetchingRef = useRef<Set<string>>(new Set());
  const streamBufferRef = useRef("");
  const streamRafRef = useRef<number | null>(null);
  const [sessionFastMode, setSessionFastMode] = useState<boolean | null>(null);
  const [sessionTodos, setSessionTodos] = useState<SessionTodoItem[]>([]);
  const [todoInput, setTodoInput] = useState("");
  const [showSessionTodo, setShowSessionTodo] = useState(false);
  const [showRoutingDebug, setShowRoutingDebug] = useState(false);
  const [promotingTodoId, setPromotingTodoId] = useState<string | null>(null);
  const [models, setModels] = useState<ChatModelRecord[]>([]);
  const [agents, setAgents] = useState<ChatAgentRecord[]>([]);
  const [teammates, setTeammates] = useState<ChatTeammateListItem[]>([]);
  const [teammatesLoading, setTeammatesLoading] = useState(false);
  const [teammateError, setTeammateError] = useState<string | null>(null);
  const markingTeammateReadRef = useRef<Set<string>>(new Set());
  const [defaultAgentId, setDefaultAgentId] = useState<string | null>(null);
  const [workbenchTab, setWorkbenchTab] = useState<WorkbenchTab>("todo");
  const [mobileWorkbenchOpen, setMobileWorkbenchOpen] = useState(false);
  const [sessionAgentId, setSessionAgentId] = useState<string | null>(null);
  const [sessionModelRef, setSessionModelRef] = useState<string | null>(null);
  const [sessionWorkspacePath, setSessionWorkspacePath] = useState<string | null>(null);
  const [sessionToolMode, setSessionToolMode] = useState<ToolMode>("default");
  const [sessionObjects, setSessionObjects] = useState<SessionObjectsSnapshot>(null);
  const [queuedDrafts, setQueuedDrafts] = useState<Array<{ id: string; text: string; createdAt: string }>>([]);
  const [showQueuedDrafts, setShowQueuedDrafts] = useState(false);
  const [sendingQueuedDraft, setSendingQueuedDraft] = useState(false);
  const [sessionTurns, setSessionTurns] = useState<ChannelSessionTurn[]>([]);
  const [olderMessagesCursor, setOlderMessagesCursor] = useState<string | null>(null);
  const [hasOlderMessages, setHasOlderMessages] = useState(false);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  const [olderMessagesError, setOlderMessagesError] = useState("");
  const [liveProgressEvents, setLiveProgressEvents] = useState<LiveProgressEvent[]>([]);
  const [liveToolCards, setLiveToolCards] = useState<
    Array<{ id: string; name: string; args?: Record<string, unknown>; status: "running" | "done" | "error"; resultPreview?: string }>
  >([]);
  type TurnStatus = {
    sessionId: string;
    clientTurnId: string;
    phase: string;
    label: string;
    detail?: string | null;
    createdAt: string;
  };
  type ActiveTurn = {
    clientTurnId: string;
    sessionId: string;
    phase: "queued" | "routing" | "loading-context" | "drafting-plan" | "reviewing-plan" | "finalizing" | "streaming" | "cancelled";
    label: string;
    detail?: string;
    startedAt: number;
  };
  const [latestTurnStatus, setLatestTurnStatus] = useState<TurnStatus | null>(null);
  const [thinkingContent, setThinkingContent] = useState<string[]>([]);
  const [trustedWorkspaces, setTrustedWorkspaces] = useState<TrustedWorkspace[]>([]);
  const [workspacePreviewFiles, setWorkspacePreviewFiles] = useState<WorkspacePreviewFile[]>([]);
  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachment[]>([]);
  const [sessionArtifacts, setSessionArtifacts] = useState<SessionArtifact[]>([]);
  const [uploadingAttachment, setUploadingAttachment] = useState(false);
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [chatBoot, setChatBoot] = useState<{
    sessions: { count: number; recent: { id: string; title: string; updatedAt: string; messageCount: number }[] };
    models: { count: number; active: number };
    agents: { count: number; activeAgent: { id: string; name: string } | null };
  } | null>(null);
  const chatBootstrappedRef = useRef(false);
  const currentSessionRecord = useMemo(
    () => sessions.find((session) => session.id === currentSession) ?? null,
    [currentSession, sessions],
  );
  const currentTeammate = useMemo(
    () => teammates.find((teammate) => teammate.sessionId === currentSession) ?? null,
    [currentSession, teammates],
  );
  useEffect(() => {
    if (!currentTeammate || currentTeammate.unread === 0) return;
    if (markingTeammateReadRef.current.has(currentTeammate.id)) return;
    const agentId = currentTeammate.id;
    const sessionId = currentTeammate.sessionId;
    markingTeammateReadRef.current.add(agentId);
    void fetch("/api/teammates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "mark-read", agentId }),
    }).then(async (response) => {
      const json = await response.json() as { success?: boolean; error?: string };
      if (!response.ok || !json.success) throw new Error(json.error || `Could not mark agent chat read (${response.status})`);
      return json;
    })
      .then(() => {
        if (currentSessionRef.current === sessionId) {
          setTeammates((current) => current.map((entry) => entry.id === agentId ? { ...entry, unread: 0 } : entry));
        }
      })
      .catch((error) => setTeammateError(error instanceof Error ? error.message : "Could not update agent unread state"))
      .finally(() => { markingTeammateReadRef.current.delete(agentId); });
  }, [currentTeammate]);
  const activeModel = useMemo(
    () => {
      if (sessionModelRef) {
        const match = models.find((model) => model.id === sessionModelRef || modelRefForRecord(model) === sessionModelRef);
        if (match) return match;
      }
      return models.find((model) => model.isActive) ?? models[0] ?? null;
    },
    [models, sessionModelRef],
  );
  const defaultAgent = useMemo(
    () =>
      agents.find((agent) => agent.id === defaultAgentId) ??
      agents.find((agent) => agent.isDefault) ??
      agents.find((agent) => agent.isActive !== false) ??
      null,
    [agents, defaultAgentId],
  );
  const activeAgent = useMemo(
    () =>
      agents.find((agent) => agent.id === sessionAgentId) ??
      defaultAgent,
    [agents, defaultAgent, sessionAgentId],
  );
  const activeChannelLabel = useMemo(() => {
    if (currentSessionRecord?.channel) return currentSessionRecord.channel;
    if (!currentSession) return "webchat";
    const [channel] = currentSession.split(":", 1);
    return currentSession.includes(":") && channel ? channel : "webchat";
  }, [currentSession, currentSessionRecord?.channel]);
  const isExternalChannelSession = Boolean(currentSessionRecord?.channel && currentSessionRecord.channel !== "webchat");
  // Desktop watch windows open with ?readOnly=1 for a read-only view of a session.
  const readOnlyWatch = searchParams.get("readOnly") === "1";
  const composerLocked = isExternalChannelSession || readOnlyWatch;
  const agentModelLabel = useMemo(() => {
    if (sessionModelRef) return sessionModelRef;
    if (activeAgent?.modelRef) return activeAgent.modelRef;
    if (activeModel) return `${activeModel.provider}/${activeModel.modelId}`;
    return "no active model";
  }, [activeAgent?.modelRef, activeModel, sessionModelRef]);
  const agentWorkspaceLabel = useMemo(() => {
    const workspace = sessionWorkspacePath || activeAgent?.workspacePath || "default workspace";
    const parts = workspace.split(/[\\/]/).filter(Boolean);
    return parts.slice(-2).join("/") || workspace;
  }, [activeAgent?.workspacePath, sessionWorkspacePath]);
  const agentCapabilityLabel = useMemo(() => {
    const skillCount = activeAgent?.enabledSkills?.length ?? 0;
    const extensionCount = activeAgent?.enabledExtensions?.length ?? 0;
    const toolsetCount = activeAgent?.enabledToolsets?.length ?? 0;
    const parts = [
      toolsetCount > 0 ? `${toolsetCount} toolset${toolsetCount === 1 ? "" : "s"}` : "default tools",
      skillCount > 0 ? `${skillCount} skill${skillCount === 1 ? "" : "s"}` : null,
      extensionCount > 0 ? `${extensionCount} extension${extensionCount === 1 ? "" : "s"}` : null,
    ].filter(Boolean);
    if (sessionToolMode !== "default") parts.unshift(`${sessionToolMode} tool mode`);
    return parts.join(" / ");
  }, [activeAgent?.enabledExtensions?.length, activeAgent?.enabledSkills?.length, activeAgent?.enabledToolsets?.length, sessionToolMode]);
  const liveMeter = useMemo(() => {
    const selectedModel = sessionModelRef || activeAgent?.modelRef || (activeModel ? modelRefForRecord(activeModel) : "");
    const modelId = modelLookupId(selectedModel);
    const contextWindow = getModelContextWindow(modelId);
    const historyTokens = messages.reduce((sum, message) => sum + approxTokens(message.content), 0);
    const draftTokens = approxTokens(input);
    const estimatedOutputTokens = draftTokens > 0 ? Math.min(1200, Math.max(256, Math.ceil(draftTokens * 1.5))) : 0;
    const totalTokens = historyTokens + draftTokens;
    const contextPercent = contextWindow ? Math.min(100, Math.round((totalTokens / contextWindow) * 1000) / 10) : null;
    const cost = selectedModel ? estimateCost(modelId, draftTokens, estimatedOutputTokens) : 0;
    return {
      selectedModel,
      contextWindow,
      historyTokens,
      draftTokens,
      estimatedOutputTokens,
      contextPercent,
      estimatedCost: formatCost(cost) || "$0",
    };
  }, [activeAgent?.modelRef, activeModel, input, messages, sessionModelRef]);
  const sessionHealth = useMemo(
    () => [
      { label: "Session", value: currentSessionRecord?.title || "new chat" },
      { label: "Agent", value: activeAgent?.name || "default" },
      { label: "Model Mode", value: sessionFastMode === null ? "auto" : sessionFastMode ? "fast" : "standard" },
      { label: "Snapshot", value: messages.length > 0 ? `${messages.length} messages` : "empty" },
      { label: "Open Todos", value: String(sessionTodos.filter((item) => !item.isDone).length) },
      { label: "Turn Queue", value: sessionTurns[0] ? sessionTurns[0].status : "idle" },
    ],
    [activeAgent?.name, currentSessionRecord?.title, messages.length, sessionFastMode, sessionTodos, sessionTurns],
  );
  const latestRoutingTrace = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index--) {
      const trace = messages[index]?.metadata?.routingTrace;
      if (trace && typeof trace === "object") return trace as Record<string, unknown>;
    }
    return null;
  }, [messages]);
  const latestRoutingTraceJson = useMemo(
    () => latestRoutingTrace ? JSON.stringify(latestRoutingTrace, null, 2) : "",
    [latestRoutingTrace],
  );
  const latestPendingPlan = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index--) {
      const plan = readPendingAppActionPlanLocal(messages[index]?.metadata?.pendingAppActionPlan);
      if (plan) return plan;
    }
    return null;
  }, [messages]);
  const recentExecutionBadges = useMemo(() => {
    const badges: string[] = [];
    for (let index = messages.length - 1; index >= 0 && badges.length < 6; index--) {
      const metadata = messages[index]?.metadata;
      const provenance = messages[index]?.provenance;
      const routeSource = String(provenance?.routeSource ?? metadata?.routeSource ?? "").trim();
      const eventType = String(metadata?.eventType ?? "").trim();
      const channel = String(provenance?.channel ?? metadata?.channel ?? "").trim();
      if (routeSource && !badges.includes(`route: ${routeSource}`)) badges.push(`route: ${routeSource}`);
      if (eventType && !badges.includes(eventType)) badges.push(eventType);
      if (channel && !badges.includes(`channel: ${channel}`)) badges.push(`channel: ${channel}`);
    }
    return badges;
  }, [messages]);

  const lastMessage = useMemo(() => messages[messages.length - 1] ?? null, [messages]);
  const isClarifying = lastMessage?.role === "assistant" && (
    lastMessage.content?.includes("Reply with") ||
    lastMessage.content?.includes("confirm") ||
    lastMessage.content?.includes("cancel")
  );
  const composerPlaceholder = loading
      ? "Type to queue or steer..."
      : isClarifying
        ? "Type confirm, edit, or cancel..."
        : "Type a message...";

  const applyRecoveredTurns = useCallback((turns: ChannelSessionTurn[], sessionId: string) => {
    setSessionTurns(turns);
    const activeTurn = turns.find((turn) => turn.status === "processing" || turn.status === "queued") ?? null;
    if (activeTurn) {
      setLoading(true);
      setStreamingContent(activeTurn.streamContent || "");
      return;
    }
    const latestCompleted = turns.find((turn) => turn.status === "completed" && turn.response);
    if (latestCompleted?.response) {
      const assistantMsg: ChatMessage = {
        id: `${latestCompleted.clientTurnId}:assistant`,
        sessionId,
        role: "assistant",
        content: latestCompleted.response,
        metadata: latestCompleted.metadata ?? undefined,
        provenance: latestCompleted.provenance ?? undefined,
        createdAt: latestCompleted.completedAt || latestCompleted.updatedAt,
      };
      setMessages((prev) => {
        const exists = prev.some((entry) => entry.role === "assistant" && entry.content === assistantMsg.content);
        return exists ? prev : [...prev, assistantMsg];
      });
      setLoading(false);
      setStreamingContent("");
      return;
    }
    if (turns.some((turn) => turn.status === "failed")) {
      setLoading(false);
      setStreamingContent("");
    }
  }, []);

  const refreshSessionTurns = useCallback(async (sessionId: string) => {
    if (turnsFetchingRef.current.has(sessionId)) return;
    turnsFetchingRef.current.add(sessionId);
    try {
      const response = await fetch(`/api/channels?action=session-turns&sessionId=${encodeURIComponent(sessionId)}`);
      const json = await response.json() as { success?: boolean; data?: ChannelSessionTurn[] };
      if (json.success) {
        const turns = (json.data ?? []) as ChannelSessionTurn[];
        applyRecoveredTurns(turns, sessionId);
        const activeTurn = turns.find((t) => t.status === "processing" || t.status === "queued");
        if (activeTurn?.progressEvents?.length) {
          setLiveProgressEvents((current) => {
            if (current.length > 0) return current;
            return activeTurn.progressEvents!.map((pe) => ({
              id: `${activeTurn.clientTurnId}:${pe.eventType}:${pe.createdAt}`,
              event: pe.eventType,
              nodeId: pe.data && typeof pe.data === "object" && "nodeId" in pe.data ? String((pe.data as Record<string, unknown>).nodeId ?? "") : undefined,
              nodeType: pe.data && typeof pe.data === "object" && "nodeType" in pe.data ? String((pe.data as Record<string, unknown>).nodeType ?? "") : undefined,
              label: pe.data && typeof pe.data === "object" && "label" in pe.data ? String((pe.data as Record<string, unknown>).label ?? "") : undefined,
              status: pe.data && typeof pe.data === "object" && "status" in pe.data ? String((pe.data as Record<string, unknown>).status ?? "") : undefined,
              durationMs: pe.data && typeof pe.data === "object" && "durationMs" in pe.data && typeof (pe.data as Record<string, unknown>).durationMs === "number" ? (pe.data as Record<string, unknown>).durationMs as number : undefined,
              error: pe.data && typeof pe.data === "object" && "error" in pe.data ? String((pe.data as Record<string, unknown>).error ?? "") : undefined,
              createdAt: pe.createdAt,
            }));
          });
        }
      }
    } finally {
      turnsFetchingRef.current.delete(sessionId);
    }
  }, [applyRecoveredTurns]);

  // Keep ref in sync so WS handler always sees the current session
  useEffect(() => {
    if (!loading) return;
    hiddenDuringRunRef.current = document.hidden;
    const markHidden = () => {
      if (document.hidden) hiddenDuringRunRef.current = true;
    };
    document.addEventListener("visibilitychange", markHidden);
    return () => document.removeEventListener("visibilitychange", markHidden);
  }, [loading]);

  useEffect(() => {
    currentSessionRef.current = currentSession;
    setLiveProgressEvents([]);
    setOlderMessagesCursor(null);
    setHasOlderMessages(false);
    setLoadingOlderMessages(false);
    setOlderMessagesError("");
  }, [currentSession]);

  useEffect(() => {
    setHydrated(true);
    try {
      const storedMode = window.localStorage.getItem("disp8ch-chat-view-mode");
      if (storedMode === "simple" || storedMode === "operator") {
        setChatViewMode(storedMode);
      }
    } catch {}
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem("disp8ch-chat-show-session-todo");
    if (stored === "0") {
      setShowSessionTodo(false);
    }
    const storedWorkbenchTab = window.localStorage.getItem("disp8ch-chat-workbench-tab");
    if (storedWorkbenchTab === "todo" || storedWorkbenchTab === "context" || storedWorkbenchTab === "objects" || storedWorkbenchTab === "artifacts" || storedWorkbenchTab === "trace") {
      setWorkbenchTab(storedWorkbenchTab);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("disp8ch-chat-show-session-todo", showSessionTodo ? "1" : "0");
  }, [showSessionTodo]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("disp8ch-chat-workbench-tab", workbenchTab);
  }, [workbenchTab]);

  useEffect(() => {
    if (typeof window === "undefined" || !hydrated) return;
    try { localStorage.setItem("disp8ch-chat-view-mode", chatViewMode); } catch {}
  }, [chatViewMode, hydrated]);

  const loadFullSessionData = useCallback(async () => {
    cachedJson<any>("channels:sessions", "/api/channels?action=sessions", APP_TTL.channels)
      .then((data) => {
        if (data.success && data.data.length > 0) {
          setSessions(data.data);
          try {
            if (requestedSessionId) {
              setCurrentSession(requestedSessionId);
            } else {
              const lastId = localStorage.getItem("disp8ch-last-chat-session");
              const match = data.data.find((s: ChatSessionListItem) => s.id === lastId);
              setCurrentSession(match ? match.id : data.data[0].id);
            }
          } catch {
            setCurrentSession(requestedSessionId || data.data[0].id);
          }
        }
      })
      .catch(() => {});

    cachedJson<any>("models", "/api/models", APP_TTL.models)
      .then((data) => {
        if (data.success && Array.isArray(data.data)) {
          setModels(data.data as ChatModelRecord[]);
        }
      })
      .catch(() => setModels([]));

    cachedJson<any>("agents", "/api/agents", APP_TTL.agents)
      .then((data) => {
        if (data.success && data.data) {
          setAgents(Array.isArray(data.data.agents) ? data.data.agents as ChatAgentRecord[] : []);
          setDefaultAgentId(typeof data.data.defaultId === "string" ? data.data.defaultId : null);
        }
      })
      .catch(() => {
        setAgents([]);
        setDefaultAgentId(null);
      });
    fetch("/api/workspaces")
      .then((r) => r.json())
      .then((data) => {
        if (data.success) setTrustedWorkspaces((data.data ?? []) as TrustedWorkspace[]);
      })
      .catch(() => setTrustedWorkspaces([]));
  }, [requestedSessionId]);

  // Bootstrap-first: critical data for immediate shell render
  useEffect(() => {
    chatBootstrappedRef.current = true;
    let cancelled = false;
    fetch("/api/chat/bootstrap")
      .then((r) => r.json())
      .then((json) => {
        if (cancelled || !json.success) return;
        setChatBoot(json.data);
        if (json.data.sessions?.recent?.length > 0) {
          setSessions(json.data.sessions.recent.map((s: Record<string, unknown>) => ({
            id: String(s.id || ""),
            title: String(s.title || ""),
            fastMode: false as boolean | null,
            messageCount: typeof s.messageCount === "number" ? s.messageCount : 0,
            lastMessageAt: String(s.updatedAt || ""),
          })));
          try {
            if (requestedSessionId) {
              setCurrentSession(requestedSessionId);
            } else {
              const lastId = localStorage.getItem("disp8ch-last-chat-session");
              const match = json.data.sessions.recent.find((s: Record<string, unknown>) => String(s.id || "") === lastId);
              setCurrentSession(match ? String(match.id || "") : String(json.data.sessions.recent[0].id || ""));
            }
          } catch {
            setCurrentSession(requestedSessionId || String(json.data.sessions.recent[0].id || ""));
          }
        }
        setLoading(false);
      })
      .catch(() => {});

    // Full session data is deferred until after useful-ready + idle so
    // /api/channels?action=sessions, /api/agents, /api/models, and /api/workspaces
    // do not fire pre-ready on chat.
    const cancelDeferred = scheduleAfterUseful(() => {
      if (!cancelled) void loadFullSessionData();
    });

    return () => { cancelled = true; cancelDeferred(); };
  }, [loadFullSessionData]);

  // WebSocket connection for live streaming tokens
  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let active = true;

    function connect() {
      if (!active) return;
      try {
        const protocol = window.location.protocol === "https:" ? "wss" : "ws";
        const fallbackPort = (() => {
          const currentPort = parseInt(window.location.port || "3100", 10);
          return Number.isNaN(currentPort) ? "3101" : String(currentPort + 1);
        })();
        const wsPort = fallbackPort;
        ws = new WebSocket(`${protocol}://${window.location.hostname}:${wsPort}`);
      } catch {
        return;
      }

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string) as {
            type: string;
            data: {
              sessionId?: string;
              clientTurnId?: string;
              token?: string;
              role?: "user" | "assistant" | "system";
              content?: string;
              metadata?: Record<string, unknown>;
              createdAt?: string;
            };
          };
          if (msg.type === "webchat:stream") {
            const { sessionId: sid, token } = msg.data;
            if (sid === currentSessionRef.current && typeof token === "string") {
              const cleaned = stripJunkFromToken(token);
              const { thinking, clean } = extractThinking(cleaned);
              if (thinking.length > 0) {
                setThinkingContent((prev) => [...prev, ...thinking]);
              }
              streamBufferRef.current += clean;
              if (streamRafRef.current === null) {
                streamRafRef.current = requestAnimationFrame(() => {
                  setStreamingContent(streamBufferRef.current);
                  streamRafRef.current = null;
                });
              }
            }
            return;
          }
          if (msg.type === "webchat:status") {
            const status = msg.data as TurnStatus;
            if (status.sessionId === currentSessionRef.current) {
              setLatestTurnStatus(status);
            }
            return;
          }
          if (msg.type === "webchat:progress") {
            const payload = msg.data as Record<string, unknown>;
            if (payload.sessionId === currentSessionRef.current) {
              setLiveProgressEvents((current) => [
                {
                  id: `${String(payload.clientTurnId || "turn")}:${String(payload.event || "progress")}:${String(payload.nodeId || current.length)}:${Date.now()}`,
                  event: String(payload.event || "progress"),
                  nodeId: typeof payload.nodeId === "string" ? payload.nodeId : undefined,
                  nodeType: typeof payload.nodeType === "string" ? payload.nodeType : undefined,
                  label: typeof payload.label === "string" ? payload.label : undefined,
                  status: typeof payload.status === "string" ? payload.status : undefined,
                  durationMs: typeof payload.durationMs === "number" ? payload.durationMs : undefined,
                  error: typeof payload.error === "string" ? payload.error : undefined,
                  createdAt: new Date().toISOString(),
                },
                ...current,
              ].slice(0, 20));
            }
            return;
          }
          if (msg.type === "webchat:tool") {
            const { clientTurnId, phase, name, args, resultPreview } = msg.data as any;
            if (phase === "start") {
              setLiveToolCards(prev => [...prev, { id: `${name}-${Date.now()}`, name, args, status: "running" }]);
            } else {
              setLiveToolCards(prev => prev.map(c =>
                c.name === name && c.status === "running"
                  ? { ...c, status: phase === "done" ? "done" : "error", resultPreview }
                  : c
              ));
            }
            return;
          }
          if (msg.type === "webchat:message") {
            const { sessionId: sid, role, content: rawContent, metadata, createdAt } = msg.data;
            if (sid === currentSessionRef.current && role && typeof rawContent === "string") {
              const content = extractThinking(rawContent).clean;
              setMessages((prev) => {
                const recentDuplicate = prev.slice(-3).some((entry) => entry.role === role && entry.content === content);
                if (recentDuplicate) return prev;
                return [
                  ...prev,
                  {
                    id: nanoid(8),
                    sessionId: sid,
                    role,
                    content,
                    metadata,
                    createdAt: createdAt || new Date().toISOString(),
                  },
                ];
              });
              if (role === "assistant") {
                notifyCompletion({
                  key: `chat-${sid}-${createdAt || rawContent.length}`,
                  title: "disp8ch response ready",
                  body: "Your response is ready.",
                  sessionId: sid,
                  wasHiddenDuringRun: hiddenDuringRunRef.current,
                });
                streamBufferRef.current = "";
                if (streamRafRef.current !== null) { cancelAnimationFrame(streamRafRef.current); streamRafRef.current = null; }
                setLoading(false);
                setStreamingContent("");
                setLiveToolCards([]);
                setLatestTurnStatus(null);
                setThinkingContent([]);
                void refreshSessionTurns(sid).catch(() => {});
              }
            }
          }
        } catch {
          // ignore malformed frames
        }
      };

      ws.onclose = () => {
        if (active) {
          reconnectTimer = setTimeout(connect, 3000);
        }
      };

      ws.onerror = () => {
        ws?.close();
      };
    }

    connect();

    return () => {
      active = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, [refreshSessionTurns]);

  useEffect(() => {
    if (chatBootstrappedRef.current) return;
    cachedJson<any>("channels:sessions", "/api/channels?action=sessions", APP_TTL.channels)
      .then((data) => {
        if (data.success && data.data.length > 0) {
          setSessions(data.data);
          try {
            if (requestedSessionId) {
              setCurrentSession(requestedSessionId);
            } else {
              const lastId = localStorage.getItem("disp8ch-last-chat-session");
              const match = data.data.find((s: ChatSessionListItem) => s.id === lastId);
              setCurrentSession(match ? match.id : data.data[0].id);
            }
          } catch {
            setCurrentSession(requestedSessionId || data.data[0].id);
          }
        }
      })
      .catch(() => {});
  }, [requestedSessionId]);

  useEffect(() => {
    if (chatBootstrappedRef.current) return;
    cachedJson<any>("models", "/api/models", APP_TTL.models)
      .then((data) => {
        if (data.success && Array.isArray(data.data)) {
          setModels(data.data as ChatModelRecord[]);
        }
      })
      .catch(() => setModels([]));

    cachedJson<any>("agents", "/api/agents", APP_TTL.agents)
      .then((data) => {
        if (data.success && data.data) {
          setAgents(Array.isArray(data.data.agents) ? data.data.agents as ChatAgentRecord[] : []);
          setDefaultAgentId(typeof data.data.defaultId === "string" ? data.data.defaultId : null);
        }
      })
      .catch(() => {
        setAgents([]);
        setDefaultAgentId(null);
      });
    fetch("/api/workspaces")
      .then((r) => r.json())
      .then((data) => {
        if (data.success) setTrustedWorkspaces((data.data ?? []) as TrustedWorkspace[]);
      })
      .catch(() => setTrustedWorkspaces([]));
  }, []);

  useEffect(() => {
    const workspace = sessionWorkspacePath || activeAgent?.workspacePath || "";
    if (!workspace) {
      setWorkspacePreviewFiles([]);
      return;
    }
    fetch(`/api/workspaces?action=preview&path=${encodeURIComponent(workspace)}`)
      .then((r) => r.json())
      .then((data) => {
        setWorkspacePreviewFiles(data.success ? (data.data?.files ?? []) as WorkspacePreviewFile[] : []);
      })
      .catch(() => setWorkspacePreviewFiles([]));
  }, [activeAgent?.workspacePath, sessionWorkspacePath]);

  useEffect(() => {
    if (!currentSession) return;
    let cancelled = false;
    const loadingSid = currentSession;
    setSessionLoading(true);
    setSessionLoadError("");

    fetch(`/api/channels?action=messages&sessionId=${encodeURIComponent(currentSession)}&limit=100`)
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.error || `Could not load chat (${response.status})`);
        return data;
      })
      .then((data) => {
        // Only apply the result if this is still the active session.
        if (cancelled || currentSessionRef.current !== loadingSid) return;
        setSessionLoading(false);
        setSessionLoadError("");
        setHasOlderMessages(Boolean(data.page?.hasMore));
        setOlderMessagesCursor(typeof data.page?.nextCursor === "string" ? data.page.nextCursor : null);
        const fetchedMessages = (data.data ?? []) as ChatMessage[];
        setMessages((current) => {
          const localActiveMessages = current.filter((message) => message.sessionId === currentSession);
          if (localActiveMessages.length === 0) return fetchedMessages;
          const fetchedKeys = new Set(
            fetchedMessages.map((message) => `${message.role}:${message.content}:${message.createdAt ?? ""}`),
          );
          const optimisticMessages = localActiveMessages.filter((message) => {
            const key = `${message.role}:${message.content}:${message.createdAt ?? ""}`;
            return !fetchedKeys.has(key);
          });
          if (optimisticMessages.length === 0) return fetchedMessages;
          return [...fetchedMessages, ...optimisticMessages].sort((left, right) => {
            const leftTime = Date.parse(left.createdAt || "") || 0;
            const rightTime = Date.parse(right.createdAt || "") || 0;
            return leftTime - rightTime;
          });
        });
      })
      .catch((error) => {
        if (cancelled || currentSessionRef.current !== loadingSid) return;
        setSessionLoading(false);
        setMessages([]);
        setHasOlderMessages(false);
        setOlderMessagesCursor(null);
        setSessionLoadError(error instanceof Error ? error.message : "Could not load this chat.");
      });
    fetch(`/api/channels?action=session-settings&sessionId=${currentSession}`)
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled && currentSessionRef.current === loadingSid && data.success) {
          const settings = data.data as Partial<ChatSessionSettings> | undefined;
          setSessionFastMode(settings?.fastMode ?? null);
          setSessionAgentId(settings?.agentId ?? null);
          setSessionModelRef(settings?.modelRef ?? null);
          setSessionWorkspacePath(settings?.workspacePath ?? null);
          setSessionToolMode(settings?.toolMode === "restricted" || settings?.toolMode === "full" ? settings.toolMode : "default");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSessionFastMode(null);
          setSessionAgentId(null);
          setSessionModelRef(null);
          setSessionWorkspacePath(null);
          setSessionToolMode("default");
        }
      });
    fetch(`/api/channels?action=session-todos&sessionId=${currentSession}`)
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) {
          if (data.success) {
            setSessionTodos((data.data ?? []) as SessionTodoItem[]);
          }
        }
      })
      .catch(() => { if (!cancelled) setSessionTodos([]); });
    // session-turns recovery is owned by the dedicated `refreshSessionTurns`
    // effect below — it dedupes in-flight requests via `turnsFetchingRef`.
    fetch(`/api/artifacts?sessionId=${encodeURIComponent(currentSession)}`)
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) {
          if (data.success) setSessionArtifacts((data.data ?? []) as SessionArtifact[]);
        }
      })
      .catch(() => { if (!cancelled) setSessionArtifacts([]); });

    return () => { cancelled = true; };
  }, [applyRecoveredTurns, currentSession, sessionReloadToken]);

  const loadOlderMessages = useCallback(async () => {
    if (!currentSession || !olderMessagesCursor || loadingOlderMessages) return;
    const loadingSessionId = currentSession;
    const scrollElement = scrollRef.current;
    const previousScrollHeight = scrollElement?.scrollHeight ?? 0;
    const previousScrollTop = scrollElement?.scrollTop ?? 0;
    setLoadingOlderMessages(true);
    setOlderMessagesError("");
    try {
      const response = await fetch(`/api/channels?action=messages&sessionId=${encodeURIComponent(currentSession)}&limit=100&before=${encodeURIComponent(olderMessagesCursor)}`);
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || `Could not load older messages (${response.status})`);
      if (currentSessionRef.current !== loadingSessionId) return;
      const older = (data.data ?? []) as ChatMessage[];
      setMessages((current) => {
        const ids = new Set(current.map((message) => message.id));
        return [...older.filter((message) => !ids.has(message.id)), ...current];
      });
      requestAnimationFrame(() => {
        const element = scrollRef.current;
        if (!element || currentSessionRef.current !== loadingSessionId) return;
        element.scrollTop = previousScrollTop + Math.max(0, element.scrollHeight - previousScrollHeight);
      });
      if (currentSessionRef.current === loadingSessionId) {
        setHasOlderMessages(Boolean(data.page?.hasMore));
        setOlderMessagesCursor(typeof data.page?.nextCursor === "string" ? data.page.nextCursor : null);
      }
    } catch (error) {
      if (currentSessionRef.current === loadingSessionId) {
        setOlderMessagesError(error instanceof Error ? error.message : "Could not load older messages.");
      }
    } finally {
      if (currentSessionRef.current === loadingSessionId) setLoadingOlderMessages(false);
    }
  }, [currentSession, loadingOlderMessages, olderMessagesCursor]);

  useEffect(() => {
    if (!currentSession) return;
    fetch(`/api/channels?action=routing-debug&sessionId=${currentSession}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.success) {
          setSessionObjects((data.data?.recentEntities ?? null) as SessionObjectsSnapshot);
        }
      })
      .catch(() => setSessionObjects(null));
  }, [currentSession, messages.length]);

  useEffect(() => {
    if (currentSession) {
      try { localStorage.setItem("disp8ch-last-chat-session", currentSession); } catch { /* quota exceeded */ }
    }
  }, [currentSession]);

  useEffect(() => {
    try {
      const draft = currentSession ? localStorage.getItem(`${DRAFT_KEY}${currentSession}`) : null;
      if (draft) setInput(draft);
      else setInput("");
    } catch {}
  }, [currentSession]);

  useEffect(() => {
    if (!requestedSessionId || appliedQuerySessionRef.current === requestedSessionId) return;
    appliedQuerySessionRef.current = requestedSessionId;
    setCurrentSession(requestedSessionId);
  }, [requestedSessionId]);

  useEffect(() => {
    const draft = String(searchParams.get("draft") || "").trim();
    if (!draft) return;
    const draftApplicationKey = `${currentSession || "__no_session__"}\u0000${draft}`;
    if (appliedQueryDraftRef.current === draftApplicationKey) return;
    appliedQueryDraftRef.current = draftApplicationKey;
    setInput(draft);
    try {
      if (currentSession) localStorage.setItem(`${DRAFT_KEY}${currentSession}`, draft);
    } catch {}
  }, [currentSession, searchParams]);

  useEffect(() => {
    if (currentSession) {
      void refreshSessionTurns(currentSession);
    }
  }, [currentSession, refreshSessionTurns]);

  const hasActiveTurn = loading || sessionTurns.some((turn) => turn.status === "queued" || turn.status === "processing");
  usePolling(
    async () => { await refreshSessionTurns(currentSession!); },
    [currentSession, loading, refreshSessionTurns, sessionTurns],
    { intervalMs: 2000, enabled: Boolean(currentSession && hasActiveTurn), pauseWhenHidden: true, backoffOnError: true, immediate: false },
  );

  useEffect(() => {
    if (typeof window === "undefined" || !currentSession) {
      setQueuedDrafts([]);
      return;
    }
    try {
      const raw = window.localStorage.getItem(`disp8ch-chat-queued-drafts:${currentSession}`);
      const parsed = raw ? JSON.parse(raw) as unknown : [];
      setQueuedDrafts(Array.isArray(parsed) ? parsed.filter((item) => {
        const record = item as Partial<{ id: string; text: string; createdAt: string }>;
        return typeof record.id === "string" && typeof record.text === "string" && record.text.trim();
      }).map((item) => item as { id: string; text: string; createdAt: string }) : []);
    } catch {
      setQueuedDrafts([]);
    }
  }, [currentSession]);

  useEffect(() => {
    if (typeof window === "undefined" || !currentSession) return;
    window.localStorage.setItem(`disp8ch-chat-queued-drafts:${currentSession}`, JSON.stringify(queuedDrafts));
  }, [currentSession, queuedDrafts]);

  useEffect(() => {
    if (scrollRef.current && scrollPinnedRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, streamingContent]);

  const createSession = () => {
    const id = nanoid(8);
    const session = { id, title: "New Chat", fastMode: null, channel: "webchat", senderLabel: "local operator", messageCount: 0 };
    setSessions((prev) => [...prev, session]);
    setCurrentSession(id);
    setMessages([]);
    setSessionLoading(false);
    setSessionLoadError("");
    setHasOlderMessages(false);
    setOlderMessagesCursor(null);
    setOlderMessagesError("");
    setSessionFastMode(null);
    setSessionAgentId(null);
    setSessionModelRef(null);
    setSessionWorkspacePath(null);
    setSessionToolMode("default");
    setSessionObjects(null);
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "n") {
        e.preventDefault();
        createSession();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [createSession]);

  const updateSessionTitle = useCallback((sessionId: string, title: string) => {
    setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, title } : s)));
  }, []);

  const handleSelectSession = useCallback((id: string) => {
    if (id === currentSession) return;
    setSessionLoading(true);
    setSessionLoadError("");
    setMessages([]);
    setHasOlderMessages(false);
    setOlderMessagesCursor(null);
    setLoadingOlderMessages(false);
    setOlderMessagesError("");
    setStreamingContent("");
    setThinkingContent([]);
    setSessionTurns([]);
    setLiveProgressEvents([]);
    setLoading(false);
    setCurrentSession(id);
  }, [currentSession]);

  const loadTeammates = useCallback(async () => {
    setTeammatesLoading(true);
    try {
      const response = await fetch("/api/teammates");
      const json = await response.json() as { success?: boolean; data?: { teammates?: ChatTeammateListItem[] }; error?: string };
      if (!response.ok || !json.success) throw new Error(json.error || `Could not refresh agents (${response.status})`);
      setTeammates(Array.isArray(json.data?.teammates) ? json.data.teammates : []);
      setTeammateError(null);
    } catch (error) {
      setTeammateError(error instanceof Error ? error.message : "Could not refresh agents");
    } finally {
      setTeammatesLoading(false);
    }
  }, []);

  const handleSelectTeammate = useCallback(async (agentId: string) => {
    const teammate = teammates.find((entry) => entry.id === agentId);
    if (!teammate?.isActive) return;
    setTeammateError(null);
    try {
      const response = await fetch("/api/teammates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "open", agentId }),
      });
      const json = await response.json() as { success?: boolean; data?: { sessionId?: string }; error?: string };
      const sessionId = String(json.data?.sessionId || "");
      if (!response.ok || !json.success || !sessionId) throw new Error(json.error || `Could not open agent chat (${response.status})`);
      setTeammates((current) => current.map((entry) => entry.id === agentId ? { ...entry, sessionId } : entry));
      setSessions((current) => current.some((session) => session.id === sessionId)
        ? current
        : [{ id: sessionId, title: teammate.name, fastMode: null, channel: "webchat", senderLabel: teammate.name, messageCount: 0 }, ...current]);
      handleSelectSession(sessionId);
      setMobileSessionOpen(false);
    } catch (error) {
      setTeammateError(error instanceof Error ? error.message : "Could not open agent chat");
    }
  }, [handleSelectSession, teammates]);

  useEffect(() => {
    void loadTeammates();
  }, [agents.length, loadTeammates, messages.length]);

  useEffect(() => {
    if (searchParams.get("teammates") !== "1" || typeof window === "undefined") return;
    if (window.matchMedia("(max-width: 767px)").matches) setMobileSessionOpen(true);
  }, [searchParams]);

  const deleteSession = useCallback(async (sessionId: string) => {
    try {
      const response = await fetch("/api/channels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "delete-session",
          sessionId,
        }),
      });
      const json = await response.json() as { success?: boolean };
      if (!json.success) return;
      invalidateCache(/^channels:sessions/);
      setSessions((prev) => {
        const next = prev.filter((session) => session.id !== sessionId);
        if (currentSession === sessionId) {
          setCurrentSession(next[0]?.id ?? null);
          setMessages([]);
          setSessionFastMode(next[0]?.fastMode ?? null);
          setSessionTodos([]);
          setSessionAgentId(null);
          setSessionModelRef(null);
          setSessionWorkspacePath(null);
          setSessionToolMode("default");
          setSessionObjects(null);
        }
        return next;
      });
    } catch {
      // no-op
    }
  }, [currentSession]);

  const handleUndo = useCallback(async () => {
    if (!currentSession) return;
    try {
      const res = await fetch("/api/undo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: currentSession }),
      });
      const data = await res.json() as { success?: boolean; data?: { messagePreview?: string; undone?: boolean } };
      if (data.success) {
        const msgsRes = await fetch(`/api/channels?action=messages&sessionId=${currentSession}`);
        const msgsData = await msgsRes.json() as { success?: boolean; data?: ChatMessage[] };
        if (msgsData.success && msgsData.data) setMessages(msgsData.data);
      }
    } catch { /* silent */ }
  }, [currentSession]);

  const updateSessionSettings = useCallback(async (patch: Partial<Omit<ChatSessionSettings, "sessionId">>) => {
    const sessionId = currentSession || nanoid(8);
    if (!currentSession) {
      setSessions((prev) => [
        ...prev,
        { id: sessionId, title: `Chat ${sessions.length + 1}`, fastMode: patch.fastMode ?? sessionFastMode },
      ]);
      setCurrentSession(sessionId);
    }

    const res = await fetch("/api/channels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "session-settings",
        sessionId,
        fastMode: patch.fastMode === undefined ? sessionFastMode : patch.fastMode,
        agentId: patch.agentId === undefined ? sessionAgentId : patch.agentId,
        modelRef: patch.modelRef === undefined ? sessionModelRef : patch.modelRef,
        workspacePath: patch.workspacePath === undefined ? sessionWorkspacePath : patch.workspacePath,
        toolMode: patch.toolMode === undefined ? sessionToolMode : patch.toolMode,
      }),
    });
    const data = await res.json() as { success?: boolean; data?: Partial<ChatSessionSettings> };
    if (!data.success) return;
    setSessionFastMode(data.data?.fastMode ?? null);
    setSessionAgentId(data.data?.agentId ?? null);
    setSessionModelRef(data.data?.modelRef ?? null);
    setSessionWorkspacePath(data.data?.workspacePath ?? null);
    setSessionToolMode(data.data?.toolMode === "restricted" || data.data?.toolMode === "full" ? data.data.toolMode : "default");
    setSessions((prev) =>
      prev.map((session) =>
        session.id === sessionId
          ? { ...session, fastMode: data.data?.fastMode ?? null }
          : session,
      ),
    );
  }, [currentSession, sessionAgentId, sessionFastMode, sessionModelRef, sessionToolMode, sessionWorkspacePath, sessions.length]);

  const updateSessionFastMode = useCallback(async (fastMode: boolean | null) => {
    await updateSessionSettings({ fastMode });
  }, [updateSessionSettings]);

  const playAudio = useCallback(async (text: string) => {
    if (!voiceMode || !text) return;
    try {
      const res = await fetch("/api/voice/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, voice: "alloy" }),
      });
      if (!res.ok) return;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.onended = () => URL.revokeObjectURL(url);
      await audio.play();
    } catch {
      // Voice mode fails silently
    }
  }, [voiceMode]);

  const exportChat = useCallback((format: "json" | "markdown") => {
    if (!currentSession) return;
    const url = `/api/channels?action=export&sessionId=${encodeURIComponent(currentSession)}&format=${format}`;
    const a = document.createElement("a");
    a.href = url;
    a.download = `chat-${currentSession}.${format === "json" ? "json" : "md"}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, [currentSession]);

  const mutateSessionTodos = useCallback(async (payload: Record<string, unknown>) => {
    if (!currentSession) return;
    const response = await fetch("/api/channels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "session-todos",
        sessionId: currentSession,
        ...payload,
      }),
    });
    const json = await response.json() as { success: boolean; data?: { items?: SessionTodoItem[] } };
    if (json.success) {
      setSessionTodos((json.data?.items ?? []) as SessionTodoItem[]);
    }
  }, [currentSession]);

  const uploadAttachment = useCallback(async (file: File) => {
    const sessionId = currentSession || nanoid(8);
    if (!currentSession) {
      setSessions((prev) => [
        ...prev,
        { id: sessionId, title: "Attachment chat", fastMode: sessionFastMode, channel: "webchat", senderLabel: "local operator", messageCount: 0 },
      ]);
      setCurrentSession(sessionId);
    }
    const form = new FormData();
    form.set("file", file);
    form.set("sessionId", sessionId);
    setUploadingAttachment(true);
    try {
      const response = await fetch("/api/uploads", { method: "POST", body: form });
      const json = await response.json() as { success?: boolean; data?: ChatAttachment; error?: string };
      if (json.success && json.data) {
        const attachment = {
          ...json.data,
          previewUrl: json.data.mimeType.startsWith("image/")
            ? `/api/uploads?id=${encodeURIComponent(json.data.id)}`
            : null,
        };
        setPendingAttachments((current) => [...current, attachment].slice(-6));
        setSessionArtifacts((current) => [
          {
            id: attachment.id,
            kind: attachment.mimeType.startsWith("image/") ? "image" : "file",
            name: attachment.fileName,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
            path: attachment.path,
            createdAt: attachment.createdAt,
            source: "chat-upload",
            previewText: null,
            status: null,
            workflowId: null,
            executionId: null,
            previewUrl: attachment.previewUrl,
            href: null,
            metadata: attachment.metadata,
          },
          ...current,
        ]);
      }
    } finally {
      setUploadingAttachment(false);
    }
  }, [currentSession, sessionFastMode]);

  const requestSkillReview = useCallback((): string => {
    if (!currentSession) return "Start a conversation before requesting a skill review.";
    const reviewSessionId = currentSession;
    if (skillReviewInFlightRef.current.has(reviewSessionId)) {
      return "A skill review is already running for this conversation.";
    }
    skillReviewInFlightRef.current.add(reviewSessionId);
    void fetch("/api/learning/review-conversation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: reviewSessionId, agentId: sessionAgentId }),
    })
      .then(async (response) => {
        const json = await response.json();
        if (!response.ok || !json.success) throw new Error(String(json.error || `Review failed with HTTP ${response.status}`));
        return json;
      })
      .then((json) => {
        if (currentSessionRef.current !== reviewSessionId) return;
        const result = json.success
          ? json.data?.written > 0
            ? `Skill review created ${json.data.written} proposal${json.data.written === 1 ? "" : "s"}. Review them in Skills & Extensions before applying.`
            : json.data?.skippedReason || "No new reusable skill proposal was needed."
          : `Skill review failed: ${json.error || "unknown error"}`;
        setMessages((previous) => [...previous, { id: nanoid(), role: "system", content: result, sessionId: reviewSessionId, createdAt: new Date().toISOString() }]);
      })
      .catch((error) => {
        if (currentSessionRef.current !== reviewSessionId) return;
        setMessages((previous) => [...previous, { id: nanoid(), role: "system", content: `Skill review failed: ${String(error)}`, sessionId: reviewSessionId, createdAt: new Date().toISOString() }]);
      })
      .finally(() => { skillReviewInFlightRef.current.delete(reviewSessionId); });
    return "Reviewing this conversation for reusable, approval-gated skill improvements…";
  }, [currentSession, sessionAgentId]);

  const sendMessage = useCallback(async (messageText?: string, options?: { force?: boolean }) => {
    if (isExternalChannelSession) {
      setMessages((prev) => [
        ...prev,
        {
          id: nanoid(),
          sessionId: currentSession || "",
          role: "system",
          content: "This external channel session is read-only in /chat. Reply from the source channel.",
          createdAt: new Date().toISOString(),
        },
      ]);
      return;
    }
    const text = messageText ?? input.trim();
    if (!text && pendingAttachments.length === 0) return;
    if (text.trim() === "/review-skill" && pendingAttachments.length === 0) {
      const status = requestSkillReview();
      setMessages((previous) => [...previous, { id: nanoid(), role: "system", content: status, sessionId: currentSession || "", createdAt: new Date().toISOString() }]);
      setInput("");
      return;
    }
    const attachmentContext = pendingAttachments.length > 0
      ? [
          "",
          "Attached local files:",
          ...pendingAttachments.map((file) => `- asset_id=${file.id}; name=${file.fileName}; type=${file.mimeType}; size=${file.sizeBytes} bytes`),
        ].join("\n")
      : "";
    const outboundText = `${text || "Please review the attached local file."}${attachmentContext}`;
    if (loading && !options?.force) {
      const queued = { id: nanoid(8), text: outboundText, createdAt: new Date().toISOString() };
      setQueuedDrafts((prev) => [...prev, queued].slice(-8));
      setInput("");
      setPendingAttachments([]);
      return;
    }

    const sessionId = currentSession || nanoid(8);
    if (!currentSession) {
      const session = {
        id: sessionId,
        title: text.slice(0, 30) || "New Chat",
        fastMode: sessionFastMode,
        channel: "webchat",
        senderLabel: "local operator",
        messageCount: 0,
      };
      setSessions((prev) => [...prev, session]);
      setCurrentSession(sessionId);
    }

    const userMsg: ChatMessage = {
      id: nanoid(8),
      sessionId,
      role: "user",
      content: outboundText,
      provenance: {
        source: "channel:webchat",
        channel: "webchat",
        sessionId,
      },
      createdAt: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    try { localStorage.removeItem(`${DRAFT_KEY}${sessionId}`); } catch {}
    setPendingAttachments([]);
    streamBufferRef.current = "";
    if (streamRafRef.current !== null) { cancelAnimationFrame(streamRafRef.current); streamRafRef.current = null; }
    setLoading(true);
    setStreamingContent("");
    setThinkingContent([]);
    // Honest initial label: "Sending..." reflects what's really happening —
    // the server hasn't classified the message yet. As soon as the server
    // responds (within ~50ms) it pushes a "Routing your message..." status,
    // then "Calling DeepSeek..." or similar as the workflow advances.
    const hasAppActionIntent = /create\s+(?:\d+\s+)?agent|org|team|company|create.*task|add.*board|run\s+(?:the\s+)?(?:org|research|task|workflow)|schedule/i.test(text.trim());
    setLatestTurnStatus({
      clientTurnId: userMsg.id,
      sessionId,
      phase: hasAppActionIntent ? "routing" : "queued",
      label: hasAppActionIntent ? "Planning app changes…" : "Sending…",
      detail: hasAppActionIntent ? "Checking what needs to be created or updated" : undefined,
      createdAt: new Date().toISOString(),
    });

    try {
      const res = await fetch("/api/channels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "chat",
          sessionId,
          message: outboundText,
          clientTurnId: userMsg.id,
          agentId: activeAgent?.id ?? sessionAgentId ?? undefined,
          sessionSettings: {
            fastMode: sessionFastMode,
            agentId: activeAgent?.id ?? sessionAgentId ?? null,
            modelRef: sessionModelRef,
            workspacePath: sessionWorkspacePath ?? activeAgent?.workspacePath ?? null,
            toolMode: sessionToolMode,
          },
          attachmentIds: pendingAttachments.map((a) => a.id).filter(Boolean),
          async: true,
        }),
      });

      const data = await res.json();

      if (data.success) {
        // Auto-title: set session title from first user message
        if (messages.length === 0 && !editingMessageId) {
          const firstMessageTitle = text.trim().slice(0, 48);
          if (firstMessageTitle) {
            updateSessionTitle(sessionId, firstMessageTitle);
          }
        }
        if (data.data?.queued) {
          await refreshSessionTurns(sessionId);
          setLoading(true);
          return;
        }
        const directContent = data.data.response as string;
        const cleanedContent = extractThinking(directContent).clean;
        const assistantMsg: ChatMessage = {
          id: nanoid(8),
          sessionId,
          role: "assistant",
          content: cleanedContent,
          metadata: data.data.metadata,
          provenance: data.data.provenance ?? null,
          createdAt: new Date().toISOString(),
        };
        setMessages((prev) => {
          const recentDuplicate = prev.slice(-3).some((entry) => entry.role === "assistant" && entry.content === assistantMsg.content);
          return recentDuplicate ? prev : [...prev, assistantMsg];
        });
        void refreshSessionTurns(sessionId).catch(() => {});
    setStreamingContent("");
    setThinkingContent([]);
    setLiveToolCards([]);
        playAudio(cleanedContent);
        // Opt-in: notify if the user navigated away while this response ran.
        notifyCompletion({
          key: `chat-${sessionId}-${assistantMsg.id}`,
          title: "disp8ch response ready",
          body: "Your response is ready.",
          sessionId,
          wasHiddenDuringRun: hiddenDuringRunRef.current,
        });
      }
    } catch {
      const errorMsg: ChatMessage = {
        id: nanoid(8),
        sessionId,
        role: "assistant",
        content: "Sorry, something went wrong. Please try again.",
        createdAt: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, errorMsg]);
      setStreamingContent("");
      setThinkingContent([]);
    }

    setLoading(false);
  }, [activeAgent?.id, activeAgent?.workspacePath, input, loading, currentSession, isExternalChannelSession, pendingAttachments, playAudio, refreshSessionTurns, requestSkillReview, sessionAgentId, sessionFastMode, sessionModelRef, sessionToolMode, sessionWorkspacePath]);

  useEffect(() => {
    if (loading || sendingQueuedDraft || queuedDrafts.length === 0) return;
    const [next, ...rest] = queuedDrafts;
    setSendingQueuedDraft(true);
    setQueuedDrafts(rest);
    void sendMessage(next.text, { force: true }).finally(() => setSendingQueuedDraft(false));
  }, [loading, queuedDrafts, sendMessage, sendingQueuedDraft]);

  const handlePendingPlanSaved = useCallback((messageId: string, plan: EditableAppActionPlan, summary: string) => {
    setMessages((prev) =>
      prev.map((message) =>
        message.id === messageId
          ? {
              ...message,
              content: formatEditedPlanResponse(summary),
              metadata: {
                ...(message.metadata ?? {}),
                pendingAppActionPlan: plan,
              },
            }
          : message,
      ),
    );
  }, []);

  const addTodo = useCallback(async () => {
    const content = todoInput.trim();
    if (!content || !currentSession) return;
    await mutateSessionTodos({ todoAction: "add", content });
    setTodoInput("");
  }, [currentSession, mutateSessionTodos, todoInput]);

  const promoteTodoToBoardTask = useCallback(async (item: SessionTodoItem) => {
    setPromotingTodoId(item.id);
    try {
      const response = await fetch("/api/boards/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          boardId: "main-board",
          title: item.content,
          description: `Promoted from session todo in chat ${item.sessionId}.`,
          sourceType: "session-todo",
          sourceRef: item.id,
          status: "inbox",
          priority: "medium",
        }),
      });
      const json = await response.json() as { success?: boolean };
      if (json.success) {
        await mutateSessionTodos({ todoAction: "remove", todoId: item.id });
      }
    } finally {
      setPromotingTodoId(null);
    }
  }, [mutateSessionTodos]);

  const SLASH_COMMANDS: Array<{ command: string; description: string; handler: (input: string) => string | void }> = [
    {
      command: "/teammates",
      description: "Open the agent chats in the conversation sidebar",
      handler: () => {
        setMobileSessionOpen(true);
        return "Agent teammates are pinned above recent conversations in the Chats sidebar.";
      },
    },
    {
      command: "/discover",
      description: "Show capabilities relevant to this page",
      handler: () => { window.dispatchEvent(new CustomEvent("disp8ch:discover-more")); },
    },
    {
      command: "/review-skill",
      description: "Review this conversation for a reusable skill proposal",
      handler: requestSkillReview,
    },
    {
      command: "/fast on",
      description: "Enable fast mode for this chat",
      handler: () => { void updateSessionFastMode(true); return "Fast mode enabled — using cheaper/faster model."; },
    },
    {
      command: "/fast off",
      description: "Disable fast mode for this chat",
      handler: () => { void updateSessionFastMode(false); return "Fast mode disabled — using standard model."; },
    },
    {
      command: "/fast auto",
      description: "Auto fast mode (model default)",
      handler: () => { void updateSessionFastMode(null); return "Fast mode set to auto — model default will be used."; },
    },
    {
      command: "/restricted",
      description: "Enable restricted tool mode",
      handler: () => { void updateSessionSettings({ toolMode: "restricted" }); return "Tool mode: restricted — high-risk tools blocked."; },
    },
    {
      command: "/full",
      description: "Enable full tool access",
      handler: () => { void updateSessionSettings({ toolMode: "full" }); return "Tool mode: full — all tools available."; },
    },
    {
      command: "/default",
      description: "Default tool policy",
      handler: () => { void updateSessionSettings({ toolMode: "default" }); return "Tool mode: default policy restored."; },
    },
    {
      command: "/new",
      description: "Start a new chat",
      handler: () => { createSession(); return undefined; },
    },
    {
      command: "/clear",
      description: "Clear current chat messages",
      handler: () => { setMessages([]); setSessionTurns([]); return undefined; },
    },
    {
      command: "/undo",
      description: "Undo the last assistant message in this chat",
      handler: () => { void handleUndo(); return "Undoing last assistant message..."; },
    },
    {
      command: "/steer",
      description: "Correct the agent mid-turn (e.g. /steer focus on files not APIs)",
      handler: (input: string) => {
        const steeringText = input.slice(7).trim(); // Remove "/steer "
        if (!steeringText) return "Usage: /steer <correction message>";
        void sendMessage(steeringText, { force: true });
        return `Steering: "${steeringText}" — interrupting current task.`;
      },
    },
    {
      command: "/retry",
      description: "Retry the last message with a correction",
      handler: (input: string) => {
        const correction = input.slice(7).trim();
        const lastUserMsg = messages.filter(m => m.role === "user").pop();
        const lastUserText = lastUserMsg?.content || "";
        const retryText = correction ? `${lastUserText}\n\n[Correction: ${correction}]` : lastUserText;
        if (!lastUserText) return "No message to retry.";
        void sendMessage(retryText, { force: true });
        return `Retrying with correction: "${correction || "none"}"`;
      },
    },
    {
      command: "/compress",
      description: "Manually compress conversation context",
      handler: () => {
        if (!currentSession) return "No active session to compress.";
        fetch("/api/channels", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "compress-session",
            sessionId: currentSession,
          }),
        }).catch(() => {});
        return "Context compression requested. The system will compact older messages to save tokens.";
      },
    },
  ];
  const [slashSuggestions, setSlashSuggestions] = useState<Array<{ command: string; description: string }>>([]);
  const [slashIndex, setSlashIndex] = useState(0);
  const [mentionSuggestions, setMentionSuggestions] = useState<Array<{ value: string; label: string; description: string }>>([]);
  const [mentionIndex, setMentionIndex] = useState(0);

  const completeMention = useCallback((value: string) => {
    setInput((current) => current.replace(/(^|\s)@[^\s]*$/, (_match, prefix: string) => `${prefix}${value}`));
    setMentionSuggestions([]);
  }, []);

  const SUGGESTION_CHIPS = [
    { label: "Show active workflows", message: "list workflows" },
    { label: "Check channel health", message: "check channel health" },
    { label: "Help me create a board task", message: "help me create a board task for tracking our next feature" },
  ];

  const returnTo = useMemo(() => {
    const requested = String(searchParams.get("returnTo") || "").trim();
    return requested.startsWith("/") && !requested.startsWith("//") ? requested : "";
  }, [searchParams]);

  const returnLabel = useMemo(() => {
    if (!returnTo) return "";
    const segment = returnTo.split(/[?#]/)[0].split("/").filter(Boolean).at(-1) || "workspace";
    return segment === "designs" ? "Design Studio" : segment.charAt(0).toUpperCase() + segment.slice(1);
  }, [returnTo]);

  const lastAssistantMessageId = useMemo(
    () => {
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index].role === "assistant") return messages[index].id;
      }
      return null;
    },
    [messages],
  );

  const handleStartEditMessage = useCallback((message: ChatMessage) => {
    setEditingMessageId(message.id);
    setEditValue(message.content);
  }, []);

  const handleEndEditMessage = useCallback(() => {
    setEditingMessageId(null);
  }, []);

  const handleRegenerateAssistant = useCallback((messageId: string) => {
    const idx = messages.findIndex((message) => message.id === messageId);
    if (idx <= 0) return;
    for (let index = idx - 1; index >= 0; index -= 1) {
      if (messages[index].role === "user") {
        void sendMessage(messages[index].content, { force: true });
        return;
      }
    }
  }, [messages, sendMessage]);

  return (
      <>
    <div className="flex flex-1 overflow-hidden">
        <div data-perf-ready="chat" style={{ display: "contents" }}>
        <SessionSidebar
          sessions={sessions}
          teammates={teammates}
          teammatesLoading={teammatesLoading}
          teammateError={teammateError}
          onSelectTeammate={(agentId) => void handleSelectTeammate(agentId)}
          currentSession={currentSession}
          onSelectSession={handleSelectSession}
          onCreateSession={createSession}
          onDeleteSession={(id) => void deleteSession(id)}
          onExportChat={exportChat}
          renamingSessionId={renamingSessionId}
          renameValue={renameValue}
          onRenameStart={(id, title) => { setRenamingSessionId(id); setRenameValue(title); }}
          onRenameChange={setRenameValue}
          onRenameCommit={() => {
            if (renameValue.trim() && renamingSessionId) {
              updateSessionTitle(renamingSessionId, renameValue.trim());
            }
            setRenamingSessionId(null);
          }}
          onRenameCancel={() => setRenamingSessionId(null)}
        />

        {/* Chat main area */}
        <div className="flex flex-1 overflow-hidden">
          <div
            className="flex min-w-0 flex-1 flex-col"
            onDragEnter={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragOver={(e) => e.preventDefault()}
          >
            {dragOver ? (
              <div
                className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm"
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  for (const file of Array.from(e.dataTransfer.files)) {
                    void uploadAttachment(file);
                  }
                }}
                onDragOver={(e) => e.preventDefault()}
              >
                <div className="rounded-lg border-2 border-dashed border-primary/50 bg-background px-8 py-6 text-center">
                  <FileUp className="mx-auto h-8 w-8 text-muted-foreground" />
                  <p className="mt-2 text-sm font-medium text-foreground">Drop files to upload</p>
                  <p className="text-xs text-muted-foreground">Images, PDFs, text files</p>
                </div>
              </div>
            ) : null}
            <ChannelPulseDynamic />
            <LivePlanPanelDynamic steps={sessionTodos.map(t => ({ id: t.id, content: t.content, isDone: t.isDone, updatedAt: t.updatedAt }))} />
            {/* Desktop top bar */}
            <div className="hidden md:flex items-center justify-between border-b px-4 py-1.5">
              <div className="flex items-center gap-2">
                {returnTo ? (
                  <Button asChild variant="ghost" size="sm" className="h-7 shrink-0 px-2 text-xs normal-case tracking-normal">
                    <a href={returnTo} title={`Return to ${returnLabel}`}>
                      <ArrowLeft className="mr-1 h-3.5 w-3.5" /> {returnLabel}
                    </a>
                  </Button>
                ) : null}
                {chatViewMode === "operator" ? (
                  <ComposerContextStrip
                    agents={agents}
                    models={models}
                    sessionAgentId={sessionAgentId}
                    sessionModelRef={sessionModelRef}
                    sessionToolMode={sessionToolMode}
                    sessionWorkspacePath={sessionWorkspacePath}
                    activeAgent={activeAgent}
                    activeChannelLabel={activeChannelLabel}
                    agentModelLabel={agentModelLabel}
                    agentCapabilityLabel={agentCapabilityLabel}
                    liveMeter={liveMeter}
                    onUpdateSettings={(patch) => void updateSessionSettings(patch as Parameters<typeof updateSessionSettings>[0])}
                    trustedWorkspaces={trustedWorkspaces}
                    defaultAgent={defaultAgent}
                    agentLocked={Boolean(currentTeammate)}
                  />
                ) : (
                  <span className="text-xs text-muted-foreground">
                    {activeAgent?.name || "default"} · {agentModelLabel}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                <Button
                  variant={chatViewMode === "simple" ? "default" : "outline"}
                  size="sm" className="h-7 shrink-0"
                  onClick={() => setChatViewMode(v => v === "simple" ? "operator" : "simple")}
                  title={chatViewMode === "simple" ? "Switch to Operator mode" : "Switch to Simple mode"}
                >
                  {chatViewMode === "simple" ? "Simple" : "Operator"}
                </Button>
                <Button
                  variant={showSessionTodo ? "default" : "outline"}
                  size="sm"
                  className="h-7 shrink-0"
                  onClick={() => setShowSessionTodo((v) => !v)}
                >
                  {showSessionTodo ? <PanelRightClose className="mr-1 h-3.5 w-3.5" /> : <PanelRightOpen className="mr-1 h-3.5 w-3.5" />}
                  Workbench
                </Button>
              </div>
            </div>

            {/* Mobile top bar */}
            <div className="flex md:hidden items-center justify-between border-b px-3 py-1.5">
              {returnTo ? (
                <Button asChild variant="ghost" size="icon" className="h-7 w-7">
                  <a href={returnTo} aria-label={`Return to ${returnLabel}`} title={`Return to ${returnLabel}`}>
                    <ArrowLeft className="h-4 w-4" />
                  </a>
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => setMobileSessionOpen(true)}
                  aria-label="Open sessions"
                  title="Open sessions"
                >
                  <MessageSquare className="h-4 w-4" />
                </Button>
              )}
              <span className="text-sm font-medium truncate mx-2 flex-1 min-w-0">
                {currentSessionRecord?.title || "Chat"}
              </span>
              <div className="flex items-center gap-1">
                {returnTo ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-10 w-10"
                    onClick={() => setMobileSessionOpen(true)}
                    aria-label="Open chats and agents"
                    title="Open chats and agents"
                  >
                    <MessageSquare className="h-4 w-4" />
                  </Button>
                ) : null}
                <Button
                  variant={chatViewMode === "simple" ? "default" : "outline"}
                  size="sm" className="h-7 shrink-0"
                  onClick={() => setChatViewMode(v => v === "simple" ? "operator" : "simple")}
                  title={chatViewMode === "simple" ? "Switch to Operator mode" : "Switch to Simple mode"}
                >
                  {chatViewMode === "simple" ? "Simple" : "Operator"}
                </Button>
                <Button
                  variant={showSessionTodo ? "default" : "outline"}
                  size="sm"
                  className="h-7 shrink-0"
                  onClick={() => setShowSessionTodo((v) => !v)}
                  aria-label="Open Workbench"
                  title="Open Workbench"
                >
                  <PanelRightOpen className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
            <div
              ref={scrollRef}
              className="flex-1 overflow-auto p-4 space-y-4 relative"
              onScroll={() => {
                const el = scrollRef.current;
                if (!el) return;
                const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
                if (distFromBottom <= NEAR_BOTTOM_THRESHOLD) {
                  nearBottomCounterRef.current++;
                  if (nearBottomCounterRef.current >= 2) {
                    scrollPinnedRef.current = true;
                    userUnpinnedRef.current = false;
                    setScrollPinned(true);
                  }
                } else {
                  nearBottomCounterRef.current = 0;
                  if (!userUnpinnedRef.current) {
                    userUnpinnedRef.current = true;
                    scrollPinnedRef.current = false;
                    setScrollPinned(false);
                  }
                }
                setShowJumpToBottom(distFromBottom > 80 && !scrollPinnedRef.current);
              }}
              onClick={(e) => {
                const target = e.target as HTMLElement;
                if (target.tagName === "IMG" && target.getAttribute("src")) {
                  setLightboxImage(target.getAttribute("src"));
                }
              }}
            >
              {hasOlderMessages ? (
                <div className="flex flex-col items-center gap-2 pb-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={loadingOlderMessages}
                    onClick={() => void loadOlderMessages()}
                    className="h-10 transition-transform duration-150 ease-out active:not-disabled:scale-[0.96]"
                  >
                    {loadingOlderMessages ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Clock className="mr-1.5 h-3.5 w-3.5" />}
                    Load older messages
                  </Button>
                  {olderMessagesError ? <p role="alert" className="text-xs text-destructive">{olderMessagesError}</p> : null}
                </div>
              ) : null}
              {sessionLoading ? (
                <div className="flex flex-1 items-center justify-center" role="status">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  <span className="text-sm text-muted-foreground">Loading chat…</span>
                </div>
              ) : sessionLoadError ? (
                <div className="flex flex-1 items-center justify-center px-4">
                  <div role="alert" className="max-w-md rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-center text-sm text-destructive">
                    <p>{sessionLoadError}</p>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="mt-3 h-10 transition-[background-color,border-color,transform] active:scale-[0.96]"
                      onClick={() => {
                        setSessionLoading(true);
                        setSessionLoadError("");
                        setSessionReloadToken((value) => value + 1);
                      }}
                    >
                      Try again
                    </Button>
                  </div>
                </div>
              ) : messages.length === 0 ? (
                <div className="flex flex-1 items-center justify-center h-full">
                  <div className="max-w-md text-center text-muted-foreground">
                    <MessageSquare className="mx-auto mb-4 h-10 w-10 opacity-50" />
                    <p className="text-sm font-medium text-foreground">What can I help with?</p>
                    <div className="mt-4 flex flex-wrap justify-center gap-2">
                      {SUGGESTION_CHIPS.map((chip) => (
                        <Button
                          key={chip.label}
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-8 rounded-full px-4 text-xs"
                          disabled={loading}
                          onClick={() => void sendMessage(chip.message)}
                        >
                          {chip.label}
                        </Button>
                      ))}
                    </div>
                    <p className="mt-4 text-xs">
                      Or type any question — <code>show commands</code>, <code>check channel health</code>, or just ask.
                    </p>
                  </div>
                </div>
              ) : (
                messages.map((msg) => (
                  <MessageRow
                    key={msg.id}
                    msg={msg}
                    isEditing={editingMessageId === msg.id}
                    editValue={editingMessageId === msg.id ? editValue : ""}
                    loading={loading}
                    lastAssistantMessageId={lastAssistantMessageId}
                    onEditStart={handleStartEditMessage}
                    onEditValueChange={setEditValue}
                    onEditEnd={handleEndEditMessage}
                    onSend={sendMessage}
                    onRegenerateAssistant={handleRegenerateAssistant}
                    onPendingPlanSaved={handlePendingPlanSaved}
                  />
                ))
              )}
              {loading && (
                <div className="flex justify-start">
                  <div className="w-full max-w-[86%] space-y-2">
                    <LiveAgentActivity
                      phase={latestTurnStatus?.phase}
                      label={latestTurnStatus?.label}
                      detail={latestTurnStatus?.detail}
                      progressEvents={liveProgressEvents}
                      tools={liveToolCards}
                      isStreaming={Boolean(streamingContent)}
                      reasoningSignals={thinkingContent.length}
                    />
                    {streamingContent ? (
                      <div className="border border-border bg-muted px-4 py-3 shadow-[inset_3px_0_0_var(--terminal-red)]">
                        <StreamingMarkdown content={streamingContent} className="text-foreground" />
                        <span
                          aria-hidden="true"
                          className="ml-0.5 inline-block h-3 w-1.5 -mb-0.5 animate-pulse bg-foreground/70 align-baseline"
                        />
                      </div>
                    ) : null}
                    {liveToolCards.length > 0 && (
                      <div className="space-y-0.5">
                        {liveToolCards.map((card) => (
                          <ToolCallCard key={card.id} {...card} live={card.status === "running"} />
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
              {showJumpToBottom && messages.length > 0 ? (
                <button
                  type="button"
                  onClick={() => {
                    if (scrollRef.current) {
                      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
                      scrollPinnedRef.current = true;
                      userUnpinnedRef.current = false;
                      setScrollPinned(true);
                      setShowJumpToBottom(false);
                    }
                  }}
                  className="absolute bottom-4 right-4 z-10 flex h-8 w-8 items-center justify-center rounded-full border bg-background shadow-md hover:bg-muted transition-colors"
                >
                  <span className="text-sm">↓</span>
                </button>
              ) : null}
            </div>
            {loading ? (
              <div className="flex items-center gap-2 px-3 py-1.5 text-xs bg-muted/30 border-t">
                <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                <span className="text-muted-foreground">
                  {streamingContent ? "Agent is responding..." : "Processing..."}
                </span>
                <div className="ml-auto flex items-center gap-1.5">
                  <Button
                    variant="outline" size="sm" className="h-6 px-2 text-[10px]"
                    onClick={() => {
                      if (input.trim()) {
                        setQueuedDrafts(prev => [...prev, { id: nanoid(), text: input.trim(), createdAt: new Date().toISOString() }].slice(-8));
                        setInput("");
                      }
                    }}
                    disabled={!input.trim()}
                  >
                    Queue
                  </Button>
                  <Button
                    variant="outline" size="sm" className="h-6 px-2 text-[10px]"
                    onClick={() => {
                      const steeringText = input.trim();
                      if (!steeringText) return;
                      setInput("");
                      void sendMessage(steeringText, { force: true });
                    }}
                    disabled={!input.trim()}
                    title="Send this draft as a mid-turn correction"
                  >
                    Steer
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-[10px] text-terminal-red hover:text-terminal-red/80"
                    onClick={async () => {
                      // Cancel the in-flight turn. Works whether or not we have a
                      // latestTurnStatus payload — falls back to the most recent
                      // processing/queued turn for this session.
                      const clientTurnId =
                        latestTurnStatus?.clientTurnId ||
                        sessionTurns.find((t) => t.status === "processing" || t.status === "queued")?.clientTurnId;
                      try {
                        await fetch("/api/channels", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({
                            action: "cancel-turn",
                            clientTurnId,
                            sessionId: currentSession,
                          }),
                        });
                      } catch { /* ignore */ }
                      setLoading(false);
                      setLatestTurnStatus(null);
                      setStreamingContent("");
                    }}
                  >
                    Stop
                  </Button>
                </div>
              </div>
            ) : null}
            <div className="border-t border-terminal-red/20 bg-card/95 p-4 shadow-[0_-12px_28px_rgba(0,0,0,0.18)]">
              {isExternalChannelSession ? (
                <div className="mb-2 rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                  External channel history is read-only here. Use the original channel to reply.
                </div>
              ) : null}
              {chatViewMode === "operator" ? (
              <div className="mb-2 flex flex-wrap items-center gap-2" aria-label="Command shortcuts">
                <span className="text-xs font-medium text-muted-foreground">Shortcuts</span>
                {CHAT_QUICK_COMMANDS.map((entry) => (
                  <Button
                    key={entry.label}
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 rounded-full px-3 text-xs"
                    disabled={loading || isExternalChannelSession}
                    title={entry.title}
                    onClick={() => void sendMessage(entry.message)}
                  >
                    {entry.label}
                  </Button>
                ))}
              </div>
              ) : null}
              {loading && (
                <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  <span>
                    {streamingContent
                      ? "Agent is responding..."
                      : sessionTurns.some((t) => t.status === "processing")
                        ? "Processing tools..."
                        : "Thinking..."}
                  </span>
                </div>
              )}
              {queuedDrafts.length > 0 ? (
                <div className="mb-2 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setShowQueuedDrafts(!showQueuedDrafts)}
                    className="inline-flex items-center gap-1 rounded-full border bg-amber-500/10 border-amber-500/30 px-2.5 py-0.5 text-xs text-amber-400 hover:bg-amber-500/20 transition-colors"
                  >
                    {queuedDrafts.length} queued
                    <span className="ml-0.5">{showQueuedDrafts ? '▾' : '▸'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setQueuedDrafts([])}
                    className="text-[10px] text-muted-foreground hover:text-foreground"
                  >
                    clear
                  </button>
                </div>
              ) : null}
              {showQueuedDrafts && queuedDrafts.length > 0 ? (
                <div className="mb-2 space-y-1 rounded border bg-background px-3 py-2">
                  {queuedDrafts.slice(0, 3).map((draft) => (
                    <div key={draft.id} className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="min-w-0 flex-1 truncate">{draft.text}</span>
                      <button type="button" className="text-[10px] hover:text-foreground" onClick={() => setQueuedDrafts((prev) => prev.filter((item) => item.id !== draft.id))}>Remove</button>
                    </div>
                  ))}
                  {queuedDrafts.length > 3 ? <p className="text-[10px] text-muted-foreground">+{queuedDrafts.length - 3} more</p> : null}
                </div>
              ) : null}
              {pendingAttachments.length > 0 ? (
                <div className="mb-2 flex flex-wrap gap-2">
                  {pendingAttachments.map((file) => (
                    <Badge key={file.id} variant="secondary" className="max-w-full gap-1.5 truncate py-1">
                      {file.mimeType.startsWith("image/") && file.previewUrl ? (
                        <img
                          src={file.previewUrl}
                          alt=""
                          className="h-6 w-6 rounded-sm border object-cover cursor-pointer hover:opacity-90 transition-opacity"
                          onClick={() => setLightboxImage(file.previewUrl || "")}
                        />
                      ) : (
                        <FileUp className="h-3 w-3" />
                      )}
                      <span className="truncate">{file.fileName}</span>
                      <button type="button" className="ml-1 text-muted-foreground hover:text-foreground" onClick={() => setPendingAttachments((c) => c.filter((e) => e.id !== file.id))} title="Remove attachment">
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
              ) : null}
              <div className="relative flex items-end gap-2">
                {mentionSuggestions.length > 0 ? (
                  <div className="absolute bottom-full left-0 right-0 mb-1 rounded-lg bg-popover p-1 shadow-xl ring-1 ring-foreground/10">
                    {mentionSuggestions.map((suggestion, index) => (
                      <button
                        key={suggestion.value}
                        type="button"
                        className={`flex min-h-10 w-full items-center justify-between rounded-md px-3 py-2 text-left text-xs ${index === mentionIndex ? "bg-accent text-accent-foreground" : "text-foreground hover:bg-muted/50"}`}
                        onMouseEnter={() => setMentionIndex(index)}
                        onClick={() => completeMention(suggestion.value)}
                      >
                        <code className="font-mono">{suggestion.label}</code>
                        <span className="ml-3 truncate text-muted-foreground">{suggestion.description}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
                {slashSuggestions.length > 0 ? (
                  <div className="absolute bottom-full left-0 right-0 mb-1 rounded-md border bg-popover p-1 shadow-lg">
                    {slashSuggestions.map((s, i) => (
                      <div
                        key={s.command}
                        className={`flex items-center justify-between rounded px-2 py-1 text-xs cursor-pointer ${i === slashIndex ? "bg-accent text-accent-foreground" : "text-foreground"}`}
                        onClick={() => {
                          const cmd = SLASH_COMMANDS.find((c) => c.command === s.command);
                          if (cmd) {
                            const result = cmd.handler(input);
                            setInput("");
                            setSlashSuggestions([]);
                            if (result) {
                              setMessages((prev) => [
                                ...prev,
                                {
                                  id: nanoid(),
                                  role: "system",
                                  content: result,
                                  sessionId: currentSession || "",
                                  createdAt: new Date().toISOString(),
                                },
                              ]);
                            }
                          }
                        }}
                      >
                        <code className="font-mono">{s.command}</code>
                        <span className="text-muted-foreground">{s.description}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
                <label className="inline-flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-md border bg-background text-muted-foreground hover:text-foreground" title="Attach local file">
                  {uploadingAttachment ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileUp className="h-4 w-4" />}
                  {hydrated ? (
                    <input type="file" className="sr-only" accept="image/*,audio/*,video/*,text/*,application/pdf,application/json,text/csv" disabled={uploadingAttachment || isExternalChannelSession} onChange={(event) => { const file = event.target.files?.[0]; const inputEl = event.currentTarget; if (file) void uploadAttachment(file).finally(() => { inputEl.value = ""; }); }} />
                  ) : null}
                </label>
                <Button variant="outline" size="icon" onClick={() => setLiveSessionOpen(true)} disabled={isExternalChannelSession} title="Open Live Session notes">
                  <Mic className="h-4 w-4" />
                </Button>
                <Button variant={voiceMode ? "default" : "outline"} size="icon" onClick={() => setVoiceMode((v) => !v)} title={voiceMode ? "Disable voice replies" : "Enable voice replies"}>
                  {voiceMode ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
                </Button>
                <textarea
                  value={input}
                  onChange={(e) => {
                    const value = e.target.value;
                    handleComposerChange(value);

                    // Slash command detection
                    if (value.startsWith("/")) {
                      const partial = value.toLowerCase();
                      const matches = SLASH_COMMANDS.filter(
                        (c) => c.command.startsWith(partial) || c.command.includes(partial),
                      );
                      setSlashSuggestions(matches.map((c) => ({ command: c.command, description: c.description })));
                      setSlashIndex(0);
                    } else {
                      setSlashSuggestions([]);
                    }

                    const mentionMatch = value.match(/(?:^|\s)(@[^\s]*)$/);
                    if (mentionMatch) {
                      const query = mentionMatch[1].slice(1).toLowerCase();
                      const contextCandidates = [
                        { value: "@file:", label: "@file:path", description: "Attach a file or line range" },
                        { value: "@folder:", label: "@folder:path", description: "Attach a folder listing" },
                        { value: "@diff ", label: "@diff", description: "Attach the working tree diff" },
                        { value: "@staged ", label: "@staged", description: "Attach the staged diff" },
                        { value: "@git:3 ", label: "@git:N", description: "Attach up to 10 recent workspace commits" },
                        { value: "@url:", label: "@url:https://…", description: "Attach a web page" },
                        ...agents.filter((agent) => agent.isActive !== false).map((agent) => ({ value: `@agent:${agent.id} `, label: `@${agent.name}`, description: "Hand off through the durable agent inbox" })),
                      ];
                      setMentionSuggestions(contextCandidates.filter((candidate) => !query || `${candidate.label} ${candidate.description} ${candidate.value}`.toLowerCase().includes(query)).slice(0, 8));
                      setMentionIndex(0);
                    } else {
                      setMentionSuggestions([]);
                    }

                    e.target.style.height = "auto";
                    e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
                  }}
                  onPaste={(e) => {
                    const imageFiles = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
                    if (imageFiles.length === 0) return;
                    e.preventDefault();
                    for (const file of imageFiles) {
                      void uploadAttachment(file);
                    }
                  }}
                  onKeyDown={(e) => {
                    if (mentionSuggestions.length > 0) {
                      if (e.key === "Tab" || e.key === "Enter") { e.preventDefault(); completeMention(mentionSuggestions[mentionIndex].value); return; }
                      if (e.key === "ArrowDown") { e.preventDefault(); setMentionIndex((index) => Math.min(index + 1, mentionSuggestions.length - 1)); return; }
                      if (e.key === "ArrowUp") { e.preventDefault(); setMentionIndex((index) => Math.max(index - 1, 0)); return; }
                      if (e.key === "Escape") { setMentionSuggestions([]); return; }
                    }
                    if (slashSuggestions.length > 0) {
                      if (e.key === "Tab" || (e.key === "Enter" && slashSuggestions.length === 1)) {
                        e.preventDefault();
                        const cmd = SLASH_COMMANDS.find(
                          (c) => c.command === slashSuggestions[slashIndex].command,
                        );
                        if (cmd) {
                          const result = cmd.handler(input);
                          setInput("");
                          setSlashSuggestions([]);
                          if (result) {
                            setMessages((prev) => [
                              ...prev,
                              {
                                id: nanoid(),
                                role: "system",
                                content: result,
                                sessionId: currentSession || "",
                                createdAt: new Date().toISOString(),
                              },
                            ]);
                          }
                        }
                        return;
                      }
                      if (e.key === "ArrowDown") {
                        e.preventDefault();
                        setSlashIndex((i) => Math.min(i + 1, slashSuggestions.length - 1));
                        return;
                      }
                      if (e.key === "ArrowUp") {
                        e.preventDefault();
                        setSlashIndex((i) => Math.max(i - 1, 0));
                        return;
                      }
                      if (e.key === "Escape") {
                        setSlashSuggestions([]);
                        return;
                      }
                    }

                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      sendMessage();
                    }
                  }}
                  placeholder={readOnlyWatch ? "Read-only watch window" : composerPlaceholder}
                  disabled={composerLocked}
                  rows={1}
                  className="flex-1 resize-none overflow-hidden rounded-md border border-border bg-background px-4 py-3 text-[15px] leading-6 text-foreground shadow-[inset_3px_0_0_hsl(var(--accent-red)/0.45)] placeholder:text-muted-foreground/80 focus-visible:border-terminal-red/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                  style={{ minHeight: "48px", maxHeight: "168px" }}
                />
                <Button className="h-12 w-12 shrink-0" size="icon" onClick={() => sendMessage()} disabled={composerLocked || (!input.trim() && pendingAttachments.length === 0)}>
                  <Send className="h-4 w-4" />
                </Button>
              </div>
              {voiceMode ? <p className="mt-1 text-xs text-muted-foreground">Voice mode: AI replies will be spoken aloud</p> : null}
            </div>
          </div>

          <SessionWorkbenchDynamic
            showWorkbench={showSessionTodo}
            onClose={() => setShowSessionTodo(false)}
            sessionTodos={sessionTodos}
            workbenchTab={workbenchTab}
            onTabChange={setWorkbenchTab}
            currentSession={currentSession}
            activeAgent={activeAgent}
            agentModelLabel={agentModelLabel}
            sessionWorkspacePath={sessionWorkspacePath}
            agentCapabilityLabel={agentCapabilityLabel}
            activeChannelLabel={activeChannelLabel}
            sessionFastMode={sessionFastMode}
            sessionToolMode={sessionToolMode}
            latestPendingPlan={latestPendingPlan}
            workspacePreviewFiles={workspacePreviewFiles}
            sessionObjects={sessionObjects}
            sessionArtifacts={sessionArtifacts}
            recentExecutionBadges={recentExecutionBadges}
            latestRoutingTrace={latestRoutingTrace}
            latestRoutingTraceJson={latestRoutingTraceJson}
            sessionTurns={sessionTurns}
            liveProgressEvents={liveProgressEvents}
            todoInput={todoInput}
            onTodoInputChange={setTodoInput}
            onAddTodo={() => void addTodo()}
            onMutateTodos={mutateSessionTodos}
            promotingTodoId={promotingTodoId}
            onPromoteTodo={(item) => void promoteTodoToBoardTask(item)}
            todos={sessionTodos}
          />
        </div>
        </div>
      </div>
      {mobileSessionOpen ? (
        <>
          <div className="fixed inset-0 z-50 bg-background/60 backdrop-blur-sm md:hidden" onClick={() => setMobileSessionOpen(false)} />
          <div className="fixed inset-y-0 left-0 z-50 w-[min(80vw,300px)] border-r bg-card md:hidden">
            <SessionSidebar
              sessions={sessions}
              teammates={teammates}
              teammatesLoading={teammatesLoading}
              teammateError={teammateError}
              onSelectTeammate={(agentId) => void handleSelectTeammate(agentId)}
              currentSession={currentSession}
              onSelectSession={(id) => { handleSelectSession(id); setMobileSessionOpen(false); }}
              onCreateSession={() => { createSession(); setMobileSessionOpen(false); }}
              onDeleteSession={(id) => { void deleteSession(id); }}
              onExportChat={exportChat}
              renamingSessionId={renamingSessionId}
              renameValue={renameValue}
              onRenameStart={(id, title) => { setRenamingSessionId(id); setRenameValue(title); }}
              onRenameChange={setRenameValue}
              onRenameCommit={() => {
                if (renameValue.trim() && renamingSessionId) {
                  updateSessionTitle(renamingSessionId, renameValue.trim());
                }
                setRenamingSessionId(null);
              }}
              onRenameCancel={() => setRenamingSessionId(null)}
              forceVisible
            />
          </div>
        </>
      ) : null}
      {lightboxImage ? (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 backdrop-blur-sm cursor-pointer"
          onClick={() => setLightboxImage(null)}
        >
          <button
            className="absolute top-4 right-4 rounded-full bg-background/20 p-2 text-white hover:bg-background/40"
            onClick={() => setLightboxImage(null)}
          >
            <X className="h-5 w-5" />
          </button>
          <img
            src={lightboxImage}
            alt=""
            className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
          ) : null}
      <LiveSessionPanelDynamic
        open={liveSessionOpen}
        onOpenChange={setLiveSessionOpen}
        onUseTranscript={(text) => handleComposerChange(text)}
      />
    </>
  );
}
