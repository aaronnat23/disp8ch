#!/usr/bin/env node
/**
 * disp8ch CLI — Configure disp8ch from the command line.
 *
 * Usage:
 *   dpc <command> [args]
 *
 * Commands:
 *   init [--ensure-env] [--timezone <tz>] [--onboarding-done]  Initialize app state for automation
 *
 *   models list                          List configured models
 *   models recommend [provider]          Show recommended tool-capable models
 *   models add <provider> [api-key] [base-url] [--model <model-id>] [--fast]  Add a model provider
 *   models probe [id|provider]           Probe model connectivity
 *   models probe-tools [id|provider]     Probe model tool-use connectivity
 *   models remove <id>                   Remove a model
 *   models set-priority <id> <priority>  Set model priority (higher = preferred)
 *
 *   memory embedding-status              Show active embedding model and vector index stats
 *   memory stats                         Show memory statistics
 *   memory list                          List all memories
 *   memory search <query>                Search memories
 *   memory clear                         Delete all memories
 *   memory rebuild-index                 Rebuild embeddings + FTS index for all memories
 *   memory index-sessions                Index past session transcripts into memory search
 *   memory index-collections             Index extra markdown collections into memory search
 *   memory backfill                      Sync atomic memory files to MEMORY.md
 *
 *   workflows list                       List all workflows
 *   workflows create <name> [template]   Create a workflow (supports all built-in templates)
 *   workflows delete <id>                Delete a workflow
 *
 *   agents list                          List agents
 *   agents create <name>                 Create an agent
 *   agents update <id>                   Update an agent
 *   agents delete <id>                   Delete an agent
 *   agents default                       Show the default agent
 *
 *   data-sources list                    List uploaded/scraped data sources
 *   data-sources search <query>          Search data sources
 *   data-sources get <id-or-name>        Show one data source
 *   data-sources upload <file>           Upload a file data source
 *   data-sources scrape <url>            Scrape one page
 *   data-sources crawl <url>             Crawl multiple pages
 *   data-sources delete <id-or-name>     Delete a data source
 *
 *   boards list                          List boards
 *   boards create <name>                 Create a board
 *   boards delete <board-id>             Delete a board
 *   boards tasks                         List board tasks
 *   boards create-task <title>           Create a board task
 *   boards run-task <task-id>            Run a workflow-backed board task
 *   boards claim-task <task-id> <agent>  Check out a task
 *   boards release-task <task-id>        Release a checked-out task
 *   boards delete-task <task-id>         Delete a board task
 *
 *   orgs list                            List saved organizations
 *   orgs current                         Show the active organization
 *   orgs save-current <name>             Save current hierarchy as an organization
 *   orgs switch <id-or-name>             Switch to a saved organization
 *   orgs delete <id-or-name>             Delete a saved organization
 *   orgs export <id-or-name> [path]       Export an organization pack to JSON
 *   orgs import <file>                    Import an organization pack JSON
 *   orgs import-template <path>           Import an external company export/template
 *
 *   goals list                           List hierarchy goals
 *   goals create <name>                  Create a hierarchy goal
 *   goals delete <goal-id>               Delete a hierarchy goal

 *   extensions list                      List installed extensions + global state
 *   extensions status                    Show runtime hook status for extensions
 *   extensions install <source> [ref]    Install an external extension from local path or git
 *   extensions update <id>               Refresh an installed external extension from its tracked source
 *   extensions uninstall <id>            Remove an installed external extension
 *   extensions enable <id>               Enable an extension globally
 *   extensions disable <id>              Disable an extension globally
 *   extensions config-get <id>           Show stored extension config
 *   extensions config-set <id> <json>    Save stored extension config JSON
 *
 *   skills list [--verbose]              List installed skill packs + their sources
 *   skills install <source> [ref]        Install an external skill pack from local path or git
 *   skills update <id>                   Refresh an installed external skill pack from its tracked source
 *   skills uninstall <id>                Remove an installed external skill pack
 *   skills import-reference <repo-path>  Import external reference skills into a disp8ch skill pack
 *   skills import-workspace <repo-path>  Import workspace skills into a disp8ch skill pack

 *   learning status                      Show learning-loop status
 *   learning candidates                  List learning candidates
 *   learning events                      List recent learning events
 *   learning promote <id|latest>         Promote a learning candidate
 *   learning dismiss <id|latest>         Dismiss a learning candidate
 *
 *   backup create                        Create a verified local backup snapshot
 *   backup list                          List backup snapshots
 *   backup verify [id|latest]            Verify checksums for a backup snapshot
 *
 *   acp status                           Show ACP ingress status
 *   acp test [message]                   Send a test ACP message through /api/acp
 *   acp sessions                         List ACP session bindings
 *   acp reset-session <id-or-label>      Reset a persisted ACP session transcript
 *   acp serve [--port <n>] [--target <url>]  Run an ACP bridge proxy
 *
 *   config get <key>                     Get a config value
 *   config set <key> <value>             Set a config value
 *   config show [--json]                 Show all configuration
 *   config validate                      Validate runtime config and security posture
 *
 *   secrets list                         List stored secret names
 *   secrets set <name> <value|--stdin>   Create/update an encrypted secret
 *   secrets remove <name>                Delete a stored secret
 *
 *   auth google [--manual]               Set up Google OAuth (Gmail/Drive)
 *   auth status                          Show Google OAuth status
 *   auth revoke                          Delete stored Google OAuth token
 *
 *   status                               Show system status
 *   health [--json]                      Run structured health checks
 *   doctor [--repair] [--json]           Diagnose and optionally repair common issues
 *   update [--dry-run] [--json]          Report or apply install updates
 *   env                                  Show which env vars are set
 */

import Database from "better-sqlite3";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { normalizeProviderBaseUrl } from "../src/lib/agents/provider-base-url";
import { normalizeProviderId } from "../src/lib/agents/provider-normalization";
import { getRuntimeModelAvailability } from "../src/lib/agents/model-availability";
import { resolveModelApiKey } from "../src/lib/agents/provider-auth";
import { callModel } from "../src/lib/agents/multi-provider";
import { callWithTools } from "../src/lib/agents/tool-caller";
import { TOOL_CATALOG } from "../src/lib/engine/tools";
import { PROVIDERS } from "../src/types/model";
import {
  providerRequiresApiKey,
  providerSupportsBaseUrlInput,
  resolveProviderModelSelection,
} from "../src/lib/agents/provider-plugins";
import { checkModelToolSupport, getToolCapableRecommendations } from "../src/lib/agents/model-capabilities";
import { runConfigValidation } from "../src/lib/config/validator";
import { deleteSecret, getSecretsStatus, listSecretsMeta, upsertSecret } from "../src/lib/secrets/store";
import { createBackup, listBackups, verifyBackup } from "../src/lib/backup/manager";
import { getBackupPolicyStatus, runBackupPolicy } from "../src/lib/backup/policy";
import {
  createAgent,
  deleteAgent,
  getDefaultAgent,
  listAgents,
  pruneExtensionReferences,
  pruneSkillPackReferences,
  updateAgent,
} from "../src/lib/agents/registry";
import {
  createBoard,
  createBoardTask,
  deleteBoard,
  deleteBoardTask,
  listBoards,
  listBoardTasks,
  releaseBoardTask,
  claimBoardTask,
} from "../src/lib/boards/manager";
import { runWorkflowBackedBoardTask } from "../src/lib/boards/task-runner";
import {
  createDocumentFromCrawl,
  createDocumentFromScrape,
  createDocumentFromUpload,
  deleteDocument,
  getDocumentById,
  getDocumentByName,
  listDocuments,
  searchDocuments,
} from "../src/lib/documents/store";
import { initializeDatabase } from "../src/lib/db";
import {
  applyHierarchyOrganization,
  deleteHierarchyOrganization,
  getActiveHierarchyOrganization,
  listHierarchyOrganizations,
  resolveHierarchyOrganization,
  saveCurrentHierarchyOrganization,
} from "../src/lib/hierarchy/organizations";
import { createHierarchyGoal, deleteHierarchyGoal, listHierarchyGoals } from "../src/lib/hierarchy/goals";
import { exportCompanyPackage, importCompanyPackage, importExternalCompanyTemplate } from "../src/lib/governance/company-packages";
import { getExtensionRuntimeStatus, listRuntimeBackedExtensionIds, loadExtensionRuntimeRegistry } from "../src/lib/extensions/runtime";
import {
  buildGlobalExtensionEntries,
  clearGlobalExtensionState,
  getExtensionGlobalConfig,
  setGlobalExtensionConfig,
  setGlobalExtensionEnabled,
} from "../src/lib/extensions/state";
import {
  installExternalExtension,
  uninstallExternalExtension,
  updateExternalExtension,
} from "../src/lib/extensions/installer";
import { listInstalledSkillCatalog, listInstalledSkillInventory } from "../src/lib/extensions/registry";
import {
  installExternalSkillPack,
  listExternalSkillPacks,
  uninstallExternalSkillPack,
  updateExternalSkillPack,
} from "../src/lib/skills/installer";
import {
  dismissLearningCandidate,
  formatLearningStatusMarkdown,
  listLearningCandidates,
  listLearningEvents,
  promoteLearningCandidate,
} from "../src/lib/learning/loop";
import { importExternalSkillLibraryRepo, importWorkspaceSkillLibraryRepo } from "../src/lib/learning/importers";
import { getInstallPaths, type InstallChannel } from "./install-paths";

// Resolve project root and database
const PROJECT_ROOT = process.cwd();
const DB_PATH = path.resolve(process.env.DATABASE_PATH || "./data/disp8ch.db");
const MEMORY_PATH = path.resolve(process.env.MEMORY_PATH || "./data/memories");
const WORKSPACE_PATH = path.resolve(process.env.WORKSPACE_PATH || "./data/workspace");
const WORKSPACE_MEMORY_PATH = path.join(WORKSPACE_PATH, "memory");

type HealthCheck = {
  name: string;
  status: "ok" | "warn" | "fail";
  details: string;
};

const PROVIDER_ID_LIST = PROVIDERS.map((provider) => provider.id).join(", ");

// Provider defaults
const PROVIDER_DEFAULTS: Record<string, { model: string; name: string; baseUrl?: string }> =
  Object.fromEntries(
    PROVIDERS.map((provider) => [
      provider.id,
      {
        model: provider.defaultModel,
        name: provider.defaultName,
        ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
      },
    ]),
  );

function getDb(): Database.Database {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`Database not found at ${DB_PATH}. Run 'pnpm run setup' first.`);
    process.exit(1);
  }
  const db = new Database(DB_PATH);
  db.pragma(process.platform === "win32" ? "journal_mode = DELETE" : "journal_mode = WAL");

  // Ensure base_url column exists
  try {
    db.prepare("SELECT base_url FROM models LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE models ADD COLUMN base_url TEXT");
  }
  try {
    db.prepare("SELECT fast_mode FROM models LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE models ADD COLUMN fast_mode INTEGER DEFAULT 0");
  }

  try {
    const appCols = db.prepare("PRAGMA table_info(app_config)").all() as Array<{ name: string }>;
    const names = new Set(appCols.map((c) => c.name));
    if (!names.has("learning_enabled")) db.exec("ALTER TABLE app_config ADD COLUMN learning_enabled INTEGER DEFAULT 1");
    if (!names.has("learning_mode")) db.exec("ALTER TABLE app_config ADD COLUMN learning_mode TEXT DEFAULT 'review'");
    if (!names.has("learning_capture_preferences")) db.exec("ALTER TABLE app_config ADD COLUMN learning_capture_preferences INTEGER DEFAULT 1");
    if (!names.has("learning_capture_playbooks")) db.exec("ALTER TABLE app_config ADD COLUMN learning_capture_playbooks INTEGER DEFAULT 1");
    if (!names.has("learning_auto_promote_threshold")) db.exec("ALTER TABLE app_config ADD COLUMN learning_auto_promote_threshold INTEGER DEFAULT 2");
    if (!names.has("tool_output_limit")) db.exec("ALTER TABLE app_config ADD COLUMN tool_output_limit INTEGER DEFAULT 8000");
    if (!names.has("compaction_mode")) db.exec("ALTER TABLE app_config ADD COLUMN compaction_mode TEXT DEFAULT 'off'");
    if (!names.has("compaction_threshold")) db.exec("ALTER TABLE app_config ADD COLUMN compaction_threshold REAL DEFAULT 0.75");
    if (!names.has("context_window")) db.exec("ALTER TABLE app_config ADD COLUMN context_window INTEGER DEFAULT 200000");
    if (!names.has("channel_retry_attempts")) db.exec("ALTER TABLE app_config ADD COLUMN channel_retry_attempts INTEGER DEFAULT 3");
    if (!names.has("channel_retry_min_delay_ms")) db.exec("ALTER TABLE app_config ADD COLUMN channel_retry_min_delay_ms INTEGER DEFAULT 400");
    if (!names.has("channel_retry_max_delay_ms")) db.exec("ALTER TABLE app_config ADD COLUMN channel_retry_max_delay_ms INTEGER DEFAULT 30000");
    if (!names.has("channel_retry_jitter")) db.exec("ALTER TABLE app_config ADD COLUMN channel_retry_jitter REAL DEFAULT 0.1");
    if (!names.has("telemetry_enabled")) db.exec("ALTER TABLE app_config ADD COLUMN telemetry_enabled INTEGER DEFAULT 1");
    if (!names.has("hooks_enabled")) db.exec("ALTER TABLE app_config ADD COLUMN hooks_enabled INTEGER DEFAULT 1");
    if (!names.has("memory_flush_enabled")) db.exec("ALTER TABLE app_config ADD COLUMN memory_flush_enabled INTEGER DEFAULT 1");
    if (!names.has("context_pruning_mode")) db.exec("ALTER TABLE app_config ADD COLUMN context_pruning_mode TEXT DEFAULT 'tool-results'");
    if (!names.has("context_pruning_keep_recent_assistants")) db.exec("ALTER TABLE app_config ADD COLUMN context_pruning_keep_recent_assistants INTEGER DEFAULT 3");
    if (!names.has("context_pruning_min_tool_chars")) db.exec("ALTER TABLE app_config ADD COLUMN context_pruning_min_tool_chars INTEGER DEFAULT 12000");
    if (!names.has("context_pruning_max_tool_chars")) db.exec("ALTER TABLE app_config ADD COLUMN context_pruning_max_tool_chars INTEGER DEFAULT 4000");
    if (!names.has("context_pruning_head_chars")) db.exec("ALTER TABLE app_config ADD COLUMN context_pruning_head_chars INTEGER DEFAULT 1500");
    if (!names.has("context_pruning_tail_chars")) db.exec("ALTER TABLE app_config ADD COLUMN context_pruning_tail_chars INTEGER DEFAULT 1500");
    if (!names.has("rate_limit_webhooks")) db.exec("ALTER TABLE app_config ADD COLUMN rate_limit_webhooks INTEGER DEFAULT 30");
    if (!names.has("rate_limit_execute")) db.exec("ALTER TABLE app_config ADD COLUMN rate_limit_execute INTEGER DEFAULT 20");
    if (!names.has("rate_limit_channels")) db.exec("ALTER TABLE app_config ADD COLUMN rate_limit_channels INTEGER DEFAULT 60");
    if (!names.has("log_max_days")) db.exec("ALTER TABLE app_config ADD COLUMN log_max_days INTEGER DEFAULT 7");
    if (!names.has("lane_main_max_concurrent")) db.exec("ALTER TABLE app_config ADD COLUMN lane_main_max_concurrent INTEGER DEFAULT 4");
    if (!names.has("lane_cron_max_concurrent")) db.exec("ALTER TABLE app_config ADD COLUMN lane_cron_max_concurrent INTEGER DEFAULT 1");
    if (!names.has("lane_subflow_max_concurrent")) db.exec("ALTER TABLE app_config ADD COLUMN lane_subflow_max_concurrent INTEGER DEFAULT 8");
    if (!names.has("provenance_mode")) db.exec("ALTER TABLE app_config ADD COLUMN provenance_mode TEXT DEFAULT 'meta'");
    if (!names.has("acp_auth_mode")) db.exec("ALTER TABLE app_config ADD COLUMN acp_auth_mode TEXT DEFAULT 'off'");
    if (!names.has("acp_auth_secret_name")) db.exec("ALTER TABLE app_config ADD COLUMN acp_auth_secret_name TEXT");
    if (!names.has("install_posture")) db.exec("ALTER TABLE app_config ADD COLUMN install_posture TEXT DEFAULT 'local_only'");
    if (!names.has("disable_loopback_bypass")) db.exec("ALTER TABLE app_config ADD COLUMN disable_loopback_bypass INTEGER DEFAULT 0");
    if (!names.has("operator_auth_backoff_enabled")) db.exec("ALTER TABLE app_config ADD COLUMN operator_auth_backoff_enabled INTEGER DEFAULT 1");
  } catch {
    // best-effort migration guard for older databases
  }

  try {
    const memCols = db.prepare("PRAGMA table_info(memory_config)").all() as Array<{ name: string }>;
    const memNames = new Set(memCols.map((c) => c.name));
    if (!memNames.has("decay_enabled")) db.exec("ALTER TABLE memory_config ADD COLUMN decay_enabled INTEGER DEFAULT 1");
    if (!memNames.has("decay_half_life_days")) db.exec("ALTER TABLE memory_config ADD COLUMN decay_half_life_days INTEGER DEFAULT 30");
    if (!memNames.has("embedding_model")) db.exec("ALTER TABLE memory_config ADD COLUMN embedding_model TEXT DEFAULT 'auto'");
    if (!memNames.has("vector_weight")) db.exec("ALTER TABLE memory_config ADD COLUMN vector_weight REAL DEFAULT 0.7");
    if (!memNames.has("text_weight")) db.exec("ALTER TABLE memory_config ADD COLUMN text_weight REAL DEFAULT 0.3");
    if (!memNames.has("index_sessions")) db.exec("ALTER TABLE memory_config ADD COLUMN index_sessions INTEGER DEFAULT 1");
    if (!memNames.has("session_chunk_tokens")) db.exec("ALTER TABLE memory_config ADD COLUMN session_chunk_tokens INTEGER DEFAULT 400");
    if (!memNames.has("session_chunk_overlap")) db.exec("ALTER TABLE memory_config ADD COLUMN session_chunk_overlap INTEGER DEFAULT 80");
    if (!memNames.has("startup_include_files")) db.exec("ALTER TABLE memory_config ADD COLUMN startup_include_files TEXT DEFAULT NULL");
    if (!memNames.has("max_snippet_chars")) db.exec("ALTER TABLE memory_config ADD COLUMN max_snippet_chars INTEGER DEFAULT 700");
    if (!memNames.has("max_injected_chars")) db.exec("ALTER TABLE memory_config ADD COLUMN max_injected_chars INTEGER DEFAULT 4000");
    if (!memNames.has("citations_mode")) db.exec("ALTER TABLE memory_config ADD COLUMN citations_mode TEXT DEFAULT 'on'");
    if (!memNames.has("extra_collection_paths")) db.exec("ALTER TABLE memory_config ADD COLUMN extra_collection_paths TEXT DEFAULT NULL");
    if (!memNames.has("search_backend")) db.exec("ALTER TABLE memory_config ADD COLUMN search_backend TEXT DEFAULT 'qmd-like'");
    if (!memNames.has("rerank_strategy")) db.exec("ALTER TABLE memory_config ADD COLUMN rerank_strategy TEXT DEFAULT 'auto'");
    if (!memNames.has("query_expansion_enabled")) db.exec("ALTER TABLE memory_config ADD COLUMN query_expansion_enabled INTEGER DEFAULT 1");
    if (!memNames.has("strong_signal_enabled")) db.exec("ALTER TABLE memory_config ADD COLUMN strong_signal_enabled INTEGER DEFAULT 1");
    if (!memNames.has("rerank_candidate_limit")) db.exec("ALTER TABLE memory_config ADD COLUMN rerank_candidate_limit INTEGER DEFAULT 40");
  } catch {
    // best-effort migration guard for older databases
  }

  return db;
}

function nanoid(size = 8): string {
  return crypto.randomBytes(size).toString("hex").slice(0, size);
}

function slugifyForFile(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "organization-pack";
}

const CONFIG_KEY_ALIASES: Record<string, string> = {
  learning_enabled: "learning.enabled",
  learning_mode: "learning.mode",
  learning_capture_preferences: "learning.capture_preferences",
  learning_capture_playbooks: "learning.capture_playbooks",
  learning_auto_promote_threshold: "learning.auto_promote_threshold",
  tool_output_limit: "tool.output_limit",
  compaction_mode: "compaction.mode",
  compaction_threshold: "compaction.threshold",
  context_window: "compaction.context_window",
  pending_mutation_ttl_ms: "pending_mutation.ttl_ms",
  context_pruning_mode: "context.pruning.mode",
  context_pruning_keep_recent_assistants: "context.pruning.keep_recent_assistants",
  context_pruning_min_tool_chars: "context.pruning.min_tool_chars",
  context_pruning_max_tool_chars: "context.pruning.max_tool_chars",
  context_pruning_head_chars: "context.pruning.head_chars",
  context_pruning_tail_chars: "context.pruning.tail_chars",
  channel_retry_attempts: "retry.attempts",
  channel_retry_min_delay_ms: "retry.min_delay_ms",
  channel_retry_max_delay_ms: "retry.max_delay_ms",
  channel_retry_jitter: "retry.jitter",
  provenance_mode: "provenance_mode",
  acp_auth_mode: "acp_auth_mode",
  acp_auth_secret_name: "acp_auth_secret_name",
  telemetry_enabled: "telemetry.enabled",
  hooks_enabled: "hooks.enabled",
  memory_flush_enabled: "memory.flush_enabled",
  rate_limit_webhooks: "ratelimit.webhooks",
  rate_limit_execute: "ratelimit.execute",
  rate_limit_channels: "ratelimit.channels",
  lane_main_max_concurrent: "lane.main.max_concurrent",
  lane_cron_max_concurrent: "lane.cron.max_concurrent",
  lane_subflow_max_concurrent: "lane.subflow.max_concurrent",
  log_max_days: "log.max_days",
  decay_enabled: "memory.decay.enabled",
  decay_half_life_days: "memory.decay.half_life_days",
  embedding_model: "memory.embedding_model",
  vector_weight: "memory.vector_weight",
  text_weight: "memory.text_weight",
  index_sessions: "memory.index_sessions",
  session_chunk_tokens: "memory.session_chunk_tokens",
  session_chunk_overlap: "memory.session_chunk_overlap",
  startup_include_files: "memory.startup_include_files",
  max_snippet_chars: "memory.max_snippet_chars",
  max_injected_chars: "memory.max_injected_chars",
  citations_mode: "memory.citations_mode",
  extra_collection_paths: "memory.extra_collection_paths",
  search_backend: "memory.search_backend",
  rerank_strategy: "memory.rerank_strategy",
  query_expansion_enabled: "memory.query_expansion_enabled",
  strong_signal_enabled: "memory.strong_signal_enabled",
  rerank_candidate_limit: "memory.rerank_candidate_limit",
};

function resolveConfigKey(key: string): string {
  return CONFIG_KEY_ALIASES[key] ?? key;
}

function parseBooleanConfigValue(value: string, key: string): number {
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "on", "yes"].includes(normalized)) return 1;
  if (["0", "false", "off", "no"].includes(normalized)) return 0;
  console.error(`${key} must be true/false or 1/0`);
  process.exit(1);
}

function parseIntConfigValue(value: string, key: string, min: number, max?: number): number {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < min || (max !== undefined && parsed > max)) {
    console.error(
      max === undefined
        ? `${key} must be >= ${min}`
        : `${key} must be between ${min} and ${max}`
    );
    process.exit(1);
  }
  return parsed;
}

function parseNumberConfigValue(value: string, key: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    console.error(`${key} must be between ${min} and ${max}`);
    process.exit(1);
  }
  return parsed;
}

function parseNullableListConfigValue(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (["null", "none", "clear", "default"].includes(trimmed.toLowerCase())) return null;
  return trimmed
    .split(/\r?\n|,/)
    .map((part) => part.trim())
    .filter(Boolean)
    .join(",");
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function readOption(args: string[], flag: string): string | undefined {
  const exact = args.indexOf(flag);
  if (exact >= 0) {
    const next = args[exact + 1];
    if (!next || next.startsWith("--")) return undefined;
    return next;
  }
  const prefix = `${flag}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (!inline) return undefined;
  return inline.slice(prefix.length);
}

function parseOptionalInt(
  args: string[],
  flag: string,
  fallback: number,
  min: number,
  max?: number,
): number {
  const raw = readOption(args, flag);
  if (raw === undefined) return fallback;
  return parseIntConfigValue(raw, flag, min, max);
}

function parseCsvOption(args: string[], flag: string): string[] | undefined {
  const raw = readOption(args, flag);
  if (raw === undefined) return undefined;
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function ensureEnvFileDefaults(options?: {
  forceWrite?: boolean;
  encryptionKey?: string;
}): { envPath: string; created: boolean; updated: boolean } {
  const envPath = path.join(PROJECT_ROOT, ".env.local");
  const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf-8") : "";
  const lines = existing ? existing.split(/\r?\n/) : [];
  const lineMap = new Map<string, number>();

  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/^([A-Z0-9_]+)=/);
    if (match) lineMap.set(match[1], i);
  }

  const desired = new Map<string, string>([
    ["WS_PORT", "3101"],
    ["DATABASE_PATH", "./data/disp8ch.db"],
    ["MEMORY_PATH", "./data/memories"],
  ]);

  let encryptionKey = String(options?.encryptionKey || "").trim();
  if (!encryptionKey) {
    const current = process.env.SECRETS_MASTER_KEY || process.env.ENCRYPTION_KEY;
    encryptionKey = String(current || "").trim();
  }
  if (!encryptionKey) {
    encryptionKey = crypto.randomBytes(32).toString("hex");
  }
  desired.set("ENCRYPTION_KEY", encryptionKey);

  let updated = false;
  for (const [key, value] of desired) {
    const line = `${key}=${value}`;
    const existingIndex = lineMap.get(key);
    if (existingIndex === undefined) {
      lines.push(line);
      updated = true;
      continue;
    }
    const currentValue = lines[existingIndex].slice(key.length + 1);
    if (!currentValue.trim() || options?.forceWrite) {
      if (lines[existingIndex] !== line) {
        lines[existingIndex] = line;
        updated = true;
      }
    }
  }

  if (!fs.existsSync(envPath)) {
    fs.writeFileSync(envPath, `${lines.join("\n").trim()}\n`, "utf-8");
    return { envPath, created: true, updated: true };
  }

  if (updated) {
    fs.writeFileSync(envPath, `${lines.join("\n").trim()}\n`, "utf-8");
  }
  return { envPath, created: false, updated };
}

// ============================================================================
// Commands
// ============================================================================

function modelsListCmd() {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM models ORDER BY priority DESC").all() as Array<{
    id: string; provider: string; model_id: string; name: string;
    priority: number; is_active: number; base_url: string | null; fast_mode?: number | null;
  }>;

  if (rows.length === 0) {
    console.log("No models configured.");
    console.log("Add one with: dpc models add <provider> [api-key] [base-url] [--model <model-id>] [--fast]");
    console.log("See recommendations with: dpc models recommend [provider]");
    console.log(`Providers: ${PROVIDER_ID_LIST}`);
    return;
  }

  console.log("Configured models:\n");
  for (const r of rows) {
    const active = r.is_active ? "active" : "inactive";
    const support = checkModelToolSupport(r.provider, r.model_id);
    const supportLabel =
      support.status === "supported" ? "tools:yes" :
      support.status === "unsupported" ? "tools:no" :
      "tools:unknown";
    console.log(`  [${r.id}] ${r.name}`);
    console.log(`         provider: ${r.provider}  model: ${r.model_id}`);
    console.log(`         priority: ${r.priority}  status: ${active}  ${supportLabel}${r.base_url ? `  url: ${r.base_url}` : ""}${r.fast_mode === 1 ? "  fast:on" : ""}`);
    if (support.status !== "supported") {
      console.log(`         note: ${support.reason}`);
    }
    console.log();
  }
  db.close();
}

function modelsRecommendCmd(target?: string) {
  const targetProvider = target ? normalizeProviderId(target) : null;
  const providers = targetProvider
    ? PROVIDERS.filter((p) => p.id === targetProvider)
    : PROVIDERS;

  if (providers.length === 0) {
    console.log(`Unknown provider: ${target}`);
    console.log(`Valid: ${PROVIDERS.map((p) => p.id).join(", ")}`);
    process.exit(1);
  }

  console.log(`Recommended tool-capable models (${providers.length} provider${providers.length === 1 ? "" : "s"}):\n`);
  for (const provider of providers) {
    const recommended = getToolCapableRecommendations(provider.id);
    const fallback = provider.models.filter((m) => m.supportsTools).slice(0, 4);
    const models = recommended.length > 0 ? recommended : fallback;
    console.log(`  ${provider.id} (default: ${provider.defaultModel})`);
    if (models.length === 0) {
      console.log("    - none in curated list");
      console.log();
      continue;
    }
    for (const model of models) {
      const status = model.status ? ` [${model.status}]` : "";
      console.log(`    - ${model.id}${status}`);
    }
    console.log();
  }
}

async function modelsAddCmd(
  providerInput: string,
  apiKeyOrBaseUrl?: string,
  maybeBaseUrl?: string,
  ...extraArgs: string[]
) {
  if (!providerInput) {
    console.error("Usage: dpc models add <provider> [api-key] [base-url] [--model <model-id>] [--allow-unsupported-model] [--fast]");
    console.error(`Providers: ${PROVIDER_ID_LIST}`);
    process.exit(1);
  }

  const provider = normalizeProviderId(providerInput);
  if (!provider) {
    console.error(`Unknown provider: ${providerInput}`);
    console.error(`Valid: ${Object.keys(PROVIDER_DEFAULTS).join(", ")}`);
    process.exit(1);
  }

  const defaults = PROVIDER_DEFAULTS[provider];
  if (!apiKeyOrBaseUrl && providerRequiresApiKey(provider)) {
    console.error(`API key required for ${provider}. Usage: dpc models add ${provider} <api-key>`);
    process.exit(1);
  }

  const providerUsesBaseUrl = providerSupportsBaseUrlInput(provider);
  const baseUrlInput = providerUsesBaseUrl ? apiKeyOrBaseUrl : maybeBaseUrl;
  const apiKeyLooksLikeUrl = /^https?:\/\//i.test(String(apiKeyOrBaseUrl || "").trim());
  const normalizedBaseUrl =
    normalizeProviderBaseUrl(provider, baseUrlInput) ??
    normalizeProviderBaseUrl(provider, defaults.baseUrl) ??
    null;
  const normalizedApiKey =
    !providerRequiresApiKey(provider) && (provider === "ollama" || provider === "lmstudio" || apiKeyLooksLikeUrl)
      ? ""
      : (apiKeyOrBaseUrl || "");
  let modelId = defaults.model;
  let modelName = defaults.name;
  let customModelId: string | undefined;
  let allowUnsupportedModel = false;
  let fastMode = false;

  for (let i = 0; i < extraArgs.length; i++) {
    const arg = String(extraArgs[i] || "");
    if (arg === "--model") {
      const value = String(extraArgs[i + 1] || "").trim();
      if (!value) {
        console.error("Missing value for --model");
        process.exit(1);
      }
      customModelId = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--model=")) {
      const value = arg.slice("--model=".length).trim();
      if (!value) {
        console.error("Missing value for --model");
        process.exit(1);
      }
      customModelId = value;
      continue;
    }
    if (arg === "--allow-unsupported-model") {
      allowUnsupportedModel = true;
      continue;
    }
    if (arg === "--fast" || arg === "--fast-mode") {
      fastMode = true;
      continue;
    }
    if (arg === "--no-fast") {
      fastMode = false;
      continue;
    }
    console.error(`Unknown option: ${arg}`);
    console.error("Supported options: --model <model-id>, --allow-unsupported-model, --fast, --no-fast");
    process.exit(1);
  }
  const selection = await resolveProviderModelSelection({
    provider,
    requestedModelId: customModelId,
    baseUrl: normalizedBaseUrl,
    apiKey: normalizedApiKey,
  });
  modelId = selection.modelId || modelId;
  modelName = selection.name || modelName;
  if (selection.discovered) {
    console.log(`Discovered ${provider} model: ${modelId}`);
  }
  for (const warning of selection.warnings) {
    console.warn(`Warning: ${warning}`);
  }

  const support = checkModelToolSupport(provider, modelId);
  if (support.status === "unsupported" && !allowUnsupportedModel) {
    const rec = support.recommendations.map((m) => m.id);
    console.error(`Model "${modelId}" is marked as not tool-capable for ${provider}.`);
    console.error(`Reason: ${support.reason}`);
    if (rec.length > 0) {
      console.error(`Use one of: ${rec.join(", ")}`);
    }
    console.error("If you still want this model, re-run with --allow-unsupported-model");
    process.exit(1);
  }
  if (support.status !== "supported") {
    console.warn(`Warning: ${support.reason}`);
  }

  const db = getDb();
  const id = nanoid();
  const now = new Date().toISOString();
  const count = (db.prepare("SELECT COUNT(*) as c FROM models").get() as { c: number }).c;

  db.prepare(
    "INSERT INTO models (id, provider, model_id, name, api_key, priority, is_active, base_url, fast_mode, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(id, provider, modelId, modelName, normalizedApiKey, count, 1, normalizedBaseUrl, fastMode ? 1 : 0, now);

  console.log(`Added ${modelName} (${provider}/${modelId})`);
  console.log(`ID: ${id}  Priority: ${count}${fastMode ? "  FAST=on" : ""}`);
  db.close();
}

function modelsRemoveCmd(id: string) {
  if (!id) { console.error("Usage: dpc models remove <id>"); process.exit(1); }
  const db = getDb();
  const result = db.prepare("DELETE FROM models WHERE id = ?").run(id);
  console.log(result.changes > 0 ? `Removed model ${id}` : `Model ${id} not found`);
  db.close();
}

function modelsSetPriorityCmd(id: string, priority: string) {
  if (!id || !priority) { console.error("Usage: dpc models set-priority <id> <priority>"); process.exit(1); }
  const db = getDb();
  db.prepare("UPDATE models SET priority = ? WHERE id = ?").run(parseInt(priority, 10), id);
  console.log(`Set priority of ${id} to ${priority}`);
  db.close();
}

async function modelsProbeCmd(target?: string) {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM models WHERE is_active = 1 ORDER BY priority DESC").all() as Array<{
    id: string;
    provider: string;
    model_id: string;
    name: string;
    api_key: string;
    base_url: string | null;
  }>;
  db.close();

  if (rows.length === 0) {
    console.log("No active models configured.");
    return;
  }

  const targetProvider = target ? normalizeProviderId(target) : null;
  const filtered = target
    ? rows.filter((row) => row.id === target || row.provider === target || row.provider === targetProvider)
    : rows;

  if (filtered.length === 0) {
    console.log(`No active model matched target: ${target}`);
    return;
  }

  console.log(`Probing ${filtered.length} model(s):\n`);
  let okCount = 0;

  for (const row of filtered) {
    const provider = normalizeProviderId(row.provider) ?? row.provider;
    const auth = resolveModelApiKey({ provider, storedApiKey: row.api_key });
    const baseUrl = normalizeProviderBaseUrl(provider, row.base_url);
    const label = `[${row.id}] ${provider}/${row.model_id}`;
    const support = checkModelToolSupport(provider, row.model_id);

    if (providerRequiresApiKey(provider) && !auth.apiKey) {
      console.log(`  [FAIL] ${label}  missing API key (source=${auth.source})`);
      continue;
    }
    if (support.status === "unsupported") {
      console.log(`  [FAIL] ${label}  model is not tool-capable (${support.reason})`);
      continue;
    }
    if (support.status === "unknown") {
      console.log(`  [WARN] ${label}  unknown tool support (${support.reason})`);
    }

    const started = Date.now();
    try {
      const result = await callModel({
        provider: provider as Parameters<typeof callModel>[0]["provider"],
        modelId: row.model_id,
        apiKey: auth.apiKey,
        baseUrl: baseUrl ?? undefined,
        systemPrompt: "You are a connectivity probe. Reply with only PONG.",
        userMessage: "Reply with only PONG.",
        // Gemini 3 Flash can spend a significant share of low token budgets on thinking.
        // Keep probe budget high enough to get a visible one-token reply reliably.
        maxTokens: 120,
      });
      const ms = Date.now() - started;
      const response = result.response.trim();
      const isOk = /^pong\b/i.test(response);
      if (isOk) {
        okCount += 1;
        console.log(`  [OK]   ${label}  ${ms}ms  tokens=${result.tokensUsed}`);
      } else {
        console.log(`  [WARN] ${label}  ${ms}ms  unexpected reply: ${JSON.stringify(response.slice(0, 80))}`);
      }
    } catch (error) {
      const ms = Date.now() - started;
      console.log(`  [FAIL] ${label}  ${ms}ms  ${String(error)}`);
    }
  }

  console.log(`\nProbe summary: ${okCount}/${filtered.length} successful`);
}

async function modelsProbeToolsCmd(target?: string) {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM models WHERE is_active = 1 ORDER BY priority DESC").all() as Array<{
    id: string;
    provider: string;
    model_id: string;
    name: string;
    api_key: string;
    base_url: string | null;
  }>;
  db.close();

  if (rows.length === 0) {
    console.log("No active models configured.");
    return;
  }

  const targetProvider = target ? normalizeProviderId(target) : null;
  const filtered = target
    ? rows.filter((row) => row.id === target || row.provider === target || row.provider === targetProvider)
    : rows;

  if (filtered.length === 0) {
    console.log(`No active model matched target: ${target}`);
    return;
  }

  console.log(`Tool-use probing ${filtered.length} model(s):\n`);
  let okCount = 0;

  for (const row of filtered) {
    const provider = normalizeProviderId(row.provider) ?? row.provider;
    const auth = resolveModelApiKey({ provider, storedApiKey: row.api_key });
    const baseUrl = normalizeProviderBaseUrl(provider, row.base_url);
    const label = `[${row.id}] ${provider}/${row.model_id}`;

    if (providerRequiresApiKey(provider) && !auth.apiKey) {
      console.log(`  [FAIL] ${label}  missing API key (source=${auth.source})`);
      continue;
    }

    const started = Date.now();
    try {
      const result = await callWithTools({
        provider,
        modelId: row.model_id,
        apiKey: auth.apiKey,
        baseUrl: baseUrl ?? undefined,
        systemPrompt:
          "You are a tool-use connectivity probe. You must call system_info exactly once, then reply with only: PONG TOOL_OK",
        userMessage: "Run the tool-use probe now.",
        maxTokens: 120,
        tools: [TOOL_CATALOG.system_info],
        maxToolCalls: 3,
      });

      const ms = Date.now() - started;
      const response = result.response.trim();
      const usedTool = result.toolsUsed.includes("system_info");
      const repliedPong = /^pong\b/i.test(response);

      if (usedTool && repliedPong) {
        okCount += 1;
        console.log(`  [OK]   ${label}  ${ms}ms  tool=system_info  tokens=${result.tokensUsed}`);
      } else {
        const flags = `tool=${usedTool ? "yes" : "no"} pong=${repliedPong ? "yes" : "no"}`;
        console.log(`  [WARN] ${label}  ${ms}ms  ${flags}  reply=${JSON.stringify(response.slice(0, 80))}`);
      }
    } catch (error) {
      const ms = Date.now() - started;
      console.log(`  [FAIL] ${label}  ${ms}ms  ${String(error)}`);
    }
  }

  console.log(`\nTool-use probe summary: ${okCount}/${filtered.length} successful`);
}

function memoryTierCmd() {
  // Tier system removed — system now auto-selects the best provider.
  console.log("Memory tiers are no longer used.");
  console.log("The system now automatically selects the best search strategy:");
  console.log("  - Hybrid BM25 + vector search when an embedding model is available");
  console.log("  - FTS5-only search as fallback when no embedding model is configured");
  console.log("");
  console.log("To check which mode is active: dpc memory embedding-status");
  console.log("To configure embedding model:  dpc config set embedding_model text-embedding-3-small");
}

function memoryStatsCmd() {
  const db = getDb();
  const row = db.prepare("SELECT * FROM memory_config WHERE id = 'default'").get() as {
    tier: string; auto_threshold: number; total_memories: number; storage_bytes: number;
  };

  const atomicFiles = fs.existsSync(MEMORY_PATH)
    ? fs.readdirSync(MEMORY_PATH).filter((f) => f.endsWith(".md"))
    : [];

  const workspaceFiles: string[] = [];
  const mainMemory = path.join(WORKSPACE_PATH, "MEMORY.md");
  if (fs.existsSync(mainMemory)) workspaceFiles.push("MEMORY.md");
  if (fs.existsSync(WORKSPACE_MEMORY_PATH)) {
    for (const f of fs.readdirSync(WORKSPACE_MEMORY_PATH)) {
      if (f.endsWith(".md")) workspaceFiles.push(`memory/${f}`);
    }
  }

  let atomicBytes = 0;
  for (const f of atomicFiles) {
    atomicBytes += fs.statSync(path.join(MEMORY_PATH, f)).size;
  }
  let workspaceBytes = 0;
  for (const rel of workspaceFiles) {
    const abs = path.join(WORKSPACE_PATH, rel);
    if (fs.existsSync(abs)) workspaceBytes += fs.statSync(abs).size;
  }

  // Count cached embeddings.
  let embeddingCount = 0;
  let embeddingModel = "none";
  let sessionChunks = 0;
  try {
    const embRow = db.prepare("SELECT COUNT(*) AS n FROM memory_embeddings").get() as { n: number } | undefined;
    embeddingCount = embRow?.n ?? 0;
    const cfgRow = db.prepare("SELECT embedding_model FROM memory_config WHERE id = 'default'").get() as { embedding_model?: string } | undefined;
    embeddingModel = cfgRow?.embedding_model ?? "auto";
    const scRow = db.prepare("SELECT COUNT(*) AS n FROM session_chunks").get() as { n: number } | undefined;
    sessionChunks = scRow?.n ?? 0;
  } catch {
    // Tables may not exist on older DBs — non-fatal.
  }

  console.log(`Memory stats:`);
  console.log(`  Provider:   unified (hybrid BM25 + vector)`);
  console.log(`  Atomic:     ${atomicFiles.length} entries`);
  console.log(`  Workspace:  ${workspaceFiles.length} files`);
  console.log(`  Storage:    ${((atomicBytes + workspaceBytes) / 1024).toFixed(1)} KB`);
  console.log(`  Embedding:  ${embeddingModel} (${embeddingCount} cached)`);
  console.log(`  Sessions:   ${sessionChunks} indexed chunks`);
  db.close();
}

function memoryListCmd() {
  const atomicFiles = fs.existsSync(MEMORY_PATH)
    ? fs.readdirSync(MEMORY_PATH).filter((f) => f.endsWith(".md"))
    : [];
  const workspaceFiles: string[] = [];
  if (fs.existsSync(path.join(WORKSPACE_PATH, "MEMORY.md"))) {
    workspaceFiles.push("MEMORY.md");
  }
  if (fs.existsSync(WORKSPACE_MEMORY_PATH)) {
    for (const f of fs.readdirSync(WORKSPACE_MEMORY_PATH).filter((x) => x.endsWith(".md")).sort()) {
      workspaceFiles.push(`memory/${f}`);
    }
  }

  if (atomicFiles.length === 0 && workspaceFiles.length === 0) {
    console.log("No memories.");
    return;
  }

  console.log(`Atomic memories (${atomicFiles.length}):\n`);
  for (const f of atomicFiles) {
    const raw = fs.readFileSync(path.join(MEMORY_PATH, f), "utf-8");
    const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!match) continue;
    const body = match[2].trim();
    const meta: Record<string, string> = {};
    for (const line of match[1].split("\n")) {
      const i = line.indexOf(": ");
      if (i > -1) meta[line.slice(0, i)] = line.slice(i + 2);
    }
    const id = meta.id || f.replace(".md", "");
    const type = meta.type || "unknown";
    const preview = body.length > 80 ? body.slice(0, 80) + "..." : body;
    console.log(`  [${id}] (${type}) ${preview}`);
  }

  console.log(`\nWorkspace memory files (${workspaceFiles.length}):\n`);
  for (const rel of workspaceFiles) {
    const abs = path.join(WORKSPACE_PATH, rel);
    const raw = fs.readFileSync(abs, "utf-8");
    const lines = raw.split(/\r?\n/);
    const preview = lines.find((line) => line.trim() && !line.trim().startsWith("#")) || lines[0] || "";
    const short = preview.length > 90 ? preview.slice(0, 90) + "..." : preview;
    console.log(`  ${rel}: ${short}`);
  }
}

function memorySearchCmd(query: string) {
  if (!query) { console.error("Usage: dpc memory search <query>"); process.exit(1); }

  const lower = query.toLowerCase();
  const results: string[] = [];

  if (fs.existsSync(MEMORY_PATH)) {
    for (const f of fs.readdirSync(MEMORY_PATH).filter((x) => x.endsWith(".md"))) {
      const raw = fs.readFileSync(path.join(MEMORY_PATH, f), "utf-8");
      if (!raw.toLowerCase().includes(lower)) continue;
      const match = raw.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
      const body = match ? match[1].trim() : raw;
      const preview = body.length > 100 ? body.slice(0, 100) + "..." : body;
      results.push(`  [atomic] ${f.replace(".md", "")}: ${preview}`);
    }
  }

  const workspaceTargets: string[] = [];
  const mainMemory = path.join(WORKSPACE_PATH, "MEMORY.md");
  if (fs.existsSync(mainMemory)) workspaceTargets.push(mainMemory);
  if (fs.existsSync(WORKSPACE_MEMORY_PATH)) {
    for (const f of fs.readdirSync(WORKSPACE_MEMORY_PATH).filter((x) => x.endsWith(".md"))) {
      workspaceTargets.push(path.join(WORKSPACE_MEMORY_PATH, f));
    }
  }

  for (const abs of workspaceTargets) {
    const raw = fs.readFileSync(abs, "utf-8");
    if (!raw.toLowerCase().includes(lower)) continue;
    const rel = path.relative(WORKSPACE_PATH, abs).replace(/\\/g, "/");
    const line = raw.split(/\r?\n/).find((l) => l.toLowerCase().includes(lower)) || raw.split(/\r?\n/)[0] || "";
    const preview = line.length > 120 ? line.slice(0, 120) + "..." : line;
    results.push(`  [workspace] ${rel}: ${preview}`);
  }

  console.log(`Found ${results.length} memories matching "${query}":\n`);
  results.forEach((r) => console.log(r));
}

function memoryClearCmd() {
  const atomicFiles = fs.existsSync(MEMORY_PATH) ? fs.readdirSync(MEMORY_PATH).filter((f) => f.endsWith(".md")) : [];
  for (const f of atomicFiles) fs.unlinkSync(path.join(MEMORY_PATH, f));

  let workspaceCleared = 0;
  if (fs.existsSync(WORKSPACE_MEMORY_PATH)) {
    const daily = fs.readdirSync(WORKSPACE_MEMORY_PATH).filter((f) => f.endsWith(".md"));
    for (const f of daily) {
      fs.unlinkSync(path.join(WORKSPACE_MEMORY_PATH, f));
      workspaceCleared += 1;
    }
  }
  const mainMemory = path.join(WORKSPACE_PATH, "MEMORY.md");
  if (fs.existsSync(mainMemory)) {
    fs.writeFileSync(mainMemory, "# MEMORY\n\nCurated durable memory: decisions, preferences, and stable facts.\n", "utf-8");
    workspaceCleared += 1;
  }

  const db = getDb();
  db.prepare("UPDATE memory_config SET total_memories = 0, storage_bytes = 0, updated_at = ? WHERE id = 'default'")
    .run(new Date().toISOString());
  try { db.exec("DELETE FROM memories_fts"); } catch { /* ok */ }
  try { db.exec("DELETE FROM memory_embeddings"); } catch { /* ok */ }
  try { db.exec("DELETE FROM memories_collection_fts"); } catch { /* ok */ }
  try { db.exec("DELETE FROM collection_chunk_embeddings"); } catch { /* ok */ }
  try { db.exec("DELETE FROM collection_chunks"); } catch { /* ok */ }
  try { db.exec("DELETE FROM collection_files"); } catch { /* ok */ }
  db.close();

  console.log(`Cleared ${atomicFiles.length} atomic memories and ${workspaceCleared} workspace memory files.`);
}

function memoryEmbeddingStatusCmd() {
  const db = getDb();
  try {
    const cfgRow = db.prepare("SELECT embedding_model, vector_weight, text_weight, index_sessions FROM memory_config WHERE id = 'default'")
      .get() as { embedding_model?: string; vector_weight?: number; text_weight?: number; index_sessions?: number } | undefined;

    const configured = cfgRow?.embedding_model ?? "auto";
    const vectorW = cfgRow?.vector_weight ?? 0.7;
    const textW = cfgRow?.text_weight ?? 0.3;
    const sessionIndex = (cfgRow?.index_sessions ?? 1) !== 0;

    let cachedCount = 0;
    let sessionChunks = 0;
    let collectionChunks = 0;
    try {
      const embRow = db.prepare("SELECT COUNT(*) AS n FROM memory_embeddings").get() as { n: number };
      cachedCount = embRow.n ?? 0;
      const scRow = db.prepare("SELECT COUNT(*) AS n FROM session_chunks").get() as { n: number };
      sessionChunks = scRow.n ?? 0;
      const ccRow = db.prepare("SELECT COUNT(*) AS n FROM collection_chunks").get() as { n: number };
      collectionChunks = ccRow.n ?? 0;
    } catch { /* tables may not exist yet */ }

    // Try to detect available embedding model from models table.
    const models = db.prepare("SELECT model_id, provider FROM models WHERE is_active = 1 ORDER BY priority DESC").all() as Array<{ model_id: string; provider: string }>;
    const embPrefixes = ["text-embedding-3", "text-embedding-ada", "nomic-embed", "mxbai-embed", "all-minilm", "bge-", "e5-"];
    const detected = models.find((m) => embPrefixes.some((p) => m.model_id.toLowerCase().includes(p)));

    console.log(`Embedding status:`);
    console.log(`  Configured:     ${configured}`);
    console.log(`  Detected model: ${detected ? `${detected.model_id} (${detected.provider})` : "none"}`);
    console.log(`  Mode:           ${detected ? "hybrid (BM25 + vector)" : "fts5-only"}`);
    console.log(`  Vector weight:  ${vectorW}`);
    console.log(`  Text weight:    ${textW}`);
    console.log(`  Cached vectors: ${cachedCount}`);
    console.log(`  Session index:  ${sessionIndex ? "enabled" : "disabled"} (${sessionChunks} chunks)`);
    console.log(`  Collection chunks: ${collectionChunks}`);
    if (!detected) {
      console.log(`\n  No embedding model detected. Add one to enable hybrid search:`);
      console.log(`  dpc models add openai <key> --model text-embedding-3-small`);
      console.log(`  dpc models add ollama http://localhost:11434 --model nomic-embed-text`);
    }
  } catch (err) {
    console.error(`Failed to read embedding status: ${String(err)}`);
  }
  db.close();
}

async function memoryIndexCollectionsCmd() {
  const port = process.env.PORT ?? "3100";
  try {
    const res = await fetch(`http://localhost:${port}/api/memory?action=index-collections`);
    const data = await res.json() as { success: boolean; data?: { indexed: number }; error?: string };
    if (!data.success) {
      console.error(`Failed: ${data.error ?? "unknown error"}`);
      process.exit(1);
    }
    console.log(`Indexed ${data.data?.indexed ?? 0} collection chunks`);
  } catch (err) {
    console.error(`Request failed: ${String(err)}`);
    console.error("Make sure disp8ch is running (pnpm dev) before calling this command.");
    process.exit(1);
  }
}

async function memoryRebuildIndexCmd() {
  const db = getDb();

  const atomicFiles = fs.existsSync(MEMORY_PATH)
    ? fs.readdirSync(MEMORY_PATH).filter((f) => f.endsWith(".md"))
    : [];

  // Rebuild FTS5.
  console.log(`Rebuilding FTS5 index for ${atomicFiles.length} entries...`);
  try { db.exec("DELETE FROM memories_fts"); } catch { /* ok */ }

  let ftsCount = 0;
  for (const file of atomicFiles) {
    const raw = fs.readFileSync(path.join(MEMORY_PATH, file), "utf-8");
    const idMatch = raw.match(/^id:\s*(.+)$/m);
    const typeMatch = raw.match(/^type:\s*(.+)$/m);
    const tagsMatch = raw.match(/^tags:\s*\[(.*)]/m);
    const fmEnd = raw.indexOf("\n---\n", 4);
    const body = fmEnd !== -1 ? raw.slice(fmEnd + 5).trim() : "";
    const id = idMatch?.[1]?.trim() ?? file.replace(".md", "");
    const type = typeMatch?.[1]?.trim() ?? "fact";
    const tags = tagsMatch?.[1]?.trim() ?? "";
    try {
      db.prepare("INSERT OR REPLACE INTO memories_fts (id, content, tags, type) VALUES (?, ?, ?, ?)").run(id, body, tags, type);
      ftsCount++;
    } catch { /* ok */ }
  }
  console.log(`FTS5 rebuilt: ${ftsCount} entries indexed.`);

  // Rebuild embeddings if a model is available.
  const cfgRow = db.prepare("SELECT embedding_model FROM memory_config WHERE id = 'default'").get() as { embedding_model?: string } | undefined;
  const configured = cfgRow?.embedding_model ?? "auto";
  const embPrefixes = ["text-embedding-3", "text-embedding-ada", "nomic-embed", "mxbai-embed", "all-minilm", "bge-", "e5-"];
  const models = db.prepare("SELECT * FROM models WHERE is_active = 1 ORDER BY priority DESC").all() as Array<Record<string, unknown>>;
  const embModel = configured !== "disabled"
    ? (configured !== "auto" ? models.find((m) => (m.model_id as string) === configured) : models.find((m) => embPrefixes.some((p) => (m.model_id as string).toLowerCase().includes(p))))
    : null;

  if (!embModel) {
    console.log("No embedding model available — skipping vector index rebuild.");
    console.log("Run 'dpc memory embedding-status' to see how to configure one.");
    db.close();
    return;
  }

  console.log(`Generating embeddings using ${embModel.model_id as string}...`);
  db.prepare("DELETE FROM memory_embeddings").run();

  const { normalizeProviderBaseUrl: normBase } = await import("../src/lib/agents/provider-base-url");
  const { resolveModelApiKey: resolveKey } = await import("../src/lib/agents/provider-auth");
  const { normalizeProviderId: normProv } = await import("../src/lib/agents/provider-normalization");

  const provider = normProv(embModel.provider as string) ?? String(embModel.provider);
  const auth = resolveKey({ provider, storedApiKey: embModel.api_key as string });
  const baseUrl = normBase(provider, (embModel.base_url as string | undefined) || undefined);

  let embCount = 0;
  for (const file of atomicFiles) {
    const raw = fs.readFileSync(path.join(MEMORY_PATH, file), "utf-8");
    const idMatch = raw.match(/^id:\s*(.+)$/m);
    const hashMatch = raw.match(/^content_hash:\s*(.+)$/m);
    const fmEnd = raw.indexOf("\n---\n", 4);
    const body = fmEnd !== -1 ? raw.slice(fmEnd + 5).trim() : "";
    const id = idMatch?.[1]?.trim() ?? file.replace(".md", "");
    const hash = hashMatch?.[1]?.trim() ?? "";
    if (!body) continue;

    try {
      let embedding: number[] | null = null;
      if (provider === "ollama") {
        const ollamaBase = (baseUrl ?? "http://localhost:11434/v1").replace(/\/v1\/?$/i, "");
        const resp = await fetch(`${ollamaBase}/api/embed`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: embModel.model_id as string, input: body }),
        });
        const data = await resp.json() as { embeddings?: number[][] };
        embedding = data.embeddings?.[0] ?? null;
      } else {
        const base = (baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
        const resp = await fetch(`${base}/embeddings`, {
          method: "POST",
          headers: { Authorization: `Bearer ${auth.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: embModel.model_id as string, input: body }),
        });
        const data = await resp.json() as { data?: Array<{ embedding: number[] }> };
        embedding = data.data?.[0]?.embedding ?? null;
      }

      if (embedding) {
        db.prepare("INSERT OR REPLACE INTO memory_embeddings (id, content_hash, embedding, model_id, created_at) VALUES (?, ?, ?, ?, ?)")
          .run(id, hash, JSON.stringify(embedding), embModel.model_id as string, new Date().toISOString());
        embCount++;
      }
    } catch {
      // Non-fatal: skip this entry.
    }
  }

  console.log(`Embeddings generated: ${embCount}/${atomicFiles.length}.`);
  db.close();
}

async function memoryIndexSessionsCmd() {
  const db = getDb();

  const cfgRow = db.prepare("SELECT embedding_model FROM memory_config WHERE id = 'default'").get() as { embedding_model?: string } | undefined;
  const configured = cfgRow?.embedding_model ?? "auto";
  const embPrefixes = ["text-embedding-3", "text-embedding-ada", "nomic-embed", "mxbai-embed", "all-minilm", "bge-", "e5-"];
  const models = db.prepare("SELECT * FROM models WHERE is_active = 1 ORDER BY priority DESC").all() as Array<Record<string, unknown>>;
  const embModel = configured !== "disabled"
    ? (configured !== "auto" ? models.find((m) => (m.model_id as string) === configured) : models.find((m) => embPrefixes.some((p) => (m.model_id as string).toLowerCase().includes(p))))
    : null;

  if (!embModel) {
    console.error("No embedding model available. Configure one first:");
    console.error("  dpc models add openai <key> --model text-embedding-3-small");
    db.close();
    return;
  }

  const sessions = db.prepare("SELECT DISTINCT session_id FROM messages").all() as Array<{ session_id: string }>;
  console.log(`Indexing ${sessions.length} sessions with model ${embModel.model_id as string}...`);

  // Enable session indexing in config.
  db.prepare("UPDATE memory_config SET index_sessions = 1, updated_at = ? WHERE id = 'default'")
    .run(new Date().toISOString());

  db.close();

  // Re-use the API action via dynamic import.
  console.log("Session indexing initiated. Run the app and call GET /api/memory?action=index-sessions for progress.");
  console.log(`Sessions found: ${sessions.length}`);
}

function memoryBackfillCmd() {
  const atomicFiles = fs.existsSync(MEMORY_PATH)
    ? fs.readdirSync(MEMORY_PATH).filter((f) => f.endsWith(".md"))
    : [];

  const mainMemoryPath = path.join(WORKSPACE_PATH, "MEMORY.md");
  const existing = fs.existsSync(mainMemoryPath)
    ? fs.readFileSync(mainMemoryPath, "utf-8")
    : "# MEMORY\n\nCurated durable memory: decisions, preferences, and stable facts.\n\n";

  const durableTypes = new Set(["fact", "preference", "entity", "decision", "skill", "relationship", "correction", "profile", "knowledge", "behavior", "tool"]);
  let added = 0;
  const lines: string[] = [];

  for (const file of atomicFiles) {
    const raw = fs.readFileSync(path.join(MEMORY_PATH, file), "utf-8");
    const idMatch = raw.match(/^id:\s*(.+)$/m);
    const typeMatch = raw.match(/^type:\s*(.+)$/m);
    const sourceMatch = raw.match(/^source:\s*(.+)$/m);
    const tagsMatch = raw.match(/^tags:\s*\[(.*)]/m);
    const fmEnd = raw.indexOf("\n---\n", 4);
    const body = fmEnd !== -1 ? raw.slice(fmEnd + 5).trim() : "";

    const id = idMatch?.[1]?.trim() ?? file.replace(".md", "");
    const type = typeMatch?.[1]?.trim() ?? "fact";
    const source = sourceMatch?.[1]?.trim() ?? "unknown";
    const tags = tagsMatch?.[1]?.trim() ?? "";

    if (!durableTypes.has(type)) continue;
    if (existing.includes(`id=${id}`)) continue; // already in MEMORY.md

    const ts = new Date().toISOString();
    lines.push(`- [${ts}] id=${id} status=active type=${type} source=${source} tags=${tags} ${body}`);
    added++;
  }

  if (added > 0) {
    const updated = existing.trimEnd() + "\n\n" + lines.join("\n") + "\n";
    fs.mkdirSync(path.dirname(mainMemoryPath), { recursive: true });
    fs.writeFileSync(mainMemoryPath, updated, "utf-8");
    console.log(`Backfilled ${added} atomic entries into MEMORY.md.`);
  } else {
    console.log("Nothing to backfill — all durable entries are already in MEMORY.md.");
  }
}

function workflowsListCmd() {
  const db = getDb();
  const rows = db.prepare("SELECT id, name, description, is_active, created_at FROM workflows ORDER BY updated_at DESC").all() as Array<{
    id: string; name: string; description: string | null; is_active: number; created_at: string;
  }>;

  if (rows.length === 0) { console.log("No workflows. Create one: dpc workflows create \"My Workflow\""); return; }

  console.log(`${rows.length} workflows:\n`);
  for (const r of rows) {
    const status = r.is_active ? "active" : "inactive";
    console.log(`  [${r.id}] ${r.name} (${status})`);
    if (r.description) console.log(`         ${r.description}`);
  }
  db.close();
}

async function workflowsCreateCmd(name: string, template?: string) {
  if (!name) { console.error("Usage: dpc workflows create <name> [template]"); process.exit(1); }

  if (template) {
    try {
      const routeModule = await import("../src/app/api/workflows/route");
      const route = routeModule.default ?? routeModule;
      const req = new Request("http://localhost/api/workflows", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          template,
        }),
      });
      const res = await route.POST(req as never);
      const json = await res.json();
      if (!json?.success || !json?.data?.id) {
        console.error(`Failed to create workflow from template: ${template}`);
        if (json?.error) console.error(String(json.error));
        process.exit(1);
      }
      console.log(`Created workflow: ${name}`);
      console.log(`ID: ${json.data.id}`);
      console.log(`Template: ${template}`);
      return;
    } catch (error) {
      console.error(`Failed to create workflow from template: ${template}`);
      console.error(String(error));
      process.exit(1);
    }
  }

  const db = getDb();
  const id = nanoid(12);
  const now = new Date().toISOString();

  db.prepare(
    "INSERT INTO workflows (id, name, description, nodes, edges, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(id, name, null, JSON.stringify([]), JSON.stringify([]), 1, now, now);

  console.log(`Created workflow: ${name}`);
  console.log(`ID: ${id}`);
  db.close();
}

function workflowsDeleteCmd(id: string) {
  if (!id) { console.error("Usage: dpc workflows delete <id>"); process.exit(1); }
  const db = getDb();
  const result = db.prepare("DELETE FROM workflows WHERE id = ?").run(id);
  console.log(result.changes > 0 ? `Deleted workflow ${id}` : `Workflow ${id} not found`);
  db.close();
}

function readConfigSnapshot() {
  const db = getDb();
  try {
    const app = db.prepare("SELECT * FROM app_config WHERE id = 'default'").get() as Record<string, unknown>;
    const memory = db.prepare("SELECT * FROM memory_config WHERE id = 'default'").get() as Record<string, unknown> & {
      decay_enabled?: number;
      decay_half_life_days?: number;
      embedding_model?: string | null;
      vector_weight?: number;
      text_weight?: number;
      index_sessions?: number;
      session_chunk_tokens?: number;
      session_chunk_overlap?: number;
      startup_include_files?: string | null;
      max_snippet_chars?: number;
      max_injected_chars?: number;
      citations_mode?: string | null;
      extra_collection_paths?: string | null;
    };
    const modelCount = (db.prepare("SELECT COUNT(*) as c FROM models").get() as { c: number }).c;
    const workflowCount = (db.prepare("SELECT COUNT(*) as c FROM workflows").get() as { c: number }).c;
    return {
      app,
      memory,
      meta: {
        models: modelCount,
        workflows: workflowCount,
        databasePath: DB_PATH,
        memoryPath: MEMORY_PATH,
      },
    };
  } finally {
    db.close();
  }
}

function configShowCmd(jsonMode = false) {
  const snapshot = readConfigSnapshot();
  if (jsonMode) {
    console.log(JSON.stringify(snapshot, null, 2));
    return;
  }

  const { app, memory: mem, meta } = snapshot;
  const modelCount = meta.models;
  const wfCount = meta.workflows;
  const memoryPath = meta.memoryPath;
  const databasePath = meta.databasePath;
  const _typedMem = mem as Record<string, unknown> & {
    tier?: unknown;
    auto_threshold?: unknown;
    decay_enabled?: number;
    decay_half_life_days?: number;
    embedding_model?: string | null;
    vector_weight?: number;
    text_weight?: number;
    index_sessions?: number;
    session_chunk_tokens?: number;
    session_chunk_overlap?: number;
    startup_include_files?: string | null;
    max_snippet_chars?: number;
    max_injected_chars?: number;
    citations_mode?: string | null;
    extra_collection_paths?: string | null;
  };

  console.log("disp8ch configuration:\n");
  console.log(`  Onboarding done:  ${app.onboarding_done === 1 ? "yes" : "no"}`);
  console.log(`  Timezone:         ${app.timezone}`);
  console.log(`  Tool output:      ${app.tool_output_limit}`);
  console.log(`  Compaction mode:  ${app.compaction_mode}`);
  console.log(`  Compact at:       ${Math.round(Number(app.compaction_threshold ?? 0.75) * 100)}%`);
  console.log(`  Context window:   ${app.context_window}`);
  console.log(`  Pruning mode:     ${app.context_pruning_mode ?? "tool-results"}`);
  console.log(`  Protect turns:    ${app.context_pruning_keep_recent_assistants ?? 3}`);
  console.log(`  Retry attempts:   ${app.channel_retry_attempts}`);
  console.log(`  Retry delays:     ${app.channel_retry_min_delay_ms}..${app.channel_retry_max_delay_ms} ms`);
  console.log(`  Retry jitter:     ${app.channel_retry_jitter}`);
  console.log(`  ACP auth:         ${String(app.acp_auth_mode ?? "off")}${app.acp_auth_secret_name ? ` (secret ${String(app.acp_auth_secret_name)})` : ""}`);
  console.log(`  Telemetry:        ${Number(app.telemetry_enabled) === 1 ? "on" : "off"}`);
  console.log(`  Hooks:            ${Number(app.hooks_enabled) === 1 ? "on" : "off"}`);
  console.log(`  Memory flush:     ${Number(app.memory_flush_enabled) === 1 ? "on" : "off"}`);
  console.log(`  Rate limit:       webhooks=${app.rate_limit_webhooks ?? 30}/min  execute=${app.rate_limit_execute ?? 20}/min  channels=${app.rate_limit_channels ?? 60}/min`);
  console.log(`  Lane limits:      main=${app.lane_main_max_concurrent ?? 4}  cron=${app.lane_cron_max_concurrent ?? 1}  subflow=${app.lane_subflow_max_concurrent ?? 8}`);
  console.log(`  Log retention:    ${app.log_max_days ?? 7} days`);
  console.log(`  Memory tier:      ${_typedMem.tier}`);
  console.log(`  Auto threshold:   ${_typedMem.auto_threshold}`);
  console.log(`  Decay:            ${Number(_typedMem.decay_enabled) === 1 ? "on" : "off"}  half-life=${_typedMem.decay_half_life_days ?? 30} days`);
  console.log(`  Embedding model:  ${_typedMem.embedding_model ?? "auto"}`);
  console.log(`  Search weights:   vector=${_typedMem.vector_weight ?? 0.7}  text=${_typedMem.text_weight ?? 0.3}`);
  console.log(`  Index sessions:   ${Number(_typedMem.index_sessions) === 1 ? "on" : "off"}`);
  console.log(`  Session chunks:   tokens=${_typedMem.session_chunk_tokens ?? 400}  overlap=${_typedMem.session_chunk_overlap ?? 80}`);
  console.log(`  Startup files:    ${_typedMem.startup_include_files ?? "(default)"}`);
  console.log(`  Snippet caps:     per-snippet=${_typedMem.max_snippet_chars ?? 700}  injected=${_typedMem.max_injected_chars ?? 4000}`);
  console.log(`  Citations:        ${_typedMem.citations_mode ?? "on"}`);
  console.log(`  Collection paths: ${_typedMem.extra_collection_paths ?? "(none)"}`);
  console.log(`  Models:           ${modelCount}`);
  console.log(`  Workflows:        ${wfCount}`);
  console.log(`  Database:         ${databasePath}`);
  console.log(`  Memory path:      ${memoryPath}`);
}

function configGetCmd(key: string) {
  if (!key) { console.error("Usage: dpc config get <key>"); process.exit(1); }
  const db = getDb();
  const resolvedKey = resolveConfigKey(key);

  const configMap: Record<string, string> = {
    "onboarding": "SELECT onboarding_done as value FROM app_config WHERE id = 'default'",
    "timezone": "SELECT timezone as value FROM app_config WHERE id = 'default'",
    "tool.output_limit": "SELECT tool_output_limit as value FROM app_config WHERE id = 'default'",
    "compaction.mode": "SELECT compaction_mode as value FROM app_config WHERE id = 'default'",
    "compaction.threshold": "SELECT compaction_threshold as value FROM app_config WHERE id = 'default'",
    "compaction.context_window": "SELECT context_window as value FROM app_config WHERE id = 'default'",
    "pending_mutation.ttl_ms": "SELECT pending_mutation_ttl_ms as value FROM app_config WHERE id = 'default'",
    "context.pruning.mode": "SELECT context_pruning_mode as value FROM app_config WHERE id = 'default'",
    "context.pruning.keep_recent_assistants": "SELECT context_pruning_keep_recent_assistants as value FROM app_config WHERE id = 'default'",
    "context.pruning.min_tool_chars": "SELECT context_pruning_min_tool_chars as value FROM app_config WHERE id = 'default'",
    "context.pruning.max_tool_chars": "SELECT context_pruning_max_tool_chars as value FROM app_config WHERE id = 'default'",
    "context.pruning.head_chars": "SELECT context_pruning_head_chars as value FROM app_config WHERE id = 'default'",
    "context.pruning.tail_chars": "SELECT context_pruning_tail_chars as value FROM app_config WHERE id = 'default'",
    "retry.attempts": "SELECT channel_retry_attempts as value FROM app_config WHERE id = 'default'",
    "retry.min_delay_ms": "SELECT channel_retry_min_delay_ms as value FROM app_config WHERE id = 'default'",
    "retry.max_delay_ms": "SELECT channel_retry_max_delay_ms as value FROM app_config WHERE id = 'default'",
    "retry.jitter": "SELECT channel_retry_jitter as value FROM app_config WHERE id = 'default'",
    "provenance_mode": "SELECT provenance_mode as value FROM app_config WHERE id = 'default'",
    "acp_auth_mode": "SELECT acp_auth_mode as value FROM app_config WHERE id = 'default'",
    "acp_auth_secret_name": "SELECT acp_auth_secret_name as value FROM app_config WHERE id = 'default'",
    "telemetry.enabled": "SELECT telemetry_enabled as value FROM app_config WHERE id = 'default'",
    "hooks.enabled": "SELECT hooks_enabled as value FROM app_config WHERE id = 'default'",
    "memory.flush_enabled": "SELECT memory_flush_enabled as value FROM app_config WHERE id = 'default'",
    "ratelimit.webhooks": "SELECT rate_limit_webhooks as value FROM app_config WHERE id = 'default'",
    "ratelimit.execute": "SELECT rate_limit_execute as value FROM app_config WHERE id = 'default'",
    "ratelimit.channels": "SELECT rate_limit_channels as value FROM app_config WHERE id = 'default'",
    "lane.main.max_concurrent": "SELECT lane_main_max_concurrent as value FROM app_config WHERE id = 'default'",
    "lane.cron.max_concurrent": "SELECT lane_cron_max_concurrent as value FROM app_config WHERE id = 'default'",
    "lane.subflow.max_concurrent": "SELECT lane_subflow_max_concurrent as value FROM app_config WHERE id = 'default'",
    "log.max_days": "SELECT log_max_days as value FROM app_config WHERE id = 'default'",
    "memory.tier": "SELECT tier as value FROM memory_config WHERE id = 'default'",
    "memory.threshold": "SELECT auto_threshold as value FROM memory_config WHERE id = 'default'",
    "memory.decay.enabled": "SELECT decay_enabled as value FROM memory_config WHERE id = 'default'",
    "memory.decay.half_life_days": "SELECT decay_half_life_days as value FROM memory_config WHERE id = 'default'",
    "memory.embedding_model": "SELECT embedding_model as value FROM memory_config WHERE id = 'default'",
    "memory.vector_weight": "SELECT vector_weight as value FROM memory_config WHERE id = 'default'",
    "memory.text_weight": "SELECT text_weight as value FROM memory_config WHERE id = 'default'",
    "memory.index_sessions": "SELECT index_sessions as value FROM memory_config WHERE id = 'default'",
    "memory.session_chunk_tokens": "SELECT session_chunk_tokens as value FROM memory_config WHERE id = 'default'",
    "memory.session_chunk_overlap": "SELECT session_chunk_overlap as value FROM memory_config WHERE id = 'default'",
    "memory.startup_include_files": "SELECT startup_include_files as value FROM memory_config WHERE id = 'default'",
    "memory.max_snippet_chars": "SELECT max_snippet_chars as value FROM memory_config WHERE id = 'default'",
    "memory.max_injected_chars": "SELECT max_injected_chars as value FROM memory_config WHERE id = 'default'",
    "memory.citations_mode": "SELECT citations_mode as value FROM memory_config WHERE id = 'default'",
    "memory.extra_collection_paths": "SELECT extra_collection_paths as value FROM memory_config WHERE id = 'default'",
    "memory.search_backend": "SELECT search_backend as value FROM memory_config WHERE id = 'default'",
    "memory.rerank_strategy": "SELECT rerank_strategy as value FROM memory_config WHERE id = 'default'",
    "memory.query_expansion_enabled": "SELECT query_expansion_enabled as value FROM memory_config WHERE id = 'default'",
    "memory.strong_signal_enabled": "SELECT strong_signal_enabled as value FROM memory_config WHERE id = 'default'",
    "memory.rerank_candidate_limit": "SELECT rerank_candidate_limit as value FROM memory_config WHERE id = 'default'",
  };

  const query = configMap[resolvedKey];
  if (!query) {
    console.error(`Unknown key: ${key}`);
    console.error(`Valid keys: ${Object.keys(configMap).join(", ")}`);
    process.exit(1);
  }

  const row = db.prepare(query).get() as { value: unknown };
  console.log(String(row.value));
  db.close();
}

function configSetCmd(key: string, value: string) {
  if (!key || value === undefined) { console.error("Usage: dpc config set <key> <value>"); process.exit(1); }
  const db = getDb();
  const now = new Date().toISOString();
  const resolvedKey = resolveConfigKey(key);

  const setters: Record<string, () => void> = {
    "onboarding": () => db.prepare("UPDATE app_config SET onboarding_done = ?, updated_at = ? WHERE id = 'default'").run(parseBooleanConfigValue(value, "onboarding"), now),
    "timezone": () => db.prepare("UPDATE app_config SET timezone = ?, updated_at = ? WHERE id = 'default'").run(value, now),
    "tool.output_limit": () => {
      const n = parseIntConfigValue(value, "tool.output_limit", 1000, 500000);
      db.prepare("UPDATE app_config SET tool_output_limit = ?, updated_at = ? WHERE id = 'default'").run(n, now);
    },
    "compaction.mode": () => {
      if (!["off", "summarize", "drop"].includes(value)) {
        console.error("Valid compaction.mode values: off, summarize, drop");
        process.exit(1);
      }
      db.prepare("UPDATE app_config SET compaction_mode = ?, updated_at = ? WHERE id = 'default'").run(value, now);
    },
    "compaction.threshold": () => {
      const n = parseNumberConfigValue(value, "compaction.threshold", 0.1, 0.95);
      db.prepare("UPDATE app_config SET compaction_threshold = ?, updated_at = ? WHERE id = 'default'").run(n, now);
    },
    "compaction.context_window": () => {
      const n = parseIntConfigValue(value, "compaction.context_window", 1000);
      db.prepare("UPDATE app_config SET context_window = ?, updated_at = ? WHERE id = 'default'").run(n, now);
    },
    "pending_mutation.ttl_ms": () => {
      const n = parseIntConfigValue(value, "pending_mutation.ttl_ms", 1000, 86400000);
      db.prepare("UPDATE app_config SET pending_mutation_ttl_ms = ?, updated_at = ? WHERE id = 'default'").run(n, now);
    },
    "context.pruning.mode": () => {
      if (!["off", "tool-results"].includes(value)) {
        console.error("Valid context.pruning.mode values: off, tool-results");
        process.exit(1);
      }
      db.prepare("UPDATE app_config SET context_pruning_mode = ?, updated_at = ? WHERE id = 'default'").run(value, now);
    },
    "context.pruning.keep_recent_assistants": () => {
      const n = parseIntConfigValue(value, "context.pruning.keep_recent_assistants", 1, 12);
      db.prepare("UPDATE app_config SET context_pruning_keep_recent_assistants = ?, updated_at = ? WHERE id = 'default'").run(n, now);
    },
    "context.pruning.min_tool_chars": () => {
      const n = parseIntConfigValue(value, "context.pruning.min_tool_chars", 1000, 200000);
      db.prepare("UPDATE app_config SET context_pruning_min_tool_chars = ?, updated_at = ? WHERE id = 'default'").run(n, now);
    },
    "context.pruning.max_tool_chars": () => {
      const n = parseIntConfigValue(value, "context.pruning.max_tool_chars", 500, 20000);
      db.prepare("UPDATE app_config SET context_pruning_max_tool_chars = ?, updated_at = ? WHERE id = 'default'").run(n, now);
    },
    "context.pruning.head_chars": () => {
      const n = parseIntConfigValue(value, "context.pruning.head_chars", 100, 10000);
      db.prepare("UPDATE app_config SET context_pruning_head_chars = ?, updated_at = ? WHERE id = 'default'").run(n, now);
    },
    "context.pruning.tail_chars": () => {
      const n = parseIntConfigValue(value, "context.pruning.tail_chars", 100, 10000);
      db.prepare("UPDATE app_config SET context_pruning_tail_chars = ?, updated_at = ? WHERE id = 'default'").run(n, now);
    },
    "retry.attempts": () => {
      const n = parseIntConfigValue(value, "retry.attempts", 1, 10);
      db.prepare("UPDATE app_config SET channel_retry_attempts = ?, updated_at = ? WHERE id = 'default'").run(n, now);
    },
    "retry.min_delay_ms": () => {
      const n = parseIntConfigValue(value, "retry.min_delay_ms", 10, 10000);
      db.prepare("UPDATE app_config SET channel_retry_min_delay_ms = ?, updated_at = ? WHERE id = 'default'").run(n, now);
    },
    "retry.max_delay_ms": () => {
      const n = parseIntConfigValue(value, "retry.max_delay_ms", 100, 120000);
      db.prepare("UPDATE app_config SET channel_retry_max_delay_ms = ?, updated_at = ? WHERE id = 'default'").run(n, now);
    },
    "retry.jitter": () => {
      const n = parseNumberConfigValue(value, "retry.jitter", 0, 0.5);
      db.prepare("UPDATE app_config SET channel_retry_jitter = ?, updated_at = ? WHERE id = 'default'").run(n, now);
    },
    "provenance_mode": () => {
      if (!["off", "meta", "meta+receipt"].includes(value)) {
        console.error("Valid provenance_mode values: off, meta, meta+receipt");
        process.exit(1);
      }
      db.prepare("UPDATE app_config SET provenance_mode = ?, updated_at = ? WHERE id = 'default'").run(value, now);
    },
    "acp_auth_mode": () => {
      if (!["off", "bearer"].includes(value)) {
        console.error("Valid acp_auth_mode values: off, bearer");
        process.exit(1);
      }
      db.prepare("UPDATE app_config SET acp_auth_mode = ?, updated_at = ? WHERE id = 'default'").run(value, now);
    },
    "acp_auth_secret_name": () => {
      const next = value.trim().toUpperCase();
      db.prepare("UPDATE app_config SET acp_auth_secret_name = ?, updated_at = ? WHERE id = 'default'").run(next || null, now);
    },
    "telemetry.enabled": () => db.prepare("UPDATE app_config SET telemetry_enabled = ?, updated_at = ? WHERE id = 'default'").run(parseBooleanConfigValue(value, "telemetry.enabled"), now),
    "hooks.enabled": () => db.prepare("UPDATE app_config SET hooks_enabled = ?, updated_at = ? WHERE id = 'default'").run(parseBooleanConfigValue(value, "hooks.enabled"), now),
    "memory.flush_enabled": () => db.prepare("UPDATE app_config SET memory_flush_enabled = ?, updated_at = ? WHERE id = 'default'").run(parseBooleanConfigValue(value, "memory.flush_enabled"), now),
    "ratelimit.webhooks": () => {
      const n = parseIntConfigValue(value, "ratelimit.webhooks", 1, 1000);
      db.prepare("UPDATE app_config SET rate_limit_webhooks = ?, updated_at = ? WHERE id = 'default'").run(n, now);
    },
    "ratelimit.execute": () => {
      const n = parseIntConfigValue(value, "ratelimit.execute", 1, 1000);
      db.prepare("UPDATE app_config SET rate_limit_execute = ?, updated_at = ? WHERE id = 'default'").run(n, now);
    },
    "ratelimit.channels": () => {
      const n = parseIntConfigValue(value, "ratelimit.channels", 1, 1000);
      db.prepare("UPDATE app_config SET rate_limit_channels = ?, updated_at = ? WHERE id = 'default'").run(n, now);
    },
    "lane.main.max_concurrent": () => {
      const n = parseIntConfigValue(value, "lane.main.max_concurrent", 1, 32);
      db.prepare("UPDATE app_config SET lane_main_max_concurrent = ?, updated_at = ? WHERE id = 'default'").run(n, now);
    },
    "lane.cron.max_concurrent": () => {
      const n = parseIntConfigValue(value, "lane.cron.max_concurrent", 1, 16);
      db.prepare("UPDATE app_config SET lane_cron_max_concurrent = ?, updated_at = ? WHERE id = 'default'").run(n, now);
    },
    "lane.subflow.max_concurrent": () => {
      const n = parseIntConfigValue(value, "lane.subflow.max_concurrent", 1, 64);
      db.prepare("UPDATE app_config SET lane_subflow_max_concurrent = ?, updated_at = ? WHERE id = 'default'").run(n, now);
    },
    "log.max_days": () => {
      const n = parseIntConfigValue(value, "log.max_days", 1, 365);
      db.prepare("UPDATE app_config SET log_max_days = ?, updated_at = ? WHERE id = 'default'").run(n, now);
    },
    "memory.tier": () => {
      if (!["simple", "thorough", "auto"].includes(value)) { console.error("Valid tiers: simple, thorough, auto"); process.exit(1); }
      db.prepare("UPDATE memory_config SET tier = ?, updated_at = ? WHERE id = 'default'").run(value, now);
    },
    "memory.threshold": () => db.prepare("UPDATE memory_config SET auto_threshold = ?, updated_at = ? WHERE id = 'default'").run(parseIntConfigValue(value, "memory.threshold", 0), now),
    "memory.decay.enabled": () => db.prepare("UPDATE memory_config SET decay_enabled = ?, updated_at = ? WHERE id = 'default'").run(parseBooleanConfigValue(value, "memory.decay.enabled"), now),
    "memory.decay.half_life_days": () => {
      const n = parseIntConfigValue(value, "memory.decay.half_life_days", 1, 365);
      db.prepare("UPDATE memory_config SET decay_half_life_days = ?, updated_at = ? WHERE id = 'default'").run(n, now);
    },
    "memory.embedding_model": () => {
      const next = value.trim();
      if (!next || next.length > 200) {
        console.error("memory.embedding_model must be a non-empty string up to 200 chars");
        process.exit(1);
      }
      db.prepare("UPDATE memory_config SET embedding_model = ?, updated_at = ? WHERE id = 'default'").run(next, now);
    },
    "memory.vector_weight": () => {
      const n = parseNumberConfigValue(value, "memory.vector_weight", 0, 1);
      db.prepare("UPDATE memory_config SET vector_weight = ?, updated_at = ? WHERE id = 'default'").run(n, now);
    },
    "memory.text_weight": () => {
      const n = parseNumberConfigValue(value, "memory.text_weight", 0, 1);
      db.prepare("UPDATE memory_config SET text_weight = ?, updated_at = ? WHERE id = 'default'").run(n, now);
    },
    "memory.index_sessions": () => {
      const next = parseBooleanConfigValue(value, "memory.index_sessions");
      db.prepare("UPDATE memory_config SET index_sessions = ?, updated_at = ? WHERE id = 'default'").run(next, now);
    },
    "memory.session_chunk_tokens": () => {
      const n = parseIntConfigValue(value, "memory.session_chunk_tokens", 50, 4000);
      db.prepare("UPDATE memory_config SET session_chunk_tokens = ?, updated_at = ? WHERE id = 'default'").run(n, now);
    },
    "memory.session_chunk_overlap": () => {
      const n = parseIntConfigValue(value, "memory.session_chunk_overlap", 0, 500);
      db.prepare("UPDATE memory_config SET session_chunk_overlap = ?, updated_at = ? WHERE id = 'default'").run(n, now);
    },
    "memory.startup_include_files": () => {
      const next = parseNullableListConfigValue(value);
      db.prepare("UPDATE memory_config SET startup_include_files = ?, updated_at = ? WHERE id = 'default'").run(next, now);
    },
    "memory.max_snippet_chars": () => {
      const n = parseIntConfigValue(value, "memory.max_snippet_chars", 100, 5000);
      db.prepare("UPDATE memory_config SET max_snippet_chars = ?, updated_at = ? WHERE id = 'default'").run(n, now);
    },
    "memory.max_injected_chars": () => {
      const n = parseIntConfigValue(value, "memory.max_injected_chars", 500, 20000);
      db.prepare("UPDATE memory_config SET max_injected_chars = ?, updated_at = ? WHERE id = 'default'").run(n, now);
    },
    "memory.citations_mode": () => {
      if (!["on", "off", "auto"].includes(value)) {
        console.error("Valid memory.citations_mode values: on, off, auto");
        process.exit(1);
      }
      db.prepare("UPDATE memory_config SET citations_mode = ?, updated_at = ? WHERE id = 'default'").run(value, now);
    },
    "memory.extra_collection_paths": () => {
      const next = parseNullableListConfigValue(value);
      db.prepare("UPDATE memory_config SET extra_collection_paths = ?, updated_at = ? WHERE id = 'default'").run(next, now);
    },
    "memory.search_backend": () => {
      if (!["builtin", "qmd-like"].includes(value)) {
        console.error("Valid memory.search_backend values: builtin, qmd-like");
        process.exit(1);
      }
      db.prepare("UPDATE memory_config SET search_backend = ?, updated_at = ? WHERE id = 'default'").run(value, now);
    },
    "memory.rerank_strategy": () => {
      if (!["auto", "mmr", "local", "model", "off"].includes(value)) {
        console.error("Valid memory.rerank_strategy values: auto, mmr, local, model, off");
        process.exit(1);
      }
      db.prepare("UPDATE memory_config SET rerank_strategy = ?, updated_at = ? WHERE id = 'default'").run(value, now);
    },
    "memory.query_expansion_enabled": () => {
      const next = parseBooleanConfigValue(value, "memory.query_expansion_enabled");
      db.prepare("UPDATE memory_config SET query_expansion_enabled = ?, updated_at = ? WHERE id = 'default'").run(next, now);
    },
    "memory.strong_signal_enabled": () => {
      const next = parseBooleanConfigValue(value, "memory.strong_signal_enabled");
      db.prepare("UPDATE memory_config SET strong_signal_enabled = ?, updated_at = ? WHERE id = 'default'").run(next, now);
    },
    "memory.rerank_candidate_limit": () => {
      const n = parseIntConfigValue(value, "memory.rerank_candidate_limit", 5, 80);
      db.prepare("UPDATE memory_config SET rerank_candidate_limit = ?, updated_at = ? WHERE id = 'default'").run(n, now);
    },
  };

  const setter = setters[resolvedKey];
  if (!setter) {
    console.error(`Unknown key: ${key}`);
    console.error(`Valid keys: ${Object.keys(setters).join(", ")}`);
    process.exit(1);
  }

  setter();
  console.log(`Set ${key} = ${value}`);
  db.close();
}

function configValidateCmd() {
  const report = runConfigValidation();
  const headline = report.ok
    ? `Config validation passed (${report.checks.length} checks, ${report.warnings} warning${report.warnings === 1 ? "" : "s"}).`
    : `Config validation failed (${report.errors} error${report.errors === 1 ? "" : "s"}, ${report.warnings} warning${report.warnings === 1 ? "" : "s"}).`;
  console.log(headline);
  console.log(`Checked at: ${report.checkedAt}\n`);
  for (const check of report.checks) {
    const label = check.status.toUpperCase().padEnd(5, " ");
    console.log(`  [${label}] ${check.title} — ${check.summary}`);
    for (const detail of check.details ?? []) {
      console.log(`           - ${detail}`);
    }
  }
  if (!report.ok) {
    process.exitCode = 1;
  }
}

function secretsListCmd() {
  const status = getSecretsStatus();
  const secrets = listSecretsMeta();
  console.log(`Secrets manager: ${status.masterKeyConfigured ? "ready" : "master key missing"}`);
  if (status.keySource) {
    console.log(`Key source: ${status.keySource}`);
  }
  if (secrets.length === 0) {
    console.log("No stored secrets.");
    return;
  }
  console.log(`\nStored secrets (${secrets.length}):\n`);
  for (const secret of secrets) {
    console.log(`  - ${secret.name}  source=${secret.source}  updated=${secret.updatedAt}`);
  }
}

function secretsSetCmd(name: string, value: string) {
  if (!name || value === undefined) {
    console.error("Usage: dpc secrets set <name> <value|--stdin>");
    process.exit(1);
  }
  if (value.trim() === "--stdin") {
    value = fs.readFileSync(0, "utf8").replace(/[\r\n]+$/, "");
  }
  if (!value) {
    console.error(`Secret value for ${name} is empty.`);
    process.exit(1);
  }
  const saved = upsertSecret({ name, value, source: "cli" });
  console.log(`Saved secret ${saved.name}.`);
  console.log(`Reference it with: secret:${saved.name}`);
}

function secretsRemoveCmd(name: string) {
  if (!name) {
    console.error("Usage: dpc secrets remove <name>");
    process.exit(1);
  }
  const ok = deleteSecret(name);
  if (!ok) {
    console.error(`Secret not found: ${name}`);
    process.exit(1);
  }
  console.log(`Deleted secret ${name.toUpperCase()}.`);
}

function statusCmd() {
  console.log("disp8ch status:\n");

  // Database
  const dbExists = fs.existsSync(DB_PATH);
  console.log(`  Database:    ${dbExists ? "OK" : "MISSING"} (${DB_PATH})`);

  // Memories
  const memExists = fs.existsSync(MEMORY_PATH);
  const memCount = memExists ? fs.readdirSync(MEMORY_PATH).filter((f) => f.endsWith(".md")).length : 0;
  console.log(`  Memories:    ${memCount} files (${MEMORY_PATH})`);

  // .env.local
  const envExists = fs.existsSync(path.join(PROJECT_ROOT, ".env.local"));
  console.log(`  .env.local:  ${envExists ? "OK" : "MISSING"}`);

  // Models
  if (dbExists) {
    const db = getDb();
    const modelAvailability = getRuntimeModelAvailability(db);
    const wfCount = (db.prepare("SELECT COUNT(*) as c FROM workflows").get() as { c: number }).c;
    console.log(`  Models:      ${modelAvailability.available ? modelAvailability.details : "none active"}`);
    console.log(`  Workflows:   ${wfCount}`);
    db.close();
  }

  console.log();
}

function runHealthChecks(): HealthCheck[] {
  const checks: HealthCheck[] = [];

  // Database
  const dbExists = fs.existsSync(DB_PATH);
  if (!dbExists) {
    checks.push({ name: "database", status: "fail", details: `Missing: ${DB_PATH}` });
  } else {
    try {
      const db = getDb();
      checks.push({ name: "database", status: "ok", details: DB_PATH });

      const modelAvailability = getRuntimeModelAvailability(db);
      checks.push({
        name: "models",
        status: modelAvailability.available ? "ok" : "warn",
        details: modelAvailability.details,
      });

      const activeWorkflows = (db.prepare("SELECT COUNT(*) as c FROM workflows WHERE is_active = 1").get() as { c: number }).c;
      checks.push({
        name: "workflows",
        status: activeWorkflows > 0 ? "ok" : "warn",
        details: activeWorkflows > 0 ? `${activeWorkflows} active workflow(s)` : "No active workflows",
      });
      db.close();
    } catch (error) {
      checks.push({ name: "database", status: "fail", details: String(error) });
    }
  }

  // Workspace
  checks.push({
    name: "workspace",
    status: fs.existsSync(WORKSPACE_PATH) ? "ok" : "warn",
    details: WORKSPACE_PATH,
  });
  checks.push({
    name: "workspace-memory",
    status: fs.existsSync(WORKSPACE_MEMORY_PATH) ? "ok" : "warn",
    details: WORKSPACE_MEMORY_PATH,
  });

  // Environment
  const envPath = path.join(PROJECT_ROOT, ".env.local");
  checks.push({
    name: "env.local",
    status: fs.existsSync(envPath) ? "ok" : "warn",
    details: envPath,
  });

  // Memory store
  const memExists = fs.existsSync(MEMORY_PATH);
  const memCount = memExists ? fs.readdirSync(MEMORY_PATH).filter((f) => f.endsWith(".md")).length : 0;
  checks.push({
    name: "atomic-memory",
    status: memExists ? "ok" : "warn",
    details: memExists ? `${memCount} files in ${MEMORY_PATH}` : `Missing: ${MEMORY_PATH}`,
  });

  checks.push(checkPlaywrightRuntime());

  // Google OAuth
  try {
    const db = new Database(DB_PATH, { readonly: true });
    if (process.platform !== "win32") db.pragma("journal_mode = WAL");
    try {
      const row = db.prepare("SELECT email, expires_at FROM google_oauth WHERE id = 'default'").get() as {
        email: string | null; expires_at: number | null;
      } | undefined;
      if (row) {
        const nowSec = Math.floor(Date.now() / 1000);
        const expired = row.expires_at ? row.expires_at < nowSec : true;
        checks.push({
          name: "google-oauth",
          status: expired ? "warn" : "ok",
          details: `email=${row.email || "unknown"}, ${expired ? "token expired" : "token valid"}`,
        });
      } else {
        checks.push({ name: "google-oauth", status: "warn", details: "Not configured" });
      }
    } catch {
      checks.push({ name: "google-oauth", status: "warn", details: "Table not created yet" });
    }
    db.close();
  } catch {
    checks.push({ name: "google-oauth", status: "warn", details: "Unable to check" });
  }

  return checks;
}

function summarizePlaywrightFailure(raw: string): string {
  const text = String(raw || "").replace(/\s+/g, " ").trim();
  if (!text) return "Chromium launch failed";
  if (text.includes("Executable doesn't exist") || text.includes("Please run the following command")) {
    return "Chromium not installed (run: pnpm run playwright:install)";
  }
  if (
    text.includes("Host system is missing dependencies") ||
    text.includes("libnspr4.so") ||
    text.includes("libnss3.so")
  ) {
    return process.platform === "linux"
      ? "Linux browser deps missing (run: pnpm run playwright:install:linux)"
      : "Browser runtime dependencies missing";
  }
  return text.slice(0, 220);
}

function checkPlaywrightRuntime(): HealthCheck {
  const playwrightPackage = path.join(PROJECT_ROOT, "node_modules", "playwright");
  if (!fs.existsSync(playwrightPackage)) {
    return {
      name: "browser-playwright",
      status: "warn",
      details: "Playwright package not installed yet (run pnpm install)",
    };
  }

  const smokeScript = [
    "const { chromium } = require('playwright');",
    "(async () => {",
    "  const browser = await chromium.launch({ headless: true });",
    "  await browser.close();",
    "})().catch((error) => {",
    "  const message = String(error && (error.stack || error.message) || error);",
    "  process.stderr.write(message);",
    "  process.exit(1);",
    "});",
  ].join("\n");

  try {
    execFileSync(process.execPath, ["-e", smokeScript], {
      cwd: PROJECT_ROOT,
      stdio: "pipe",
      timeout: 15000,
      env: {
        ...process.env,
        CI: "1",
      },
    });
    return {
      name: "browser-playwright",
      status: "ok",
      details: "Chromium launch ok",
    };
  } catch (error) {
    const stdout = Buffer.isBuffer((error as { stdout?: unknown }).stdout)
      ? (error as { stdout: Buffer }).stdout.toString("utf8")
      : String((error as { stdout?: unknown }).stdout || "");
    const stderr = Buffer.isBuffer((error as { stderr?: unknown }).stderr)
      ? (error as { stderr: Buffer }).stderr.toString("utf8")
      : String((error as { stderr?: unknown }).stderr || "");
    return {
      name: "browser-playwright",
      status: "warn",
      details: summarizePlaywrightFailure(`${stderr}\n${stdout}`),
    };
  }
}

function printHealthChecks(checks: HealthCheck[]) {
  for (const check of checks) {
    const icon = check.status === "ok" ? "OK" : check.status === "warn" ? "WARN" : "FAIL";
    console.log(`  [${icon}] ${check.name.padEnd(18)} ${check.details}`);
  }
}

function formatHealthJson(checks: HealthCheck[], extra: Record<string, unknown> = {}) {
  const hasFailure = checks.some((c) => c.status === "fail");
  return {
    ok: !hasFailure,
    checks: checks.map((check) => ({
      name: check.name,
      status: check.status,
      summary: check.details,
      repair: null,
    })),
    ...extra,
  };
}

function healthCmd(json = false) {
  const checks = runHealthChecks();
  if (json) {
    console.log(JSON.stringify(formatHealthJson(checks), null, 2));
    return;
  }
  console.log("disp8ch health:\n");
  printHealthChecks(checks);
  const hasFailure = checks.some((c) => c.status === "fail");
  console.log(`\nOverall: ${hasFailure ? "UNHEALTHY" : "HEALTHY"}`);
}

function doctorCmd(repair: boolean, json = false) {
  const repairMessages: string[] = [];
  const warnRepair = (message: string) => {
    repairMessages.push(message);
    if (!json) console.log(`  WARN ${message}`);
  };

  const before = runHealthChecks();
  if (json && !repair) {
    console.log(JSON.stringify(formatHealthJson(before, { repaired: false }), null, 2));
    return;
  }

  if (!json) {
    console.log("disp8ch doctor:\n");
    printHealthChecks(before);
  }

  if (repair) {
    if (!json) console.log("\nApplying repairs...\n");
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    fs.mkdirSync(MEMORY_PATH, { recursive: true });
    fs.mkdirSync(WORKSPACE_PATH, { recursive: true });
    fs.mkdirSync(WORKSPACE_MEMORY_PATH, { recursive: true });
    try {
      const workspaceCore: Array<[string, string]> = [
        ["AGENTS.md", "# AGENTS\n"],
        ["SOUL.md", "# SOUL\n"],
        ["USER.md", "# USER\n"],
        ["IDENTITY.md", "# IDENTITY\n"],
        ["TOOLS.md", "# TOOLS\n"],
        ["HOOKS.md", "# HOOKS\n"],
        ["MEMORY.md", "# MEMORY\n\nCurated durable memory: decisions, preferences, and stable facts.\n"],
        ["HEARTBEAT.md", "# HEARTBEAT\n"],
        ["BOOT.md", "# BOOT\n"],
      ];
      for (const [name, content] of workspaceCore) {
        const filePath = path.join(WORKSPACE_PATH, name);
        if (!fs.existsSync(filePath)) {
          fs.writeFileSync(filePath, content, "utf-8");
        }
      }
      const hooksDir = path.join(WORKSPACE_PATH, "hooks");
      fs.mkdirSync(hooksDir, { recursive: true });
      const sampleHook = path.join(hooksDir, "sample-hook.mjs");
      if (!fs.existsSync(sampleHook)) {
        fs.writeFileSync(
          sampleHook,
          "export default async function onEvent(event) { if (event.type === \"workflow.complete\") console.log(\"[hook] workflow complete\"); }\n",
          "utf-8",
        );
      }
    } catch (error) {
      warnRepair(`failed workspace repair: ${String(error)}`);
    }

    try {
      const db = new Database(DB_PATH);
      db.pragma(process.platform === "win32" ? "journal_mode = DELETE" : "journal_mode = WAL");
      db.exec(`
        CREATE TABLE IF NOT EXISTS app_config (
          id TEXT PRIMARY KEY,
          onboarding_done INTEGER DEFAULT 0,
          timezone TEXT DEFAULT 'UTC',
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
      `);
      const now = new Date().toISOString();
      db.prepare("INSERT OR IGNORE INTO app_config (id, onboarding_done, timezone, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run("default", 0, "UTC", now, now);
      db.prepare("INSERT OR IGNORE INTO memory_config (id, tier, auto_threshold, total_memories, storage_bytes, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run("default", "auto", 50, 0, 0, now);
      db.close();
    } catch (error) {
      warnRepair(`failed DB repair: ${String(error)}`);
    }
  }

  const after = runHealthChecks();
  if (json) {
    console.log(JSON.stringify(formatHealthJson(after, {
      repaired: repair,
      before: before.map((check) => ({ name: check.name, status: check.status, summary: check.details, repair: null })),
      repairMessages,
    }), null, 2));
    return;
  }

  console.log("\nAfter checks:\n");
  printHealthChecks(after);
  const hasFailure = after.some((c) => c.status === "fail");
  console.log(`\nOverall: ${hasFailure ? "UNHEALTHY" : "HEALTHY"}`);
}

type UpdatePlanStep = {
  action: string;
  status: "ready" | "manual" | "unsupported" | "unknown";
  details: string;
};

function detectInstallChannel(): InstallChannel {
  const raw = String(process.env.DISP8CH_INSTALL_CHANNEL || "").toLowerCase();
  if (raw === "desktop" || raw === "script" || raw === "source") return raw;
  if (process.resourcesPath) return "desktop";
  if (process.env.DISP8CH_APP_DIR) return "script";
  return "source";
}

function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8")) as { version?: string };
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
}

function gitOutput(args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
  } catch {
    return null;
  }
}

function buildUpdatePlan(dryRun: boolean) {
  const channel = detectInstallChannel();
  const paths = getInstallPaths({ channel, appRoot: PROJECT_ROOT });
  const version = readPackageVersion();
  const steps: UpdatePlanStep[] = [];
  const currentCommit = gitOutput(["rev-parse", "--short", "HEAD"]);
  const branch = gitOutput(["rev-parse", "--abbrev-ref", "HEAD"]);
  const upstream = gitOutput(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  const aheadBehind = upstream ? gitOutput(["rev-list", "--left-right", "--count", `${upstream}...HEAD`]) : null;

  if (channel === "desktop") {
    const updateFeed = process.env.DISP8CH_DESKTOP_UPDATE_URL || process.env.DISP8CH_UPDATE_MANIFEST_URL || "";
    steps.push({
      action: "desktop-update",
      status: "manual",
      details: updateFeed
        ? `Would check the desktop update manifest at ${updateFeed}. The desktop shell can download and SHA-256 verify matching artifacts when DISP8CH_ENABLE_DESKTOP_UPDATE_DOWNLOADS=1, but installer execution/restart remains manual.`
        : "Desktop update checks need DISP8CH_DESKTOP_UPDATE_URL or DISP8CH_UPDATE_MANIFEST_URL. Use the signed installer or release artifact for now.",
    });
  } else if (channel === "script") {
    steps.push({
      action: "script-update",
      status: dryRun ? "ready" : "manual",
      details: dryRun
        ? `Would update app files under ${paths.appDir}, reinstall dependencies if package files changed, preserve ${paths.databasePath}, then restart the runtime.`
        : "Automatic script update is not enabled yet; rerun the one-line installer or update the app directory manually.",
    });
  } else {
    steps.push({
      action: "source-update",
      status: dryRun ? "ready" : "manual",
      details: dryRun
        ? `Would update the source checkout at ${PROJECT_ROOT}, preserve repo-local data/env files, reinstall dependencies if package files changed, then run health checks.`
        : "Automatic source update is intentionally manual; use git pull, pnpm install, then dpc doctor.",
    });
  }

  if (upstream && aheadBehind) {
    const [behind, ahead] = aheadBehind.split(/\s+/).map((value) => Number(value || 0));
    steps.push({
      action: "git-status",
      status: "ready",
      details: `Branch ${branch || "unknown"} tracks ${upstream}; behind=${behind || 0}, ahead=${ahead || 0}.`,
    });
  } else if (currentCommit) {
    steps.push({
      action: "git-status",
      status: "unknown",
      details: `Current source commit ${currentCommit}; no upstream tracking branch was available without fetching.`,
    });
  } else {
    steps.push({
      action: "source-status",
      status: "unknown",
      details: "No git checkout was detected for this runtime.",
    });
  }

  return {
    ok: true,
    dryRun,
    channel,
    version,
    platform: process.platform,
    appDir: paths.appDir,
    dataDir: paths.dataDir,
    databasePath: paths.databasePath,
    steps,
  };
}

function updateCmd(args: string[]) {
  const dryRun = args.includes("--dry-run");
  const json = args.includes("--json");
  const plan = buildUpdatePlan(dryRun);
  if (json) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  console.log(`disp8ch update ${dryRun ? "(dry run)" : ""}`.trim());
  console.log(`Channel: ${plan.channel}`);
  console.log(`Version: ${plan.version}`);
  console.log(`App: ${plan.appDir}`);
  console.log(`Data: ${plan.dataDir}`);
  console.log("");
  for (const step of plan.steps) {
    console.log(`[${step.status.toUpperCase()}] ${step.action}: ${step.details}`);
  }
  if (!dryRun) {
    console.log("\nNo files were changed. Use --dry-run for a machine-readable update plan; mutating updates require a signed desktop release or the installer script path.");
  }
}

function envCmd() {
  const keys = [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GOOGLE_API_KEY",
    "GROQ_API_KEY",
    "TOGETHER_API_KEY",
    "OPENROUTER_API_KEY",
    "DEEPSEEK_API_KEY",
    "MISTRAL_API_KEY",
    "ZHIPU_API_KEY",
    "MOONSHOT_API_KEY",
    "XAI_API_KEY",
    "OLLAMA_BASE_URL",
    "VLLM_API_KEY",
    "VLLM_BASE_URL",
    "SGLANG_API_KEY",
    "SGLANG_BASE_URL",
    "WS_PORT",
    "DATABASE_PATH",
    "MEMORY_PATH",
    "ENCRYPTION_KEY",
    "SECRETS_MASTER_KEY",
  ];

  console.log("Environment variables:\n");
  for (const key of keys) {
    const val = process.env[key];
    if (val) {
      const display = key.includes("KEY") && key !== "ENCRYPTION_KEY" && key !== "SECRETS_MASTER_KEY"
        ? val.slice(0, 8) + "..." + val.slice(-4)
        : val;
      console.log(`  ${key} = ${display}`);
    } else {
      console.log(`  ${key} = (not set)`);
    }
  }
}

function helpCmd() {
  console.log(`
disp8ch CLI — Configure disp8ch from the terminal

Usage: dpc <command> [args]

Init:
  init [--ensure-env] [--timezone <tz>] [--onboarding-done]
                                      Initialize app state for automation and LLM use

Models:
  models list                          List configured models
  models recommend [provider]          Show recommended tool-capable models
  models add <provider> [api-key] [base-url] [--model <model-id>] [--fast]  Add a model provider
  models probe [id|provider]           Probe model connectivity
  models probe-tools [id|provider]     Probe model tool-use connectivity
  models remove <id>                   Remove a model
  models set-priority <id> <priority>  Set failover priority (higher = preferred)

  Providers: ${PROVIDER_ID_LIST}

Memory:
  memory embedding-status              Show active embedding model and vector index stats
  memory stats                         Show memory statistics
  memory list                          List all memories
  memory search <query>                Search memories
  memory clear                         Delete all memories
  memory rebuild-index                 Rebuild embeddings + FTS index for all memories
  memory index-sessions                Index past session transcripts into memory search
  memory index-collections             Index extra markdown collections into memory search
  memory backfill                      Sync atomic memory files to MEMORY.md

Workflows:
  workflows list                       List all workflows
  workflows create <name> [template]   Create a workflow (supports all built-in templates)
  workflows delete <id>                Delete a workflow

Agents:
  agents list                          List agents
  agents create <name>                 Create an agent
  agents update <id>                   Update an agent
  agents delete <id>                   Delete an agent
  agents default                       Show the default agent

Data Sources:
  data-sources list                    List uploaded/scraped data sources
  data-sources search <query>          Search data sources
  data-sources get <id-or-name>        Show one data source
  data-sources upload <file>           Upload a file data source
  data-sources scrape <url>            Scrape one page
  data-sources crawl <url>             Crawl multiple pages
  data-sources delete <id-or-name>     Delete a data source

Boards:
  boards list                          List boards
  boards create <name>                 Create a board
  boards delete <board-id>             Delete a board
  boards tasks                         List board tasks
  boards create-task <title>           Create a board task
  boards run-task <task-id>            Run a workflow-backed board task
  boards claim-task <task-id> <agent>  Check out a task
  boards release-task <task-id>        Release a checked-out task
  boards delete-task <task-id>         Delete a board task

Organizations:
  orgs list                            List saved organizations
  orgs current                         Show the active organization
  orgs save-current <name>             Save current hierarchy as an organization
  orgs switch <id-or-name>             Switch to a saved organization
  orgs delete <id-or-name>             Delete a saved organization
  orgs export <id-or-name> [path]      Export an organization pack to JSON
  orgs import <file>                   Import an organization pack from JSON
  orgs import-template <path>          Import an external company export/template

Goals:
  goals list                           List hierarchy goals
  goals create <name>                  Create a hierarchy goal
  goals delete <goal-id>               Delete a hierarchy goal

Extensions:
  extensions list                      List installed extensions + global state
  extensions status                    Show runtime hook status for extensions
  extensions install <source> [ref]    Install an external extension from local path or git
  extensions update <id>               Refresh an installed external extension from its tracked source
  extensions uninstall <id>            Remove an installed external extension
  extensions enable <id>               Enable an extension globally
  extensions disable <id>              Disable an extension globally
  extensions config-get <id>           Show stored extension config
  extensions config-set <id> <json>    Save stored extension config JSON

Skills:
  skills list [--verbose]              List installed skill packs + agent-visible sources
  skills install <source> [ref]        Install an external skill pack from local path or git
  skills update <id>                   Refresh an installed external skill pack from its tracked source
  skills uninstall <id>                Remove an installed external skill pack
  skills import-reference <repo-path>  Import reference skills into a disp8ch skill pack
  skills import-workspace <repo-path>  Import workspace skills into a disp8ch skill pack

Learning:
  learning status                      Show learning-loop status
  learning candidates                  List learning candidates
  learning events                      List recent learning evidence
  learning promote <id|latest>         Promote a learning candidate
  learning dismiss <id|latest>         Dismiss a learning candidate

Backups:
  backup create                        Create a verified local backup snapshot
  backup list                          List backup snapshots
  backup verify [id|latest]            Verify checksums for a backup snapshot
  backup status                        Show automated backup policy status
  backup run-policy                    Run automated backup policy now

ACP:
  acp status                           Show ACP ingress status
  acp test [message]                   Send a test ACP message
  acp sessions                         List ACP session bindings
  acp reset-session <id-or-label>      Reset a persisted ACP session transcript
  acp serve [--port <n>] [--target <url>]  Run an ACP bridge proxy

Auth:
  auth google [--manual]               Set up Google OAuth (Gmail/Drive)
  auth status                          Show Google OAuth status
  auth revoke                          Delete stored Google OAuth token

Config:
  config show [--json]                 Show all configuration
  config get <key>                     Get a config value
  config set <key> <value>             Set a config value
  config validate                      Validate runtime config and security posture

  Keys:
    onboarding, timezone, tool.output_limit
    learning_enabled, learning_mode, learning_capture_preferences
    learning_capture_playbooks, learning_auto_promote_threshold
    backup_enabled, backup_cron, backup_retention_count, backup_include_logs
    backup_replication_mode, backup_replication_target, backup_replication_rsync_args
    compaction.mode, compaction.threshold, compaction.context_window
    pending_mutation.ttl_ms
    retry.attempts, retry.min_delay_ms, retry.max_delay_ms, retry.jitter
    telemetry.enabled, hooks.enabled, memory.flush_enabled
    ratelimit.webhooks, ratelimit.execute, ratelimit.channels
    lane.main.max_concurrent, lane.cron.max_concurrent, lane.subflow.max_concurrent
    log.max_days
    memory.decay.enabled, memory.decay.half_life_days
    memory.embedding_model, memory.vector_weight, memory.text_weight
    memory.index_sessions, memory.session_chunk_tokens, memory.session_chunk_overlap
    memory.startup_include_files, memory.max_snippet_chars, memory.max_injected_chars
    memory.citations_mode, memory.extra_collection_paths
    memory.search_backend, memory.rerank_strategy
    memory.query_expansion_enabled, memory.strong_signal_enabled
    memory.rerank_candidate_limit
    provenance_mode, acp_auth_mode, acp_auth_secret_name

  Aliases:
    Raw config field names also work, for example:
    tool_output_limit, embedding_model, index_sessions, citations_mode

Secrets:
  secrets list                         List secret names (values are never printed)
  secrets set <name> <value|--stdin>   Create/update encrypted secret
  secrets remove <name>                Delete secret

System:
  status                               Show system status
  health [--json]                      Run health checks
  doctor [--repair] [--json]           Diagnose and optionally repair common issues
  update [--dry-run] [--json]          Report install update actions without touching app data
  env                                  Show which env vars are set
  help                                 Show this help

Examples:
  dpc init --ensure-env --timezone Asia/Kuala_Lumpur --onboarding-done
  dpc models recommend
  dpc models recommend google
  dpc models add anthropic sk-ant-xxxx
  dpc models add google AIzaSy-xxxx
  dpc models add google AIzaSy-xxxx --model gemini-3-flash-preview
  dpc models add ollama
  dpc models add ollama http://localhost:11434
  dpc models add openai-compatible http://127.0.0.1:8000/v1 --model Qwen/Qwen3-8B
  dpc models add lmstudio
  dpc models add lmstudio http://127.0.0.1:1234/v1
  dpc models probe google
  dpc models probe-tools google
  printf "%s" "$OPENAI_API_KEY" | dpc secrets set OPENAI_API_KEY --stdin
  dpc secrets list
  dpc memory embedding-status
  dpc memory rebuild-index
  dpc memory index-collections
  dpc config set memory.vector_weight 0.7
  dpc config show --json
  dpc config validate
  dpc workflows list
  dpc workflows create "Support Bot" simple-chat
  dpc workflows create "Google Assistant" gmail-drive-bridge
  dpc workflows create "Local Specs Bot" pc-specs-tool-use
  dpc agents list
  dpc agents create "Research Agent" --model google:gemini-3-flash-preview
  dpc data-sources list
  dpc data-sources crawl https://docs.python.org/3/ --name python-docs --max-pages 20 --max-depth 2
  dpc boards tasks
  dpc boards create-task "Review python docs" --board main-board --template document-intelligence
  dpc orgs current
  dpc orgs save-current "CEO Demo Org"
  dpc goals list
  dpc goals create "Launch local-first assistant" --organization "CEO Demo Org"
  dpc extensions list
  dpc extensions status
  dpc skills list
  dpc skills list --verbose
  dpc extensions install ./extensions-external/my-pack
  dpc extensions install your-org/your-pack main
  dpc extensions update my-pack
  dpc extensions uninstall my-pack
  dpc skills list
  dpc skills install ./skills-external/release-ops-pack
  dpc skills install your-org/your-skill-pack main
  dpc skills update your-skill-pack
  dpc skills uninstall your-skill-pack
  dpc backup create
  dpc backup list
  dpc backup verify latest
  dpc backup status
  dpc backup run-policy
  dpc acp status
  dpc acp test "ACP ingress smoke test" --mode meta+receipt
  dpc auth google
  dpc auth google --manual
  dpc auth status
  dpc auth revoke
  dpc status
  dpc health
  dpc health --json
  dpc doctor --repair
  dpc doctor --json
  dpc update --dry-run
  dpc update --dry-run --json
`);
}

// ============================================================================
// Auth commands (Google OAuth2 PKCE)
// ============================================================================

async function authGoogleCmd(manual: boolean) {
  const readline = await import("node:readline");
  const childProcess = await import("node:child_process");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> =>
    new Promise((resolve) => rl.question(q, (a) => resolve(a.trim())));

  console.log(`
Google OAuth2 Setup
===================

This connects disp8ch to your Gmail and Google Drive.

Prerequisites:
  1. Go to https://console.cloud.google.com/apis/credentials
  2. Create an OAuth 2.0 Client ID (Application type: Desktop app)
  3. Enable the Gmail API and Google Drive API in your project
  4. Note your Client ID and Client Secret
`);

  const clientId = await ask("Client ID: ");
  if (!clientId) {
    console.error("Client ID is required.");
    rl.close();
    process.exit(1);
  }

  const clientSecret = await ask("Client Secret: ");
  if (!clientSecret) {
    console.error("Client Secret is required.");
    rl.close();
    process.exit(1);
  }
  rl.close();

  const { generatePkce, buildAuthUrl, waitForCallback, exchangeCode, fetchUserEmail, saveToken, DEFAULT_SCOPES } =
    await import("../src/lib/google-oauth");

  const port = 3102;
  const redirectUri = `http://localhost:${port}`;
  const { verifier, challenge, state } = generatePkce();
  const authUrl = buildAuthUrl(clientId, redirectUri, DEFAULT_SCOPES, challenge, state);

  console.log("\nOpening browser for authorization...\n");

  const isWsl = !!process.env.WSL_DISTRO_NAME;
  if (manual || isWsl) {
    console.log("Open this URL in your browser:\n");
    console.log(`  ${authUrl}\n`);
    if (isWsl) {
      console.log("(WSL detected — auto-open is not available)");
    }
  } else {
    // Try to open browser
    const openCmd =
      process.platform === "darwin" ? "open" :
      process.platform === "win32" ? "start" :
      "xdg-open";
    try {
      childProcess.execFileSync(openCmd, [authUrl], { stdio: "ignore" });
    } catch {
      console.log("Could not open browser automatically. Open this URL:\n");
      console.log(`  ${authUrl}\n`);
    }
  }

  console.log("Waiting for authorization callback on port " + port + "...");

  let callbackResult: { code: string; state: string };
  try {
    callbackResult = await waitForCallback(port, 120000);
  } catch (err) {
    console.error(`\nAuthorization failed: ${String(err)}`);
    process.exit(1);
    return; // unreachable, satisfies TS
  }

  if (callbackResult.state !== state) {
    console.error("\nState mismatch — possible CSRF. Aborting.");
    process.exit(1);
  }

  console.log("\nExchanging authorization code for tokens...");

  const tokens = await exchangeCode(
    callbackResult.code,
    clientId,
    clientSecret,
    redirectUri,
    verifier,
  );

  let email = "unknown";
  try {
    email = await fetchUserEmail(tokens.access_token);
  } catch {
    console.log("  (Could not fetch Gmail profile email)");
  }

  saveToken({
    clientId,
    clientSecret,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresIn: tokens.expires_in,
    scopes: DEFAULT_SCOPES,
    email,
  });

  console.log(`\nGoogle OAuth configured successfully!`);
  console.log(`  Email: ${email}`);
  console.log(`  Scopes: ${DEFAULT_SCOPES.join(", ")}`);
  console.log(`  Token expires in: ${tokens.expires_in}s (auto-refreshes)`);
  console.log(`\nUse {{google.accessToken}} in workflow templates.`);
}

function authStatusCmd() {
  const db = getDb();
  try {
    db.exec(`
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
      )
    `);
    const row = db.prepare("SELECT * FROM google_oauth WHERE id = 'default'").get() as {
      email: string | null; expires_at: number | null; scopes: string; created_at: string;
    } | undefined;

    if (!row) {
      console.log("Google OAuth: Not configured");
      console.log("Run 'dpc auth google' to set up.");
      return;
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const expired = row.expires_at ? row.expires_at < nowSec : true;
    const expiresStr = row.expires_at
      ? new Date(row.expires_at * 1000).toISOString()
      : "unknown";

    console.log("Google OAuth: Configured\n");
    console.log(`  Email:     ${row.email || "unknown"}`);
    console.log(`  Expires:   ${expiresStr}${expired ? " (EXPIRED)" : ""}`);
    console.log(`  Scopes:    ${row.scopes}`);
    console.log(`  Created:   ${row.created_at}`);
  } finally {
    db.close();
  }
}

function authRevokeCmd() {
  const db = getDb();
  try {
    db.exec(`
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
      )
    `);
    const row = db.prepare("SELECT email FROM google_oauth WHERE id = 'default'").get() as { email: string | null } | undefined;
    if (!row) {
      console.log("No Google OAuth token to revoke.");
      return;
    }
    db.prepare("DELETE FROM google_oauth WHERE id = 'default'").run();
    console.log(`Google OAuth token deleted${row.email ? ` (was: ${row.email})` : ""}.`);
  } finally {
    db.close();
  }
}

async function backupCreateCmd() {
  const backup = await createBackup();
  console.log(`Backup created: ${backup.id}`);
  console.log(`  Directory: ${backup.backupDir}`);
  console.log(`  Created:   ${backup.createdAt}`);
  console.log(`  Files:     ${backup.totalFiles}`);
  console.log(`  Size:      ${backup.totalBytes} bytes`);
}

function backupListCmd() {
  const backups = listBackups();
  if (backups.length === 0) {
    console.log("No backups found.");
    return;
  }
  for (const backup of backups) {
    console.log(`${backup.id}`);
    console.log(`  Created: ${backup.createdAt}`);
    console.log(`  Files:   ${backup.totalFiles}`);
    console.log(`  Size:    ${backup.totalBytes} bytes`);
    console.log(`  Dir:     ${backup.backupDir}`);
  }
}

function backupVerifyCmd(idOrRef?: string) {
  const result = verifyBackup(idOrRef || "latest");
  console.log(`Backup verify: ${result.manifest.id}`);
  console.log(`  OK:       ${result.ok ? "yes" : "no"}`);
  console.log(`  Files:    ${result.checkedFiles}`);
  console.log(`  Size:     ${result.totalBytes} bytes`);
  if (result.missingFiles.length > 0) {
    console.log(`  Missing:  ${result.missingFiles.join(", ")}`);
  }
  if (result.mismatchedFiles.length > 0) {
    console.log(`  Changed:  ${result.mismatchedFiles.join(", ")}`);
  }
  if (!result.ok) {
    process.exitCode = 1;
  }
}

function backupStatusCmd() {
  const status = getBackupPolicyStatus();
  console.log(`Automated backups: ${status.config.enabled ? "enabled" : "disabled"}`);
  console.log(`  Scheduled:   ${status.scheduled ? "yes" : "no"}`);
  console.log(`  Cron:        ${status.config.cronExpression}`);
  console.log(`  Retention:   ${status.config.retentionCount}`);
  console.log(`  Replication: ${status.config.replicationMode}${status.config.replicationTarget ? ` -> ${status.config.replicationTarget}` : ""}`);
  console.log(`  Next run:    ${status.nextRunAt || "n/a"}`);
  console.log(`  Running:     ${status.running ? "yes" : "no"}`);
  console.log(`  Last success:${status.config.lastSuccessAt ? ` ${status.config.lastSuccessAt}` : " never"}`);
  console.log(`  Last error:  ${status.config.lastError || "none"}`);
  console.log(`  Latest:      ${status.latestBackup?.id || "none"}`);
}

async function backupRunPolicyCmd() {
  const result = await runBackupPolicy("cli", { ignoreDisabled: true });
  console.log(`Backup policy run: ${result.backup.id}`);
  console.log(`  Verified:    ${result.verified ? "yes" : "no"}`);
  console.log(`  Pruned:      ${result.prunedBackupIds.length > 0 ? result.prunedBackupIds.join(", ") : "none"}`);
  console.log(`  Replication: ${result.replication.skipped ? "skipped" : `${result.replication.mode} -> ${result.replication.destination}`}`);
}

function getAcpTargetUrl(explicit?: string | null): string {
  const raw = explicit || process.env.ACP_TARGET_URL || `http://127.0.0.1:${process.env.PORT ?? "3100"}/api/acp`;
  return raw.replace(/\/$/, "");
}

function getAcpBearerToken(explicit?: string | null): string | null {
  return String(explicit || process.env.ACP_INGRESS_TOKEN || "").trim() || null;
}

function buildAcpHeaders(explicitToken?: string | null): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = getAcpBearerToken(explicitToken);
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function acpStatusCmd() {
  const target = getAcpTargetUrl();
  try {
    const response = await fetch(target, { headers: buildAcpHeaders() });
    const json = await response.json() as { success?: boolean; data?: Record<string, unknown>; error?: string };
    if (!response.ok || !json.success) {
      console.error(`ACP status failed: ${json.error || `HTTP ${response.status}`}`);
      process.exit(1);
    }
    console.log(`ACP endpoint: ${target}`);
    console.log(`  Transport: ${String(json.data?.transport || "unknown")}`);
    console.log(`  Provenance mode: ${String(json.data?.provenanceMode || "unknown")}`);
    console.log(`  Auth mode: ${String(json.data?.authMode || "off")}`);
    console.log(`  Auth configured: ${Boolean(json.data?.authConfigured) ? "yes" : "no"}`);
  } catch (error) {
    console.error(`ACP status failed: ${String(error)}`);
    console.error("Make sure the disp8ch app server is running before checking ACP status.");
    process.exit(1);
  }
}

async function acpTestCmd(args: string[]) {
  const target = getAcpTargetUrl(readOption(args, "--target"));
  const messageParts: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const token = String(args[i] || "");
    if (!token || token === "test") continue;
    if (token.startsWith("--")) {
      i += 1;
      continue;
    }
    messageParts.push(token);
  }
  const message = messageParts.join(" ").trim() || `ACP test message ${Date.now()}`;
  const sessionId = readOption(args, "--session") || `acp-cli-${Date.now()}`;
  const traceId = readOption(args, "--trace") || `acp_cli_${Date.now()}`;
  const actor = readOption(args, "--actor") || "dpc-cli";
  const client = readOption(args, "--client") || "dpc";
  const provenanceMode = readOption(args, "--mode") || undefined;
  const sessionLabel = readOption(args, "--label") || undefined;
  const requireExisting = hasFlag(args, "--require-existing");
  const resetSession = hasFlag(args, "--reset-session");
  const bearer = readOption(args, "--token");
  try {
    const response = await fetch(target, {
      method: "POST",
      headers: buildAcpHeaders(bearer),
      body: JSON.stringify({
        message,
        sessionId,
        sessionLabel,
        traceId,
        actor,
        client,
        provenanceMode,
        requireExisting,
        resetSession,
      }),
    });
    const json = await response.json() as { success?: boolean; data?: Record<string, unknown>; error?: string };
    if (!response.ok || !json.success) {
      console.error(`ACP test failed: ${json.error || `HTTP ${response.status}`}`);
      process.exit(1);
    }
    console.log(`ACP test session: ${String(json.data?.sessionId || sessionId)}`);
    console.log(`  Workflow: ${String(json.data?.workflowName || json.data?.workflowId || "none")}`);
    if (json.data?.receipt) {
      console.log(`  Receipt: ${String(json.data.receipt)}`);
    }
    console.log("\nResponse:\n");
    console.log(String(json.data?.response || ""));
  } catch (error) {
    console.error(`ACP test failed: ${String(error)}`);
    console.error("Make sure the disp8ch app server is running before sending ACP test traffic.");
    process.exit(1);
  }
}

async function acpSessionsCmd(args: string[]) {
  const target = getAcpTargetUrl(readOption(args, "--target"));
  const limit = readOption(args, "--limit") || "20";
  const bearer = readOption(args, "--token");
  try {
    const response = await fetch(`${target}?action=sessions&limit=${encodeURIComponent(limit)}`, {
      headers: buildAcpHeaders(bearer),
    });
    const json = await response.json() as { success?: boolean; data?: Array<Record<string, unknown>>; error?: string };
    if (!response.ok || !json.success) {
      console.error(`ACP sessions failed: ${json.error || `HTTP ${response.status}`}`);
      process.exit(1);
    }
    const sessions = json.data || [];
    if (sessions.length === 0) {
      console.log("No ACP sessions found.");
      return;
    }
    for (const item of sessions) {
      console.log(`${String(item.sessionId)}${item.sessionLabel ? ` [${String(item.sessionLabel)}]` : ""}`);
      console.log(`  status=${String(item.status || "active")} turns=${String(item.turnCount || 0)} client=${String(item.client || "-")} actor=${String(item.actor || "-")}`);
      console.log(`  last_used=${String(item.lastUsedAt || "-")}`);
    }
  } catch (error) {
    console.error(`ACP sessions failed: ${String(error)}`);
    process.exit(1);
  }
}

async function acpResetSessionCmd(args: string[]) {
  const target = getAcpTargetUrl(readOption(args, "--target"));
  const ref = String(args.find((item) => item && !item.startsWith("--") && item !== "reset-session") || "").trim();
  if (!ref) {
    console.error("Usage: dpc acp reset-session <session-id-or-label>");
    process.exit(1);
  }
  const bearer = readOption(args, "--token");
  try {
    const response = await fetch(target, {
      method: "POST",
      headers: buildAcpHeaders(bearer),
      body: JSON.stringify({
        action: "reset-session",
        sessionId: ref.startsWith("acp:") ? ref : undefined,
        sessionLabel: ref.startsWith("acp:") ? undefined : ref,
      }),
    });
    const json = await response.json() as { success?: boolean; data?: Record<string, unknown>; error?: string };
    if (!response.ok || !json.success) {
      console.error(`ACP reset-session failed: ${json.error || `HTTP ${response.status}`}`);
      process.exit(1);
    }
    console.log(`Reset ACP session ${String(json.data?.sessionId || ref)}`);
  } catch (error) {
    console.error(`ACP reset-session failed: ${String(error)}`);
    process.exit(1);
  }
}

async function acpServeCmd(args: string[]) {
  const port = parseInt(readOption(args, "--port") || "3310", 10);
  const target = getAcpTargetUrl(readOption(args, "--target"));
  const bearer = readOption(args, "--token");
  const server = http.createServer(async (req, res) => {
    if (!req.url) {
      res.writeHead(400).end("Missing URL");
      return;
    }
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, target }));
      return;
    }
    if (req.method === "GET" && req.url === "/status") {
      try {
        const upstream = await fetch(target, { headers: buildAcpHeaders(bearer) });
        const text = await upstream.text();
        res.writeHead(upstream.status, { "Content-Type": upstream.headers.get("content-type") || "application/json" });
        res.end(text);
      } catch (error) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: String(error) }));
      }
      return;
    }
    if (req.method === "GET" && req.url.startsWith("/sessions")) {
      try {
        const upstream = await fetch(`${target}?action=sessions`, { headers: buildAcpHeaders(bearer) });
        const text = await upstream.text();
        res.writeHead(upstream.status, { "Content-Type": upstream.headers.get("content-type") || "application/json" });
        res.end(text);
      } catch (error) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: String(error) }));
      }
      return;
    }
    if (req.method !== "POST" || (req.url !== "/ingress" && req.url !== "/sessions/reset")) {
      res.writeHead(404).end("Not found");
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", async () => {
      try {
        const bodyBuffer = Buffer.concat(chunks);
        const upstream = await fetch(target, {
          method: "POST",
          headers: buildAcpHeaders(bearer),
          body: req.url === "/sessions/reset"
            ? JSON.stringify({
                action: "reset-session",
                ...(JSON.parse(bodyBuffer.toString("utf8")) as object),
              })
            : bodyBuffer,
        });
        const text = await upstream.text();
        res.writeHead(upstream.status, { "Content-Type": upstream.headers.get("content-type") || "application/json" });
        res.end(text);
      } catch (error) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: String(error) }));
      }
    });
  });
  server.listen(port, "0.0.0.0", () => {
    console.log(`ACP bridge listening on http://0.0.0.0:${port}/ingress`);
    console.log(`Forwarding to ${target}`);
    console.log(`Status proxy: http://0.0.0.0:${port}/status`);
    console.log(`Sessions proxy: http://0.0.0.0:${port}/sessions`);
  });
}

function initCmd(args: string[]) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.mkdirSync(MEMORY_PATH, { recursive: true });
  fs.mkdirSync(WORKSPACE_PATH, { recursive: true });
  fs.mkdirSync(WORKSPACE_MEMORY_PATH, { recursive: true });
  initializeDatabase();

  if (hasFlag(args, "--ensure-env")) {
    const envResult = ensureEnvFileDefaults({
      forceWrite: hasFlag(args, "--force-env"),
      encryptionKey: readOption(args, "--encryption-key"),
    });
    console.log(`Env file: ${envResult.envPath}`);
    console.log(`  created: ${envResult.created ? "yes" : "no"}`);
    console.log(`  updated: ${envResult.updated ? "yes" : "no"}`);
  }

  // Force default rows/tables for the main surfaces.
  listAgents();
  listBoards();
  listDocuments();
  listHierarchyOrganizations();

  const timezone = readOption(args, "--timezone");
  const onboardingDone = hasFlag(args, "--onboarding-done");
  if (timezone || onboardingDone) {
    const db = getDb();
    const current = db.prepare("SELECT timezone, onboarding_done FROM app_config WHERE id = 'default'").get() as
      | { timezone: string; onboarding_done: number }
      | undefined;
    db.prepare("UPDATE app_config SET timezone = ?, onboarding_done = ?, updated_at = ? WHERE id = 'default'")
      .run(
        timezone || current?.timezone || "UTC",
        onboardingDone ? 1 : (current?.onboarding_done ?? 0),
        new Date().toISOString(),
      );
    db.close();
  }

  console.log("Initialization complete.");
  console.log(`  Database:  ${DB_PATH}`);
  console.log(`  Memory:    ${MEMORY_PATH}`);
  console.log(`  Workspace: ${WORKSPACE_PATH}`);
  if (timezone) console.log(`  Timezone:  ${timezone}`);
  if (onboardingDone) console.log("  Onboarding marked complete.");
}

function agentsListCmd() {
  const agents = listAgents();
  if (agents.length === 0) {
    console.log("No agents found.");
    return;
  }
  console.log(`${agents.length} agents:\n`);
  for (const agent of agents) {
    console.log(`[${agent.id}] ${agent.name}`);
    console.log(`  default: ${agent.isDefault ? "yes" : "no"}  active: ${agent.isActive ? "yes" : "no"}`);
    console.log(`  workspace: ${agent.workspacePath}`);
    console.log(`  model: ${agent.modelRef || "(inherit)"}`);
    console.log(`  disabled tools: ${agent.disabledTools.length > 0 ? agent.disabledTools.join(", ") : "(none)"}`);
  }
}

function agentsDefaultCmd() {
  const agent = getDefaultAgent();
  console.log(`Default agent: ${agent.name}`);
  console.log(`  ID: ${agent.id}`);
  console.log(`  Workspace: ${agent.workspacePath}`);
  console.log(`  Model: ${agent.modelRef || "(inherit)"}`);
}

function agentsCreateCmd(args: string[]) {
  const name = args[0];
  if (!name) {
    console.error("Usage: dpc agents create <name> [--id <agent-id>] [--workspace <path>] [--model <model-ref>] [--disable-tools a,b] [--default]");
    process.exit(1);
  }
  const agent = createAgent({
    name,
    id: readOption(args, "--id"),
    workspacePath: readOption(args, "--workspace"),
    modelRef: readOption(args, "--model") ?? null,
    disabledTools: parseCsvOption(args, "--disable-tools"),
    isDefault: hasFlag(args, "--default"),
  });
  console.log(`Created agent: ${agent.name}`);
  console.log(`  ID: ${agent.id}`);
}

function agentsUpdateCmd(args: string[]) {
  const agentId = args[0];
  if (!agentId) {
    console.error("Usage: dpc agents update <agent-id> [--name <name>] [--workspace <path>] [--model <model-ref>] [--disable-tools a,b] [--default] [--active|--inactive]");
    process.exit(1);
  }
  const hasDefaultFlag = hasFlag(args, "--default");
  const hasActiveFlag = hasFlag(args, "--active");
  const hasInactiveFlag = hasFlag(args, "--inactive");
  const agent = updateAgent(agentId, {
    name: readOption(args, "--name"),
    workspacePath: readOption(args, "--workspace"),
    modelRef: readOption(args, "--model"),
    disabledTools: parseCsvOption(args, "--disable-tools"),
    isDefault: hasDefaultFlag ? true : undefined,
    isActive: hasActiveFlag ? true : hasInactiveFlag ? false : undefined,
  });
  console.log(`Updated agent: ${agent.name}`);
  console.log(`  ID: ${agent.id}`);
}

function agentsDeleteCmd(agentId?: string) {
  if (!agentId) {
    console.error("Usage: dpc agents delete <agent-id>");
    process.exit(1);
  }
  deleteAgent(agentId);
  console.log(`Deleted agent: ${agentId}`);
}

function dataSourcesListCmd() {
  const docs = listDocuments();
  if (docs.length === 0) {
    console.log("No data sources found.");
    return;
  }
  console.log(`${docs.length} data sources:\n`);
  for (const doc of docs) {
    console.log(`[${doc.id}] ${doc.name}`);
    console.log(`  type: ${doc.sourceType}  mime: ${doc.mimeType || "(none)"}`);
    console.log(`  url: ${doc.sourceUrl || "(local upload)"}`);
  }
}

function dataSourcesSearchCmd(query: string) {
  if (!query) {
    console.error("Usage: dpc data-sources search <query>");
    process.exit(1);
  }
  const docs = searchDocuments(query);
  console.log(`Found ${docs.length} data source(s) for "${query}":\n`);
  for (const doc of docs) {
    const excerpt = doc.excerpt.length > 220 ? `${doc.excerpt.slice(0, 220)}...` : doc.excerpt;
    console.log(`[${doc.id}] ${doc.name}`);
    console.log(`  ${excerpt}`);
  }
}

function dataSourcesGetCmd(reference?: string) {
  if (!reference) {
    console.error("Usage: dpc data-sources get <id-or-name>");
    process.exit(1);
  }
  const doc = getDocumentById(reference) || getDocumentByName(reference);
  if (!doc) {
    console.error(`Data source not found: ${reference}`);
    process.exit(1);
  }
  console.log(`${doc.name}`);
  console.log(`  ID: ${doc.id}`);
  console.log(`  Type: ${doc.sourceType}`);
  console.log(`  Source URL: ${doc.sourceUrl || "(local upload)"}`);
  console.log(`  File: ${doc.filePath || "(none)"}`);
  console.log(`  Size: ${doc.sizeBytes ?? 0}`);
  console.log(`  Created: ${doc.createdAt}`);
  console.log(`\n${doc.extractedText.slice(0, 1200)}${doc.extractedText.length > 1200 ? "\n\n[...truncated]" : ""}`);
}

async function dataSourcesUploadCmd(args: string[]) {
  const filePath = args[0];
  if (!filePath) {
    console.error("Usage: dpc data-sources upload <file-path> [--name <name>] [--mime <mime>]");
    process.exit(1);
  }
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    console.error(`File not found: ${resolved}`);
    process.exit(1);
  }
  const record = await createDocumentFromUpload({
    fileName: readOption(args, "--name") || path.basename(resolved),
    mimeType: readOption(args, "--mime") || "application/octet-stream",
    buffer: fs.readFileSync(resolved),
  });
  console.log(`Uploaded data source: ${record.name}`);
  console.log(`  ID: ${record.id}`);
}

async function dataSourcesScrapeCmd(args: string[]) {
  const url = args[0];
  if (!url) {
    console.error("Usage: dpc data-sources scrape <url> [--name <name>] [--strategy <auto|static|dynamic>]");
    process.exit(1);
  }
  const record = await createDocumentFromScrape({
    url,
    name: readOption(args, "--name"),
    options: {
      strategy: readOption(args, "--strategy") as "auto" | "static" | "dynamic" | undefined,
    },
  });
  console.log(`Scraped data source: ${record.name}`);
  console.log(`  ID: ${record.id}`);
  console.log(`  URL: ${record.sourceUrl || url}`);
}

async function dataSourcesCrawlCmd(args: string[]) {
  const url = args[0];
  if (!url) {
    console.error("Usage: dpc data-sources crawl <url> [--name <name>] [--max-pages <n>] [--max-depth <n>] [--strategy <auto|static|dynamic>] [--allow-cross-domain] [--no-sitemap]");
    process.exit(1);
  }
  const record = await createDocumentFromCrawl({
    url,
    name: readOption(args, "--name"),
    options: {
      maxPages: parseOptionalInt(args, "--max-pages", 20, 1, 80),
      maxDepth: parseOptionalInt(args, "--max-depth", 2, 0, 6),
      sameDomainOnly: !hasFlag(args, "--allow-cross-domain"),
      includeSubdomains: !hasFlag(args, "--no-subdomains"),
      seedFromSitemaps: !hasFlag(args, "--no-sitemap"),
      includePatterns: parseCsvOption(args, "--include"),
      excludePatterns: parseCsvOption(args, "--exclude"),
      strategy: readOption(args, "--strategy") as "auto" | "static" | "dynamic" | undefined,
    },
  });
  console.log(`Crawled data source: ${record.name}`);
  console.log(`  ID: ${record.id}`);
  console.log(`  URL: ${record.sourceUrl || url}`);
}

function dataSourcesDeleteCmd(reference?: string) {
  if (!reference) {
    console.error("Usage: dpc data-sources delete <id-or-name>");
    process.exit(1);
  }
  const doc = getDocumentById(reference) || getDocumentByName(reference);
  if (!doc) {
    console.error(`Data source not found: ${reference}`);
    process.exit(1);
  }
  deleteDocument(doc.id);
  console.log(`Deleted data source: ${doc.name}`);
}

function boardsListCmd() {
  const boards = listBoards();
  if (boards.length === 0) {
    console.log("No boards found.");
    return;
  }
  console.log(`${boards.length} boards:\n`);
  for (const board of boards) {
    console.log(`[${board.id}] ${board.name}`);
    console.log(`  active: ${board.isActive ? "yes" : "no"}  tasks: ${board.taskCount}`);
    if (board.description) console.log(`  ${board.description}`);
  }
}

function boardsCreateCmd(args: string[]) {
  const name = args[0];
  if (!name) {
    console.error("Usage: dpc boards create <name> [--description <text>]");
    process.exit(1);
  }
  const board = createBoard({ name, description: readOption(args, "--description") ?? null });
  console.log(`Created board: ${board.name}`);
  console.log(`  ID: ${board.id}`);
}

function boardsDeleteCmd(boardId?: string) {
  if (!boardId) {
    console.error("Usage: dpc boards delete <board-id>");
    process.exit(1);
  }
  deleteBoard(boardId);
  console.log(`Deleted board: ${boardId}`);
}

function boardsTasksCmd(args: string[]) {
  const boardId = readOption(args, "--board");
  const organizationId = readOption(args, "--organization");
  const goalId = readOption(args, "--goal");
  const tasks = listBoardTasks(boardId, { organizationId: organizationId ?? null, goalId: goalId ?? null });
  if (tasks.length === 0) {
    console.log("No board tasks found.");
    return;
  }
  console.log(`${tasks.length} board task(s):\n`);
  for (const task of tasks) {
    console.log(`[${task.id}] ${task.title}`);
    console.log(`  board: ${task.boardName || task.boardId}  status: ${task.status}  priority: ${task.priority}`);
    console.log(`  workflow template: ${task.workflowTemplateKey || "(plain task)"}  workflow: ${task.workflowId || "(none)"}`);
  }
}

function boardsCreateTaskCmd(args: string[]) {
  const title = args[0];
  const boardId = readOption(args, "--board") || "main-board";
  if (!title) {
    console.error("Usage: dpc boards create-task <title> [--board <board-id>] [--description <text>] [--template <template-key>] [--organization <org>] [--goal <goal>] [--priority <low|medium|high>] [--agent <agent-id>]");
    process.exit(1);
  }
  const task = createBoardTask({
    boardId,
    title,
    description: readOption(args, "--description") ?? null,
    workflowTemplateKey: readOption(args, "--template") ?? null,
    organizationId: readOption(args, "--organization") ?? null,
    goalId: readOption(args, "--goal") ?? null,
    priority: (readOption(args, "--priority") as "low" | "medium" | "high" | undefined) ?? "medium",
    assignedAgentId: readOption(args, "--agent") ?? null,
    sourceType: readOption(args, "--source-type") ?? null,
    sourceRef: readOption(args, "--source-ref") ?? null,
  });
  console.log(`Created board task: ${task.title}`);
  console.log(`  ID: ${task.id}`);
}

async function boardsRunTaskCmd(taskId?: string) {
  if (!taskId) {
    console.error("Usage: dpc boards run-task <task-id>");
    process.exit(1);
  }
  const result = await runWorkflowBackedBoardTask(taskId);
  console.log(`Task run started: ${result.taskId}`);
  console.log(`  Workflow: ${result.workflowName} (${result.workflowId})`);
  console.log(`  Execution: ${result.executionId}`);
  console.log(`  Status: ${result.executionStatus}`);
  if (result.response) {
    console.log(`\n${result.response}`);
  }
}

function boardsClaimTaskCmd(taskId?: string, agentId?: string) {
  if (!taskId || !agentId) {
    console.error("Usage: dpc boards claim-task <task-id> <agent-id>");
    process.exit(1);
  }
  const task = claimBoardTask(taskId, agentId);
  console.log(`Claimed task: ${task.title}`);
  console.log(`  Checked out by: ${task.checkedOutByAgentName || task.checkedOutByAgentId}`);
}

function boardsReleaseTaskCmd(taskId?: string, agentId?: string) {
  if (!taskId) {
    console.error("Usage: dpc boards release-task <task-id> [agent-id]");
    process.exit(1);
  }
  const task = releaseBoardTask(taskId, agentId || null);
  console.log(`Released task: ${task.title}`);
}

function boardsDeleteTaskCmd(taskId?: string) {
  if (!taskId) {
    console.error("Usage: dpc boards delete-task <task-id>");
    process.exit(1);
  }
  deleteBoardTask(taskId);
  console.log(`Deleted board task: ${taskId}`);
}

function orgsListCmd() {
  const orgs = listHierarchyOrganizations();
  if (orgs.length === 0) {
    console.log("No organizations found.");
    return;
  }
  console.log(`${orgs.length} organization(s):\n`);
  for (const org of orgs) {
    console.log(`[${org.id}] ${org.name}${org.isActive ? " (active)" : ""}`);
    console.log(`  members: ${org.memberCount}`);
    if (org.mission) console.log(`  mission: ${org.mission}`);
  }
}

function orgsCurrentCmd() {
  const org = getActiveHierarchyOrganization();
  if (!org) {
    console.log("No active organization.");
    return;
  }
  console.log(`${org.name}`);
  console.log(`  ID: ${org.id}`);
  console.log(`  Members: ${org.memberCount}`);
  if (org.description) console.log(`  Description: ${org.description}`);
  if (org.mission) console.log(`  Mission: ${org.mission}`);
}

function orgsSaveCurrentCmd(args: string[]) {
  const name = args[0];
  if (!name) {
    console.error("Usage: dpc orgs save-current <name> [--description <text>] [--mission <text>] [--no-activate]");
    process.exit(1);
  }
  const org = saveCurrentHierarchyOrganization({
    name,
    description: readOption(args, "--description") ?? null,
    mission: readOption(args, "--mission") ?? null,
    activate: !hasFlag(args, "--no-activate"),
  });
  console.log(`Saved organization: ${org.name}`);
  console.log(`  ID: ${org.id}`);
}

function orgsSwitchCmd(reference?: string) {
  if (!reference) {
    console.error("Usage: dpc orgs switch <id-or-name>");
    process.exit(1);
  }
  const org = applyHierarchyOrganization(reference);
  console.log(`Active organization: ${org.name}`);
  console.log(`  ID: ${org.id}`);
}

function orgsDeleteCmd(reference?: string) {
  if (!reference) {
    console.error("Usage: dpc orgs delete <id-or-name>");
    process.exit(1);
  }
  deleteHierarchyOrganization(reference);
  console.log(`Deleted organization: ${reference}`);
}

function orgsExportCmd(reference?: string, outputPathRaw?: string) {
  const organization =
    (reference ? resolveHierarchyOrganization(reference) : null) ??
    getActiveHierarchyOrganization();
  if (!organization) {
    console.error("Organization not found.");
    process.exit(1);
  }
  const pkg = exportCompanyPackage(organization.id);
  const defaultPath = path.resolve("data", "exports", `${slugifyForFile(organization.name)}.disp8ch-org.json`);
  const outputPath = path.resolve(outputPathRaw || defaultPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
  console.log(`Exported organization: ${organization.name}`);
  console.log(`  file: ${outputPath}`);
}

function orgsImportCmd(filePath?: string) {
  if (!filePath) {
    console.error("Usage: dpc orgs import <file>");
    process.exit(1);
  }
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    console.error(`File not found: ${resolved}`);
    process.exit(1);
  }
  const parsed = JSON.parse(fs.readFileSync(resolved, "utf8")) as Parameters<typeof importCompanyPackage>[0];
  const imported = importCompanyPackage(parsed, { activate: true });
  console.log(`Imported organization pack from ${resolved}`);
  console.log(`  organization: ${imported.organizationId}`);
  console.log(`  agents: ${imported.agentIds.length}`);
  console.log(`  goals: ${imported.goalIds.length}`);
}

function orgsImportTemplateCmd(sourcePath?: string) {
  if (!sourcePath) {
    console.error("Usage: dpc orgs import-template <path>");
    process.exit(1);
  }
  const resolved = path.resolve(sourcePath);
  if (!fs.existsSync(resolved)) {
    console.error(`Path not found: ${resolved}`);
    process.exit(1);
  }
  const imported = importExternalCompanyTemplate(resolved, { activate: true });
  console.log(`Imported external company template from ${resolved}`);
  console.log(`  organization: ${imported.organizationId}`);
  console.log(`  agents: ${imported.agentIds.length}`);
  console.log(`  goals: ${imported.goalIds.length}`);
  console.log(`  package: ${imported.package.organization.name}`);
}

function goalsListCmd(args: string[]) {
  const organizationReference = readOption(args, "--organization");
  const organizationId = organizationReference
    ? (listHierarchyOrganizations().find((org) => org.id === organizationReference || org.name === organizationReference)?.id ?? organizationReference)
    : null;
  const goals = listHierarchyGoals({ organizationId });
  if (goals.length === 0) {
    console.log("No goals found.");
    return;
  }
  console.log(`${goals.length} goal(s):\n`);
  for (const goal of goals) {
    console.log(`[${goal.id}] ${goal.name}`);
    console.log(`  organization: ${goal.organizationName || goal.organizationId || "(none)"}`);
    console.log(`  parent: ${goal.parentGoalName || goal.parentGoalId || "(root)"}`);
  }
}

function goalsCreateCmd(args: string[]) {
  const name = args[0];
  if (!name) {
    console.error("Usage: dpc goals create <name> [--organization <org>] [--description <text>] [--parent <goal>]");
    process.exit(1);
  }
  const goal = createHierarchyGoal({
    name,
    description: readOption(args, "--description") ?? null,
    organizationId: readOption(args, "--organization") ?? null,
    parentGoalId: readOption(args, "--parent") ?? null,
  });
  console.log(`Created goal: ${goal.name}`);
  console.log(`  ID: ${goal.id}`);
}

function goalsDeleteCmd(goalId?: string) {
  if (!goalId) {
    console.error("Usage: dpc goals delete <goal-id>");
    process.exit(1);
  }
  deleteHierarchyGoal(goalId);
  console.log(`Deleted goal: ${goalId}`);
}

async function extensionsListCmd() {
  const agent = getDefaultAgent();
  const entries = buildGlobalExtensionEntries(agent.enabledExtensions);
  const runtimeBacked = new Set(listRuntimeBackedExtensionIds());
  if (entries.length === 0) {
    console.log("No extensions found.");
    return;
  }
  for (const entry of entries) {
    console.log(`${entry.name} (${entry.id})`);
    console.log(`  source: ${entry.source}/${entry.installSource}`);
    console.log(`  globally enabled: ${entry.globallyEnabled ? "yes" : "no"}`);
    console.log(`  enabled for default agent: ${entry.agentEnabled ? "yes" : "no"}`);
    console.log(`  runtime available: ${entry.runtimePath || runtimeBacked.has(entry.id) ? "yes" : "no"}`);
    if (entry.sourceRef) {
      console.log(`  source ref: ${entry.sourceRef}`);
    }
    if (entry.sourceRevision) {
      console.log(`  revision: ${entry.sourceRevision}`);
    }
    console.log(`  config keys: ${Object.keys(entry.config).join(", ") || "none"}`);
  }
}

async function extensionsStatusCmd() {
  const agent = getDefaultAgent();
  const entries = buildGlobalExtensionEntries(agent.enabledExtensions);
  const runtime = await getExtensionRuntimeStatus();
  const runtimeById = new Map(runtime.extensions.map((entry) => [entry.id, entry]));
  console.log(JSON.stringify({
    source: "cli-live",
    defaultAgentId: agent.id,
    extensions: entries.map((entry) => ({
      id: entry.id,
      name: entry.name,
      description: entry.description,
      source: entry.source,
      installSource: entry.installSource,
      sourceRef: entry.sourceRef ?? null,
      sourceRevision: entry.sourceRevision ?? null,
      globallyEnabled: entry.globallyEnabled,
      enabledForDefaultAgent: entry.agentEnabled ?? false,
      runtimeAvailable: Boolean(entry.runtimePath) || Boolean(runtimeById.get(entry.id)?.hasRuntime),
      runtimeHooks: runtimeById.get(entry.id)?.hooks ?? [],
      runtimeStatus: runtimeById.get(entry.id)?.status ?? null,
      config: entry.config,
    })),
  }, null, 2));
}

async function extensionsInstallCmd(source?: string, ref?: string) {
  if (!source) {
    console.error("Usage: dpc extensions install <source> [ref]");
    process.exit(1);
  }
  const existingIds = new Set(buildGlobalExtensionEntries().map((entry) => entry.id));
  const installed = installExternalExtension({
    source,
    ref: ref ?? null,
  });
  if (!existingIds.has(installed.id)) {
    setGlobalExtensionEnabled(installed.id, false);
  }
  await loadExtensionRuntimeRegistry();
  console.log(`Installed external extension: ${installed.id}`);
  console.log(`  source: ${installed.installSource}`);
  console.log(`  ref: ${installed.sourceRef}`);
  if (installed.sourceRevision) {
    console.log(`  revision: ${installed.sourceRevision}`);
  }
  console.log("  global enabled: no (default)");
}

async function extensionsUpdateCmd(extensionId?: string) {
  if (!extensionId) {
    console.error("Usage: dpc extensions update <id>");
    process.exit(1);
  }
  const installed = updateExternalExtension(extensionId);
  await loadExtensionRuntimeRegistry();
  console.log(`Updated external extension: ${installed.id}`);
  console.log(`  source: ${installed.installSource}`);
  console.log(`  ref: ${installed.sourceRef}`);
  if (installed.sourceRevision) {
    console.log(`  revision: ${installed.sourceRevision}`);
  }
}

async function extensionsUninstallCmd(extensionId?: string) {
  if (!extensionId) {
    console.error("Usage: dpc extensions uninstall <id>");
    process.exit(1);
  }
  const removed = uninstallExternalExtension(extensionId);
  if (!removed) {
    console.error(`External extension not found: ${extensionId}`);
    process.exit(1);
  }
  clearGlobalExtensionState(extensionId);
  pruneExtensionReferences(extensionId);
  await loadExtensionRuntimeRegistry();
  console.log(`Removed external extension: ${extensionId}`);
}

function extensionsEnableCmd(extensionId?: string) {
  if (!extensionId) {
    console.error("Usage: dpc extensions enable <id>");
    process.exit(1);
  }
  const entry = setGlobalExtensionEnabled(extensionId, true);
  console.log(`Enabled globally: ${entry.name} (${entry.id})`);
}

function extensionsDisableCmd(extensionId?: string) {
  if (!extensionId) {
    console.error("Usage: dpc extensions disable <id>");
    process.exit(1);
  }
  const entry = setGlobalExtensionEnabled(extensionId, false);
  console.log(`Disabled globally: ${entry.name} (${entry.id})`);
}

function extensionsConfigGetCmd(extensionId?: string) {
  if (!extensionId) {
    console.error("Usage: dpc extensions config-get <id>");
    process.exit(1);
  }
  console.log(JSON.stringify(getExtensionGlobalConfig(extensionId), null, 2));
}

function extensionsConfigSetCmd(extensionId?: string, rawJson?: string) {
  if (!extensionId || !rawJson) {
    console.error("Usage: dpc extensions config-set <id> <json>");
    process.exit(1);
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawJson) as Record<string, unknown>;
  } catch (error) {
    console.error(`Invalid JSON: ${String(error)}`);
    process.exit(1);
  }
  const entry = setGlobalExtensionConfig(extensionId, parsed);
  console.log(`Saved config for ${entry.name} (${entry.id})`);
}

function skillsListCmd() {
  const agent = getDefaultAgent();
  const verbose = process.argv.includes("--verbose") || process.argv.includes("-v");
  const entries = verbose
    ? listInstalledSkillCatalog({ agentWorkspacePath: agent.workspacePath })
    : listInstalledSkillInventory({ agentWorkspacePath: agent.workspacePath });
  const externalPacks = listExternalSkillPacks();

  if (entries.length === 0) {
    console.log("No skill packs found.");
  } else {
    console.log(`Skill packs visible to default agent (${agent.name}):\n`);
    for (const entry of entries) {
      console.log(`${entry.label} (${entry.id})`);
      console.log(`  source: ${entry.source}`);
      if (entry.extensionId) {
        console.log(`  extension: ${entry.extensionId}`);
      }
      if (verbose) {
        console.log(`  path: ${entry.skillPath}`);
      }
    }
  }

  console.log("\nSkill roots:");
  console.log(`  workspace: ${path.join(WORKSPACE_PATH, "skills")}`);
  console.log(`  agent (${agent.id}): ${path.join(agent.workspacePath, "skills")}`);
  console.log(`  external: ${path.resolve("data", "skills-external")}`);

  if (externalPacks.length > 0) {
    console.log(`\nExternal skill packs (${externalPacks.length}):\n`);
    for (const pack of externalPacks) {
      console.log(`${pack.name} (${pack.id})`);
      console.log(`  source: ${pack.installSource}`);
      console.log(`  ref: ${pack.sourceRef}`);
      if (pack.sourceRevision) {
        console.log(`  revision: ${pack.sourceRevision}`);
      }
      console.log(`  skills: ${pack.skillCount}`);
    }
  }
}

function skillsInstallCmd(source?: string, ref?: string) {
  if (!source) {
    console.error("Usage: dpc skills install <source> [ref]");
    process.exit(1);
  }
  const installed = installExternalSkillPack({
    source,
    ref: ref ?? null,
  });
  console.log(`Installed external skill pack: ${installed.id}`);
  console.log(`  source: ${installed.installSource}`);
  console.log(`  ref: ${installed.sourceRef}`);
  console.log(`  skills: ${installed.skillCount}`);
  if (installed.sourceRevision) {
    console.log(`  revision: ${installed.sourceRevision}`);
  }
}

function skillsUpdateCmd(skillPackId?: string) {
  if (!skillPackId) {
    console.error("Usage: dpc skills update <id>");
    process.exit(1);
  }
  const updated = updateExternalSkillPack(skillPackId);
  console.log(`Updated external skill pack: ${updated.id}`);
  console.log(`  source: ${updated.installSource}`);
  console.log(`  ref: ${updated.sourceRef}`);
  console.log(`  skills: ${updated.skillCount}`);
  if (updated.sourceRevision) {
    console.log(`  revision: ${updated.sourceRevision}`);
  }
}

function skillsUninstallCmd(skillPackId?: string) {
  if (!skillPackId) {
    console.error("Usage: dpc skills uninstall <id>");
    process.exit(1);
  }
  const removed = uninstallExternalSkillPack(skillPackId);
  if (!removed) {
    console.error(`External skill pack not found: ${skillPackId}`);
    process.exit(1);
  }
  pruneSkillPackReferences(skillPackId);
  console.log(`Removed external skill pack: ${skillPackId}`);
}

function skillsImportReferenceCmd(repoPath?: string) {
  if (!repoPath) {
    console.error("Usage: dpc skills import-reference <repo-path>");
    process.exit(1);
  }
  const imported = importExternalSkillLibraryRepo(repoPath);
  console.log(`Imported external reference skills from ${imported.repoPath}`);
  console.log(`  skill pack: ${imported.importedPack.id}`);
  console.log(`  skills: ${imported.skillCount}`);
}

function skillsImportWorkspaceCmd(repoPath?: string) {
  if (!repoPath) {
    console.error("Usage: dpc skills import-workspace <repo-path>");
    process.exit(1);
  }
  const imported = importWorkspaceSkillLibraryRepo(repoPath);
  console.log(`Imported workspace skills from ${imported.repoPath}`);
  console.log(`  skill pack: ${imported.importedPack.id}`);
  console.log(`  skills: ${imported.skillCount}`);
  if (imported.recommendedExtensionIds.length > 0) {
    console.log(`  runtime-backed extension matches: ${imported.recommendedExtensionIds.join(", ")}`);
  }
}

function learningStatusCmd() {
  console.log(formatLearningStatusMarkdown());
}

function learningCandidatesCmd() {
  const candidates = listLearningCandidates("all");
  if (candidates.length === 0) {
    console.log("No learning candidates yet.");
    return;
  }
  for (const candidate of candidates) {
    console.log(`${candidate.title} (${candidate.id})`);
    console.log(`  status: ${candidate.status}`);
    console.log(`  kind: ${candidate.kind}`);
    console.log(`  evidence: ${candidate.evidenceCount}`);
    if (candidate.targetPath) {
      console.log(`  target: ${candidate.targetPath}`);
    }
  }
}

function learningEventsCmd() {
  const events = listLearningEvents(20);
  if (events.length === 0) {
    console.log("No learning events yet.");
    return;
  }
  for (const event of events) {
    console.log(`${event.title} (${event.id})`);
    console.log(`  kind: ${event.kind}`);
    console.log(`  summary: ${event.summary}`);
    console.log(`  at: ${event.createdAt}`);
  }
}

async function learningPromoteCmd(reference?: string) {
  const promoted = await promoteLearningCandidate(reference || "latest");
  console.log(`Promoted learning candidate: ${promoted.title}`);
  if (promoted.targetPath) {
    console.log(`  target: ${promoted.targetPath}`);
  }
}

function learningDismissCmd(reference?: string) {
  const dismissed = dismissLearningCandidate(reference || "latest");
  console.log(`Dismissed learning candidate: ${dismissed.title}`);
}

// ============================================================================
// Router
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const sub = args[1];

  switch (cmd) {
    case "init":
      initCmd(args.slice(1));
      break;

    case "models":
      switch (sub) {
        case "list": modelsListCmd(); break;
        case "recommend": modelsRecommendCmd(args[2]); break;
        case "add": {
          const provider = args[2];
          const addArgs = args.slice(3);
          const positional: string[] = [];
          const options: string[] = [];

          for (let i = 0; i < addArgs.length; i++) {
            const token = String(addArgs[i] || "");
            if (token.startsWith("--")) {
              options.push(token);
              if (token === "--model") {
                const value = String(addArgs[i + 1] || "");
                if (value) {
                  options.push(value);
                  i += 1;
                }
              }
              continue;
            }
            positional.push(token);
          }

          await modelsAddCmd(provider, positional[0], positional[1], ...options);
          break;
        }
        case "probe": await modelsProbeCmd(args[2]); break;
        case "probe-tools": await modelsProbeToolsCmd(args[2]); break;
        case "remove": modelsRemoveCmd(args[2]); break;
        case "set-priority": modelsSetPriorityCmd(args[2], args[3]); break;
        default: console.error("Unknown models command. Try: list, recommend, add, probe, probe-tools, remove, set-priority"); break;
      }
      break;

    case "memory":
      switch (sub) {
        case "tier": memoryTierCmd(); break;
        case "embedding-status": await memoryEmbeddingStatusCmd(); break;
        case "rebuild-index": await memoryRebuildIndexCmd(); break;
        case "index-sessions": await memoryIndexSessionsCmd(); break;
        case "index-collections": await memoryIndexCollectionsCmd(); break;
        case "backfill": memoryBackfillCmd(); break;
        case "stats": memoryStatsCmd(); break;
        case "list": memoryListCmd(); break;
        case "search": memorySearchCmd(args.slice(2).join(" ")); break;
        case "clear": memoryClearCmd(); break;
        default: console.error("Unknown memory command. Try: embedding-status, stats, list, search, clear, rebuild-index, index-sessions, index-collections, backfill"); break;
      }
      break;

    case "workflows":
      switch (sub) {
        case "list": workflowsListCmd(); break;
        case "create": await workflowsCreateCmd(args[2], args[3]); break;
        case "delete": workflowsDeleteCmd(args[2]); break;
        default: console.error("Unknown workflows command. Try: list, create, delete"); break;
      }
      break;

    case "agents":
      switch (sub) {
        case "list": agentsListCmd(); break;
        case "create": agentsCreateCmd(args.slice(2)); break;
        case "update": agentsUpdateCmd(args.slice(2)); break;
        case "delete": agentsDeleteCmd(args[2]); break;
        case "default": agentsDefaultCmd(); break;
        default: console.error("Unknown agents command. Try: list, create, update, delete, default"); break;
      }
      break;

    case "data-sources":
      switch (sub) {
        case "list": dataSourcesListCmd(); break;
        case "search": dataSourcesSearchCmd(args.slice(2).join(" ")); break;
        case "get": dataSourcesGetCmd(args[2]); break;
        case "upload": await dataSourcesUploadCmd(args.slice(2)); break;
        case "scrape": await dataSourcesScrapeCmd(args.slice(2)); break;
        case "crawl": await dataSourcesCrawlCmd(args.slice(2)); break;
        case "delete": dataSourcesDeleteCmd(args[2]); break;
        default: console.error("Unknown data-sources command. Try: list, search, get, upload, scrape, crawl, delete"); break;
      }
      break;

    case "boards":
      switch (sub) {
        case "list": boardsListCmd(); break;
        case "create": boardsCreateCmd(args.slice(2)); break;
        case "delete": boardsDeleteCmd(args[2]); break;
        case "tasks": boardsTasksCmd(args.slice(2)); break;
        case "create-task": boardsCreateTaskCmd(args.slice(2)); break;
        case "run-task": await boardsRunTaskCmd(args[2]); break;
        case "claim-task": boardsClaimTaskCmd(args[2], args[3]); break;
        case "release-task": boardsReleaseTaskCmd(args[2], args[3]); break;
        case "delete-task": boardsDeleteTaskCmd(args[2]); break;
        default: console.error("Unknown boards command. Try: list, create, delete, tasks, create-task, run-task, claim-task, release-task, delete-task"); break;
      }
      break;

    case "orgs":
      switch (sub) {
        case "list": orgsListCmd(); break;
        case "current": orgsCurrentCmd(); break;
        case "save-current": orgsSaveCurrentCmd(args.slice(2)); break;
        case "switch": orgsSwitchCmd(args[2]); break;
        case "delete": orgsDeleteCmd(args[2]); break;
        case "export": orgsExportCmd(args[2], args[3]); break;
        case "import": orgsImportCmd(args[2]); break;
        case "import-template": orgsImportTemplateCmd(args[2]); break;
        default: console.error("Unknown orgs command. Try: list, current, save-current, switch, delete, export, import, import-template"); break;
      }
      break;

    case "goals":
      switch (sub) {
        case "list": goalsListCmd(args.slice(2)); break;
        case "create": goalsCreateCmd(args.slice(2)); break;
        case "delete": goalsDeleteCmd(args[2]); break;
        default: console.error("Unknown goals command. Try: list, create, delete"); break;
      }
      break;

    case "extensions":
      switch (sub) {
        case "list": await extensionsListCmd(); break;
        case "status": await extensionsStatusCmd(); break;
        case "install": await extensionsInstallCmd(args[2], args[3]); break;
        case "update": await extensionsUpdateCmd(args[2]); break;
        case "uninstall": await extensionsUninstallCmd(args[2]); break;
        case "enable": extensionsEnableCmd(args[2]); break;
        case "disable": extensionsDisableCmd(args[2]); break;
        case "config-get": extensionsConfigGetCmd(args[2]); break;
        case "config-set": extensionsConfigSetCmd(args[2], args[3]); break;
        default: console.error("Unknown extensions command. Try: list, status, install, update, uninstall, enable, disable, config-get, config-set"); break;
      }
      break;

    case "skills":
      switch (sub) {
        case "list": skillsListCmd(); break;
        case "install": skillsInstallCmd(args[2], args[3]); break;
        case "update": skillsUpdateCmd(args[2]); break;
        case "uninstall": skillsUninstallCmd(args[2]); break;
        case "import-reference": skillsImportReferenceCmd(args[2]); break;
        case "import-workspace": skillsImportWorkspaceCmd(args[2]); break;
        default: helpCmd(); process.exit(1);
      }
      break;

    case "learning":
      switch (sub) {
        case "status": learningStatusCmd(); break;
        case "candidates": learningCandidatesCmd(); break;
        case "events": learningEventsCmd(); break;
        case "promote": await learningPromoteCmd(args[2]); break;
        case "dismiss": learningDismissCmd(args[2]); break;
        default: console.error("Unknown learning command. Try: status, candidates, events, promote, dismiss"); break;
      }
      break;

    case "backup":
      switch (sub) {
        case "create": await backupCreateCmd(); break;
        case "list": backupListCmd(); break;
        case "verify": backupVerifyCmd(args[2]); break;
        case "status": backupStatusCmd(); break;
        case "run-policy": await backupRunPolicyCmd(); break;
        default: console.error("Unknown backup command. Try: create, list, verify, status, run-policy"); break;
      }
      break;

    case "acp":
      switch (sub) {
        case "status": await acpStatusCmd(); break;
        case "test": await acpTestCmd(args.slice(1)); break;
        case "sessions": await acpSessionsCmd(args.slice(1)); break;
        case "reset-session": await acpResetSessionCmd(args.slice(1)); break;
        case "serve": await acpServeCmd(args.slice(1)); break;
        default: console.error("Unknown acp command. Try: status, test, sessions, reset-session, serve"); break;
      }
      break;

    case "config":
      switch (sub) {
        case "show": configShowCmd(args.includes("--json") || args.includes("-j")); break;
        case "get": configGetCmd(args[2]); break;
        case "set": configSetCmd(args[2], args[3]); break;
        case "validate": configValidateCmd(); break;
        default: console.error("Unknown config command. Try: show, get, set, validate"); break;
      }
      break;

    case "secrets":
      switch (sub) {
        case "list": secretsListCmd(); break;
        case "set": secretsSetCmd(args[2], args.slice(3).join(" ")); break;
        case "remove": secretsRemoveCmd(args[2]); break;
        default: console.error("Unknown secrets command. Try: list, set, remove"); break;
      }
      break;

    case "auth":
      switch (sub) {
        case "google": await authGoogleCmd(args.includes("--manual")); break;
        case "status": authStatusCmd(); break;
        case "revoke": authRevokeCmd(); break;
        default: console.error("Unknown auth command. Try: google, status, revoke"); break;
      }
      break;

    case "status": statusCmd(); break;
    case "health": healthCmd(args.includes("--json")); break;
    case "doctor": doctorCmd(args.includes("--repair"), args.includes("--json")); break;
    case "update": updateCmd(args); break;
    case "env": envCmd(); break;
    case "help": case "--help": case "-h": case undefined: helpCmd(); break;
    default:
      console.error(`Unknown command: ${cmd}`);
      helpCmd();
      break;
  }
}

function shouldKeepCliProcessAlive(args: string[]): boolean {
  const cmd = String(args[0] || "");
  const sub = String(args[1] || "");
  if (cmd === "acp" && sub === "serve") return true;
  if (cmd === "auth" && sub === "google") return true;
  return false;
}

function flushCliStreamsAndExit(code: number): void {
  const done = () => process.exit(code);
  let pending = 2;
  const fallbackTimer = setTimeout(done, 25);
  const mark = () => {
    pending -= 1;
    if (pending <= 0) {
      clearTimeout(fallbackTimer);
      done();
    }
  };
  try {
    process.stdout.write("", mark);
  } catch {
    mark();
  }
  try {
    process.stderr.write("", mark);
  } catch {
    mark();
  }
}

const cliArgs = process.argv.slice(2);

main().then(() => {
  if (!shouldKeepCliProcessAlive(cliArgs)) {
    flushCliStreamsAndExit(0);
  }
}).catch((error) => {
  console.error(String(error));
  flushCliStreamsAndExit(1);
});
