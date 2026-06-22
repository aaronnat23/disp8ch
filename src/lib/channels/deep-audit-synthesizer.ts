import type { ModelProvider } from "@/types/model";
import { callModel } from "@/lib/agents/multi-provider";
import type { DeepAuditProfile } from "@/lib/channels/deep-audit-profile";
import type { DeepAuditOutline } from "@/lib/channels/deep-audit-outline";
import { formatDeepAuditOutlineAsPrompt } from "@/lib/channels/deep-audit-outline";

export type DeepSynthesisResult = {
  answer: string;
  usedModel: boolean;
  diagnostics: {
    promptChars: number;
    answerChars: number;
    tokensUsed: number;
    evidenceCount: number;
    rejectedReason?: string;
  };
};

const DEFAULT_DEEP_SYNTHESIS_TIMEOUT_MS = 45_000;

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

const SYNTHESIS_SYSTEM_PROMPT = [
  "You are disp8ch AI's deep audit synthesizer. Your job is to produce a structured, evidence-grounded answer.",
  "",
  "RULES:",
  "1. Follow the outline sections in order. Each section must be present.",
  "2. Use only VERIFIED evidence (tagged with ✓) for behavior claims.",
  "3. Search/list/candidate evidence (tagged with ⚠) can suggest but cannot prove behavior.",
  "4. Explain WHY each failure gate matters — not just that it exists.",
  "5. Include concrete regression tests when the task requests fixes or tests.",
  "6. If evidence is incomplete, say exactly what is missing — do not guess.",
  "7. Be concise but complete. Do not pad. Do not repeat evidence.",
  "8. Prefer file:line references when evidence includes line numbers.",
  "9. The answer should stand alone as a decision-ready artifact.",
  "10. Do NOT output tool-call syntax, XML, DSML, or raw evidence IDs.",
  "11. Stay on the exact target named by the user. If the user asks about repo-inspection grounding, the answer must center repo-inspection routing, evidence collection, evidence contracts, and final synthesis gates.",
  "12. Do not substitute adjacent systems such as broad web research, source-purpose coverage, or generic answer contracts unless the collected evidence proves they are directly in the requested call chain.",
].join("\n");

function buildFocusGuard(userMessage: string): string {
  const guards: string[] = [];
  if (/\brepo[-\s]?inspection\b|\brepo\b[\s\S]{0,80}\bgrounding\b|\bgrounding\b[\s\S]{0,80}\brepo\b/i.test(userMessage)) {
    guards.push(
      "Focus guard: this request is about repo-inspection grounding. Required named mechanisms include `collectRepoInspectionEvidence`, `evaluateRepoEvidenceContract`, route metadata such as `repo-inspection`, and the deep-audit synthesis/contract path if present in evidence.",
      "Off-target warning: do not frame the main answer around broad web research, source-purpose coverage, or web-research finalizers unless you explicitly label them as adjacent/non-primary.",
    );
  }
  if (/\bshallow|depth|quality|contract|gate\b/i.test(userMessage)) {
    guards.push(
      "Quality guard: distinguish evidence collection gates from final answer synthesis gates. A response can have enough reads but still be shallow if synthesis ignores or misuses the verified evidence.",
    );
  }
  return guards.join("\n");
}

export async function synthesizeDeepAuditAnswer(params: {
  userMessage: string;
  profile: DeepAuditProfile;
  outline: DeepAuditOutline;
  evidencePromptBlock: string;
  provider: ModelProvider;
  modelId: string;
  apiKey: string;
  baseUrl?: string | null;
  maxTokens?: number | null;
  temperature?: number | null;
  timeoutMs?: number | null;
}): Promise<DeepSynthesisResult> {
  const outlinePrompt = formatDeepAuditOutlineAsPrompt(params.outline);

  const systemPrompt = [
    SYNTHESIS_SYSTEM_PROMPT,
    "",
    buildFocusGuard(params.userMessage),
    "",
    outlinePrompt,
  ].join("\n");

  const userMessage = [
    `Original request: ${params.userMessage.slice(0, 300)}`,
    "",
    "Collected evidence:",
    params.evidencePromptBlock.slice(0, 30000),
    "",
    "Produce the synthesis answer following the outline above.",
    "Before writing, verify that the answer's main subject matches the original request, not just a related subsystem mentioned in search results.",
  ].join("\n");

  const promptChars = systemPrompt.length + userMessage.length;

  try {
    const timeoutMs = params.timeoutMs ?? readPositiveEnv("DEEP_AUDIT_SYNTHESIS_TIMEOUT_MS") ?? DEFAULT_DEEP_SYNTHESIS_TIMEOUT_MS;
    const result = await withTimeout(
      callModel({
        provider: params.provider,
        modelId: params.modelId,
        apiKey: params.apiKey,
        baseUrl: params.baseUrl ?? undefined,
        systemPrompt,
        userMessage,
        maxTokens: params.maxTokens ?? 6000,
        temperature: params.temperature ?? 0.3,
      }),
      timeoutMs,
      "Deep audit synthesis",
    );

    return {
      answer: result.response || "",
      usedModel: true,
      diagnostics: {
        promptChars,
        answerChars: (result.response || "").length,
        tokensUsed: result.tokensUsed,
        evidenceCount: params.outline.sections.reduce((s, sec) => s + sec.anchors.length, 0),
      },
    };
  } catch (err) {
    return {
      answer: "",
      usedModel: false,
      diagnostics: { promptChars, answerChars: 0, tokensUsed: 0, evidenceCount: 0, rejectedReason: String(err) },
    };
  }
}

function evidenceCitation(file: string, evidenceText: string): string {
  const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const snippetHeader = new RegExp(`file_read\\s+${escaped}\\s+lines\\s+(\\d+)-(\\d+)`, "i").exec(evidenceText);
  if (snippetHeader) return `${file}:${snippetHeader[1]}-${snippetHeader[2]}`;
  const repoCitation = new RegExp(`${escaped}:(\\d+)(?:[-–](\\d+))?\\b`).exec(evidenceText);
  if (repoCitation) return `${file}:${repoCitation[1]}${repoCitation[2] ? `-${repoCitation[2]}` : ""}`;
  return file;
}

export function buildFallbackDeepAuditAnswer(
  _profile: DeepAuditProfile,
  outline: DeepAuditOutline,
  evidenceText: string,
  userMessage = "",
): string {
  const verifiedFiles = Array.from(new Set(
    outline.sections
      .flatMap((section) => section.anchors)
      .filter((anchor) => anchor.verified && anchor.kind === "file_path")
      .map((anchor) => anchor.value),
  )).slice(0, 10);
  const candidateSignals = Array.from(new Set(
    outline.sections
      .flatMap((section) => section.anchors)
      .filter((anchor) => !anchor.verified)
      .map((anchor) => anchor.value),
    )).slice(0, 5);
  const cite = (file: string) => evidenceCitation(file, evidenceText);
  const lines = [
    "## Audit Recovery",
    "Model-led synthesis was unavailable or rejected. This recovery response reports collected evidence only; it does not invent a case-specific diagnosis, fix, or test plan.",
    "",
    `Request: ${String(userMessage || "").trim().slice(0, 500) || "(not provided)"}`,
    outline.evidenceSummary,
    "",
    "## Verified Evidence",
    ...(verifiedFiles.length
      ? verifiedFiles.map((file) => `- \`${cite(file)}\`: verified file read.`)
      : ["- No verified file reads were available."]),
    ...(candidateSignals.length
      ? ["", "Candidate signals (not proof):", ...candidateSignals.map((signal) => `- \`${signal}\``)]
      : []),
  ];

  for (const section of outline.sections) {
    const sectionFiles = Array.from(new Set(
      section.anchors
        .filter((anchor) => anchor.verified && anchor.kind === "file_path")
        .map((anchor) => anchor.value),
    ));
    lines.push(
      "",
      `## ${section.label}`,
      section.instruction,
      ...(sectionFiles.length
        ? ["Verified inputs for a later synthesis:", ...sectionFiles.slice(0, 8).map((file) => `- \`${cite(file)}\``)]
        : ["No section-specific verified input was collected."]),
      "No conclusion is asserted here because deterministic recovery cannot safely infer behavior, causality, or implementation changes from file names alone.",
    );
  }

  if (outline.missingAnchors.length > 0) {
    lines.push("", "## Missing Evidence", ...outline.missingAnchors.map((item) => `- ${item}`));
  }

  lines.push(
    "",
    "## Next Safe Step",
    "- Retry model-led synthesis using the verified evidence above, or perform targeted reads for the missing evidence.",
    "- Keep search/list hits as candidates until their files or source pages are read.",
    "- Do not treat this recovery response as proof that a feature exists, is configured, or needs a specific fix.",
  );

  return lines.join("\n");
}
