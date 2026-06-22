import type { ModelProvider } from "@/types/model";
import { callModel } from "@/lib/agents/multi-provider";
import type { EvidenceLedgerEntry } from "@/lib/channels/evidence-ledger-v2";
import { formatEvidencePackForModel } from "@/lib/channels/evidence-ledger-v2";
import { compressEvidence } from "@/lib/channels/evidence-compressor";
import type { EvidenceItem } from "@/lib/channels/evidence-ledger";
import { injectModelFamilyGuidance } from "@/lib/channels/model-family-guidance";
import { logger } from "@/lib/utils/logger";

const log = logger.child("channels:evidence-rich-synthesis");

export type SynthesisRequirements = {
  minSections?: string[];
  minVerifiedSources?: number;
  minConcreteDetails?: number;
  requireCommands?: boolean;
  requireRisks?: boolean;
  requireTests?: boolean;
  requireValidationChecklist?: boolean;
  requireSourceCategories?: boolean;
  sectionPlanText?: string;
  /** Budget fields: compact synthesis preserves quality at reduced length. */
  targetWords?: number;
  hardCapWords?: number;
  maxSections?: number;
  maxTables?: number;
  maxCodeBlocks?: number;
};

export type SynthesisInput = {
  userMessage: string;
  route: string;
  routeSource: string;
  evidencePack: string;
  ledger: EvidenceLedgerEntry[];
  evidenceItems?: EvidenceItem[];
  currentDraft: string;
  provider: ModelProvider;
  modelId: string;
  apiKey: string;
  baseUrl?: string | null;
  requirements?: SynthesisRequirements;
  depthTier: "thorough" | "exhaustive";
};

export type SynthesisDiagnostics = {
  promptChars: number;
  answerChars: number;
  tokensUsed: number;
  route: string;
  evidenceCounts: {
    verifiedSources: number;
    totalLedger: number;
    webSearches: number;
    urlsFetched: number;
    filesRead: number;
  };
  contractsRun: string[];
  contractFailures: number;
  synthesisUsed: boolean;
  rejectedReason?: string;
  budget?: { targetWords: number; hardCapWords: number; maxTokens: number };
};

export type SynthesisResult = {
  answer: string;
  diagnostics: SynthesisDiagnostics;
};

const SYSTEM_PROMPT = [
  "You are disp8ch AI's synthesis engine. Transform a safe draft into a compact, decision-ready answer.",
  "",
  "ANSWER BUDGET — you MUST respect this:",
  "- The input will give you a target word count and a hard cap. Aim for the target.",
  "- Do NOT exceed the hard cap. A shorter answer that hits all requirements is BETTER than a longer one that rambles.",
  "- If you are close to the target and the answer already covers what matters, stop writing. Do not add filler.",
  "",
  "OUTPUT STYLE:",
  "1. LEAD WITH THE CONCRETE DECISION. Commit to ONE primary choice (exact name/version/tag, exact command, exact config). Put alternates after.",
  "2. USE QUANTITATIVE TABLES. For sizing / budget / comparison / matrix prompts, render markdown tables with concrete numbers — not prose paragraphs.",
  "3. NAME WHAT WON'T WORK. Add a 'Rejected Options' or 'What Won't Work' table when the prompt involves choosing between options or compatibility.",
  "4. PROPOSE WORKAROUNDS when the primary capability is unavailable.",
  "5. SPECIFIC GAPS, NOT META-FAILURES. Say 'Could not measure X — source Y blocks automation' — NOT 'Missing source category Z'.",
  "6. Put limitations AFTER the useful synthesis unless evidence is genuinely absent.",
  "7. INLINE CITATIONS. Cite each verified source inline next to the claim it supports. Do NOT build separate 'Source Category Table' or 'Verified vs Inferred' tables — keep citations next to claims.",
  "8. CITATION FORMAT. Use only full markdown links or bare full URLs that appear in the verified evidence pack. Bad: [vendor docs] or [github issue]. Good: [Project setup docs](https://example.com/docs/setup).",
  "9. SOURCE DATING. For current/latest/recent prompts, include a compact 'Sources checked' line near the end: 'Sources checked: retrieved today; source publish/update dates were not consistently visible.' If a source date is known, state it.",
  "10. ONE 'Sources' FOOTER (optional). At the very end, you may include a single short Sources list with the URLs already cited inline. Do not repeat full source descriptions.",
  "",
  "DEDUP RULES — violations make answers bloated and repetitive:",
  "11. Do NOT mention the same model, endpoint, version, or caveat in multiple sections. Pick the MOST appropriate section and put it there once.",
  "12. If a table already contains a comparison, do NOT repeat each row in prose.",
  "13. If validation steps cover an endpoint, do NOT repeat that endpoint under failure diagnostics unless adding a NEW failure mode.",
  "14. If a claim has an inline citation, do NOT repeat the same URL in a source table.",
  "15. Prefer ONE compact 'Risks and Unknowns' section over separate 'Failure Modes', 'Risks', 'Unknowns', and 'What Could Not Verify' sections unless the task explicitly requires them.",
  "16. Merge sections that overlap. If 'Setup Commands' include a validation step, do not repeat it under 'Validation Checklist'.",
  "",
  "EVIDENCE RULES:",
  "17. You MAY use your trained knowledge to add specific factual content even when no URL in the evidence pack contains the exact fact. Training-knowledge claims that are encouraged: exact version tags / image tags / package versions / model identifiers, specific resource sizes / file sizes / memory budgets / quantization sizes, default port numbers / endpoint paths / base URLs of well-known services, environment variables / config syntax / command flags / file/folder layout conventions, well-known tuning knobs and their effects, API contracts / method signatures for widely-documented libraries, common error patterns and their root causes. Write these naturally — do NOT prefix with 'I think' or mark with '[trained]'.",
  "18. You MUST NOT: invent specific URLs not in the evidence pack, claim you ran a tool you didn't run, claim you read a specific file you didn't read, fabricate experimental results or measurements not in evidence.",
  "19. When a fact is from the evidence pack, cite the URL inline. When a fact is from training, write it naturally without disclaimer.",
  "20. If your output would be substantially weaker without a training-knowledge fact, USE that fact. Do not produce a generic 'pick something that fits' answer when you know the specifics.",
  "",
  "STRUCTURE:",
  "21. Lead with: a Primary Recommendation (1-3 lines, decision).",
  "22. Follow with: domain-appropriate compact sections — for sizing prompts: budget table; for setup prompts: exact commands + validation checklist; for comparison prompts: matrix table; for gap analysis: prioritized plan with concrete targets.",
  "23. For local runtime / model setup / deployment-sizing prompts, the answer is incomplete unless it includes: exact chosen model/runtime/config identifier, quantitative fit table with units, exact commands/config values, rejected options, and validation/failure diagnostics.",
  "24. The final answer must be standalone and decision-ready.",
  "25. Keep the total section count low. Prefer 4-6 compact sections over 10+ thin ones.",
  "",
  "FORBIDDEN OUTPUT:",
  "26. Do not output raw tool syntax, XML, DSML, or internal evidence IDs.",
  "27. Do not include filler ('In summary, ...', 'Hope this helps!', 'Let me know if...').",
  "28. Do not include a verbose 'Verified vs Inferred' table — inline citations next to claims do the same job.",
  "29. Do not produce a separate 'Source Category Table' — inline citations are sufficient.",
  "30. Do not repeat the same content in multiple sections.",
].join("\n");

function buildBudgetInstruction(requirements?: SynthesisRequirements): string {
  const target = requirements?.targetWords ?? 1100;
  const hardCap = requirements?.hardCapWords ?? Math.ceil(target * 1.25);

  const parts = [
    `ANSWER BUDGET: target ${target} words. Hard cap: ${hardCap} words.`,
  ];

  if (requirements?.maxSections) {
    parts.push(`Max sections: ${requirements.maxSections}. Prefer 4-6 compact sections over many thin ones.`);
  }
  if (requirements?.maxTables) {
    parts.push(`Max tables: ${requirements.maxTables}.`);
  }
  if (requirements?.maxCodeBlocks) {
    parts.push(`Max code blocks: ${requirements.maxCodeBlocks}.`);
  }

  return parts.join("\n");
}

function buildDepthInstructions(
  depthTier: "thorough" | "exhaustive",
  requirements?: SynthesisRequirements,
): string {
  const reqStr = requirements ? [
    requirements.sectionPlanText ? `Compact section plan:\n${requirements.sectionPlanText}` : "",
    requirements.minSections ? `Required sections: ${requirements.minSections.join(", ")}.` : "",
    requirements.minVerifiedSources ? `Must cite at least ${requirements.minVerifiedSources} verified sources.` : "",
    requirements.minConcreteDetails ? `Must include at least ${requirements.minConcreteDetails} concrete file/module/mechanism references.` : "",
    requirements.requireCommands ? "Must include exact setup/verification commands." : "",
    requirements.requireRisks ? "Must include a risks section." : "",
    requirements.requireTests ? "Must include tests/validation steps." : "",
    requirements.requireValidationChecklist ? "Must include a validation checklist." : "",
  ].filter(Boolean).join("\n") : "";

  // Do not inject source-category table as a blanket requirement.
  // Inline citations are sufficient per SYSTEM_PROMPT rules 7/25/26.

  if (depthTier === "exhaustive") {
    return [
      "DEPTH TIER: EXHAUSTIVE",
      "Produce a comprehensive answer within the budget:",
      "- Expand each section with concrete evidence details",
      "- Add detailed implementation steps with exact file paths",
      "- Include validation and failure diagnostics",
      "- Add explicit unknowns for every unverified claim area",
      "- Structure with clear headings — but prefer fewer, denser sections",
      reqStr,
      "Target: the answer should be detailed enough for a senior engineer to implement from.",
    ].filter(Boolean).join("\n");
  }

  return [
    "DEPTH TIER: THOROUGH",
    "Produce a compact but thorough answer within the budget:",
    "- Include concrete file paths, source links, and commands",
    "- Include risks and caveats where applicable",
    "- Separate confirmed facts from inferences",
    "- Add explicit unknowns",
    "- Merge overlapping sections; prefer fewer, denser sections",
    reqStr,
    "Target: the answer should give the user actionable, specific information.",
  ].filter(Boolean).join("\n");
}

function computeEvidenceCounts(ledger: EvidenceLedgerEntry[]): SynthesisDiagnostics["evidenceCounts"] {
  const verifiedSources = ledger.filter(
    (e) => e.verified && (e.kind === "web_source" || e.kind === "browser_page" || e.kind === "repo_file" || e.kind === "document"),
  ).length;
  const webSearches = ledger.filter((e) => e.tool === "web_search").length;
  const urlsFetched = ledger.filter(
    (e) => e.kind === "web_source" || e.kind === "browser_page",
  ).length;
  const filesRead = ledger.filter((e) => e.kind === "repo_file").length;
  return {
    verifiedSources,
    totalLedger: ledger.length,
    webSearches,
    urlsFetched,
    filesRead,
  };
}

function deriveMaxTokens(requirements?: SynthesisRequirements, depthTier?: "thorough" | "exhaustive"): number {
  const targetWords = requirements?.targetWords ?? 1100;
  const hardCapWords = requirements?.hardCapWords ?? Math.ceil(targetWords * 1.25);

  if (depthTier === "exhaustive") {
    return Math.max(3000, Math.min(7000, Math.ceil(hardCapWords * 1.6)));
  }

  return Math.max(1800, Math.min(5200, Math.ceil(hardCapWords * 1.6)));
}

function readPositiveEnv(name: string): number | null {
  const raw = process.env[name];
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export async function synthesizeEvidenceRichAnswer(
  input: SynthesisInput,
): Promise<SynthesisResult> {
  const requirements = input.requirements;
  const budgetInstruction = buildBudgetInstruction(requirements);
  const depthInstructions = buildDepthInstructions(input.depthTier, requirements);
  const evidenceCounts = computeEvidenceCounts(input.ledger);
  const timeoutMs = readPositiveEnv("DISP8CH_EVIDENCE_RICH_SYNTHESIS_TIMEOUT_MS") ?? 60_000;

  const baseSystemPrompt = [
    SYSTEM_PROMPT,
    "",
    budgetInstruction,
    "",
    depthInstructions,
  ].join("\n");

  const systemPrompt = injectModelFamilyGuidance(
    baseSystemPrompt,
    input.provider,
    input.modelId,
  );

  const compressedEv = input.evidenceItems && input.evidenceItems.length > 0
    ? compressEvidence(input.evidenceItems, 8000)
    : "";

  const userMessageSafe = String(input.userMessage ?? "").slice(0, 800);
  const currentDraftSafe = String(input.currentDraft ?? "").slice(0, 8000);
  const ledgerSafe = Array.isArray(input.ledger) ? input.ledger : [];

  const budgetSummary = requirements?.targetWords
    ? `Target: ${requirements.targetWords} words. Hard cap: ${requirements.hardCapWords ?? Math.ceil(requirements.targetWords * 1.25)} words.`
    : "";

  const userPrompt = [
    `Original request: ${userMessageSafe}`,
    "",
    budgetSummary,
    "",
    "Verified evidence pack:",
    formatEvidencePackForModel(ledgerSafe, { maxEntries: 12, maxExcerptChars: 500 }),
    "",
    compressedEv ? `Additional compressed evidence:\n${compressedEv}` : "",
    "",
    "Current draft to rewrite into a compact final answer:",
    "```",
    currentDraftSafe,
    "```",
    "",
    "Rewrite the draft into a compact final answer.",
    "Keep the highest-signal facts, commands, citations, and caveats.",
    "Merge duplicate validation, source, risk, unknown, and failure-mode material.",
    "Do not preserve every heading from the draft.",
    "Respect the answer budget unless the user explicitly requested exhaustive detail.",
    "Make this answer decision-ready: a user should be able to act on it without further questions.",
  ].filter(Boolean).join("\n");

  const promptChars = systemPrompt.length + userPrompt.length;

  try {
    const targetWords = requirements?.targetWords ?? 1100;
    const hardCapWords = requirements?.hardCapWords ?? Math.ceil(targetWords * 1.25);
    const maxTokens = deriveMaxTokens(requirements, input.depthTier);
    const temperature = input.provider === "deepseek" ? 0.55 : 0.2;

    const result = await callModel({
      provider: input.provider,
      modelId: input.modelId,
      apiKey: input.apiKey,
      baseUrl: input.baseUrl ?? undefined,
      systemPrompt,
      userMessage: userPrompt,
      maxTokens,
      temperature,
    });

    const answer = result.response || "";

    if (!answer || answer.length < 100) {
      log.warn("synthesis returned empty/short answer", {
        route: input.route,
        answerLength: answer.length,
      });
      return {
        answer: input.currentDraft,
        diagnostics: {
          promptChars,
          answerChars: answer.length,
          tokensUsed: result.tokensUsed,
          route: input.route,
          evidenceCounts,
          contractsRun: [],
          contractFailures: 0,
          synthesisUsed: false,
          rejectedReason: "empty or short synthesis answer",
          budget: { targetWords, hardCapWords, maxTokens },
        },
      };
    }

    return {
      answer,
      diagnostics: {
        promptChars,
        answerChars: answer.length,
        tokensUsed: result.tokensUsed,
        route: input.route,
        evidenceCounts,
        contractsRun: ["compact-synthesis"],
        contractFailures: 0,
        synthesisUsed: true,
        budget: { targetWords, hardCapWords, maxTokens },
      },
    };
  } catch (err) {
    log.warn("synthesis call failed", {
      route: input.route,
      error: String(err),
    });
    const targetWords = requirements?.targetWords ?? 1100;
    const hardCapWords = requirements?.hardCapWords ?? Math.ceil(targetWords * 1.25);
    return {
      answer: input.currentDraft,
      diagnostics: {
        promptChars,
        answerChars: 0,
        tokensUsed: 0,
        route: input.route,
        evidenceCounts,
        contractsRun: [],
        contractFailures: 1,
        synthesisUsed: false,
        rejectedReason: String(err),
        budget: { targetWords, hardCapWords, maxTokens: deriveMaxTokens(requirements, input.depthTier) },
      },
    };
  }
}

// ── Synthesis Skip Gate ──────────────────────────────────────────────────────
//
// Skip the second pass when the draft is already decision-ready enough.
// This follows the evidence-sufficient pattern: once the answer is usable, stop instead
// of forcing a second expansion.  The criteria are STRUCTURAL only — no
// domain keywords, no benchmark-specific logic, no hardcoded case IDs.

export type SkipGateInput = {
  currentDraft: string;
  userMessage: string;
  route: string;
  depthTier: "normal" | "thorough" | "exhaustive";
  verifiedSourceCount: number;
  contractIssues: string[];
};

export type SkipGateResult = {
  skip: boolean;
  reason: string;
  missingDenseSignals?: string[];
};

function requiresDenseSetupSpecificity(userMessage: string): boolean {
  const text = userMessage.toLowerCase();
  const setupIntent = /\b(?:how\s+do\s+i|how\s+can\s+i|how\s+to|set\s*up|install|configure|run|deploy|build|spin\s*up|host|serve|endpoint|api)\b/i.test(text);
  const sizingIntent = /\b(?:fit|fits?|sizing|budget|vram|memory|gpu|ram|context|tokens?|quant|throughput|speed|latency|tradeoffs?|failure\s+risks?)\b/i.test(text);
  const localRuntimeIntent = /\b(?:local|self[-\s]?hosted|windows|gpu|runtime|server|model|llm|openai[-\s]?compatible|api\s+endpoint)\b/i.test(text);
  return (setupIntent && localRuntimeIntent) || (setupIntent && sizingIntent) || (sizingIntent && localRuntimeIntent);
}

function missingDenseSetupSignals(currentDraft: string, userMessage: string): string[] {
  if (!requiresDenseSetupSpecificity(userMessage)) return [];

  const draft = currentDraft.toLowerCase();
  const missing: string[] = [];
  const hasExactIdentifier =
    /`?[a-z0-9][a-z0-9._/-]{2,}:[a-z0-9][a-z0-9._/-]{1,}`?/i.test(currentDraft) ||
    /\b[a-z0-9][a-z0-9._/-]{2,}\s*@\s*(?:q[0-9]|v?\d|[a-z0-9._-]{2,})/i.test(currentDraft) ||
    /\b(?:model|runtime|image|version|tag|quant)\b[\s\S]{0,80}\b(?:q[234568]|int[48]|fp16|gguf|awq|gptq|mlx|onnx|cuda)\b/i.test(currentDraft);
  const hasQuantitativeFit =
    /\n\|.+\|\n\|[ :|-]+\|/i.test(currentDraft) &&
    /\b(?:gb|gib|mb|mib|vram|ram|memory|context|tokens?|t\/s|tokens?\/s|ms|latency|q[234568])\b/i.test(currentDraft);
  const hasExactConfigOrCommands =
    /```[\s\S]{20,}```/.test(currentDraft) ||
    /\b(?:curl|docker\s+run|docker\s+compose|ollama\s+|llama-server|set\s+[A-Z_]+|setx\s+[A-Z_]+|export\s+[A-Z_]+|[A-Z][A-Z0-9_]{5,}=|base_url|\/v1\/chat\/completions|localhost:\d{3,5})\b/i.test(currentDraft);
  const hasRejectedOptions =
    /\b(?:rejected\s+options?|what\s+won['']?t\s+work|why\s+not|avoid|do\s+not\s+choose|not\s+recommended|bad\s+fit)\b/i.test(draft) &&
    /\n\|.+\|\n\|[ :|-]+\|/i.test(currentDraft);
  const hasValidation =
    /\b(?:validate|validation|verify|test|smoke\s+test|health\s+check|failure\s+diagnostics?|diagnose|fallback)\b/i.test(draft) &&
    (hasExactConfigOrCommands || /\b(?:endpoint|port|log|error|timeout|oom|out\s+of\s+memory)\b/i.test(draft));
  const hasRisks =
    /\b(?:risks?|failure\s+modes?|pitfalls?|unknowns?|could\s+not\s+verify|limits?|caveats?)\b/i.test(draft);

  if (!hasExactIdentifier) missing.push("exact primary model/runtime/config identifier");
  if (!hasQuantitativeFit) missing.push("quantitative fit table with units");
  if (!hasExactConfigOrCommands) missing.push("exact commands or config values");
  if (!hasRejectedOptions) missing.push("rejected-options rationale");
  if (!hasValidation) missing.push("validation or failure diagnostics");
  if (!hasRisks) missing.push("risks and unknowns");

  return missing;
}

export function shouldSkipSynthesis(input: SkipGateInput): SkipGateResult {
  const draftWords = input.currentDraft.split(/\s+/).filter(Boolean).length;
  const draftLower = input.currentDraft.toLowerCase();

  const hasRecommendation =
    /\b(?:primary\s+recommendation|recommended\s+(?:setup|approach|path|config|model|way))\b/i.test(input.currentDraft) ||
    /##\s*recommendation/i.test(input.currentDraft);

  const hasConcreteCommand = /```[\s\S]{20,}```/.test(input.currentDraft);
  const hasTable = /\n\|.+\|\n\|[ :|-]+\|/i.test(input.currentDraft);
  const hasInlineCitation = /\bhttps?:\/\/[^\s)]{10,}/.test(input.currentDraft);
  const hasRisksOrUnknowns =
    /\b(?:risks?|failure\s+modes?|unknowns?|could\s+not\s+verify|what\s+(?:i\s+)?could\s+(?:not|n't)\s+verify)\b/i.test(input.currentDraft);

  const asksRisks = /\b(?:risks?|fail(?:ure)?|won['']?t\s+work|pitfalls?|gotchas?|broken)\b/i.test(input.userMessage);
  const asksSetup = /\b(?:how\s+do\s+i|how\s+can\s+i|how\s+to|set\s*up|install|configure|run|deploy)\b/i.test(input.userMessage);
  const asksTable = /\b(?:compare|comparison|vs\.?\s+|matrix|tradeoffs?|budget|sizing)\b/i.test(input.userMessage);
  const asksExhaustive = /\b(?:exhaustive|comprehensive|every\s+detail|full\s+breakdown)\b/i.test(input.userMessage);
  const asksImplementationPlan = /\b(?:implementation\s+plan|fix\s+plan|files?\s+to\s+touch|propose\s+(?:one|an?)?\s*improvement)\b/i.test(input.userMessage);

  const hasVerifiedSources = input.verifiedSourceCount >= 2;
  const contractClean = input.contractIssues.length === 0;
  const denseMissing = missingDenseSetupSignals(input.currentDraft, input.userMessage);

  // Exhaustive request — never skip, user explicitly wants thoroughness.
  if (asksExhaustive || input.depthTier === "exhaustive") {
    return { skip: false, reason: "exhaustive depth requested" };
  }

  // Implementation plan — always enrich.
  if (asksImplementationPlan) {
    return { skip: false, reason: "implementation plan benefits from enrichment" };
  }

  // Draft is too thin — always synthesize.
  if (draftWords < 400) {
    return { skip: false, reason: "draft too thin (<400 words)" };
  }

  if (denseMissing.length >= 2) {
    return {
      skip: false,
      reason: `draft lacks dense setup specificity: ${denseMissing.slice(0, 4).join(", ")}`,
      missingDenseSignals: denseMissing,
    };
  }

  // Draft is already substantial and well-formed — skip.
  if (draftWords >= 800 && hasRecommendation && (hasTable || hasInlineCitation) && contractClean) {
    const checkpoints: string[] = ["draft ≥800 words", "has recommendation"];
    if (hasTable) checkpoints.push("has table");
    if (hasInlineCitation) checkpoints.push("has inline citation");
    if (contractClean) checkpoints.push("contract clean");
    return { skip: true, reason: `draft already decision-ready: ${checkpoints.join(", ")}` };
  }

  // Draft is moderately sized with recommendation + commands + sources — skip.
  if (draftWords >= 600 && hasRecommendation && hasConcreteCommand && hasVerifiedSources && contractClean) {
    return { skip: true, reason: "draft decision-ready: recommendation + commands + verified sources" };
  }

  // Setup prompts with recommendation + table/commands + sources — skip.
  if (asksSetup && draftWords >= 500 && hasRecommendation && (hasTable || hasConcreteCommand) && hasVerifiedSources && contractClean) {
    return { skip: true, reason: "setup draft decision-ready: rec + evidence + commands/table" };
  }

  // Comparison prompts with table + sources — skip.
  if (asksTable && draftWords >= 500 && hasTable && hasVerifiedSources && contractClean) {
    return { skip: true, reason: "comparison draft has table + sources" };
  }

  // Risks requested and covered — skip if other signals are good.
  if (asksRisks && hasRisksOrUnknowns && draftWords >= 500 && hasVerifiedSources && contractClean) {
    return { skip: true, reason: "risks covered, draft sufficient" };
  }

  // Default: enrich.
  return { skip: false, reason: "draft could benefit from enrichment" };
}

// ── Requirement Building: compact intent-based, no forced exhaustive schema ──

export function shouldSynthesizeEvidenceRich(params: {
  route: string;
  userMessage: string;
  depthTier: "normal" | "thorough" | "exhaustive";
  verifiedSourceCount: number;
  currentDraftWordCount: number;
}): boolean {
  const thin = params.currentDraftWordCount < 500;
  const hasEvidence = params.verifiedSourceCount >= 2;
  const deepRoute = /\b(?:broad-synthesis|web_research|repo.inspection|deep-audit)\b/i.test(params.route);

  const needsDecisionReadyAnswer = /\b(?:how\s+do\s+i|how\s+can\s+i|how\s+should\s+i|best\s+(?:way|practice|approach)|recommend|what\s+(?:are|is)\s+the\s+best|set\s*up|install|configure|run|deploy|build|implementation\s+plan|fix\s+plan|tradeoffs?|compare|vs\.?\s+|matrix|does\s+\w+\s+support|is\s+\w+\s+compatible|research\s+whether|confirmed\s+facts?|currently\s+supports?|tested\s+setup)\b/i.test(params.userMessage);

  const depthRequested = params.depthTier === "thorough" || params.depthTier === "exhaustive";

  return deepRoute && hasEvidence && (depthRequested || thin || needsDecisionReadyAnswer);
}

function resolveBudgetByIntent(userMessage: string, depthTier: "thorough" | "exhaustive"): {
  targetWords: number;
  hardCapWords: number;
  maxSections: number;
  maxTables: number;
  maxCodeBlocks: number;
} {
  const msg = userMessage.toLowerCase();
  const asksImplementation = /\b(?:implementation\s+plan|fix\s+plan|gap|parity|files?\s+to\s+touch|propose\s+(?:one|an?)?\s*improvement)\b/i.test(msg);
  const asksSetup = /\b(?:how\s+do\s+i|how\s+can\s+i|how\s+to|set\s*up|install|configure|run|deploy|build|spin\s*up)\b/i.test(msg);
  const asksSetupAndRisks = asksSetup && /\b(?:risks?|fail(?:ure)?|won['']?t\s+work|pitfalls?|validation)\b/i.test(msg);
  const asksExplicitExhaustive = /\b(?:exhaustive|comprehensive|every\s+detail|full\s+breakdown|detailed\s+(?:audit|analysis|report))\b/i.test(msg);

  if (depthTier === "exhaustive" || asksExplicitExhaustive) {
    return { targetWords: 2200, hardCapWords: 2700, maxSections: 8, maxTables: 3, maxCodeBlocks: 4 };
  }
  if (asksImplementation) {
    return { targetWords: 1600, hardCapWords: 2000, maxSections: 7, maxTables: 2, maxCodeBlocks: 3 };
  }
  if (asksSetupAndRisks) {
    return { targetWords: 1500, hardCapWords: 1900, maxSections: 6, maxTables: 3, maxCodeBlocks: 3 };
  }
  if (asksSetup) {
    return { targetWords: 1100, hardCapWords: 1400, maxSections: 5, maxTables: 2, maxCodeBlocks: 3 };
  }
  return { targetWords: 1100, hardCapWords: 1400, maxSections: 5, maxTables: 2, maxCodeBlocks: 2 };
}

function buildCompactSectionPlan(userMessage: string): string {
  const msg = userMessage.toLowerCase();
  const asksRecommendation = /\b(?:best\s+(?:way|practice|approach|setup)|recommend|which\s+(?:should|do)\s+i|what(?:'s|\s+is)\s+the\s+best|primary\s+choice|tested\s+setup)\b/i.test(userMessage);
  const asksSetup = /\b(?:how\s+do\s+i|how\s+can\s+i|how\s+to|set\s*up|install|configure|run|deploy|build|spin\s*up)\b/i.test(userMessage);
  const asksComparison = /\b(?:compare|comparison|vs\.?\s+|matrix|tradeoffs?|alternatives?|options?|which\s+(?:one|is\s+better))\b/i.test(userMessage);
  const asksSizing = /\b(?:fit|fits?|sizing|budget|vram|memory|gpu|ram|context|tokens?|quant|latency|throughput|speed)\b/i.test(userMessage);
  const asksFailureModes = /\b(?:risks?|fail(?:ure)?|won['']?t\s+work|pitfalls?|gotchas?|broken)\b/i.test(userMessage);
  const asksCurrentSource = /\b(?:research\s+whether|currently\s+supports?|confirmed\s+facts?|likely\s+inferences?|conflict(?:ing)?\s+sources?)\b/i.test(userMessage);
  const asksImplementation = /\b(?:implementation\s+plan|fix\s+plan|gap|parity|improve\s+the\s+app|files?\s+to\s+touch)\b/i.test(userMessage);
  const asksValidation = /\b(?:tests?|validation|verify|verification|acceptance\s+criteria|regression)\b/i.test(userMessage);

  // Implementation audit plan
  if (asksImplementation) {
    return [
      "Compact section plan:",
      "1. Direct diagnosis",
      "2. Mechanisms worth adopting",
      "3. Modules to change",
      "4. Prioritized implementation plan",
      "5. Tests and acceptance criteria",
      "6. Remaining risks",
    ].join("\n");
  }

  // Current-source synthesis
  if (asksCurrentSource) {
    return [
      "Compact section plan:",
      "1. Direct answer",
      "2. Confirmed facts",
      "3. Likely inferences",
      "4. What could not be verified",
    ].join("\n");
  }

  // Setup + recommendation
  if (asksRecommendation || asksSetup) {
    const plan = ["Compact section plan:"];
    plan.push("1. Primary recommendation with exact chosen model/runtime/config");
    if (/\b(?:official|community|source\s+categor|source\s+type|separate\s+official|separate\s+confirmed)\b/i.test(userMessage)) {
      plan.push(`${plan.length + 1}. Source categories checked`);
    }
    if (asksComparison || asksSizing) plan.push(`${plan.length + 1}. Fit / budget / comparison table`);
    if (asksSetup) plan.push(`${plan.length + 1}. Setup commands and config values`);
    if (asksFailureModes || asksComparison || asksSizing) plan.push(`${plan.length + 1}. Rejected options / what will not work`);
    if (asksFailureModes) plan.push(`${plan.length + 1}. Risks and failure diagnostics`);
    if (asksValidation) plan.push(`${plan.length + 1}. Validation`);
    plan.push(`${plan.length + 1}. Unknowns / source gaps`);
    return plan.join("\n");
  }

  // Default compact plan
  return [
    "Compact section plan:",
    "1. Direct answer / recommendation",
    "2. Supporting evidence",
    "3. Risks and caveats",
    "4. Unknowns (if any)",
  ].join("\n");
}

export function buildSynthesisRequirements(userMessage: string, route: string): SynthesisRequirements {
  const msg = userMessage.toLowerCase();

  const asksRecommendation = /\b(?:best\s+(?:way|practice|approach|setup)|recommend|which\s+(?:should|do)\s+i|what(?:'s|\s+is)\s+the\s+best|primary\s+choice|tested\s+setup)\b/i.test(userMessage);
  const asksSetupOrCommands = /\b(?:how\s+do\s+i|how\s+can\s+i|how\s+to|set\s*up|install|configure|run|deploy|build|spin\s*up)\b/i.test(userMessage);
  const asksComparison = /\b(?:compare|comparison|vs\.?\s+|matrix|tradeoffs?|alternatives?|options?|which\s+(?:one|is\s+better))\b/i.test(userMessage);
  const asksSizing = /\b(?:fit|fits?|sizing|budget|vram|memory|gpu|ram|context|tokens?|quant|latency|throughput|speed)\b/i.test(userMessage);
  const asksFailureModes = /\b(?:risks?|fail(?:ure)?|won['']?t\s+work|pitfalls?|gotchas?|broken|errors?)\b/i.test(userMessage);
  const asksCurrentSourceSynthesis = /\b(?:research\s+whether|currently\s+supports?|confirmed\s+facts?|likely\s+inferences?|unknowns?|conflict(?:ing)?\s+sources?|separate\s+(?:confirmed|verified|fact))\b/i.test(userMessage);
  const asksImplementationPlan = /\b(?:implementation\s+plan|fix\s+plan|gap|parity|improve\s+the\s+app|files?\s+to\s+touch|propose\s+(?:one|an?)?\s*improvement)\b/i.test(userMessage);
  const asksTests = /\b(?:tests?|validation|verify|verification|acceptance\s+criteria|regression)\b/i.test(userMessage);
  const asksDimensionalGaps = /\b(?:exactly\s+what['']?s\s+missing|missing\s+(?:from|in)\s+evidence|what\s+(?:i\s+)?could(?:\s+not|n[''']t)\s+verify|unknowns?)\b/i.test(userMessage);

  const sectionPlanText = buildCompactSectionPlan(userMessage);

  const minSections: string[] = [];
  if (asksRecommendation || asksSetupOrCommands) minSections.push("Primary Recommendation");
  if (asksComparison || asksSizing) minSections.push("Comparison or Fit Table");
  if (asksSetupOrCommands) minSections.push("Setup Steps");
  if (asksFailureModes) minSections.push("Risks and Unknowns");
  if (asksCurrentSourceSynthesis) {
    minSections.push("Confirmed Facts", "Likely Inferences");
  }
  if (asksImplementationPlan) {
    minSections.push("Prioritized Plan", "Files to Touch");
  }
  if (asksTests) minSections.push("Validation");
  if (asksDimensionalGaps || asksCurrentSourceSynthesis) minSections.push("Unknowns");

  // Derive budget from intent, not hardcoded depth tier.
  // Use "thorough" as default; route.ts will pass "exhaustive" for explicit exhaustive requests.
  const budget = resolveBudgetByIntent(userMessage, "thorough");

  return {
    sectionPlanText,
    minSections,
    minVerifiedSources: 1,
    minConcreteDetails: asksRecommendation || asksImplementationPlan ? 4 : 2,
    requireCommands: asksSetupOrCommands,
    requireRisks: asksFailureModes,
    requireTests: asksTests || asksImplementationPlan,
    requireValidationChecklist: asksSetupOrCommands,
    targetWords: budget.targetWords,
    hardCapWords: budget.hardCapWords,
    maxSections: budget.maxSections,
    maxTables: budget.maxTables,
    maxCodeBlocks: budget.maxCodeBlocks,
  };
}
