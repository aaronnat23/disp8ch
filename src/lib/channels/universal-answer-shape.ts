import type { UniversalInvestigationPlan } from "@/lib/channels/universal-agentic-planner";
import type { UniversalEvidenceDossier } from "@/lib/channels/universal-evidence-dossier";

export type UniversalAnswerShape = {
  intent:
    | "direct_answer"
    | "research_synthesis"
    | "repo_audit"
    | "capability_status"
    | "workflow_design"
    | "code_change"
    | "goal_update";
  depth: "brief" | "standard" | "rich";
  preferredSections: string[];
  maxTargetChars: number;
  mustPreserve: string[];
  avoid: string[];
  /** Hard user-stated format constraint (e.g. "exactly 2 sentences", "3 bullets"). */
  explicitFormat: string | null;
};

function asksForBrief(text: string): boolean {
  return /\b(?:short|brief|concise|tl;dr|one paragraph|just the answer)\b/i.test(text);
}

function asksForRich(text: string): boolean {
  return /\b(?:detailed|thorough|deep|rich|complete|comprehensive|full|compare|audit|implementation plan|step by step|release recommendation|release readiness|criteria|criterion|evidence table|residual risks?)\b/i.test(text);
}

// "two-sentence note", "exactly 3 bullets", "5 lines", "under 50 words" —
// when the user states a count/format, it is a hard contract for the final answer.
const WORD_NUMBERS = "one|two|three|four|five|six|seven|eight|nine|ten";
export function extractExplicitFormatConstraint(message: string): string | null {
  const text = String(message || "");
  const strong = text.match(
    new RegExp(
      String.raw`\b(?:exactly|keep(?:\s+it)?(?:\s+to)?|use|include|give|return|provide|write|make)\s+(?:exactly\s+)?(\d{1,2}|${WORD_NUMBERS})[-\s]+(?:short\s+|brief\s+|concise\s+|technical\s+|simple\s+|key\s+|main\s+)?(sentences?|bullets?|bullet\s+points?|lines?|paragraphs?|items?)\b`,
      "i",
    ),
  );
  const general = text.match(
    new RegExp(
      String.raw`\b(?:exactly\s+)?(\d{1,2}|${WORD_NUMBERS})[-\s]+(?:short\s+|brief\s+|concise\s+|technical\s+|simple\s+|key\s+|main\s+)?(sentences?|bullets?|bullet\s+points?|lines?|paragraphs?|items?)\b`,
      "i",
    ),
  );
  const limit = text.match(/\b(?:under|at\s+most|no\s+more\s+than|max(?:imum)?\s+of?)\s+(\d{1,3})\s+(words?|sentences?|bullets?|lines?|characters?)\b/i);
  const match = strong || general || limit;
  if (!match) return null;
  const base = `${match[1]} ${match[2]}`.toLowerCase();
  const eachBulletWords = text.match(/\beach\s+bullet[\s\S]{0,30}?\b(under|at\s+most|no\s+more\s+than)\s+(\d{1,3})\s+words?\b/i);
  return eachBulletWords && /bullet|item/.test(base)
    ? `${base}, each ${eachBulletWords[1].toLowerCase()} ${eachBulletWords[2]} words`
    : base;
}

export function inferUniversalAnswerShape(input: {
  message: string;
  plan?: UniversalInvestigationPlan | null;
  dossier?: UniversalEvidenceDossier | null;
  taskHints?: Record<string, unknown>;
}): UniversalAnswerShape {
  const text = `${input.message}\n${input.plan?.taskSummary ?? ""}\n${input.plan?.finalAnswerCriteria.join("\n") ?? ""}`;
  const lower = text.toLowerCase();
  const hasRepo = input.plan?.dimensions.some((dimension) => dimension.evidenceNeeded.includes("repo")) ||
    /\b(?:repo|codebase|source file|implementation|security audit|architecture|file:line)\b/i.test(lower);
  const hasWeb = input.plan?.dimensions.some((dimension) => dimension.evidenceNeeded.includes("web")) ||
    /\b(?:research|current|latest|source|sources|citation|official docs|compare|recommend)\b/i.test(lower);
  const hasWorkflow = /\b(?:workflow|automation|node|trigger|webhook|cron|schedule)\b/i.test(lower);
  const hasCapability = /\b(?:implemented|configured|callable|available now|capability|feature status|missing provider|fallback)\b/i.test(lower);
  const hasCodeChange = /\b(?:edit|change code|modify|patch|implement|fix bug|refactor)\b/i.test(lower);
  const hasGoal = Boolean(input.taskHints?.standingGoal) || /\b(?:goal|subgoal|long-horizon|daemon|board task)\b/i.test(lower);

  let intent: UniversalAnswerShape["intent"] = "direct_answer";
  if (hasCodeChange) intent = "code_change";
  else if (hasCapability) intent = "capability_status";
  else if (hasRepo) intent = "repo_audit";
  else if (hasWorkflow) intent = "workflow_design";
  else if (hasWeb) intent = "research_synthesis";
  else if (hasGoal) intent = "goal_update";

  const evidenceCount = input.dossier
    ? input.dossier.sourceMap.length + input.dossier.coverage.web + input.dossier.coverage.repo + input.dossier.coverage.app_state
    : 0;
  const depth: UniversalAnswerShape["depth"] = asksForBrief(text)
    ? "brief"
    : asksForRich(text) || evidenceCount >= 10 || intent === "repo_audit"
      ? "rich"
      : "standard";

  const sectionMap: Record<UniversalAnswerShape["intent"], string[]> = {
    direct_answer: ["Answer", "Why", "Next Steps"],
    research_synthesis: ["Recommendation", "Evidence", "Tradeoffs", "Verification Gaps"],
    repo_audit: ["Finding", "Evidence", "Risk", "Fix", "Verification"],
    capability_status: ["Capability", "Implemented", "Configured/Callable", "Fallback/Missing", "Evidence"],
    workflow_design: ["Trigger", "Nodes", "Data Flow", "Risks", "Tests"],
    code_change: ["Changes", "Files", "Verification", "Risks"],
    goal_update: ["Progress", "Judgment", "Next Task", "Blockers"],
  };

  const maxTargetChars = depth === "brief" ? 1800 : depth === "rich" ? 9000 : 5200;
  return {
    intent,
    depth,
    preferredSections: sectionMap[intent],
    maxTargetChars,
    mustPreserve: [
      "directly answer the user request",
      "cite concrete file paths or source URLs when evidence exists",
      "state unknowns and blockers plainly",
      "separate evidence-backed facts from inference",
    ],
    avoid: [
      "generic templates",
      "benchmark IDs or prior comparison artifacts",
      "overstating configuration/callability",
      "source links that do not support nearby claims",
    ],
    explicitFormat: extractExplicitFormatConstraint(input.message),
  };
}

export function formatAnswerShapeForPrompt(shape: UniversalAnswerShape): string {
  return [
    `Answer intent: ${shape.intent}`,
    `Target depth: ${shape.depth}`,
    `Target length: up to about ${shape.maxTargetChars} characters unless the user's explicit format requires otherwise.`,
    shape.explicitFormat
      ? `HARD FORMAT CONTRACT: the user asked for ${shape.explicitFormat}. The final answer must contain exactly that — no extra sentences, headers, sections, evidence blocks, recommendations, or preambles. Format/count compliance overrides every depth and section guideline above.`
      : "",
    shape.explicitFormat ? "" : `Useful sections: ${shape.preferredSections.join(", ")}`,
    `Must preserve: ${shape.mustPreserve.join("; ")}`,
    `Avoid: ${shape.avoid.join("; ")}`,
  ].filter(Boolean).join("\n");
}


// ── Deterministic post-format enforcement ──
// Models drift on exact counts even with a hard contract in the prompt. When
// the user asked for N bullets/sentences/lines and the answer exceeds N, trim
// deterministically (keep the first N) instead of trusting a retry.
const WORD_TO_NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

export function enforceExplicitFormat(answer: string, constraint: string | null): { answer: string; trimmed: boolean } {
  if (!constraint) return { answer, trimmed: false };
  const match = constraint.match(/^(\d{1,3}|[a-z]+)\s+(sentences?|bullets?|bullet\s+points?|lines?|items?)/i);
  if (!match) return { answer, trimmed: false };
  const n = WORD_TO_NUM[match[1].toLowerCase()] ?? Number(match[1]);
  if (!Number.isFinite(n) || n < 1) return { answer, trimmed: false };
  const unit = match[2].toLowerCase();

  if (/bullet|item|line/.test(unit)) {
    const lines = answer.split("\n");
    const bulletIdx = lines.map((line, i) => (/^\s*(?:[-*•]|\d+[.)])\s+/.test(line) ? i : -1)).filter((i) => i >= 0);
    const perBullet = constraint.match(/each\s+(under|at\s+most|no\s+more\s+than)\s+(\d{1,3})\s+words/i);
    const maxWords = perBullet ? Math.max(1, Number(perBullet[2]) - (perBullet[1].toLowerCase() === "under" ? 1 : 0)) : null;
    const existingBullets = bulletIdx.map((index) => lines[index]!
      .trim()
      .replace(/^(?:[-*•]|\d+[.)])\s+/, "")
      .trim());
    const proseClauses = answer
      .replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, "")
      .split(/\r?\n+|;\s+|(?<=[.!?])\s+/)
      .map((clause) => clause
        .replace(/^#{1,6}\s*/, "")
        .replace(/^(?:use|answer|proven|likely|unknown|recommendation)\s*:\s*/i, "")
        .trim())
      .filter((clause) => clause.length > 0);
    const candidates = [...existingBullets, ...proseClauses]
      .filter((clause, index, all) => all.findIndex((item) => item.toLowerCase() === clause.toLowerCase()) === index);
    if (candidates.length < n) {
      const words = answer
        .replace(/[#*_`]/g, " ")
        .replace(/^(?:use|answer|proven|likely|unknown|recommendation)\s*:\s*/gim, "")
        .split(/\s+/)
        .filter(Boolean);
      const chunkSize = Math.ceil(words.length / n);
      for (let start = 0; start < words.length && candidates.length < n; start += chunkSize) {
        candidates.push(words.slice(start, start + chunkSize).join(" "));
      }
    }
    if (candidates.length < n) return { answer, trimmed: false };
    const bullets = candidates.slice(0, n).map((candidate) => {
      const words = candidate.split(/\s+/).filter(Boolean);
      return `- ${(maxWords ? words.slice(0, maxWords) : words).join(" ")}`;
    });
    const normalized = bullets.join("\n").trim();
    return { answer: normalized, trimmed: normalized !== answer.trim() };
  }

  if (/sentence/.test(unit)) {
    const flat = answer.replace(/\s+/g, " ").trim();
    const sentences = flat.match(/[^.!?]+[.!?]+(?:\s|$)/g) ?? [];
    if (sentences.length <= n) return { answer, trimmed: false };
    return { answer: sentences.slice(0, n).join("").trim(), trimmed: true };
  }

  return { answer, trimmed: false };
}
