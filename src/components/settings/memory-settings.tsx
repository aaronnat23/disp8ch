"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import { Trash2, RefreshCw, Database, Cpu, FolderOpen, Quote, Radar, AlertTriangle } from "lucide-react";
import type { MemoryStats, MemoryEntry } from "@/types/memory";
import { Label } from "@/components/ui/label";

const STARTUP_FILE_OPTIONS = [
  { key: "AGENTS.md", label: "AGENTS.md", desc: "Agent profiles and registry" },
  { key: "SOUL.md", label: "SOUL.md", desc: "Personality and tone" },
  { key: "USER.md", label: "USER.md", desc: "User profile and preferences" },
  { key: "IDENTITY.md", label: "IDENTITY.md", desc: "Core identity rules" },
  { key: "TOOLS.md", label: "TOOLS.md", desc: "Tool usage guidelines" },
  { key: "MEMORY.md", label: "MEMORY.md", desc: "Durable memory surface" },
  { key: "BOOT.md", label: "BOOT.md", desc: "Boot-time instructions" },
];

interface EmbeddingStatus {
  configured: string;
  active: { modelId: string; provider: string } | null;
  vectorIndexed: number;
  sessionChunks: number;
  collectionChunks?: number;
  mode: "hybrid" | "fts5-only";
  vectorBackend: {
    kind: "sqlite-vec" | "json-cosine-fallback";
    available: boolean;
    loaded: boolean;
    dimensions: number | null;
    error: string | null;
  };
  providerPlan?: {
    configured: string;
    mode: "hybrid" | "fts5-only";
    actualMode?: "hybrid" | "fts5-only";
    active: { provider: string; modelId: string } | null;
    candidates: Array<{ provider: string; modelId: string; source: string }>;
    selected?: { provider: string; modelId: string; source: string } | null;
    fallbackCount: number;
    unavailableReason?: string | null;
  };
  searchPolicy?: {
    backend: "builtin" | "qmd-like";
    rerankStrategy: "auto" | "mmr" | "local" | "model" | "off";
    queryExpansionEnabled: boolean;
    strongSignalEnabled: boolean;
    rerankCandidateLimit: number;
  };
  runtime?: {
    dirty: boolean;
    sessionsDirty: boolean;
    jobs: {
      queued: number;
      running: number;
      completed: number;
      failed: number;
    };
    watcher: {
      pollingFallback: boolean;
      lastEventAt: string | null;
    };
  };
  agentId?: string;
  memoryAgentId?: string;
}

interface MemoryDiagnostics {
  agentId: string;
  memoryAgentId: string;
  workspacePath: string;
  embeddingModel: string;
  vectorBackend: {
    kind: "sqlite-vec" | "json-cosine-fallback";
    available: boolean;
    loaded: boolean;
    dimensions: number | null;
    error: string | null;
  };
  vectorIndexed: number;
  sessionChunks: number;
  collectionChunks: number;
  pathContexts: number;
  startupFileHygiene?: {
    defaultWorkspaceDir: string;
    activeWorkspaceDir: string;
    usingDefaultWorkspace: boolean;
    rootStartupFilesPresent: string[];
    divergentFiles: Array<{
      file: string;
      activeExists: boolean;
      defaultExists: boolean;
      activeBytes: number;
      defaultBytes: number;
      sameContent: boolean;
    }>;
    warnings: string[];
  };
  providerPlan?: {
    configured: string;
    mode: "hybrid" | "fts5-only";
    actualMode?: "hybrid" | "fts5-only";
    active: { provider: string; modelId: string } | null;
    candidates: Array<{ provider: string; modelId: string; source: string }>;
    selected?: { provider: string; modelId: string; source: string } | null;
    fallbackCount: number;
    unavailableReason?: string | null;
  };
  searchPolicy?: {
    backend: "builtin" | "qmd-like";
    rerankStrategy: "auto" | "mmr" | "local" | "model" | "off";
    queryExpansionEnabled: boolean;
    strongSignalEnabled: boolean;
    rerankCandidateLimit: number;
  };
  runtime?: {
    dirty: boolean;
    sessionsDirty: boolean;
    lastSyncAt: string | null;
    lastSyncReason: string | null;
    lastFailure: string | null;
    providerFailures: Array<{ role: string; provider: string; modelId: string; error: string; at: string }>;
    providerHealth: Array<{
      role: string;
      provider: string;
      modelId: string;
      successes: number;
      failures: number;
      consecutiveFailures: number;
      lastSuccessAt: string | null;
      lastFailureAt: string | null;
      lastError: string | null;
    }>;
    providerBatchHealth: Array<{
      provider: string;
      modelId: string;
      batchSuccesses: number;
      batchFailures: number;
      batchFallbacks: number;
      consecutiveBatchFailures: number;
      lastBatchSuccessAt: string | null;
      lastBatchFailureAt: string | null;
      lastBatchError: string | null;
    }>;
    sessions: {
      pending: string[];
      warmCount: number;
      trackedCount: number;
      lastIndexedAt: string | null;
    };
    jobs: {
      queued: number;
      running: number;
      completed: number;
      failed: number;
    };
    watcher: {
      pollingFallback: boolean;
      lastEventAt: string | null;
      lastChangedPath: string | null;
    };
    isolation: {
      atomicFtsScoped: boolean;
      workspaceScoped: boolean;
      sessionScoped: boolean;
      collectionScoped: boolean;
    };
    recovery: {
      attempts: number;
      successes: number;
      failures: number;
      lastReason: string | null;
      lastError: string | null;
      lastRecoveredAt: string | null;
    };
  };
}

interface SessionRecallMatch {
  score: number;
  chunkIndex: number;
  preview: string;
}

interface SessionRecallSession {
  sessionId: string;
  score: number;
  matchCount: number;
  messageCount: number;
  startedAt: string | null;
  updatedAt: string | null;
  participants: string[];
  summary: string;
  summaryMode: "llm" | "extractive";
  matches: SessionRecallMatch[];
}

interface SessionRecallPayload {
  query: string;
  indexingEnabled: boolean;
  sessionChunkCount: number;
  usedModel: { provider: string; modelId: string } | null;
  sessions: SessionRecallSession[];
}

export function MemorySettings() {
  const [memoryStats, setMemoryStats] = useState<MemoryStats | null>(null);
  const [memories, setMemories] = useState<MemoryEntry[]>([]);
  const [embeddingStatus, setEmbeddingStatus] = useState<EmbeddingStatus | null>(null);
  const [memoryDiagnostics, setMemoryDiagnostics] = useState<MemoryDiagnostics | null>(null);
  const [sessionRecallQuery, setSessionRecallQuery] = useState("");
  const [sessionRecallLoading, setSessionRecallLoading] = useState(false);
  const [sessionRecallError, setSessionRecallError] = useState<string | null>(null);
  const [sessionRecallResult, setSessionRecallResult] = useState<SessionRecallPayload | null>(null);

  // Config fields
  const [vectorWeight, setVectorWeight] = useState(0.7);
  const [textWeight, setTextWeight] = useState(0.3);
  const [indexSessions, setIndexSessions] = useState(false);
  const [startupFiles, setStartupFiles] = useState<string[]>(STARTUP_FILE_OPTIONS.map((o) => o.key));
  const [citationsMode, setCitationsMode] = useState<"on" | "off" | "auto">("on");
  const [maxSnippetChars, setMaxSnippetChars] = useState(700);
  const [maxInjectedChars, setMaxInjectedChars] = useState(4000);
  const [collectionPaths, setCollectionPaths] = useState("");
  const [embeddingModelConfig, setEmbeddingModelConfig] = useState("auto");
  const [searchBackend, setSearchBackend] = useState<"builtin" | "qmd-like">("qmd-like");
  const [rerankStrategy, setRerankStrategy] = useState<"auto" | "mmr" | "local" | "model" | "off">("auto");
  const [queryExpansionEnabled, setQueryExpansionEnabled] = useState(true);
  const [strongSignalEnabled, setStrongSignalEnabled] = useState(true);
  const [rerankCandidateLimit, setRerankCandidateLimit] = useState(40);
  const [configDirty, setConfigDirty] = useState(false);

  // Action states
  const [rebuilding, setRebuilding] = useState(false);
  const [indexingSessions, setIndexingSessions] = useState(false);
  const [indexingCollections, setIndexingCollections] = useState(false);

  const fetchMemoryStats = () => {
    fetch("/api/memory?action=stats")
      .then((r) => r.json())
      .then((data) => {
        if (data.success) setMemoryStats(data.data);
      })
      .catch(() => {});
  };

  const fetchEmbeddingStatus = () => {
    fetch("/api/memory?action=embedding-status")
      .then((r) => r.json())
      .then((data) => {
        if (data.success) setEmbeddingStatus(data.data);
      })
      .catch(() => {});
  };

  const fetchDiagnostics = () => {
    fetch("/api/memory?action=diagnostics")
      .then((r) => r.json())
      .then((data) => {
        if (data.success) setMemoryDiagnostics(data.data);
      })
      .catch(() => {});
  };

  const parseStartupFileConfig = (value: unknown): string[] => {
    if (typeof value !== "string" || !value.trim()) return [];
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) return parsed.map((entry) => String(entry).trim()).filter(Boolean);
    } catch {
      // Fall back to legacy comma-separated values.
    }
    return value.split(",").map((entry) => entry.trim()).filter(Boolean);
  };

  const fetchConfig = () => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((data) => {
        if (data.success) {
          const d = data.data;
          if (typeof d.vector_weight === "number") setVectorWeight(d.vector_weight);
          if (typeof d.text_weight === "number") setTextWeight(d.text_weight);
          if (typeof d.embedding_model === "string" && d.embedding_model) setEmbeddingModelConfig(d.embedding_model);
          if (typeof d.index_sessions === "number") setIndexSessions(d.index_sessions === 1);
          if (typeof d.startup_include_files === "string" && d.startup_include_files) {
            setStartupFiles(parseStartupFileConfig(d.startup_include_files));
          }
          if (d.citations_mode === "on" || d.citations_mode === "off" || d.citations_mode === "auto") {
            setCitationsMode(d.citations_mode);
          }
          if (typeof d.max_snippet_chars === "number") setMaxSnippetChars(d.max_snippet_chars);
          if (typeof d.max_injected_chars === "number") setMaxInjectedChars(d.max_injected_chars);
          if (typeof d.extra_collection_paths === "string" && d.extra_collection_paths) {
            setCollectionPaths(d.extra_collection_paths.split(",").map((s: string) => s.trim()).join("\n"));
          }
          if (d.search_backend === "builtin" || d.search_backend === "qmd-like") {
            setSearchBackend(d.search_backend);
          }
          if (
            d.rerank_strategy === "auto" ||
            d.rerank_strategy === "mmr" ||
            d.rerank_strategy === "local" ||
            d.rerank_strategy === "model" ||
            d.rerank_strategy === "off"
          ) {
            setRerankStrategy(d.rerank_strategy);
          }
          if (typeof d.query_expansion_enabled === "number") setQueryExpansionEnabled(d.query_expansion_enabled === 1);
          if (typeof d.strong_signal_enabled === "number") setStrongSignalEnabled(d.strong_signal_enabled === 1);
          if (typeof d.rerank_candidate_limit === "number") setRerankCandidateLimit(d.rerank_candidate_limit);
        }
      })
      .catch(() => {});
  };

  const fetchMemories = () => {
    fetch("/api/memory")
      .then((r) => r.json())
      .then((data) => { if (data.success) setMemories(data.data); })
      .catch(() => {});
  };

  useEffect(() => {
    fetchMemoryStats();
    fetchEmbeddingStatus();
    fetchDiagnostics();
    fetchConfig();
    fetchMemories();
  }, []);

  const saveConfig = async () => {
    const pathsCleaned = collectionPaths
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .join(",");
    await fetch("/api/config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vector_weight: vectorWeight,
        text_weight: textWeight,
        embedding_model: embeddingModelConfig,
        index_sessions: indexSessions ? 1 : 0,
        startup_include_files: startupFiles.length === STARTUP_FILE_OPTIONS.length
          ? null
          : startupFiles.join(","),
        citations_mode: citationsMode,
        max_snippet_chars: maxSnippetChars,
        max_injected_chars: maxInjectedChars,
        extra_collection_paths: pathsCleaned || null,
        search_backend: searchBackend,
        rerank_strategy: rerankStrategy,
        query_expansion_enabled: queryExpansionEnabled ? 1 : 0,
        strong_signal_enabled: strongSignalEnabled ? 1 : 0,
        rerank_candidate_limit: rerankCandidateLimit,
      }),
    });
    setConfigDirty(false);
    fetchConfig();
    fetchDiagnostics();
  };

  const handleVectorWeightChange = (val: number) => {
    setVectorWeight(val);
    setTextWeight(Math.round((1 - val) * 10) / 10);
    setConfigDirty(true);
  };

  const toggleStartupFile = (key: string) => {
    setStartupFiles((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    );
    setConfigDirty(true);
  };

  const rebuildIndex = async () => {
    setRebuilding(true);
    try {
      await fetch("/api/memory?action=rebuild-index");
      fetchEmbeddingStatus();
      fetchMemoryStats();
      fetchDiagnostics();
    } finally {
      setRebuilding(false);
    }
  };

  const indexSessionsCmd = async () => {
    setIndexingSessions(true);
    try {
      await fetch("/api/memory?action=index-sessions");
      fetchEmbeddingStatus();
      fetchDiagnostics();
    } finally {
      setIndexingSessions(false);
    }
  };

  const indexCollectionsCmd = async () => {
    setIndexingCollections(true);
    try {
      await fetch("/api/memory?action=index-collections");
      fetchEmbeddingStatus();
      fetchDiagnostics();
    } finally {
      setIndexingCollections(false);
    }
  };

  const deleteMemory = async (id: string) => {
    await fetch(`/api/memory?id=${id}`, { method: "DELETE" });
    fetchMemories();
    fetchMemoryStats();
  };

  const runSessionRecall = async () => {
    const query = sessionRecallQuery.trim();
    if (!query) return;
    setSessionRecallLoading(true);
    setSessionRecallError(null);
    try {
      const response = await fetch(
        `/api/memory?action=session-recall&limit=4&query=${encodeURIComponent(query)}`,
        { cache: "no-store" },
      );
      const payload = await response.json();
      if (!response.ok || !payload.success || !payload.data) {
        throw new Error(payload.error || `Session recall failed (${response.status})`);
      }
      setSessionRecallResult(payload.data as SessionRecallPayload);
    } catch (error) {
      setSessionRecallError(String(error));
      setSessionRecallResult(null);
    } finally {
      setSessionRecallLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Embedding Status */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Cpu className="h-4 w-4" />
            Vector Search
          </CardTitle>
          <CardDescription>
            {embeddingStatus?.mode === "fts5-only"
              ? "FTS5 keyword search only — no embedding model found"
              : `Hybrid BM25 + vector search active`}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-3 gap-3 text-center">
            <div className="rounded border p-2">
              <div className="text-lg font-semibold">{embeddingStatus?.vectorIndexed ?? 0}</div>
              <div className="text-xs text-muted-foreground">Vectors cached</div>
            </div>
            <div className="rounded border p-2">
              <div className="text-lg font-semibold">{embeddingStatus?.sessionChunks ?? 0}</div>
              <div className="text-xs text-muted-foreground">Session chunks</div>
            </div>
            <div className="rounded border p-2">
              <div className="text-xs font-medium truncate">{embeddingStatus?.active?.modelId ?? "none"}</div>
              <div className="text-xs text-muted-foreground">Model</div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
            <span>Configured: {embeddingStatus?.configured ?? "auto"}</span>
            <span>Backend: {embeddingStatus?.vectorBackend.kind ?? "unknown"}</span>
            <span>Provider: {embeddingStatus?.active?.provider ?? "none"}</span>
            <span>Scope: {embeddingStatus?.memoryAgentId ?? "default"}</span>
            <span>Candidates: {embeddingStatus?.providerPlan?.candidates?.length ?? 0}</span>
            <span>Fallbacks: {embeddingStatus?.providerPlan?.fallbackCount ?? 0}</span>
            <span>Search backend: {embeddingStatus?.searchPolicy?.backend ?? searchBackend}</span>
            <span>Rerank policy: {embeddingStatus?.searchPolicy?.rerankStrategy ?? rerankStrategy}</span>
          </div>

          <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
            <span>Dirty: {embeddingStatus?.runtime?.dirty ? "yes" : "no"}</span>
            <span>Session dirty: {embeddingStatus?.runtime?.sessionsDirty ? "yes" : "no"}</span>
            <span>Queued jobs: {embeddingStatus?.runtime?.jobs.queued ?? 0}</span>
            <span>Running jobs: {embeddingStatus?.runtime?.jobs.running ?? 0}</span>
            <span>Watcher fallback: {embeddingStatus?.runtime?.watcher.pollingFallback ? "polling" : "watch only"}</span>
            <span>Last watcher event: {embeddingStatus?.runtime?.watcher.lastEventAt ?? "none"}</span>
          </div>

          {embeddingStatus?.providerPlan?.unavailableReason ? (
            <div className="rounded border border-amber-300/50 bg-amber-50/60 p-2 text-xs text-amber-900">
              {embeddingStatus.providerPlan.unavailableReason}
            </div>
          ) : null}

          <div className="space-y-2 rounded border p-3">
            <div className="text-sm font-medium">Embedding model config</div>
            <div className="grid grid-cols-2 gap-2">
              {[
                { label: "Auto", value: "auto" },
                { label: "Local", value: "local" },
                { label: "Local only", value: "local-only:Xenova/all-MiniLM-L6-v2" },
                { label: "Google", value: "gemini-embedding-001" },
                { label: "OpenAI", value: "text-embedding-3-small" },
                { label: "Disabled", value: "disabled" },
              ].map((item) => (
                <button
                  key={item.value}
                  onClick={() => { setEmbeddingModelConfig(item.value); setConfigDirty(true); }}
                  className={`rounded-lg border p-2 text-left text-xs transition-colors ${
                    embeddingModelConfig === item.value ? "border-primary bg-primary/5 font-medium" : "hover:bg-accent"
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <input
              value={embeddingModelConfig}
              onChange={(e) => { setEmbeddingModelConfig(e.target.value); setConfigDirty(true); }}
              className="w-full rounded border bg-background px-2 py-1 font-mono text-xs"
              placeholder="auto | local | local:<model> | local-only:<model> | gemini-embedding-001"
            />
            <p className="text-xs text-muted-foreground">
              `local` uses a local ONNX embedding model with a cross-platform cache. `local-only:` requires the model to
              already exist in the local cache.
            </p>
          </div>

          <div className="space-y-3 rounded border p-3">
            <div className="text-sm font-medium">Search backend policy</div>
            <div className="grid grid-cols-2 gap-2">
              {[
                {
                  label: "QMD-like",
                  value: "qmd-like" as const,
                  desc: "Strong-signal probe, query expansion, RRF, chunk selection, position-aware blend",
                },
                {
                  label: "Builtin",
                  value: "builtin" as const,
                  desc: "Straight hybrid retrieval with lighter post-processing",
                },
              ].map((item) => (
                <button
                  key={item.value}
                  onClick={() => { setSearchBackend(item.value); setConfigDirty(true); }}
                  className={`rounded-lg border p-2 text-left text-xs transition-colors ${
                    searchBackend === item.value ? "border-primary bg-primary/5 font-medium" : "hover:bg-accent"
                  }`}
                >
                  <div>{item.label}</div>
                  <div className="mt-1 text-[11px] text-muted-foreground">{item.desc}</div>
                </button>
              ))}
            </div>

            <div className="space-y-1">
              <Label className="text-xs">Rerank policy</Label>
              <select
                value={rerankStrategy}
                onChange={(e) => { setRerankStrategy(e.target.value as typeof rerankStrategy); setConfigDirty(true); }}
                className="w-full rounded border bg-background px-2 py-1 text-xs"
              >
                <option value="auto">Auto</option>
                <option value="mmr">MMR only</option>
                <option value="local">Local rerank</option>
                <option value="model">Model rerank</option>
                <option value="off">Off</option>
              </select>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => { setQueryExpansionEnabled((current) => !current); setConfigDirty(true); }}
                className={`rounded-lg border p-2 text-left text-xs transition-colors ${
                  queryExpansionEnabled ? "border-primary bg-primary/5" : "hover:bg-accent"
                }`}
              >
                <div className="font-medium">Query expansion</div>
                <div className="mt-1 text-[11px] text-muted-foreground">
                  {queryExpansionEnabled ? "Enabled for QMD-like backend" : "Disabled"}
                </div>
              </button>
              <button
                onClick={() => { setStrongSignalEnabled((current) => !current); setConfigDirty(true); }}
                className={`rounded-lg border p-2 text-left text-xs transition-colors ${
                  strongSignalEnabled ? "border-primary bg-primary/5" : "hover:bg-accent"
                }`}
              >
                <div className="font-medium">Strong-signal probe</div>
                <div className="mt-1 text-[11px] text-muted-foreground">
                  {strongSignalEnabled ? "Skip expansion on decisive lexical hits" : "Always allow expansion"}
                </div>
              </button>
            </div>

            <div className="space-y-1">
              <div className="flex justify-between text-sm">
                <span>Rerank candidate limit</span>
                <span className="font-mono text-xs">{rerankCandidateLimit}</span>
              </div>
              <input
                type="range"
                min={5}
                max={80}
                step={1}
                value={rerankCandidateLimit}
                onChange={(e) => { setRerankCandidateLimit(parseInt(e.target.value)); setConfigDirty(true); }}
                className="w-full"
              />
            </div>
          </div>

          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={rebuildIndex}
              disabled={rebuilding}
            >
              <RefreshCw className={`mr-1 h-3 w-3 ${rebuilding ? "animate-spin" : ""}`} />
              {rebuilding ? "Rebuilding…" : "Rebuild Index"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={indexSessionsCmd}
              disabled={indexingSessions || !indexSessions}
              title={!indexSessions ? "Enable session indexing first" : undefined}
            >
              <Database className={`mr-1 h-3 w-3 ${indexingSessions ? "animate-pulse" : ""}`} />
              {indexingSessions ? "Indexing…" : "Index Sessions"}
            </Button>
          </div>

          {/* Vector / Text weight */}
          {embeddingStatus?.mode !== "fts5-only" && (
            <div className="space-y-2 pt-1">
              <div className="flex justify-between text-sm">
                <span>Vector weight</span>
                <span className="font-mono text-xs">{vectorWeight.toFixed(1)}</span>
              </div>
              <input
                type="range"
                min={0}
                max={1}
                step={0.1}
                value={vectorWeight}
                onChange={(e) => handleVectorWeightChange(parseFloat(e.target.value))}
                className="w-full"
              />
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>Text (BM25): {textWeight.toFixed(1)}</span>
                <span>Vector: {vectorWeight.toFixed(1)}</span>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Radar className="h-4 w-4" />
            Retrieval Diagnostics
          </CardTitle>
          <CardDescription>Live retrieval backend, scope, and index health</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
          <span>Workspace: {memoryDiagnostics?.workspacePath ?? "loading..."}</span>
          <span>Path contexts: {memoryDiagnostics?.pathContexts ?? 0}</span>
          <span>Agent scope: {memoryDiagnostics?.agentId ?? "main"}</span>
          <span>Memory scope: {memoryDiagnostics?.memoryAgentId ?? "default"}</span>
          <span>Vectors: {memoryDiagnostics?.vectorIndexed ?? 0}</span>
          <span>Session chunks: {memoryDiagnostics?.sessionChunks ?? 0}</span>
          <span>Collection chunks: {memoryDiagnostics?.collectionChunks ?? 0}</span>
          <span>Backend loaded: {memoryDiagnostics?.vectorBackend.loaded ? "yes" : "no"}</span>
          <span>Plan mode: {memoryDiagnostics?.providerPlan?.mode ?? "unknown"}</span>
          <span>Selected: {memoryDiagnostics?.providerPlan?.selected?.provider ?? memoryDiagnostics?.providerPlan?.active?.provider ?? "none"}</span>
          <span>Plan candidates: {memoryDiagnostics?.providerPlan?.candidates?.length ?? 0}</span>
          <span>Fallback candidates: {memoryDiagnostics?.providerPlan?.fallbackCount ?? 0}</span>
          <span>Search backend: {memoryDiagnostics?.searchPolicy?.backend ?? searchBackend}</span>
          <span>Rerank policy: {memoryDiagnostics?.searchPolicy?.rerankStrategy ?? rerankStrategy}</span>
          <span>Query expansion: {memoryDiagnostics?.searchPolicy?.queryExpansionEnabled ? "on" : "off"}</span>
          <span>Strong signal: {memoryDiagnostics?.searchPolicy?.strongSignalEnabled ? "on" : "off"}</span>
          <span>Rerank limit: {memoryDiagnostics?.searchPolicy?.rerankCandidateLimit ?? rerankCandidateLimit}</span>
          <span>Manager dirty: {memoryDiagnostics?.runtime?.dirty ? "yes" : "no"}</span>
          <span>Session dirty: {memoryDiagnostics?.runtime?.sessionsDirty ? "yes" : "no"}</span>
          <span>Last sync: {memoryDiagnostics?.runtime?.lastSyncAt ?? "never"}</span>
          <span>Sync reason: {memoryDiagnostics?.runtime?.lastSyncReason ?? "none"}</span>
          <span>Tracked sessions: {memoryDiagnostics?.runtime?.sessions.trackedCount ?? 0}</span>
          <span>Warm sessions: {memoryDiagnostics?.runtime?.sessions.warmCount ?? 0}</span>
          <span>Pending sessions: {memoryDiagnostics?.runtime?.sessions.pending.length ?? 0}</span>
          <span>Queued jobs: {memoryDiagnostics?.runtime?.jobs.queued ?? 0}</span>
          <span>Completed jobs: {memoryDiagnostics?.runtime?.jobs.completed ?? 0}</span>
          <span>Failed jobs: {memoryDiagnostics?.runtime?.jobs.failed ?? 0}</span>
          <span>Watcher mode: {memoryDiagnostics?.runtime?.watcher.pollingFallback ? "watch + polling" : "watch"}</span>
          <span>Last file event: {memoryDiagnostics?.runtime?.watcher.lastChangedPath ?? "none"}</span>
          <span>Isolation: {memoryDiagnostics?.runtime?.isolation.atomicFtsScoped ? "scoped" : "legacy"}</span>
          <span>Provider failures: {memoryDiagnostics?.runtime?.providerFailures.length ?? 0}</span>
          <span>Provider health rows: {memoryDiagnostics?.runtime?.providerHealth.length ?? 0}</span>
          <span>Batch health rows: {memoryDiagnostics?.runtime?.providerBatchHealth.length ?? 0}</span>
          <span>Batch fallbacks: {memoryDiagnostics?.runtime?.providerBatchHealth.reduce((sum, row) => sum + row.batchFallbacks, 0) ?? 0}</span>
          <span>Recovery attempts: {memoryDiagnostics?.runtime?.recovery.attempts ?? 0}</span>
          <span>Recovery success: {memoryDiagnostics?.runtime?.recovery.successes ?? 0}</span>
          <span>Recovery failures: {memoryDiagnostics?.runtime?.recovery.failures ?? 0}</span>
          <span>Last recovery: {memoryDiagnostics?.runtime?.recovery.lastRecoveredAt ?? "never"}</span>
          {memoryDiagnostics?.startupFileHygiene?.warnings?.length ? (
            <div className="col-span-2 rounded border border-amber-500/40 bg-amber-500/10 p-3 text-amber-200">
              <div className="mb-1 flex items-center gap-2 font-medium">
                <AlertTriangle className="h-4 w-4" />
                Startup file hygiene warning
              </div>
              <div className="space-y-1">
                {memoryDiagnostics.startupFileHygiene.warnings.map((warning) => (
                  <p key={warning}>{warning}</p>
                ))}
              </div>
              {memoryDiagnostics.startupFileHygiene.divergentFiles.length > 0 ? (
                <p className="mt-2 text-amber-100/80">
                  Divergent files: {memoryDiagnostics.startupFileHygiene.divergentFiles.map((file) => file.file).join(", ")}
                </p>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* Session Indexing */}
      <Card>
        <CardHeader>
          <CardTitle>Session Transcript Indexing</CardTitle>
          <CardDescription>Index past conversations as searchable memory (requires embedding model)</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <button
            onClick={() => { setIndexSessions(!indexSessions); setConfigDirty(true); }}
            className={`w-full rounded-lg border p-3 text-left transition-colors ${
              indexSessions ? "border-primary bg-primary/5" : "hover:bg-accent"
            }`}
          >
            <div className="font-medium text-sm">{indexSessions ? "Enabled" : "Disabled"}</div>
            <div className="text-xs text-muted-foreground">
              {indexSessions
                ? "New sessions will be chunked and indexed automatically"
                : "Session transcripts are not indexed — saves storage and API calls"}
            </div>
          </button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Session Recall</CardTitle>
          <CardDescription>
            Search indexed chat transcripts and summarize relevant prior conversations. This complements Memory Browser, which only shows durable memory entries.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-col gap-2 md:flex-row">
            <Input
              value={sessionRecallQuery}
              onChange={(event) => setSessionRecallQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void runSessionRecall();
                }
              }}
              placeholder="Recall sessions about onboarding tokens, failed deploys, customer requests..."
            />
            <Button
              variant="outline"
              onClick={() => void runSessionRecall()}
              disabled={sessionRecallLoading || !sessionRecallQuery.trim()}
            >
              {sessionRecallLoading ? "Searching…" : "Recall Sessions"}
            </Button>
          </div>

          <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
            <span>Indexed chunks: {sessionRecallResult?.sessionChunkCount ?? embeddingStatus?.sessionChunks ?? 0}</span>
            <span>Indexing: {(sessionRecallResult?.indexingEnabled ?? indexSessions) ? "enabled" : "disabled"}</span>
            <span>Summary path: {sessionRecallResult?.usedModel ? "LLM-assisted" : "extractive fallback"}</span>
            {sessionRecallResult?.usedModel ? (
              <span>
                Model: {sessionRecallResult.usedModel.provider} / {sessionRecallResult.usedModel.modelId}
              </span>
            ) : null}
          </div>

          {!indexSessions && !sessionRecallResult?.indexingEnabled ? (
            <div className="rounded border border-amber-300/50 bg-amber-50/60 p-2 text-xs text-amber-900">
              Session indexing is currently disabled. Recall only works against transcripts that have already been indexed.
            </div>
          ) : null}

          {sessionRecallError ? (
            <div className="rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
              {sessionRecallError}
            </div>
          ) : null}

          {sessionRecallResult ? (
            sessionRecallResult.sessions.length === 0 ? (
              <div className="rounded border p-3 text-sm text-muted-foreground">
                No indexed sessions matched <span className="font-mono">{sessionRecallResult.query}</span>.
              </div>
            ) : (
              <div className="space-y-3">
                {sessionRecallResult.sessions.map((session) => (
                  <div key={session.sessionId} className="rounded-lg border p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="text-sm font-semibold">{session.sessionId}</div>
                      <Badge variant="outline">{session.summaryMode === "llm" ? "LLM summary" : "Extractive"}</Badge>
                      <Badge variant="secondary">{session.matchCount} matches</Badge>
                      <Badge variant="secondary">{session.messageCount} messages</Badge>
                    </div>
                    <p className="mt-2 text-sm">{session.summary}</p>
                    <div className="mt-2 flex flex-wrap gap-3 text-xs text-muted-foreground">
                      <span>Last active: {session.updatedAt ? new Date(session.updatedAt).toLocaleString() : "unknown"}</span>
                      {session.participants.length > 0 ? (
                        <span>Participants: {session.participants.join(", ")}</span>
                      ) : null}
                    </div>
                    {session.matches.length > 0 ? (
                      <div className="mt-3 space-y-2">
                        {session.matches.map((match, index) => (
                          <div key={`${session.sessionId}:${match.chunkIndex}:${index}`} className="rounded border bg-muted/30 p-2 text-xs text-muted-foreground">
                            <div className="font-medium text-foreground">Match {index + 1}</div>
                            <div className="mt-1">{match.preview}</div>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            )
          ) : null}
        </CardContent>
      </Card>

      {/* Citations Mode */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Quote className="h-4 w-4" />
            Citations Mode
          </CardTitle>
          <CardDescription>Control when memory search results include Source: path citations</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-2">
            {(["on", "auto", "off"] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => { setCitationsMode(mode); setConfigDirty(true); }}
                className={`rounded-lg border p-2 text-center text-sm transition-colors ${
                  citationsMode === mode ? "border-primary bg-primary/5 font-medium" : "hover:bg-accent"
                }`}
              >
                {mode === "on" ? "On" : mode === "auto" ? "Auto (DM only)" : "Off"}
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Auto suppresses citations in group/channel contexts.
          </p>
        </CardContent>
      </Card>

      {/* Result Size Limits */}
      <Card>
        <CardHeader>
          <CardTitle>Result Size Limits</CardTitle>
          <CardDescription>Cap memory snippets to prevent context overflow</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <div className="flex justify-between text-sm">
              <span>Max snippet chars</span>
              <span className="font-mono text-xs">{maxSnippetChars}</span>
            </div>
            <input
              type="range" min={100} max={5000} step={100}
              value={maxSnippetChars}
              onChange={(e) => { setMaxSnippetChars(parseInt(e.target.value)); setConfigDirty(true); }}
              className="w-full"
            />
          </div>
          <div className="space-y-1">
            <div className="flex justify-between text-sm">
              <span>Max injected chars (total)</span>
              <span className="font-mono text-xs">{maxInjectedChars}</span>
            </div>
            <input
              type="range" min={500} max={20000} step={500}
              value={maxInjectedChars}
              onChange={(e) => { setMaxInjectedChars(parseInt(e.target.value)); setConfigDirty(true); }}
              className="w-full"
            />
          </div>
        </CardContent>
      </Card>

      {/* Collection Paths */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FolderOpen className="h-4 w-4" />
            Collection Paths
            {(embeddingStatus?.collectionChunks ?? 0) > 0 && (
              <Badge variant="secondary" className="ml-auto text-xs">
                {embeddingStatus?.collectionChunks} chunks
              </Badge>
            )}
          </CardTitle>
          <CardDescription>Index arbitrary folders (e.g. ~/notes) into memory search</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <textarea
            value={collectionPaths}
            onChange={(e) => { setCollectionPaths(e.target.value); setConfigDirty(true); }}
            placeholder={`~/notes\n/home/user/docs`}
            className="w-full rounded border bg-background p-2 font-mono text-xs min-h-[80px] resize-y"
          />
          <p className="text-xs text-muted-foreground">One absolute or ~/relative path per line. Only .md files are indexed.</p>
          <Button
            variant="outline"
            size="sm"
            onClick={indexCollectionsCmd}
            disabled={indexingCollections || !collectionPaths.trim()}
          >
            <Database className={`mr-1 h-3 w-3 ${indexingCollections ? "animate-pulse" : ""}`} />
            {indexingCollections ? "Indexing…" : "Index Now"}
          </Button>
        </CardContent>
      </Card>

      {/* Startup Files */}
      <Card>
        <CardHeader>
          <CardTitle>Startup Context Files</CardTitle>
          <CardDescription>
            Files loaded from the selected workspace at conversation start. The default profile workspace is `data/workspace`.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {STARTUP_FILE_OPTIONS.map((opt) => (
            <button
              key={opt.key}
              onClick={() => toggleStartupFile(opt.key)}
              className={`w-full rounded-lg border p-2 text-left transition-colors ${
                startupFiles.includes(opt.key) ? "border-primary bg-primary/5" : "hover:bg-accent opacity-50"
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs font-semibold">{opt.label}</span>
                <Badge variant={startupFiles.includes(opt.key) ? "default" : "outline"} className="text-xs">
                  {startupFiles.includes(opt.key) ? "on" : "off"}
                </Badge>
              </div>
              <div className="text-xs text-muted-foreground">{opt.desc}</div>
            </button>
          ))}
        </CardContent>
      </Card>

      {configDirty && (
        <Button onClick={saveConfig} className="w-full">
          Save Memory Settings
        </Button>
      )}

      {/* Stats */}
      {memoryStats && (
        <Card>
          <CardHeader><CardTitle>Memory Stats</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="flex justify-between text-sm">
              <span>Total memories</span>
              <span>{memoryStats.totalMemories}</span>
            </div>
            <Progress value={Math.min((memoryStats.totalMemories / Math.max(memoryStats.autoThreshold, 1)) * 100, 100)} />
            <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
              <span>Storage: {(memoryStats.storageBytes / 1024).toFixed(1)} KB</span>
              <span>Mode: {memoryStats.currentMode}</span>
              {memoryStats.embeddingModel && (
                <span className="col-span-2">Embeddings: {memoryStats.embeddingModel}</span>
              )}
              {typeof memoryStats.vectorIndexed === "number" && (
                <span>Vectors: {memoryStats.vectorIndexed}</span>
              )}
              {typeof memoryStats.sessionChunks === "number" && (
                <span>Session chunks: {memoryStats.sessionChunks}</span>
              )}
              {typeof (embeddingStatus?.collectionChunks) === "number" && (embeddingStatus?.collectionChunks ?? 0) > 0 && (
                <span>Collection chunks: {embeddingStatus?.collectionChunks}</span>
              )}
              {typeof memoryStats.workspaceMemoryFiles === "number" && (
                <span>Workspace files: {memoryStats.workspaceMemoryFiles}</span>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Memory Browser */}
      <Card>
        <CardHeader>
          <CardTitle>Memory Browser</CardTitle>
          <CardDescription>{memories.length} memories stored</CardDescription>
        </CardHeader>
        <CardContent>
          {memories.length === 0 ? (
            <p className="text-sm text-muted-foreground">No memories yet.</p>
          ) : (
            <div className="space-y-2 max-h-[400px] overflow-auto">
              {memories.map((m) => (
                <div key={m.id} className="flex items-start justify-between rounded border p-2">
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-xs">{m.type}</Badge>
                      <span className="text-xs text-muted-foreground">{m.confidence}</span>
                      {Number.isFinite(Number(m.reinforcementCount)) && Number(m.reinforcementCount) > 1 && (
                        <Badge variant="secondary" className="text-xs">
                          x{m.reinforcementCount}
                        </Badge>
                      )}
                    </div>
                    <p className="mt-1 text-sm">{m.content}</p>
                  </div>
                  <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={() => deleteMemory(m.id)}>
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
