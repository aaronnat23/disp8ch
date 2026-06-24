import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";
import path from "node:path";
import fs from "node:fs";
import { ensureWorkspaceScaffold } from "@/lib/workspace/files";
import { upgradeChannelBoardWorkflowNodes } from "@/lib/workflows/channel-board";
import { loadSqliteVecForDatabase } from "./sqlite-vec-loader";

let db: ReturnType<typeof drizzle> | null = null;
let sqlite: Database.Database | null = null;
let sqlitePath: string | null = null;
const sqliteRecoveryStatus = {
  attempts: 0,
  successes: 0,
  failures: 0,
  lastReason: null as string | null,
  lastError: null as string | null,
  lastRecoveredAt: null as string | null,
};

function openSqliteConnection(): Database.Database {
  const dbPath = process.env.DATABASE_PATH || "./data/disp8ch.db";
  const resolvedPath = path.resolve(dbPath);
  sqlitePath = resolvedPath;
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

  const connection = new Database(resolvedPath);
  loadSqliteVecForDatabase(connection as unknown as object);
  connection.pragma("busy_timeout = 5000");
  if (process.platform === "win32") {
    connection.pragma("journal_mode = DELETE");
  } else {
    try {
      connection.pragma("journal_mode = WAL");
    } catch {
      // Some desktop/synced folders reject WAL sidecar writes. DELETE mode is
      // slower but keeps a fresh install usable instead of failing onboarding.
      connection.pragma("journal_mode = DELETE");
    }
  }
  connection.pragma("foreign_keys = ON");
  return connection;
}

export function getDb() {
  if (db) return db;
  sqlite = openSqliteConnection();

  db = drizzle(sqlite, { schema });
  return db;
}

export function getSqlite() {
  if (!sqlite) {
    getDb();
  }
  return sqlite!;
}

function isRecoverableSqliteError(error: unknown): boolean {
  const message = String(error);
  return (
    message.includes("SQLITE_READONLY") ||
    message.includes("attempt to write a readonly database") ||
    message.includes("SQLITE_IOERR") ||
    message.includes("SQLITE_CANTOPEN")
  );
}

export function reopenSqliteConnection(reason: string, error?: unknown): boolean {
  if (!isRecoverableSqliteError(error ?? reason)) {
    return false;
  }
  sqliteRecoveryStatus.attempts += 1;
  sqliteRecoveryStatus.lastReason = reason;
  sqliteRecoveryStatus.lastError = error ? String(error) : null;

  try {
    sqlite?.close();
  } catch {
    // Best-effort close only.
  }

  sqlite = null;
  db = null;

  try {
    sqlite = openSqliteConnection();
    db = drizzle(sqlite, { schema });
    sqliteRecoveryStatus.successes += 1;
    sqliteRecoveryStatus.lastRecoveredAt = new Date().toISOString();
    return true;
  } catch (reopenError) {
    try {
      sqlite?.close();
    } catch {
      // Best-effort close only.
    }
    sqlite = null;
    db = null;
    sqliteRecoveryStatus.failures += 1;
    throw new Error(
      `Failed to reopen SQLite connection for ${reason} at ${sqlitePath || "unknown path"}: ${String(reopenError)}`,
    );
  }
}

export function withSqliteWriteRecovery<T>(
  reason: string,
  operation: (database: Database.Database) => T,
): T {
  let attempt = 0;
  let lastError: unknown;

  while (attempt < 2) {
    const database = getSqlite();
    try {
      return operation(database);
    } catch (error) {
      lastError = error;
      if (attempt === 0 && reopenSqliteConnection(reason, error)) {
        attempt += 1;
        continue;
      }
      throw error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function getSqliteRecoveryStatus() {
  return { ...sqliteRecoveryStatus };
}

function repairLegacyWorkflowTemplates(database: Database.Database): void {
  const replacements: Array<[string, string]> = [
    ["{{result_requestBody}}", "{{run.result.requestBody}}"],
    ["{{result_summaryPrompt}}", "{{run.result.summaryPrompt}}"],
    ["{{result_seedUrl}}", "{{run.result.seedUrl}}"],
    ["{{result_strategy}}", "{{run.result.strategy}}"],
    ["{{result_maxPages}}", "{{run.result.maxPages}}"],
    ["{{result_maxDepth}}", "{{run.result.maxDepth}}"],
    [
      "description: 'Auto-created by cron workflow. ISO timestamp: ' + now.toISOString(),\\n  status: 'inbox',\\n  priority: 'medium'",
      "description: 'Auto-created by cron workflow. ISO timestamp: ' + now.toISOString(),\\n  sourceType: 'cron-generated',\\n  sourceRef: 'cron-board-task-creator',\\n  status: 'inbox',\\n  priority: 'medium'",
    ],
    [
      "\"url\":\"http://localhost:3100/api/boards/tasks\"",
      "\"url\":\"http://127.0.0.1:3100/api/boards/tasks\"",
    ],
  ];

  const rows = database
    .prepare("SELECT id, nodes FROM workflows")
    .all() as Array<{ id: string; nodes: string }>;

  const update = database.prepare("UPDATE workflows SET nodes = ?, updated_at = ? WHERE id = ?");
  const now = new Date().toISOString();

  const applyRepair = database.transaction(() => {
    for (const row of rows) {
      let nextNodes = row.nodes;
      for (const [from, to] of replacements) {
        nextNodes = nextNodes.split(from).join(to);
      }
      nextNodes = upgradeChannelBoardWorkflowNodes(nextNodes);
      if (nextNodes !== row.nodes) {
        update.run(nextNodes, now, row.id);
      }
    }
  });

  applyRepair();
}

function execIgnoringDuplicateColumn(database: Database.Database, sql: string): void {
  try {
    database.exec(sql);
  } catch (error) {
    const message = String(error);
    if (!message.includes("duplicate column name")) {
      throw error;
    }
  }
}

function isMalformedSqliteError(error: unknown): boolean {
  const message = String(error);
  return message.includes("database disk image is malformed") || message.includes("SQLITE_CORRUPT");
}

function repairCollectionChunkEmbeddingTable(database: Database.Database): boolean {
  try {
    database.exec("DROP TABLE IF EXISTS collection_chunk_embeddings");
    database.exec(`
      CREATE TABLE IF NOT EXISTS collection_chunk_embeddings (
        id TEXT PRIMARY KEY,
        embedding TEXT NOT NULL,
        provider_id TEXT NOT NULL DEFAULT 'unknown',
        provider_key TEXT NOT NULL DEFAULT '',
        model_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    return true;
  } catch {
    return false;
  }
}

function quoteSqlIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, "\"\"")}"`;
}

function dropLegacyMainDbVectorArtifacts(database: Database.Database): void {
  const legacyArtifacts = database
    .prepare(`
      SELECT type, name
      FROM sqlite_master
      WHERE name = 'memory_vector_index'
         OR name LIKE 'memory_vectors_vec_%'
      ORDER BY
        CASE type
          WHEN 'table' THEN 0
          WHEN 'index' THEN 1
          WHEN 'trigger' THEN 2
          WHEN 'view' THEN 3
          ELSE 4
        END,
        CASE
          WHEN name = 'memory_vector_index' THEN 0
          ELSE 1
        END,
        LENGTH(name) DESC,
        name DESC
    `)
    .all() as Array<{ type: string; name: string }>;

  for (const artifact of legacyArtifacts) {
    const identifier = quoteSqlIdentifier(artifact.name);
    if (artifact.type === "view") {
      database.exec(`DROP VIEW IF EXISTS ${identifier}`);
      continue;
    }
    database.exec(`DROP ${artifact.type.toUpperCase()} IF EXISTS ${identifier}`);
  }
}

export function initializeDatabase() {
  const database = getSqlite();

  // Ensure workspace markdown scaffold exists for memory/context flows.
  ensureWorkspaceScaffold();
  dropLegacyMainDbVectorArtifacts(database);

  database.exec(`
    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      nodes TEXT NOT NULL,
      edges TEXT NOT NULL,
      organization_id TEXT,
      goal_id TEXT,
      source_type TEXT,
      source_ref TEXT,
      schedule_profile TEXT,
      policy TEXT,
      is_active INTEGER DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS executions (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      status TEXT NOT NULL,
      trigger_type TEXT NOT NULL,
      trigger_data TEXT,
      provenance TEXT,
      node_results TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      config TEXT NOT NULL,
      is_active INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS models (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      model_id TEXT NOT NULL,
      name TEXT NOT NULL,
      api_key TEXT NOT NULL,
      priority INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      max_tokens INTEGER,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS webhooks (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      name TEXT NOT NULL,
      secret TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_config (
      id TEXT PRIMARY KEY,
      onboarding_done INTEGER DEFAULT 0,
      timezone TEXT DEFAULT 'UTC',
      learning_enabled INTEGER DEFAULT 1,
      learning_mode TEXT DEFAULT 'review',
      learning_capture_preferences INTEGER DEFAULT 1,
      learning_capture_playbooks INTEGER DEFAULT 1,
      learning_auto_promote_threshold INTEGER DEFAULT 2,
      learning_show_feedback INTEGER DEFAULT 1,
      backup_enabled INTEGER DEFAULT 0,
      backup_cron TEXT DEFAULT '0 */6 * * *',
      backup_retention_count INTEGER DEFAULT 14,
      backup_include_logs INTEGER DEFAULT 0,
      backup_replication_mode TEXT DEFAULT 'off',
      backup_replication_target TEXT,
      backup_replication_rsync_args TEXT,
      backup_last_run_at TEXT,
      backup_last_success_at TEXT,
      backup_last_error TEXT,
      backup_last_backup_id TEXT,
      provenance_mode TEXT DEFAULT 'meta',
      acp_auth_mode TEXT DEFAULT 'off',
      acp_auth_secret_name TEXT,
      install_posture TEXT DEFAULT 'local_only',
      disable_loopback_bypass INTEGER DEFAULT 0,
      operator_auth_backoff_enabled INTEGER DEFAULT 1,
      mcp_security_posture TEXT DEFAULT 'guarded',
      channel_access_mode TEXT DEFAULT 'open',
      website_policy_mode TEXT DEFAULT 'off',
      website_policy_domains TEXT DEFAULT '',
      smart_model_routing_enabled INTEGER DEFAULT 0,
      smart_model_routing_max_chars INTEGER DEFAULT 160,
      smart_model_routing_max_words INTEGER DEFAULT 28,
      anthropic_prompt_caching_enabled INTEGER DEFAULT 1,
      web_search_provider TEXT DEFAULT 'duckduckgo',
      web_search_api_key TEXT DEFAULT NULL,
      browser_backend TEXT DEFAULT 'playwright',
      browser_cdp_url TEXT DEFAULT NULL,
      compaction_mode TEXT DEFAULT 'off',
      compaction_threshold REAL DEFAULT 0.75,
      context_window INTEGER DEFAULT 200000,
      memory_flush_enabled INTEGER DEFAULT 1,
      memory_flush_soft_threshold_tokens INTEGER DEFAULT 4000,
      compaction_keep_recent_tokens INTEGER DEFAULT 20000,
      compaction_reserve_tokens_floor INTEGER DEFAULT 20000,
      compaction_model_ref TEXT,
      compaction_identifier_policy TEXT DEFAULT 'strict',
      compaction_identifier_instructions TEXT,
      compaction_quality_guard_enabled INTEGER DEFAULT 0,
      compaction_quality_guard_max_retries INTEGER DEFAULT 1,
      context_pruning_mode TEXT DEFAULT 'tool-results',
      context_pruning_keep_recent_assistants INTEGER DEFAULT 3,
      context_pruning_min_tool_chars INTEGER DEFAULT 12000,
      context_pruning_max_tool_chars INTEGER DEFAULT 4000,
      context_pruning_head_chars INTEGER DEFAULT 1500,
      context_pruning_tail_chars INTEGER DEFAULT 1500,
      async_delegation_max_concurrent INTEGER DEFAULT 3,
      lane_main_max_concurrent INTEGER DEFAULT 4,
      lane_cron_max_concurrent INTEGER DEFAULT 1,
      lane_subflow_max_concurrent INTEGER DEFAULT 8,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory_config (
      id TEXT PRIMARY KEY,
      tier TEXT NOT NULL,
      auto_threshold INTEGER DEFAULT 50,
      total_memories INTEGER DEFAULT 0,
      storage_bytes INTEGER DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL DEFAULT 'default',
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata TEXT,
      provenance TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session_followups (
      session_id TEXT PRIMARY KEY,
      message TEXT,
      hidden_payload TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_session_followups_updated_at ON session_followups(updated_at DESC);

    CREATE TABLE IF NOT EXISTS channel_session_settings (
      session_id TEXT PRIMARY KEY,
      fast_mode INTEGER,
      agent_id TEXT,
      model_ref TEXT,
      workspace_path TEXT,
      tool_mode TEXT DEFAULT 'default',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_channel_session_settings_updated_at ON channel_session_settings(updated_at DESC);

    CREATE TABLE IF NOT EXISTS channel_session_turns (
      client_turn_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL,
      message TEXT NOT NULL,
      response TEXT,
      error TEXT,
      metadata TEXT,
      provenance TEXT,
      request_payload TEXT,
      stream_content TEXT,
      worker_id TEXT,
      lease_expires_at TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_channel_session_turns_session_updated
      ON channel_session_turns(session_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_channel_session_turns_status_updated
      ON channel_session_turns(status, updated_at ASC);

    CREATE TABLE IF NOT EXISTS channel_session_app_state (
      session_id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_channel_session_app_state_updated_at ON channel_session_app_state(updated_at DESC);

    CREATE TABLE IF NOT EXISTS chat_attachments (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      path TEXT NOT NULL,
      metadata TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_attachments_session_created
      ON chat_attachments(session_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS trusted_workspaces (
      path TEXT PRIMARY KEY,
      label TEXT,
      source TEXT NOT NULL DEFAULT 'local',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_trusted_workspaces_updated ON trusted_workspaces(updated_at DESC);

    CREATE TABLE IF NOT EXISTS channel_session_startup_snapshots (
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL DEFAULT 'default',
      workspace_path TEXT NOT NULL,
      startup_context TEXT NOT NULL,
      source_files_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (session_id, agent_id)
    );
    CREATE INDEX IF NOT EXISTS idx_channel_session_startup_snapshots_updated_at
      ON channel_session_startup_snapshots(updated_at DESC);

    CREATE TABLE IF NOT EXISTS background_jobs (
      id TEXT PRIMARY KEY,
      tool_name TEXT NOT NULL,
      command_preview TEXT NOT NULL,
      cwd TEXT,
      session_id TEXT,
      agent_id TEXT,
      notify_on_complete INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      pid INTEGER,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      exit_code INTEGER,
      stdout TEXT,
      stderr TEXT,
      metadata TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_background_jobs_session_started
      ON background_jobs(session_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_background_jobs_status_started
      ON background_jobs(status, started_at DESC);

    CREATE TABLE IF NOT EXISTS memory_promotion_events (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      entry_id TEXT,
      event_kind TEXT NOT NULL,
      source TEXT NOT NULL,
      content TEXT NOT NULL,
      backfill_run_id TEXT,
      detail_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_promotion_events_agent_created
      ON memory_promotion_events(agent_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_promotion_events_backfill
      ON memory_promotion_events(backfill_run_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS channel_sender_access (
      channel TEXT NOT NULL,
      subject_key TEXT NOT NULL,
      subject_label TEXT,
      approved_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (channel, subject_key)
    );

    CREATE TABLE IF NOT EXISTS learning_events (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      scope TEXT NOT NULL,
      scope_id TEXT,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_learning_events_fingerprint ON learning_events(fingerprint, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_learning_events_created_at ON learning_events(created_at DESC);

    CREATE TABLE IF NOT EXISTS learning_candidates (
      id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'proposed',
      kind TEXT NOT NULL,
      scope TEXT NOT NULL,
      scope_id TEXT,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      content TEXT,
      confidence REAL DEFAULT 0,
      evidence_count INTEGER DEFAULT 1,
      source_event_ids TEXT NOT NULL DEFAULT '[]',
      target_path TEXT,
      promoted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_learning_candidates_status ON learning_candidates(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_learning_candidates_updated_at ON learning_candidates(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_channel_sender_access_approved_at ON channel_sender_access(approved_at DESC);

    CREATE TABLE IF NOT EXISTS channel_pairings (
      code TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      subject_key TEXT NOT NULL,
      subject_label TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      approved_at TEXT,
      denied_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_channel_pairings_status_created_at ON channel_pairings(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_channel_pairings_subject ON channel_pairings(channel, subject_key, status);

    CREATE TABLE IF NOT EXISTS extension_installs (
      extension_id TEXT PRIMARY KEY,
      install_source TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      install_ref TEXT,
      source_revision TEXT,
      root_dir TEXT NOT NULL,
      manifest_path TEXT NOT NULL,
      runtime_path TEXT,
      scan_status TEXT DEFAULT 'pass',
      scan_summary TEXT,
      scan_findings TEXT,
      scanned_at TEXT,
      installed_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_extension_installs_updated_at ON extension_installs(updated_at DESC);

    CREATE TABLE IF NOT EXISTS session_todos (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      content TEXT NOT NULL,
      is_done INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_session_todos_session_id ON session_todos(session_id, sort_order, created_at);

    CREATE TABLE IF NOT EXISTS session_compaction_state (
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL DEFAULT 'default',
      latest_summary TEXT,
      compaction_count INTEGER NOT NULL DEFAULT 0,
      last_compacted_at TEXT,
      last_flush_at TEXT,
      last_flush_cycle INTEGER NOT NULL DEFAULT -1,
      last_tokens_before INTEGER,
      last_tokens_after INTEGER,
      recent_skills_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL,
      PRIMARY KEY (session_id, agent_id)
    );
    CREATE INDEX IF NOT EXISTS idx_session_compaction_state_updated_at ON session_compaction_state(updated_at DESC);

    CREATE TABLE IF NOT EXISTS acp_sessions (
      session_id TEXT PRIMARY KEY,
      session_label TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      actor TEXT,
      client TEXT,
      provenance_mode TEXT,
      last_trace_id TEXT,
      turn_count INTEGER NOT NULL DEFAULT 0,
      metadata TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_acp_sessions_label ON acp_sessions(session_label);
    CREATE INDEX IF NOT EXISTS idx_acp_sessions_last_used_at ON acp_sessions(last_used_at DESC);

    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      id,
      content,
      tags,
      type
    );

    CREATE TABLE IF NOT EXISTS memory_atomic_scope (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL DEFAULT 'default',
      updated_at TEXT NOT NULL,
      visibility_kind TEXT NOT NULL DEFAULT 'agent',
      visibility_id TEXT,
      source_execution_id TEXT,
      source_node_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_memory_atomic_scope_agent_id ON memory_atomic_scope(agent_id);
    -- The visibility index is created in the migration block below, after the
    -- ALTER TABLE that adds visibility_kind to pre-existing databases.

    -- Typed cross-surface memory candidates: an evidence-linked, reviewable
    -- proposal to write durable memory. Promotion uses the same
    -- applyMemoryOperations + buildWriteVisibility path as direct workflow
    -- memory. This is NOT the append-only audit log (memory_promotion_events).
    CREATE TABLE IF NOT EXISTS memory_candidates (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'pending',
      agent_id TEXT NOT NULL DEFAULT 'default',
      content TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'fact',
      tags TEXT NOT NULL DEFAULT '[]',
      confidence REAL NOT NULL DEFAULT 0.8,
      when_to_use TEXT,
      happened_at TEXT,
      scope_kind TEXT NOT NULL DEFAULT 'agent',
      scope_id TEXT,
      origin_type TEXT NOT NULL,
      origin_id TEXT,
      execution_id TEXT,
      node_id TEXT,
      session_id TEXT,
      document_id TEXT,
      evidence_json TEXT NOT NULL DEFAULT '[]',
      source_summary TEXT,
      candidate_hash TEXT NOT NULL UNIQUE,
      conflict_state TEXT NOT NULL DEFAULT 'none',
      related_ids_json TEXT NOT NULL DEFAULT '[]',
      applied_entry_id TEXT,
      review_after TEXT,
      expires_at TEXT,
      reviewed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_candidates_status
      ON memory_candidates(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_candidates_scope
      ON memory_candidates(agent_id, scope_kind, scope_id);
    CREATE INDEX IF NOT EXISTS idx_memory_candidates_origin
      ON memory_candidates(origin_type, origin_id);

    CREATE TABLE IF NOT EXISTS memory_identifier_index (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL DEFAULT 'default',
      subject_key TEXT NOT NULL,
      identifier TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      lane TEXT NOT NULL DEFAULT 'persistent_facts',
      session_id TEXT,
      source_path TEXT,
      memory_entry_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      is_current INTEGER NOT NULL DEFAULT 1,
      superseded_by TEXT,
      metadata_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_memory_identifier_subject_current
      ON memory_identifier_index(agent_id, subject_key, is_current, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_identifier_identifier
      ON memory_identifier_index(agent_id, identifier);
    CREATE INDEX IF NOT EXISTS idx_memory_identifier_entry
      ON memory_identifier_index(agent_id, memory_entry_id, source_path);

    CREATE TABLE IF NOT EXISTS memory_embeddings (
      id TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL,
      embedding TEXT NOT NULL,
      provider_id TEXT NOT NULL DEFAULT 'unknown',
      provider_key TEXT NOT NULL DEFAULT '',
      model_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session_chunks (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL DEFAULT 'default',
      chunk_text TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      message_count INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session_chunk_embeddings (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL DEFAULT 'default',
      embedding TEXT NOT NULL,
      provider_id TEXT NOT NULL DEFAULT 'unknown',
      provider_key TEXT NOT NULL DEFAULT '',
      model_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS memories_session_fts USING fts5(
      id,
      content
    );

    CREATE TABLE IF NOT EXISTS collection_files (
      id TEXT PRIMARY KEY,
      file_path TEXT NOT NULL UNIQUE,
      mtime INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS collection_chunks (
      id TEXT PRIMARY KEY,
      file_id TEXT NOT NULL,
      chunk_text TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS collection_chunk_embeddings (
      id TEXT PRIMARY KEY,
      embedding TEXT NOT NULL,
      provider_id TEXT NOT NULL DEFAULT 'unknown',
      provider_key TEXT NOT NULL DEFAULT '',
      model_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS memories_collection_fts USING fts5(
      id,
      content
    );

    CREATE TABLE IF NOT EXISTS memory_path_contexts (
      id TEXT PRIMARY KEY,
      path_prefix TEXT NOT NULL UNIQUE,
      context_text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS google_oauth (
      id TEXT PRIMARY KEY DEFAULT 'default',
      email TEXT,
      client_id TEXT NOT NULL,
      client_secret TEXT NOT NULL,
      access_token TEXT,
      refresh_token TEXT,
      expires_at INTEGER,
      scopes TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS app_secrets (
      name TEXT PRIMARY KEY,
      value_enc TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS provider_oauth_tokens (
      provider TEXT PRIMARY KEY,
      account_label TEXT,
      access_token_encrypted TEXT NOT NULL,
      refresh_token_encrypted TEXT,
      expires_at INTEGER,
      base_url TEXT,
      scopes TEXT NOT NULL DEFAULT '[]',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS boards (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS board_tasks (
      id TEXT PRIMARY KEY,
      board_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      workflow_template_key TEXT,
      workflow_id TEXT,
      source_type TEXT,
      source_ref TEXT,
      status TEXT NOT NULL DEFAULT 'inbox',
      priority TEXT NOT NULL DEFAULT 'medium',
      assigned_agent_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_board_tasks_board_id ON board_tasks(board_id);
    CREATE INDEX IF NOT EXISTS idx_board_tasks_status ON board_tasks(status);

    -- Cross-tab work trails. Created here (alongside the rest of the schema) so the
    -- lifecycle is explicit; src/lib/work-trails/work-trails.ts keeps a defensive
    -- ensureWorkTrailTables() for older DBs and direct-library callers.
    CREATE TABLE IF NOT EXISTS work_trails (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      client_turn_id TEXT,
      user_message TEXT NOT NULL,
      intent_json TEXT NOT NULL,
      plan_json TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS work_trail_events (
      id TEXT PRIMARY KEY,
      trail_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      surface TEXT,
      object_type TEXT,
      object_id TEXT,
      object_name TEXT,
      summary TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(trail_id) REFERENCES work_trails(id)
    );

    CREATE INDEX IF NOT EXISTS idx_work_trails_session ON work_trails(session_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_work_trail_events_trail ON work_trail_events(trail_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_work_trail_events_object ON work_trail_events(surface, object_type, object_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS tags (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      color TEXT NOT NULL DEFAULT '#64748b',
      scope TEXT NOT NULL DEFAULT 'general',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tag_links (
      id TEXT PRIMARY KEY,
      tag_id TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(tag_id, target_type, target_id)
    );

    CREATE INDEX IF NOT EXISTS idx_tag_links_target ON tag_links(target_type, target_id);
    CREATE INDEX IF NOT EXISTS idx_tag_links_tag ON tag_links(tag_id);

    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL,
      name TEXT NOT NULL,
      mime_type TEXT,
      source_url TEXT,
      file_path TEXT,
      size_bytes INTEGER,
      extracted_text TEXT NOT NULL,
      metadata TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_documents_created_at ON documents(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_documents_source_type ON documents(source_type);

    CREATE TABLE IF NOT EXISTS document_chunks (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      ord INTEGER NOT NULL,
      text TEXT NOT NULL,
      char_start INTEGER NOT NULL DEFAULT 0,
      char_end INTEGER NOT NULL DEFAULT 0,
      embedding_status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_document_chunks_document_ord ON document_chunks(document_id, ord);
    CREATE INDEX IF NOT EXISTS idx_document_chunks_status ON document_chunks(embedding_status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS document_chunk_embeddings (
      id TEXT PRIMARY KEY,
      embedding TEXT NOT NULL,
      provider_id TEXT NOT NULL DEFAULT 'unknown',
      provider_key TEXT NOT NULL DEFAULT '',
      model_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS document_chunks_fts USING fts5(
      id,
      document_id,
      content,
      tokenize = 'unicode61'
    );

    CREATE TABLE IF NOT EXISTS notebooks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      settings_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notebooks_updated_at ON notebooks(updated_at DESC);

    CREATE TABLE IF NOT EXISTS notebook_documents (
      notebook_id TEXT NOT NULL,
      document_id TEXT NOT NULL,
      context_mode TEXT NOT NULL DEFAULT 'summary',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (notebook_id, document_id)
    );
    CREATE INDEX IF NOT EXISTS idx_notebook_documents_document ON notebook_documents(document_id);

    CREATE TABLE IF NOT EXISTS notebook_notes (
      id TEXT PRIMARY KEY,
      notebook_id TEXT NOT NULL,
      title TEXT NOT NULL,
      content_md TEXT NOT NULL,
      origin TEXT NOT NULL DEFAULT 'user',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notebook_notes_notebook ON notebook_notes(notebook_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS notebook_transformations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      built_in INTEGER NOT NULL DEFAULT 0,
      apply_on_ingest INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS document_insights (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      notebook_id TEXT,
      transformation_id TEXT NOT NULL,
      content_md TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_document_insights_document ON document_insights(document_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_document_insights_notebook ON document_insights(notebook_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS notebook_outputs (
      id TEXT PRIMARY KEY,
      notebook_id TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notebook_outputs_notebook ON notebook_outputs(notebook_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS workflow_node_pin_data (
      workflow_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      data_json TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (workflow_id, node_id)
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_node_pin_data_workflow
      ON workflow_node_pin_data(workflow_id);

    CREATE TABLE IF NOT EXISTS workflow_agent_tools (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      tool_name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL,
      input_schema_json TEXT NOT NULL,
      output_schema_json TEXT,
      allowed_agent_ids_json TEXT,
      allowed_organization_ids_json TEXT,
      approval_policy TEXT NOT NULL DEFAULT 'inherit',
      enabled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS workflow_credentials (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      service_type TEXT NOT NULL,
      secret_ref TEXT NOT NULL,
      metadata_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Durable, hash-bound, one-time workflow node approval grants. Reused by the
    -- Approvals surface beside tool/MCP/task approvals. A grant authorizes the
    -- exact (workflow version, execution, node, attempt, effect, input) tuple it
    -- was created for; any mismatch invalidates it before execution.
    CREATE TABLE IF NOT EXISTS workflow_node_approvals (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      workflow_version_hash TEXT NOT NULL,
      execution_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 1,
      effect_kind TEXT NOT NULL,
      effect_risk TEXT NOT NULL,
      effect_json TEXT NOT NULL,
      target TEXT,
      input_hash TEXT NOT NULL,
      digest TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      requires_human INTEGER NOT NULL DEFAULT 1,
      requested_at TEXT NOT NULL,
      expires_at TEXT,
      decided_at TEXT,
      decided_by TEXT,
      decision_note TEXT,
      claimed_at TEXT,
      executed_at TEXT,
      result_ref TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_node_approvals_status
      ON workflow_node_approvals(status, requested_at DESC);
    CREATE INDEX IF NOT EXISTS idx_workflow_node_approvals_exec
      ON workflow_node_approvals(execution_id, node_id);
    CREATE INDEX IF NOT EXISTS idx_workflow_node_approvals_digest
      ON workflow_node_approvals(digest);

    CREATE TABLE IF NOT EXISTS workflow_versions (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      nodes_json TEXT NOT NULL,
      edges_json TEXT NOT NULL,
      metadata_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_versions_number
      ON workflow_versions(workflow_id, version);
    CREATE INDEX IF NOT EXISTS idx_workflow_versions_workflow
      ON workflow_versions(workflow_id);

    CREATE TABLE IF NOT EXISTS workflow_execution_node_traces (
      id TEXT PRIMARY KEY,
      execution_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      node_name TEXT,
      node_type TEXT NOT NULL,
      status TEXT NOT NULL,
      input_json TEXT,
      output_json TEXT,
      error_json TEXT,
      duration_ms INTEGER,
      cost_usd REAL DEFAULT 0,
      token_count INTEGER DEFAULT 0,
      started_at TEXT,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_node_traces_execution
      ON workflow_execution_node_traces(execution_id);
    CREATE INDEX IF NOT EXISTS idx_workflow_node_traces_workflow
      ON workflow_execution_node_traces(workflow_id, completed_at DESC);

    CREATE TABLE IF NOT EXISTS hierarchy_activity_events (
      id TEXT PRIMARY KEY,
      organization_id TEXT,
      goal_id TEXT,
      agent_id TEXT,
      actor_type TEXT NOT NULL DEFAULT 'system',
      event_type TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT,
      status TEXT,
      cost_usd REAL DEFAULT 0,
      token_count INTEGER DEFAULT 0,
      model_provider TEXT,
      model_id TEXT,
      artifact_refs_json TEXT NOT NULL DEFAULT '[]',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_hierarchy_activity_org_created
      ON hierarchy_activity_events(organization_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_hierarchy_activity_goal_created
      ON hierarchy_activity_events(goal_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_hierarchy_activity_agent_created
      ON hierarchy_activity_events(agent_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS hierarchy_budget_policies (
      id TEXT PRIMARY KEY,
      organization_id TEXT,
      goal_id TEXT,
      agent_id TEXT,
      scope TEXT NOT NULL,
      soft_limit_usd REAL,
      hard_limit_usd REAL,
      require_approval_above_usd REAL,
      period TEXT NOT NULL DEFAULT 'monthly',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_hierarchy_budget_policy_scope
      ON hierarchy_budget_policies(scope, organization_id, goal_id, agent_id);

    CREATE TABLE IF NOT EXISTS hierarchy_approval_policies (
      id TEXT PRIMARY KEY,
      organization_id TEXT,
      scope TEXT NOT NULL,
      action_pattern TEXT NOT NULL,
      approver_agent_id TEXT,
      require_human INTEGER NOT NULL DEFAULT 0,
      min_risk TEXT NOT NULL DEFAULT 'medium',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_hierarchy_approval_policy_org
      ON hierarchy_approval_policies(organization_id, scope);

    CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
      id,
      name,
      content,
      tokenize = 'unicode61'
    );

    CREATE TABLE IF NOT EXISTS design_projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      organization_id TEXT,
      goal_id TEXT,
      source_session_id TEXT,
      active_artifact_id TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_design_projects_updated
      ON design_projects(updated_at DESC);

    CREATE TABLE IF NOT EXISTS design_artifacts (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'html',
      entry_file TEXT NOT NULL DEFAULT 'index.html',
      status TEXT NOT NULL DEFAULT 'draft',
      current_version_id TEXT,
      source_session_id TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES design_projects(id)
    );
    CREATE INDEX IF NOT EXISTS idx_design_artifacts_project_updated
      ON design_artifacts(project_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS design_artifact_versions (
      id TEXT PRIMARY KEY,
      artifact_id TEXT NOT NULL,
      version_number INTEGER NOT NULL,
      file_path TEXT NOT NULL,
      content_sha256 TEXT NOT NULL,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      summary TEXT,
      created_by TEXT NOT NULL DEFAULT 'system',
      created_at TEXT NOT NULL,
      FOREIGN KEY(artifact_id) REFERENCES design_artifacts(id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_design_artifact_versions_artifact_number
      ON design_artifact_versions(artifact_id, version_number);

    CREATE TABLE IF NOT EXISTS design_patches (
      id TEXT PRIMARY KEY,
      artifact_id TEXT NOT NULL,
      version_before_id TEXT,
      version_after_id TEXT,
      patch_kind TEXT NOT NULL,
      label TEXT NOT NULL,
      patch_json TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      session_id TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(artifact_id) REFERENCES design_artifacts(id)
    );
    CREATE INDEX IF NOT EXISTS idx_design_patches_artifact_created
      ON design_patches(artifact_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS design_systems (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT,
      description TEXT,
      design_md TEXT NOT NULL,
      tokens_css TEXT,
      components_html TEXT,
      source_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_design_systems_category
      ON design_systems(category, name);

    CREATE TABLE IF NOT EXISTS design_validation_reports (
      id TEXT PRIMARY KEY,
      artifact_id TEXT NOT NULL,
      version_id TEXT NOT NULL,
      report_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(artifact_id) REFERENCES design_artifacts(id),
      FOREIGN KEY(version_id) REFERENCES design_artifact_versions(id)
    );
    CREATE INDEX IF NOT EXISTS idx_design_validation_reports_artifact_created
      ON design_validation_reports(artifact_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS design_assets (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      artifact_id TEXT,
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      path TEXT NOT NULL,
      width INTEGER,
      height INTEGER,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES design_projects(id),
      FOREIGN KEY(artifact_id) REFERENCES design_artifacts(id)
    );
    CREATE INDEX IF NOT EXISTS idx_design_assets_project_created
      ON design_assets(project_id, created_at DESC);
  `);

  // Agent execution config — added post-v4
  const appCols = database.prepare("PRAGMA table_info(app_config)").all() as { name: string }[];
  const appColNames = appCols.map(c => c.name);
  if (!appColNames.includes("tool_output_limit"))
    database.exec("ALTER TABLE app_config ADD COLUMN tool_output_limit INTEGER DEFAULT 8000");
  if (!appColNames.includes("learning_enabled"))
    database.exec("ALTER TABLE app_config ADD COLUMN learning_enabled INTEGER DEFAULT 1");
  if (!appColNames.includes("learning_mode"))
    database.exec("ALTER TABLE app_config ADD COLUMN learning_mode TEXT DEFAULT 'review'");
  if (!appColNames.includes("learning_capture_preferences"))
    database.exec("ALTER TABLE app_config ADD COLUMN learning_capture_preferences INTEGER DEFAULT 1");
  if (!appColNames.includes("learning_capture_playbooks"))
    database.exec("ALTER TABLE app_config ADD COLUMN learning_capture_playbooks INTEGER DEFAULT 1");
  if (!appColNames.includes("learning_auto_promote_threshold"))
    database.exec("ALTER TABLE app_config ADD COLUMN learning_auto_promote_threshold INTEGER DEFAULT 2");
  if (!appColNames.includes("learning_show_feedback"))
    database.exec("ALTER TABLE app_config ADD COLUMN learning_show_feedback INTEGER DEFAULT 1");
  if (!appColNames.includes("backup_enabled"))
    database.exec("ALTER TABLE app_config ADD COLUMN backup_enabled INTEGER DEFAULT 0");
  if (!appColNames.includes("backup_cron"))
    database.exec("ALTER TABLE app_config ADD COLUMN backup_cron TEXT DEFAULT '0 */6 * * *'");
  if (!appColNames.includes("backup_retention_count"))
    database.exec("ALTER TABLE app_config ADD COLUMN backup_retention_count INTEGER DEFAULT 14");
  if (!appColNames.includes("backup_include_logs"))
    database.exec("ALTER TABLE app_config ADD COLUMN backup_include_logs INTEGER DEFAULT 0");
  if (!appColNames.includes("backup_replication_mode"))
    database.exec("ALTER TABLE app_config ADD COLUMN backup_replication_mode TEXT DEFAULT 'off'");
  if (!appColNames.includes("backup_replication_target"))
    database.exec("ALTER TABLE app_config ADD COLUMN backup_replication_target TEXT");
  if (!appColNames.includes("backup_replication_rsync_args"))
    database.exec("ALTER TABLE app_config ADD COLUMN backup_replication_rsync_args TEXT");
  if (!appColNames.includes("backup_last_run_at"))
    database.exec("ALTER TABLE app_config ADD COLUMN backup_last_run_at TEXT");
  if (!appColNames.includes("backup_last_success_at"))
    database.exec("ALTER TABLE app_config ADD COLUMN backup_last_success_at TEXT");
  if (!appColNames.includes("backup_last_error"))
    database.exec("ALTER TABLE app_config ADD COLUMN backup_last_error TEXT");
  if (!appColNames.includes("backup_last_backup_id"))
    database.exec("ALTER TABLE app_config ADD COLUMN backup_last_backup_id TEXT");
  if (!appColNames.includes("compaction_mode"))
    database.exec("ALTER TABLE app_config ADD COLUMN compaction_mode TEXT DEFAULT 'off'");
  if (!appColNames.includes("compaction_threshold"))
    database.exec("ALTER TABLE app_config ADD COLUMN compaction_threshold REAL DEFAULT 0.75");
  if (!appColNames.includes("context_window"))
    database.exec("ALTER TABLE app_config ADD COLUMN context_window INTEGER DEFAULT 200000");
  if (!appColNames.includes("pending_mutation_ttl_ms"))
    database.exec("ALTER TABLE app_config ADD COLUMN pending_mutation_ttl_ms INTEGER DEFAULT 900000");

  const workflowCols = database.prepare("PRAGMA table_info(workflows)").all() as { name: string }[];
  const workflowColNames = new Set(workflowCols.map((column) => column.name));
  if (!workflowColNames.has("source_type")) {
    database.exec("ALTER TABLE workflows ADD COLUMN source_type TEXT");
  }
  if (!workflowColNames.has("source_ref")) {
    database.exec("ALTER TABLE workflows ADD COLUMN source_ref TEXT");
  }
  if (!workflowColNames.has("organization_id")) {
    database.exec("ALTER TABLE workflows ADD COLUMN organization_id TEXT");
  }
  if (!workflowColNames.has("goal_id")) {
    database.exec("ALTER TABLE workflows ADD COLUMN goal_id TEXT");
  }
  if (!workflowColNames.has("concurrency")) {
    // JSON: { "mode": "skip" | "queue", "maxConcurrent": number }. NULL = skip-if-running.
    database.exec("ALTER TABLE workflows ADD COLUMN concurrency TEXT");
  }
  if (!workflowColNames.has("policy")) {
    database.exec("ALTER TABLE workflows ADD COLUMN policy TEXT");
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS workflow_execution_queue (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      trigger_type TEXT NOT NULL,
      trigger_data TEXT,
      provenance TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      execution_id TEXT,
      enqueued_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_execution_queue_workflow_status
      ON workflow_execution_queue(workflow_id, status, enqueued_at);

    CREATE TABLE IF NOT EXISTS workflow_policy_usage (
      workflow_id TEXT NOT NULL,
      day_key TEXT NOT NULL,
      run_count INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      notification_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (workflow_id, day_key)
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_policy_usage_day
      ON workflow_policy_usage(day_key, workflow_id);
  `);

  const boardTaskCols = database.prepare("PRAGMA table_info(board_tasks)").all() as { name: string }[];
  const boardTaskColNames = new Set(boardTaskCols.map((column) => column.name));
  if (!boardTaskColNames.has("workflow_template_key")) {
    database.exec("ALTER TABLE board_tasks ADD COLUMN workflow_template_key TEXT");
  }
  if (!boardTaskColNames.has("workflow_id")) {
    database.exec("ALTER TABLE board_tasks ADD COLUMN workflow_id TEXT");
  }
  if (!boardTaskColNames.has("source_type")) {
    database.exec("ALTER TABLE board_tasks ADD COLUMN source_type TEXT");
  }
  if (!boardTaskColNames.has("source_ref")) {
    database.exec("ALTER TABLE board_tasks ADD COLUMN source_ref TEXT");
  }
  if (!boardTaskColNames.has("organization_id")) {
    database.exec("ALTER TABLE board_tasks ADD COLUMN organization_id TEXT");
  }
  if (!boardTaskColNames.has("goal_id")) {
    database.exec("ALTER TABLE board_tasks ADD COLUMN goal_id TEXT");
  }
  if (!boardTaskColNames.has("checked_out_by_agent_id")) {
    database.exec("ALTER TABLE board_tasks ADD COLUMN checked_out_by_agent_id TEXT");
  }
  if (!boardTaskColNames.has("checked_out_at")) {
    database.exec("ALTER TABLE board_tasks ADD COLUMN checked_out_at TEXT");
  }
  if (!appColNames.includes("channel_retry_attempts"))
    database.exec("ALTER TABLE app_config ADD COLUMN channel_retry_attempts INTEGER DEFAULT 3");
  if (!appColNames.includes("channel_retry_min_delay_ms"))
    database.exec("ALTER TABLE app_config ADD COLUMN channel_retry_min_delay_ms INTEGER DEFAULT 400");
  if (!appColNames.includes("channel_retry_max_delay_ms"))
    database.exec("ALTER TABLE app_config ADD COLUMN channel_retry_max_delay_ms INTEGER DEFAULT 30000");
  if (!appColNames.includes("channel_retry_jitter"))
    database.exec("ALTER TABLE app_config ADD COLUMN channel_retry_jitter REAL DEFAULT 0.1");
  if (!appColNames.includes("telemetry_enabled"))
    database.exec("ALTER TABLE app_config ADD COLUMN telemetry_enabled INTEGER DEFAULT 1");
  if (!appColNames.includes("hooks_enabled"))
    database.exec("ALTER TABLE app_config ADD COLUMN hooks_enabled INTEGER DEFAULT 1");
  if (!appColNames.includes("memory_flush_enabled"))
    database.exec("ALTER TABLE app_config ADD COLUMN memory_flush_enabled INTEGER DEFAULT 1");
  if (!appColNames.includes("memory_flush_soft_threshold_tokens"))
    database.exec("ALTER TABLE app_config ADD COLUMN memory_flush_soft_threshold_tokens INTEGER DEFAULT 4000");
  if (!appColNames.includes("compaction_keep_recent_tokens"))
    database.exec("ALTER TABLE app_config ADD COLUMN compaction_keep_recent_tokens INTEGER DEFAULT 20000");
  if (!appColNames.includes("compaction_reserve_tokens_floor"))
    database.exec("ALTER TABLE app_config ADD COLUMN compaction_reserve_tokens_floor INTEGER DEFAULT 20000");
  if (!appColNames.includes("compaction_model_ref"))
    database.exec("ALTER TABLE app_config ADD COLUMN compaction_model_ref TEXT");
  if (!appColNames.includes("compaction_identifier_policy"))
    database.exec("ALTER TABLE app_config ADD COLUMN compaction_identifier_policy TEXT DEFAULT 'strict'");
  if (!appColNames.includes("compaction_identifier_instructions"))
    database.exec("ALTER TABLE app_config ADD COLUMN compaction_identifier_instructions TEXT");
  if (!appColNames.includes("compaction_quality_guard_enabled"))
    database.exec("ALTER TABLE app_config ADD COLUMN compaction_quality_guard_enabled INTEGER DEFAULT 0");
  if (!appColNames.includes("compaction_quality_guard_max_retries"))
    database.exec("ALTER TABLE app_config ADD COLUMN compaction_quality_guard_max_retries INTEGER DEFAULT 1");
  if (!appColNames.includes("context_pruning_mode"))
    database.exec("ALTER TABLE app_config ADD COLUMN context_pruning_mode TEXT DEFAULT 'tool-results'");
  if (!appColNames.includes("context_pruning_keep_recent_assistants"))
    database.exec("ALTER TABLE app_config ADD COLUMN context_pruning_keep_recent_assistants INTEGER DEFAULT 3");
  if (!appColNames.includes("context_pruning_min_tool_chars"))
    database.exec("ALTER TABLE app_config ADD COLUMN context_pruning_min_tool_chars INTEGER DEFAULT 12000");
  if (!appColNames.includes("context_pruning_max_tool_chars"))
    database.exec("ALTER TABLE app_config ADD COLUMN context_pruning_max_tool_chars INTEGER DEFAULT 4000");
  if (!appColNames.includes("context_pruning_head_chars"))
    database.exec("ALTER TABLE app_config ADD COLUMN context_pruning_head_chars INTEGER DEFAULT 1500");
  if (!appColNames.includes("context_pruning_tail_chars"))
    database.exec("ALTER TABLE app_config ADD COLUMN context_pruning_tail_chars INTEGER DEFAULT 1500");
  if (!appColNames.includes("async_delegation_max_concurrent"))
    database.exec("ALTER TABLE app_config ADD COLUMN async_delegation_max_concurrent INTEGER DEFAULT 3");
  if (!appColNames.includes("rate_limit_webhooks"))
    database.exec("ALTER TABLE app_config ADD COLUMN rate_limit_webhooks INTEGER DEFAULT 30");
  if (!appColNames.includes("rate_limit_execute"))
    database.exec("ALTER TABLE app_config ADD COLUMN rate_limit_execute INTEGER DEFAULT 20");
  if (!appColNames.includes("rate_limit_channels"))
    database.exec("ALTER TABLE app_config ADD COLUMN rate_limit_channels INTEGER DEFAULT 60");
  if (!appColNames.includes("log_max_days"))
    database.exec("ALTER TABLE app_config ADD COLUMN log_max_days INTEGER DEFAULT 7");
  if (!appColNames.includes("lane_main_max_concurrent"))
    database.exec("ALTER TABLE app_config ADD COLUMN lane_main_max_concurrent INTEGER DEFAULT 4");
  if (!appColNames.includes("lane_cron_max_concurrent"))
    database.exec("ALTER TABLE app_config ADD COLUMN lane_cron_max_concurrent INTEGER DEFAULT 1");
  if (!appColNames.includes("lane_subflow_max_concurrent"))
    database.exec("ALTER TABLE app_config ADD COLUMN lane_subflow_max_concurrent INTEGER DEFAULT 8");
  if (!appColNames.includes("provenance_mode"))
    database.exec("ALTER TABLE app_config ADD COLUMN provenance_mode TEXT DEFAULT 'meta'");
  if (!appColNames.includes("acp_auth_mode"))
    database.exec("ALTER TABLE app_config ADD COLUMN acp_auth_mode TEXT DEFAULT 'off'");
  if (!appColNames.includes("acp_auth_secret_name"))
    database.exec("ALTER TABLE app_config ADD COLUMN acp_auth_secret_name TEXT");
  if (!appColNames.includes("install_posture"))
    database.exec("ALTER TABLE app_config ADD COLUMN install_posture TEXT DEFAULT 'local_only'");
  if (!appColNames.includes("disable_loopback_bypass"))
    database.exec("ALTER TABLE app_config ADD COLUMN disable_loopback_bypass INTEGER DEFAULT 0");
  if (!appColNames.includes("operator_auth_backoff_enabled"))
    database.exec("ALTER TABLE app_config ADD COLUMN operator_auth_backoff_enabled INTEGER DEFAULT 1");
  if (!appColNames.includes("mcp_security_posture"))
    database.exec("ALTER TABLE app_config ADD COLUMN mcp_security_posture TEXT DEFAULT 'guarded'");
  if (!appColNames.includes("channel_access_mode"))
    database.exec("ALTER TABLE app_config ADD COLUMN channel_access_mode TEXT DEFAULT 'open'");
  if (!appColNames.includes("website_policy_mode"))
    database.exec("ALTER TABLE app_config ADD COLUMN website_policy_mode TEXT DEFAULT 'off'");
  if (!appColNames.includes("website_policy_domains"))
    database.exec("ALTER TABLE app_config ADD COLUMN website_policy_domains TEXT DEFAULT ''");
  if (!appColNames.includes("smart_model_routing_enabled"))
    database.exec("ALTER TABLE app_config ADD COLUMN smart_model_routing_enabled INTEGER DEFAULT 0");
  if (!appColNames.includes("smart_model_routing_max_chars"))
    database.exec("ALTER TABLE app_config ADD COLUMN smart_model_routing_max_chars INTEGER DEFAULT 160");
  if (!appColNames.includes("smart_model_routing_max_words"))
    database.exec("ALTER TABLE app_config ADD COLUMN smart_model_routing_max_words INTEGER DEFAULT 28");
  if (!appColNames.includes("anthropic_prompt_caching_enabled"))
    database.exec("ALTER TABLE app_config ADD COLUMN anthropic_prompt_caching_enabled INTEGER DEFAULT 1");
  if (!appColNames.includes("web_search_provider"))
    database.exec("ALTER TABLE app_config ADD COLUMN web_search_provider TEXT DEFAULT 'duckduckgo'");
  if (!appColNames.includes("web_search_api_key"))
    database.exec("ALTER TABLE app_config ADD COLUMN web_search_api_key TEXT DEFAULT NULL");
  if (!appColNames.includes("browser_backend"))
    database.exec("ALTER TABLE app_config ADD COLUMN browser_backend TEXT DEFAULT 'playwright'");
  if (!appColNames.includes("browser_cdp_url"))
    database.exec("ALTER TABLE app_config ADD COLUMN browser_cdp_url TEXT DEFAULT NULL");
  if (!appColNames.includes("checkpoint_enabled"))
    database.exec("ALTER TABLE app_config ADD COLUMN checkpoint_enabled INTEGER DEFAULT 1");
  if (!appColNames.includes("image_generation_api_key"))
    database.exec("ALTER TABLE app_config ADD COLUMN image_generation_api_key TEXT DEFAULT NULL");
  if (!appColNames.includes("mcp_servers"))
    database.exec("ALTER TABLE app_config ADD COLUMN mcp_servers TEXT DEFAULT '[]'");
  if (!appColNames.includes("learning_llm_review_enabled"))
    database.exec("ALTER TABLE app_config ADD COLUMN learning_llm_review_enabled INTEGER DEFAULT 1");
  if (!appColNames.includes("learning_llm_review_interval"))
    database.exec("ALTER TABLE app_config ADD COLUMN learning_llm_review_interval INTEGER DEFAULT 10");
  if (!appColNames.includes("voice_stt_provider"))
    database.exec("ALTER TABLE app_config ADD COLUMN voice_stt_provider TEXT DEFAULT 'openai-whisper'");
  if (!appColNames.includes("voice_stt_api_key"))
    database.exec("ALTER TABLE app_config ADD COLUMN voice_stt_api_key TEXT DEFAULT NULL");
  if (!appColNames.includes("voice_tts_provider"))
    database.exec("ALTER TABLE app_config ADD COLUMN voice_tts_provider TEXT DEFAULT 'openai'");
  if (!appColNames.includes("voice_tts_api_key"))
    database.exec("ALTER TABLE app_config ADD COLUMN voice_tts_api_key TEXT DEFAULT NULL");
  if (!appColNames.includes("voice_tts_voice_model"))
    database.exec("ALTER TABLE app_config ADD COLUMN voice_tts_voice_model TEXT DEFAULT NULL");

  const modelCols = (database.prepare("PRAGMA table_info(models)").all() as Array<{ name: string }>).map((r) => r.name);
  if (!modelCols.includes("base_url"))
    database.exec("ALTER TABLE models ADD COLUMN base_url TEXT");
  if (!modelCols.includes("fast_mode"))
    database.exec("ALTER TABLE models ADD COLUMN fast_mode INTEGER DEFAULT 0");

  const candidateColNames = (database.prepare("PRAGMA table_info(learning_candidates)").all() as Array<{ name: string }>).map((r) => r.name);
  if (!candidateColNames.includes("last_synthesized_evidence_count"))
    database.exec("ALTER TABLE learning_candidates ADD COLUMN last_synthesized_evidence_count INTEGER");

  // memory_config: temporal decay + unified provider settings
  const memCols = database.prepare("PRAGMA table_info(memory_config)").all() as { name: string }[];
  const memColNames = memCols.map(c => c.name);
  if (!memColNames.includes("decay_enabled"))
    database.exec("ALTER TABLE memory_config ADD COLUMN decay_enabled INTEGER DEFAULT 1");
  if (!memColNames.includes("decay_half_life_days"))
    database.exec("ALTER TABLE memory_config ADD COLUMN decay_half_life_days INTEGER DEFAULT 30");
  if (!memColNames.includes("embedding_model"))
    database.exec("ALTER TABLE memory_config ADD COLUMN embedding_model TEXT DEFAULT 'local'");
  if (!memColNames.includes("vector_weight"))
    database.exec("ALTER TABLE memory_config ADD COLUMN vector_weight REAL DEFAULT 0.7");
  if (!memColNames.includes("text_weight"))
    database.exec("ALTER TABLE memory_config ADD COLUMN text_weight REAL DEFAULT 0.3");
  if (!memColNames.includes("index_sessions"))
    database.exec("ALTER TABLE memory_config ADD COLUMN index_sessions INTEGER DEFAULT 1");
  if (!memColNames.includes("session_chunk_tokens"))
    database.exec("ALTER TABLE memory_config ADD COLUMN session_chunk_tokens INTEGER DEFAULT 400");
  if (!memColNames.includes("session_chunk_overlap"))
    database.exec("ALTER TABLE memory_config ADD COLUMN session_chunk_overlap INTEGER DEFAULT 80");
  if (!memColNames.includes("startup_include_files"))
    database.exec("ALTER TABLE memory_config ADD COLUMN startup_include_files TEXT DEFAULT NULL");
  if (!memColNames.includes("startup_exclude_files"))
    database.exec("ALTER TABLE memory_config ADD COLUMN startup_exclude_files TEXT DEFAULT NULL");
  if (!memColNames.includes("max_snippet_chars"))
    database.exec("ALTER TABLE memory_config ADD COLUMN max_snippet_chars INTEGER DEFAULT 700");
  if (!memColNames.includes("max_injected_chars"))
    database.exec("ALTER TABLE memory_config ADD COLUMN max_injected_chars INTEGER DEFAULT 4000");
  if (!memColNames.includes("citations_mode"))
    database.exec("ALTER TABLE memory_config ADD COLUMN citations_mode TEXT DEFAULT 'on'");
  if (!memColNames.includes("extra_collection_paths"))
    database.exec("ALTER TABLE memory_config ADD COLUMN extra_collection_paths TEXT DEFAULT NULL");
  if (!memColNames.includes("search_backend"))
    database.exec("ALTER TABLE memory_config ADD COLUMN search_backend TEXT DEFAULT 'qmd-like'");
  if (!memColNames.includes("rerank_strategy"))
    database.exec("ALTER TABLE memory_config ADD COLUMN rerank_strategy TEXT DEFAULT 'auto'");
  if (!memColNames.includes("query_expansion_enabled"))
    database.exec("ALTER TABLE memory_config ADD COLUMN query_expansion_enabled INTEGER DEFAULT 1");
  if (!memColNames.includes("strong_signal_enabled"))
    database.exec("ALTER TABLE memory_config ADD COLUMN strong_signal_enabled INTEGER DEFAULT 1");
  if (!memColNames.includes("rerank_candidate_limit"))
    database.exec("ALTER TABLE memory_config ADD COLUMN rerank_candidate_limit INTEGER DEFAULT 40");

  // Seed app_config if empty
  const appConfigRow = database.prepare("SELECT id FROM app_config WHERE id = 'default'").get();
  if (!appConfigRow) {
    const now = new Date().toISOString();
    database.prepare(
      "INSERT INTO app_config (id, onboarding_done, timezone, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
    ).run("default", 0, "UTC", now, now);
  }

  // Seed memory_config if empty
  const memConfigRow = database.prepare("SELECT id FROM memory_config WHERE id = 'default'").get();
  if (!memConfigRow) {
    const now = new Date().toISOString();
    database.prepare(
      "INSERT INTO memory_config (id, tier, auto_threshold, total_memories, storage_bytes, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("default", "auto", 50, 0, 0, now);
  }

  // Seed a default board if none exists so Boards page is immediately usable.
  const boardCount = database.prepare("SELECT COUNT(*) AS count FROM boards").get() as { count?: number } | undefined;
  if (Number(boardCount?.count || 0) === 0) {
    const now = new Date().toISOString();
    database.prepare(
      "INSERT INTO boards (id, name, description, is_active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)"
    ).run("main-board", "Main Board", "Default execution board", now, now);
  }

  // Session delta indexing state — tracks how many messages have been indexed per agent/session.
  database.exec(`
    CREATE TABLE IF NOT EXISTS session_index_state_v2 (
      agent_id TEXT NOT NULL DEFAULT 'default',
      session_id TEXT NOT NULL,
      last_msg_count INTEGER DEFAULT 0,
      last_indexed_at TEXT NOT NULL,
      PRIMARY KEY (agent_id, session_id)
    );
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS learning_events (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      scope TEXT NOT NULL,
      scope_id TEXT,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_learning_events_fingerprint ON learning_events(fingerprint, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_learning_events_created_at ON learning_events(created_at DESC);

    CREATE TABLE IF NOT EXISTS learning_candidates (
      id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'proposed',
      kind TEXT NOT NULL,
      scope TEXT NOT NULL,
      scope_id TEXT,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      content TEXT,
      confidence REAL DEFAULT 0,
      evidence_count INTEGER DEFAULT 1,
      source_event_ids TEXT NOT NULL DEFAULT '[]',
      target_path TEXT,
      promoted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_learning_candidates_status ON learning_candidates(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_learning_candidates_updated_at ON learning_candidates(updated_at DESC);

    CREATE TABLE IF NOT EXISTS standing_goal_runs (
      id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL,
      task_id TEXT,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL,
      turn_index INTEGER NOT NULL DEFAULT 0,
      max_turns INTEGER NOT NULL DEFAULT 20,
      worker_id TEXT,
      model_provider TEXT,
      model_id TEXT,
      started_at TEXT,
      completed_at TEXT,
      last_judged_at TEXT,
      last_verdict TEXT,
      last_reason TEXT,
      consecutive_parse_failures INTEGER NOT NULL DEFAULT 0,
      consecutive_same_blockers INTEGER NOT NULL DEFAULT 0,
      tools_used_json TEXT NOT NULL DEFAULT '[]',
      deliverables_json TEXT NOT NULL DEFAULT '[]',
      evidence_summary TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_standing_goal_runs_goal_updated
      ON standing_goal_runs(goal_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_standing_goal_runs_status_updated
      ON standing_goal_runs(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_standing_goal_runs_task_updated
      ON standing_goal_runs(task_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS standing_goal_judgments (
      id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL,
      task_id TEXT,
      run_id TEXT NOT NULL,
      verdict TEXT NOT NULL,
      reason TEXT NOT NULL,
      missing_criteria_json TEXT NOT NULL DEFAULT '[]',
      satisfied_criteria_json TEXT NOT NULL DEFAULT '[]',
      raw_response TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_standing_goal_judgments_goal_created
      ON standing_goal_judgments(goal_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_standing_goal_judgments_run_created
      ON standing_goal_judgments(run_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS skill_usage_events (
      id TEXT PRIMARY KEY,
      skill_id TEXT NOT NULL,
      skill_name TEXT NOT NULL,
      skill_source TEXT NOT NULL,
      event_kind TEXT NOT NULL,
      session_id TEXT,
      agent_id TEXT,
      trigger_text TEXT,
      outcome TEXT,
      evidence_json TEXT NOT NULL DEFAULT '[]',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_skill_usage_skill_created
      ON skill_usage_events(skill_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_skill_usage_session_created
      ON skill_usage_events(session_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_skill_usage_kind_created
      ON skill_usage_events(event_kind, created_at DESC);

    CREATE TABLE IF NOT EXISTS skill_compounding_evaluations (
      id TEXT PRIMARY KEY,
      skill_id TEXT NOT NULL,
      skill_name TEXT NOT NULL,
      status TEXT NOT NULL,
      usage_count INTEGER NOT NULL DEFAULT 0,
      success_count INTEGER NOT NULL DEFAULT 0,
      stale_score INTEGER NOT NULL DEFAULT 0,
      recommendation TEXT NOT NULL,
      rationale TEXT NOT NULL,
      evidence_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_skill_compounding_skill_created
      ON skill_compounding_evaluations(skill_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_skill_compounding_status_created
      ON skill_compounding_evaluations(status, created_at DESC);
  `);

  execIgnoringDuplicateColumn(database, "ALTER TABLE channel_session_settings ADD COLUMN agent_id TEXT");
  execIgnoringDuplicateColumn(database, "ALTER TABLE channel_session_settings ADD COLUMN model_ref TEXT");
  execIgnoringDuplicateColumn(database, "ALTER TABLE channel_session_settings ADD COLUMN workspace_path TEXT");
  execIgnoringDuplicateColumn(database, "ALTER TABLE channel_session_settings ADD COLUMN tool_mode TEXT DEFAULT 'default'");
  execIgnoringDuplicateColumn(database, "ALTER TABLE channel_session_turns ADD COLUMN request_payload TEXT");
  execIgnoringDuplicateColumn(database, "ALTER TABLE channel_session_turns ADD COLUMN stream_content TEXT");
  execIgnoringDuplicateColumn(database, "ALTER TABLE channel_session_turns ADD COLUMN worker_id TEXT");
  execIgnoringDuplicateColumn(database, "ALTER TABLE channel_session_turns ADD COLUMN lease_expires_at TEXT");
  execIgnoringDuplicateColumn(database, "ALTER TABLE channel_session_turns ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0");
  execIgnoringDuplicateColumn(database, "ALTER TABLE workflows ADD COLUMN schedule_profile TEXT");

  database.exec(`
    CREATE TABLE IF NOT EXISTS channel_session_startup_snapshots (
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL DEFAULT 'default',
      workspace_path TEXT NOT NULL,
      startup_context TEXT NOT NULL,
      source_files_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (session_id, agent_id)
    );
    CREATE INDEX IF NOT EXISTS idx_channel_session_startup_snapshots_updated_at
      ON channel_session_startup_snapshots(updated_at DESC);
  `);

  // Per-agent memory isolation: add agent_id to memory_embeddings table.
  // (The memories table does not exist in SQLite — memory entries live in data/memories/*.md files.)
  const memEmbedCols = database.prepare("PRAGMA table_info(memory_embeddings)").all() as { name: string }[];
  const memEmbedColNames = memEmbedCols.map(c => c.name);
  if (!memEmbedColNames.includes("agent_id"))
    execIgnoringDuplicateColumn(database, "ALTER TABLE memory_embeddings ADD COLUMN agent_id TEXT DEFAULT 'default'");
  if (!memEmbedColNames.includes("provider_id"))
    execIgnoringDuplicateColumn(database, "ALTER TABLE memory_embeddings ADD COLUMN provider_id TEXT DEFAULT 'unknown'");
  if (!memEmbedColNames.includes("provider_key"))
    execIgnoringDuplicateColumn(database, "ALTER TABLE memory_embeddings ADD COLUMN provider_key TEXT DEFAULT ''");

  // Workflow memory visibility columns (added with the workflow approval + memory scope work).
  // Existing rows default to agent-wide visibility so behaviour does not silently change.
  const memScopeCols = (database.prepare("PRAGMA table_info(memory_atomic_scope)").all() as { name: string }[]).map((c) => c.name);
  if (!memScopeCols.includes("visibility_kind"))
    execIgnoringDuplicateColumn(database, "ALTER TABLE memory_atomic_scope ADD COLUMN visibility_kind TEXT NOT NULL DEFAULT 'agent'");
  if (!memScopeCols.includes("visibility_id"))
    execIgnoringDuplicateColumn(database, "ALTER TABLE memory_atomic_scope ADD COLUMN visibility_id TEXT");
  if (!memScopeCols.includes("source_execution_id"))
    execIgnoringDuplicateColumn(database, "ALTER TABLE memory_atomic_scope ADD COLUMN source_execution_id TEXT");
  if (!memScopeCols.includes("source_node_id"))
    execIgnoringDuplicateColumn(database, "ALTER TABLE memory_atomic_scope ADD COLUMN source_node_id TEXT");
  try {
    database.exec("CREATE INDEX IF NOT EXISTS idx_memory_atomic_scope_visibility ON memory_atomic_scope(agent_id, visibility_kind, visibility_id)");
  } catch { /* index may already exist */ }

  const messageCols = database.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
  const messageColNames = messageCols.map((c) => c.name);

  const extensionInstallCols = database.prepare("PRAGMA table_info(extension_installs)").all() as { name: string }[];
  const extensionInstallColNames = extensionInstallCols.map((c) => c.name);
  if (!extensionInstallColNames.includes("scan_status"))
    database.exec("ALTER TABLE extension_installs ADD COLUMN scan_status TEXT DEFAULT 'pass'");
  if (!extensionInstallColNames.includes("scan_summary"))
    database.exec("ALTER TABLE extension_installs ADD COLUMN scan_summary TEXT");
  if (!extensionInstallColNames.includes("scan_findings"))
    database.exec("ALTER TABLE extension_installs ADD COLUMN scan_findings TEXT");
  if (!extensionInstallColNames.includes("scanned_at"))
    database.exec("ALTER TABLE extension_installs ADD COLUMN scanned_at TEXT");
  if (!messageColNames.includes("agent_id"))
    database.exec("ALTER TABLE messages ADD COLUMN agent_id TEXT DEFAULT 'default'");
  if (!messageColNames.includes("provenance"))
    database.exec("ALTER TABLE messages ADD COLUMN provenance TEXT");

  const executionCols = database.prepare("PRAGMA table_info(executions)").all() as { name: string }[];
  const executionColNames = executionCols.map((c) => c.name);
  if (!executionColNames.includes("provenance"))
    database.exec("ALTER TABLE executions ADD COLUMN provenance TEXT");

  const sessionChunkCols = database.prepare("PRAGMA table_info(session_chunks)").all() as { name: string }[];
  const sessionChunkColNames = sessionChunkCols.map((c) => c.name);
  if (!sessionChunkColNames.includes("agent_id"))
    database.exec("ALTER TABLE session_chunks ADD COLUMN agent_id TEXT DEFAULT 'default'");

  const sessionChunkEmbeddingCols = database.prepare("PRAGMA table_info(session_chunk_embeddings)").all() as { name: string }[];
  const sessionChunkEmbeddingColNames = sessionChunkEmbeddingCols.map((c) => c.name);
  if (!sessionChunkEmbeddingColNames.includes("agent_id"))
    execIgnoringDuplicateColumn(database, "ALTER TABLE session_chunk_embeddings ADD COLUMN agent_id TEXT DEFAULT 'default'");
  if (!sessionChunkEmbeddingColNames.includes("provider_id"))
    execIgnoringDuplicateColumn(database, "ALTER TABLE session_chunk_embeddings ADD COLUMN provider_id TEXT DEFAULT 'unknown'");
  if (!sessionChunkEmbeddingColNames.includes("provider_key"))
    execIgnoringDuplicateColumn(database, "ALTER TABLE session_chunk_embeddings ADD COLUMN provider_key TEXT DEFAULT ''");

  const collectionChunkEmbeddingCols = database.prepare("PRAGMA table_info(collection_chunk_embeddings)").all() as { name: string }[];
  const collectionChunkEmbeddingColNames = collectionChunkEmbeddingCols.map((c) => c.name);
  if (!collectionChunkEmbeddingColNames.includes("provider_id"))
    execIgnoringDuplicateColumn(database, "ALTER TABLE collection_chunk_embeddings ADD COLUMN provider_id TEXT DEFAULT 'unknown'");
  if (!collectionChunkEmbeddingColNames.includes("provider_key"))
    execIgnoringDuplicateColumn(database, "ALTER TABLE collection_chunk_embeddings ADD COLUMN provider_key TEXT DEFAULT ''");

  database.exec("CREATE INDEX IF NOT EXISTS idx_memory_embeddings_agent_model ON memory_embeddings(agent_id, provider_id, model_id)");
  database.exec("CREATE INDEX IF NOT EXISTS idx_session_chunk_embeddings_agent_model ON session_chunk_embeddings(agent_id, provider_id, model_id)");
  const sessionCompactionCols = database.prepare("PRAGMA table_info(session_compaction_state)").all() as { name: string }[];
  const sessionCompactionColNames = sessionCompactionCols.map((c) => c.name);
  if (!sessionCompactionColNames.includes("recent_skills_json"))
    database.exec("ALTER TABLE session_compaction_state ADD COLUMN recent_skills_json TEXT NOT NULL DEFAULT '[]'");
  database.exec("CREATE INDEX IF NOT EXISTS idx_session_compaction_state_updated_at ON session_compaction_state(updated_at DESC)");

  // session_todos: upgrade from is_done boolean to status text
  const sessionTodoCols = database.prepare("PRAGMA table_info(session_todos)").all() as { name: string }[];
  const sessionTodoColNames = sessionTodoCols.map((c) => c.name);
  if (!sessionTodoColNames.includes("status"))
    database.exec("ALTER TABLE session_todos ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'");

  try {
    database.exec("CREATE INDEX IF NOT EXISTS idx_collection_chunk_embeddings_model ON collection_chunk_embeddings(provider_id, model_id)");
  } catch (error) {
    if (!isMalformedSqliteError(error)) throw error;
    if (repairCollectionChunkEmbeddingTable(database)) {
      database.exec("CREATE INDEX IF NOT EXISTS idx_collection_chunk_embeddings_model ON collection_chunk_embeddings(provider_id, model_id)");
    }
  }

  // --- Governance: board_tasks new columns ---
  if (!boardTaskColNames.has("execution_locked_at")) {
    database.exec("ALTER TABLE board_tasks ADD COLUMN execution_locked_at TEXT");
  }
  if (!boardTaskColNames.has("execution_run_id")) {
    database.exec("ALTER TABLE board_tasks ADD COLUMN execution_run_id TEXT");
  }
  if (!boardTaskColNames.has("request_depth")) {
    database.exec("ALTER TABLE board_tasks ADD COLUMN request_depth INTEGER DEFAULT 0");
  }
  if (!boardTaskColNames.has("requester_agent_id")) {
    database.exec("ALTER TABLE board_tasks ADD COLUMN requester_agent_id TEXT");
  }

  // --- Governance: task_labels ---
  database.exec(`
    CREATE TABLE IF NOT EXISTS task_labels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      color TEXT DEFAULT '#ff0000',
      scope TEXT DEFAULT 'global',
      created_at TEXT NOT NULL
    );
  `);

  // --- Governance: task_label_assignments ---
  database.exec(`
    CREATE TABLE IF NOT EXISTS task_label_assignments (
      task_id TEXT NOT NULL,
      label_id TEXT NOT NULL,
      PRIMARY KEY (task_id, label_id)
    );
  `);

  // --- Governance: approval_comments ---
  database.exec(`
    CREATE TABLE IF NOT EXISTS approval_comments (
      id TEXT PRIMARY KEY,
      approval_id TEXT NOT NULL,
      author_type TEXT NOT NULL DEFAULT 'user',
      author_id TEXT,
      comment TEXT NOT NULL,
      decision TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_approval_comments_approval ON approval_comments(approval_id);
  `);

  // --- Governance: agent_config_revisions ---
  database.exec(`
    CREATE TABLE IF NOT EXISTS agent_config_revisions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      changed_keys TEXT NOT NULL,
      before_snapshot TEXT NOT NULL,
      after_snapshot TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'patch',
      rolled_back_from_revision_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_config_revisions_agent ON agent_config_revisions(agent_id, created_at DESC);
  `);

  // --- Governance: activity_log ---
  database.exec(`
    CREATE TABLE IF NOT EXISTS activity_log (
      id TEXT PRIMARY KEY,
      actor_type TEXT NOT NULL DEFAULT 'system',
      actor_id TEXT,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      details TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_activity_log_time ON activity_log(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_activity_log_entity ON activity_log(entity_type, entity_id);
  `);

  // --- Governance: agent_spend_events new columns ---
  const spendCols = database.prepare("PRAGMA table_info(agent_spend_events)").all() as { name: string }[];
  const spendColNames = new Set(spendCols.map(c => c.name));
  if (spendColNames.size > 0) {
    if (!spendColNames.has("billing_code"))
      execIgnoringDuplicateColumn(database, "ALTER TABLE agent_spend_events ADD COLUMN billing_code TEXT");
    if (!spendColNames.has("goal_id"))
      execIgnoringDuplicateColumn(database, "ALTER TABLE agent_spend_events ADD COLUMN goal_id TEXT");
    if (!spendColNames.has("entity_type"))
      execIgnoringDuplicateColumn(database, "ALTER TABLE agent_spend_events ADD COLUMN entity_type TEXT");
    if (!spendColNames.has("entity_id"))
      execIgnoringDuplicateColumn(database, "ALTER TABLE agent_spend_events ADD COLUMN entity_id TEXT");
  }

  // --- Governance: agent_wakeup_requests ---
  database.exec(`
    CREATE TABLE IF NOT EXISTS agent_wakeup_requests (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      trigger_detail TEXT,
      payload TEXT,
      idempotency_key TEXT,
      coalesced_count INTEGER DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'queued',
      claimed_at TEXT,
      finished_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_wakeup_agent_status ON agent_wakeup_requests(agent_id, status);
  `);

  // --- Governance: task_approvals ---
  database.exec(`
    CREATE TABLE IF NOT EXISTS task_approvals (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      approver_type TEXT NOT NULL DEFAULT 'user',
      approver_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      decision_note TEXT,
      decided_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_task_approvals_task ON task_approvals(task_id);
    CREATE INDEX IF NOT EXISTS idx_task_approvals_status ON task_approvals(status);

    -- Desktop Attention Center: lightweight read/dismiss receipts keyed by
    -- source type + id. Source records (approvals, jobs, workflows) remain
    -- authoritative; this table never copies the underlying event.
    CREATE TABLE IF NOT EXISTS attention_receipts (
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'dismissed',
      updated_at TEXT NOT NULL,
      PRIMARY KEY (source_type, source_id)
    );
    CREATE INDEX IF NOT EXISTS idx_attention_receipts_state ON attention_receipts(state, updated_at DESC);

    CREATE TABLE IF NOT EXISTS skill_steward_state (
      skill_id TEXT PRIMARY KEY,
      name TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      note TEXT,
      last_used_at TEXT,
      usage_count INTEGER DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_skill_steward_status ON skill_steward_state(status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS hook_run_state (
      hook_path TEXT PRIMARY KEY,
      last_event_type TEXT,
      last_status TEXT NOT NULL DEFAULT 'never',
      last_error TEXT,
      last_duration_ms INTEGER,
      last_run_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_hook_run_state_updated ON hook_run_state(updated_at DESC);

    CREATE TABLE IF NOT EXISTS hook_file_state (
      hook_path TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 1,
      note TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_hook_file_state_enabled ON hook_file_state(enabled, updated_at DESC);
  `);

  const skillStewardCols = database.prepare("PRAGMA table_info(skill_steward_state)").all() as { name: string }[];
  const skillStewardColNames = skillStewardCols.map((c) => c.name);
  if (!skillStewardColNames.includes("name"))
    database.exec("ALTER TABLE skill_steward_state ADD COLUMN name TEXT");
  if (!skillStewardColNames.includes("last_used_at"))
    database.exec("ALTER TABLE skill_steward_state ADD COLUMN last_used_at TEXT");
  if (!skillStewardColNames.includes("usage_count"))
    database.exec("ALTER TABLE skill_steward_state ADD COLUMN usage_count INTEGER DEFAULT 0");

  // --- Governance: agents new columns (guard against missing table) ---
  const hasAgentsTable = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agents'").get();
  if (hasAgentsTable) {
    const agentGovernanceCols = database.prepare("PRAGMA table_info(agents)").all() as { name: string }[];
    const agentGovernanceColNames = new Set(agentGovernanceCols.map(c => c.name));
    if (agentGovernanceColNames.size > 0) {
      if (!agentGovernanceColNames.has("permissions"))
        execIgnoringDuplicateColumn(database, "ALTER TABLE agents ADD COLUMN permissions TEXT NOT NULL DEFAULT '{}'");
      if (!agentGovernanceColNames.has("context_mode"))
        execIgnoringDuplicateColumn(database, "ALTER TABLE agents ADD COLUMN context_mode TEXT DEFAULT 'fat'");
      if (!agentGovernanceColNames.has("heartbeat_cron"))
        execIgnoringDuplicateColumn(database, "ALTER TABLE agents ADD COLUMN heartbeat_cron TEXT");
    }
  }

  // --- Agent monthly budget tracking ---
  if (hasAgentsTable) {
    const agentBudgetCols = database.prepare("PRAGMA table_info(agents)").all() as { name: string }[];
    const agentBudgetColNames = agentBudgetCols.map(c => c.name);
    if (!agentBudgetColNames.includes("budget_monthly_cents"))
      database.exec("ALTER TABLE agents ADD COLUMN budget_monthly_cents INTEGER DEFAULT NULL");
    if (!agentBudgetColNames.includes("spent_monthly_cents"))
      database.exec("ALTER TABLE agents ADD COLUMN spent_monthly_cents INTEGER DEFAULT 0");
    if (!agentBudgetColNames.includes("budget_reset_at"))
      database.exec("ALTER TABLE agents ADD COLUMN budget_reset_at TEXT");
  }

  // --- Multi-company isolation: company_id columns ---

  // company_id on board_tasks (boardTaskColNames already fetched above)
  if (!boardTaskColNames.has("company_id")) {
    database.exec("ALTER TABLE board_tasks ADD COLUMN company_id TEXT");
  }

  // company_id on workflows
  const wfCols = database.prepare("PRAGMA table_info(workflows)").all() as Array<{ name: string }>;
  const wfColNames = new Set(wfCols.map((c) => c.name));
  if (!wfColNames.has("company_id")) {
    database.exec("ALTER TABLE workflows ADD COLUMN company_id TEXT");
  }

  // company_id on executions (executionCols already fetched above as executionColNames array)
  const execCols2 = database.prepare("PRAGMA table_info(executions)").all() as Array<{ name: string }>;
  const execColNames2 = new Set(execCols2.map((c) => c.name));
  if (!execColNames2.has("company_id")) {
    database.exec("ALTER TABLE executions ADD COLUMN company_id TEXT");
  }
  if (!execColNames2.has("parent_execution_id")) {
    database.exec("ALTER TABLE executions ADD COLUMN parent_execution_id TEXT");
  }
  if (!execColNames2.has("parent_node_id")) {
    database.exec("ALTER TABLE executions ADD COLUMN parent_node_id TEXT");
  }

  const chatAttachmentCols = database.prepare("PRAGMA table_info(chat_attachments)").all() as Array<{ name: string }>;
  const chatAttachmentColNames = new Set(chatAttachmentCols.map((c) => c.name));
  if (!chatAttachmentColNames.has("metadata")) {
    database.exec("ALTER TABLE chat_attachments ADD COLUMN metadata TEXT");
  }

  // company_id on activity_log
  const actCols = database.prepare("PRAGMA table_info(activity_log)").all() as Array<{ name: string }>;
  const actColNames = new Set(actCols.map((c) => c.name));
  if (!actColNames.has("company_id")) {
    database.exec("ALTER TABLE activity_log ADD COLUMN company_id TEXT");
  }

  // --- Heartbeat execution history ---
  database.exec(`
    CREATE TABLE IF NOT EXISTS heartbeat_runs (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      invocation_source TEXT NOT NULL DEFAULT 'scheduled',
      wakeup_request_id TEXT,
      wakeups_processed INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_heartbeat_runs_agent ON heartbeat_runs(agent_id, started_at DESC);
  `);

  // --- agent_spend_events: task_id attribution column ---
  if (spendColNames.size > 0 && !spendColNames.has("task_id"))
    execIgnoringDuplicateColumn(database, "ALTER TABLE agent_spend_events ADD COLUMN task_id TEXT");

  // --- agent_runtime_state ---
  database.exec(`
    CREATE TABLE IF NOT EXISTS agent_runtime_state (
      agent_id TEXT PRIMARY KEY,
      session_id TEXT,
      state_json TEXT,
      total_input_tokens INTEGER NOT NULL DEFAULT 0,
      total_output_tokens INTEGER NOT NULL DEFAULT 0,
      total_cached_tokens INTEGER NOT NULL DEFAULT 0,
      total_cost_usd REAL NOT NULL DEFAULT 0,
      last_run_id TEXT,
      last_run_status TEXT,
      last_error TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_runtime_state_updated ON agent_runtime_state(updated_at DESC);
  `);

  // --- heartbeat_run_events ---
  database.exec(`
    CREATE TABLE IF NOT EXISTS heartbeat_run_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      seq INTEGER NOT NULL DEFAULT 0,
      event_type TEXT NOT NULL DEFAULT 'log',
      stream TEXT,
      level TEXT DEFAULT 'info',
      message TEXT,
      payload TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_hb_run_events_run ON heartbeat_run_events(run_id, seq);
    CREATE INDEX IF NOT EXISTS idx_hb_run_events_agent ON heartbeat_run_events(agent_id, created_at DESC);
  `);

  // --- task_comments ---
  database.exec(`
    CREATE TABLE IF NOT EXISTS task_comments (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      author_agent_id TEXT,
      author_user_id TEXT,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_task_comments_task ON task_comments(task_id, created_at ASC);
  `);

  // --- turn_progress_events: persisted workflow node progress per WebChat turn ---
  database.exec(`
    CREATE TABLE IF NOT EXISTS turn_progress_events (
      id TEXT PRIMARY KEY,
      client_turn_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_turn_progress_events_turn ON turn_progress_events(client_turn_id, created_at ASC);
  `);

  // Migration: repair cross-platform workspace paths
  try {
    database.prepare(
      "UPDATE agents SET workspace_path = 'agents/' || id WHERE workspace_path LIKE '%:%' OR workspace_path LIKE '%\\%'"
    ).run();
  } catch {
    // migration may run before table exists
  }

  repairLegacyWorkflowTemplates(database);

  // Dynamic workflow tables
  const { ensureDynamicWorkflowTables } = require("../dynamic-workflows/store") as typeof import("../dynamic-workflows/store");
  ensureDynamicWorkflowTables();
}
