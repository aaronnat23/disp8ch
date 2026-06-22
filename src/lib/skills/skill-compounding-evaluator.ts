import { nanoid } from "nanoid";
import { initializeDatabase, withSqliteWriteRecovery } from "@/lib/db";
import { listSkillUsageEvents, listSkillUsageSummaries, type SkillUsageSummary } from "@/lib/skills/usage-ledger";

export type SkillCompoundingStatus = "active" | "stale" | "needs_review" | "archived_candidate";

export type SkillCompoundingEvaluation = {
  id: string;
  skillId: string;
  skillName: string;
  status: SkillCompoundingStatus;
  usageCount: number;
  successCount: number;
  staleScore: number;
  recommendation: string;
  rationale: string;
  evidence: string[];
  createdAt: string;
};

function daysSince(iso: string | null): number {
  if (!iso) return 999;
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return 999;
  return Math.max(0, Math.floor((Date.now() - time) / 86_400_000));
}

function evaluateSummary(summary: SkillUsageSummary): Omit<SkillCompoundingEvaluation, "id" | "createdAt"> {
  const usageCount = summary.usedCount + summary.loadedCount;
  const successCount = summary.appliedPatchCount + summary.usedCount;
  const staleDays = Math.min(365, daysSince(summary.lastUsedAt ?? summary.lastLoadedAt ?? summary.lastEventAt));
  const staleScore = Math.min(100, staleDays + Math.max(0, summary.loadedCount - summary.usedCount) * 3);
  const reviewPressure = summary.proposedPatchCount - summary.appliedPatchCount + summary.dismissedCount;
  let status: SkillCompoundingStatus = "active";
  let recommendation = "Keep active.";
  if (usageCount === 0 || staleScore >= 120) {
    status = "archived_candidate";
    recommendation = "Consider archiving or disabling if the operator does not need this skill.";
  } else if (staleScore >= 45) {
    status = "stale";
    recommendation = "Review freshness and examples before relying on this skill for current workflows.";
  } else if (reviewPressure >= 2) {
    status = "needs_review";
    recommendation = "Review proposal history; repeated edits or dismissals suggest the skill is not matching real use.";
  }
  return {
    skillId: summary.skillId,
    skillName: summary.skillName,
    status,
    usageCount,
    successCount,
    staleScore,
    recommendation,
    rationale: [
      `${summary.loadedCount} loads, ${summary.usedCount} uses, ${summary.appliedPatchCount} applied patches.`,
      summary.lastUsedAt ? `Last used ${summary.lastUsedAt}.` : "No direct use event recorded yet.",
      reviewPressure > 0 ? `${reviewPressure} unresolved review signal(s).` : "No unresolved review pressure.",
    ].join(" "),
    evidence: [
      summary.lastLoadedAt ? `last_loaded_at=${summary.lastLoadedAt}` : "",
      summary.lastUsedAt ? `last_used_at=${summary.lastUsedAt}` : "",
      summary.lastPatchedAt ? `last_patched_at=${summary.lastPatchedAt}` : "",
    ].filter(Boolean),
  };
}

export function evaluateSkillCompounding(input: {
  skillId?: string | null;
  limit?: number;
} = {}): SkillCompoundingEvaluation[] {
  initializeDatabase();
  const summaries = listSkillUsageSummaries(input.limit ?? 200)
    .filter((summary) => input.skillId ? summary.skillId === input.skillId : true);
  const now = new Date().toISOString();
  const output: SkillCompoundingEvaluation[] = [];
  for (const summary of summaries) {
    const evaluated = evaluateSummary(summary);
    const recentEvents = listSkillUsageEvents({ skillId: summary.skillId, limit: 12 });
    const evidence = [
      ...evaluated.evidence,
      ...recentEvents.slice(0, 5).map((event) => `${event.eventKind}@${event.createdAt}${event.outcome ? `:${event.outcome}` : ""}`),
    ];
    const id = nanoid(16);
    withSqliteWriteRecovery("skill-compounding:evaluate", (writer) => {
      writer.prepare(`
        INSERT INTO skill_compounding_evaluations (
          id, skill_id, skill_name, status, usage_count, success_count, stale_score,
          recommendation, rationale, evidence_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        evaluated.skillId,
        evaluated.skillName,
        evaluated.status,
        evaluated.usageCount,
        evaluated.successCount,
        evaluated.staleScore,
        evaluated.recommendation,
        evaluated.rationale,
        JSON.stringify(evidence),
        now,
      );
    });
    output.push({ id, createdAt: now, ...evaluated, evidence });
  }
  return output;
}
