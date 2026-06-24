"use client";

import { useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Search, X } from "lucide-react";
import {
  Zap,
  Webhook,
  Play,
  Bot,
  Send,
  MessageCircle,
  GitBranch,
  Brain,
  BookOpen,
  Terminal,
  Globe,
  Rss,
  GitFork,
  Timer,
  Variable,
  Filter,
  Mail,
  Clock,
  Workflow,
  Code2,
  FolderOpen,
  FilePen,
  Mic,
  Volume2,
  Repeat,
  Layers,
  Merge,
  ShieldAlert,
  MessageSquareMore,
  Braces,
  Scissors,
  ScanSearch,
  Diff,
  Gauge,
  Database,
  ClipboardCopy,
  Bell,
  GitCommitHorizontal,
  Archive,
  CalendarClock,
  RadioTower,
  Scale,
  StickyNote,
} from "lucide-react";
import type { NodePaletteItem } from "@/types/workflow";

const paletteItems: NodePaletteItem[] = [
  // Triggers
  {
    type: "message-trigger",
    category: "trigger",
    label: "Message Trigger",
    description: "Triggered by incoming messages",
    color: "#22c55e",
    icon: "Zap",
    defaultConfig: { channel: "webchat" },
  },
  {
    type: "webhook-trigger",
    category: "trigger",
    label: "Webhook Trigger",
    description: "Triggered by HTTP requests",
    color: "#22c55e",
    icon: "Webhook",
    defaultConfig: { path: "/webhook", method: "POST" },
  },
  {
    type: "github-trigger",
    category: "trigger",
    label: "GitHub Trigger",
    description: "Parses a GitHub webhook (PR/issue/push) into structured fields",
    color: "#6e7681",
    icon: "GitBranch",
    defaultConfig: { events: "pull_request" },
  },
  {
    type: "manual-trigger",
    category: "trigger",
    label: "Manual Trigger",
    description: "Triggered manually",
    color: "#22c55e",
    icon: "Play",
    defaultConfig: {},
  },
  {
    type: "cron-trigger",
    category: "trigger",
    label: "Cron Trigger",
    description: "Run on a schedule",
    color: "#22c55e",
    icon: "Clock",
    defaultConfig: { expression: "0 * * * *", timezone: "UTC" },
  },
  {
    type: "telegram-trigger",
    category: "trigger",
    label: "Telegram Trigger",
    description: "Triggered by Telegram messages",
    color: "#22c55e",
    icon: "Zap",
    defaultConfig: {},
  },
  {
    type: "discord-trigger",
    category: "trigger",
    label: "Discord Trigger",
    description: "Triggered by Discord messages",
    color: "#22c55e",
    icon: "Zap",
    defaultConfig: {},
  },
  // Agents
  {
    type: "claude-agent",
    category: "agent",
    label: "Agent",
    description: "AI agent powered by your configured model",
    color: "#a855f7",
    icon: "Bot",
    defaultConfig: {
      systemPrompt: "You are a helpful AI assistant.",
      temperature: 0.7,
      maxTokens: 1024,
      approvalMode: "human",
      execSecurity: "full",
      execAsk: "on-miss",
      execAllowlist: "",
      memoryAccess: "workflow",
    },
  },
  {
    type: "parallel-agents",
    category: "agent",
    label: "Parallel Agents",
    description: "Run multiple agent workers concurrently",
    color: "#a855f7",
    icon: "GitFork",
    defaultConfig: {
      taskTemplate: "{{trigger.message}}",
      maxParallel: 2,
      workers: [
        {
          roleKey: "workerA",
          label: "Worker A",
          agentId: "",
          taskTemplate: "{{trigger.message}}",
          systemPrompt:
            "You are Worker A. Focus on your assigned part of the task and return concise findings.",
          maxTokens: 900,
          temperature: 0.4,
        },
        {
          roleKey: "workerB",
          label: "Worker B",
          agentId: "",
          taskTemplate: "{{trigger.message}}",
          systemPrompt:
            "You are Worker B. Focus on your assigned part of the task and return concise findings.",
          maxTokens: 900,
          temperature: 0.4,
        },
      ],
    },
  },
  {
    type: "call-workflow",
    category: "agent",
    label: "Call Workflow",
    description: "Execute another workflow",
    color: "#a855f7",
    icon: "Workflow",
    defaultConfig: { workflowId: "" },
  },
  {
    type: "spawn-coding-agent",
    category: "agent",
    label: "Spawn Coding Agent",
    description: "Delegate to Claude Code, Gemini CLI, or Codex on this machine",
    color: "#06b6d4",
    icon: "Terminal",
    defaultConfig: {
      agent: "claude",
      mode: "run",
      task: "{{message.text}}",
      maxBudgetUsd: 0.10,
      timeoutMs: 120000,
    },
  },
  // Channels
  {
    type: "send-webchat",
    category: "channel",
    label: "Send WebChat",
    description: "Send response via WebChat",
    color: "#f97316",
    icon: "Send",
    defaultConfig: {},
  },
  {
    type: "webhook-response",
    category: "channel",
    label: "Webhook Response",
    description: "Return an HTTP response from a webhook workflow",
    color: "#f97316",
    icon: "Webhook",
    defaultConfig: { statusCode: 200, body: "{\"success\":true}", headers: "{}" },
  },
  {
    type: "send-whatsapp",
    category: "channel",
    label: "Send WhatsApp",
    description: "Send response via WhatsApp",
    color: "#f97316",
    icon: "MessageCircle",
    defaultConfig: {},
  },
  {
    type: "send-telegram",
    category: "channel",
    label: "Send Telegram",
    description: "Send via Telegram bot",
    color: "#0088cc",
    icon: "Send",
    defaultConfig: {},
  },
  {
    type: "send-discord",
    category: "channel",
    label: "Send Discord",
    description: "Post to Discord channel",
    color: "#5865f2",
    icon: "Send",
    defaultConfig: {},
  },
  {
    type: "send-email",
    category: "channel",
    label: "Send Email",
    description: "Send an email via SMTP",
    color: "#ec4899",
    icon: "Mail",
    defaultConfig: { host: "smtp.gmail.com", port: 587, secure: false, subject: "Message from disp8ch" },
  },
  {
    type: "send-sms",
    category: "channel",
    label: "Send SMS",
    description: "Send an SMS text message",
    color: "#16a34a",
    icon: "MessageCircle",
    defaultConfig: { to: "", message: "{{agent.response}}", mockMode: true },
  },
  {
    type: "github-comment",
    category: "channel",
    label: "GitHub Comment",
    description: "Post a comment to a GitHub issue or pull request",
    color: "#6e7681",
    icon: "MessageSquare",
    defaultConfig: { repo: "owner/name", issueNumber: "{{github-trigger.number}}", body: "{{agent.response}}", mockMode: true },
  },
  {
    type: "send-slack",
    category: "channel",
    label: "Send Slack",
    description: "Post to a Slack channel",
    color: "#4a154b",
    icon: "Send",
    defaultConfig: {},
  },
  {
    type: "send-bluebubbles",
    category: "channel",
    label: "Send BlueBubbles",
    description: "Send to an iMessage / BlueBubbles chat",
    color: "#2563eb",
    icon: "MessageCircle",
    defaultConfig: {},
  },
  {
    type: "send-teams",
    category: "channel",
    label: "Send Teams",
    description: "Reply into a Microsoft Teams conversation",
    color: "#5b5fc7",
    icon: "Send",
    defaultConfig: {},
  },
  // Logic
  {
    type: "if-else",
    category: "logic",
    label: "If/Else",
    description: "Conditional branching",
    color: "#6b7280",
    icon: "GitBranch",
    defaultConfig: { condition: "" },
  },
  {
    type: "switch",
    category: "logic",
    label: "Switch",
    description: "Multi-branch routing",
    color: "#6b7280",
    icon: "GitFork",
    defaultConfig: { expression: "", cases: [] },
  },
  {
    type: "delay",
    category: "logic",
    label: "Delay",
    description: "Pause execution",
    color: "#6b7280",
    icon: "Timer",
    defaultConfig: { duration: 1000 },
  },
  {
    type: "set-variables",
    category: "logic",
    label: "Set Variables",
    description: "Set context variables",
    color: "#6b7280",
    icon: "Variable",
    defaultConfig: { assignments: [] },
  },
  {
    type: "filter",
    category: "logic",
    label: "Filter",
    description: "Stop if condition fails",
    color: "#6b7280",
    icon: "Filter",
    defaultConfig: { condition: "true" },
  },
  // Memory
  {
    type: "memory-recall",
    category: "memory",
    label: "Memory Recall",
    description: "Search stored memories",
    color: "#f59e0b",
    icon: "BookOpen",
    defaultConfig: { query: "{{trigger.message}}", limit: 5, memoryAccess: "workflow" },
  },
  {
    type: "memory-store",
    category: "memory",
    label: "Memory Store",
    description: "Store new memories",
    color: "#f59e0b",
    icon: "Brain",
    defaultConfig: { extractMode: "auto", memoryAccess: "workflow" },
  },
  // Tools
  {
    type: "sticky-note",
    category: "tool",
    label: "Sticky Note",
    description: "Document a canvas section without changing the workflow",
    color: "#facc15",
    icon: "StickyNote",
    defaultConfig: { note: "Add notes, assumptions, or setup steps here." },
  },
  {
    type: "system-command",
    category: "tool",
    label: "System Command",
    description: "Run built-in local tools (PC specs/files)",
    color: "#06b6d4",
    icon: "Terminal",
    defaultConfig: {
      action: "pc-specs",
      path: ".",
      maxEntries: 20,
      timeoutMs: 15000,
    },
  },
  {
    type: "http-request",
    category: "tool",
    label: "HTTP Request",
    description: "Call any external API",
    color: "#0ea5e9",
    icon: "Globe",
    defaultConfig: { url: "", method: "GET", headers: "", body: "" },
  },
  {
    type: "rss-read",
    category: "tool",
    label: "RSS Read",
    description: "Fetch items from an RSS/Atom feed",
    color: "#f97316",
    icon: "Rss",
    defaultConfig: { url: "", limit: 10, sinceHours: 0 },
  },
  {
    type: "run-code",
    category: "tool",
    label: "Run Code",
    description: "Execute JavaScript in sandbox",
    color: "#06b6d4",
    icon: "Code2",
    defaultConfig: { code: "result = input;", timeout: 5000 },
  },
  {
    type: "read-file",
    category: "tool",
    label: "Read File",
    description: "Read a file from disk",
    color: "#06b6d4",
    icon: "FolderOpen",
    defaultConfig: { path: "", encoding: "utf-8" },
  },
  {
    type: "write-file",
    category: "tool",
    label: "Write File",
    description: "Write content to a file",
    color: "#06b6d4",
    icon: "FilePen",
    defaultConfig: { path: "", mode: "overwrite" },
  },
  {
    type: "board-task",
    category: "tool",
    label: "Board Task",
    description: "List, create, update, or delete board tasks",
    color: "#06b6d4",
    icon: "GitBranch",
    defaultConfig: { action: "list", boardId: "main-board", limit: 10 },
  },
  {
    type: "document-tool",
    category: "tool",
    label: "Document Tool",
    description: "List, search, read, scrape, or delete documents",
    color: "#06b6d4",
    icon: "BookOpen",
    defaultConfig: { action: "list", limit: 10, strategy: "static", maxPages: 12, maxDepth: 1 },
  },
  {
    type: "workflow-template",
    category: "tool",
    label: "Workflow Template",
    description: "List templates or create workflows from templates",
    color: "#06b6d4",
    icon: "Workflow",
    defaultConfig: { action: "list-templates" },
  },
  {
    type: "scheduler-job",
    category: "tool",
    label: "Scheduler",
    description: "List, run, or resync scheduled workflows",
    color: "#06b6d4",
    icon: "Clock",
    defaultConfig: { action: "list" },
  },
  // Integrations
  {
    type: "integration-agent",
    category: "integration",
    label: "Integration Agent",
    description: "Generic AI-powered API/integration node for unsupported services",
    color: "#0f766e",
    icon: "Bot",
    defaultConfig: {
      serviceName: "Custom API",
      objective: "{{trigger.message}}",
      baseUrl: "",
      authHeaderName: "Authorization",
      authScheme: "Bearer",
      authToken: "",
      enabledTools: ["http_request"],
      temperature: 0.2,
      maxTokens: 1200,
    },
  },
  {
    type: "google-sheets",
    category: "integration",
    label: "Google Sheets",
    description: "Read, append, or update rows in Google Sheets",
    color: "#16a34a",
    icon: "Database",
    defaultConfig: {
      action: "read",
      spreadsheetId: "",
      range: "Sheet1!A:Z",
      valueInputOption: "USER_ENTERED",
      valuesJson: "[]",
    },
  },
  {
    type: "notion",
    category: "integration",
    label: "Notion",
    description: "Query databases and create pages in Notion",
    color: "#111827",
    icon: "BookOpen",
    defaultConfig: {
      action: "query-database",
      apiKey: "",
      databaseId: "",
      pageId: "",
      queryJson: "{}",
      propertiesJson: "{}",
    },
  },
  {
    type: "airtable",
    category: "integration",
    label: "Airtable",
    description: "List, create, and update Airtable records",
    color: "#f59e0b",
    icon: "Layers",
    defaultConfig: {
      action: "list-records",
      apiKey: "",
      baseId: "",
      table: "",
      recordId: "",
      fieldsJson: "{}",
      maxRecords: 20,
    },
  },
  // Voice
  {
    type: "voice-stt",
    category: "voice",
    label: "Speech → Text",
    description: "Transcribe audio via Whisper",
    color: "#14b8a6",
    icon: "Mic",
    defaultConfig: { language: "", model: "whisper-1" },
  },
  {
    type: "voice-tts",
    category: "voice",
    label: "Text → Speech",
    description: "Generate speech via OpenAI TTS",
    color: "#14b8a6",
    icon: "Volume2",
    defaultConfig: { voice: "alloy", model: "tts-1", speed: 1.0 },
  },
  // Advanced Logic
  {
    type: "loop",
    category: "advanced-logic",
    label: "Loop",
    description: "Iterate over an array of items",
    color: "#8b5cf6",
    icon: "Repeat",
    defaultConfig: { sourcePath: "" },
  },
  {
    type: "aggregate",
    category: "advanced-logic",
    label: "Aggregate",
    description: "Collect items into a single array",
    color: "#8b5cf6",
    icon: "Layers",
    defaultConfig: {},
  },
  {
    type: "merge",
    category: "advanced-logic",
    label: "Merge",
    description: "Combine multiple branch outputs",
    color: "#6b7280",
    icon: "Merge",
    defaultConfig: {},
  },
  {
    type: "error-handler",
    category: "advanced-logic",
    label: "Error Handler",
    description: "Catch errors from upstream nodes",
    color: "#ef4444",
    icon: "ShieldAlert",
    defaultConfig: {},
  },
  {
    type: "wait-for-input",
    category: "advanced-logic",
    label: "Wait for Input",
    description: "Pause and wait for user response",
    color: "#f97316",
    icon: "MessageSquareMore",
    defaultConfig: { prompt: "Waiting for your input...", timeout: 60000 },
  },
  {
    type: "rate-limiter",
    category: "advanced-logic",
    label: "Rate Limiter",
    description: "Throttle execution frequency",
    color: "#6b7280",
    icon: "Gauge",
    defaultConfig: { key: "default", maxCalls: 10, windowMs: 60000 },
  },
  // Advanced Data
  {
    type: "json-transform",
    category: "advanced-data",
    label: "JSON Transform",
    description: "Map, filter, reshape JSON data",
    color: "#06b6d4",
    icon: "Braces",
    defaultConfig: { expression: "result = input;" },
  },
  {
    type: "split-text",
    category: "advanced-data",
    label: "Split Text",
    description: "Split text into chunks",
    color: "#06b6d4",
    icon: "Scissors",
    defaultConfig: { mode: "separator", separator: "\\n", chunkSize: 1000 },
  },
  {
    type: "regex-extract",
    category: "advanced-data",
    label: "Regex Extract",
    description: "Extract patterns from text",
    color: "#06b6d4",
    icon: "ScanSearch",
    defaultConfig: { pattern: "", flags: "g" },
  },
  {
    type: "compare-text",
    category: "advanced-data",
    label: "Compare Text",
    description: "Diff two texts line by line",
    color: "#06b6d4",
    icon: "Diff",
    defaultConfig: { textA: "", textB: "" },
  },
  // Advanced Tools
  {
    type: "database-query",
    category: "advanced-tool",
    label: "Database Query",
    description: "Run SQL against SQLite database",
    color: "#06b6d4",
    icon: "Database",
    defaultConfig: { query: "", dbPath: "" },
  },
  {
    type: "clipboard",
    category: "advanced-tool",
    label: "Clipboard",
    description: "Read or write system clipboard",
    color: "#06b6d4",
    icon: "ClipboardCopy",
    defaultConfig: { action: "read" },
  },
  {
    type: "notification",
    category: "advanced-tool",
    label: "Notification",
    description: "Show desktop notification",
    color: "#f97316",
    icon: "Bell",
    defaultConfig: { title: "disp8ch", message: "" },
  },
  {
    type: "git-operation",
    category: "advanced-tool",
    label: "Git Operation",
    description: "Run git commands with structured output",
    color: "#06b6d4",
    icon: "GitCommitHorizontal",
    defaultConfig: { action: "status", repoPath: "." },
  },
  {
    type: "archive",
    category: "advanced-tool",
    label: "Archive",
    description: "Create or extract zip archives",
    color: "#06b6d4",
    icon: "Archive",
    defaultConfig: { action: "create", archivePath: "", sourcePath: "" },
  },
  {
    type: "date-time",
    category: "tool",
    label: "Date & Time",
    description: "Format or shift dates and timestamps",
    color: "#06b6d4",
    icon: "CalendarClock",
    defaultConfig: { operation: "now", timezone: "UTC", locale: "en-US", outputStyle: "datetime" },
  },
  {
    type: "channel-status",
    category: "tool",
    label: "Channel Status",
    description: "Inspect runtime status for all configured channels",
    color: "#06b6d4",
    icon: "RadioTower",
    defaultConfig: { format: "summary" },
  },
  {
    type: "council",
    category: "tool",
    label: "Council",
    description: "Run a multi-agent council decision inside a workflow",
    color: "#06b6d4",
    icon: "Scale",
    defaultConfig: {
      topic: "{{trigger.message}}",
      optionsText: "Approve\nRevise\nReject",
      decisionMode: "majority",
      agentIds: "",
    },
  },
];

const iconMap: Record<string, React.ElementType> = {
  Zap,
  Webhook,
  Play,
  Bot,
  Send,
  MessageCircle,
  GitBranch,
  Brain,
  BookOpen,
  Terminal,
  Globe,
  Rss,
  GitFork,
  Timer,
  Variable,
  Filter,
  Mail,
  Clock,
  Workflow,
  Code2,
  FolderOpen,
  FilePen,
  Mic,
  Volume2,
  Repeat,
  Layers,
  Merge,
  ShieldAlert,
  MessageSquareMore,
  Braces,
  Scissors,
  ScanSearch,
  Diff,
  Gauge,
  Database,
  ClipboardCopy,
  Bell,
  GitCommitHorizontal,
  Archive,
  CalendarClock,
  RadioTower,
  Scale,
  StickyNote,
};

const categories = [
  { key: "trigger", label: "Triggers" },
  { key: "agent", label: "Agents" },
  { key: "channel", label: "Channels" },
  { key: "logic", label: "Logic" },
  { key: "memory", label: "Memory" },
  { key: "tool", label: "Tools" },
  { key: "integration", label: "Integrations" },
  { key: "voice", label: "Voice" },
  { key: "advanced-logic", label: "Advanced Logic" },
  { key: "advanced-data", label: "Data Processing" },
  { key: "advanced-tool", label: "Advanced Tools" },
];

export function NodePalette() {
  const [query, setQuery] = useState("");

  const filterItem = (item: NodePaletteItem) => {
    if (!query.trim()) return true;
    const q = query.trim().toLowerCase();
    return (
      item.label.toLowerCase().includes(q) ||
      item.type.toLowerCase().includes(q) ||
      (item.description?.toLowerCase().includes(q) ?? false) ||
      item.category.toLowerCase().includes(q)
    );
  };

  // Pre-compute visible category counts so we can hide empties at search time.
  const visibleByCategory = useMemo(() => {
    const map = new Map<string, NodePaletteItem[]>();
    for (const item of paletteItems) {
      if (!filterItem(item)) continue;
      const list = map.get(item.category) ?? [];
      list.push(item);
      map.set(item.category, list);
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const totalMatches = useMemo(() => {
    let n = 0;
    for (const list of visibleByCategory.values()) n += list.length;
    return n;
  }, [visibleByCategory]);

  const onDragStart = (
    event: React.DragEvent,
    item: NodePaletteItem
  ) => {
    event.dataTransfer.setData("application/reactflow", item.type);
    event.dataTransfer.setData("label", item.label);
    event.dataTransfer.setData("defaultConfig", JSON.stringify(item.defaultConfig));
    event.dataTransfer.effectAllowed = "move";
  };

  return (
    <div className="flex h-full w-[220px] flex-col border-r bg-card">
      <div className="px-3 py-3 font-semibold text-sm flex items-center justify-between">
        <span>Nodes</span>
        {query ? (
          <span className="text-[10px] font-normal text-muted-foreground">
            {totalMatches} match{totalMatches === 1 ? "" : "es"}
          </span>
        ) : null}
      </div>
      <div className="px-2 pb-2">
        <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Search nodes</div>
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search nodes…"
            className="h-7 pl-7 pr-7 text-xs"
            aria-label="Filter node palette"
          />
          {query ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setQuery("")}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          ) : null}
        </div>
      </div>
      <Separator />
      <ScrollArea className="flex-1">
        <div className="p-2 space-y-3">
          {query && totalMatches === 0 ? (
            <div className="text-xs text-muted-foreground px-2 py-4 text-center">
              No nodes match &quot;{query}&quot;.
            </div>
          ) : null}
          {categories.map((cat) => {
            const items = visibleByCategory.get(cat.key) ?? [];
            if (items.length === 0) return null;
            return (
              <div key={cat.key}>
                <div className="px-2 py-1 text-xs font-medium text-muted-foreground uppercase">
                  {cat.label}
                </div>
                <div className="space-y-1">
                  {items.map((item) => {
                    const Icon = iconMap[item.icon] || Zap;
                    return (
                      <div
                        key={item.type}
                        draggable
                        onDragStart={(e) => onDragStart(e, item)}
                        className="flex cursor-grab items-center gap-2 rounded-md border px-2 py-1.5 text-sm transition-colors hover:bg-accent active:cursor-grabbing"
                        title={item.description ?? item.label}
                      >
                        <div
                          className="flex h-5 w-5 items-center justify-center rounded"
                          style={{ backgroundColor: item.color }}
                        >
                          <Icon className="h-3 w-3 text-white" />
                        </div>
                        <span className="text-xs truncate">{item.label}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}
