"use client";

import { type ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Braces, Download, RefreshCw, RotateCcw, Save, Search, Undo2, Upload, Wand2 } from "lucide-react";

const CATEGORY_ORDER = [
  "all",
  "gateway",
  "runtime",
  "channels",
  "cron",
  "limits",
  "memory",
  "tools",
  "diagnostics",
] as const;

type ConfigCategory = (typeof CATEGORY_ORDER)[number];
type ConfigFieldType = "boolean" | "number" | "string" | "enum" | "multiline";

type ConfigKey =
  | "timezone"
  | "tool_output_limit"
  | "compaction_mode"
  | "compaction_threshold"
  | "context_window"
  | "memory_flush_soft_threshold_tokens"
  | "compaction_keep_recent_tokens"
  | "compaction_reserve_tokens_floor"
  | "compaction_model_ref"
  | "compaction_identifier_policy"
  | "compaction_identifier_instructions"
  | "compaction_quality_guard_enabled"
  | "compaction_quality_guard_max_retries"
  | "context_pruning_mode"
  | "context_pruning_keep_recent_assistants"
  | "context_pruning_min_tool_chars"
  | "context_pruning_max_tool_chars"
  | "context_pruning_head_chars"
  | "context_pruning_tail_chars"
  | "channel_retry_attempts"
  | "channel_retry_min_delay_ms"
  | "channel_retry_max_delay_ms"
  | "channel_retry_jitter"
  | "telemetry_enabled"
  | "hooks_enabled"
  | "memory_flush_enabled"
  | "rate_limit_webhooks"
  | "rate_limit_execute"
  | "rate_limit_channels"
  | "log_max_days"
  | "async_delegation_max_concurrent"
  | "lane_main_max_concurrent"
  | "lane_cron_max_concurrent"
  | "lane_subflow_max_concurrent"
  | "decay_enabled"
  | "decay_half_life_days"
  | "embedding_model"
  | "vector_weight"
  | "text_weight"
  | "index_sessions"
  | "session_chunk_tokens"
  | "session_chunk_overlap"
  | "startup_include_files"
  | "max_snippet_chars"
  | "max_injected_chars"
  | "citations_mode"
  | "extra_collection_paths";

type ConfigValue = string | number | boolean | null;
type ConfigFormState = Record<ConfigKey, ConfigValue>;
type ConfigViewMode = "form" | "raw";

type ConfigField = {
  key: ConfigKey;
  label: string;
  description: string;
  type: ConfigFieldType;
  category: Exclude<ConfigCategory, "all">;
  defaultValue: ConfigValue;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  tags?: string[];
  placeholder?: string;
  emptyAsNull?: boolean;
};

const CONFIG_FIELDS: ConfigField[] = [
  {
    key: "timezone",
    label: "Timezone",
    description: "Default timezone used by scheduling and runtime rendering.",
    type: "string",
    category: "gateway",
    defaultValue: "UTC",
    placeholder: "UTC",
    tags: ["region", "locale"],
  },
  {
    key: "telemetry_enabled",
    label: "Telemetry Enabled",
    description: "Write telemetry events for runtime and execution analytics.",
    type: "boolean",
    category: "gateway",
    defaultValue: true,
    tags: ["events", "logging"],
  },
  {
    key: "hooks_enabled",
    label: "Hooks Enabled",
    description: "Allow hook scripts to run for lifecycle events.",
    type: "boolean",
    category: "gateway",
    defaultValue: true,
    tags: ["automation"],
  },
  {
    key: "memory_flush_enabled",
    label: "Memory Flush Enabled",
    description: "Run pre-compaction memory extraction when context fills up.",
    type: "boolean",
    category: "gateway",
    defaultValue: true,
    tags: ["memory", "compaction"],
  },
  {
    key: "compaction_mode",
    label: "Compaction Mode",
    description: "How to compact context when usage approaches context window limit.",
    type: "enum",
    category: "runtime",
    defaultValue: "off",
    options: ["off", "summarize", "drop"],
  },
  {
    key: "compaction_threshold",
    label: "Compaction Threshold",
    description: "Threshold (0.1 to 0.95) for context compaction trigger.",
    type: "number",
    category: "runtime",
    defaultValue: 0.75,
    min: 0.1,
    max: 0.95,
    step: 0.05,
  },
  {
    key: "context_window",
    label: "Context Window",
    description: "Context size in tokens used by runtime compaction logic.",
    type: "number",
    category: "runtime",
    defaultValue: 200000,
    min: 1000,
    step: 1000,
  },
  {
    key: "memory_flush_soft_threshold_tokens",
    label: "Memory Flush Soft Threshold",
    description: "How many tokens before compaction the one-time memory flush may run.",
    type: "number",
    category: "runtime",
    defaultValue: 4000,
    min: 0,
    max: 500000,
    step: 500,
    tags: ["context", "memory", "compaction"],
  },
  {
    key: "compaction_keep_recent_tokens",
    label: "Keep Recent Context Budget",
    description: "Target token budget to preserve verbatim before older turns are summarized.",
    type: "number",
    category: "runtime",
    defaultValue: 20000,
    min: 2000,
    max: 500000,
    step: 1000,
    tags: ["context", "compaction"],
  },
  {
    key: "compaction_reserve_tokens_floor",
    label: "Reserve Tokens Floor",
    description: "Minimum reply headroom preserved before compaction triggers.",
    type: "number",
    category: "runtime",
    defaultValue: 20000,
    min: 1000,
    max: 500000,
    step: 1000,
    tags: ["context", "compaction"],
  },
  {
    key: "compaction_model_ref",
    label: "Compaction Model Override",
    description: "Optional model row id or provider:model-id used only for compaction summaries.",
    type: "string",
    category: "runtime",
    defaultValue: "",
    placeholder: "google:gemini-3-flash-preview",
    emptyAsNull: true,
    tags: ["model", "compaction"],
  },
  {
    key: "compaction_identifier_policy",
    label: "Identifier Retention Policy",
    description: "How aggressively compaction summaries preserve exact identifiers.",
    type: "enum",
    category: "runtime",
    defaultValue: "strict",
    options: ["strict", "off", "custom"],
    tags: ["context", "compaction"],
  },
  {
    key: "compaction_identifier_instructions",
    label: "Identifier Retention Instructions",
    description: "Optional custom instructions for identifier retention during compaction.",
    type: "multiline",
    category: "runtime",
    defaultValue: "",
    emptyAsNull: true,
    placeholder: "Preserve ports, paths, hashes, and ticket ids.",
    tags: ["context", "compaction"],
  },
  {
    key: "compaction_quality_guard_enabled",
    label: "Compaction Quality Guard",
    description: "Re-audit summaries for missing sections, identifiers, and latest asks before accepting them.",
    type: "boolean",
    category: "runtime",
    defaultValue: false,
    tags: ["context", "compaction"],
  },
  {
    key: "compaction_quality_guard_max_retries",
    label: "Quality Guard Retries",
    description: "Maximum additional summary retries when the quality guard finds omissions.",
    type: "number",
    category: "runtime",
    defaultValue: 1,
    min: 0,
    max: 5,
    step: 1,
    tags: ["context", "compaction"],
  },
  {
    key: "context_pruning_mode",
    label: "Context Pruning Mode",
    description: "Transient in-memory trimming policy for large old tool outputs.",
    type: "enum",
    category: "runtime",
    defaultValue: "tool-results",
    options: ["off", "tool-results"],
    tags: ["context", "pruning"],
  },
  {
    key: "context_pruning_keep_recent_assistants",
    label: "Protected Recent Assistant Turns",
    description: "How many recent assistant turns stay fully protected from tool-result pruning.",
    type: "number",
    category: "runtime",
    defaultValue: 3,
    min: 1,
    max: 12,
    step: 1,
    tags: ["context", "pruning"],
  },
  {
    key: "context_pruning_min_tool_chars",
    label: "Prune Minimum Tool Size",
    description: "Only tool results larger than this size are eligible for trimming.",
    type: "number",
    category: "runtime",
    defaultValue: 12000,
    min: 1000,
    max: 200000,
    step: 1000,
    tags: ["context", "pruning"],
  },
  {
    key: "context_pruning_max_tool_chars",
    label: "Pruned Tool Size Cap",
    description: "Maximum size preserved after trimming an oversized tool result.",
    type: "number",
    category: "runtime",
    defaultValue: 4000,
    min: 500,
    max: 20000,
    step: 250,
    tags: ["context", "pruning"],
  },
  {
    key: "context_pruning_head_chars",
    label: "Pruned Head Characters",
    description: "How many leading characters to preserve from a trimmed tool result.",
    type: "number",
    category: "runtime",
    defaultValue: 1500,
    min: 100,
    max: 10000,
    step: 100,
    tags: ["context", "pruning"],
  },
  {
    key: "context_pruning_tail_chars",
    label: "Pruned Tail Characters",
    description: "How many trailing characters to preserve from a trimmed tool result.",
    type: "number",
    category: "runtime",
    defaultValue: 1500,
    min: 100,
    max: 10000,
    step: 100,
    tags: ["context", "pruning"],
  },
  {
    key: "async_delegation_max_concurrent",
    label: "Async Subagent Concurrency",
    description: "Maximum background subagents that sessions_spawn can run at once. Extra background dispatches are rejected instead of queued.",
    type: "number",
    category: "runtime",
    defaultValue: 3,
    min: 1,
    max: 16,
    step: 1,
    tags: ["async", "subagent", "delegation", "sessions_spawn"],
  },
  {
    key: "lane_main_max_concurrent",
    label: "Main Lane Concurrency",
    description: "Maximum concurrent main workflow runs.",
    type: "number",
    category: "runtime",
    defaultValue: 4,
    min: 1,
    max: 32,
    step: 1,
  },
  {
    key: "lane_subflow_max_concurrent",
    label: "Subflow Lane Concurrency",
    description: "Maximum concurrent subflow runs.",
    type: "number",
    category: "runtime",
    defaultValue: 8,
    min: 1,
    max: 64,
    step: 1,
  },
  {
    key: "lane_cron_max_concurrent",
    label: "Cron Max Concurrent Runs",
    description: "Maximum number of cron jobs running concurrently.",
    type: "number",
    category: "cron",
    defaultValue: 1,
    min: 1,
    max: 16,
    step: 1,
  },
  {
    key: "channel_retry_attempts",
    label: "Channel Retry Attempts",
    description: "Retry attempts for outbound channel delivery failures.",
    type: "number",
    category: "channels",
    defaultValue: 3,
    min: 1,
    max: 10,
    step: 1,
  },
  {
    key: "channel_retry_min_delay_ms",
    label: "Channel Retry Min Delay (ms)",
    description: "Minimum retry backoff delay for channel sends.",
    type: "number",
    category: "channels",
    defaultValue: 400,
    min: 10,
    max: 10000,
    step: 10,
  },
  {
    key: "channel_retry_max_delay_ms",
    label: "Channel Retry Max Delay (ms)",
    description: "Maximum retry backoff delay for channel sends.",
    type: "number",
    category: "channels",
    defaultValue: 30000,
    min: 100,
    max: 120000,
    step: 100,
  },
  {
    key: "channel_retry_jitter",
    label: "Channel Retry Jitter",
    description: "Randomized delay spread for retry timing (0.0 to 0.5).",
    type: "number",
    category: "channels",
    defaultValue: 0.1,
    min: 0,
    max: 0.5,
    step: 0.05,
  },
  {
    key: "rate_limit_channels",
    label: "Rate Limit Channels",
    description: "Per-minute limit for channel webhook/message requests.",
    type: "number",
    category: "limits",
    defaultValue: 60,
    min: 1,
    max: 1000,
    step: 1,
  },
  {
    key: "rate_limit_webhooks",
    label: "Rate Limit Webhooks",
    description: "Per-minute limit for workflow webhooks.",
    type: "number",
    category: "limits",
    defaultValue: 30,
    min: 1,
    max: 1000,
    step: 1,
  },
  {
    key: "rate_limit_execute",
    label: "Rate Limit Execute",
    description: "Per-minute limit for direct execute API calls.",
    type: "number",
    category: "limits",
    defaultValue: 20,
    min: 1,
    max: 1000,
    step: 1,
  },
  {
    key: "tool_output_limit",
    label: "Tool Output Limit",
    description: "Maximum characters returned from tool execution output.",
    type: "number",
    category: "tools",
    defaultValue: 8000,
    min: 1000,
    max: 500000,
    step: 1000,
  },
  {
    key: "log_max_days",
    label: "Log Retention Days",
    description: "Maximum number of days retained in runtime logs.",
    type: "number",
    category: "diagnostics",
    defaultValue: 7,
    min: 1,
    max: 365,
    step: 1,
  },
  {
    key: "decay_enabled",
    label: "Memory Decay Enabled",
    description: "Apply temporal decay to non-durable memory relevance.",
    type: "boolean",
    category: "memory",
    defaultValue: true,
  },
  {
    key: "decay_half_life_days",
    label: "Memory Decay Half Life (days)",
    description: "Half-life for memory decay scoring.",
    type: "number",
    category: "memory",
    defaultValue: 30,
    min: 1,
    max: 365,
    step: 1,
  },
  {
    key: "embedding_model",
    label: "Embedding Model",
    description: "Embedding model identifier for vector indexing.",
    type: "string",
    category: "memory",
    defaultValue: "auto",
    placeholder: "auto",
  },
  {
    key: "vector_weight",
    label: "Vector Weight",
    description: "Weight for vector similarity in hybrid memory ranking.",
    type: "number",
    category: "memory",
    defaultValue: 0.7,
    min: 0,
    max: 1,
    step: 0.1,
  },
  {
    key: "text_weight",
    label: "Text Weight",
    description: "Weight for keyword/BM25 score in hybrid memory ranking.",
    type: "number",
    category: "memory",
    defaultValue: 0.3,
    min: 0,
    max: 1,
    step: 0.1,
  },
  {
    key: "index_sessions",
    label: "Index Sessions",
    description: "Enable transcript chunk indexing for session search recall.",
    type: "boolean",
    category: "memory",
    defaultValue: false,
  },
  {
    key: "session_chunk_tokens",
    label: "Session Chunk Tokens",
    description: "Token size for session chunking during indexing.",
    type: "number",
    category: "memory",
    defaultValue: 400,
    min: 50,
    max: 4000,
    step: 10,
  },
  {
    key: "session_chunk_overlap",
    label: "Session Chunk Overlap",
    description: "Overlap size between indexed session chunks.",
    type: "number",
    category: "memory",
    defaultValue: 80,
    min: 0,
    max: 500,
    step: 5,
  },
  {
    key: "startup_include_files",
    label: "Startup Include Files",
    description: "Comma/newline-separated files loaded from the selected workspace at startup. Default profile files live in data/workspace.",
    type: "multiline",
    category: "memory",
    defaultValue: "",
    emptyAsNull: true,
    placeholder: "AGENTS.md\nSOUL.md\nUSER.md",
  },
  {
    key: "max_snippet_chars",
    label: "Max Snippet Chars",
    description: "Character cap per retrieved memory snippet.",
    type: "number",
    category: "memory",
    defaultValue: 700,
    min: 100,
    max: 5000,
    step: 50,
  },
  {
    key: "max_injected_chars",
    label: "Max Injected Chars",
    description: "Total character cap for injected memory retrieval context.",
    type: "number",
    category: "memory",
    defaultValue: 4000,
    min: 500,
    max: 20000,
    step: 100,
  },
  {
    key: "citations_mode",
    label: "Citations Mode",
    description: "Citations behavior for memory retrieval responses.",
    type: "enum",
    category: "memory",
    defaultValue: "on",
    options: ["on", "off", "auto"],
  },
  {
    key: "extra_collection_paths",
    label: "Extra Collection Paths",
    description: "Additional collection paths for indexing (comma/newline-separated).",
    type: "multiline",
    category: "memory",
    defaultValue: "",
    emptyAsNull: true,
    placeholder: "data/docs\ndata/reference",
  },
];

const CONFIG_FIELD_KEYS = new Set<ConfigKey>(CONFIG_FIELDS.map((field) => field.key));

const CATEGORY_LABELS: Record<ConfigCategory, string> = {
  all: "All Settings",
  gateway: "Gateway",
  runtime: "Runtime",
  channels: "Channels",
  cron: "Cron",
  limits: "Rate Limits",
  memory: "Memory",
  tools: "Tools",
  diagnostics: "Diagnostics",
};

const CONFIG_PRESETS: Array<{
  id: string;
  label: string;
  description: string;
  values: Partial<ConfigFormState>;
}> = [
  {
    id: "balanced",
    label: "Balanced (Recommended)",
    description: "Good defaults for mixed workflows and channels.",
    values: {
      lane_main_max_concurrent: 4,
      async_delegation_max_concurrent: 3,
      lane_subflow_max_concurrent: 8,
      lane_cron_max_concurrent: 1,
      channel_retry_attempts: 3,
      channel_retry_min_delay_ms: 400,
      channel_retry_max_delay_ms: 30000,
      channel_retry_jitter: 0.1,
      rate_limit_channels: 60,
      rate_limit_webhooks: 30,
      rate_limit_execute: 20,
      telemetry_enabled: true,
      hooks_enabled: true,
      memory_flush_enabled: true,
      index_sessions: false,
      compaction_mode: "off",
    },
  },
  {
    id: "reliable",
    label: "High Reliability",
    description: "More retries + slower backoff for unstable networks.",
    values: {
      channel_retry_attempts: 5,
      channel_retry_min_delay_ms: 800,
      channel_retry_max_delay_ms: 60000,
      channel_retry_jitter: 0.2,
      rate_limit_channels: 90,
      rate_limit_webhooks: 45,
      rate_limit_execute: 30,
      compaction_mode: "summarize",
      memory_flush_enabled: true,
      lane_main_max_concurrent: 3,
      async_delegation_max_concurrent: 2,
    },
  },
  {
    id: "fast",
    label: "Throughput",
    description: "Higher concurrency and tighter retries for speed.",
    values: {
      lane_main_max_concurrent: 8,
      async_delegation_max_concurrent: 6,
      lane_subflow_max_concurrent: 16,
      lane_cron_max_concurrent: 2,
      channel_retry_attempts: 2,
      channel_retry_min_delay_ms: 200,
      channel_retry_max_delay_ms: 5000,
      channel_retry_jitter: 0.05,
      rate_limit_channels: 120,
      rate_limit_webhooks: 60,
      rate_limit_execute: 40,
      compaction_mode: "off",
    },
  },
];

function buildDefaultForm(): ConfigFormState {
  const entries = CONFIG_FIELDS.map((field) => [field.key, field.defaultValue]);
  return Object.fromEntries(entries) as ConfigFormState;
}

function normalizeTerm(value: string): string {
  return value.trim().toLowerCase();
}

function formToPayload(form: ConfigFormState): Record<string, unknown> {
  const payload: Record<string, unknown> = {};

  for (const field of CONFIG_FIELDS) {
    const value = form[field.key];
    if (field.type === "boolean") {
      payload[field.key] = value ? 1 : 0;
      continue;
    }
    if (field.type === "number") {
      const numeric = Number(value);
      payload[field.key] = Number.isFinite(numeric) ? numeric : field.defaultValue;
      continue;
    }
    if (field.type === "multiline") {
      const cleaned = String(value ?? "")
        .split(/\r?\n|,/)
        .map((part) => part.trim())
        .filter(Boolean)
        .join(",");
      payload[field.key] = cleaned || (field.emptyAsNull ? null : "");
      continue;
    }
    if (field.type === "string") {
      const text = String(value ?? "").trim();
      payload[field.key] = text || (field.emptyAsNull ? null : "");
      continue;
    }
    payload[field.key] = String(value ?? "");
  }

  return payload;
}

function payloadToForm(
  source: Record<string, unknown>,
  base: ConfigFormState = buildDefaultForm()
): ConfigFormState {
  const next = { ...base };

  for (const field of CONFIG_FIELDS) {
    const raw = source[field.key];
    if (raw === undefined) continue;

    if (field.type === "boolean") {
      next[field.key] = raw === 1 || raw === true || raw === "1";
      continue;
    }

    if (field.type === "number") {
      const numeric = Number(raw);
      if (Number.isFinite(numeric)) next[field.key] = numeric;
      continue;
    }

    if (field.type === "multiline") {
      if (raw === null || raw === undefined || raw === "") {
        next[field.key] = "";
      } else if (typeof raw === "string") {
        next[field.key] = raw
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean)
          .join("\n");
      } else {
        next[field.key] = String(raw);
      }
      continue;
    }

    next[field.key] = raw === null || raw === undefined ? "" : String(raw);
  }

  return next;
}

function pickSupportedPayload(source: Record<string, unknown>) {
  const payload: Record<string, unknown> = {};
  const ignoredKeys: string[] = [];

  for (const [key, value] of Object.entries(source)) {
    if (CONFIG_FIELD_KEYS.has(key as ConfigKey)) {
      payload[key] = value;
    } else {
      ignoredKeys.push(key);
    }
  }

  return { payload, ignoredKeys };
}

export function ConfigSettings() {
  const [form, setForm] = useState<ConfigFormState>(() => buildDefaultForm());
  const [lastLoadedForm, setLastLoadedForm] = useState<ConfigFormState>(() => buildDefaultForm());
  const [viewMode, setViewMode] = useState<ConfigViewMode>("form");
  const [rawDraft, setRawDraft] = useState("");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<ConfigCategory>("all");
  const [showChangedOnly, setShowChangedOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  const loadConfig = async () => {
    setLoading(true);
    setStatus(null);
    try {
      const response = await fetch("/api/config");
      const json = await response.json() as { success: boolean; data?: Record<string, unknown>; error?: string };
      if (!json.success || !json.data) {
        setStatus(`Error: ${json.error ?? "Failed to load config"}`);
        return;
      }

      const next = payloadToForm(json.data);
      setForm(next);
      setLastLoadedForm(next);
      setRawDraft(JSON.stringify(formToPayload(next), null, 2));
      setDirty(false);
    } catch (error) {
      console.error("[config-settings] Failed to load config:", String(error));
      setStatus(`Error: ${String(error)}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadConfig();
  }, []);

  const changedKeys = useMemo(() => {
    return CONFIG_FIELDS
      .filter((field) => form[field.key] !== lastLoadedForm[field.key])
      .map((field) => field.key);
  }, [form, lastLoadedForm]);

  const changedKeySet = useMemo(() => new Set<ConfigKey>(changedKeys), [changedKeys]);

  const visibleFields = useMemo(() => {
    const term = normalizeTerm(search);
    return CONFIG_FIELDS.filter((field) => {
      if (category !== "all" && field.category !== category) return false;
      if (showChangedOnly && !changedKeySet.has(field.key)) return false;
      if (!term) return true;

      const haystack = [
        field.key,
        field.label,
        field.description,
        field.category,
        ...(field.tags ?? []),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(term);
    });
  }, [category, changedKeySet, search, showChangedOnly]);

  const categoryCounts = useMemo(() => {
    const term = normalizeTerm(search);
    const byCategory: Record<ConfigCategory, number> = {
      all: 0,
      gateway: 0,
      runtime: 0,
      channels: 0,
      cron: 0,
      limits: 0,
      memory: 0,
      tools: 0,
      diagnostics: 0,
    };

    for (const field of CONFIG_FIELDS) {
      const haystack = [
        field.key,
        field.label,
        field.description,
        field.category,
        ...(field.tags ?? []),
      ]
        .join(" ")
        .toLowerCase();
      if (showChangedOnly && !changedKeySet.has(field.key)) continue;
      if (term && !haystack.includes(term)) continue;
      byCategory.all += 1;
      byCategory[field.category] += 1;
    }
    return byCategory;
  }, [changedKeySet, search, showChangedOnly]);

  const setFieldValue = (key: ConfigKey, value: ConfigValue) => {
    setForm((prev) => {
      const next = { ...prev, [key]: value };
      setRawDraft(JSON.stringify(formToPayload(next), null, 2));
      return next;
    });
    setDirty(true);
  };

  const applyPreset = (presetId: string) => {
    const preset = CONFIG_PRESETS.find((entry) => entry.id === presetId);
    if (!preset) return;
    setForm((prev) => {
      const next = { ...prev };
      for (const [key, value] of Object.entries(preset.values)) {
        next[key as ConfigKey] = value as ConfigValue;
      }
      setRawDraft(JSON.stringify(formToPayload(next), null, 2));
      return next;
    });
    setDirty(true);
    setStatus(`Preset applied: ${preset.label}`);
  };

  const restoreLastLoaded = () => {
    const next = { ...lastLoadedForm };
    setForm(next);
    setRawDraft(JSON.stringify(formToPayload(next), null, 2));
    setDirty(false);
    setStatus("Restored last loaded config.");
  };

  const resetCurrentCategoryToDefaults = () => {
    setForm((prev) => {
      const next = { ...prev };
      for (const field of CONFIG_FIELDS) {
        if (category !== "all" && field.category !== category) continue;
        next[field.key] = field.defaultValue;
      }
      setRawDraft(JSON.stringify(formToPayload(next), null, 2));
      return next;
    });
    setDirty(true);
    setStatus(`Reset ${CATEGORY_LABELS[category]} fields to defaults.`);
  };

  const resetSingleField = (key: ConfigKey) => {
    const field = CONFIG_FIELDS.find((entry) => entry.key === key);
    if (!field) return;
    setFieldValue(key, field.defaultValue);
  };

  const exportConfig = () => {
    const text = viewMode === "raw" ? rawDraft : JSON.stringify(formToPayload(form), null, 2);
    const blob = new Blob([text], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    anchor.download = `disp8ch-config-${stamp}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    setStatus(viewMode === "raw" ? "Exported raw config draft." : "Exported config.");
  };

  const importConfigFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        setStatus("Error: Imported file must contain a JSON object.");
        return;
      }

      const { payload, ignoredKeys } = pickSupportedPayload(parsed as Record<string, unknown>);
      if (Object.keys(payload).length === 0) {
        setStatus("Error: Imported file did not contain any supported config keys.");
        return;
      }

      const nextForm = payloadToForm(payload, form);
      setForm(nextForm);
      setRawDraft(JSON.stringify(payload, null, 2));
      setDirty(true);
      setStatus(
        ignoredKeys.length > 0
          ? `Imported config draft. Ignored ${ignoredKeys.length} unsupported key${ignoredKeys.length === 1 ? "" : "s"}.`
          : "Imported config draft."
      );
    } catch (error) {
      setStatus(`Error: Failed to import config (${String(error)})`);
    } finally {
      event.target.value = "";
    }
  };

  const saveConfig = async () => {
    setSaving(true);
    setStatus(null);
    try {
      let payload: Record<string, unknown>;
      if (viewMode === "raw") {
        const parsed = JSON.parse(rawDraft) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          setStatus("Error: Raw editor must contain a JSON object.");
          return;
        }
        payload = parsed as Record<string, unknown>;
      } else {
        payload = formToPayload(form);
      }

      const response = await fetch("/api/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await response.json() as { success: boolean; error?: string };
      if (!json.success) {
        setStatus(`Error: ${json.error ?? "Failed to save config"}`);
        return;
      }

      setStatus("Saved.");
      setDirty(false);
      await loadConfig();
    } catch (error) {
      console.error("[config-settings] Failed to save config:", String(error));
      setStatus(`Error: ${String(error)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Config</CardTitle>
          <CardDescription>
            Search and edit runtime settings from one place with a form-first editor.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={() => void loadConfig()} disabled={loading}>
              <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
              Reload
            </Button>
            <Button onClick={() => void saveConfig()} disabled={saving || !dirty}>
              <Save className="mr-2 h-4 w-4" />
              {saving ? "Saving..." : "Save"}
            </Button>
            <Button
              variant="outline"
              onClick={restoreLastLoaded}
              disabled={loading || !dirty}
            >
              <Undo2 className="mr-2 h-4 w-4" />
              Restore Loaded
            </Button>
            <Button
              variant="outline"
              onClick={resetCurrentCategoryToDefaults}
              disabled={loading}
            >
              <RotateCcw className="mr-2 h-4 w-4" />
              Reset {CATEGORY_LABELS[category]}
            </Button>
            <Button variant="outline" onClick={() => importInputRef.current?.click()} disabled={loading}>
              <Upload className="mr-2 h-4 w-4" />
              Import JSON
            </Button>
            <Button variant="outline" onClick={exportConfig}>
              <Download className="mr-2 h-4 w-4" />
              Export JSON
            </Button>
            <input
              ref={importInputRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(event) => void importConfigFile(event)}
            />
            <Badge variant={dirty ? "secondary" : "outline"}>{dirty ? "Unsaved changes" : "No changes"}</Badge>
            <Badge variant="outline">Changed fields: {changedKeys.length}</Badge>
            {status ? (
              <span className={`text-sm ${status.startsWith("Error") ? "text-destructive" : "text-muted-foreground"}`}>
                {status}
              </span>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant={viewMode === "form" ? "default" : "outline"}
              onClick={() => setViewMode("form")}
            >
              Form
            </Button>
            <Button
              variant={viewMode === "raw" ? "default" : "outline"}
              onClick={() => setViewMode("raw")}
            >
              <Braces className="mr-2 h-4 w-4" />
              Raw JSON
            </Button>
          </div>

          <div className="grid gap-2 md:grid-cols-3">
            {CONFIG_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => applyPreset(preset.id)}
                className="rounded-md border p-2 text-left transition-colors hover:bg-accent"
              >
                <div className="mb-1 flex items-center gap-1 text-sm font-medium">
                  <Wand2 className="h-3.5 w-3.5" />
                  {preset.label}
                </div>
                <p className="text-xs text-muted-foreground">{preset.description}</p>
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {viewMode === "raw" ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Raw JSON Editor</CardTitle>
            <CardDescription>
              Paste a JSON object with config keys, then click Save.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Textarea
              value={rawDraft}
              onChange={(event) => {
                setRawDraft(event.target.value);
                setDirty(true);
              }}
              rows={24}
              className="font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">
              Tip: only include keys you want to change. Example: <code>{`{"rate_limit_channels":90,"telemetry_enabled":1}`}</code>
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Settings</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  className="pl-8"
                  placeholder="Search settings..."
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </div>

              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <input
                  type="checkbox"
                  checked={showChangedOnly}
                  onChange={(event) => setShowChangedOnly(event.target.checked)}
                />
                Show changed only
              </label>

              <div className="space-y-1">
                {CATEGORY_ORDER.map((entry) => (
                  <button
                    key={entry}
                    type="button"
                    onClick={() => setCategory(entry)}
                    className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-sm transition-colors ${
                      category === entry
                        ? "bg-accent text-accent-foreground"
                        : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                    }`}
                  >
                    <span>{CATEGORY_LABELS[entry]}</span>
                    <Badge variant="outline" className="ml-2">
                      {categoryCounts[entry]}
                    </Badge>
                  </button>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                {CATEGORY_LABELS[category]} ({visibleFields.length})
              </CardTitle>
              <CardDescription>
                Use this form to edit supported config keys. Fields map directly to <code>app_config</code> and <code>memory_config</code>.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {visibleFields.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {showChangedOnly ? "No changed settings match your filter." : "No settings match your filter."}
                </p>
              ) : null}

              {visibleFields.map((field) => {
                const value = form[field.key];
                return (
                  <div key={field.key} className="rounded-md border p-3">
                    <div className="mb-2 flex items-start justify-between gap-3">
                      <div>
                        <Label className="text-sm font-semibold">{field.label}</Label>
                        <p className="mt-1 text-xs text-muted-foreground">{field.description}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge variant="outline">{field.key}</Badge>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => resetSingleField(field.key)}
                        >
                          Reset
                        </Button>
                      </div>
                    </div>

                    {field.type === "boolean" ? (
                      <div className="flex justify-end">
                        <Switch
                          checked={Boolean(value)}
                          onCheckedChange={(checked) => setFieldValue(field.key, checked)}
                        />
                      </div>
                    ) : null}

                    {field.type === "number" ? (
                      <Input
                        type="number"
                        value={Number(value)}
                        min={field.min}
                        max={field.max}
                        step={field.step}
                        onChange={(event) => {
                          const next = Number(event.target.value);
                          setFieldValue(field.key, Number.isFinite(next) ? next : field.defaultValue);
                        }}
                      />
                    ) : null}

                    {field.type === "enum" ? (
                      <Select
                        value={String(value)}
                        onValueChange={(next) => setFieldValue(field.key, next)}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {(field.options ?? []).map((option) => (
                            <SelectItem key={`${field.key}:${option}`} value={option}>
                              {option}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : null}

                    {field.type === "string" ? (
                      <Input
                        value={String(value ?? "")}
                        placeholder={field.placeholder}
                        onChange={(event) => setFieldValue(field.key, event.target.value)}
                      />
                    ) : null}

                    {field.type === "multiline" ? (
                      <Textarea
                        value={String(value ?? "")}
                        placeholder={field.placeholder}
                        rows={3}
                        onChange={(event) => setFieldValue(field.key, event.target.value)}
                      />
                    ) : null}
                  </div>
                );
              })}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
