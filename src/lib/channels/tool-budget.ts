import type { ModelLedLane } from "@/lib/channels/model-led-context";

export type ToolBudgetPolicy = {
  lane: ModelLedLane;
  maxTotalToolCalls: number;
  maxByTool: Record<string, number>;
  maxFileReadsPerPath: number;
};

export type ToolBudgetDecision = {
  allowed: boolean;
  reason?: string;
};

export function createToolBudgetPolicy(lane: ModelLedLane): ToolBudgetPolicy {
  switch (lane) {
    case "broad_research":
      return {
        lane,
        maxTotalToolCalls: 64,
        maxByTool: {
          web_search: 16,
          web_extract: 18,
          web_crawl: 6,
          fetch_url: 20,
          browser_navigate: 12,
          browser_snapshot: 12,
          browser_click: 6,
          browser_get_text: 6,
          browser_get_links: 8,
          browser_get_images: 6,
          browser_vision: 4,
          browser_cdp: 6,
          browser_dialog: 4,
          browser_wait: 6,
          browser_back: 4,
          browser_console: 4,
          browser_action: 6,
          documents_search: 6,
          documents_semantic_search: 6,
          document_get: 6,
          memory_search: 5,
          memory_get: 5,
          search_files: 6,
          read_file: 8,
          pc_specs: 2,
        },
        maxFileReadsPerPath: 3,
      };
    case "repo_inspection":
      return {
        lane,
        maxTotalToolCalls: 64,
        maxByTool: {
          channel_status: 6,
          search_files: 18,
          list_files: 10,
          read_file: 36,
          code_review: 3,
          memory_search: 5,
          memory_get: 5,
          session_recall: 4,
        },
        maxFileReadsPerPath: 3,
      };
    case "app_design":
    case "app_mutation_proposal":
      return {
        lane,
        maxTotalToolCalls: 28,
        maxByTool: {
          channel_status: 6,
          workflow_templates: 4,
          workflow_list: 4,
          workflow_get: 8,
          workflow_execution_status: 4,
          schedules_list: 4,
          webhooks_list: 4,
          board_tasks: 4,
          governance_queue: 4,
          documents_list: 3,
          documents_search: 5,
          documents_semantic_search: 5,
          document_get: 5,
          memory_search: 5,
          memory_get: 5,
          session_recall: 4,
          search_files: 4,
          read_file: 6,
        },
        maxFileReadsPerPath: 2,
      };
    case "memory_recall":
      return {
        lane,
        maxTotalToolCalls: 6,
        maxByTool: {
          session_recall: 3,
          memory_search: 3,
          memory_get: 3,
        },
        maxFileReadsPerPath: 1,
      };
    case "direct":
      return { lane, maxTotalToolCalls: 0, maxByTool: {}, maxFileReadsPerPath: 0 };
    case "read_only_workspace":
    default:
      return {
        lane,
        maxTotalToolCalls: 10,
        maxByTool: {
          channel_status: 4,
          documents_list: 2,
          documents_search: 3,
          documents_semantic_search: 3,
          document_get: 3,
          memory_search: 3,
          memory_get: 3,
          session_recall: 2,
        },
        maxFileReadsPerPath: 1,
      };
  }
}

function normalizePathArg(args: Record<string, unknown>): string | null {
  const value = args.path ?? args.file ?? args.filePath ?? args.filename;
  if (typeof value !== "string") return null;
  return value.replace(/\\/g, "/").replace(/\/+/g, "/").trim().toLowerCase() || null;
}

function callKey(name: string, args: Record<string, unknown>): string {
  return `${name}:${JSON.stringify(args)}`;
}

export class ToolBudgetTracker {
  private total = 0;
  private byTool = new Map<string, number>();
  private identical = new Map<string, number>();
  private fileReads = new Map<string, number>();
  private effectiveMax: number;
  private expandedBy = 0;
  private consecutiveNoNewInfo = 0;
  private lastResultWasUseful = true;

  constructor(private readonly policy: ToolBudgetPolicy, private readonly maxExpandedTotal?: number) {
    this.effectiveMax = policy.maxTotalToolCalls;
  }

  /** Expand the tool budget when a required evidence need is still open and last tool was useful. */
  tryExpand(reason: string): { expanded: boolean; reason: string } {
    const hardMax = this.maxExpandedTotal ?? this.policy.maxTotalToolCalls;
    if (this.effectiveMax >= hardMax) {
      return { expanded: false, reason: "hard budget ceiling reached" };
    }
    if (!this.lastResultWasUseful) {
      return { expanded: false, reason: "last tool added no new information" };
    }
    const increment = Math.min(12, hardMax - this.effectiveMax);
    this.effectiveMax += increment;
    this.expandedBy += increment;
    return { expanded: true, reason: `expanded by ${increment} for: ${reason}` };
  }

  /** Call after each tool result to track whether it was useful. */
  recordResultUsefulness(wasUseful: boolean): void {
    this.lastResultWasUseful = wasUseful;
    if (!wasUseful) {
      this.consecutiveNoNewInfo++;
    } else {
      this.consecutiveNoNewInfo = 0;
    }
  }

  /** Returns true when two consecutive tools added nothing new. */
  shouldStopEarly(): boolean {
    return this.consecutiveNoNewInfo >= 2;
  }

  get totalUsed(): number { return this.total; }
  get currentLimit(): number { return this.effectiveMax; }
  get expansionUsed(): number { return this.expandedBy; }

  beforeTool(name: string, args: Record<string, unknown>): ToolBudgetDecision {
    if (this.policy.maxTotalToolCalls <= 0) {
      return {
        allowed: false,
        reason: `Tool budget reached for lane ${this.policy.lane}: no tools are available for this lane. Synthesize a final answer without more tools.`,
      };
    }

    if (this.total >= this.effectiveMax) {
      return {
        allowed: false,
        reason: `Tool budget reached for lane ${this.policy.lane}: ${this.total}/${this.effectiveMax} total calls used${this.expandedBy > 0 ? ` (expanded by ${this.expandedBy})` : ""}. Synthesize a final answer from collected evidence.`,
      };
    }

    const perToolLimit = this.policy.maxByTool[name];
    const usedForTool = this.byTool.get(name) ?? 0;
    if (typeof perToolLimit === "number" && usedForTool >= perToolLimit) {
      return {
        allowed: false,
        reason: `Tool budget reached for ${name}: ${usedForTool}/${perToolLimit} calls used. Stop using ${name} and synthesize from current evidence.`,
      };
    }

    const key = callKey(name, args);
    const identicalCount = this.identical.get(key) ?? 0;
    if (identicalCount >= 1) {
      return {
        allowed: false,
        reason: `Repeated tool call blocked: ${name} was already called with the same arguments. Use existing evidence or choose a materially different tool call.`,
      };
    }

    if (name === "read_file") {
      const path = normalizePathArg(args);
      if (path) {
        const reads = this.fileReads.get(path) ?? 0;
        if (reads >= this.policy.maxFileReadsPerPath) {
          return {
            allowed: false,
            reason: `Repeated file read blocked: ${path} has already been read ${reads} time(s). Use the existing result or request a different range only if necessary.`,
          };
        }
      }
    }

    return { allowed: true };
  }

  recordTool(name: string, args: Record<string, unknown>): void {
    this.total++;
    this.byTool.set(name, (this.byTool.get(name) ?? 0) + 1);
    const key = callKey(name, args);
    this.identical.set(key, (this.identical.get(key) ?? 0) + 1);
    if (name === "read_file") {
      const path = normalizePathArg(args);
      if (path) this.fileReads.set(path, (this.fileReads.get(path) ?? 0) + 1);
    }
  }
}

export function formatToolBudgetStop(reason: string): string {
  return [
    "[Tool budget stop]",
    reason,
    "Do not try the blocked call again. Write the best final answer from collected evidence. If evidence is incomplete, state what remains unverified.",
  ].join("\n");
}
