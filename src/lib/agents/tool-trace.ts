export type AccuracyMode = "fast" | "balanced" | "thorough";

export type ToolTraceEvent =
  | {
      type: "accuracy_mode";
      mode: AccuracyMode;
      reason: string;
      lane: string;
    }
  | {
      type: "evidence_plan";
      needs: string[];
      requiredCount: number;
      stopCriteria: string[];
    }
  | {
      type: "tool_start";
      tool: string;
      argsSummary: string;
      budgetUsed: number;
      budgetLimit: number;
      iteration: number;
    }
  | {
      type: "tool_end";
      tool: string;
      durationMs: number;
      resultChars: number;
      evidenceAdded: boolean;
      errorCategory?: string;
    }
  | {
      type: "budget_decision";
      action: "continue" | "expand" | "stop";
      reason: string;
      toolsUsed: number;
      budgetLimit: number;
    }
  | {
      type: "synthesis_start";
      evidenceItems: number;
      remainingMs: number;
      reason: string;
    }
  | {
      type: "synthesis_complete";
      durationMs: number;
      outputChars: number;
      fromEvidence: boolean;
    }
  | {
      type: "failure";
      tool: string;
      errorCategory: string;
      blocked: boolean;
      retryCount: number;
    };

export type ToolTraceRecord = {
  sessionId?: string;
  agentId?: string;
  lane: string;
  mode: AccuracyMode;
  provider: string;
  modelId: string;
  startedAt: string;
  events: ToolTraceEvent[];
  toolsUsed: string[];
  totalToolCalls: number;
  totalDurationMs: number;
  evidenceCount: number;
  failureCount: number;
  synthesisType: "model" | "evidence_fallback" | "deadline_fallback" | "none";
};

export class ToolTracer {
  private events: ToolTraceEvent[] = [];
  private startTime = Date.now();
  private toolStartTimes = new Map<string, number>();
  private toolCount = 0;
  private evidenceCount = 0;
  private failureCount = 0;
  private mode: AccuracyMode = "balanced";
  private lane = "read_only_workspace";
  private synthesisType: ToolTraceRecord["synthesisType"] = "none";

  constructor(
    private readonly sessionId?: string,
    private readonly agentId?: string,
    private readonly provider = "unknown",
    private readonly modelId = "unknown",
  ) {}

  recordAccuracyMode(mode: AccuracyMode, reason: string, lane: string): void {
    this.mode = mode;
    this.lane = lane;
    this.events.push({ type: "accuracy_mode", mode, reason, lane });
  }

  recordEvidencePlan(needs: string[], requiredCount: number, stopCriteria: string[]): void {
    this.events.push({ type: "evidence_plan", needs, requiredCount, stopCriteria });
  }

  recordToolStart(tool: string, args: Record<string, unknown>, budgetUsed: number, budgetLimit: number): void {
    const key = `${tool}-${this.toolCount}`;
    this.toolStartTimes.set(key, Date.now());
    this.toolCount++;
    const argsSummary = JSON.stringify(args).slice(0, 120);
    this.events.push({
      type: "tool_start",
      tool,
      argsSummary,
      budgetUsed,
      budgetLimit,
      iteration: this.toolCount,
    });
  }

  recordToolEnd(tool: string, resultChars: number, evidenceAdded: boolean, errorCategory?: string): void {
    const startKey = `${tool}-${this.toolCount - 1}`;
    const start = this.toolStartTimes.get(startKey) ?? this.startTime;
    const durationMs = Date.now() - start;
    if (evidenceAdded) this.evidenceCount++;
    this.events.push({ type: "tool_end", tool, durationMs, resultChars, evidenceAdded, errorCategory });
  }

  recordBudgetDecision(action: "continue" | "expand" | "stop", reason: string, toolsUsed: number, budgetLimit: number): void {
    this.events.push({ type: "budget_decision", action, reason, toolsUsed, budgetLimit });
  }

  recordSynthesisStart(evidenceItems: number, remainingMs: number, reason: string): void {
    this.synthesisType = "model";
    this.events.push({ type: "synthesis_start", evidenceItems, remainingMs, reason });
  }

  recordSynthesisComplete(durationMs: number, outputChars: number, fromEvidence: boolean): void {
    this.synthesisType = fromEvidence ? "evidence_fallback" : "model";
    this.events.push({ type: "synthesis_complete", durationMs, outputChars, fromEvidence });
  }

  recordDeadlineFallback(): void {
    this.synthesisType = "deadline_fallback";
  }

  recordFailure(tool: string, errorCategory: string, blocked: boolean, retryCount: number): void {
    this.failureCount++;
    this.events.push({ type: "failure", tool, errorCategory, blocked, retryCount });
  }

  toRecord(toolsUsed: string[]): ToolTraceRecord {
    return {
      sessionId: this.sessionId,
      agentId: this.agentId,
      lane: this.lane,
      mode: this.mode,
      provider: this.provider,
      modelId: this.modelId,
      startedAt: new Date(this.startTime).toISOString(),
      events: this.events,
      toolsUsed,
      totalToolCalls: this.toolCount,
      totalDurationMs: Date.now() - this.startTime,
      evidenceCount: this.evidenceCount,
      failureCount: this.failureCount,
      synthesisType: this.synthesisType,
    };
  }

  formatSummary(toolsUsed: string[]): string {
    const record = this.toRecord(toolsUsed);
    const lines = [
      `[tool-trace] mode=${record.mode} lane=${record.lane} provider=${record.provider}:${record.modelId}`,
      `  tools=${record.totalToolCalls} evidence=${record.evidenceCount} failures=${record.failureCount} synthesis=${record.synthesisType}`,
      `  duration=${record.totalDurationMs}ms toolsUsed=[${toolsUsed.join(", ")}]`,
    ];
    const failures = this.events.filter((event): event is Extract<ToolTraceEvent, { type: "failure" }> => event.type === "failure");
    if (failures.length > 0) {
      lines.push(`  failures: ${failures.map((failure) => `${failure.tool}(${failure.errorCategory})`).join(", ")}`);
    }
    const budgetStops = this.events.filter(
      (event): event is Extract<ToolTraceEvent, { type: "budget_decision" }> =>
        event.type === "budget_decision" && event.action === "stop",
    );
    if (budgetStops.length > 0) {
      lines.push(`  budget_stops: ${budgetStops.map((event) => event.reason.slice(0, 60)).join("; ")}`);
    }
    return lines.join("\n");
  }
}
