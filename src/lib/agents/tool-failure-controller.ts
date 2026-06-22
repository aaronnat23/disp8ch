export type ToolFailureCategory =
  | "timeout"
  | "not_found"
  | "permission"
  | "empty"
  | "blocked"
  | "unavailable"
  | "invalid_args"
  | "unknown";

export type ToolFailureRecord = {
  tool: string;
  argsKey: string;
  category: ToolFailureCategory;
  count: number;
  lastError: string;
  doNotRetry: boolean;
};

const IDEMPOTENT_TOOLS = new Set([
  "read_file",
  "list_files",
  "search_files",
  "find_files",
  "web_search",
  "fetch_url",
  "browser_action",
  "memory_search",
  "memory_get",
  "document_get",
  "documents_search",
]);

function categorize(error: string): ToolFailureCategory {
  const msg = error.toLowerCase();
  if (/timed out|timeout|deadline/.test(msg)) return "timeout";
  if (/not found|no such file|enoent|does not exist|404/.test(msg)) return "not_found";
  if (/permission|access denied|403|unauthorized/.test(msg)) return "permission";
  if (/empty|no results|0 result|not available/.test(msg)) return "empty";
  if (/blocked|do not retry|stop|refused/.test(msg)) return "blocked";
  if (/unavailable|not installed|missing skill|unknown tool/.test(msg)) return "unavailable";
  if (/invalid|argument|parameter|schema|type error/.test(msg)) return "invalid_args";
  return "unknown";
}

function argsKey(args: Record<string, unknown>): string {
  return JSON.stringify(args, Object.keys(args).sort()).slice(0, 300);
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
  } {
    const errorStr = error instanceof Error ? error.message : String(error);
    const category = categorize(errorStr);
    const key = `${tool}:${argsKey(args)}`;
    const existing = this.records.get(key);
    const count = (existing?.count ?? 0) + 1;
    const doNotRetry = category === "blocked" || category === "timeout" || category === "unavailable" || count >= 2;

    const record: ToolFailureRecord = { tool, argsKey: argsKey(args), category, count, lastError: errorStr.slice(0, 300), doNotRetry };
    this.records.set(key, record);

    if (doNotRetry) {
      this.blockedSignatures.add(key);
    }

    const guidance = this.buildGuidance(tool, category, count, doNotRetry);
    return { category, blocked: doNotRetry, retryCount: count, guidance };
  }

  isBlocked(tool: string, args: Record<string, unknown>): boolean {
    return this.blockedSignatures.has(`${tool}:${argsKey(args)}`);
  }

  recordNoProgress(tool: string, args: Record<string, unknown>, output: string): string | null {
    if (!IDEMPOTENT_TOOLS.has(tool)) return null;
    const key = `${tool}:${argsKey(args)}`;
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
