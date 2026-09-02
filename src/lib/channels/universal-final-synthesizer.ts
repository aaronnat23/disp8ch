import type { ModelProvider } from "@/types/model";
import { callModel } from "@/lib/agents/multi-provider";
import {
  summarizeDossierForFinalAnswer,
  type UniversalEvidenceDossier,
} from "@/lib/channels/universal-evidence-dossier";
import type {
  UniversalCriticReport,
  UniversalCriticScore,
} from "@/lib/channels/universal-agentic-critic";
import type { UniversalInvestigationPlan } from "@/lib/channels/universal-agentic-planner";
import {
  answerHasRepoNativeCommands,
  asksForRepoNativeVerificationCommands,
  formatRepoCriterionAuditGuidance,
  formatRepoNativeCommandGuidance,
  formatRepoSecurityAuditGuidance,
  isRepoCriterionAuditRequest,
  isRepoSecurityAuditRequest,
} from "@/lib/channels/repo-audit-discipline";
import { buildConcisionGuard } from "@/lib/channels/answer-shape";
import {
  asksForBriefResponse,
  extractRequestedAnswerSections,
} from "@/lib/channels/universal-answer-shape";
import { formatRankedEvidenceForPrompt } from "@/lib/channels/evidence-ranking";
import type { FinalSynthesisContract } from "@/lib/channels/final-synthesis-contract";

export type SynthesizerInput = {
  message: string;
  provider: string;
  modelId: string;
  apiKey: string;
  baseUrl?: string;
  plan: UniversalInvestigationPlan;
  draft: string;
  dossier: UniversalEvidenceDossier;
  critic?: UniversalCriticReport | null;
  safetyBoundary?: "read_only" | "proposal_only" | "confirmed_mutation" | "dedicated_pipeline";
  routeMetadata?: Record<string, unknown>;
  finalSynthesisContract?: FinalSynthesisContract;
  maxTokens?: number;
};

export type SynthesizerResult = {
  answer: string;
  usedSynthesizer: boolean;
  notes: string[];
};

const SYNTH_SYSTEM_PROMPT = `You are the final-answer synthesizer for disp8ch AI, a local-first personal AI assistant.

Shape the final answer for the user, not for another model.

Self-identity: "disp8ch", "disp8ch AI", and "this app" all refer to the assistant itself. Never describe disp8ch AI as an unknown external product. Never mention internal pipeline artifacts (dossier, draft, critic, evidence budget, route names) in the final answer.

Rules:
- If the user stated an exact count or format (N sentences, N bullets, N lines, under N words), the final answer must contain exactly that and nothing else — no extra headers, sections, evidence blocks, or recommendations. Format compliance overrides every other shaping rule.
- Match the user's actual request. Do not paste boilerplate or section headers that the user did not ask for.
- Be evidence-aware: cite the file paths, source URLs, app state, or memory evidence that the dossier actually contains. Do not invent new facts.
- State unknowns explicitly when the dossier shows them. Do not hide gaps.
- Compress when the draft is too long while preserving the highest-value evidence and any next-action steps.
- If the dossier contains many web sources or repo files and the user did not ask for a brief answer, keep enough depth to be useful. Do not collapse a rich investigation into a short generic summary.
- For research answers, preserve the strongest official/source-quality distinctions, failure risks, and concrete recommendation.
- If the user asks about weak/missing source categories, include a Source Category Assessment table separating official/primary sources, product/runtime/model documentation, community/third-party evidence, and missing/weak evidence.
- For practical recommendation research with source categories, include a concise risks/tradeoffs section after the recommendation.
- In source-category tables, include visible source URLs from the dossier for every non-missing row when available; if a row has no direct URL support, say that evidence is weak or missing.
- For source-category research, do not promote an exact version, model name, package, installer, or benchmark as the primary recommendation unless the dossier summary contains direct source support for that exact item. If evidence is weak, recommend the verified class of option and label the exact item as unverified.
- Treat exact model/version claims from search snippets, blogs, gists, videos, or community posts as community-only unless the dossier also contains official/runtime documentation for the exact item.
- For repo answers, preserve the main implementation path, cited files, risks, and verification guidance.
- For release/readiness/criterion audits, lead with the recommendation, then provide a criterion evidence table, residual risks, exact repo-native verification commands, and explicit unmeasured unknowns.
- For repo verification commands, derive from package/script evidence. Prefer Windows-native pnpm.cmd/tsx commands when that is what the dossier supports; do not invent Jest or node-loader commands without package/config evidence.
- For Design Studio / image / artifact outputs, include the artifact ID, version, dimensions, and how to inspect/update.
- For code edits, include the changed files and the verification command/result.
- For workflow/app designs, include trigger, nodes/tools, data flow, risks, and confirmation boundary.
- For capability/status answers, separate implemented / configured / callable only when the dossier supports that distinction.
- If the user asks whether app capabilities are available now, include a compact status table with capability, implemented/code evidence, configured/callable now, fallback or planned/missing state, and evidence.
- Keep the opening capability verdict consistent with every capability row. Tool registration or read-only classification alone does not prove a dependency, browser binary, credential, or external service is callable at runtime; require app-state or live-probe evidence and otherwise say conditional/unknown.
- If the user states a Return: or Respond with: list of semantic sections, use those headings in the stated order and honor counts inside them. Do not replace them with generic recommendation, tradeoff, evidence, or source-category sections.
- For current capability/status answers, treat source/config/app-state files as authoritative. Do not use prior comparison reports, previous run outputs, or files under docs/improvements as proof of current runtime availability.
- This repository is operated and verified Windows-native. If a repo or capability answer includes commands, use executable Windows cmd/PowerShell forms such as pnpm.cmd and PowerShell environment checks; do not emit bash-only cat/grep/export syntax.
- Never add raw tool-call markup, hidden benchmark scenario text, or secrets.
- Do not use benchmark IDs or memorized test cases.
- Do not include source links, files, or claims that are not in the dossier summary.

Return the final answer text only. No commentary, no JSON wrapper, no metadata prefix.`;

function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) return fenced[1].trim();
  return trimmed;
}

function isLongDraft(draft: string): boolean {
  return draft.length > 16_000;
}

function isWeakCritic(critic?: UniversalCriticReport | null): boolean {
  if (!critic) return false;
  const avg = (
    critic.scores.directness +
    critic.scores.grounding +
    critic.scores.evidenceCoverage +
    critic.scores.sourceQuality +
    critic.scores.actionability +
    critic.scores.uncertaintyHandling +
    critic.scores.conciseEnough
  ) / 7;
  return avg < 2.4 || critic.decision === "repair";
}

function requestText(input: { message?: string; dossier: UniversalEvidenceDossier }): string {
  return `${input.message ?? ""}\n${input.dossier.request ?? ""}`;
}

function asksForSourceCategorySeparation(text: string): boolean {
  return /\b(?:source\s+categor(?:y|ies)|official\s+(?:docs?|sources?)|community\s+(?:reports?|sources?|signal)|third[- ]party|weak\s+(?:or\s+missing\s+)?source|missing\s+(?:source|evidence)|confirmed\s+facts|likely\s+inferences|unknowns)\b/i.test(text);
}

function externalWebSourceCount(dossier: UniversalEvidenceDossier): number {
  return dossier.sourceMap.filter((source) =>
    Boolean(
      source.url &&
      /^https?:\/\//i.test(source.url) &&
      !/^https?:\/\/(?:localhost|127\.0\.0\.1)\b/i.test(source.url),
    ),
  ).length;
}

function asksForBroadResearchJudgment(text: string): boolean {
  return /\b(?:research|compare|comparison|versus|vs\.?|best|recommend|should\s+i|which\s+(?:one|tool|model|option|setup|approach)|setup|install|configure|troubleshoot|diagnos|current|latest|recent|source|sources|citation|docs?|documentation|public|online)\b/i.test(text);
}

function shouldApplyResearchSourceLens(input: {
  message?: string;
  dossier: UniversalEvidenceDossier;
  plan?: UniversalInvestigationPlan;
}): boolean {
  const text = requestText({ message: input.message, dossier: input.dossier });
  if (asksForBriefResponse(input.message ?? input.dossier.request)) return false;
  const webDimensions = input.plan?.dimensions.filter((dimension) => dimension.evidenceNeeded.includes("web")).length ?? 0;
  const enoughWebEvidence =
    input.dossier.coverage.web >= 4 ||
    externalWebSourceCount(input.dossier) >= 3 ||
    webDimensions >= 2;
  return enoughWebEvidence && asksForBroadResearchJudgment(text);
}

function asksForCapabilityState(text: string): boolean {
  return (
    /\b(?:implemented|configured|callable|available\s+(?:now|right\s+now|currently)|merely\s+planned|planned\s+capabilit|not\s+configured|missing\s+(?:key|secret|model|provider))\b/i.test(text) &&
    /\b(?:this\s+app|this\s+project|codebase|capabilit|tool|provider|runtime|feature|image|video|voice|stt|transcript|slack|teams|discord|email)\b/i.test(text)
  );
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

function answerHasCapabilityStateContradiction(answer: string): boolean {
  const text = String(answer || "");
  const blanketNegative =
    /\b(?:neither|not\s+currently\s+callable\s+for\s+either|both\s+(?:are\s+)?not\s+(?:configured|callable|available))\b/i.test(text);
  const blanketPositive =
    /\b(?:both|all)\s+(?:are\s+)?(?:currently\s+)?(?:configured|callable|available)\b/i.test(text);
  const positiveRow =
    /\bconfigured\s*\/?\s*callable\s+now\b[^\n]{0,80}(?:✅|yes|callable)|(?:✅|yes)[^\n]{0,80}\bcallable\s+now\b/i.test(text);
  const negativeRow =
    /\bconfigured\s*\/?\s*callable\s+now\b[^\n]{0,80}(?:❌|no|not configured|unknown)|(?:❌|no)[^\n]{0,80}\bcallable\s+now\b/i.test(text);
  return (blanketNegative && positiveRow) || (blanketPositive && negativeRow);
}

function normalizeSectionLabel(section: string): string {
  return section
    .toLowerCase()
    .replace(/\b(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+|next|in\s+order)\b/g, " ")
    .replace(/\b(?:the|a|an)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function answerHasRequestedSectionStructure(answer: string, sections: string[]): boolean {
  if (sections.length === 0) return true;
  const headings = answer
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*#{1,6}\s*/, "").replace(/[*_:`]/g, "").trim())
    .filter(Boolean);

  let cursor = -1;
  for (const section of sections) {
    const label = normalizeSectionLabel(section);
    if (!label) continue;
    const next = headings.findIndex((heading, index) =>
      index > cursor && normalizeSectionLabel(heading).includes(label),
    );
    if (next < 0) return false;
    cursor = next;
  }
  return true;
}

function hasUnixOnlyRepoCommands(answer: string): boolean {
  return (
    /```(?:bash|sh)\b/i.test(answer) ||
    /^\s*(?:cat|grep|export)\s+\S+/im.test(answer) ||
    /`(?:cat|grep|export|ls)\s+[^`\n]+`/i.test(answer) ||
    /\$\{[A-Z_][A-Z0-9_]*(?::[-+?])[^}]*\}/.test(answer)
  );
}

export function stripUnrequestedUnixVerificationSection(answer: string): string {
  if (!hasUnixOnlyRepoCommands(answer)) return answer;
  const lines = answer.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) =>
    /^\s*(?:#{1,6}\s*)?(?:\*\*)?(?:verification|test)\s+commands?\b.*?(?:\*\*)?:?\s*$/i.test(line),
  );
  if (headingIndex < 0) return answer;
  return lines.slice(0, headingIndex).join("\n").trim();
}

function asksForRepoAuditOrCommands(input: {
  message?: string;
  dossier: UniversalEvidenceDossier;
  plan?: UniversalInvestigationPlan;
}): { criterionAudit: boolean; securityAudit: boolean; nativeCommands: boolean } {
  const text = requestText({ message: input.message, dossier: input.dossier });
  const criterionAudit = isRepoCriterionAuditRequest(text, input.plan);
  const securityAudit = isRepoSecurityAuditRequest(text, input.plan);
  const nativeCommands = asksForRepoNativeVerificationCommands(text) || criterionAudit;
  return { criterionAudit, securityAudit, nativeCommands };
}

export function shouldRunSynthesizer(input: {
  message?: string;
  draft: string;
  dossier: UniversalEvidenceDossier;
  plan?: UniversalInvestigationPlan;
  critic?: UniversalCriticReport | null;
}): boolean {
  if (!input.draft || input.draft.trim().length < 80) return false;
  const text = requestText(input);
  const requestedSections = extractRequestedAnswerSections(input.message ?? input.dossier.request);
  if (!answerHasRequestedSectionStructure(input.draft, requestedSections)) return true;
  const researchSourceLens = shouldApplyResearchSourceLens(input);
  const repoAudit = asksForRepoAuditOrCommands(input);
  if (
    repoAudit.criterionAudit &&
    (input.dossier.coverage.repo > 0 || input.dossier.sourceMap.some((source) => source.filePath))
  ) {
    return true;
  }
  if (
    repoAudit.securityAudit &&
    (input.dossier.coverage.repo > 0 || input.dossier.sourceMap.some((source) => source.filePath)) &&
    (
      (input.critic?.missingEvidence.length ?? 0) > 0 ||
      [
        /\bsrc\/lib\/secrets\/store\.ts\b/i,
        /\bsrc\/lib\/utils\/logger\.ts\b/i,
        /\bsrc\/lib\/workflows\/secret-redaction\.ts\b/i,
        /\bsrc\/lib\/workflows\/execution-traces\.ts\b/i,
        /\bsrc\/lib\/channels\/final-answer-sanitizer\.ts\b/i,
      ].filter((pattern) => pattern.test(input.draft)).length < 4
    )
  ) {
    return true;
  }
  if (
    repoAudit.nativeCommands &&
    (input.dossier.coverage.repo > 0 || input.dossier.sourceMap.some((source) => source.filePath)) &&
    !answerHasRepoNativeCommands(input.draft)
  ) {
    return true;
  }
  if (
    asksForSourceCategorySeparation(text) &&
    (input.dossier.coverage.web > 0 || input.dossier.sourceMap.some((source) => source.url))
  ) {
    return true;
  }
  if (researchSourceLens && input.draft.length < 9000) {
    return true;
  }
  if (
    asksForCapabilityState(text) &&
    input.dossier.sourceMap.some((source) => source.filePath) &&
    (
      !answerHasCapabilityStateShape(input.draft) ||
      answerUsesPriorRunArtifact(input.draft) ||
      answerHasCapabilityStateContradiction(input.draft) ||
      hasUnixOnlyRepoCommands(input.draft)
    )
  ) {
    return true;
  }
  if (isWeakCritic(input.critic)) return true;
  if (isLongDraft(input.draft)) return true;
  if (input.dossier.sourceMap.length > 0 && input.draft.length < 1200) return false;
  return false;
}

export async function runFinalSynthesizer(input: SynthesizerInput): Promise<SynthesizerResult> {
  const structuralText = requestText({ message: input.message, dossier: input.dossier });
  const sourceCategoryRequest = asksForSourceCategorySeparation(structuralText);
  const researchSourceLens = shouldApplyResearchSourceLens({
    message: input.message,
    dossier: input.dossier,
    plan: input.plan,
  });
  const capabilityStateRequest = asksForCapabilityState(structuralText);
  const requestedSections = extractRequestedAnswerSections(input.message);
  const repoAudit = asksForRepoAuditOrCommands({
    message: input.message,
    dossier: input.dossier,
    plan: input.plan,
  });
  const dossierSummary = summarizeDossierForFinalAnswer(input.dossier, {
    maxItems: sourceCategoryRequest || researchSourceLens || capabilityStateRequest || repoAudit.criterionAudit || repoAudit.securityAudit ? 28 : 14,
    maxChars: sourceCategoryRequest || researchSourceLens || capabilityStateRequest || repoAudit.criterionAudit || repoAudit.securityAudit ? 6500 : 2400,
  });
  const rankedEvidence = formatRankedEvidenceForPrompt(input.dossier, 10);
  const concisionGuard = buildConcisionGuard(input.message);
  const draft = String(input.draft || "").trim();
  const synthBudget = input.maxTokens ?? 4500;
  const notes: string[] = [];
  const richEvidence =
    input.dossier.coverage.web >= 8 ||
    input.dossier.coverage.repo >= 8 ||
    input.dossier.sourceMap.length >= 8;

  if (draft.length > 16_000) notes.push("compressed: draft exceeded 16k chars");
  if (isWeakCritic(input.critic)) notes.push("repair: critic scores below threshold");
  if (input.dossier.toolFailures.some((failure) => !failure.recovered)) {
    notes.push("tool_failures_present");
  }

  try {
    const result = await callModel({
      provider: input.provider as ModelProvider,
      modelId: input.modelId,
      apiKey: input.apiKey,
      baseUrl: input.baseUrl,
      systemPrompt: [
        SYNTH_SYSTEM_PROMPT,
        // Evidence-proportional richness (A1): a rich dossier earns a
        // sectioned narrative that uses most of the distinct evidence; a thin
        // dossier must stay concise instead of padding.
        input.dossier.items.length >= 10 || input.dossier.sourceMap.length >= 6
          ? `Richness directive: the investigation gathered ${input.dossier.items.length} evidence items across ${input.dossier.sourceMap.length} sources. Produce a sectioned narrative (overview, findings per theme with citations, risks/unknowns, next steps) that uses most of the distinct evidence. Do not collapse it into a short summary unless the user asked for brevity.`
          : "Richness directive: evidence is limited — stay concise, state what is missing, and do not pad.",
      ].join("\n\n"),
      userMessage: [
        `User request:\n${input.message}`,
        `Investigation plan:\n${input.plan.taskSummary}`,
        `Plan criteria:\n${input.plan.finalAnswerCriteria.join("; ") || "answer directly with evidence and caveats."}`,
        input.safetyBoundary ? `Safety boundary: ${input.safetyBoundary}` : "",
        input.routeMetadata?.routeSource ? `Route source: ${String(input.routeMetadata.routeSource)}` : "",
        `Evidence dossier summary:\n${dossierSummary}`,
        `Ranked evidence preference:\n${rankedEvidence}`,
        `Concision guard:\n${concisionGuard.instruction}\nTarget length: ${concisionGuard.targetWords}. Risk limit: ${concisionGuard.riskLimit}. Test/command limit: ${concisionGuard.testLimit}.`,
        "Exact-token discipline: preserve exact model IDs, package names, file names, versions, and commands from the user request. If evidence does not support the exact requested token, say that directly instead of substituting a similar token.",
        input.finalSynthesisContract
          ? `Final synthesis contract:\n${input.finalSynthesisContract.instructions}\nRequired signals: ${input.finalSynthesisContract.requiredSignals.join(", ")}`
          : "",
        input.critic
          ? `Critic report:\nscores=${JSON.stringify(input.critic.scores)}\nfindings=${input.critic.findings.join("; ")}\nmissing=${input.critic.missingEvidence.join("; ")}\nrepair=${input.critic.repairInstruction || "—"}`
          : "",
        richEvidence && !/\b(?:short|brief|concise|one paragraph|tl;dr)\b/i.test(input.message)
          ? "Depth instruction: this was an evidence-rich investigation. Keep a substantive answer; prefer roughly 4k-8k characters unless the user's request clearly needs less."
          : "",
        sourceCategoryRequest
          ? "Source-category instruction: include a Source Category Assessment table with rows for official/primary, product/runtime/model docs, community/third-party evidence, and weak/missing evidence. Include visible source URLs from the dossier for every non-missing row where available; if a row lacks direct URL support, mark it weak or missing. Add a concise risks/tradeoffs section when giving a practical recommendation. Do not recommend exact model/version/package names unless the dossier directly supports that exact item; if evidence is weak or only community/snippet-backed, recommend the verified class of option and label exact examples as unverified."
          : "",
        !sourceCategoryRequest && researchSourceLens
          ? "Research source-lens instruction: this is an evidence-backed web research answer even though the user did not explicitly ask for a source-category table. Preserve source quality in the prose: distinguish official/primary evidence from product/runtime docs and community/third-party reports where the dossier supports it; include visible References; include concise risks/tradeoffs or evidence limits when relevant; do not make exact version/model/package recommendations stronger than the cited evidence supports. Use a table only if it makes the answer clearer."
          : "",
        capabilityStateRequest
          ? "Capability-state instruction: explicitly separate implemented/code exists, configured/callable now, active fallback if any, and planned/missing. Keep the opening verdict consistent with every capability row. Tool registration and package declaration alone do not prove live runtime callability; require app-state or live-probe evidence and otherwise say conditional/unknown. Cite source/config/app-state files from the dossier. Exclude prior comparison reports, previous run outputs, and docs/improvements artifacts from the evidence table. If commands are useful, use Windows-native cmd/PowerShell and pnpm.cmd forms only."
          : "",
        requestedSections.length > 0
          ? `Requested-section instruction: use these headings in this exact order: ${requestedSections.join(", ")}. Honor every semantic count in the labels. Do not add substitute recommendation, tradeoff, evidence, or source-category sections.`
          : "",
        repoAudit.criterionAudit
          ? `Repo criterion-audit instruction:\n${formatRepoCriterionAuditGuidance()}`
          : "",
        repoAudit.securityAudit
          ? `Repo security-audit instruction:\n${formatRepoSecurityAuditGuidance()}`
          : "",
        !repoAudit.criterionAudit && repoAudit.nativeCommands
          ? `Repo-native command instruction:\n${formatRepoNativeCommandGuidance()}`
          : "",
        `Draft answer:\n${draft.slice(0, 12_000)}`,
      ].filter(Boolean).join("\n\n"),
      maxTokens: synthBudget,
      temperature: 0.1,
    });
    const cleaned = stripJsonFence(result.response || "").trim();
    if (cleaned.length >= 80) {
      return { answer: cleaned, usedSynthesizer: true, notes };
    }
    return { answer: draft, usedSynthesizer: false, notes: [...notes, "synthesizer_returned_too_short"] };
  } catch {
    return { answer: draft, usedSynthesizer: false, notes: [...notes, "synthesizer_failed"] };
  }
}

export function criticScoreIsStrong(scores: UniversalCriticScore, threshold = 2.5): boolean {
  const avg = (
    scores.directness +
    scores.grounding +
    scores.evidenceCoverage +
    scores.sourceQuality +
    scores.actionability +
    scores.uncertaintyHandling +
    scores.conciseEnough
  ) / 7;
  return avg >= threshold;
}
