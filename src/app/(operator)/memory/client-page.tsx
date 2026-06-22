"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAfterUseful } from "@/lib/client/use-after-useful";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type DailyMemoryItem = {
  path: string;
  date: string;
  bytes: number;
  words: number;
  entries: number;
  updatedAtMs: number;
  preview: string;
};

type MemoryType =
  | "fact"
  | "preference"
  | "entity"
  | "decision"
  | "correction"
  | "relationship"
  | "skill"
  | "observation"
  | "profile"
  | "event"
  | "knowledge"
  | "behavior"
  | "tool";

type MemoryEntry = {
  id: string;
  type: MemoryType;
  content: string;
  confidence: number;
  source: string;
  tags: string[];
  created: string;
  updated: string;
  whenToUse?: string;
  happenedAt?: string;
};

type MemoryRollup = {
  id: string;
  title: string;
  summary: string;
  itemCount: number;
  items: Array<{
    id: string;
    content: string;
    type: string;
    refs: string[];
    whenToUse?: string;
    happenedAt?: string;
  }>;
};

type MemoryStats = {
  totalMemories: number;
  storageBytes: number;
  embeddingModel: string | null;
  vectorIndexed: number;
  sessionChunks: number;
};

type MemoryPathContext = {
  id: string;
  pathPrefix: string;
  contextText: string;
  createdAt: string;
  updatedAt: string;
};

type DocumentLite = {
  id: string;
  sourceType: "upload" | "scrape" | "integration";
  name: string;
  sourceUrl: string | null;
  excerpt?: string;
  createdAt?: string;
};

type AgentSkillState = {
  enabledSkills: string[];
  enabledExtensions: string[];
  skills: Array<{
    id: string;
    label: string;
    description: string;
    enabled: boolean;
    extensionId?: string | null;
  }>;
  extensions: Array<{
    id: string;
    name: string;
    description: string;
    enabled: boolean;
    globallyEnabled?: boolean;
  }>;
};

type SearchResult = {
  id?: string;
  path: string;
  type?: string;
  content: string;
  score: number;
  source: "atomic" | "workspace" | "session" | "collection";
  confidence?: number;
  reinforcementCount?: number;
  lastReinforcedAt?: string;
  startLine?: number;
  endLine?: number;
  contextText?: string;
};

type SearchDiagnostics = {
  query: string;
  strongSignal: boolean;
  rewrittenQuery?: string | null;
  expandedQueries: string[];
  candidateCount: number;
  sourceCounts: Record<string, number>;
  rerankStrategy?: string;
  searchPolicy?: {
    backend: string;
    rerankStrategy: string;
    queryExpansionEnabled: boolean;
    strongSignalEnabled: boolean;
    rerankCandidateLimit: number;
  };
  providerPlan?: {
    configured: string;
    actualMode: string;
    selected?: {
      provider: string;
      modelId: string;
      source: string;
    } | null;
  };
  explain?: {
    searchBackend: string;
    fusedListCount: number;
    preFilterCandidates: number;
    postFilterCandidates: number;
    chunkedRerank: boolean;
    positionAwareBlend: boolean;
    backendDefaultRerank: string;
    autoResolvedStrategy: string;
    expansionSkipped: boolean;
  };
};

const USER_MEMORY_TYPES = new Set<MemoryType>([
  "profile",
  "preference",
  "fact",
  "decision",
  "correction",
  "relationship",
  "entity",
  "event",
  "knowledge",
]);

const AGENT_MEMORY_TYPES = new Set<MemoryType>(["observation", "behavior", "tool", "skill"]);
const MEMORY_UI_STATE_KEY = "disp8ch-memory-ui-state";

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[idx]}`;
}

function formatDateTime(value?: string | number | null): string {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString();
}

function truncate(value: string, max = 180): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function scoreTone(score: number): string {
  if (score >= 0.85) return "default";
  if (score >= 0.55) return "secondary";
  return "outline";
}

function memoryBucketLabel(type: MemoryType): string {
  return USER_MEMORY_TYPES.has(type) ? "user" : "agent";
}

export default function MemoryPage() {
  const [items, setItems] = useState<DailyMemoryItem[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [memoryEntries, setMemoryEntries] = useState<MemoryEntry[]>([]);
  const [rollups, setRollups] = useState<MemoryRollup[]>([]);
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [pathContexts, setPathContexts] = useState<MemoryPathContext[]>([]);
  const [documents, setDocuments] = useState<DocumentLite[]>([]);
  const [agentSkills, setAgentSkills] = useState<AgentSkillState | null>(null);
  const [activeTab, setActiveTab] = useState("user");
  const [entryFilter, setEntryFilter] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [documentResults, setDocumentResults] = useState<DocumentLite[]>([]);
  const [diagnostics, setDiagnostics] = useState<SearchDiagnostics | null>(null);
  const [timelineEntries, setTimelineEntries] = useState<MemoryEntry[]>([]);
  const [timelineTypes, setTimelineTypes] = useState<string[]>([]);
  const [timelineTypeFilter, setTimelineTypeFilter] = useState("");
  const [timelineTotal, setTimelineTotal] = useState(0);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [showTimeline, setShowTimeline] = useState(false);
  const [maintenanceRunning, setMaintenanceRunning] = useState<string | null>(null);
  const [maintenanceNotice, setMaintenanceNotice] = useState("");
  // Progressive disclosure: keep the technical health/maintenance controls (embedding
  // provider, index status, reindex/clear/export) collapsed by default.
  const [showMemoryAdvanced, setShowMemoryAdvanced] = useState(false);
  const [clearTestDialogOpen, setClearTestDialogOpen] = useState(false);
  const [hideGettingStarted, setHideGettingStarted] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const loadOverview = useCallback(async () => {
    setLoading(true);
    try {
      const [
        journalResponse,
        rollupResponse,
        memoryResponse,
        statsResponse,
        pathContextsResponse,
        documentsResponse,
        skillsResponse,
      ] = await Promise.all([
        fetch("/api/memory?action=journal"),
        fetch("/api/memory?action=rollups&limit=6"),
        fetch("/api/memory"),
        fetch("/api/memory?action=stats"),
        fetch("/api/memory?action=path-contexts"),
        fetch("/api/documents?limit=12"),
        fetch("/api/agents/skills"),
      ]);
      const [
        journalJson,
        rollupJson,
        memoryJson,
        statsJson,
        pathContextsJson,
        documentsJson,
        skillsJson,
      ] = await Promise.all([
        journalResponse.json(),
        rollupResponse.json(),
        memoryResponse.json(),
        statsResponse.json(),
        pathContextsResponse.json(),
        documentsResponse.json(),
        skillsResponse.json(),
      ]);
      const nextItems = (journalJson.data ?? []) as DailyMemoryItem[];
      setItems(nextItems);
      setRollups(((rollupJson.data ?? []) as MemoryRollup[]).filter(Boolean));
      setMemoryEntries(((memoryJson.data ?? []) as MemoryEntry[]).filter(Boolean));
      setStats((statsJson.data ?? null) as MemoryStats | null);
      setPathContexts(((pathContextsJson.data ?? []) as MemoryPathContext[]).filter(Boolean));
      setDocuments(((documentsJson.data ?? []) as DocumentLite[]).filter(Boolean));
      setAgentSkills((skillsJson.data ?? null) as AgentSkillState | null);
      if (!selectedPath || !nextItems.some((entry) => entry.path === selectedPath)) {
        setSelectedPath(nextItems[0]?.path ?? null);
      }
    } catch {
      // no-op
    } finally {
      setLoading(false);
    }
  }, [selectedPath]);

  const loadFile = useCallback(async (path: string) => {
    try {
      const response = await fetch(`/api/memory?action=get&path=${encodeURIComponent(path)}`);
      const json = await response.json();
      if (!json.success) return;
      setContent(String(json.data?.text ?? ""));
    } catch {
      // no-op
    }
  }, []);

  const runSearch = useCallback(async () => {
    const query = searchQuery.trim();
    if (!query) {
      setSearchResults([]);
      setDocumentResults([]);
      setDiagnostics(null);
      return;
    }
    setSearchLoading(true);
    try {
      const [memoryResponse, documentResponse] = await Promise.all([
        fetch(`/api/memory?action=search&query=${encodeURIComponent(query)}&limit=8&mode=gpt&debug=1`),
        fetch(`/api/documents?q=${encodeURIComponent(query)}&limit=6`),
      ]);
      const [memoryJson, documentJson] = await Promise.all([
        memoryResponse.json(),
        documentResponse.json(),
      ]);
      setSearchResults(((memoryJson.data ?? []) as SearchResult[]).filter(Boolean));
      setDiagnostics((memoryJson.diagnostics ?? null) as SearchDiagnostics | null);
      setDocumentResults(((documentJson.data ?? []) as DocumentLite[]).filter(Boolean));
    } catch {
      // no-op
    } finally {
      setSearchLoading(false);
    }
  }, [searchQuery]);

  const loadTimeline = useCallback(async (typeFilter = "") => {
    setTimelineLoading(true);
    try {
      const url = `/api/memory?action=timeline&limit=100${typeFilter ? `&type=${encodeURIComponent(typeFilter)}` : ""}`;
      const res = await fetch(url);
      const json = await res.json() as { success: boolean; data?: { entries: MemoryEntry[]; types: string[]; total: number } };
      if (json.success && json.data) {
        setTimelineEntries(json.data.entries);
        setTimelineTypes(json.data.types);
        setTimelineTotal(json.data.total);
      }
    } catch {
      // no-op
    } finally {
      setTimelineLoading(false);
    }
  }, []);

  const testMemoryTargets = useMemo(() => memoryEntries.filter((entry) => {
    const haystack = `${entry.source} ${entry.tags.join(" ")} ${entry.content}`.toLowerCase();
    return haystack.includes("test") || haystack.includes("fixture") || haystack.includes("regression");
  }), [memoryEntries]);

  const runMaintenanceAction = useCallback(async (action: "index-sessions" | "index-collections" | "clear-test" | "export-audit") => {
    setMaintenanceRunning(action);
    setMaintenanceNotice("");
    try {
      if (action === "export-audit") {
        const payload = {
          exportedAt: new Date().toISOString(),
          stats,
          diagnostics,
          memoryEntries,
          rollups,
          documents,
          pathContexts,
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `memory-audit-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        setMaintenanceNotice("Memory audit exported.");
        return;
      }

      if (action === "clear-test") {
        await Promise.all(testMemoryTargets.map((entry) => fetch(`/api/memory?id=${encodeURIComponent(entry.id)}`, { method: "DELETE" })));
        await loadOverview();
        setClearTestDialogOpen(false);
        setMaintenanceNotice(`Cleared ${testMemoryTargets.length} test-like memory entr${testMemoryTargets.length === 1 ? "y" : "ies"}.`);
        return;
      }

      const response = await fetch(`/api/memory?action=${action}`, { cache: "no-store" });
      const json = await response.json();
      if (!json.success) {
        setMaintenanceNotice(`${action} failed: ${json.error || "unknown error"}`);
        return;
      }
      await loadOverview();
      setMaintenanceNotice(action === "index-sessions" ? "Session reindex complete." : "Document/resource reindex complete.");
    } catch (error) {
      setMaintenanceNotice(`Maintenance failed: ${String(error)}`);
    } finally {
      setMaintenanceRunning(null);
    }
  }, [diagnostics, documents, loadOverview, pathContexts, rollups, stats, testMemoryTargets]);

  useEffect(() => {
    if (showTimeline) void loadTimeline(timelineTypeFilter);
  }, [showTimeline, timelineTypeFilter, loadTimeline]);

  // Memory overview fans out to 7 endpoints; defer behind useful-ready so
  // /api/memory?action=* doesn't block first paint.
  useAfterUseful(() => {
    void loadOverview();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(MEMORY_UI_STATE_KEY);
      if (raw) setHideGettingStarted(Boolean((JSON.parse(raw) as { hideGettingStarted?: boolean }).hideGettingStarted));
    } catch {
      // keep default
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(MEMORY_UI_STATE_KEY, JSON.stringify({ hideGettingStarted }));
    } catch {
      // ignore storage failures
    }
  }, [hideGettingStarted]);

  useEffect(() => {
    if (!selectedPath) {
      setContent("");
      return;
    }
    void loadFile(selectedPath);
  }, [loadFile, selectedPath]);

  const selectedItem = useMemo(
    () => items.find((entry) => entry.path === selectedPath) ?? null,
    [items, selectedPath],
  );

  const filteredEntries = useMemo(() => {
    const needle = entryFilter.trim().toLowerCase();
    return memoryEntries.filter((entry) => {
      const bucketMatch =
        activeTab === "user"
          ? USER_MEMORY_TYPES.has(entry.type)
          : activeTab === "agent"
            ? AGENT_MEMORY_TYPES.has(entry.type)
            : true;
      if (!bucketMatch) return false;
      if (!needle) return true;
      const haystack = `${entry.type} ${entry.content} ${entry.tags.join(" ")}`.toLowerCase();
      return haystack.includes(needle);
    });
  }, [activeTab, entryFilter, memoryEntries]);

  const userEntries = useMemo(
    () => memoryEntries.filter((entry) => USER_MEMORY_TYPES.has(entry.type)),
    [memoryEntries],
  );
  const agentEntries = useMemo(
    () => memoryEntries.filter((entry) => AGENT_MEMORY_TYPES.has(entry.type)),
    [memoryEntries],
  );
  const enabledSkills = useMemo(
    () => (agentSkills?.skills ?? []).filter((skill) => skill.enabled),
    [agentSkills],
  );
  const enabledExtensions = useMemo(
    () => (agentSkills?.extensions ?? []).filter((extension) => extension.enabled),
    [agentSkills],
  );
  const summaryCards = useMemo(
    () => [
      { label: "User Memory", value: userEntries.length, meta: "preferences, facts, decisions" },
      { label: "Agent Memory", value: agentEntries.length, meta: "observations, tools, behavior" },
      { label: "Resources", value: pathContexts.length + documents.length + items.length, meta: "contexts, docs, journals" },
      { label: "Skills Context", value: enabledSkills.length, meta: `${enabledExtensions.length} enabled extensions` },
    ],
    [agentEntries.length, documents.length, enabledExtensions.length, enabledSkills.length, items.length, pathContexts.length, userEntries.length],
  );
  const hasMemoryContent = useMemo(
    () =>
      memoryEntries.length > 0 ||
      items.length > 0 ||
      rollups.length > 0 ||
      pathContexts.length > 0 ||
      documents.length > 0 ||
      enabledSkills.length > 0 ||
      enabledExtensions.length > 0,
    [documents.length, enabledExtensions.length, enabledSkills.length, items.length, memoryEntries.length, pathContexts.length, rollups.length],
  );
  const journalLines = useMemo(
    () =>
      content
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#")),
    [content],
  );
  const healthChips = useMemo(
    () => [
      {
        label: "Embedding Provider",
        value: stats?.embeddingModel || "fts fallback",
        tone: stats?.embeddingModel ? "default" : "secondary",
      },
      {
        label: "Session Index",
        value: `${stats?.sessionChunks ?? 0} chunks`,
        tone: (stats?.sessionChunks ?? 0) > 0 ? "default" : "secondary",
      },
      {
        label: "Vector Index",
        value: `${stats?.vectorIndexed ?? 0} indexed`,
        tone: (stats?.vectorIndexed ?? 0) > 0 ? "default" : "secondary",
      },
      {
        label: "Document Memory",
        value: `${documents.length} sources`,
        tone: documents.length > 0 ? "default" : "secondary",
      },
    ] as const,
    [documents.length, stats],
  );
  const cleanupCandidates = useMemo(() => {
    const duplicateContent = new Map<string, number>();
    memoryEntries.forEach((entry) => {
      const key = entry.content.trim().toLowerCase();
      if (!key) return;
      duplicateContent.set(key, (duplicateContent.get(key) ?? 0) + 1);
    });
    return memoryEntries
      .map((entry) => {
        const ageDays = Math.floor((Date.now() - new Date(entry.updated || entry.created).getTime()) / 86400000);
        const reasons = [
          entry.confidence < 0.45 ? "low confidence" : "",
          ageDays > 90 ? "stale" : "",
          entry.content.length > 1400 ? "oversized" : "",
          (duplicateContent.get(entry.content.trim().toLowerCase()) ?? 0) > 1 ? "duplicate" : "",
        ].filter(Boolean);
        return { entry, ageDays, reasons };
      })
      .filter((candidate) => candidate.reasons.length > 0)
      .slice(0, 8);
  }, [memoryEntries]);

  return (
<main className="flex-1 overflow-auto p-6" data-perf-ready="memory">
          <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-2xl font-bold">Memory & Context Explorer</h1>
              <p className="text-sm text-muted-foreground">
                Split user memory, agent memory, resources, and skills context. Search the live retrieval stack and inspect why memory or documents surfaced.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {stats ? (
                <>
                  <Badge variant="outline">{stats.totalMemories} memories</Badge>
                  <Badge variant="outline">{formatBytes(stats.storageBytes)}</Badge>
                  <Badge variant="outline">{stats.embeddingModel || "fts-only"}</Badge>
                </>
              ) : null}
              <Button variant="outline" size="sm" onClick={() => void loadOverview()} disabled={loading}>
                {loading ? "Refreshing..." : "Refresh"}
              </Button>
            </div>
          </div>

          {/* ── Getting Started panel (empty state) ── */}
          {!loading && !hasMemoryContent && (
            <div className="mb-4 border border-slate-600/60 bg-slate-800/40 p-5 space-y-4">
              {!hideGettingStarted ? (
                <>
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-[10px] font-mono uppercase tracking-widest text-slate-400">GETTING STARTED — MEMORY</div>
                    <Button variant="ghost" size="sm" onClick={() => setHideGettingStarted(true)}>Hide Tips</Button>
                  </div>
                  <p className="text-sm text-slate-300 max-w-2xl">
                    Memory is your AI&apos;s long-term knowledge store. Agents automatically extract and recall facts, preferences, and context across conversations. You can also store memories manually via chat or API.
                  </p>
                  <div className="grid gap-2 sm:grid-cols-3 text-[11px]">
                    <div className="border border-slate-700/60 p-3 space-y-1">
                      <div className="font-mono uppercase tracking-wide text-slate-400">How It Works</div>
                      <div className="text-slate-400">Agents use <strong className="text-slate-300">memory_store</strong> to save facts and <strong className="text-slate-300">memory_search</strong> to recall them. Memories are stored as markdown files in <strong className="text-slate-300">data/memories/</strong> with vector embeddings for semantic search.</div>
                    </div>
                    <div className="border border-slate-700/60 p-3 space-y-1">
                      <div className="font-mono uppercase tracking-wide text-slate-400">4 Context Tabs</div>
                      <ul className="list-disc list-inside space-y-0.5 text-slate-400">
                        <li><strong className="text-slate-300">User Memory</strong> — facts about you (preferences, context)</li>
                        <li><strong className="text-slate-300">Agent Memory</strong> — agent-scoped knowledge</li>
                        <li><strong className="text-slate-300">Resources</strong> — indexed documents and files</li>
                        <li><strong className="text-slate-300">Skills</strong> — operational skill context</li>
                      </ul>
                    </div>
                    <div className="border border-slate-700/60 p-3 space-y-1">
                      <div className="font-mono uppercase tracking-wide text-slate-400">Configure</div>
                      <div className="text-slate-400">Go to <strong className="text-slate-300">Settings - Memory</strong> to check memory health, run repairs, and configure optional collection paths for bulk document import.</div>
                    </div>
                  </div>
                </>
              ) : (
                <Button variant="outline" size="sm" onClick={() => setHideGettingStarted(false)}>Show Tips</Button>
              )}
            </div>
          )}

          <div className="mb-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {summaryCards.map((card) => (
              <Card key={card.label}>
                <CardContent className="pt-5">
                  <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                    {card.label}
                  </div>
                  <div className="mt-2 text-2xl font-semibold tabular-nums">{card.value}</div>
                  <div className="mt-1 text-xs text-muted-foreground">{card.meta}</div>
                </CardContent>
              </Card>
            ))}
          </div>

          <div className="mb-3">
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={() => setShowMemoryAdvanced((value) => !value)}
            >
              {showMemoryAdvanced
                ? "▾ Hide memory health & maintenance"
                : "▸ Memory health & maintenance — embedding/index status, reindex, clear, export (for power users)"}
            </Button>
          </div>

          {showMemoryAdvanced && (
          <div className="mb-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Memory Health</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {healthChips.map((chip) => (
                  <div key={chip.label} className="rounded-md border bg-muted/20 p-3">
                    <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">{chip.label}</div>
                    <Badge className="mt-2" variant={chip.tone as "default" | "secondary"}>{chip.value}</Badge>
                  </div>
                ))}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Maintenance Actions</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid gap-2 sm:grid-cols-2">
                  <Button variant="outline" size="sm" onClick={() => void runMaintenanceAction("index-sessions")} disabled={Boolean(maintenanceRunning)}>
                    {maintenanceRunning === "index-sessions" ? "Reindexing..." : "Reindex Sessions"}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => void runMaintenanceAction("index-collections")} disabled={Boolean(maintenanceRunning)}>
                    {maintenanceRunning === "index-collections" ? "Reindexing..." : "Reindex Documents"}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setClearTestDialogOpen(true)} disabled={Boolean(maintenanceRunning)}>
                    {maintenanceRunning === "clear-test" ? "Clearing..." : "Clear Test Memories"}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => void runMaintenanceAction("export-audit")} disabled={Boolean(maintenanceRunning)}>
                    Export Memory Audit
                  </Button>
                </div>
                {maintenanceNotice ? <div className="rounded-md border bg-muted/30 p-2 text-xs text-muted-foreground">{maintenanceNotice}</div> : null}
              </CardContent>
            </Card>
          </div>
          )}

          <Dialog open={clearTestDialogOpen} onOpenChange={setClearTestDialogOpen}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Clear Test Memories</DialogTitle>
                <DialogDescription>
                  Review this cleanup before deleting. It targets memories whose source, tags, or content mention test, fixture, or regression.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3 text-sm">
                <div className="rounded-md border bg-muted/30 p-3">
                  <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Matched Entries</div>
                  <div className="mt-1 text-2xl font-semibold tabular-nums">{testMemoryTargets.length}</div>
                  <div className="mt-1 text-xs text-muted-foreground">Export a memory audit first if you want an offline review trail.</div>
                </div>
                {testMemoryTargets.length > 0 ? (
                  <div className="max-h-44 space-y-2 overflow-auto rounded-md border p-2 text-xs text-muted-foreground">
                    {testMemoryTargets.slice(0, 8).map((entry) => (
                      <div key={entry.id} className="border-b border-border/60 pb-2 last:border-b-0 last:pb-0">
                        <div className="font-medium text-foreground">{entry.type} · {entry.source || "unknown source"}</div>
                        <div className="line-clamp-2">{entry.content}</div>
                      </div>
                    ))}
                    {testMemoryTargets.length > 8 ? <div>+ {testMemoryTargets.length - 8} more matched entries</div> : null}
                  </div>
                ) : (
                  <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">No matching test-like memories are currently loaded.</div>
                )}
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setClearTestDialogOpen(false)} disabled={Boolean(maintenanceRunning)}>Cancel</Button>
                <Button
                  variant="destructive"
                  onClick={() => void runMaintenanceAction("clear-test")}
                  disabled={Boolean(maintenanceRunning) || testMemoryTargets.length === 0}
                >
                  {maintenanceRunning === "clear-test" ? "Clearing..." : "Delete Matched Memories"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_420px]">
            <div className="space-y-4">
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Context Split</CardTitle>
                </CardHeader>
                <CardContent>
                  <Tabs value={activeTab} onValueChange={setActiveTab}>
                    <TabsList className="mb-4 grid h-auto w-full grid-cols-2 md:grid-cols-4">
                      <TabsTrigger value="user">User Memory</TabsTrigger>
                      <TabsTrigger value="agent">Agent Memory</TabsTrigger>
                      <TabsTrigger value="resources">Resources</TabsTrigger>
                      <TabsTrigger value="skills">Skills</TabsTrigger>
                    </TabsList>

                    <TabsContent value="user" className="space-y-4">
                      <Input
                        placeholder="Filter user memory..."
                        value={entryFilter}
                        onChange={(event) => setEntryFilter(event.target.value)}
                      />
                      <div className="space-y-3">
                        {filteredEntries.length === 0 ? (
                          <p className="text-sm text-muted-foreground">No user memory entries matched.</p>
                        ) : (
                          filteredEntries.map((entry) => (
                            <div key={entry.id} className="rounded-md border px-3 py-3">
                              <div className="mb-2 flex flex-wrap items-center gap-2">
                                <Badge variant="secondary">{entry.type}</Badge>
                                <Badge variant="outline">{memoryBucketLabel(entry.type)}</Badge>
                                <span className="text-xs text-muted-foreground">{formatDateTime(entry.updated)}</span>
                              </div>
                              <div className="text-sm whitespace-pre-wrap">{entry.content}</div>
                              <div className="mt-2 text-xs text-muted-foreground">
                                Confidence {entry.confidence.toFixed(2)}
                                {entry.happenedAt ? ` • Happened ${formatDateTime(entry.happenedAt)}` : ""}
                                {entry.tags.length > 0 ? ` • ${entry.tags.join(", ")}` : ""}
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                    </TabsContent>

                    <TabsContent value="agent" className="space-y-4">
                      <Input
                        placeholder="Filter agent memory..."
                        value={entryFilter}
                        onChange={(event) => setEntryFilter(event.target.value)}
                      />
                      <div className="space-y-3">
                        {filteredEntries.length === 0 ? (
                          <p className="text-sm text-muted-foreground">No agent memory entries matched.</p>
                        ) : (
                          filteredEntries.map((entry) => (
                            <div key={entry.id} className="rounded-md border px-3 py-3">
                              <div className="mb-2 flex flex-wrap items-center gap-2">
                                <Badge variant="secondary">{entry.type}</Badge>
                                <Badge variant="outline">{entry.source}</Badge>
                                {entry.whenToUse ? <Badge variant="outline">actionable</Badge> : null}
                              </div>
                              <div className="text-sm whitespace-pre-wrap">{entry.content}</div>
                              <div className="mt-2 text-xs text-muted-foreground">
                                {entry.whenToUse ? `Use when: ${entry.whenToUse}` : "No explicit when-to-use guidance yet."}
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                    </TabsContent>

                    <TabsContent value="resources" className="space-y-4">
                      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                        <Card>
                          <CardHeader className="pb-3">
                            <CardTitle className="text-sm">Path Contexts</CardTitle>
                          </CardHeader>
                          <CardContent className="space-y-3">
                            {pathContexts.length === 0 ? (
                              <p className="text-sm text-muted-foreground">No path contexts configured.</p>
                            ) : (
                              pathContexts.map((context) => (
                                <div key={context.id} className="rounded-md border px-3 py-2">
                                  <div className="text-xs font-medium text-foreground">{context.pathPrefix}</div>
                                  <div className="mt-1 text-xs text-muted-foreground">{truncate(context.contextText, 240)}</div>
                                </div>
                              ))
                            )}
                          </CardContent>
                        </Card>

                        <Card>
                          <CardHeader className="pb-3">
                            <CardTitle className="text-sm">Recent Documents</CardTitle>
                          </CardHeader>
                          <CardContent className="space-y-3">
                            {documents.length === 0 ? (
                              <p className="text-sm text-muted-foreground">No documents indexed yet.</p>
                            ) : (
                              documents.map((document) => (
                                <div key={document.id} className="rounded-md border px-3 py-2">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <div className="text-sm font-medium">{document.name}</div>
                                    <Badge variant="outline">{document.sourceType}</Badge>
                                  </div>
                                  <div className="mt-1 text-xs text-muted-foreground">{truncate(document.excerpt || document.sourceUrl || document.id, 220)}</div>
                                </div>
                              ))
                            )}
                          </CardContent>
                        </Card>
                      </div>

                      <Card>
                        <CardHeader className="pb-3">
                          <CardTitle className="text-sm">Daily Memory Files</CardTitle>
                        </CardHeader>
                        <CardContent className="grid gap-4 xl:grid-cols-[280px_minmax(0,1fr)]">
                          <div className="space-y-2">
                            {items.length === 0 ? (
                              <p className="text-sm text-muted-foreground">No daily memory files found.</p>
                            ) : (
                              items.map((entry) => (
                                <button
                                  key={entry.path}
                                  type="button"
                                  onClick={() => setSelectedPath(entry.path)}
                                  className={`w-full rounded-md border px-3 py-2 text-left transition ${
                                    selectedPath === entry.path ? "border-primary bg-muted/50" : "hover:bg-muted/40"
                                  }`}
                                >
                                  <div className="mb-1 flex items-center justify-between gap-2">
                                    <div className="font-medium text-sm">{entry.date}</div>
                                    <Badge variant="secondary">{entry.entries}</Badge>
                                  </div>
                                  <div className="text-xs text-muted-foreground">
                                    {formatBytes(entry.bytes)} • {entry.words} words
                                  </div>
                                </button>
                              ))
                            )}
                          </div>
                          <div className="space-y-3">
                            <div className="rounded-md border px-3 py-3">
                              <div className="mb-2 flex items-center justify-between gap-2">
                                <div className="font-medium text-sm">{selectedItem ? selectedItem.date : "Select a day"}</div>
                                {selectedItem ? <Badge variant="outline">{selectedItem.entries} entries</Badge> : null}
                              </div>
                              {!selectedItem ? (
                                <p className="text-sm text-muted-foreground">Choose a daily memory file from the left panel.</p>
                              ) : journalLines.length === 0 ? (
                                <p className="text-sm text-muted-foreground">No entries in this daily file yet.</p>
                              ) : (
                                <div className="space-y-2">
                                  {journalLines.slice(0, 8).map((line, index) => (
                                    <div key={`${selectedItem.path}:${index}`} className="rounded-md border px-3 py-2 text-sm whitespace-pre-wrap">
                                      {line}
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    </TabsContent>

                    <TabsContent value="skills" className="space-y-4">
                      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                        <Card>
                          <CardHeader className="pb-3">
                            <CardTitle className="text-sm">Enabled Skills</CardTitle>
                          </CardHeader>
                          <CardContent className="space-y-3">
                            {enabledSkills.length === 0 ? (
                              <p className="text-sm text-muted-foreground">No skill packs enabled for the default agent.</p>
                            ) : (
                              enabledSkills.map((skill) => (
                                <div key={skill.id} className="rounded-md border px-3 py-2">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <div className="text-sm font-medium">{skill.label}</div>
                                    <Badge variant="secondary">{skill.id}</Badge>
                                    {skill.extensionId ? <Badge variant="outline">{skill.extensionId}</Badge> : null}
                                  </div>
                                  <div className="mt-1 text-xs text-muted-foreground">{skill.description}</div>
                                </div>
                              ))
                            )}
                          </CardContent>
                        </Card>

                        <Card>
                          <CardHeader className="pb-3">
                            <CardTitle className="text-sm">Enabled Extensions</CardTitle>
                          </CardHeader>
                          <CardContent className="space-y-3">
                            {enabledExtensions.length === 0 ? (
                              <p className="text-sm text-muted-foreground">No extension packs enabled for the default agent.</p>
                            ) : (
                              enabledExtensions.map((extension) => (
                                <div key={extension.id} className="rounded-md border px-3 py-2">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <div className="text-sm font-medium">{extension.name}</div>
                                    <Badge variant="secondary">{extension.id}</Badge>
                                    {extension.globallyEnabled === false ? <Badge variant="outline">global off</Badge> : null}
                                  </div>
                                  <div className="mt-1 text-xs text-muted-foreground">{extension.description}</div>
                                </div>
                              ))
                            )}
                          </CardContent>
                        </Card>
                      </div>

                      <Card>
                        <CardHeader className="pb-3">
                          <CardTitle className="text-sm">Rollups</CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-3">
                          {rollups.length === 0 ? (
                            <p className="text-sm text-muted-foreground">No rollups available yet.</p>
                          ) : (
                            rollups.map((rollup) => (
                              <div key={rollup.id} className="rounded-md border px-3 py-3">
                                <div className="mb-2 flex items-center justify-between gap-2">
                                  <div className="font-medium text-sm">{rollup.title}</div>
                                  <Badge variant="outline">{rollup.itemCount}</Badge>
                                </div>
                                <div className="text-xs text-muted-foreground">{rollup.summary}</div>
                              </div>
                            ))
                          )}
                        </CardContent>
                      </Card>
                    </TabsContent>
                  </Tabs>
                </CardContent>
              </Card>
            </div>

            <div className="space-y-4">
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Retrieval Explain</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex gap-2">
                    <Input
                      value={searchQuery}
                      onChange={(event) => setSearchQuery(event.target.value)}
                      placeholder="Search memory and documents..."
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void runSearch();
                      }}
                    />
                    <Button onClick={() => void runSearch()} disabled={searchLoading}>
                      {searchLoading ? "Searching..." : "Search"}
                    </Button>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Runs memory search with diagnostics and a live document search in parallel so you can see why context surfaced.
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm">Cleanup Review Queue</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {cleanupCandidates.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No stale, duplicate, oversized, or low-confidence memory entries detected from the current load.</p>
                  ) : (
                    cleanupCandidates.map(({ entry, ageDays, reasons }) => (
                      <div key={entry.id} className="rounded-md border px-3 py-3">
                        <div className="mb-2 flex flex-wrap items-center gap-2">
                          <Badge variant="outline">{entry.type}</Badge>
                          <Badge variant="secondary">{reasons.join(", ")}</Badge>
                          <span className="text-xs text-muted-foreground">{ageDays}d old</span>
                        </div>
                        <div className="text-sm">{truncate(entry.content, 180)}</div>
                        <div className="mt-2 text-xs text-muted-foreground">
                          Manual review only in this pass. Use API maintenance for destructive cleanup.
                        </div>
                      </div>
                    ))
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm">Memory Results</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {searchResults.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No memory results yet.</p>
                  ) : (
                    searchResults.map((result, index) => (
                      <div key={`${result.path}:${result.id || index}`} className="rounded-md border px-3 py-3">
                        <div className="mb-2 flex flex-wrap items-center gap-2">
                          <Badge variant={scoreTone(result.score) as "default" | "secondary" | "outline"}>
                            {result.score.toFixed(2)}
                          </Badge>
                          <Badge variant="outline">{result.source}</Badge>
                          {result.type ? <Badge variant="secondary">{result.type}</Badge> : null}
                        </div>
                        {result.content && result.content.length > 260 ? (
                          <div>
                            <p className="text-sm whitespace-pre-wrap">
                              {expandedIds.has(result.path) ? result.content : result.content.slice(0, 260) + "..."}
                            </p>
                            <button
                              className="text-[10px] text-primary hover:underline mt-1"
                              onClick={() => setExpandedIds(prev => {
                                const next = new Set(prev);
                                next.has(result.path) ? next.delete(result.path) : next.add(result.path);
                                return next;
                              })}
                            >
                              {expandedIds.has(result.path) ? "Show less" : "Show more"}
                            </button>
                          </div>
                        ) : (
                          <p className="text-sm whitespace-pre-wrap">{result.content}</p>
                        )}
                        <div className="mt-2 text-xs text-muted-foreground">
                          {result.path}
                          {typeof result.startLine === "number" && typeof result.endLine === "number"
                            ? ` • lines ${result.startLine}-${result.endLine}`
                            : ""}
                          {result.contextText ? ` • path context: ${truncate(result.contextText, 120)}` : ""}
                        </div>
                      </div>
                    ))
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm">Document Candidates</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {documentResults.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No document candidates yet.</p>
                  ) : (
                    documentResults.map((document) => (
                      <div key={document.id} className="rounded-md border px-3 py-3">
                        <div className="mb-2 flex flex-wrap items-center gap-2">
                          <div className="text-sm font-medium">{document.name}</div>
                          <Badge variant="outline">{document.sourceType}</Badge>
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {truncate(document.excerpt || document.sourceUrl || document.id, 220)}
                        </div>
                      </div>
                    ))
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm">Why This Surfaced</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {!diagnostics ? (
                    <p className="text-sm text-muted-foreground">Run a search to inspect retrieval decisions.</p>
                  ) : (
                    <>
                      <div className="flex flex-wrap gap-2">
                        <Badge variant="outline">backend: {diagnostics.searchPolicy?.backend || "-"}</Badge>
                        <Badge variant="outline">rerank: {diagnostics.rerankStrategy || diagnostics.searchPolicy?.rerankStrategy || "-"}</Badge>
                        <Badge variant="outline">strong signal: {diagnostics.strongSignal ? "yes" : "no"}</Badge>
                        <Badge variant="outline">candidates: {diagnostics.candidateCount}</Badge>
                      </div>
                      <div className="space-y-2 text-xs text-muted-foreground">
                        <div>Selected model: {diagnostics.providerPlan?.selected ? `${diagnostics.providerPlan.selected.provider}/${diagnostics.providerPlan.selected.modelId}` : diagnostics.providerPlan?.configured || "-"}</div>
                        <div>Expanded queries: {diagnostics.expandedQueries.length > 0 ? diagnostics.expandedQueries.join(" | ") : "none"}</div>
                        <div>Rewritten query: {diagnostics.rewrittenQuery || "none"}</div>
                        <div>
                          Source counts: {Object.entries(diagnostics.sourceCounts).map(([key, value]) => `${key}:${value}`).join(" • ") || "none"}
                        </div>
                        <div>
                          Fused list: {diagnostics.explain?.fusedListCount ?? "-"} • pre-filter {diagnostics.explain?.preFilterCandidates ?? "-"} • post-filter {diagnostics.explain?.postFilterCandidates ?? "-"}
                        </div>
                        <div>
                          Position-aware blend: {diagnostics.explain?.positionAwareBlend ? "on" : "off"} • chunked rerank: {diagnostics.explain?.chunkedRerank ? "on" : "off"}
                        </div>
                        <div>
                          Auto strategy: {diagnostics.explain?.autoResolvedStrategy || "-"} • backend default: {diagnostics.explain?.backendDefaultRerank || "-"}
                        </div>
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>
            </div>
          </div>

          {/* ── Memory Timeline ── */}
          <div className="mt-6">
            <div className="mb-3 flex items-center gap-3">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowTimeline((v) => !v)}
                className="text-xs uppercase tracking-wider"
              >
                {showTimeline ? "Hide" : "Show"} Memory Timeline
              </Button>
              {showTimeline && (
                <span className="text-xs text-muted-foreground font-mono">
                  {timelineTotal} total entries · showing {timelineEntries.length}
                </span>
              )}
            </div>

            {showTimeline && (
              <Card>
                <CardHeader className="pb-2 flex flex-row items-center justify-between">
                  <CardTitle className="text-sm uppercase tracking-widest text-muted-foreground">
                    {"// Memory Timeline"}
                  </CardTitle>
                  <div className="flex items-center gap-2">
                    <select
                      className="rounded-md border bg-background px-2 py-1 text-xs"
                      value={timelineTypeFilter}
                      onChange={(e) => setTimelineTypeFilter(e.target.value)}
                    >
                      <option value="">All types</option>
                      {timelineTypes.map((t) => (
                        <option key={t} value={t}>{t}</option>
                      ))}
                    </select>
                    <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => void loadTimeline(timelineTypeFilter)} disabled={timelineLoading}>
                      {timelineLoading ? "Loading…" : "Refresh"}
                    </Button>
                  </div>
                </CardHeader>
                <CardContent>
                  {timelineLoading ? (
                    <p className="text-xs font-mono text-muted-foreground animate-pulse">Loading timeline…</p>
                  ) : timelineEntries.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No memory entries found.</p>
                  ) : (
                    <div className="relative ml-2 border-l border-border pl-6 space-y-4">
                      {timelineEntries.map((entry) => {
                        const d = new Date(entry.created);
                        const dateStr = d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
                        const timeStr = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
                        return (
                          <div key={entry.id} className="relative">
                            <span className="absolute -left-[25px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-background bg-muted-foreground" />
                            <div className="flex flex-wrap items-center gap-2 mb-1">
                              <Badge variant="secondary" className="text-[10px]">{entry.type}</Badge>
                              <span className="text-[10px] font-mono text-muted-foreground">{dateStr} {timeStr}</span>
                              {entry.confidence < 1 && (
                                <span className="text-[10px] font-mono text-muted-foreground">conf: {Math.round(entry.confidence * 100)}%</span>
                              )}
                              {entry.source && entry.source !== "user" && (
                                <Badge variant="outline" className="text-[10px]">{entry.source}</Badge>
                              )}
                            </div>
                            <p className="text-xs text-foreground line-clamp-3">{entry.content}</p>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </CardContent>
              </Card>
            )}
          </div>
        </main>
  );
}
