import { classifyFailure, type FailureCode } from "@/lib/utils/failure-contract";

export type ToolFailureCategory = FailureCode;

export type ToolFailureRecord = {
  tool: string;
  argsKey: string;
  category: ToolFailureCategory;
  count: number;
  lastError: string;
  doNotRetry: boolean;
  retryable: boolean;
  retryAfterMs: number | null;
  suggestedAction: "retry" | "change_input" | "configure" | "ask_user" | "switch_approach" | "stop";
};

const IDEMPOTENT_TOOLS = new Set([
  "read_file",
  "list_files",
  "search_files",
  "find_files",
  "web_search",
  "fetch_url",
  "memory_search",
  "memory_get",
  "document_get",
  "documents_search",
]);

export function isSafelyRetryableTool(tool: string): boolean {
  return IDEMPOTENT_TOOLS.has(tool);
}

function stableSignatureValue(value: unknown, seen: WeakSet<object>, depth = 0): unknown {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return String(value);
  if (depth >= 6) return "[max-depth]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    const normalized = value.slice(0, 50).map((entry) => stableSignatureValue(entry, seen, depth + 1));
    seen.delete(value);
    return normalized;
  }
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort().slice(0, 50)) {
    output[key] = stableSignatureValue((value as Record<string, unknown>)[key], seen, depth + 1);
  }
  seen.delete(value);
  return output;
}

export function toolCallSignature(args: Record<string, unknown>): string {
  return JSON.stringify(stableSignatureValue(args, new WeakSet<object>())).slice(0, 1200);
}

export class ToolFailureController {
  private records = new Map<string, ToolFailureRecord>();
  private blockedSignatures = new Set<string>();
  private noProgressCounts = new Map<string, number>();

  recordFailure(tool: string, args: Record<string, unknown>, error: unknown): {
    category: ToolFailureCategory;
    blocked: boolean;
    retryCount: number;
    guidance: string;
    retryable: boolean;
    retryAfterMs: number | null;
    suggestedAction: ToolFailureRecord["suggestedAction"];
  } {
    const errorStr = error instanceof Error ? error.message : String(error);
    const failure = classifyFailure(error);
    const category = failure.code;
    const key = `${tool}:${toolCallSignature(args)}`;
    const existing = this.records.get(key);
    const count = (existing?.count ?? 0) + 1;
    const retryable = IDEMPOTENT_TOOLS.has(tool) && failure.retryable && count < 2;
    const doNotRetry = !retryable && (category === "blocked" || category === "timeout" || category === "unavailable" || category === "authentication" || category === "quota" || category === "permission" || count >= 2);
    const parsedRetryAfterMs = failure.retryAfterMs;
    const action = failure.action;

    const record: ToolFailureRecord = {
      tool,
      argsKey: toolCallSignature(args),
      category,
      count,
      lastError: errorStr.slice(0, 300),
      doNotRetry,
      retryable,
      retryAfterMs: parsedRetryAfterMs,
      suggestedAction: action,
    };
    this.records.set(key, record);

    if (doNotRetry) {
      this.blockedSignatures.add(key);
    }

    const guidance = this.buildGuidance(tool, category, count, doNotRetry);
    return { category, blocked: doNotRetry, retryCount: count, guidance, retryable, retryAfterMs: parsedRetryAfterMs, suggestedAction: action };
  }

  /** Compatibility entry point used by the central tool executor. */
  record(tool: string, args: Record<string, unknown>, error: unknown): string {
    const failure = this.recordFailure(tool, args, error);
    const message = error instanceof Error ? error.message : String(error);
    const recoveryPolicy = failure.retryCount >= 2
      ? "This exact tool call has failed more than once. Do not call it again with the same arguments. Switch tools, change parameters, reduce scope, or explain the blocker."
      : failure.retryable
        ? "This read-only call may be retried once using the shared retry policy. Do not blindly retry after that attempt."
        : "Do not blindly retry the exact same call. Try a different tool, different parameters, a smaller step, or explain the blocker if no alternate path is available.";
    return [
      failure.guidance,
      `Arguments: ${JSON.stringify(args).slice(0, 1200)}`,
      `Error: ${message}`,
      `Recovery policy: ${recoveryPolicy}`,
    ].join("\n");
  }

  getRecord(tool: string, args: Record<string, unknown>): ToolFailureRecord | null {
    return this.records.get(`${tool}:${toolCallSignature(args)}`) ?? null;
  }

  isBlocked(tool: string, args: Record<string, unknown>): boolean {
    return this.blockedSignatures.has(`${tool}:${toolCallSignature(args)}`);
  }

  recordNoProgress(tool: string, args: Record<string, unknown>, output: string): string | null {
    if (!IDEMPOTENT_TOOLS.has(tool)) return null;
    const key = `${tool}:${toolCallSignature(args)}`;
    const count = (this.noProgressCounts.get(key) ?? 0) + 1;
    this.noProgressCounts.set(key, count);
    if (count >= 4) {
      this.blockedSignatures.add(key);
      return `[Tool blocked: ${tool}] This repeated read/search did not add useful new evidence. Use a different query, read a different file/range, or synthesize from current evidence.`;
    }
    if (count >= 2) {
      return `[Tool warning: ${tool}] This repeated read/search appears to add little new evidence. Change strategy if more evidence is needed.\n\n${output}`;
    }
    return null;
  }

  private buildGuidance(tool: string, category: ToolFailureCategory, count: number, doNotRetry: boolean): string {
    const prefix = doNotRetry
      ? `[Tool blocked: ${tool}] Do NOT retry this call.`
      : `[Tool failed: ${tool}]`;

    switch (category) {
      case "rate_limited":
        return `${prefix} The provider is rate-limiting requests. Respect Retry-After when present and retry this read-only call at most once.`;
      case "authentication":
        return `${prefix} Authentication failed. Check the provider or integration credentials before trying again.`;
      case "quota":
        return `${prefix} The configured account has no usable quota. Change provider/account or ask the operator to update billing.`;
      case "context_overflow":
        return `${prefix} The request exceeded the model context. Reduce attachments or scope, compact history, then make a smaller call.`;
      case "conflict":
        return `${prefix} The target changed since it was read. Reload current state and ask the operator to review the new diff.`;
      case "timeout":
        return `${prefix} The tool timed out. Try a narrower query, smaller file range, or different approach. If this tool is needed, explain what could not be verified.`;
      case "not_found":
        return `${prefix} Resource not found. Try searching/listing to discover available paths before reading.`;
      case "permission":
        return `${prefix} Access denied. This resource is not accessible. Note the limitation and continue with available evidence.`;
      case "empty":
        return `${prefix} No results returned. Try broader search terms, different parameters, or check availability.`;
      case "blocked":
        return `${prefix} This operation is blocked. Do not attempt to work around this restriction.`;
      case "unavailable":
        return `${prefix} Tool or skill not available. Use available alternatives (web search, manual analysis, or explain the limitation).`;
      case "invalid_args":
        return `${prefix} Invalid arguments. If retrying (count: ${count}), fix the schema before calling again.`;
      default:
        if (count >= 2) {
          return `${prefix} Failed ${count} times. Switch approach — use different tool, parameters, or scope.`;
        }
        return `${prefix} Try a different approach or tool.`;
    }
  }

  formatSummaryForModel(): string {
    const blocked = Array.from(this.records.values()).filter((record) => record.doNotRetry);
    if (blocked.length === 0) return "";
    const lines = blocked
      .slice(0, 8)
      .map((record) => `- ${record.tool} [${record.category}]: ${record.lastError.slice(0, 100)}`);
    return `Blocked tool calls (do not retry):\n${lines.join("\n")}`;
  }
}
