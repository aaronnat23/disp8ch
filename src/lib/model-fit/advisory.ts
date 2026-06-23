import { nanoid } from "nanoid";
import { getSqlite, initializeDatabase, withSqliteWriteRecovery } from "@/lib/db";
import { recommendLocalModelsV2, type RankedModel, type RecommendationResultV2 } from "./recommend-v2";

export type AdvisorySuggestion = {
  kind: "accuracy" | "speed" | "context" | "tools" | "memory" | "local";
  candidateId: string;
  title: string;
  tradeoff: string;
  confidence: string;
  downloadSizeBytes: number | null;
};

export type ModelAdvisory = {
  id: string;
  modelRowId: string;
  provider: string;
  modelId: string;
  callable: boolean;
  latencyMs: number | null;
  status: "ready" | "dismissed";
  evidence: {
    exactModelListed: boolean | null;
    contextMax: number | null;
    capabilities: string[];
    modalities: string[];
    runtimeVersion: string | null;
  };
  suggestions: AdvisorySuggestion[];
  summary: string;
  createdAt: string;
};

function ensureAdvisoryTables(): void {
  initializeDatabase();
  getSqlite().exec(`
    CREATE TABLE IF NOT EXISTS model_fit_advisories (
      id TEXT PRIMARY KEY,
      model_row_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      model_id TEXT NOT NULL,
      callable INTEGER NOT NULL DEFAULT 0,
      latency_ms INTEGER,
      status TEXT NOT NULL DEFAULT 'ready',
      report_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_model_fit_advisories_model
      ON model_fit_advisories(model_row_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS model_fit_advisory_preferences (
      id TEXT PRIMARY KEY CHECK (id = 'default'),
      suggestions_enabled INTEGER NOT NULL DEFAULT 1,
      remind_after TEXT,
      updated_at TEXT NOT NULL
    );
    INSERT OR IGNORE INTO model_fit_advisory_preferences (id, suggestions_enabled, updated_at)
      VALUES ('default', 1, CURRENT_TIMESTAMP);
  `);
}

function uniqueSuggestions(candidates: Array<{ kind: AdvisorySuggestion["kind"]; model: RankedModel | null; tradeoff: string }>): AdvisorySuggestion[] {
  const seen = new Set<string>();
  const output: AdvisorySuggestion[] = [];
  for (const item of candidates) {
    const model = item.model;
    if (!model || seen.has(`${item.kind}:${model.modelId}`)) continue;
    seen.add(`${item.kind}:${model.modelId}`);
    output.push({
      kind: item.kind,
      candidateId: model.modelId,
      title: model.displayName,
      tradeoff: item.tradeoff,
      confidence: model.confidence,
      downloadSizeBytes: model.sizeBytes,
    });
  }
  return output;
}

export async function createModelAdvisory(input: {
  modelRowId: string;
  provider: string;
  modelId: string;
  latencyMs: number;
  recommendation?: RecommendationResultV2;
  evidence?: ModelAdvisory["evidence"];
}): Promise<ModelAdvisory | null> {
  ensureAdvisoryTables();
  const preference = getSqlite().prepare(
    "SELECT suggestions_enabled, remind_after FROM model_fit_advisory_preferences WHERE id = 'default'"
  ).get() as { suggestions_enabled: number; remind_after: string | null } | undefined;
  if (preference?.suggestions_enabled === 0) return null;
  if (preference?.remind_after && Date.parse(preference.remind_after) > Date.now()) return null;

  const result = input.recommendation ?? await recommendLocalModelsV2({ task: "general", preference: "balanced", contextTokens: 8192 });
  const currentIdentity = input.modelId.toLowerCase();
  const isCurrent = (model: RankedModel | null) => Boolean(model && (
    model.ollamaTag?.toLowerCase() === currentIdentity ||
    model.displayName.toLowerCase() === currentIdentity ||
    model.modelId.toLowerCase() === currentIdentity
  ));
  const current = result.allCandidates.find((model) => isCurrent(model)) ?? null;
  const candidates: Array<{
    kind: AdvisorySuggestion["kind"];
    model: RankedModel | null;
    tradeoff: string;
  }> = [];
  if (!current) {
    const localAlternative = result.lanes.balanced ?? result.lanes.fast ?? result.lanes.quality;
    candidates.push({
      kind: "local",
      model: localAlternative,
      tradeoff: "Runs locally for offline use and data control. This is an alternative, not a proven quality upgrade.",
    });
  } else {
    const quality = isCurrent(result.lanes.quality) ? null : result.lanes.quality;
    if (quality && (quality.totalParamsB ?? 0) > (current.totalParamsB ?? Number.POSITIVE_INFINITY)) {
      candidates.push({ kind: "accuracy", model: quality, tradeoff: "Higher model capacity may improve answer quality, with more memory use or latency." });
    }
    const fast = isCurrent(result.lanes.fast) ? null : result.lanes.fast;
    const fastTps = fast?.performance.generationTokensPerSecond;
    const currentTps = current.performance.generationTokensPerSecond;
    if (fast && typeof fastTps === "number" && typeof currentTps === "number" && fastTps > currentTps) {
      candidates.push({ kind: "speed", model: fast, tradeoff: "Measured faster generation on this exact machine and context configuration." });
    }
    if (fast?.fitClass === "full_gpu" && current.fitClass !== "full_gpu") {
      candidates.push({ kind: "memory", model: fast, tradeoff: "Lower measured or estimated RAM and VRAM pressure on this machine." });
    }
    const toolCandidate = !current.capabilities.includes("tools")
      ? result.allCandidates.find((model) => model.capabilities.includes("tools") && !isCurrent(model)) ?? null
      : null;
    if (toolCandidate) candidates.push({ kind: "tools", model: toolCandidate, tradeoff: "Advertises tool capability for agent and workflow calls." });
    const contextCandidate = result.allCandidates
      .filter((model) => !isCurrent(model) && model.contextMax !== null && (model.contextMax ?? 0) > (current.contextMax ?? Number.POSITIVE_INFINITY))
      .sort((a, b) => (b.contextMax ?? 0) - (a.contextMax ?? 0))[0] ?? null;
    if (contextCandidate) candidates.push({ kind: "context", model: contextCandidate, tradeoff: "Advertises a longer context window than the active local model." });
  }

  const suggestions = uniqueSuggestions(candidates);
  const advisory: ModelAdvisory = {
    id: nanoid(12),
    modelRowId: input.modelRowId,
    provider: input.provider,
    modelId: input.modelId,
    callable: true,
    latencyMs: input.latencyMs,
    status: "ready",
    evidence: input.evidence ?? {
      exactModelListed: null,
      contextMax: null,
      capabilities: [],
      modalities: [],
      runtimeVersion: null,
    },
    suggestions,
    summary: suggestions.length > 0
      ? `Connection verified. ${suggestions.length} optional local alternative${suggestions.length === 1 ? " fits" : "s fit"} this PC.`
      : "Connection verified. No clearly better verified local alternative was found.",
    createdAt: new Date().toISOString(),
  };
  withSqliteWriteRecovery("model-fit:create-advisory", (db) => {
    db.prepare(`
      INSERT INTO model_fit_advisories (
        id, model_row_id, provider, model_id, callable, latency_ms, status, report_json, created_at
      ) VALUES (?, ?, ?, ?, 1, ?, 'ready', ?, ?)
    `).run(
      advisory.id,
      advisory.modelRowId,
      advisory.provider,
      advisory.modelId,
      advisory.latencyMs,
      JSON.stringify(advisory),
      advisory.createdAt,
    );
  });
  return advisory;
}

export function listModelAdvisories(modelRowId?: string): ModelAdvisory[] {
  ensureAdvisoryTables();
  const rows = (modelRowId
    ? getSqlite().prepare("SELECT report_json, status FROM model_fit_advisories WHERE model_row_id = ? ORDER BY created_at DESC LIMIT 10").all(modelRowId)
    : getSqlite().prepare("SELECT report_json, status FROM model_fit_advisories ORDER BY created_at DESC LIMIT 20").all()
  ) as Array<{ report_json: string; status: "ready" | "dismissed" }>;
  return rows.flatMap((row) => {
    try {
      return [{ ...(JSON.parse(row.report_json) as ModelAdvisory), status: row.status }];
    } catch {
      return [];
    }
  });
}

export function updateAdvisoryPreference(input: {
  advisoryId?: string;
  action: "dismiss" | "remind" | "disable";
}): void {
  ensureAdvisoryTables();
  const now = new Date().toISOString();
  withSqliteWriteRecovery("model-fit:update-advisory", (db) => {
    if (input.action === "dismiss" && input.advisoryId) {
      db.prepare("UPDATE model_fit_advisories SET status = 'dismissed' WHERE id = ?").run(input.advisoryId);
    } else if (input.action === "remind") {
      const remind = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      db.prepare("UPDATE model_fit_advisory_preferences SET remind_after = ?, updated_at = ? WHERE id = 'default'").run(remind, now);
    } else if (input.action === "disable") {
      db.prepare("UPDATE model_fit_advisory_preferences SET suggestions_enabled = 0, updated_at = ? WHERE id = 'default'").run(now);
    }
  });
}
