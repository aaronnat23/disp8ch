import type { ModelProvider } from "@/types/model";
import { callModel } from "@/lib/agents/multi-provider";
import type { UniversalInvestigationPlan } from "@/lib/channels/universal-agentic-planner";
import {
  summarizeDossierForCritic,
  type UniversalEvidenceDossier,
} from "@/lib/channels/universal-evidence-dossier";

export type UniversalCriticDecision = "finalize" | "continue" | "repair";

export type UniversalCriticAxis = 0 | 1 | 2 | 3 | 4;

export type UniversalCriticScore = {
  directness: UniversalCriticAxis;
  grounding: UniversalCriticAxis;
  evidenceCoverage: UniversalCriticAxis;
  sourceQuality: UniversalCriticAxis;
  actionability: UniversalCriticAxis;
  uncertaintyHandling: UniversalCriticAxis;
  conciseEnough: UniversalCriticAxis;
};

export type UniversalCriticReport = {
  decision: UniversalCriticDecision;
  confidence: "high" | "medium" | "low";
  scores: UniversalCriticScore;
  findings: string[];
  missingEvidence: string[];
  nextActions: string[];
  repairInstruction?: string;
  dossierSummary?: string;
};

type ToolResultPreview = { name: string; ok: boolean; preview: string };

const CRITIC_SYSTEM_PROMPT = `You are a universal answer critic for an agentic assistant.
Evaluate the draft against the user's request, the investigation plan, and the structured evidence dossier.
Use one decision:
- finalize: the answer is complete enough and additional tool use is unlikely to materially improve correctness.
- continue: material evidence is missing and one or more targeted tool calls could improve correctness or completeness.
- repair: the evidence is enough, but the answer shape is weak, too generic, too verbose, unsafe, or not aligned to the user.

Score each axis 0-4:
- directness: does the answer address the user's request directly?
- grounding: are claims tied to actual evidence (file paths, source URLs, app state, etc.)?
- evidenceCoverage: does the dossier show the right evidence kinds for the request?
- sourceQuality: are the sources diverse, recent, and authoritative where it matters?
- actionability: would the user know what to do next from the answer?
- uncertaintyHandling: are unknowns and limitations stated explicitly when they remain?
- conciseEnough: is the length proportional to the request (compressed when the user did not ask for exhaustive detail)?

For research/current facts, require source URLs or state missing sources.
For repo questions, require file paths and preferably line refs.
For app capability/status, require actual app state or repo evidence.
For workflow/design, require actual available node/tool/artifact evidence.
For code editing, require changed files and at least one verification attempt when practical.
For memory/session recall, require memory/session evidence when available.
Do not require exhaustive research when the remaining gaps would not change the answer materially.
If the draft is long but valuable, repair to compress rather than throwing away evidence.
Do not use benchmark IDs or memorized test expectations.
Return compact JSON only with: decision, confidence, scores, findings, missingEvidence, nextActions, repairInstruction.`;

function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) return fenced[1].trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 8)
    : [];
}

function axis(value: unknown): UniversalCriticAxis {
  const n = Number(value);
  if (Number.isNaN(n)) return 2;
  if (n <= 0) return 0;
  if (n >= 4) return 4;
  return Math.round(n) as UniversalCriticAxis;
}

function normalizeDecision(value: unknown): UniversalCriticDecision {
  return value === "continue" || value === "repair" ? value : "finalize";
}

function normalizeConfidence(value: unknown): "high" | "medium" | "low" {
  return value === "high" || value === "low" ? value : "medium";
}

function normalizeScores(value: unknown): UniversalCriticScore {
  const obj = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return {
    directness: axis(obj.directness),
    grounding: axis(obj.grounding),
    evidenceCoverage: axis(obj.evidenceCoverage),
    sourceQuality: axis(obj.sourceQuality),
    actionability: axis(obj.actionability),
    uncertaintyHandling: axis(obj.uncertaintyHandling),
    conciseEnough: axis(obj.conciseEnough),
  };
}

function scoreAverage(scores: UniversalCriticScore): number {
  return (
    scores.directness +
    scores.grounding +
    scores.evidenceCoverage +
    scores.sourceQuality +
    scores.actionability +
    scores.uncertaintyHandling +
    scores.conciseEnough
  ) / 7;
}

function normalizeReport(value: unknown): UniversalCriticReport | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  const scores = normalizeScores(obj.scores);
  return {
    decision: normalizeDecision(obj.decision),
    confidence: normalizeConfidence(obj.confidence),
    scores,
    findings: stringArray(obj.findings),
    missingEvidence: stringArray(obj.missingEvidence),
    nextActions: stringArray(obj.nextActions),
    repairInstruction: typeof obj.repairInstruction === "string" && obj.repairInstruction.trim()
      ? obj.repairInstruction.trim()
      : undefined,
  };
}

function asksForSourceCategorySeparation(text: string): boolean {
  return /\b(?:source\s+categor(?:y|ies)|official\s+(?:docs?|sources?)|community\s+(?:reports?|sources?|signal)|third[- ]party|weak\s+(?:or\s+missing\s+)?source|missing\s+(?:source|evidence)|confirmed\s+facts|likely\s+inferences|unknowns)\b/i.test(text);
}

function asksForCapabilityState(text: string): boolean {
  return (
    /\b(?:implemented|configured|callable|available\s+(?:now|right\s+now|currently)|merely\s+planned|planned\s+capabilit|not\s+configured|missing\s+(?:key|secret|model|provider))\b/i.test(text) &&
    /\b(?:this\s+app|this\s+project|codebase|capabilit|tool|provider|runtime|feature|image|video|voice|stt|transcript|slack|teams|discord|email)\b/i.test(text)
  );
}

function countAnswerUrls(text: string): number {
  return (text.match(/\bhttps?:\/\/[^\s)\]"'<>]+/gi) ?? []).length;
}

function answerHasSourceCategoryShape(answer: string): boolean {
  const lower = answer.toLowerCase();
  const hasOfficial = /\bofficial|primary\b/i.test(lower);
  const hasRuntime = /\bruntime|model|product|documentation|docs?\b/i.test(lower);
  const hasCommunity = /\bcommunity|third[- ]party|forum|issue|report|anecdotal\b/i.test(lower);
  const hasMissing = /\bmissing|weak|unknown|unverified|could not verify\b/i.test(lower);
  return (hasOfficial && hasRuntime && hasCommunity && hasMissing) || /\bsource\s+categor/i.test(lower);
}

function answerHasCapabilityStateShape(answer: string): boolean {
  const lower = answer.toLowerCase();
  const hasImplemented = /\bimplemented|code exists|implementation\b/i.test(lower);
  const hasConfigured = /\bconfigured|configuration|callable|available now|active|api key|secret|env\b/i.test(lower);
  const hasPlanned = /\bplanned|missing|not implemented|partial|roadmap|fallback\b/i.test(lower);
  return hasImplemented && hasConfigured && hasPlanned;
}

function answerUsesPriorRunArtifact(answer: string): boolean {
  return /\b(?:docs\/improvements|raw-results|comparison\s+run|comparison\s+reports?|previous\s+run|benchmark\s+(?:artifact|confirmation|result)|run-output|internal\s+audit\s+logs?|multiple\s+audit\s+files?|previous\s+inspections?)\b/i.test(answer);
}

function applyStructuralAnswerGuards(input: {
  message: string;
  answer: string;
  report: UniversalCriticReport;
  remainingToolBudget: number;
  dossier?: UniversalEvidenceDossier | null;
}): UniversalCriticReport {
  const dossier = input.dossier;
  const webEvidenceCount = dossier?.sourceMap.filter((source) => source.url).length ?? 0;
  const repoEvidenceCount = dossier?.sourceMap.filter((source) => source.filePath).length ?? 0;
  if (asksForSourceCategorySeparation(input.message)) {
    const lacksShape = !answerHasSourceCategoryShape(input.answer) || countAnswerUrls(input.answer) < 2;
    if (lacksShape) {
      if (webEvidenceCount < 2 && input.remainingToolBudget > 0) {
        return {
          ...input.report,
          decision: "continue",
          confidence: "medium",
          scores: {
            ...input.report.scores,
            grounding: Math.min(input.report.scores.grounding, 2) as UniversalCriticAxis,
            sourceQuality: Math.min(input.report.scores.sourceQuality, 1) as UniversalCriticAxis,
            uncertaintyHandling: Math.min(input.report.scores.uncertaintyHandling, 2) as UniversalCriticAxis,
          },
          findings: [
            ...input.report.findings,
            "The request asks for source-category separation, but the draft does not yet expose enough source-backed category evidence.",
          ].slice(0, 8),
          missingEvidence: [
            ...input.report.missingEvidence,
            "Official/primary, product/runtime/model, community or third-party, and weak/missing source-category evidence.",
          ].slice(0, 8),
          nextActions: [
            "Gather targeted official/primary, runtime/product/model, and community or third-party sources; then rewrite with category labels.",
          ],
        };
      }
      return {
        ...input.report,
        decision: "repair",
        confidence: input.report.confidence === "low" ? "medium" : input.report.confidence,
        scores: {
          ...input.report.scores,
          sourceQuality: Math.min(input.report.scores.sourceQuality, 2) as UniversalCriticAxis,
          uncertaintyHandling: Math.min(input.report.scores.uncertaintyHandling, 2) as UniversalCriticAxis,
        },
        findings: [
          ...input.report.findings,
          "The evidence is available, but the final answer needs explicit source-category separation.",
        ].slice(0, 8),
        nextActions: [],
        repairInstruction:
          "Use the evidence dossier to rewrite with a compact source-category table: official/primary, product/runtime/model docs, community/third-party evidence, and weak/missing evidence. Include source URLs where available and do not invent missing categories.",
      };
    }
  }

  if (asksForCapabilityState(input.message) && (!answerHasCapabilityStateShape(input.answer) || answerUsesPriorRunArtifact(input.answer))) {
    if (repoEvidenceCount < 2 && input.remainingToolBudget > 0) {
      return {
        ...input.report,
        decision: "continue",
        confidence: "medium",
        scores: {
          ...input.report.scores,
          grounding: Math.min(input.report.scores.grounding, 2) as UniversalCriticAxis,
          evidenceCoverage: Math.min(input.report.scores.evidenceCoverage, 2) as UniversalCriticAxis,
        },
        findings: [
          ...input.report.findings,
          "The request asks for implemented/configured/planned capability state, but repo/config evidence is still too thin.",
        ].slice(0, 8),
        missingEvidence: [
          ...input.report.missingEvidence,
          "File/config evidence for implemented code, current configuration or callability, fallback, and planned or missing pieces.",
        ].slice(0, 8),
        nextActions: ["Inspect the capability implementation, provider/config resolution, fallback path, and any detector/registry files."],
      };
    }
    return {
      ...input.report,
      decision: "repair",
      confidence: input.report.confidence === "low" ? "medium" : input.report.confidence,
      scores: {
        ...input.report.scores,
        evidenceCoverage: Math.min(input.report.scores.evidenceCoverage, 2) as UniversalCriticAxis,
        actionability: Math.min(input.report.scores.actionability, 2) as UniversalCriticAxis,
      },
        findings: [
          ...input.report.findings,
          answerUsesPriorRunArtifact(input.answer)
            ? "The answer uses prior run artifacts as capability evidence; current capability/status answers must rely on source, config, or app-state evidence."
            : "The evidence is available, but the answer needs a capability-state matrix instead of blending implementation and runtime availability.",
        ].slice(0, 8),
        nextActions: [],
        repairInstruction:
        "Use the evidence dossier to rewrite with a compact table separating implemented/code exists, configured or callable now, active fallback if any, and planned or missing work. Cite source/config/app-state evidence, exclude prior comparison reports or docs/improvements run artifacts as proof of current state, and keep paid calls/downloads out of scope.",
    };
  }

  return input.report;
}

function planPreview(plan: UniversalInvestigationPlan): string {
  return JSON.stringify({
    taskSummary: plan.taskSummary,
    assumptions: plan.assumptions,
    dimensions: plan.dimensions.map((dimension) => ({
      id: dimension.id,
      priority: dimension.priority,
      question: dimension.question,
      evidenceNeeded: dimension.evidenceNeeded,
      doneCriteria: dimension.doneCriteria,
    })),
    finalAnswerCriteria: plan.finalAnswerCriteria,
  });
}

function heuristicCritic(input: {
  message: string;
  answer: string;
  toolsUsed: string[];
  requireToolUse: boolean;
  remainingToolBudget: number;
  dossier?: UniversalEvidenceDossier | null;
}): UniversalCriticReport {
  const answer = input.answer.trim();
  const lower = answer.toLowerCase();
  const scores: UniversalCriticScore = {
    directness: 3,
    grounding: 2,
    evidenceCoverage: 2,
    sourceQuality: 2,
    actionability: 3,
    uncertaintyHandling: 2,
    conciseEnough: 3,
  };

  if (answer.length < 80 || /^(?:i'?m sorry|i can'?t|cannot help|i don'?t know)\b/i.test(answer)) {
    scores.directness = 1;
    scores.grounding = 1;
    return {
      decision: input.remainingToolBudget > 0 ? "continue" : "repair",
      confidence: "medium",
      scores,
      findings: ["The draft is too short or generic for a non-trivial request."],
      missingEvidence: input.requireToolUse ? ["No sufficient tool-grounded evidence is visible in the answer."] : [],
      nextActions: input.remainingToolBudget > 0 ? ["Use targeted tools to gather direct evidence, then rewrite the answer."] : [],
      repairInstruction: "Rewrite the answer directly for the user, preserving only claims supported by available evidence.",
    };
  }

  if (input.requireToolUse && input.toolsUsed.length === 0 && input.remainingToolBudget > 0) {
    scores.evidenceCoverage = 1;
    return {
      decision: "continue",
      confidence: "high",
      scores,
      findings: ["The request requires evidence, but no tools were used."],
      missingEvidence: ["Direct evidence from available tools."],
      nextActions: ["Use the most relevant available read-only tools before finalizing."],
    };
  }

  const asksForEvidence = /\b(?:source|cite|evidence|file|line|current|latest|verify|audit|inspect|compare|research)\b/i.test(input.message);
  const hasGrounding = /\bhttps?:\/\/\S+|\b[\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|py|css|html):\d+\b/.test(answer);
  if (asksForEvidence && !hasGrounding && input.remainingToolBudget > 0) {
    scores.grounding = 1;
    return {
      decision: "continue",
      confidence: "medium",
      scores,
      findings: ["The draft lacks visible source URLs or file:line citations for an evidence-oriented request."],
      missingEvidence: ["Grounding references in the final answer."],
      nextActions: ["Gather or surface direct source/file references and rewrite with citations."],
    };
  }

  if (answer.length > 18_000 && !/\b(?:full|exhaustive|all details|comprehensive)\b/i.test(input.message)) {
    scores.conciseEnough = 1;
    return {
      decision: "repair",
      confidence: "medium",
      scores,
      findings: ["The draft is likely longer than needed for the user's request."],
      missingEvidence: [],
      nextActions: [],
      repairInstruction: "Compress the answer while preserving evidence, conclusions, caveats, and concrete next steps.",
    };
  }

  if (lower.includes("as an ai language model") || (lower.includes("i do not have access") && input.toolsUsed.length > 0)) {
    scores.grounding = 1;
    return {
      decision: "repair",
      confidence: "medium",
      scores,
      findings: ["The answer contains generic model limitation wording despite available tool evidence."],
      missingEvidence: [],
      nextActions: [],
      repairInstruction: "Remove generic limitation wording and answer from the gathered evidence.",
    };
  }

  return applyStructuralAnswerGuards({
    message: input.message,
    answer: input.answer,
    remainingToolBudget: input.remainingToolBudget,
    dossier: input.dossier,
    report: {
    decision: "finalize",
    confidence: "medium",
    scores,
    findings: ["The draft appears complete enough for the available budget."],
    missingEvidence: [],
    nextActions: [],
    },
  });
}

function buildHeuristicFromDossier(
  input: Parameters<typeof heuristicCritic>[0] & { dossier: UniversalEvidenceDossier },
): UniversalCriticReport {
  const base = heuristicCritic(input);
  const dossier = input.dossier;
  if (!dossier) return base;
  if (dossier.toolFailures.length > 0 && dossier.toolFailures.some((failure) => !failure.recovered)) {
    base.findings.push(`${dossier.toolFailures.filter((failure) => !failure.recovered).length} tool failures are still unrecovered.`);
  }
  if (dossier.sourceMap.length === 0 && input.requireToolUse) {
    base.scores.grounding = Math.min(base.scores.grounding, 1) as UniversalCriticAxis;
    base.scores.evidenceCoverage = Math.min(base.scores.evidenceCoverage, 1) as UniversalCriticAxis;
  }
  base.findings.push(`Dossier evidence kinds: ${Object.entries(dossier.coverage).map(([k, v]) => `${k}=${v}`).join(", ")}.`);
  return base;
}

function materiallyEvidenceRich(input: {
  dossier?: UniversalEvidenceDossier | null;
  toolsUsed: string[];
}): boolean {
  const dossier = input.dossier;
  if (!dossier) return false;
  const webSources = dossier.sourceMap.filter((source) => source.url).length;
  const repoSources = dossier.sourceMap.filter((source) => source.filePath).length;
  return (
    dossier.coverage.web >= 14 ||
    dossier.coverage.repo >= 18 ||
    webSources >= 8 ||
    repoSources >= 8 ||
    input.toolsUsed.length >= 32
  );
}

function capOverInvestigation(input: {
  report: UniversalCriticReport;
  dossier?: UniversalEvidenceDossier | null;
  toolsUsed: string[];
  remainingToolBudget: number;
}): UniversalCriticReport {
  if (input.report.decision !== "continue") return input.report;
  if (!materiallyEvidenceRich(input)) return input.report;
  const missing = input.report.missingEvidence;
  const likelyNiceToHave = missing.length === 0 || missing.every((item) =>
    /\b(?:exact|full content|all|benchmark|community|reddit|forum|windows-specific|confirmation|details|more|additional|directly support)\b/i.test(item)
  );
  if (!likelyNiceToHave && input.remainingToolBudget > 8) return input.report;
  return {
    ...input.report,
    decision: "repair",
    confidence: input.report.confidence === "low" ? "medium" : input.report.confidence,
    findings: [
      ...input.report.findings,
      "Evidence is already broad enough; further tool calls are likely diminishing returns.",
    ].slice(0, 8),
    nextActions: [],
    repairInstruction:
      input.report.repairInstruction ||
      "Finalize from the evidence already gathered. Preserve the strongest sources/file references and state remaining gaps explicitly instead of continuing to search.",
  };
}

export async function critiqueUniversalAgenticAnswer(input: {
  message: string;
  provider: string;
  modelId: string;
  apiKey: string;
  baseUrl?: string;
  plan: UniversalInvestigationPlan;
  answer: string;
  toolsUsed: string[];
  toolResults: ToolResultPreview[];
  requireToolUse: boolean;
  remainingToolBudget: number;
  dossier?: UniversalEvidenceDossier | null;
}): Promise<UniversalCriticReport> {
  const dossierSummary = input.dossier
    ? summarizeDossierForCritic(input.dossier, { maxItems: 18, maxChars: 3500 })
    : "";
  const fallback = input.dossier
    ? buildHeuristicFromDossier({ ...input, dossier: input.dossier })
    : heuristicCritic(input);
  fallback.dossierSummary = dossierSummary || undefined;
  try {
    const result = await callModel({
      provider: input.provider as ModelProvider,
      modelId: input.modelId,
      apiKey: input.apiKey,
      baseUrl: input.baseUrl,
      systemPrompt: CRITIC_SYSTEM_PROMPT,
      userMessage: [
        `User request:\n${input.message}`,
        `Investigation plan:\n${planPreview(input.plan)}`,
        `Tools used:\n${input.toolsUsed.join(", ") || "none"}`,
        `Tool result previews (last 12):\n${JSON.stringify(input.toolResults.slice(-12))}`,
        dossierSummary ? `Structured evidence dossier:\n${dossierSummary}` : "",
        `Draft answer:\n${input.answer.slice(0, 12_000)}`,
        `Remaining tool budget: ${input.remainingToolBudget}`,
      ].filter(Boolean).join("\n\n"),
      maxTokens: 1400,
      temperature: 0,
    });
    const parsed = normalizeReport(JSON.parse(stripJsonFence(result.response)));
    if (!parsed) return { ...fallback, dossierSummary };
    if (parsed.decision === "continue" && input.remainingToolBudget <= 0) {
      return {
        ...parsed,
        decision: "repair",
        repairInstruction: parsed.repairInstruction || "Finalize honestly with the evidence already gathered and label any unresolved gaps.",
        dossierSummary,
      };
    }
    const guarded = applyStructuralAnswerGuards({
      message: input.message,
      answer: input.answer,
      report: parsed,
      remainingToolBudget: input.remainingToolBudget,
      dossier: input.dossier,
    });
    return {
      ...capOverInvestigation({
        report: guarded,
        dossier: input.dossier,
        toolsUsed: input.toolsUsed,
        remainingToolBudget: input.remainingToolBudget,
      }),
      dossierSummary,
    };
  } catch {
    return capOverInvestigation({
      report: fallback,
      dossier: input.dossier,
      toolsUsed: input.toolsUsed,
      remainingToolBudget: input.remainingToolBudget,
    });
  }
}

export function summariseCriticDecision(report: UniversalCriticReport): string {
  const avg = scoreAverage(report.scores);
  return `${report.decision} (avg=${avg.toFixed(2)}, confidence=${report.confidence}, missing=${report.missingEvidence.length})`;
}
