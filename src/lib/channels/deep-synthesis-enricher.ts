import type { ModelProvider } from "@/types/model";
import { callModel } from "@/lib/agents/multi-provider";

export type DepthTier = "normal" | "thorough" | "exhaustive";

export type DeepEnrichmentInput = {
  userMessage: string;
  safeAnswer: string;
  evidencePromptBlock: string;
  routeSource: string;
  depthTier: DepthTier;
  requiredSections: string[];
  provider: ModelProvider;
  modelId: string;
  apiKey: string;
  baseUrl?: string | null;
};

export type DeepEnrichmentResult = {
  answer: string;
  usedModel: boolean;
  diagnostics: {
    promptChars: number;
    answerChars: number;
    tokensUsed: number;
    rejectedReason?: string;
  };
};

// Explicit-depth answers can legitimately take minutes on real providers
// (thousands of output tokens). A short timeout makes the route burn the wait
// and then fall back to the shallow draft — worst of both. Tier-aware budgets:
const DEFAULT_DEEP_ENRICHMENT_TIMEOUT_MS = 45_000;
const DEPTH_TIER_TIMEOUT_MS: Record<string, number> = {
  thorough: 120_000,
  exhaustive: 180_000,
};

function readPositiveEnv(name: string): number | null {
  const raw = process.env[name];
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

const ENRICHMENT_SYSTEM_PROMPT = [
  "You are disp8ch AI's depth enricher. Your task is to expand a safe grounded draft answer into a more thorough, detailed response.",
  "",
  "RULES:",
  "1. BUILD UPON the safe draft. Keep all verified facts, citations, and evidence from the draft.",
  "2. ADD detail, structure, and explanation where the draft is thin. Include concrete findings, call chains, and data flow descriptions.",
  "3. Use ONLY verified evidence for file/source behavior claims. Never invent unsupported facts.",
  "4. Search/list/candidate evidence can only be labeled as candidate — never as verified behavior.",
  "5. Preserve all safety and read-only boundaries. Do not propose mutations or edits for read-only prompts.",
  "6. Prefer exact file:line references when the draft includes them. Add more specific line refs when available.",
  "7. Include unknowns and limitations explicitly instead of guessing.",
  "8. Do not output raw tool syntax, XML, DSML, or internal evidence IDs.",
  "9. Keep the user's requested shape and exact counts where applicable — do not change numbered deliverables.",
  "10. Maintain the draft's structural organization but add subsections and detail within each section.",
  "11. The final answer must stand alone as a decision-ready, complete artifact.",
  "12. Do not pad or add filler. Every expansion should add concrete value from the evidence.",
   ].join("\n");

function buildDepthInstructions(tier: DepthTier, requiredSections: string[]): string {
  const sectionsText = requiredSections.length > 0
    ? `Required output sections: ${requiredSections.join(", ")}. Ensure each section is substantial with concrete content.`
    : "";

  switch (tier) {
    case "exhaustive":
      return [
        "DEPTH TIER: EXHAUSTIVE",
        "This prompt warrants maximum depth. Expand the draft significantly:",
        "- Add detailed call chain / data flow tracing with specific file:line references",
        "- Include a comprehensive evidence table mapping claims to files",
        "- Add concrete risks, failure modes, and mitigation strategies",
        "- Include a detailed implementation plan with files to touch and rationale",
        "- Add concrete regression test cases",
        "- Include remaining unknowns and confidence levels",
        "- Add executive summary and conclusion sections if not present",
        sectionsText,
        "Target: the answer should be detailed enough for a senior engineer to make implementation decisions without further questions.",
      ].filter(Boolean).join("\n");
    case "thorough":
      return [
        "DEPTH TIER: THOROUGH",
        "Expand the draft with additional detail where it adds value:",
        "- Flesh out call chains and data flows",
        "- Add concrete examples and file references where the draft is abstract",
        "- Include risks and limitations where relevant",
        "- Expand thin sections with evidence-backed detail",
        sectionsText,
        "Target: a thorough answer that covers the main investigation paths and practical considerations.",
      ].join("\n");
    default:
      return [
        "DEPTH TIER: NORMAL",
        "Keep the draft at its current level of detail. Only fill in missing required sections or fix inconsistencies.",
        "Do not significantly expand the answer length.",
        sectionsText,
      ].filter(Boolean).join("\n");
  }
}

export function shouldEnrich(depthTier: DepthTier): boolean {
  return depthTier === "thorough" || depthTier === "exhaustive";
}

export function classifyDepthTier(message: string, profileKind: string | null): DepthTier {
  const lowered = message.toLowerCase();

  const exhaustiveSignals = [
    /\b(?:deep|exhaustive|comprehensive|full)\s+(?:audit|inspection|analysis|review|investigation)\b/i,
    /\b(?:root\s+cause|call\s+chain|data\s+flow|architecture\s+trace)\b.*\b(?:complete|detailed|thorough|exhaustive)\b/i,
    /\b(?:compare|versus|vs\.?|benchmark|parity)\b.*\b(?:reference\s+(?:app|agent)|both\s+(?:apps?|agents?|systems?))\b.*\b(?:detailed|full|complete|exhaustive)\b/i,
    /\b(?:files?\s+to\s+touch|risks?|tests?|acceptance\s+criteria)\b.*\b(?:implementation\s+plan|fix\s+plan|upgrade\s+plan)\b/i,
    /\b(?:exhaustive|comprehensive)\s+(?:list|table|breakdown|summary)\b/i,
    /\b(?:reveal|expose|uncover)\s+(?:every|all)\s+(?:detail|call|path|file|function|component)\b/i,
  ];

  if (exhaustiveSignals.some((p) => p.test(message))) {
    return "exhaustive";
  }

  const thoroughSignals = [
    /\b(?:audit|inspect|review|analy[sz]e|examine|investigate)\b[\s\S]{0,120}\b(?:codebase|repo|workspace|code|files?|implementation)\b/i,
    /\b(?:implementation\s+plan|fix\s+plan|upgrade\s+plan|improvement\s+plan)\b/i,
    /\b(?:architecture|pipeline|call\s+chain|data\s+flow|trace)\b/i,
    /\b(?:design|propose|suggest)\b.*\b(?:workflow|node|trigger|automation)\b/i,
    /\b(?:compare|versus|vs\.?)\b.*\b(?:reference\s+(?:app|agent)|difference|gap)\b/i,
    /\b(?:quality\s+gap|remaining\s+gap|shallow|regression)\b/i,
    /\b(?:research|synthesi[sz]e)\b.*\b(?:public\s+discussion|community|latest|current)\b/i,
    /\b(?:many\s+tool|tool[\s-]heavy|cross[\s-]source)\b/i,
    /\b(?:capability|runtime)\s+(?:audit|assessment|review)\b/i,
  ];

  if (thoroughSignals.some((p) => p.test(message))) {
    return "thorough";
  }

  if (profileKind && profileKind !== "regression_design") {
    return "thorough";
  }

  return "normal";
}

export async function enrichDeepSynthesisAnswer(params: DeepEnrichmentInput): Promise<DeepEnrichmentResult> {
  const depthInstructions = buildDepthInstructions(params.depthTier, params.requiredSections);

  const systemPrompt = [
    ENRICHMENT_SYSTEM_PROMPT,
    "",
    depthInstructions,
  ].join("\n");

  const userMessage = [
    `Original user request: ${params.userMessage.slice(0, 500)}`,
    "",
    "Safe grounded draft answer to enrich:",
    "```",
    params.safeAnswer.slice(0, 24000),
    "```",
    "",
    params.evidencePromptBlock ? `Evidence available for reference:\n${params.evidencePromptBlock.slice(0, 20000)}` : "",
    "",
    "Produce the enriched answer. Preserve all citations, facts, and structure from the draft. Add depth within each section.",
    "Do not remove or contradict any verified claims. Label new unsupported claims as candidate/uncertain.",
  ].filter(Boolean).join("\n");

  const promptChars = systemPrompt.length + userMessage.length;

  try {
    const maxTokens = params.depthTier === "exhaustive" ? 8000 : params.depthTier === "thorough" ? 6000 : 4000;
    const timeoutMs =
      readPositiveEnv("DEEP_AUDIT_ENRICHMENT_TIMEOUT_MS") ??
      DEPTH_TIER_TIMEOUT_MS[params.depthTier] ??
      DEFAULT_DEEP_ENRICHMENT_TIMEOUT_MS;
    const result = await withTimeout(
      callModel({
        provider: params.provider,
        modelId: params.modelId,
        apiKey: params.apiKey,
        baseUrl: params.baseUrl ?? undefined,
        systemPrompt,
        userMessage,
        maxTokens,
        temperature: 0.2,
      }),
      timeoutMs,
      "Deep audit enrichment",
    );

    return {
      answer: result.response || "",
      usedModel: true,
      diagnostics: {
        promptChars,
        answerChars: (result.response || "").length,
        tokensUsed: result.tokensUsed,
      },
    };
  } catch (err) {
    return {
      answer: "",
      usedModel: false,
      diagnostics: {
        promptChars,
        answerChars: 0,
        tokensUsed: 0,
        rejectedReason: String(err),
      },
    };
  }
}
