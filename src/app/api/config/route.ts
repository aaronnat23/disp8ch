import { NextResponse } from "next/server";
import { z } from "zod";
import { getSqlite } from "@/lib/db";
import { logger } from "@/lib/utils/logger";
import { clearModelRuntimeConfigCache } from "@/lib/agents/model-runtime-config";
import { requireOperatorAccess } from "@/lib/security/admin";

const log = logger.child("api:config");

// Fields that live in memory_config instead of app_config
const MEMORY_CONFIG_FIELDS = new Set([
  "decay_enabled",
  "decay_half_life_days",
  "embedding_model",
  "vector_weight",
  "text_weight",
  "index_sessions",
  "session_chunk_tokens",
  "session_chunk_overlap",
  "startup_include_files",
  "startup_exclude_files",
  "max_snippet_chars",
  "max_injected_chars",
  "citations_mode",
  "extra_collection_paths",
  "search_backend",
  "rerank_strategy",
  "query_expansion_enabled",
  "strong_signal_enabled",
  "rerank_candidate_limit",
]);

const PatchSchema = z.object({
  // app_config
  timezone: z.string().optional(),
  learning_enabled: z.number().int().min(0).max(1).optional(),
  learning_mode: z.enum(["off", "review", "auto"]).optional(),
  learning_capture_preferences: z.number().int().min(0).max(1).optional(),
  learning_capture_playbooks: z.number().int().min(0).max(1).optional(),
  learning_auto_promote_threshold: z.number().int().min(1).max(10).optional(),
  learning_show_feedback: z.number().int().min(0).max(1).optional(),
  backup_enabled: z.number().int().min(0).max(1).optional(),
  backup_cron: z.string().max(120).optional(),
  backup_retention_count: z.number().int().min(1).max(200).optional(),
  backup_include_logs: z.number().int().min(0).max(1).optional(),
  backup_replication_mode: z.enum(["off", "mirror-copy", "rsync"]).optional(),
  backup_replication_target: z.string().max(1000).nullable().optional(),
  backup_replication_rsync_args: z.string().max(500).nullable().optional(),
  learning_llm_review_enabled: z.number().int().min(0).max(1).optional(),
  learning_llm_review_interval: z.number().int().min(1).max(50).optional(),
  tool_output_limit: z.number().int().min(1000).max(500000).optional(),
  compaction_mode: z.enum(["off", "summarize", "drop"]).optional(),
  compaction_threshold: z.number().min(0.1).max(0.95).optional(),
  context_window: z.number().int().min(1000).optional(),
  memory_flush_soft_threshold_tokens: z.number().int().min(0).max(500000).optional(),
  compaction_keep_recent_tokens: z.number().int().min(2000).max(500000).optional(),
  compaction_reserve_tokens_floor: z.number().int().min(1000).max(500000).optional(),
  compaction_model_ref: z.string().max(200).nullable().optional(),
  compaction_identifier_policy: z.enum(["strict", "off", "custom"]).optional(),
  compaction_identifier_instructions: z.string().max(2000).nullable().optional(),
  compaction_quality_guard_enabled: z.number().int().min(0).max(1).optional(),
  compaction_quality_guard_max_retries: z.number().int().min(0).max(5).optional(),
  context_pruning_mode: z.enum(["off", "tool-results"]).optional(),
  context_pruning_keep_recent_assistants: z.number().int().min(1).max(12).optional(),
  context_pruning_min_tool_chars: z.number().int().min(1000).max(200000).optional(),
  context_pruning_max_tool_chars: z.number().int().min(500).max(20000).optional(),
  context_pruning_head_chars: z.number().int().min(100).max(10000).optional(),
  context_pruning_tail_chars: z.number().int().min(100).max(10000).optional(),
  channel_retry_attempts: z.number().int().min(1).max(10).optional(),
  channel_retry_min_delay_ms: z.number().int().min(10).max(10000).optional(),
  channel_retry_max_delay_ms: z.number().int().min(100).max(120000).optional(),
  channel_retry_jitter: z.number().min(0).max(0.5).optional(),
  provenance_mode: z.enum(["off", "meta", "meta+receipt"]).optional(),
  acp_auth_mode: z.enum(["off", "bearer"]).optional(),
  acp_auth_secret_name: z.string().max(128).nullable().optional(),
  install_posture: z.enum(["local_only", "trusted_lan", "exposed"]).optional(),
  disable_loopback_bypass: z.number().int().min(0).max(1).optional(),
  operator_auth_backoff_enabled: z.number().int().min(0).max(1).optional(),
  mcp_security_posture: z.enum(["open", "guarded", "strict"]).optional(),
  channel_access_mode: z.enum(["open", "allowlist", "pairing"]).optional(),
  website_policy_mode: z.enum(["off", "blocklist", "allowlist"]).optional(),
  website_policy_domains: z.string().nullable().optional(),
  web_search_provider: z.enum(["duckduckgo", "tavily", "exa", "brave"]).optional(),
  web_search_api_key: z.string().max(500).nullable().optional(),
  browser_backend: z.enum(["playwright", "auto", "cdp-existing"]).optional(),
  browser_cdp_url: z.string().max(500).nullable().optional(),
  checkpoint_enabled: z.number().int().min(0).max(1).optional(),
  image_generation_api_key: z.string().max(500).nullable().optional(),
  mcp_servers: z.string().nullable().optional(),
  voice_stt_provider: z.enum(["openai-whisper", "local-whisper", "deepgram"]).optional(),
  voice_stt_api_key: z.string().max(500).nullable().optional(),
  voice_tts_provider: z.enum(["openai", "elevenlabs", "azure-tts"]).optional(),
  voice_tts_api_key: z.string().max(500).nullable().optional(),
  voice_tts_voice_model: z.string().max(200).nullable().optional(),
  smart_model_routing_enabled: z.number().int().min(0).max(1).optional(),
  smart_model_routing_max_chars: z.number().int().min(40).max(2000).optional(),
  smart_model_routing_max_words: z.number().int().min(4).max(300).optional(),
  pending_mutation_ttl_ms: z.number().int().min(1000).max(86400000).optional(),
  anthropic_prompt_caching_enabled: z.number().int().min(0).max(1).optional(),
  telemetry_enabled: z.number().int().min(0).max(1).optional(),
  hooks_enabled: z.number().int().min(0).max(1).optional(),
  memory_flush_enabled: z.number().int().min(0).max(1).optional(),
  rate_limit_webhooks: z.number().int().min(1).max(1000).optional(),
  rate_limit_execute: z.number().int().min(1).max(1000).optional(),
  rate_limit_channels: z.number().int().min(1).max(1000).optional(),
  log_max_days: z.number().int().min(1).max(365).optional(),
  async_delegation_max_concurrent: z.number().int().min(1).max(16).optional(),
  lane_main_max_concurrent: z.number().int().min(1).max(32).optional(),
  lane_cron_max_concurrent: z.number().int().min(1).max(16).optional(),
  lane_subflow_max_concurrent: z.number().int().min(1).max(64).optional(),
  // memory_config
  decay_enabled: z.number().int().min(0).max(1).optional(),
  decay_half_life_days: z.number().int().min(1).max(365).optional(),
  embedding_model: z.string().max(200).optional(),
  vector_weight: z.number().min(0).max(1).optional(),
  text_weight: z.number().min(0).max(1).optional(),
  index_sessions: z.number().int().min(0).max(1).optional(),
  session_chunk_tokens: z.number().int().min(50).max(4000).optional(),
  session_chunk_overlap: z.number().int().min(0).max(500).optional(),
  startup_include_files: z.string().nullable().optional(),
  startup_exclude_files: z.string().nullable().optional(),
  max_snippet_chars: z.number().int().min(100).max(5000).optional(),
  max_injected_chars: z.number().int().min(500).max(20000).optional(),
  citations_mode: z.enum(["on", "off", "auto"]).optional(),
  extra_collection_paths: z.string().nullable().optional(),
  search_backend: z.enum(["builtin", "qmd-like"]).optional(),
  rerank_strategy: z.enum(["auto", "mmr", "local", "model", "off"]).optional(),
  query_expansion_enabled: z.number().int().min(0).max(1).optional(),
  strong_signal_enabled: z.number().int().min(0).max(1).optional(),
  rerank_candidate_limit: z.number().int().min(5).max(80).optional(),
});

export async function GET(request: Request) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const db = getSqlite();
    const appRow = db.prepare("SELECT * FROM app_config WHERE id = 'default'").get() as Record<string, unknown> | undefined;
    if (!appRow) {
      return NextResponse.json({ success: false, error: "Config not found" }, { status: 404 });
    }
    // Merge in memory_config fields so the client gets everything in one call
    const memRow = db
      .prepare("SELECT decay_enabled, decay_half_life_days, embedding_model, vector_weight, text_weight, index_sessions, session_chunk_tokens, session_chunk_overlap, startup_include_files, startup_exclude_files, max_snippet_chars, max_injected_chars, citations_mode, extra_collection_paths, search_backend, rerank_strategy, query_expansion_enabled, strong_signal_enabled, rerank_candidate_limit FROM memory_config WHERE id = 'default'")
      .get() as Record<string, unknown> | undefined;
    return NextResponse.json({ success: true, data: { ...appRow, ...(memRow ?? {}) } });
  } catch (error) {
    log.error("GET /api/config failed", { error: String(error) });
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const denied = await requireOperatorAccess(req);
    if (denied) return denied;
    const body = await req.json() as unknown;
    const parsed = PatchSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ success: false, error: parsed.error.message }, { status: 400 });
    }

    const updates = parsed.data;
    const keys = Object.keys(updates) as (keyof typeof updates)[];
    if (keys.length === 0) {
      return NextResponse.json({ success: false, error: "No fields to update" }, { status: 400 });
    }

    const db = getSqlite();
    const now = new Date().toISOString();

    // Split fields by target table
    const appKeys = keys.filter((k) => !MEMORY_CONFIG_FIELDS.has(k));
    const memKeys = keys.filter((k) => MEMORY_CONFIG_FIELDS.has(k));

    if (appKeys.length > 0) {
      const setClauses = [...appKeys.map((k) => `${k} = ?`), "updated_at = ?"].join(", ");
      const values = [...appKeys.map((k) => updates[k]), now];
      db.prepare(`UPDATE app_config SET ${setClauses} WHERE id = 'default'`).run(...values);
      if (appKeys.includes("mcp_servers")) {
        const { syncMCPServers } = await import("@/lib/mcp/registry");
        await syncMCPServers();
      }
      if (
        appKeys.some((key) =>
          [
            "smart_model_routing_enabled",
            "smart_model_routing_max_chars",
            "smart_model_routing_max_words",
            "anthropic_prompt_caching_enabled",
          ].includes(String(key)),
        )
      ) {
        clearModelRuntimeConfigCache();
      }
      if (
        appKeys.some((key) =>
          [
            "backup_enabled",
            "backup_cron",
            "backup_retention_count",
            "backup_include_logs",
            "backup_replication_mode",
            "backup_replication_target",
            "backup_replication_rsync_args",
          ].includes(String(key)),
        )
      ) {
        const { initBackupManager } = await import("@/lib/backup/policy");
        initBackupManager();
      }
    }

    if (memKeys.length > 0) {
      const setClauses = [...memKeys.map((k) => `${k} = ?`), "updated_at = ?"].join(", ");
      const values = [...memKeys.map((k) => updates[k]), now];
      db.prepare(`UPDATE memory_config SET ${setClauses} WHERE id = 'default'`).run(...values);
    }

    const appRow = db.prepare("SELECT * FROM app_config WHERE id = 'default'").get() as Record<string, unknown>;
    const memRow = db
      .prepare("SELECT decay_enabled, decay_half_life_days, embedding_model, vector_weight, text_weight, index_sessions, session_chunk_tokens, session_chunk_overlap, startup_include_files, startup_exclude_files, max_snippet_chars, max_injected_chars, citations_mode, extra_collection_paths, search_backend, rerank_strategy, query_expansion_enabled, strong_signal_enabled, rerank_candidate_limit FROM memory_config WHERE id = 'default'")
      .get() as Record<string, unknown> | undefined;
    return NextResponse.json({ success: true, data: { ...appRow, ...(memRow ?? {}) } });
  } catch (error) {
    log.error("PATCH /api/config failed", { error: String(error) });
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
