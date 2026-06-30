"use client";

import React, { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/app/empty-state";
import { SurfaceHeader } from "@/components/app/surface-header";
import { WebChatDraftButton } from "@/components/app/webchat-draft-button";
import { RelatedWorkTrailStrip } from "@/components/work-trails/related-work-trail-strip";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Label } from "@/components/ui/label";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Plus, Play, Trash2, WandSparkles, Upload, Download, Search, Clock, MessageSquare, Radio, Wand2, Pencil, ClipboardList, AlertTriangle, CheckCircle2, FileText, Copy, RotateCcw, MoreHorizontal } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { APP_TTL, cachedJson, invalidateCache } from "@/lib/client/app-data-cache";
import { useAfterUseful } from "@/lib/client/use-after-useful";
import type { Workflow } from "@/types/workflow";
import { listWorkflowTemplateCatalog } from "@/lib/workflows/template-catalog";
import { WORKFLOW_TEMPLATE_DESCRIPTIONS } from "@/lib/workflows/template-recommendations";

import { RunList as DynamicRunList } from "@/components/dynamic-workflows/run-list";

type WorkflowCard = Workflow & {
  sourceType?: string | null;
  sourceRef?: string | null;
  description: string | null;
  lastExecution?: {
    id: string;
    status: string;
    triggerType: string;
    triggerData?: Record<string, unknown> | null;
    startedAt: string;
    completedAt: string | null;
  } | null;
};
import { GoogleSetupDialog } from "@/components/workflow/google-setup-dialog";

type WorkflowDebuggerData = {
  workflow: { id: string; name: string; nodeCount: number; edgeCount: number };
  trace: {
    totals: { nodeCount: number; failedCount: number; totalDurationMs: number; totalCostUsd: number; totalTokens: number };
    bottlenecks: Array<{ nodeId: string; nodeName: string | null; nodeType: string; durationMs: number | null; status: string }>;
    failures: Array<{ nodeId: string; nodeName: string | null; nodeType: string; error: Record<string, unknown> | null }>;
  };
  credentialHealth: {
    summary: { ok: number; missing: number; untested: number; notRequired: number };
    items: Array<{ nodeId: string; nodeName: string; nodeType: string; status: string; message: string; serviceType?: string | null }>;
  };
  nodeConfig: Array<{ nodeId: string; nodeType: string; valid: boolean; missingFields: string[]; warnings: string[] }>;
  latestFailures: Array<{ trace: { nodeId: string; nodeName: string | null }; repair: { suggestions: string[] } | null }>;
  recoveryPlan?: {
    title: string;
    summary: string;
    priority: "low" | "medium" | "high";
    actions: string[];
    prompt: string;
    evidence: string[];
  };
};

type TemplateAgentSlot = {
  roleKey: string;
  label: string;
  description: string;
};

type WorkflowTemplate = {
  key: string;
  name: string;
  description: string;
  category: "starter" | "google" | "ops" | "productivity" | "data" | "research";
  requiresGoogle?: boolean;
  tags?: string[];
  nodeHints?: string[];
  complexity?: "simple" | "medium" | "complex";
  trigger?: "manual" | "message" | "cron" | "webhook";
  agentSlots?: TemplateAgentSlot[];
};

type TagLite = {
  id: string;
  name: string;
  color: string;
};

type AgentOption = {
  id: string;
  name: string;
  isActive: boolean;
  isDefault: boolean;
};

type OrganizationOption = {
  id: string;
  name: string;
  isActive: boolean;
};

type GoalOption = {
  id: string;
  name: string;
  organizationId: string | null;
};

type DocumentSourceContext = {
  id: string;
  name: string;
  sourceType: "upload" | "scrape" | "integration";
  sourceUrl: string | null;
  excerpt?: string;
};

const COMPLEXITY_COLORS: Record<string, string> = {
  simple: "text-green-400",
  medium: "text-yellow-400",
  complex: "text-red-400",
};

type TemplateIntent = {
  key: string;
  label: string;
  match: RegExp;
  keys?: string[];
};

const INTENTS: TemplateIntent[] = [
  {
    key: "chat",
    label: "Answer chat messages",
    match: /simple chat|channel workspace|webchat|conversation|receive message/i,
    keys: ["simple-chat", "channel-workspace-assistant", "integration-agent-bridge"],
  },
  { key: "tasks", label: "Create/route tasks", match: /task|board|ticket|track|follow|approval/i },
  { key: "monitor", label: "Monitor or report", match: /monitor|report|watch|alert|check|status|health/i },
  { key: "overnight", label: "Morning brief", match: /overnight|morning|brief|sleep|autonomy|wake/i, keys: ["overnight-autonomy-briefing", "ops-control-tower"] },
  { key: "connect", label: "Connect two apps", match: /connect|integrat|bridge|send.*channel|telegram|discord|slack/i },
  { key: "data", label: "Process documents/data", match: /document|data|scrape|crawl|extract|json|csv|pdf|file/i },
  { key: "schedule", label: "Run scheduled work", match: /schedule|cron|daily|weekly|recurring|timer/i },
];

const TRIGGER_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  manual: Wand2,
  message: MessageSquare,
  cron: Clock,
  webhook: Radio,
};

const FEATURED_TEMPLATE_CATALOG: WorkflowTemplate[] = [
  {
    key: "simple-chat",
    name: "Simple Chat Assistant",
    description: "Basic workflow: receive message, process with AI agent, reply via WebChat.",
    category: "starter",
    tags: ["starter", "chat"],
    nodeHints: ["message-trigger", "claude-agent", "send-webchat"],
    complexity: "simple",
    trigger: "message",
  },
  {
    key: "channel-workspace-assistant",
    name: "Channel Workspace Assistant",
    description:
      "Cross-channel general assistant for Telegram, WhatsApp, Slack, Teams, Discord, BlueBubbles, Google Chat, and WebChat. Handles random requests, task management, documents, workflows, and schedules with tools.",
    category: "starter",
    tags: ["channels", "assistant", "tools"],
    nodeHints: ["message-trigger", "claude-agent", "send-webchat"],
    complexity: "medium",
    trigger: "message",
  },
  {
    key: "gmail-drive-bridge",
    name: "Google Workspace Bridge (Gmail/Drive)",
    description: "Receives Gmail/Drive events via webhook, enriches with memory, and drafts responses.",
    category: "google",
    requiresGoogle: true,
    tags: ["google", "gmail", "drive"],
    nodeHints: ["webhook-trigger", "claude-agent", "memory-store"],
    complexity: "medium",
    trigger: "webhook",
  },
  {
    key: "pc-specs-tool-use",
    name: "Local PC Specs Assistant",
    description: "Uses local system tools to inspect CPU, RAM, storage, and workspace files before answering.",
    category: "ops",
    tags: ["ops", "system"],
    nodeHints: ["system-command", "claude-agent", "send-webchat"],
    complexity: "simple",
    trigger: "message",
  },
  {
    key: "devops-monitor",
    name: "DevOps System Monitor",
    description: "Agent with bash, system info, and file tools; stores findings in memory automatically.",
    category: "ops",
    tags: ["ops", "monitoring"],
    nodeHints: ["claude-agent", "memory-store", "send-webchat"],
    complexity: "medium",
    trigger: "message",
  },
  {
    key: "smart-command-runner",
    name: "Smart Command Runner",
    description: "Full system access agent with tool-use and model-based approval for risky operations.",
    category: "ops",
    tags: ["ops", "security"],
    nodeHints: ["claude-agent", "if-else", "send-webchat"],
    complexity: "medium",
    trigger: "message",
  },
  {
    key: "scheduled-health-check",
    name: "Scheduled Health Check",
    description: "Cron-triggered system check with code analysis and if-else branching for alerts.",
    category: "ops",
    tags: ["cron", "monitoring"],
    nodeHints: ["cron-trigger", "run-code", "if-else", "send-webchat"],
    complexity: "medium",
    trigger: "cron",
  },
  {
    key: "cron-board-task-creator",
    name: "Cron Board Task Creator",
    description: "Runs every 2 minutes: generates a timestamped task via run-code, POSTs it to the board via HTTP request, then notifies WebChat. End-to-end cron → board → chat example.",
    category: "ops",
    tags: ["cron", "boards", "automation"],
    nodeHints: ["cron-trigger", "run-code", "http-request", "send-webchat"],
    complexity: "medium",
    trigger: "cron",
  },
  {
    key: "google-api-integration",
    name: "Google API Integration (Gmail + Drive)",
    description: "Agent with http_request tool and set-variables for Google API endpoints.",
    category: "google",
    requiresGoogle: true,
    tags: ["google", "gmail", "drive"],
    nodeHints: ["message-trigger", "set-variables", "claude-agent"],
    complexity: "medium",
    trigger: "message",
  },
  {
    key: "integration-agent-bridge",
    name: "Integration Agent Bridge",
    description: "Message or manual trigger -> generic integration agent -> WebChat. Use when you need an unsupported API or SaaS and still want the workflow to continue cleanly.",
    category: "starter",
    tags: ["agent", "api", "integration"],
    nodeHints: ["manual-trigger", "message-trigger", "claude-agent", "send-webchat"],
    complexity: "simple",
    trigger: "message",
  },
  {
    key: "hierarchy-orchestrator-team",
    name: "Hierarchy Team: Orchestrator + 2 Workers",
    description:
      "Uses one orchestrator agent to plan/delegate, two worker agents to execute research subtasks in parallel, then orchestrator to produce final output.",
    category: "productivity",
    tags: ["hierarchy", "agents", "delegation"],
    nodeHints: ["manual-trigger", "claude-agent", "parallel-agents", "merge"],
    complexity: "complex",
    trigger: "manual",
    agentSlots: [
      {
        roleKey: "orchestrator",
        label: "Orchestrator Agent",
        description: "Leads planning and final synthesis.",
      },
      {
        roleKey: "workerA",
        label: "Worker A Agent",
        description: "Executes TASK_A assigned by orchestrator.",
      },
      {
        roleKey: "workerB",
        label: "Worker B Agent",
        description: "Executes TASK_B assigned by orchestrator.",
      },
    ],
  },
  {
    key: "code-runner-pipeline",
    name: "Code Runner Pipeline",
    description: "Data pipeline with set-variables, run-code, branching, and conditional AI analysis.",
    category: "data",
    tags: ["data", "pipeline"],
    nodeHints: ["set-variables", "run-code", "if-else", "claude-agent"],
    complexity: "medium",
    trigger: "manual",
  },
  {
    key: "file-processor",
    name: "File Processor Pipeline",
    description: "Read file, transform with code, write output. Pure data pipeline without AI node.",
    category: "data",
    tags: ["data", "files"],
    nodeHints: ["read-file", "run-code", "write-file"],
    complexity: "simple",
    trigger: "manual",
  },
  {
    key: "api-monitor",
    name: "API Monitor with Alerts",
    description: "Cron-triggered API health monitor with code evaluation, alerts, and memory logging.",
    category: "ops",
    tags: ["ops", "api", "cron"],
    nodeHints: ["cron-trigger", "http-request", "run-code", "if-else", "memory-store"],
    complexity: "medium",
    trigger: "cron",
  },
  {
    key: "email-summarizer",
    name: "Email Summarizer",
    description: "Fetches and summarizes your 5 most recent emails via Gmail API using http_request.",
    category: "google",
    requiresGoogle: true,
    tags: ["google", "gmail", "email"],
    nodeHints: ["manual-trigger", "http-request", "claude-agent", "send-webchat"],
    complexity: "medium",
    trigger: "manual",
  },
  {
    key: "daily-email-digest",
    name: "Daily Email Digest",
    description: "8am cron digest for yesterday's emails, summarized and stored in memory.",
    category: "google",
    requiresGoogle: true,
    tags: ["google", "gmail", "cron"],
    nodeHints: ["cron-trigger", "http-request", "claude-agent", "memory-store"],
    complexity: "medium",
    trigger: "cron",
  },
  {
    key: "smart-file-organizer",
    name: "Smart File Organizer",
    description: "Reads, categorizes, and organizes files using list/read/bash tools.",
    category: "productivity",
    tags: ["files", "automation"],
    nodeHints: ["system-command", "claude-agent", "archive"],
    complexity: "medium",
    trigger: "manual",
  },
  {
    key: "code-reviewer",
    name: "Code Reviewer",
    description: "Paste a file path and get a structured review with severity and security checks.",
    category: "productivity",
    tags: ["code", "review"],
    nodeHints: ["webhook-trigger", "claude-agent", "send-webchat"],
    complexity: "simple",
    trigger: "webhook",
  },
  {
    key: "research-assistant",
    name: "Research Assistant",
    description: "Memory-aware agent that searches the web and prior memory for better answers.",
    category: "productivity",
    tags: ["research", "memory"],
    nodeHints: ["manual-trigger", "memory-recall", "claude-agent", "memory-store"],
    complexity: "medium",
    trigger: "manual",
  },
  {
    key: "local-lead-enrichment",
    name: "Local Lead Enrichment",
    description:
      "Public-web lead research workflow that searches, verifies company/person context, writes an evidence-backed local report, and creates a board follow-up.",
    category: "research",
    tags: ["lead", "research", "browser", "boards"],
    nodeHints: ["manual-trigger", "claude-agent", "write-file", "board-task", "send-webchat"],
    complexity: "medium",
    trigger: "manual",
  },
  {
    key: "docs-site-crawler-summary",
    name: "Docs Site Crawler + Summary",
    description:
      "Crawls any docs website (auto/static/dynamic strategy), stores it in Data Sources, then summarizes key concepts with LLM.",
    category: "data",
    tags: ["crawl", "docs", "summary", "llm"],
    nodeHints: ["http-request", "claude-agent", "document-tool", "memory-store"],
    complexity: "complex",
    trigger: "manual",
  },
  {
    key: "document-intelligence",
    name: "Document Intelligence",
    description:
      "Uses document tools to inspect uploaded PDFs and scraped pages, summarize them, compare them, and store reusable findings in memory.",
    category: "data",
    tags: ["documents", "pdf", "scrape", "memory"],
    nodeHints: ["document-tool", "claude-agent", "memory-store"],
    complexity: "medium",
    trigger: "manual",
  },
  {
    key: "ops-control-tower",
    name: "Ops Control Tower",
    description:
      "Large multi-node operational briefing that pulls channel status, schedules, documents, board scope, templates, council output, DB counts, file output, and memory storage into one report.",
    category: "ops",
    tags: ["ops", "boards", "hierarchy", "council", "reporting"],
    nodeHints: ["channel-status", "scheduler-job", "board-task", "council", "database-query", "write-file", "memory-store"],
    complexity: "complex",
    trigger: "manual",
  },
  {
    key: "hierarchy-board-briefing",
    name: "Hierarchy Board Briefing",
    description:
      "Hierarchy-aware board workflow that reads scoped tasks, creates a follow-up task, reviews channels and schedules, runs council, writes a briefing report, and stores it in memory.",
    category: "productivity",
    tags: ["hierarchy", "boards", "council", "reporting"],
    nodeHints: ["board-task", "council", "write-file", "memory-store", "send-webchat"],
    complexity: "complex",
    trigger: "manual",
  },
  {
    key: "overnight-autonomy-briefing",
    name: "Overnight Autonomy Briefing",
    description:
      "Daily morning brief for unattended runs: checks background jobs, wakeups, approvals, schedules, boards, memory, WebChat, and Telegram delivery.",
    category: "ops",
    tags: ["overnight", "morning", "telegram", "approvals"],
    nodeHints: ["cron-trigger", "database-query", "claude-agent", "memory-store", "send-telegram"],
    complexity: "complex",
    trigger: "cron",
  },
  {
    key: "automated-backup",
    name: "Automated Backup Monitor",
    description: "Daily cron checks disk usage and alerts when space is critically low.",
    category: "ops",
    tags: ["backup", "cron", "ops"],
    nodeHints: ["cron-trigger", "system-command", "if-else", "send-webchat"],
    complexity: "simple",
    trigger: "cron",
  },
  {
    key: "multi-channel-router",
    name: "Multi-Channel Router",
    description: "Routes messages by channel source with different response styles per channel.",
    category: "starter",
    tags: ["routing", "channels"],
    nodeHints: ["message-trigger", "if-else", "send-webchat", "send-telegram"],
    complexity: "medium",
    trigger: "message",
  },
  {
    key: "telegram-board-intake",
    name: "Channel Board Assistant (Task Intake + List)",
    description:
      "Works with Telegram/WhatsApp/Discord/WebChat/Google Chat. Ask in plain English to add board tasks, list inbox work, run a task, or use a named workflow like 'use Channel Board Assistant v2 to list tasks'.",
    category: "ops",
    tags: ["channels", "boards", "intake", "tasks"],
    nodeHints: ["message-trigger", "claude-agent", "board-task", "send-webchat"],
    complexity: "medium",
    trigger: "message",
  },
  {
    key: "general-task-executor",
    name: "General Task Executor",
    description:
      "Turns a plain board task into an executable tool-using workflow so random tasks can actually run instead of only changing status.",
    category: "productivity",
    tags: ["boards", "executor", "tools"],
    nodeHints: ["manual-trigger", "claude-agent", "board-task"],
    complexity: "medium",
    trigger: "manual",
  },
  {
    key: "screenshot-analyzer",
    name: "Screenshot Analyzer",
    description: "Captures a screenshot and analyzes visible apps/errors using vision.",
    category: "productivity",
    tags: ["vision", "desktop"],
    nodeHints: ["manual-trigger", "claude-agent", "send-webchat"],
    complexity: "simple",
    trigger: "manual",
  },
  {
    key: "git-status-reporter",
    name: "Git Status Reporter",
    description: "Periodic git status checks and change summaries.",
    category: "ops",
    tags: ["git", "cron"],
    nodeHints: ["cron-trigger", "git-operation", "claude-agent", "send-webchat"],
    complexity: "simple",
    trigger: "cron",
  },
  {
    key: "local-api-tester",
    name: "Local API Tester",
    description: "Tests local API endpoints and generates a result report.",
    category: "data",
    tags: ["api", "testing"],
    nodeHints: ["http-request", "run-code", "memory-store"],
    complexity: "medium",
    trigger: "manual",
  },
  {
    key: "clipboard-to-memory",
    name: "Clipboard to Memory",
    description: "Reads clipboard content, categorizes it, and stores it in memory.",
    category: "productivity",
    tags: ["clipboard", "memory"],
    nodeHints: ["manual-trigger", "clipboard", "claude-agent", "memory-store"],
    complexity: "simple",
    trigger: "manual",
  },
  {
    key: "error-resilient-pipeline",
    name: "Error-Resilient Pipeline",
    description: "Cron pipeline with error handler: failures to alerts, success to AI + memory.",
    category: "ops",
    tags: ["error-handling", "cron"],
    nodeHints: ["cron-trigger", "error-handler", "claude-agent", "memory-store"],
    complexity: "medium",
    trigger: "cron",
  },
  {
    key: "text-processing-pipeline",
    name: "Text Processing Pipeline",
    description: "Reads a doc, chunks it, transforms data, and analyzes content with AI.",
    category: "data",
    tags: ["text", "pipeline"],
    nodeHints: ["read-file", "split-text", "json-transform", "claude-agent", "aggregate"],
    complexity: "medium",
    trigger: "manual",
  },
  {
    key: "db-query-dashboard",
    name: "Database Query Dashboard",
    description: "Queries disp8ch SQLite stats and formats a readable dashboard.",
    category: "data",
    tags: ["database", "analytics"],
    nodeHints: ["cron-trigger", "database-query", "json-transform", "send-webchat"],
    complexity: "simple",
    trigger: "cron",
  },
];

const featuredTemplateKeys = new Set(FEATURED_TEMPLATE_CATALOG.map((template) => template.key));

function catalogTemplateDefaults(key: string): Pick<WorkflowTemplate, "category" | "complexity" | "trigger" | "tags" | "nodeHints"> {
  const research = /research|paper|competitor|trading|experiment|strategy/.test(key);
  const data = /docs|document|dependency/.test(key);
  const productivity = /video|subconscious|support-signal/.test(key);
  const cron = /scheduler|detector|scanner|verifier|correlator|watch|watcher|digest|subconscious|trading|experiment/.test(key);
  const webhook = /pull-request/.test(key);
  const complex = /autonomous|crew|subconscious|video|trading|strategy/.test(key);
  return {
    category: research ? "research" : data ? "data" : productivity ? "productivity" : "ops",
    complexity: complex ? "complex" : "medium",
    trigger: webhook ? "webhook" : cron ? "cron" : "manual",
    tags: key.split("-").slice(0, 4),
    nodeHints: webhook
      ? ["webhook-trigger", "claude-agent", "send-webchat"]
      : cron
        ? ["cron-trigger", "claude-agent", "send-webchat"]
        : ["manual-trigger", "claude-agent", "send-webchat"],
  };
}

const TEMPLATE_CATALOG: WorkflowTemplate[] = [
  ...FEATURED_TEMPLATE_CATALOG,
  ...listWorkflowTemplateCatalog()
    .filter((entry) => !featuredTemplateKeys.has(entry.key))
    .map((entry) => ({
      key: entry.key,
      name: entry.name,
      description: WORKFLOW_TEMPLATE_DESCRIPTIONS[entry.key] ?? `Ready-to-use ${entry.name} workflow template.`,
      ...catalogTemplateDefaults(entry.key),
    })),
];

type WorkflowViewTab = "mine" | "templates" | "executions" | "runs";
type WorkflowQuickFilter = "all" | "failed" | "cron" | "message" | "imported" | "needs-setup";

type WorkflowActionNotice = {
  tone: "success" | "error";
  message: string;
};

type WorkflowExecutionListItem = {
  id: string;
  workflowId: string;
  workflowName: string;
  status: string;
  triggerType: string;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  errorSummary: string | null;
};

type QueuedExecutionItem = {
  id: string;
  workflowId: string;
  workflowName: string;
  triggerType: string;
  status: string;
  enqueuedAt: string;
  concurrency?: { mode: string; maxConcurrent: number };
};

const WORKFLOWS_UI_STATE_KEY = "disp8ch:workflows-ui";

function readWorkflowsUiState(): { hideGettingStarted?: boolean } {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(WORKFLOWS_UI_STATE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as { hideGettingStarted?: boolean };
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeWorkflowsUiState(patch: { hideGettingStarted?: boolean }) {
  if (typeof window === "undefined") return;
  const current = readWorkflowsUiState();
  window.localStorage.setItem(
    WORKFLOWS_UI_STATE_KEY,
    JSON.stringify({
      ...current,
      ...patch,
    }),
  );
}

function WorkflowsPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [workflows, setWorkflows] = useState<WorkflowCard[]>([]);
  const [runningWorkflowId, setRunningWorkflowId] = useState<string | null>(null);
  const [creatingTaskForWorkflowId, setCreatingTaskForWorkflowId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<WorkflowViewTab>("templates");
  const [executions, setExecutions] = useState<WorkflowExecutionListItem[]>([]);
  const [executionStatusFilter, setExecutionStatusFilter] = useState("");
  const [retryingExecutionId, setRetryingExecutionId] = useState<string | null>(null);
  const [queuedItems, setQueuedItems] = useState<QueuedExecutionItem[]>([]);
  const [deletingQueueId, setDeletingQueueId] = useState<string | null>(null);
  const [creatingTemplateKey, setCreatingTemplateKey] = useState<string | null>(null);
  const [deletingWorkflowId, setDeletingWorkflowId] = useState<string | null>(null);
  const [resettingAll, setResettingAll] = useState(false);
  const [workflowTags, setWorkflowTags] = useState<Record<string, TagLite[]>>({});
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [loadingAgents, setLoadingAgents] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerTemplate, setPickerTemplate] = useState<WorkflowTemplate | null>(null);
  const [templateAgents, setTemplateAgents] = useState<Record<string, string>>({});
  const [organizations, setOrganizations] = useState<OrganizationOption[]>([]);
  const [goals, setGoals] = useState<GoalOption[]>([]);
  const [selectedTemplateOrganizationId, setSelectedTemplateOrganizationId] = useState("");
  const [selectedTemplateGoalId, setSelectedTemplateGoalId] = useState("");
  const [selectedSourceDocument, setSelectedSourceDocument] = useState<DocumentSourceContext | null>(null);
  const [workflowFilterOrganizationId, setWorkflowFilterOrganizationId] = useState("");
  const [workflowFilterGoalId, setWorkflowFilterGoalId] = useState("");
  const [workflowQuickFilter, setWorkflowQuickFilter] = useState<WorkflowQuickFilter>("all");
  const [templateSearch, setTemplateSearch] = useState("");
  // Show the complete catalog first. Intent chips are opt-in shortcuts, not
  // an invisible default filter that hides most templates from new users.
  const [templateIntent, setTemplateIntent] = useState<string | null>(null);
  const [templateCategory, setTemplateCategory] = useState<WorkflowTemplate["category"] | "all">("all");
  const [importOpen, setImportOpen] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importName, setImportName] = useState("");
  const [importError, setImportError] = useState("");
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ stats?: { total: number; mapped: number; unsupported: number }; warnings?: string[]; workflowId?: string } | null>(null);
  const [importWarningsExpanded, setImportWarningsExpanded] = useState(false);
  const [actionNotice, setActionNotice] = useState<WorkflowActionNotice | null>(null);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [generateDesc, setGenerateDesc] = useState("");
  const [generateName, setGenerateName] = useState("");
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState("");
  const [hideGettingStarted, setHideGettingStarted] = useState(false);
  const [resetAllOpen, setResetAllOpen] = useState(false);
  const [deleteWorkflowTarget, setDeleteWorkflowTarget] = useState<WorkflowCard | null>(null);
  const [agentRequiredTemplate, setAgentRequiredTemplate] = useState<WorkflowTemplate | null>(null);
  const [debuggerOpen, setDebuggerOpen] = useState(false);
  const [debuggerLoading, setDebuggerLoading] = useState(false);
  const [debuggerData, setDebuggerData] = useState<WorkflowDebuggerData | null>(null);
  const [debuggerError, setDebuggerError] = useState("");
  // Credential configure-wizard (Gap 4): inline fix form inside the Inspector.
  const [credFixNodeId, setCredFixNodeId] = useState<string | null>(null);
  const [credFixForm, setCredFixForm] = useState<{ name: string; serviceType: string; secret: string }>({ name: "", serviceType: "", secret: "" });
  const [credFixSaving, setCredFixSaving] = useState(false);
  const [credFixError, setCredFixError] = useState("");
  // Lazy per-card health summary (missing creds, config warnings, last run) —
  // loaded after first paint to avoid slowing the workflow list render.
  const [cardHealth, setCardHealth] = useState<Record<string, { missing: number; warnings: number; lastStatus: string | null }>>({});
  const cardHealthFetched = useRef<Set<string>>(new Set());

  const fetchAgents = useCallback(async (): Promise<AgentOption[]> => {
    setLoadingAgents(true);
    try {
      const json = await cachedJson<any>("agents", "/api/agents", APP_TTL.agents);
      if (!json.success || !json.data?.agents) return [];
      const list = (json.data.agents as AgentOption[]).filter((agent) => agent.isActive);
      setAgents(list);
      return list;
    } catch {
      return [];
    } finally {
      setLoadingAgents(false);
    }
  }, []);

  const loadWorkflowTags = useCallback((workflowIds: string[]) => {
    const uniqueIds = Array.from(new Set(workflowIds.map((value) => value.trim()).filter(Boolean)));
    if (uniqueIds.length === 0) {
      setWorkflowTags({});
      return;
    }
    fetch(`/api/tags/links?targetType=workflow&targetIds=${encodeURIComponent(uniqueIds.join(","))}`)
      .then((r) => r.json())
      .then((json) => {
        if (!json.success || !json.data) return;
        setWorkflowTags(json.data as Record<string, TagLite[]>);
      })
      .catch(() => {});
  }, []);

  const fetchWorkflows = useCallback(() => {
    cachedJson<any>("workflows", "/api/workflows", APP_TTL.workflows)
      .then((data) => {
        if (!data.success) return;
        const next = data.data as WorkflowCard[];
        setWorkflows(next);
        loadWorkflowTags(next.map((workflow) => workflow.id));
      })
      .catch(() => {});
  }, [loadWorkflowTags]);

  const fetchExecutions = useCallback(() => {
    const params = new URLSearchParams();
    if (executionStatusFilter) params.set("status", executionStatusFilter);
    params.set("limit", "100");
    fetch(`/api/workflows/executions?${params.toString()}`)
      .then((response) => response.json())
      .then((json) => {
        if (json.success) setExecutions(json.data as WorkflowExecutionListItem[]);
      })
      .catch(() => {});
    fetch("/api/workflows/queue")
      .then((response) => response.json())
      .then((json) => {
        if (json.success) setQueuedItems(json.data as QueuedExecutionItem[]);
      })
      .catch(() => {});
  }, [executionStatusFilter]);

  const deleteQueuedItem = async (id: string) => {
    setDeletingQueueId(id);
    try {
      const response = await fetch(`/api/workflows/queue?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      const json = await response.json();
      if (json.success) setQueuedItems((current) => current.filter((item) => item.id !== id));
    } catch {
      // refresh keeps state honest on failure
    } finally {
      setDeletingQueueId(null);
    }
  };

  const runWorkflow = async (workflow: WorkflowCard) => {
    setRunningWorkflowId(workflow.id);
    setActionNotice(null);
    try {
      const res = await fetch("/api/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflowId: workflow.id,
          triggerType: "manual",
          triggerData: { source: "workflows-card-run" },
        }),
      });
      const json = await res.json();
      if (!json.success) {
        setActionNotice({ tone: "error", message: `Run failed for "${workflow.name}": ${json.error || "unknown error"}` });
        return;
      }
      setActionNotice({ tone: "success", message: `Started "${workflow.name}". Last-run badges will update after execution completes.` });
      // Refresh so lastExecution badge updates
      invalidateCache(/^workflows/);
      fetchWorkflows();
    } catch (error) {
      setActionNotice({ tone: "error", message: `Run failed for "${workflow.name}": ${String(error)}` });
    } finally {
      setRunningWorkflowId(null);
    }
  };

  const createFollowUpTask = async (workflow: WorkflowCard) => {
    setCreatingTaskForWorkflowId(workflow.id);
    setActionNotice(null);
    try {
      const res = await fetch("/api/boards/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: `Follow-up: ${workflow.name}`.slice(0, 160),
          description: `Follow-up task for workflow ${workflow.name}${workflow.description ? ` — ${workflow.description}` : ""}`.slice(0, 1200),
          workflowId: workflow.id,
          organizationId: workflow.organizationId || undefined,
          goalId: workflow.goalId || undefined,
          status: "inbox",
          priority: "medium",
        }),
      });
      const json = await res.json();
      if (!json.success) {
        setActionNotice({ tone: "error", message: `Failed to create follow-up task for "${workflow.name}": ${json.error || "unknown error"}` });
        return;
      }
      setActionNotice({ tone: "success", message: `Follow-up task created for "${workflow.name}". Open Boards to triage it.` });
      invalidateCache(/^boards/);
    } catch (error) {
      setActionNotice({ tone: "error", message: `Failed to create follow-up task for "${workflow.name}": ${String(error)}` });
    } finally {
      setCreatingTaskForWorkflowId(null);
    }
  };

  // Defer full /api/workflows fetch behind useful-ready + idle so the workflows
  // tab can paint its templates panel from cached state without waiting on the
  // slow workflows list query.
  useAfterUseful(() => {
    fetchWorkflows();
  }, [fetchWorkflows]);

  useAfterUseful(() => {
    fetchExecutions();
  }, [fetchExecutions]);

  useEffect(() => {
    const saved = readWorkflowsUiState();
    setHideGettingStarted(Boolean(saved.hideGettingStarted));
  }, []);

  useEffect(() => {
    writeWorkflowsUiState({ hideGettingStarted });
  }, [hideGettingStarted]);

  useEffect(() => {
    const requestedTemplate = String(searchParams.get("template") || "").trim();
    if (requestedTemplate) {
      setActiveTab("templates");
    }
  }, [searchParams]);

  useEffect(() => {
    const documentId = String(searchParams.get("documentId") || "").trim();
    if (!documentId) {
      setSelectedSourceDocument(null);
      return;
    }
    fetch(`/api/documents/${encodeURIComponent(documentId)}`)
      .then((response) => response.json())
      .then((json) => {
        if (!json?.success) return;
        setSelectedSourceDocument(json.data as DocumentSourceContext);
      })
      .catch(() => {});
  }, [searchParams]);

  // Defer hierarchy/orgs + goals behind useful-ready — they're only needed once
  // the user opens the Templates panel filters.
  useAfterUseful(() => {
    cachedJson<any>("hierarchy/organizations", "/api/hierarchy/organizations", APP_TTL["hierarchy/organizations"])
      .then((json) => {
        if (!json.success) return;
        const next = (json.data?.organizations ?? []) as OrganizationOption[];
        setOrganizations(next);
        const activeId = String(json.data?.activeOrganizationId ?? next.find((item) => item.isActive)?.id ?? "");
        setSelectedTemplateOrganizationId((current) => current || activeId);
      })
      .catch(() => {});
    cachedJson<any>("hierarchy/goals", "/api/hierarchy/goals", APP_TTL["hierarchy/goals"])
      .then((json) => {
        if (!json.success) return;
        setGoals((json.data ?? []) as GoalOption[]);
      })
      .catch(() => {});
  }, []);

  const organizationById = new Map(organizations.map((item) => [item.id, item.name]));
  const goalById = new Map(goals.map((item) => [item.id, item.name]));
  const templateGoals = goals.filter((goal) => !selectedTemplateOrganizationId || goal.organizationId === selectedTemplateOrganizationId);
  const workflowHasCronTrigger = (workflow: WorkflowCard) =>
    Array.isArray(workflow.nodes) && workflow.nodes.some((node) => node?.type === "cron-trigger");
  const workflowHasMessageTrigger = (workflow: WorkflowCard) =>
    Array.isArray(workflow.nodes) && workflow.nodes.some((node) => node?.type === "message-trigger");
  const workflowIsImported = (workflow: WorkflowCard) =>
    String(workflow.sourceType || "").includes("import");
  const workflowNeedsSetup = (workflow: WorkflowCard) =>
    Array.isArray(workflow.nodes) && workflow.nodes.some((node) => {
      const type = String(node?.type || "");
      if (type === "placeholder") return true;
      if (["google-sheets", "notion", "airtable"].includes(type)) return true;
      if (["send-telegram", "send-discord", "send-whatsapp", "send-slack", "send-bluebubbles", "send-teams"].includes(type)) return true;
      return false;
    });
  const workflowLastFailed = (workflow: WorkflowCard) => {
    const status = String(workflow.lastExecution?.status || "").toLowerCase();
    return ["failed", "error"].includes(status);
  };
  const scopedWorkflows = workflows.filter((workflow) => {
    if (workflowFilterOrganizationId && workflow.organizationId !== workflowFilterOrganizationId) return false;
    if (workflowFilterGoalId && workflow.goalId !== workflowFilterGoalId) return false;
    return true;
  });
  const filteredWorkflows = scopedWorkflows.filter((workflow) => {
    switch (workflowQuickFilter) {
      case "failed": return workflowLastFailed(workflow);
      case "cron": return workflowHasCronTrigger(workflow);
      case "message": return workflowHasMessageTrigger(workflow);
      case "imported": return workflowIsImported(workflow);
      case "needs-setup": return workflowNeedsSetup(workflow);
      case "all":
      default: return true;
    }
  });

  // Lazily load a compact health summary for the user's workflow cards after
  // first paint. Cached per workflow so the list never blocks on debugger calls.
  const cardHealthSignature = activeTab === "mine" ? filteredWorkflows.map((w) => w.id).join(",") : "";
  useEffect(() => {
    if (activeTab !== "mine") return;
    const ids = cardHealthSignature.split(",").filter((id) => id && !cardHealthFetched.current.has(id)).slice(0, 40);
    if (ids.length === 0) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      for (const id of ids) {
        if (cancelled) break;
        cardHealthFetched.current.add(id);
        try {
          const res = await fetch(`/api/workflows/debugger?workflowId=${encodeURIComponent(id)}`);
          const json = await res.json() as { success?: boolean; data?: {
            credentialHealth?: { summary?: { missing?: number } };
            nodeConfig?: Array<{ valid?: boolean; warnings?: string[] }>;
            trace?: { traces?: Array<{ status?: string }> };
          } };
          if (!json.success || !json.data) continue;
          const d = json.data;
          const missing = d.credentialHealth?.summary?.missing ?? 0;
          const warnings = (d.nodeConfig ?? []).filter((n) => n.valid === false || (n.warnings?.length ?? 0) > 0).length;
          const traces = d.trace?.traces ?? [];
          const lastStatus = traces.length === 0 ? null : traces.some((t) => t.status === "failed") ? "failed" : "completed";
          if (!cancelled) setCardHealth((prev) => ({ ...prev, [id]: { missing, warnings, lastStatus } }));
        } catch { /* best effort */ }
      }
    }, 500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [cardHealthSignature, activeTab]);

  const handleGenerate = async () => {
    if (!generateDesc.trim()) { setGenerateError("Describe what the workflow should do."); return; }
    const name = generateName.trim() || generateDesc.trim().slice(0, 50);
    setGenerating(true);
    setGenerateError("");
    try {
      const genRes = await fetch("/api/workflows/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: generateDesc }),
      });
      const genData = await genRes.json() as { success: boolean; data?: { nodes: unknown[]; edges: unknown[] }; error?: string };
      if (!genData.success || !genData.data) {
        setGenerateError(genData.error ?? "Generation failed");
        return;
      }
      const saveRes = await fetch("/api/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, nodes: genData.data.nodes, edges: genData.data.edges }),
      });
      const saveData = await saveRes.json() as { success: boolean; data?: { id: string }; error?: string };
      if (!saveData.success) { setGenerateError(saveData.error ?? "Save failed"); return; }
      setGenerateOpen(false);
      setGenerateDesc("");
      setGenerateName("");
      invalidateCache(/^workflows/);
      if (saveData.data?.id) router.push(`/workflows/${saveData.data.id}`);
    } catch (e) {
      setGenerateError(String(e));
    } finally {
      setGenerating(false);
    }
  };

  const exportWorkflow = (workflow: Workflow) => {
    const url = `/api/workflows?action=export&id=${workflow.id}`;
    const a = document.createElement("a");
    a.href = url;
    a.download = `${workflow.name.replace(/[^a-z0-9]/gi, "_")}.disp8ch.json`;
    a.click();
  };

  const duplicateWorkflow = async (workflow: WorkflowCard) => {
    setActionNotice(null);
    try {
      const res = await fetch("/api/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `${workflow.name} Copy`,
          description: workflow.description ?? "",
          nodes: workflow.nodes,
          edges: workflow.edges,
          organizationId: workflow.organizationId || undefined,
          goalId: workflow.goalId || undefined,
          sourceType: workflow.sourceType || "duplicate",
          sourceRef: workflow.id,
        }),
      });
      const json = await res.json();
      if (!json.success) {
        setActionNotice({ tone: "error", message: `Duplicate failed: ${json.error || "unknown error"}` });
        return;
      }
      setActionNotice({ tone: "success", message: `Duplicated "${workflow.name}".` });
      invalidateCache(/^workflows/);
      fetchWorkflows();
    } catch (error) {
      setActionNotice({ tone: "error", message: `Duplicate failed: ${String(error)}` });
    }
  };

  const replayWorkflow = async (workflow: WorkflowCard) => {
    const last = workflow.lastExecution;
    if (!last?.triggerData) {
      setActionNotice({ tone: "error", message: `"${workflow.name}" has no previous trigger payload to replay.` });
      return;
    }
    setRunningWorkflowId(workflow.id);
    setActionNotice(null);
    try {
      const res = await fetch("/api/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflowId: workflow.id,
          triggerType: last.triggerType === "cron" ? "manual" : last.triggerType,
          triggerData: {
            ...last.triggerData,
            replayedFromExecutionId: last.id,
            replayedAt: new Date().toISOString(),
          },
          provenance: { source: "workflows-replay", replayedFromExecutionId: last.id },
        }),
      });
      const json = await res.json();
      if (!json.success) {
        setActionNotice({ tone: "error", message: `Replay failed for "${workflow.name}": ${json.error || "unknown error"}` });
        return;
      }
      setActionNotice({ tone: "success", message: `Replayed "${workflow.name}" with the last trigger payload.` });
      invalidateCache(/^workflows/);
      fetchWorkflows();
    } catch (error) {
      setActionNotice({ tone: "error", message: `Replay failed for "${workflow.name}": ${String(error)}` });
    } finally {
      setRunningWorkflowId(null);
    }
  };

  const retryExecution = async (executionId: string, fromFailedNode = false) => {
    setRetryingExecutionId(executionId);
    setActionNotice(null);
    try {
      const response = await fetch("/api/workflows/executions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: fromFailedNode ? "retry-from-failed-node" : "retry", executionId }),
      });
      const json = await response.json();
      if (!json.success) {
        setActionNotice({ tone: "error", message: json.error || "Execution retry failed." });
        return;
      }
      setActionNotice({ tone: "success", message: fromFailedNode ? "Retry from failed node started." : "Execution retry started." });
      invalidateCache(/^workflows/);
      fetchExecutions();
      fetchWorkflows();
    } catch (error) {
      setActionNotice({ tone: "error", message: `Execution retry failed: ${String(error)}` });
    } finally {
      setRetryingExecutionId(null);
    }
  };

  const inspectWorkflow = async (workflow: WorkflowCard) => {
    setDebuggerOpen(true);
    setDebuggerLoading(true);
    setDebuggerError("");
    setDebuggerData(null);
    try {
      const params = new URLSearchParams({ workflowId: workflow.id });
      if (workflow.lastExecution?.id) params.set("executionId", workflow.lastExecution.id);
      const response = await fetch(`/api/workflows/debugger?${params.toString()}`);
      const json = await response.json();
      if (!response.ok || !json.success) throw new Error(json.error || "Could not load workflow debugger.");
      setDebuggerData(json.data as WorkflowDebuggerData);
    } catch (error) {
      setDebuggerError(String(error));
    } finally {
      setDebuggerLoading(false);
    }
  };

  const openWorkflowPromptInWebChat = (prompt: string) => {
    const params = new URLSearchParams({ draft: prompt, returnTo: `${window.location.pathname}${window.location.search}` });
    router.push(`/chat?${params.toString()}`);
  };

  const openCredentialFix = (item: { nodeId: string; nodeName: string; serviceType?: string | null }) => {
    setCredFixError("");
    setCredFixNodeId(item.nodeId);
    setCredFixForm({
      name: `${item.nodeName} credential`,
      serviceType: item.serviceType ?? "",
      secret: "",
    });
  };

  const submitCredentialFix = async () => {
    if (!debuggerData || !credFixNodeId) return;
    if (!credFixForm.name.trim() || !credFixForm.serviceType.trim() || !credFixForm.secret.trim()) {
      setCredFixError("Name, service type, and secret are all required.");
      return;
    }
    setCredFixSaving(true);
    setCredFixError("");
    try {
      // 1. Create the credential (secret stored encrypted by reference).
      const createRes = await fetch("/api/workflows/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create",
          name: credFixForm.name.trim(),
          serviceType: credFixForm.serviceType.trim(),
          secretValue: credFixForm.secret,
        }),
      });
      const createJson = await createRes.json() as { success: boolean; data?: { id: string }; error?: string };
      if (!createRes.ok || !createJson.success || !createJson.data?.id) {
        throw new Error(createJson.error || "Could not create credential.");
      }
      // 2. Attach the credential reference to the node (server-side safe patch).
      const attachRes = await fetch("/api/workflows/debugger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "attach-credential",
          workflowId: debuggerData.workflow.id,
          nodeId: credFixNodeId,
          credentialId: createJson.data.id,
        }),
      });
      const attachJson = await attachRes.json() as { success: boolean; error?: string };
      if (!attachRes.ok || !attachJson.success) {
        throw new Error(attachJson.error || "Could not attach credential to node.");
      }
      // 3. Refresh credential health from the server.
      setCredFixNodeId(null);
      setCredFixForm({ name: "", serviceType: "", secret: "" });
      await inspectWorkflow({ id: debuggerData.workflow.id, lastExecution: undefined } as WorkflowCard);
    } catch (error) {
      setCredFixError(String(error));
    } finally {
      setCredFixSaving(false);
    }
  };

  const handleImportFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    setImportFile(file);
    setImportError("");
    setImportResult(null);
    if (file && !importName) {
      setImportName(file.name.replace(/\.(json|disp8ch\.json)$/i, "").replace(/_/g, " "));
    }
  };

  const handleImport = async () => {
    if (!importFile) { setImportError("Choose a .json file first."); return; }
    if (!importName.trim()) { setImportError("Give the workflow a name."); return; }
    setImporting(true);
    setImportError("");
    setImportResult(null);
    try {
      const text = await importFile.text();
      const json = JSON.parse(text) as Record<string, unknown>;
      const isCompatibleWorkflow = json.nodes !== undefined && json.connections !== undefined && !json._disp8chExport;
      const isDisp8ch = json._disp8chExport === true;
      if (!isCompatibleWorkflow && !isDisp8ch) {
        setImportError("Unrecognized format. Expected a compatible workflow export or a disp8ch export (.disp8ch.json).");
        return;
      }
      const importSource = isCompatibleWorkflow ? "compatible" : "disp8ch";
      const res = await fetch("/api/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: importName.trim(), importSource, importData: json }),
      });
      const data = await res.json() as { success: boolean; data?: { id: string; importStats?: { total: number; mapped: number; unsupported: number }; importWarnings?: string[] }; error?: string };
      if (!data.success) { setImportError(data.error ?? "Import failed"); return; }
      setImportResult({
        stats: data.data?.importStats,
        warnings: data.data?.importWarnings,
        workflowId: data.data?.id,
      });
      invalidateCache(/^workflows/);
      fetchWorkflows();
    } catch (e) {
      setImportError(String(e));
    } finally {
      setImporting(false);
    }
  };

  const createWorkflow = async () => {
    const res = await fetch("/api/workflows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "New Workflow" }),
    });
    const data = await res.json();
    if (data.success) {
      invalidateCache(/^workflows/);
      router.push(`/workflows/${data.data.id}`);
    }
  };

  const createFromTemplate = async (
    template: WorkflowTemplate,
    selectedAgents?: Record<string, string>,
  ) => {
    setCreatingTemplateKey(template.key);
    try {
      const cleanedTemplateAgents = Object.fromEntries(
        Object.entries(selectedAgents ?? {}).filter(([, value]) => Boolean(value)),
      );
      const res = await fetch("/api/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: template.name,
          description: template.description,
          template: template.key,
          organizationId: selectedTemplateOrganizationId || undefined,
          goalId: selectedTemplateGoalId || undefined,
          sourceType: selectedSourceDocument ? "data-source" : undefined,
          sourceRef: selectedSourceDocument?.id,
          templateAgents:
            Object.keys(cleanedTemplateAgents).length > 0
              ? cleanedTemplateAgents
              : undefined,
        }),
      });
      const data = await res.json();
      if (data.success) {
        invalidateCache(/^workflows/);
        router.push(`/workflows/${data.data.id}`);
      }
    } finally {
      setCreatingTemplateKey(null);
    }
  };

  const prepareTemplateAgentPicker = async (template: WorkflowTemplate) => {
    if (!template.agentSlots || template.agentSlots.length === 0) {
      await createFromTemplate(template);
      return;
    }

    const availableAgents = agents.length > 0 ? agents : await fetchAgents();
    if (availableAgents.length === 0) {
      setAgentRequiredTemplate(template);
      return;
    }

    const defaults: Record<string, string> = {};
    template.agentSlots.forEach((slot, index) => {
      const preferred = availableAgents[index % availableAgents.length];
      defaults[slot.roleKey] = preferred?.id ?? availableAgents[0].id;
    });

    setTemplateAgents(defaults);
    setPickerTemplate(template);
    setPickerOpen(true);
  };

  const confirmTemplateWithAgents = async () => {
    if (!pickerTemplate) return;
    const requiredSlots = pickerTemplate.agentSlots ?? [];
    const hasMissing = requiredSlots.some((slot) => !templateAgents[slot.roleKey]);
    if (hasMissing) return;
    setPickerOpen(false);
    await createFromTemplate(pickerTemplate, templateAgents);
    setPickerTemplate(null);
  };

  const deleteWorkflow = async (id: string) => {
    setDeletingWorkflowId(id);
    try {
      await fetch(`/api/workflows?id=${id}`, { method: "DELETE" });
      invalidateCache(/^workflows/);
      fetchWorkflows();
      setDeleteWorkflowTarget(null);
      setActionNotice({ tone: "success", message: "Workflow deleted." });
    } catch (error) {
      setActionNotice({ tone: "error", message: `Delete failed: ${String(error)}` });
    } finally {
      setDeletingWorkflowId(null);
    }
  };

  const resetAllWorkflows = async () => {
    if (workflows.length === 0) return;
    setResettingAll(true);
    try {
      await fetch("/api/workflows?all=1", { method: "DELETE" });
      invalidateCache(/^workflows/);
      fetchWorkflows();
      setActiveTab("mine");
      setResetAllOpen(false);
      setActionNotice({ tone: "success", message: "All workflows and cron schedules were removed." });
    } catch (error) {
      setActionNotice({ tone: "error", message: `Reset failed: ${String(error)}` });
    } finally {
      setResettingAll(false);
    }
  };

  return (
        <main className="flex-1 overflow-auto p-6" data-perf-ready="workflows">
          <SurfaceHeader
            className="mb-6"
            title="Workflows"
            subtitle="Build, inspect, and run connected automations from templates or plain English."
            statusItems={[
              { label: "Active", value: workflows.filter((workflow) => workflow.isActive).length, tone: "ok" },
              { label: "Needs setup", value: Object.values(cardHealth).filter((health) => health.missing > 0).length, tone: "warn" },
              { label: "Templates", value: TEMPLATE_CATALOG.length },
            ]}
            secondaryActions={(
              <>
              <Button variant="outline" onClick={() => setHideGettingStarted((current) => !current)}>
                {hideGettingStarted ? "Show Tips" : "Hide Tips"}
              </Button>
              <GoogleSetupDialog />
              <Button variant="outline" onClick={() => { setGenerateOpen(true); setGenerateDesc(""); setGenerateName(""); setGenerateError(""); }}>
                <WandSparkles className="mr-2 h-4 w-4" />
                Generate
              </Button>
              <Button variant="outline" onClick={() => { setImportOpen(true); setImportFile(null); setImportName(""); setImportError(""); setImportResult(null); }}>
                <Upload className="mr-2 h-4 w-4" />
                Import
              </Button>
              <Button
                variant="outline"
                onClick={() => workflows[0] ? exportWorkflow(workflows[0]) : undefined}
                disabled={workflows.length === 0}
                title="Export the most recently updated workflow"
              >
                <Download className="mr-2 h-4 w-4" />
                Export
              </Button>
              <Button onClick={createWorkflow}>
                <Plus className="mr-2 h-4 w-4" />
                New Workflow
              </Button>
              </>
            )}
          />
          {actionNotice ? (
            <div
              className={[
                "mb-4 rounded-md border px-3 py-2 text-sm",
                actionNotice.tone === "success"
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                  : "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300",
              ].join(" ")}
              role="status"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>{actionNotice.message}</span>
                <button
                  type="button"
                  className="font-mono text-[10px] uppercase tracking-widest opacity-70 hover:opacity-100"
                  onClick={() => setActionNotice(null)}
                >
                  Dismiss
                </button>
              </div>
            </div>
          ) : null}
          <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as WorkflowViewTab)}>
            <TabsList className="mb-6 grid h-auto w-full grid-cols-2 items-stretch gap-1 border-b-0 sm:grid-cols-4 md:w-[680px] md:border-b">
              <TabsTrigger className="min-h-10 px-2 text-[10px] sm:text-xs" value="mine">My Workflows ({filteredWorkflows.length})</TabsTrigger>
              <TabsTrigger className="min-h-10 px-2 text-[10px] sm:text-xs" value="templates">Templates ({TEMPLATE_CATALOG.length})</TabsTrigger>
              <TabsTrigger className="min-h-10 px-2 text-[10px] sm:text-xs" value="executions">Executions</TabsTrigger>
              <TabsTrigger className="min-h-10 px-2 text-[10px] sm:text-xs" value="runs">Dynamic Runs</TabsTrigger>
            </TabsList>

            <TabsContent value="mine">
              <div className="mb-4 flex items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{filteredWorkflows.length} user workflows</Badge>
                  {([
                    ["all", "All"],
                    ["failed", "Failed"],
                    ["cron", "Cron"],
                    ["message", "Message"],
                    ["imported", "Imported"],
                    ["needs-setup", "Needs setup"],
                  ] as Array<[WorkflowQuickFilter, string]>).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      className={[
                        "rounded border px-2.5 py-1 font-mono text-xs transition-colors",
                        workflowQuickFilter === value
                          ? "border-terminal-red bg-terminal-red/10 text-terminal-red"
                          : "border-border text-muted-foreground hover:border-muted-foreground hover:text-foreground",
                      ].join(" ")}
                      onClick={() => setWorkflowQuickFilter(value)}
                    >
                      {label}
                    </button>
                  ))}
                  <select
                    className="rounded-md border bg-background px-3 py-2 text-sm"
                    value={workflowFilterOrganizationId}
                    onChange={(event) => {
                      setWorkflowFilterOrganizationId(event.target.value);
                      setWorkflowFilterGoalId("");
                    }}
                  >
                    <option value="">All organizations</option>
                    {organizations.map((organization) => (
                      <option key={organization.id} value={organization.id}>
                        {organization.name}
                      </option>
                    ))}
                  </select>
                  <select
                    className="rounded-md border bg-background px-3 py-2 text-sm"
                    value={workflowFilterGoalId}
                    onChange={(event) => setWorkflowFilterGoalId(event.target.value)}
                  >
                    <option value="">All goals</option>
                    {goals
                      .filter((goal) => !workflowFilterOrganizationId || goal.organizationId === workflowFilterOrganizationId)
                      .map((goal) => (
                        <option key={goal.id} value={goal.id}>
                          {goal.name}
                        </option>
                      ))}
                  </select>
                  {(workflowFilterOrganizationId || workflowFilterGoalId) ? (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          const params = new URLSearchParams();
                          if (workflowFilterOrganizationId) params.set("org", workflowFilterOrganizationId);
                          if (workflowFilterGoalId) params.set("goal", workflowFilterGoalId);
                          router.push(`/hierarchy?${params.toString()}`);
                        }}
                      >
                        Open Hierarchy
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          const params = new URLSearchParams();
                          if (workflowFilterOrganizationId) params.set("org", workflowFilterOrganizationId);
                          if (workflowFilterGoalId) params.set("goal", workflowFilterGoalId);
                          router.push(`/boards?${params.toString()}`);
                        }}
                      >
                        Open Boards
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          const params = new URLSearchParams();
                          if (workflowFilterOrganizationId) params.set("org", workflowFilterOrganizationId);
                          if (workflowFilterGoalId) params.set("goal", workflowFilterGoalId);
                          router.push(`/council?${params.toString()}`);
                        }}
                      >
                        Open Council
                      </Button>
                    </>
                  ) : null}
                </div>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={resettingAll || workflows.length === 0}
                  onClick={() => setResetAllOpen(true)}
                >
                  {resettingAll ? "Resetting..." : "Reset to Scratch"}
                </Button>
              </div>

              {filteredWorkflows.length === 0 ? (
                <>
                  <EmptyState
                    className="mb-6"
                    title={workflows.length === 0 ? "No workflows yet" : "No workflows match this filter"}
                    description={workflows.length === 0 ? "Start from a connected template, generate a workflow, or ask WebChat to draft one before saving." : "Clear the current filters or ask WebChat to inspect what should be visible."}
                    action={<Button onClick={() => setActiveTab("templates")}>Open Templates</Button>}
                    secondaryAction={<WebChatDraftButton draft="Draft a workflow plan from my current goal, but ask before saving anything." label="Draft in WebChat" />}
                  />
                  {/* ── Getting Started panel (empty state) ── */}
                  {workflows.length === 0 && !hideGettingStarted && (
                    <div className="mb-6 border border-slate-600/60 bg-slate-800/40 p-5 space-y-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="text-[10px] font-mono uppercase tracking-widest text-slate-400">GETTING STARTED — WORKFLOWS</div>
                        <button
                          type="button"
                          className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground transition-colors hover:text-terminal-red"
                          onClick={() => setHideGettingStarted(true)}
                        >
                          Dismiss
                        </button>
                      </div>
                      <p className="text-sm text-slate-300 max-w-2xl">
                        Workflows are visual node-based automations. Connect triggers, AI agents, logic, and actions in a drag-and-drop editor. Messages come in, get processed through your pipeline, and results go out.
                      </p>
                      <div className="grid gap-2 sm:grid-cols-3 text-[11px]">
                        <div className="border border-slate-700/60 p-3 space-y-1">
                          <div className="font-mono uppercase tracking-wide text-slate-400">Option 1 — Use a Template</div>
                          <div className="text-slate-400">Click the <strong className="text-slate-300">Templates</strong> tab above. Pick a starter like <strong className="text-slate-300">Simple Chat Assistant</strong> or <strong className="text-slate-300">Code Reviewer</strong> to get a working workflow instantly.</div>
                        </div>
                        <div className="border border-slate-700/60 p-3 space-y-1">
                          <div className="font-mono uppercase tracking-wide text-slate-400">Option 2 — Build from Scratch</div>
                          <div className="text-slate-400">Click <strong className="text-slate-300">New Workflow</strong> above. Drag nodes onto the canvas: start with a <strong className="text-slate-300">trigger</strong> (message, cron, webhook), add an <strong className="text-slate-300">AI agent</strong>, then a <strong className="text-slate-300">channel output</strong>.</div>
                        </div>
                        <div className="border border-slate-700/60 p-3 space-y-1">
                          <div className="font-mono uppercase tracking-wide text-slate-400">Key Concepts</div>
                          <ul className="list-disc list-inside space-y-0.5 text-slate-400">
                            <li><strong className="text-slate-300">Triggers</strong> start the flow (message, cron, webhook)</li>
                            <li><strong className="text-slate-300">Agents</strong> process with AI (Claude, GPT, Gemini)</li>
                            <li><strong className="text-slate-300">Channels</strong> deliver output (WebChat, Telegram, etc.)</li>
                            <li><strong className="text-slate-300">Logic</strong> branches with If/Else, Switch, Loop</li>
                          </ul>
                        </div>
                      </div>
                    </div>
                  )}
                  <Card>
                    <CardContent className="flex flex-col items-center justify-center py-12">
                      <p className="mb-4 text-muted-foreground">No workflows yet</p>
                      <div className="flex flex-wrap items-center gap-2">
                        <Button onClick={createWorkflow}>
                          <Plus className="mr-2 h-4 w-4" />
                          Create Empty Workflow
                        </Button>
                        <Button variant="secondary" onClick={() => setActiveTab("templates")}>
                          <WandSparkles className="mr-2 h-4 w-4" />
                          Browse Templates
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                </>
              ) : (
                <>
                  {/* Create-from-current-goal strip */}
                  {(workflowFilterOrganizationId || workflowFilterGoalId) ? (
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-terminal-red/30 bg-terminal-red/5 px-3 py-2">
                      <div className="flex items-center gap-2 text-xs">
                        <span className="font-mono uppercase tracking-widest text-muted-foreground">SCOPED TO</span>
                        {workflowFilterOrganizationId ? (
                          <Badge variant="outline">org: {organizationById.get(workflowFilterOrganizationId) || workflowFilterOrganizationId}</Badge>
                        ) : null}
                        {workflowFilterGoalId ? (
                          <Badge variant="outline" className="border-blue-500/30 text-blue-400/80">
                            goal: {goalById.get(workflowFilterGoalId) || workflowFilterGoalId}
                          </Badge>
                        ) : null}
                        <span className="text-muted-foreground">· {filteredWorkflows.length} scoped workflow(s)</span>
                      </div>
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setActiveTab("templates");
                            if (workflowFilterOrganizationId) setSelectedTemplateOrganizationId(workflowFilterOrganizationId);
                            if (workflowFilterGoalId) setSelectedTemplateGoalId(workflowFilterGoalId);
                          }}
                        >
                          + New from this goal
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setWorkflowFilterOrganizationId("");
                            setWorkflowFilterGoalId("");
                          }}
                        >
                          Clear scope
                        </Button>
                      </div>
                    </div>
                  ) : null}

                  <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                    {filteredWorkflows.map((wf) => {
                      const hasCronTrigger = workflowHasCronTrigger(wf);
                      const hasMessageTrigger = workflowHasMessageTrigger(wf);
                      const hasBoardLink = Boolean(wf.organizationId || wf.goalId);
                      const sourceType = wf.sourceType ?? null;
                      const hasDataSource = sourceType === "document" || (Array.isArray(wf.nodes) && wf.nodes.some((node) => node?.type === "document-tool"));
                      const needsSetup = workflowNeedsSetup(wf);
                      const imported = workflowIsImported(wf);
                      const lastExec = wf.lastExecution ?? null;
                      const lastFailed = lastExec && ["failed", "error"].includes(String(lastExec.status).toLowerCase());
                      const lastSucceeded = lastExec && ["success", "succeeded", "completed"].includes(String(lastExec.status).toLowerCase());
                      const ageLabel = (iso: string) => {
                        const diffMs = Date.now() - new Date(iso).getTime();
                        if (Number.isNaN(diffMs) || diffMs < 0) return "just now";
                        const mins = Math.floor(diffMs / 60000);
                        if (mins < 1) return "just now";
                        if (mins < 60) return `${mins}m ago`;
                        const hours = Math.floor(mins / 60);
                        if (hours < 24) return `${hours}h ago`;
                        const days = Math.floor(hours / 24);
                        return `${days}d ago`;
                      };
                      return (
                    <Card key={wf.id} className="transition-shadow hover:shadow-md">
                      <CardHeader className="pb-3">
                        <div className="flex items-center justify-between">
                          <CardTitle className="text-base">
                            <Link href={`/workflows/${wf.id}`} className="hover:underline">
                              {wf.name}
                            </Link>
                          </CardTitle>
                          <Badge variant={wf.isActive ? "default" : "secondary"}>
                            {wf.isActive ? "Active" : "Inactive"}
                          </Badge>
                        </div>
                      </CardHeader>
                      <CardContent>
                        <p className="mb-3 text-sm text-muted-foreground">
                          {wf.description || "No description"}
                        </p>
                        <div className="mb-3 flex flex-wrap gap-1">
                          {wf.organizationId ? (
                            <Badge variant="outline">
                              org: {organizationById.get(wf.organizationId) || wf.organizationId}
                            </Badge>
                          ) : null}
                          {wf.goalId ? (
                            <Badge
                              variant="outline"
                              className="cursor-pointer border-blue-500/30 text-blue-400/80 hover:bg-blue-500/10 transition-colors"
                              title="View goal in Hierarchy"
                              onClick={(e) => { e.stopPropagation(); router.push(`/hierarchy/goal/${wf.goalId}`); }}
                            >
                              ↗ goal: {goalById.get(wf.goalId) || wf.goalId}
                            </Badge>
                          ) : null}
                        </div>
                        {/* Health badges */}
                        <div className="mb-3 flex flex-wrap gap-1">
                          {hasCronTrigger ? (
                            <Badge variant="outline" className="border-amber-500/40 text-amber-500" title="Scheduled workflow (cron trigger)">
                              <Clock className="mr-1 h-3 w-3" />
                              cron
                            </Badge>
                          ) : null}
                          {hasMessageTrigger ? (
                            <Badge variant="outline" className="border-sky-500/40 text-sky-500" title="Message-triggered workflow">
                              <MessageSquare className="mr-1 h-3 w-3" />
                              message
                            </Badge>
                          ) : null}
                          {imported ? (
                            <Badge variant="outline" className="border-violet-500/40 text-violet-400" title="Imported workflow">
                              imported
                            </Badge>
                          ) : null}
                          {needsSetup ? (
                            <Badge variant="outline" className="border-orange-500/40 text-orange-400" title="Contains imported placeholders or external channel/integration nodes that may need credentials">
                              needs setup
                            </Badge>
                          ) : null}
                          {lastFailed ? (
                            <Badge variant="outline" className="border-red-500/40 text-red-500" title={`Last run failed · ${ageLabel(lastExec!.startedAt)}`}>
                              <AlertTriangle className="mr-1 h-3 w-3" />
                              last failed · {ageLabel(lastExec!.startedAt)}
                            </Badge>
                          ) : lastSucceeded ? (
                            <Badge variant="outline" className="border-emerald-500/40 text-emerald-500" title={`Last run succeeded · ${ageLabel(lastExec!.startedAt)}`}>
                              <CheckCircle2 className="mr-1 h-3 w-3" />
                              ok · {ageLabel(lastExec!.startedAt)}
                            </Badge>
                          ) : null}
                          {hasBoardLink ? (
                            <Badge variant="outline" className="border-blue-500/30 text-blue-400/80" title="Scoped to org / goal — produces board tasks">
                              board scope
                            </Badge>
                          ) : null}
                          {hasDataSource ? (
                            <Badge variant="outline" className="border-violet-500/40 text-violet-400" title="Uses a data source">
                              <FileText className="mr-1 h-3 w-3" />
                              data source
                            </Badge>
                          ) : null}
                        </div>
                        {cardHealth[wf.id] ? (
                          <button
                            type="button"
                            onClick={() => void inspectWorkflow(wf)}
                            className="mb-3 flex w-full items-center gap-2 rounded-md border border-border/60 bg-muted/20 px-2 py-1 text-left text-[11px] text-muted-foreground hover:border-foreground/25"
                            title="Open Workflow Inspector"
                          >
                            <span className={cardHealth[wf.id].lastStatus === "failed" ? "text-red-400" : cardHealth[wf.id].lastStatus === "completed" ? "text-emerald-400" : ""}>
                              {cardHealth[wf.id].lastStatus === "failed" ? "Last run failed" : cardHealth[wf.id].lastStatus === "completed" ? "Last run OK" : "No runs yet"}
                            </span>
                            <span>·</span>
                            <span className={cardHealth[wf.id].missing > 0 ? "text-orange-400" : ""}>{cardHealth[wf.id].missing} missing creds</span>
                            <span>·</span>
                            <span className={cardHealth[wf.id].warnings > 0 ? "text-yellow-400" : ""}>{cardHealth[wf.id].warnings} warning{cardHealth[wf.id].warnings === 1 ? "" : "s"}</span>
                            <span className="ml-auto text-[10px]">Inspect →</span>
                          </button>
                        ) : null}
                        <RelatedWorkTrailStrip
                          className="mb-3"
                          surface="workflows"
                          objectType="workflow"
                          objectId={wf.id}
                          objectName={wf.name}
                        />
                        {(workflowTags[wf.id] ?? []).length > 0 ? (
                          <div className="mb-3 flex flex-wrap gap-1">
                            {(workflowTags[wf.id] ?? []).map((tag) => (
                              <span
                                key={`${wf.id}-${tag.id}`}
                                className="rounded px-1.5 py-0.5 text-[10px]"
                                style={{ backgroundColor: `${tag.color}33`, color: tag.color }}
                              >
                                {tag.name}
                              </span>
                            ))}
                          </div>
                        ) : null}
                        <div className="flex items-center justify-between text-xs text-muted-foreground">
                          <span>{wf.nodes.length} nodes</span>
                          <div className="flex flex-wrap gap-1">
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 px-2 text-[11px]"
                              title="Run this workflow now"
                              disabled={runningWorkflowId === wf.id}
                              onClick={() => void runWorkflow(wf)}
                            >
                              <Play className="mr-1 h-3 w-3" />
                              {runningWorkflowId === wf.id ? "Running…" : "Run"}
                            </Button>
                            <Link href={`/workflows/${wf.id}`}>
                              <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px]" title="Open editor">
                                <Pencil className="mr-1 h-3 w-3" />
                                Edit
                              </Button>
                            </Link>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2 text-[11px]"
                              title="Replay the last trigger payload"
                              disabled={runningWorkflowId === wf.id || !wf.lastExecution?.triggerData}
                              onClick={() => void replayWorkflow(wf)}
                            >
                              <RotateCcw className="mr-1 h-3 w-3" />
                              Replay
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2 text-[11px]"
                              title="Inspect execution trace, credentials, and repair hints"
                              onClick={() => void inspectWorkflow(wf)}
                            >
                              <Search className="mr-1 h-3 w-3" />
                              Inspect
                            </Button>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="icon" className="h-7 w-7" title="More workflow actions">
                                  <MoreHorizontal className="h-3 w-3" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="w-48">
                                <DropdownMenuItem
                                  disabled={creatingTaskForWorkflowId === wf.id}
                                  onClick={() => void createFollowUpTask(wf)}
                                >
                                  <ClipboardList className="mr-2 h-3.5 w-3.5" />
                                  {creatingTaskForWorkflowId === wf.id ? "Creating task..." : "Create task"}
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => void duplicateWorkflow(wf)}>
                                  <Copy className="mr-2 h-3.5 w-3.5" />
                                  Duplicate
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => exportWorkflow(wf)}>
                                  <Download className="mr-2 h-3.5 w-3.5" />
                                  Export
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  disabled={deletingWorkflowId === wf.id}
                                  className="text-destructive focus:text-destructive"
                                  onClick={() => setDeleteWorkflowTarget(wf)}
                                >
                                  <Trash2 className="mr-2 h-3.5 w-3.5" />
                                  Delete
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                      );
                    })}
                  </div>
                </>
              )}
            </TabsContent>

            <TabsContent value="templates">
              {/* ── Intent chooser ── */}
              <div className="mb-4 flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium text-muted-foreground">What are you trying to automate?</span>
                <div className="flex flex-wrap gap-1.5">
                  {INTENTS.map((intent) => (
                    <Button
                      key={intent.key}
                      variant={templateIntent === intent.key ? "default" : "outline"}
                      size="sm" className="h-7 rounded-full px-3 text-xs"
                      onClick={() => setTemplateIntent(templateIntent === intent.key ? null : intent.key)}
                    >
                      {intent.label}
                    </Button>
                  ))}
                </div>
                {templateIntent ? (
                  <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setTemplateIntent(null)}>
                    Show all
                  </Button>
                ) : null}
              </div>

              {/* ── Filter bar ── */}
              <div className="mb-4 flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  {/* Category pills */}
                  {(["all", "starter", "ops", "productivity", "data", "research", "google"] as const).map((cat) => {
                    const count = cat === "all" ? TEMPLATE_CATALOG.length : TEMPLATE_CATALOG.filter((t) => t.category === cat).length;
                    return (
                      <button
                        key={cat}
                        onClick={() => setTemplateCategory(cat)}
                        className={[
                          "rounded border px-2.5 py-1 font-mono text-xs transition-colors",
                          templateCategory === cat
                            ? "border-terminal-red bg-terminal-red/10 text-terminal-red"
                            : "border-border text-muted-foreground hover:border-muted-foreground hover:text-foreground",
                        ].join(" ")}
                      >
                        {cat} <span className="opacity-60">{count}</span>
                      </button>
                    );
                  })}
                  {/* Search */}
                  <div className="relative ml-auto">
                    <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                    <input
                      className="h-8 w-48 rounded-md border bg-background pl-8 pr-3 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                      placeholder="Search templates…"
                      value={templateSearch}
                      onChange={(e) => setTemplateSearch(e.target.value)}
                    />
                  </div>
                </div>
                {/* Org / goal / source context */}
                <div className="rounded-md border border-border/60 bg-muted/10 p-3">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="text-xs font-semibold">Optional context</div>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        Templates do not require an organization. Choose an org or goal only when you want ownership, budgets, or board follow-up tied to a team.
                      </p>
                    </div>
                    <Badge variant="outline" className="text-[10px]">
                      One active agent is enough for most templates
                    </Badge>
                  </div>
                <div className="flex flex-wrap items-center gap-2">
                  {selectedSourceDocument ? (
                    <Badge variant="secondary" className="font-mono text-xs">source: {selectedSourceDocument.name}</Badge>
                  ) : null}
                  <select
                    className="rounded-md border bg-background px-3 py-1.5 text-xs"
                    value={selectedTemplateOrganizationId}
                    onChange={(event) => { setSelectedTemplateOrganizationId(event.target.value); setSelectedTemplateGoalId(""); }}
                  >
                    <option value="">No organization</option>
                    {organizations.map((org) => <option key={org.id} value={org.id}>{org.name}</option>)}
                  </select>
                  <select
                    className="rounded-md border bg-background px-3 py-1.5 text-xs"
                    value={selectedTemplateGoalId}
                    onChange={(event) => setSelectedTemplateGoalId(event.target.value)}
                  >
                    <option value="">No goal</option>
                    {templateGoals.map((goal) => <option key={goal.id} value={goal.id}>{goal.name}</option>)}
                  </select>
                </div>
                </div>
              </div>

              {selectedSourceDocument ? (
                <Card className="mb-4 border-terminal-red/30 bg-terminal-red/5">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base">Prefilled Data Source Context</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2 text-sm">
                    <div className="flex flex-wrap gap-2">
                      <Badge variant="outline">{selectedSourceDocument.sourceType}</Badge>
                      <Badge variant="secondary">{selectedSourceDocument.id}</Badge>
                    </div>
                    <div className="font-medium">{selectedSourceDocument.name}</div>
                    {selectedSourceDocument.sourceUrl ? (
                      <div className="text-xs text-muted-foreground">{selectedSourceDocument.sourceUrl}</div>
                    ) : null}
                    {selectedSourceDocument.excerpt ? (
                      <p className="text-xs text-muted-foreground">{selectedSourceDocument.excerpt}</p>
                    ) : null}
                    <p className="text-xs text-muted-foreground">
                      New workflows created from templates will retain this data source as `sourceType/sourceRef`.
                    </p>
                  </CardContent>
                </Card>
              ) : null}

              {agents.length === 0 ? (
                <Card className="mb-4 border-yellow-500/30 bg-yellow-500/5">
                  <CardContent className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <div className="text-sm font-semibold">Some templates need at least one active agent.</div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Starter templates can run immediately. Crew, research, hierarchy, and operator templates may ask you to choose agents first.
                      </p>
                    </div>
                    <Button size="sm" variant="outline" onClick={() => router.push("/agents")}>
                      Create Agent
                    </Button>
                  </CardContent>
                </Card>
              ) : null}

              {/* ── Template grid ── */}
              {(() => {
                const q = templateSearch.trim().toLowerCase();
                const selectedIntent = templateIntent
                  ? INTENTS.find((i) => i.key === templateIntent) ?? null
                  : null;
                const visible = TEMPLATE_CATALOG.filter((t) => {
                  if (templateCategory !== "all" && t.category !== templateCategory) return false;
                  if (selectedIntent) {
                    const matchesIntent = selectedIntent.keys?.includes(t.key) ?? selectedIntent.match.test(t.name + " " + t.description);
                    if (!matchesIntent) return false;
                  }
                  if (q) return t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q) || (t.tags ?? []).some((tag) => tag.includes(q));
                  return true;
                });
                return (
                  <>
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                      <p className="font-mono text-xs text-muted-foreground">
                        Showing {visible.length} of {TEMPLATE_CATALOG.length} templates
                        {selectedIntent ? ` · intent: ${selectedIntent.label}` : ""}
                        {templateCategory !== "all" ? ` · category: ${templateCategory}` : ""}
                        {q ? ` · search: "${q}"` : ""}
                      </p>
                      {(selectedIntent || templateCategory !== "all" || q) ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 text-xs"
                          onClick={() => {
                            setTemplateIntent(null);
                            setTemplateCategory("all");
                            setTemplateSearch("");
                          }}
                        >
                          Clear filters
                        </Button>
                      ) : null}
                    </div>
                    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                      {visible.map((template) => {
                        const TriggerIcon = template.trigger ? TRIGGER_ICONS[template.trigger] : null;
                        return (
                          <Card key={template.key} className="flex flex-col transition-shadow hover:shadow-md">
                            <CardHeader className="pb-2">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <CardTitle className="text-sm">{template.name}</CardTitle>
                                <Badge variant="outline" className="font-mono text-[10px]">{template.category}</Badge>
                                {template.complexity ? (
                                  <span className={["font-mono text-[10px]", COMPLEXITY_COLORS[template.complexity]].join(" ")}>
                                    ● {template.complexity}
                                  </span>
                                ) : null}
                                {template.requiresGoogle ? <Badge className="font-mono text-[10px]">Google</Badge> : null}
                                {template.agentSlots?.length ? <Badge variant="secondary" className="font-mono text-[10px]">Agent Select</Badge> : null}
                              </div>
                            </CardHeader>
                            <CardContent className="flex flex-1 flex-col gap-2">
                              <p className="text-xs text-muted-foreground leading-relaxed">{template.description}</p>
                              {/* Node hints */}
                              {template.nodeHints && template.nodeHints.length > 0 ? (
                                <div className="flex flex-wrap gap-1">
                                  {template.nodeHints.slice(0, 4).map((node) => (
                                    <span key={node} className="rounded border border-border/50 bg-muted/30 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                                      {node.replace(/-/g, "\u2011")}
                                    </span>
                                  ))}
                                  {template.nodeHints.length > 4 ? (
                                    <span className="rounded border border-border/30 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/50">
                                      +{template.nodeHints.length - 4}
                                    </span>
                                  ) : null}
                                </div>
                              ) : null}
                              <div className="mt-auto flex items-center gap-2 pt-1">
                                {TriggerIcon ? (
                                  <span className="flex items-center gap-1 font-mono text-[10px] text-muted-foreground">
                                    <TriggerIcon className="h-3 w-3" />{template.trigger}
                                  </span>
                                ) : null}
                                <Button
                                  className="ml-auto h-7 gap-1.5 text-xs"
                                  onClick={() => void prepareTemplateAgentPicker(template)}
                                  disabled={creatingTemplateKey === template.key}
                                >
                                  <WandSparkles className="h-3 w-3" />
                                  {creatingTemplateKey === template.key
                                    ? "Creating…"
                                    : template.agentSlots?.length
                                      ? "Choose Agents"
                                      : "Use Template"}
                                </Button>
                              </div>
                            </CardContent>
                          </Card>
                        );
                      })}
                    </div>
                    {visible.length === 0 ? (
                      <div className="py-12 text-center font-mono text-sm text-muted-foreground">
                        No templates match your filter.{" "}
                        <button className="text-terminal-red hover:underline" onClick={() => { setTemplateSearch(""); setTemplateCategory("all"); }}>Clear</button>
                      </div>
                    ) : null}
                  </>
                );
              })()}
            </TabsContent>

            <TabsContent value="executions">
              <Card>
                <CardHeader>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <CardTitle className="text-base">Executions</CardTitle>
                      <p className="mt-1 text-sm text-muted-foreground">All workflow runs, filterable and retryable.</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <select
                        className="rounded-md border bg-background px-3 py-2 text-sm"
                        value={executionStatusFilter}
                        onChange={(event) => setExecutionStatusFilter(event.target.value)}
                      >
                        <option value="">All statuses</option>
                        <option value="completed">Completed</option>
                        <option value="failed">Failed</option>
                        <option value="running">Running</option>
                      </select>
                      <Button variant="outline" onClick={() => fetchExecutions()}>Refresh</Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  {queuedItems.length > 0 ? (
                    <div className="mb-4 rounded-md border border-border bg-background/60 p-3">
                      <div className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                        Queued ({queuedItems.length}) — FIFO, starts when a slot frees up
                      </div>
                      <div className="space-y-2">
                        {queuedItems.map((item) => (
                          <div key={item.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                            <div className="flex items-center gap-2">
                              <Badge variant="outline">queued</Badge>
                              <span className="font-medium">{item.workflowName}</span>
                              <span className="text-xs text-muted-foreground">
                                {item.triggerType} · {new Date(item.enqueuedAt).toLocaleString()}
                                {item.concurrency ? ` · max ${item.concurrency.maxConcurrent}` : ""}
                              </span>
                            </div>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={deletingQueueId === item.id}
                              onClick={() => void deleteQueuedItem(item.id)}
                            >
                              Remove
                            </Button>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  {executions.length === 0 ? (
                    <div className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">No workflow executions recorded yet.</div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="text-left text-xs text-muted-foreground">
                          <tr className="border-b">
                            <th className="py-2 pr-3">Workflow</th>
                            <th className="py-2 pr-3">Status</th>
                            <th className="py-2 pr-3">Trigger</th>
                            <th className="py-2 pr-3">Started</th>
                            <th className="py-2 pr-3">Duration</th>
                            <th className="py-2 pr-3">Error</th>
                            <th className="py-2 text-right">Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {executions.map((execution) => (
                            <tr key={execution.id} className="border-b last:border-b-0">
                              <td className="py-3 pr-3">
                                <div className="font-medium">{execution.workflowName}</div>
                                <div className="font-mono text-[11px] text-muted-foreground">{execution.id}</div>
                              </td>
                              <td className="py-3 pr-3"><Badge variant={execution.status === "failed" ? "destructive" : "outline"}>{execution.status}</Badge></td>
                              <td className="py-3 pr-3">{execution.triggerType}</td>
                              <td className="py-3 pr-3">{new Date(execution.startedAt).toLocaleString()}</td>
                              <td className="py-3 pr-3">{execution.durationMs === null ? "-" : `${Math.round(execution.durationMs)}ms`}</td>
                              <td className="max-w-[280px] truncate py-3 pr-3 text-xs text-muted-foreground">{execution.errorSummary || "-"}</td>
                              <td className="py-3 text-right">
                                <div className="flex justify-end gap-2">
                                  <Button size="sm" variant="outline" onClick={() => router.push(`/workflows/${execution.workflowId}?executionId=${execution.id}`)}>Open</Button>
                                  <Button size="sm" variant="outline" disabled={retryingExecutionId === execution.id} onClick={() => void retryExecution(execution.id)}>
                                    Retry
                                  </Button>
                                  {execution.status === "failed" ? (
                                    <Button size="sm" variant="outline" disabled={retryingExecutionId === execution.id} onClick={() => void retryExecution(execution.id, true)}>
                                      Failed Node
                                    </Button>
                                  ) : null}
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="runs">
              <DynamicRunList />
            </TabsContent>
          </Tabs>

          <Dialog
            open={pickerOpen}
            onOpenChange={(open) => {
              setPickerOpen(open);
              if (!open) {
                setPickerTemplate(null);
              }
            }}
          >
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Choose Agents for Template</DialogTitle>
                <DialogDescription>
                  Assign existing agents to each role. You can still adjust each node&apos;s agent profile later in the workflow editor.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-3">
                {pickerTemplate?.agentSlots?.map((slot) => (
                  <div key={`${pickerTemplate.key}-${slot.roleKey}`} className="space-y-1">
                    <Label>{slot.label}</Label>
                    <select
                      className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                      value={templateAgents[slot.roleKey] ?? ""}
                      onChange={(event) =>
                        setTemplateAgents((current) => ({
                          ...current,
                          [slot.roleKey]: event.target.value,
                        }))
                      }
                    >
                      <option value="">Select agent...</option>
                      {agents.map((agent) => (
                        <option key={`${slot.roleKey}-${agent.id}`} value={agent.id}>
                          {agent.name}
                          {agent.isDefault ? " (default)" : ""}
                        </option>
                      ))}
                    </select>
                    <p className="text-xs text-muted-foreground">{slot.description}</p>
                  </div>
                ))}
              </div>

              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => {
                    setPickerOpen(false);
                    setPickerTemplate(null);
                  }}
                >
                  Cancel
                </Button>
                <Button
                  onClick={() => void confirmTemplateWithAgents()}
                  disabled={
                    loadingAgents ||
                    !pickerTemplate ||
                    (pickerTemplate.agentSlots ?? []).some((slot) => !templateAgents[slot.roleKey]) ||
                    creatingTemplateKey === pickerTemplate?.key
                  }
                >
                  {creatingTemplateKey === pickerTemplate?.key ? "Creating..." : "Create Template Workflow"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          {/* ── Generate with AI Dialog ── */}
          <Dialog open={generateOpen} onOpenChange={(open) => { setGenerateOpen(open); if (!open) { setGenerateDesc(""); setGenerateName(""); setGenerateError(""); } }}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Generate Workflow with AI</DialogTitle>
                <DialogDescription>
                  Describe what you want the workflow to do. The AI will produce a working graph of nodes and edges you can edit right away.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <div>
                  <Label>What should this workflow do?</Label>
                  <textarea
                    className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm resize-none"
                    rows={4}
                    value={generateDesc}
                    onChange={(e) => setGenerateDesc(e.target.value)}
                    placeholder="e.g. Every morning at 9am, search for the latest AI news and send a summary to my Telegram"
                  />
                </div>
                <div>
                  <Label>Workflow name (optional)</Label>
                  <input
                    className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
                    value={generateName}
                    onChange={(e) => setGenerateName(e.target.value)}
                    placeholder="Leave blank to auto-name from description"
                  />
                </div>
                {generateError && <p className="text-sm text-destructive">{generateError}</p>}
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setGenerateOpen(false)}>Cancel</Button>
                <Button onClick={() => void handleGenerate()} disabled={generating || !generateDesc.trim()}>
                  {generating ? "Generating…" : "Generate Workflow"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          {/* ── Import Dialog ── */}
          <Dialog open={importOpen} onOpenChange={(open) => { setImportOpen(open); if (!open) { setImportFile(null); setImportName(""); setImportError(""); setImportResult(null); setImportWarningsExpanded(false); } }}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Import Workflow</DialogTitle>
                <DialogDescription>
                  Import a compatible workflow export (.json) or a <strong>disp8ch</strong> export (.disp8ch.json). Unsupported nodes become placeholder nodes you can replace in the editor.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <div>
                  <Label>Workflow name</Label>
                  <input
                    className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
                    value={importName}
                    onChange={(e) => setImportName(e.target.value)}
                    placeholder="My Imported Workflow"
                  />
                </div>
                <div>
                  <Label>JSON file</Label>
                  <input
                    type="file"
                    accept=".json"
                    className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
                    onChange={handleImportFileChange}
                  />
                </div>
                {importError && <p className="text-sm text-destructive">{importError}</p>}
                {importResult && (
                  <div className="rounded-md bg-green-50 dark:bg-green-950/20 border border-green-200 dark:border-green-800 p-3 text-xs font-mono space-y-1">
                    <p className="text-green-700 dark:text-green-400 font-bold">Import successful!</p>
                    {importResult.stats && (
                      <p className="text-muted-foreground">
                        {importResult.stats.mapped}/{importResult.stats.total} nodes mapped · {importResult.stats.unsupported} placeholder
                      </p>
                    )}
                    {importResult.warnings && importResult.warnings.length > 0 && (
                      <div className="space-y-1 text-yellow-600 dark:text-yellow-400">
                        <ul className="list-disc list-inside space-y-0.5">
                          {(importWarningsExpanded ? importResult.warnings : importResult.warnings.slice(0, 5)).map((w, i) => <li key={i}>{w}</li>)}
                        </ul>
                        {importResult.warnings.length > 5 ? (
                          <button
                            type="button"
                            className="font-mono text-[10px] uppercase tracking-widest underline-offset-2 hover:underline"
                            onClick={() => setImportWarningsExpanded((current) => !current)}
                          >
                            {importWarningsExpanded ? "Show fewer warnings" : `Show all ${importResult.warnings.length} warnings`}
                          </button>
                        ) : null}
                      </div>
                    )}
                  </div>
                )}
              </div>
              <DialogFooter>
                {importResult?.workflowId ? (
                  <>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setImportOpen(false);
                        setImportFile(null);
                        setImportName("");
                        setImportResult(null);
                      }}
                    >
                      Close
                    </Button>
                    <Button
                      onClick={() => {
                        const id = importResult.workflowId!;
                        setImportOpen(false);
                        setImportFile(null);
                        setImportName("");
                        setImportResult(null);
                        router.push(`/workflows/${id}`);
                      }}
                    >
                      Open Workflow
                    </Button>
                  </>
                ) : (
                  <>
                    <Button variant="outline" onClick={() => setImportOpen(false)}>Cancel</Button>
                    <Button onClick={() => void handleImport()} disabled={importing || !importFile || !importName.trim()}>
                      {importing ? "Importing…" : "Import Workflow"}
                    </Button>
                  </>
                )}
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <Dialog open={debuggerOpen} onOpenChange={setDebuggerOpen}>
            <DialogContent className="max-w-3xl">
              <DialogHeader>
                <DialogTitle>Workflow Inspector</DialogTitle>
                <DialogDescription>
                  Execution trace, credential health, node config checks, and repair hints for the selected workflow.
                </DialogDescription>
              </DialogHeader>
              {debuggerLoading ? (
                <div className="rounded-md border p-4 text-sm text-muted-foreground">Loading debugger data...</div>
              ) : debuggerError ? (
                <div className="rounded-md border border-destructive/40 p-4 text-sm text-destructive">{debuggerError}</div>
              ) : debuggerData ? (
                <div className="max-h-[70vh] space-y-4 overflow-auto pr-1">
                  <div className="grid gap-2 sm:grid-cols-4">
                    <div className="rounded-md border p-3">
                      <div className="text-xs text-muted-foreground">Nodes</div>
                      <div className="text-lg font-semibold">{debuggerData.workflow.nodeCount}</div>
                    </div>
                    <div className="rounded-md border p-3">
                      <div className="text-xs text-muted-foreground">Last Trace</div>
                      <div className="text-lg font-semibold">{debuggerData.trace.totals.nodeCount}</div>
                    </div>
                    <div className="rounded-md border p-3">
                      <div className="text-xs text-muted-foreground">Failures</div>
                      <div className="text-lg font-semibold">{debuggerData.trace.totals.failedCount}</div>
                    </div>
                    <div className="rounded-md border p-3">
                      <div className="text-xs text-muted-foreground">Missing Creds</div>
                      <div className="text-lg font-semibold">{debuggerData.credentialHealth.summary.missing}</div>
                    </div>
                  </div>

                  {debuggerData.recoveryPlan ? (
                    <div className="rounded-md border p-3">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <div className="text-sm font-semibold">{debuggerData.recoveryPlan.title}</div>
                            <Badge
                              variant={debuggerData.recoveryPlan.priority === "high" ? "destructive" : debuggerData.recoveryPlan.priority === "medium" ? "secondary" : "outline"}
                              className="text-[10px]"
                            >
                              {debuggerData.recoveryPlan.priority}
                            </Badge>
                          </div>
                          <div className="mt-1 text-xs text-muted-foreground">{debuggerData.recoveryPlan.summary}</div>
                          <div className="mt-2 flex flex-wrap gap-1">
                            {debuggerData.recoveryPlan.evidence.slice(0, 4).map((item) => (
                              <Badge key={item} variant="outline" className="max-w-[220px] truncate text-[10px]">
                                {item}
                              </Badge>
                            ))}
                          </div>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 px-2 text-[11px]"
                          onClick={() => openWorkflowPromptInWebChat(debuggerData.recoveryPlan!.prompt)}
                        >
                          Review in WebChat
                        </Button>
                      </div>
                      <div className="mt-2 grid gap-1 text-xs text-muted-foreground sm:grid-cols-3">
                        {debuggerData.recoveryPlan.actions.slice(0, 3).map((action) => (
                          <div key={action} className="rounded bg-muted/40 px-2 py-1">
                            {action}
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {debuggerData.latestFailures.length > 0 ? (
                    <div className="rounded-md border p-3">
                      <div className="mb-2 text-sm font-semibold">Repair Hints</div>
                      <div className="space-y-2">
                        {debuggerData.latestFailures.slice(0, 5).map((failure) => {
                          const nodeLabel = failure.trace.nodeName || failure.trace.nodeId;
                          const hints = failure.repair?.suggestions ?? ["Open the node and inspect its last input/output."];
                          return (
                          <div key={failure.trace.nodeId} className="rounded bg-muted/40 p-2 text-xs">
                            <div className="flex items-start justify-between gap-2">
                              <div className="font-medium">{nodeLabel}</div>
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-6 shrink-0 px-2 text-[10px]"
                                onClick={() =>
                                  openWorkflowPromptInWebChat(
                                    `Fix the failing node "${nodeLabel}" (id ${failure.trace.nodeId}) in workflow "${debuggerData.workflow.name}" (id ${debuggerData.workflow.id}). Repair hints from the debugger: ${hints.join(" | ")}. Inspect the node config and its last input/output, propose a fix, and explain it before applying.`,
                                  )
                                }
                                title="Open WebChat with this node's repair context prefilled"
                              >
                                Ask WebChat to fix
                              </Button>
                            </div>
                            <ul className="mt-1 list-inside list-disc text-muted-foreground">
                              {hints.map((suggestion) => (
                                <li key={suggestion}>{suggestion}</li>
                              ))}
                            </ul>
                          </div>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}

                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="rounded-md border p-3">
                      <div className="mb-2 text-sm font-semibold">Credential Health</div>
                      <div className="space-y-2">
                        {debuggerData.credentialHealth.items
                          .filter((item) => item.status !== "not_required")
                          .slice(0, 8)
                          .map((item) => (
                            <div key={item.nodeId} className="space-y-2">
                              <div className="flex items-start justify-between gap-2 text-xs">
                                <div>
                                  <div className="font-medium">{item.nodeName}</div>
                                  <div className="text-muted-foreground">{item.message}</div>
                                </div>
                                <div className="flex items-center gap-2">
                                  {item.status === "missing" ? (
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      className="h-6 px-2 text-[11px]"
                                      onClick={() => openCredentialFix(item)}
                                    >
                                      Fix credential
                                    </Button>
                                  ) : null}
                                  <Badge variant={item.status === "ok" ? "default" : "outline"}>{item.status}</Badge>
                                </div>
                              </div>
                              {credFixNodeId === item.nodeId ? (
                                <div className="space-y-2 rounded-md border border-dashed p-2">
                                  <input
                                    className="w-full rounded-md border bg-background px-2 py-1 text-xs"
                                    placeholder="Credential name"
                                    value={credFixForm.name}
                                    onChange={(e) => setCredFixForm((f) => ({ ...f, name: e.target.value }))}
                                  />
                                  <input
                                    className="w-full rounded-md border bg-background px-2 py-1 text-xs"
                                    placeholder="Service type (e.g. http, slack, google)"
                                    value={credFixForm.serviceType}
                                    onChange={(e) => setCredFixForm((f) => ({ ...f, serviceType: e.target.value }))}
                                  />
                                  <input
                                    className="w-full rounded-md border bg-background px-2 py-1 text-xs"
                                    type="password"
                                    placeholder="Secret value (stored encrypted)"
                                    value={credFixForm.secret}
                                    onChange={(e) => setCredFixForm((f) => ({ ...f, secret: e.target.value }))}
                                  />
                                  {credFixError ? <div className="text-[11px] text-destructive">{credFixError}</div> : null}
                                  <div className="flex items-center gap-2">
                                    <Button size="sm" className="h-7 px-3 text-[11px]" disabled={credFixSaving} onClick={() => void submitCredentialFix()}>
                                      {credFixSaving ? "Saving…" : "Save & attach"}
                                    </Button>
                                    <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px]" disabled={credFixSaving} onClick={() => { setCredFixNodeId(null); setCredFixError(""); }}>
                                      Cancel
                                    </Button>
                                  </div>
                                </div>
                              ) : null}
                            </div>
                          ))}
                        {debuggerData.credentialHealth.items.filter((item) => item.status !== "not_required").length === 0 ? (
                          <div className="text-xs text-muted-foreground">No credential-dependent nodes detected.</div>
                        ) : null}
                      </div>
                    </div>
                    <div className="rounded-md border p-3">
                      <div className="mb-2 text-sm font-semibold">Node Config</div>
                      <div className="space-y-2">
                        {debuggerData.nodeConfig
                          .filter((item) => !item.valid || item.warnings.length > 0)
                          .slice(0, 8)
                          .map((item) => {
                            const detail = item.missingFields.length > 0 ? `Missing: ${item.missingFields.join(", ")}` : item.warnings.join(" ");
                            return (
                            <div key={item.nodeId} className="flex items-start justify-between gap-2 text-xs">
                              <div className="min-w-0">
                                <div className="font-medium">{item.nodeType}</div>
                                <div className="text-muted-foreground">{detail}</div>
                              </div>
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-6 shrink-0 px-2 text-[10px]"
                                onClick={() =>
                                  openWorkflowPromptInWebChat(
                                    `Fix the configuration of node "${item.nodeType}" (id ${item.nodeId}) in workflow "${debuggerData.workflow.name}" (id ${debuggerData.workflow.id}). Debugger reports: ${detail}. Propose the corrected config and explain it before applying.`,
                                  )
                                }
                                title="Open WebChat with this node's config issue prefilled"
                              >
                                Ask WebChat to fix
                              </Button>
                            </div>
                            );
                          })}
                        {debuggerData.nodeConfig.filter((item) => !item.valid || item.warnings.length > 0).length === 0 ? (
                          <div className="text-xs text-muted-foreground">Required node config checks passed.</div>
                        ) : null}
                      </div>
                    </div>
                  </div>

                  <div className="rounded-md border p-3">
                    <div className="mb-2 text-sm font-semibold">Slowest Nodes</div>
                    <div className="space-y-1">
                      {debuggerData.trace.bottlenecks.slice(0, 6).map((trace) => (
                        <div key={trace.nodeId} className="flex items-center justify-between text-xs">
                          <span>{trace.nodeName || trace.nodeId}</span>
                          <span className="text-muted-foreground">{trace.durationMs ?? 0} ms</span>
                        </div>
                      ))}
                      {debuggerData.trace.bottlenecks.length === 0 ? (
                        <div className="text-xs text-muted-foreground">No execution trace has been recorded yet.</div>
                      ) : null}
                    </div>
                  </div>
                </div>
              ) : null}
            </DialogContent>
          </Dialog>

          <Dialog open={resetAllOpen} onOpenChange={setResetAllOpen}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Reset Workflows</DialogTitle>
                <DialogDescription>
                  Delete all current workflows and cron schedules. This cannot be undone.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={() => setResetAllOpen(false)} disabled={resettingAll}>
                  Cancel
                </Button>
                <Button variant="destructive" onClick={() => void resetAllWorkflows()} disabled={resettingAll}>
                  {resettingAll ? "Resetting..." : "Delete All Workflows"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <Dialog
            open={Boolean(deleteWorkflowTarget)}
            onOpenChange={(open) => {
              if (!open) setDeleteWorkflowTarget(null);
            }}
          >
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Delete Workflow</DialogTitle>
                <DialogDescription>
                  Delete &quot;{deleteWorkflowTarget?.name ?? "this workflow"}&quot;. Execution history and linked task references may no longer point to a runnable workflow.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={() => setDeleteWorkflowTarget(null)} disabled={Boolean(deletingWorkflowId)}>
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => {
                    if (deleteWorkflowTarget) void deleteWorkflow(deleteWorkflowTarget.id);
                  }}
                  disabled={Boolean(deletingWorkflowId)}
                >
                  {deletingWorkflowId ? "Deleting..." : "Delete Workflow"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          {/* ── Agent Required Dialog ── */}
          <Dialog
            open={Boolean(agentRequiredTemplate)}
            onOpenChange={(open) => {
              if (!open) setAgentRequiredTemplate(null);
            }}
          >
            <DialogContent>
              <DialogHeader>
                <DialogTitle>This template needs an agent</DialogTitle>
                <DialogDescription>
                  <strong>{agentRequiredTemplate?.name ?? "This template"}</strong> requires at least one active agent.
                  Create one first, or choose a starter template that doesn&apos;t need agent slots.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter className="gap-2 sm:gap-0">
                <Button
                  variant="outline"
                  onClick={() => {
                    setAgentRequiredTemplate(null);
                    setTemplateCategory("starter");
                  }}
                >
                  View Starter Templates
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setAgentRequiredTemplate(null)}
                >
                  Cancel
                </Button>
                <Button
                  onClick={() => {
                    setAgentRequiredTemplate(null);
                    router.push("/agents?intent=template-agent-required");
                  }}
                >
                  Create Agent
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </main>
  );
}

export default function WorkflowsPage() {
  return (
    <Suspense>
      <WorkflowsPageInner />
    </Suspense>
  );
}
