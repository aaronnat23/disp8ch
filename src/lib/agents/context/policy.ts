import { getModelContextWindow } from "@/lib/agents/context-windows";
import type { ContextPolicy } from "./types";

const DEFAULT_POLICY: ContextPolicy = {
  compaction: {
    mode: "off",
    threshold: 0.75,
    contextWindow: 200000,
    memoryFlushEnabled: true,
    memoryFlushSoftThresholdTokens: 4000,
    keepRecentTokens: 20000,
    reserveTokensFloor: 20000,
    summaryModelRef: null,
    identifierPolicy: "strict",
    identifierInstructions: null,
    qualityGuardEnabled: true,
    qualityGuardMaxRetries: 1,
  },
  pruning: {
    mode: "tool-results",
    keepRecentAssistants: 3,
    minToolChars: 12000,
    maxToolChars: 4000,
    headChars: 1500,
    tailChars: 1500,
  },
};

export async function loadContextPolicy(modelId?: string): Promise<ContextPolicy> {
  try {
    const { getSqlite } = await import("@/lib/db");
    const db = getSqlite();
    const row = db
      .prepare(
        `SELECT compaction_mode,
                compaction_threshold,
                context_window,
                memory_flush_enabled,
                memory_flush_soft_threshold_tokens,
                compaction_keep_recent_tokens,
                compaction_reserve_tokens_floor,
                compaction_model_ref,
                compaction_identifier_policy,
                compaction_identifier_instructions,
                compaction_quality_guard_enabled,
                compaction_quality_guard_max_retries,
                context_pruning_mode,
                context_pruning_keep_recent_assistants,
                context_pruning_min_tool_chars,
                context_pruning_max_tool_chars,
                context_pruning_head_chars,
                context_pruning_tail_chars
           FROM app_config
          WHERE id = 'default'`,
      )
      .get() as {
        compaction_mode: ContextPolicy["compaction"]["mode"] | null;
        compaction_threshold: number | null;
        context_window: number | null;
        memory_flush_enabled: number | null;
        memory_flush_soft_threshold_tokens: number | null;
        compaction_keep_recent_tokens: number | null;
        compaction_reserve_tokens_floor: number | null;
        compaction_model_ref: string | null;
        compaction_identifier_policy: ContextPolicy["compaction"]["identifierPolicy"] | null;
        compaction_identifier_instructions: string | null;
        compaction_quality_guard_enabled: number | null;
        compaction_quality_guard_max_retries: number | null;
        context_pruning_mode: ContextPolicy["pruning"]["mode"] | null;
        context_pruning_keep_recent_assistants: number | null;
        context_pruning_min_tool_chars: number | null;
        context_pruning_max_tool_chars: number | null;
        context_pruning_head_chars: number | null;
        context_pruning_tail_chars: number | null;
      } | undefined;

    let contextWindow = row?.context_window ?? DEFAULT_POLICY.compaction.contextWindow;
    if (modelId) {
      const perModel = getModelContextWindow(modelId);
      if (perModel !== null) contextWindow = Math.min(contextWindow, perModel);
    }

    return {
      compaction: {
        mode: row?.compaction_mode ?? DEFAULT_POLICY.compaction.mode,
        threshold: row?.compaction_threshold ?? DEFAULT_POLICY.compaction.threshold,
        contextWindow,
        memoryFlushEnabled:
          (row?.memory_flush_enabled ?? (DEFAULT_POLICY.compaction.memoryFlushEnabled ? 1 : 0)) !== 0,
        memoryFlushSoftThresholdTokens:
          row?.memory_flush_soft_threshold_tokens ?? DEFAULT_POLICY.compaction.memoryFlushSoftThresholdTokens,
        keepRecentTokens:
          row?.compaction_keep_recent_tokens ?? DEFAULT_POLICY.compaction.keepRecentTokens,
        reserveTokensFloor:
          row?.compaction_reserve_tokens_floor ?? DEFAULT_POLICY.compaction.reserveTokensFloor,
        summaryModelRef:
          (row?.compaction_model_ref ?? DEFAULT_POLICY.compaction.summaryModelRef) || null,
        identifierPolicy:
          row?.compaction_identifier_policy ?? DEFAULT_POLICY.compaction.identifierPolicy,
        identifierInstructions:
          (row?.compaction_identifier_instructions ?? DEFAULT_POLICY.compaction.identifierInstructions) || null,
        qualityGuardEnabled:
          (row?.compaction_quality_guard_enabled ?? (DEFAULT_POLICY.compaction.qualityGuardEnabled ? 1 : 0)) !== 0,
        qualityGuardMaxRetries:
          row?.compaction_quality_guard_max_retries ?? DEFAULT_POLICY.compaction.qualityGuardMaxRetries,
      },
      pruning: {
        mode: row?.context_pruning_mode ?? DEFAULT_POLICY.pruning.mode,
        keepRecentAssistants:
          row?.context_pruning_keep_recent_assistants ?? DEFAULT_POLICY.pruning.keepRecentAssistants,
        minToolChars: row?.context_pruning_min_tool_chars ?? DEFAULT_POLICY.pruning.minToolChars,
        maxToolChars: row?.context_pruning_max_tool_chars ?? DEFAULT_POLICY.pruning.maxToolChars,
        headChars: row?.context_pruning_head_chars ?? DEFAULT_POLICY.pruning.headChars,
        tailChars: row?.context_pruning_tail_chars ?? DEFAULT_POLICY.pruning.tailChars,
      },
    };
  } catch {
    return modelId
      ? {
          ...DEFAULT_POLICY,
          compaction: {
            ...DEFAULT_POLICY.compaction,
            contextWindow: getModelContextWindow(modelId) ?? DEFAULT_POLICY.compaction.contextWindow,
          },
        }
      : DEFAULT_POLICY;
  }
}

export function getDefaultContextPolicy(): ContextPolicy {
  return DEFAULT_POLICY;
}
