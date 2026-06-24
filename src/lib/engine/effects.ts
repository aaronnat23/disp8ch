/**
 * Canonical workflow effect model.
 *
 * Every executable node resolves to a single `EffectDescriptor` immediately
 * before its handler runs. The descriptor — not the UI category name — is what
 * the executor guard (`node-policy-guard.ts`) uses to decide whether a node may
 * run automatically, must be approved, or is unconditionally blocked.
 *
 * Design rules (see docs/improvements/workflow-approval-and-memory-scope-plan):
 *  - One classifier. No second node registry.
 *  - Configuration-sensitive nodes (HTTP, SQL, git, ...) use a runtime resolver,
 *    so an HTTP POST is an external write while an HTTP GET is a read.
 *  - Unknown behaviour fails closed (`kind: "unknown"`).
 *  - A tiny hardline floor blocks catastrophic host operations that no approval
 *    mode — human, model, saved grant, cron, or retry — can authorize.
 */

export type EffectKind =
  | "none"
  | "read"
  | "local_write"
  | "external_write"
  | "external_send"
  | "credential_change"
  | "financial"
  | "destructive"
  | "unknown";

export type EffectRisk = "low" | "medium" | "high" | "critical";

export interface EffectDescriptor {
  kind: EffectKind;
  risk: EffectRisk;
  reversible: boolean;
  target: string | null;
  summary: string;
  details: Record<string, unknown>;
}

export type EffectResolver = (
  config: Record<string, unknown>,
  input?: Record<string, unknown>,
) => EffectDescriptor;

const KIND_ORDER: Record<EffectKind, number> = {
  none: 0,
  read: 1,
  local_write: 2,
  external_write: 3,
  external_send: 4,
  credential_change: 5,
  financial: 6,
  destructive: 7,
  unknown: 8,
};

const RISK_ORDER: Record<EffectRisk, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

export function compareKind(a: EffectKind, b: EffectKind): number {
  return KIND_ORDER[a] - KIND_ORDER[b];
}

export function compareRisk(a: EffectRisk, b: EffectRisk): number {
  return RISK_ORDER[a] - RISK_ORDER[b];
}

/** Effects that are observable outside the local machine or hard to reverse. */
export function isMaterialEffect(effect: EffectDescriptor): boolean {
  return effect.kind !== "none" && effect.kind !== "read";
}

export function effect(
  kind: EffectKind,
  risk: EffectRisk,
  opts: { reversible?: boolean; target?: string | null; summary: string; details?: Record<string, unknown> },
): EffectDescriptor {
  return {
    kind,
    risk,
    reversible: opts.reversible ?? true,
    target: opts.target ?? null,
    summary: opts.summary,
    details: opts.details ?? {},
  };
}

function str(value: unknown, fallback = ""): string {
  if (value === null || value === undefined) return fallback;
  return String(value).trim();
}

function cfg(config: Record<string, unknown>, ...keys: string[]): string {
  // Reconcile both `config.x` and `config.config.x` shapes used across templates.
  const nested = config.config && typeof config.config === "object" && !Array.isArray(config.config)
    ? (config.config as Record<string, unknown>)
    : {};
  for (const key of keys) {
    const v = config[key] ?? nested[key];
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

// ──────────────────────────────────────────────────────────────────────────
// Static baseline. Every registered handler type must appear here so that the
// completeness test can prove no executable node falls through to `unknown`
// silently. Configuration-sensitive types also register a resolver below.
// ──────────────────────────────────────────────────────────────────────────

const READ: EffectDescriptor = effect("read", "low", { summary: "Reads data without changing anything." });
const NONE: EffectDescriptor = effect("none", "low", { summary: "In-memory step with no external effect." });
const LOCAL_WRITE: EffectDescriptor = effect("local_write", "medium", { summary: "Writes locally and is reversible." });
const EXTERNAL_WRITE: EffectDescriptor = effect("external_write", "high", { reversible: false, summary: "Writes to an external system." });
const EXTERNAL_SEND: EffectDescriptor = effect("external_send", "high", { reversible: false, summary: "Sends a message to an external recipient." });
const UNKNOWN: EffectDescriptor = effect("unknown", "high", { reversible: false, summary: "Behaviour cannot be classified; treated as unsafe." });

const STATIC_EFFECTS: Record<string, EffectDescriptor> = {
  // triggers + orchestration (no direct effect; child/body nodes are guarded individually)
  "manual-trigger": NONE,
  "message-trigger": NONE,
  "webhook-trigger": NONE,
  "cron-trigger": NONE,
  "github-trigger": NONE,
  "telegram-trigger": NONE,
  "discord-trigger": NONE,
  loop: NONE,
  merge: NONE,
  "if-else": NONE,
  switch: NONE,
  filter: NONE,
  "error-handler": NONE,
  delay: NONE,
  "rate-limiter": NONE,
  "sticky-note": NONE,
  "workflow-template": NONE,
  "set-variables": NONE,
  aggregate: NONE,
  "json-transform": NONE,
  "split-text": NONE,
  template: NONE,
  "compare-text": NONE,
  "regex-extract": NONE,
  "date-time": NONE,
  "call-workflow": effect("read", "low", { summary: "Calls a sub-workflow; the sub-workflow's own nodes are each guarded." }),

  // reads
  "read-file": READ,
  "rss-read": READ,
  "channel-status": READ,
  "memory-recall": READ,
  council: READ,
  "voice-stt": READ,
  secret: effect("read", "medium", { summary: "Reads a stored secret value." }),

  // agents — text synthesis; their tool calls go through the agent tool/MCP approval path
  "claude-agent": effect("read", "low", { summary: "AI agent step; its tool calls are gated by the agent tool and MCP approval paths." }),
  "parallel-agents": effect("read", "low", { summary: "Runs agent workers; each worker tool call is gated separately." }),

  // writes
  "write-file": LOCAL_WRITE,
  "memory-store": LOCAL_WRITE,
  archive: effect("local_write", "medium", { summary: "Extracts an archive to local files." }),
  "voice-tts": effect("local_write", "low", { summary: "Synthesizes a local audio file." }),
  "run-code": effect("local_write", "high", { reversible: false, summary: "Executes code that may touch the local filesystem." }),

  // external sends
  "send-email": EXTERNAL_SEND,
  "send-webchat": effect("external_send", "medium", { summary: "Replies in WebChat." }),
  "send-telegram": EXTERNAL_SEND,
  "send-discord": EXTERNAL_SEND,
  "send-slack": EXTERNAL_SEND,
  "send-sms": EXTERNAL_SEND,
  "send-whatsapp": EXTERNAL_SEND,
  "send-teams": EXTERNAL_SEND,
  "send-bluebubbles": EXTERNAL_SEND,
  "github-comment": EXTERNAL_SEND,
  "webhook-response": effect("external_send", "medium", { summary: "Sends an HTTP response to the webhook caller." }),
  notification: effect("external_send", "low", { summary: "Raises a local desktop notification." }),

  // external integrations
  airtable: EXTERNAL_WRITE,
  "google-sheets": EXTERNAL_WRITE,
  notion: EXTERNAL_WRITE,
  "integration-agent": effect("external_write", "high", { reversible: false, summary: "Integration agent; concrete tool calls may carry stronger effects." }),
  "spawn-coding-agent": effect("external_write", "high", { reversible: false, summary: "Spawns a coding agent that can modify code and run commands." }),

  // imported placeholders must never execute
  placeholder: effect("unknown", "high", { reversible: false, summary: "Imported placeholder with unknown behaviour; will not execute." }),
  "wait-for-input": effect("read", "low", { summary: "Pauses for human input." }),
};

// ──────────────────────────────────────────────────────────────────────────
// Configuration-sensitive resolvers.
// ──────────────────────────────────────────────────────────────────────────

const RESOLVERS: Record<string, EffectResolver> = {
  "http-request": (config) => {
    const method = (cfg(config, "method") || "GET").toUpperCase();
    const url = cfg(config, "url");
    if (method === "GET" || method === "HEAD") {
      return effect("read", "low", { target: url || null, summary: `HTTP ${method} (read).`, details: { method } });
    }
    if (method === "DELETE") {
      return effect("destructive", "high", { reversible: false, target: url || null, summary: `HTTP DELETE to ${url || "a remote endpoint"}.`, details: { method } });
    }
    // POST / PUT / PATCH and anything non-read
    return effect("external_write", "high", { reversible: false, target: url || null, summary: `HTTP ${method} to ${url || "a remote endpoint"}.`, details: { method } });
  },

  "database-query": (config) => {
    const sql = cfg(config, "query", "sql");
    const target = cfg(config, "dbPath") || null;
    return classifySql(sql, target);
  },

  "system-command": (config) => {
    const action = cfg(config, "action");
    const command = cfg(config, "command");
    const builtin = action || command;
    if (builtin === "pc-specs" || builtin === "list-files") {
      return effect("read", "low", { summary: `System ${builtin} (read).`, details: { action: builtin } });
    }
    if (builtin === "move-files") {
      return effect("local_write", "medium", { target: cfg(config, "destination") || null, summary: "Moves files locally.", details: { action: builtin } });
    }
    // free-form shell command: unknown side effects, treat as high external write
    if (command) {
      return effect("external_write", "high", { reversible: false, target: command, summary: "Runs a shell command.", details: { command } });
    }
    return UNKNOWN;
  },

  clipboard: (config) => {
    const action = (cfg(config, "action") || "read").toLowerCase();
    if (action === "write") {
      return effect("local_write", "low", { summary: "Writes to the system clipboard." });
    }
    return effect("read", "low", { summary: "Reads the system clipboard." });
  },

  "git-operation": (config) => {
    const action = (cfg(config, "action", "operation") || "status").toLowerCase();
    const repo = cfg(config, "repoPath") || null;
    if (action === "status" || action === "diff" || action === "log" || action === "show") {
      return effect("read", "low", { target: repo, summary: `git ${action} (read).`, details: { action } });
    }
    if (action === "add" || action === "commit") {
      return effect("local_write", "medium", { target: repo, summary: `git ${action} (local write).`, details: { action } });
    }
    if (action === "push") {
      return effect("external_write", "high", { reversible: false, target: repo, summary: "git push to a remote.", details: { action } });
    }
    if (action.includes("force") || action === "reset" || action === "hard-reset" || action === "clean") {
      return effect("destructive", "high", { reversible: false, target: repo, summary: `git ${action} (destructive).`, details: { action } });
    }
    return effect("local_write", "medium", { target: repo, summary: `git ${action}.`, details: { action } });
  },

  "document-tool": (config) => {
    const action = (cfg(config, "action") || "list").toLowerCase();
    if (action === "list" || action === "search" || action === "get") {
      return effect("read", "low", { summary: `Document ${action} (read).`, details: { action } });
    }
    if (action === "scrape") {
      return effect("local_write", "medium", { target: cfg(config, "url") || null, summary: "Scrapes a URL and persists the document.", details: { action } });
    }
    if (action === "delete") {
      return effect("destructive", "high", { reversible: false, target: cfg(config, "documentId") || cfg(config, "documentName") || null, summary: "Deletes a document.", details: { action } });
    }
    return effect("local_write", "medium", { summary: `Document ${action}.`, details: { action } });
  },

  "scheduler-job": (config) => {
    const action = (cfg(config, "action") || "list").toLowerCase();
    if (action === "list") {
      return effect("read", "low", { summary: "Lists scheduled jobs.", details: { action } });
    }
    if (action === "run") {
      // immediate run inherits the called workflow's effects; treat as external write until the child is classified
      return effect("external_write", "high", { reversible: false, target: cfg(config, "workflowId") || cfg(config, "workflowName") || null, summary: "Runs a scheduled workflow now (inherits its effects).", details: { action } });
    }
    // create / update / enable / disable / resync
    return effect("local_write", "medium", { summary: `Scheduler ${action}.`, details: { action } });
  },

  "board-task": (config) => {
    const action = (cfg(config, "action") || "list").toLowerCase();
    if (action === "list" || action === "search" || action === "get") {
      return effect("read", "low", { summary: `Board ${action} (read).`, details: { action } });
    }
    if (action === "delete") {
      return effect("destructive", "medium", { reversible: false, target: cfg(config, "taskId") || null, summary: "Deletes a board task.", details: { action } });
    }
    return effect("local_write", "low", { target: cfg(config, "boardId") || null, summary: `Board task ${action}.`, details: { action } });
  },
};

/** Classify a single-statement (or simple) SQL string. Fails closed for multi-statement. */
export function classifySql(sqlRaw: string, target: string | null): EffectDescriptor {
  const sql = String(sqlRaw || "").trim();
  if (!sql) return effect("read", "low", { target, summary: "Empty query.", details: {} });

  // Reject multi-statement SQL unless trivially terminated by a single trailing ';'.
  const withoutTrailing = sql.replace(/;\s*$/, "");
  if (withoutTrailing.includes(";")) {
    return effect("unknown", "high", { reversible: false, target, summary: "Multi-statement SQL is not classified statement-by-statement; treated as unsafe.", details: { multiStatement: true } });
  }
  const upper = withoutTrailing.toUpperCase();
  const verb = upper.split(/\s+/)[0] || "";

  if (verb === "SELECT" || (verb === "PRAGMA" && !/=/.test(upper)) || verb === "EXPLAIN" || verb === "WITH") {
    return effect("read", "low", { target, summary: `SQL ${verb} (read).`, details: { verb } });
  }
  if (verb === "INSERT" || verb === "UPSERT" || verb === "REPLACE") {
    return effect("local_write", "medium", { target, summary: `SQL ${verb} (local write).`, details: { verb } });
  }
  if (verb === "UPDATE" || verb === "DELETE") {
    const hasWhere = /\bWHERE\b/.test(upper);
    if (!hasWhere) {
      return effect("destructive", "critical", { reversible: false, target, summary: `Unbounded ${verb} with no WHERE clause.`, details: { verb, bounded: false } });
    }
    return effect("local_write", "high", { reversible: false, target, summary: `Bounded ${verb} (high-risk write).`, details: { verb, bounded: true } });
  }
  if (verb === "DROP" || verb === "TRUNCATE" || verb === "ALTER" || verb === "ATTACH" || verb === "DETACH" || verb === "VACUUM" || verb === "CREATE") {
    return effect("destructive", "critical", { reversible: false, target, summary: `Schema change: ${verb}.`, details: { verb } });
  }
  return effect("unknown", "high", { reversible: false, target, summary: `Unclassified SQL verb: ${verb}.`, details: { verb } });
}

/**
 * Resolve the canonical effect for a node. Configuration-sensitive nodes use a
 * resolver; everything else uses the static baseline. A registered executable
 * node with neither resolver nor baseline fails closed to `unknown`.
 */
export function resolveNodeEffect(
  nodeType: string,
  config: Record<string, unknown> = {},
  input?: Record<string, unknown>,
): EffectDescriptor {
  const resolver = RESOLVERS[nodeType];
  if (resolver) {
    try {
      return resolver(config, input);
    } catch {
      return UNKNOWN;
    }
  }
  const base = STATIC_EFFECTS[nodeType];
  if (base) return base;
  return UNKNOWN;
}

export function hasResolverOrBaseline(nodeType: string): boolean {
  return Boolean(RESOLVERS[nodeType] || STATIC_EFFECTS[nodeType]);
}

export function listKnownEffectTypes(): string[] {
  return Array.from(new Set([...Object.keys(STATIC_EFFECTS), ...Object.keys(RESOLVERS)])).sort();
}

// ──────────────────────────────────────────────────────────────────────────
// Hardline floor — catastrophic host operations with no recovery path.
// Runs before every approval mode and cannot be bypassed by model, human,
// saved grant, cron, or retry. Kept intentionally tiny.
// ──────────────────────────────────────────────────────────────────────────

const HARDLINE_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\bmkfs(\.\w+)?\b/i, reason: "formatting a filesystem" },
  { re: /\bformat\s+[a-z]:/i, reason: "formatting a drive" },
  { re: /\bdd\b[^\n]*\bof=\/dev\/(sd|nvme|hd|disk)/i, reason: "writing to a raw block device" },
  { re: />\s*\/dev\/(sd|nvme|hd|disk)\w*/i, reason: "writing to a raw block device" },
  { re: /\brm\s+-[a-z]*r[a-z]*f?\s+(--no-preserve-root\s+)?\/(\s|$|\*)/i, reason: "recursive deletion of a filesystem root" },
  { re: /\brm\s+-[a-z]*r[a-z]*f?\s+--no-preserve-root/i, reason: "recursive deletion of a filesystem root" },
  { re: /\b(shutdown|reboot|halt|poweroff)\b/i, reason: "shutting down or rebooting the host" },
  { re: /\bInitialize-Disk\b|\bFormat-Volume\b|\bClear-Disk\b/i, reason: "raw disk operation" },
  { re: /\b(kill(all)?|pkill)\s+-9\s+-1\b/i, reason: "process-wide kill that would terminate the host runtime" },
  { re: /:\(\)\s*\{\s*:\|:&\s*\}\s*;/, reason: "fork bomb" },
  { re: /\bStop-Computer\b|\bRestart-Computer\b/i, reason: "shutting down or rebooting the host" },
];

export interface HardlineResult {
  blocked: boolean;
  reason: string | null;
}

/** Shared hardline matcher so the workflow guard and dynamic runs use one floor. */
export function matchesHardlinePattern(text: string): string | null {
  const haystack = String(text || "");
  for (const { re, reason } of HARDLINE_PATTERNS) {
    if (re.test(haystack)) return reason;
  }
  return null;
}

/**
 * Returns a block reason when the node's resolved effect or its command/SQL
 * payload matches a catastrophic, non-recoverable operation. This is the floor
 * that no approval can lift.
 */
export function criticalNeverAllow(
  nodeType: string,
  config: Record<string, unknown> = {},
  effectDescriptor?: EffectDescriptor,
): HardlineResult {
  const haystacks: string[] = [];
  const command = cfg(config, "command", "script", "code", "args");
  if (command) haystacks.push(command);
  const sql = cfg(config, "query", "sql");
  if (sql) haystacks.push(sql);
  if (effectDescriptor?.target) haystacks.push(String(effectDescriptor.target));

  for (const text of haystacks) {
    for (const { re, reason } of HARDLINE_PATTERNS) {
      if (re.test(text)) {
        return { blocked: true, reason };
      }
    }
  }
  return { blocked: false, reason: null };
}
