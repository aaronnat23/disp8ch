type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEntry {
  level: LogLevel;
  message: string;
  context?: string;
  data?: Record<string, unknown>;
  timestamp: string;
}

// ── Redaction ────────────────────────────────────────────────────────────────

/** Patterns that match common API keys / secrets in string values */
const REDACT_PATTERNS: RegExp[] = [
  /\bsk-ant-[a-zA-Z0-9\-_]{20,}\b/g,          // Anthropic keys
  /\bsk-[a-zA-Z0-9\-_]{20,}\b/g,              // OpenAI-style keys
  /\bAIza[a-zA-Z0-9\-_]{35,}\b/g,             // Google API keys
  /\bBearer\s+[a-zA-Z0-9\-_.]{20,}/gi,        // Bearer tokens
  /\b(api[_-]?key|api_token|access_token|secret|password|bearer)\s*[:=]\s*['"]?[a-zA-Z0-9\-_.+/]{16,}['"]?/gi,
];

/** Object keys whose values are always redacted regardless of value length */
const SENSITIVE_KEYS = new Set([
  "api_key", "apikey", "api_token", "apitoken",
  "access_token", "accesstoken",
  "secret", "password", "passwd",
  "bearer", "authorization",
  "credential", "credentials",
  "token", "auth",
  "key",
]);

function isSensitiveKey(k: string): boolean {
  const lower = k.toLowerCase().replace(/[_\-]/g, "");
  return SENSITIVE_KEYS.has(lower) || SENSITIVE_KEYS.has(k.toLowerCase());
}

function redactString(value: string): string {
  let result = value;
  for (const pattern of REDACT_PATTERNS) {
    result = result.replace(pattern, "[REDACTED]");
    pattern.lastIndex = 0; // reset global regex state
  }
  return result;
}

function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return value;
  if (typeof value === "string") return redactString(value);
  if (value === null || value === undefined) return value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = isSensitiveKey(k) ? "[REDACTED]" : redactValue(v, depth + 1);
    }
    return result;
  }
  return value;
}

// ── Formatter ────────────────────────────────────────────────────────────────

function formatLog(entry: LogEntry): string {
  const prefix = `[${entry.timestamp}] [${entry.level.toUpperCase()}]`;
  const ctx = entry.context ? ` [${entry.context}]` : "";
  const message = redactString(entry.message);
  const data = entry.data ? ` ${JSON.stringify(redactValue(entry.data))}` : "";
  return `${prefix}${ctx} ${message}${data}`;
}

// ── Rolling file writer ───────────────────────────────────────────────────────
// Uses inline require() so webpack does not bundle node:fs/node:path into
// the client-side chunk when logger is imported by React components.

const LOG_MAX_BYTES = 50 * 1024 * 1024; // 50 MB per daily file — not configurable (disk safety cap)
const LOG_MAX_DAYS_DEFAULT = 7;

let _logMaxDays: number | null = null;
let _logDirEnsured = false;
let _pruned        = false;

/** Read log_max_days from DB once per process. Falls back to 7 if DB unavailable. */
function getLogMaxDays(): number {
  if (_logMaxDays !== null) return _logMaxDays;
  try {
    // eslint-disable-next-line
    const BetterSqlite3 = require("better-sqlite3") as new (path: string, opts?: { readonly?: boolean }) => {
      prepare(sql: string): { get(): unknown };
      close(): void;
    };
    // eslint-disable-next-line
    const pathMod = require("path") as typeof import("path");
    const dbPath = pathMod.resolve(process.env.DATABASE_PATH ?? "./data/disp8ch.db");
    const db = new BetterSqlite3(dbPath, { readonly: true });
    const row = db.prepare("SELECT log_max_days FROM app_config WHERE id = 'default'").get() as
      | { log_max_days?: number }
      | undefined;
    db.close();
    _logMaxDays = row?.log_max_days ?? LOG_MAX_DAYS_DEFAULT;
  } catch {
    _logMaxDays = LOG_MAX_DAYS_DEFAULT;
  }
  return _logMaxDays;
}

function getDailyLogPath(fsModule: typeof import("fs"), pathModule: typeof import("path")): string {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return pathModule.join(process.cwd(), "data", "logs", `${date}.log`);
}

function maybePruneOldLogs(fsModule: typeof import("fs"), pathModule: typeof import("path")): void {
  if (_pruned) return;
  _pruned = true;
  try {
    const dir = pathModule.join(process.cwd(), "data", "logs");
    const cutoff = Date.now() - getLogMaxDays() * 86_400_000;
    for (const file of fsModule.readdirSync(dir)) {
      if (!file.endsWith(".log")) continue;
      const fp = pathModule.join(dir, file);
      try {
        if (fsModule.statSync(fp).mtimeMs < cutoff) fsModule.unlinkSync(fp);
      } catch {}
    }
  } catch {}
}

function writeToLogFile(line: string): void {
  // Guard: skip in browser / edge environments
  if (typeof process === "undefined" || typeof process.cwd !== "function") return;
  try {
    // eslint-disable-next-line
    const fsModule = require("fs") as typeof import("fs");
    // eslint-disable-next-line
    const pathModule = require("path") as typeof import("path");

    const logDir = pathModule.join(process.cwd(), "data", "logs");

    if (!_logDirEnsured) {
      fsModule.mkdirSync(logDir, { recursive: true });
      _logDirEnsured = true;
    }

    maybePruneOldLogs(fsModule, pathModule);

    const fp = getDailyLogPath(fsModule, pathModule);
    try {
      if (fsModule.statSync(fp).size >= LOG_MAX_BYTES) return; // cap reached
    } catch {}
    fsModule.appendFileSync(fp, line + "\n");
  } catch {}
}

// ── Logger factory ────────────────────────────────────────────────────────────

function createLogger(context?: string) {
  const log = (level: LogLevel, message: string, data?: Record<string, unknown>) => {
    const entry: LogEntry = {
      level,
      message,
      context,
      data,
      timestamp: new Date().toISOString(),
    };

    const formatted = formatLog(entry);

    switch (level) {
      case "debug":
        if (process.env.NODE_ENV === "development") {
          process.stderr.write(formatted + "\n");
          writeToLogFile(formatted);
        }
        break;
      case "info":
        process.stderr.write(formatted + "\n");
        writeToLogFile(formatted);
        break;
      case "warn":
        process.stderr.write(formatted + "\n");
        writeToLogFile(formatted);
        break;
      case "error":
        process.stderr.write(formatted + "\n");
        writeToLogFile(formatted);
        break;
    }
  };

  return {
    debug: (message: string, data?: Record<string, unknown>) => log("debug", message, data),
    info:  (message: string, data?: Record<string, unknown>) => log("info",  message, data),
    warn:  (message: string, data?: Record<string, unknown>) => log("warn",  message, data),
    error: (message: string, data?: Record<string, unknown>) => log("error", message, data),
    child: (childContext: string) =>
      createLogger(context ? `${context}:${childContext}` : childContext),
  };
}

export const logger = createLogger();
