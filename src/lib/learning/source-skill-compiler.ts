/**
 * Source-to-skill compiler. Turns an audited source pack into a REVIEW-FIRST
 * skill candidate:
 *   1. build a bounded prompt from the pack,
 *   2. ask the model to synthesize a skill (JSON),
 *   3. run deterministic verification (grounding, secrets, safe names),
 *   4. store a pending self-improvement proposal with full provenance.
 *
 * Nothing is installed here. Install is an explicit, separate, user-approved
 * action (applySelfImprovementProposal), so a learned skill is never silently
 * enabled.
 */
import { nanoid } from "nanoid";
import { callModel } from "@/lib/agents/multi-provider";
import { listSourcePackChunks, getSourcePack, setSourcePackStatus } from "@/lib/source-packs/store";
import { buildProvenanceSummary } from "@/lib/source-packs/provenance";
import {
  writeSelfImprovementProposal,
  type SelfImprovementProposal,
} from "@/lib/channels/self-improvement-proposals";
import { buildSourceSkillUserMessage, SOURCE_SKILL_SYSTEM_PROMPT } from "./source-skill-prompt";
import { verifyCompiledSkill, type CompiledSkill, type SourceSkillVerifyResult } from "./source-skill-verify";

export type CompileSourceSkillResult = {
  proposal: SelfImprovementProposal | null;
  compiled: CompiledSkill;
  verification: SourceSkillVerifyResult;
  compileRunId: string;
};

function combinedSourceText(sourcePackId: string): string {
  return listSourcePackChunks(sourcePackId, 400)
    .map((c) => c.content)
    .join("\n");
}

function stripJsonFence(raw: string): string {
  let trimmed = raw.trim();
  // Strip only the OUTER code fence. The skill_markdown field legitimately
  // contains ``` code blocks, so a non-greedy inner match would truncate it.
  if (trimmed.startsWith("```")) {
    trimmed = trimmed.replace(/^```(?:json)?[ \t]*\r?\n?/i, "");
    trimmed = trimmed.replace(/\r?\n?```\s*$/i, "");
    trimmed = trimmed.trim();
  }
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) return trimmed.slice(first, last + 1);
  return trimmed;
}

/**
 * Escape raw control characters (newline/CR/tab) that appear INSIDE JSON string
 * values. Some models emit literal newlines in long markdown fields, which
 * strict JSON.parse rejects; this makes such responses parseable without
 * altering content outside strings.
 */
function sanitizeJsonControlChars(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        out += ch;
        escaped = true;
        continue;
      }
      if (ch === '"') {
        out += ch;
        inString = false;
        continue;
      }
      if (ch === "\n") { out += "\\n"; continue; }
      if (ch === "\r") { out += "\\r"; continue; }
      if (ch === "\t") { out += "\\t"; continue; }
      out += ch;
      continue;
    }
    out += ch;
    if (ch === '"') inString = true;
  }
  return out;
}

/**
 * Best-effort salvage of a truncated JSON object: closes an unterminated string
 * and balances braces/brackets so a long-but-cut-off model response still yields
 * the fields produced so far. Verification still gates the result afterwards.
 */
function salvageJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let body = text.slice(start);
  // Drop a trailing partial token after the last comma if present.
  const lastComma = body.lastIndexOf(",");
  const lastClose = Math.max(body.lastIndexOf("}"), body.lastIndexOf("]"));
  if (lastClose < lastComma) body = body.slice(0, lastComma);

  let inString = false;
  let escaped = false;
  const stack: string[] = [];
  for (const ch of body) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") stack.pop();
  }
  let repaired = body.trimEnd();
  if (inString) repaired += '"';
  while (stack.length > 0) repaired += stack.pop();
  try {
    return JSON.parse(repaired) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function coerceCompiled(raw: unknown): CompiledSkill {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    skill_name: String(obj.skill_name || "").trim(),
    title: String(obj.title || "").trim(),
    description: String(obj.description || "").trim(),
    category: obj.category ? String(obj.category).trim() : undefined,
    skill_markdown: String(obj.skill_markdown || "").trim(),
    support_files: Array.isArray(obj.support_files)
      ? (obj.support_files as Array<Record<string, unknown>>)
          .map((f) => ({ path: String(f.path || "").trim(), content: String(f.content || "") }))
          .filter((f) => f.path)
      : undefined,
    test_plan: Array.isArray(obj.test_plan) ? (obj.test_plan as unknown[]).map((s) => String(s)) : undefined,
    verification_commands: Array.isArray(obj.verification_commands)
      ? (obj.verification_commands as unknown[]).map((s) => String(s))
      : undefined,
    source_evidence: Array.isArray(obj.source_evidence)
      ? (obj.source_evidence as Array<Record<string, unknown>>).map((e) => ({
          section: String(e.section || ""),
          sources: Array.isArray(e.sources) ? (e.sources as unknown[]).map((s) => String(s)) : [],
        }))
      : undefined,
    uncertainties: Array.isArray(obj.uncertainties) ? (obj.uncertainties as unknown[]).map((s) => String(s)) : undefined,
    blocked_claims: Array.isArray(obj.blocked_claims) ? (obj.blocked_claims as unknown[]).map((s) => String(s)) : undefined,
  };
}

/**
 * Verify a pre-synthesized compiled skill and store a pending candidate. Used by
 * the live compiler and directly by deterministic tests (mocked model output).
 */
export function finalizeSourceSkillCandidate(input: {
  sourcePackId: string;
  compiled: CompiledSkill;
  sessionId?: string;
  compileRunId?: string;
}): CompileSourceSkillResult {
  const pack = getSourcePack(input.sourcePackId);
  if (!pack) throw new Error(`Source pack not found: ${input.sourcePackId}`);
  const compileRunId = input.compileRunId ?? `csr_${nanoid(10)}`;
  const verification = verifyCompiledSkill(input.compiled, combinedSourceText(input.sourcePackId));

  // Only ground a candidate when it passes deterministic verification. A failed
  // verification returns the report so the surface can explain why.
  if (!verification.passed) {
    return { proposal: null, compiled: input.compiled, verification, compileRunId };
  }

  const evidence = [
    `source_pack:${input.sourcePackId}`,
    ...buildProvenanceSummary(input.sourcePackId).split("\n").slice(0, 12),
    ...verification.warnings.map((w) => `warning:${w}`),
  ];

  const proposal = writeSelfImprovementProposal({
    sessionId: input.sessionId || `source-skill:${compileRunId}`,
    kind: "skill",
    title: input.compiled.title || input.compiled.skill_name,
    rationale: `Compiled from source pack "${pack.name}" (${pack.itemCount} sources). ${
      input.compiled.description || ""
    }`.trim(),
    proposedContent: input.compiled.skill_markdown,
    evidence,
    sourcePackId: input.sourcePackId,
    compileRunId,
    supportFiles: input.compiled.support_files,
    verification: { passed: verification.passed, checks: verification.checks },
  });

  setSourcePackStatus(input.sourcePackId, "compiled");
  return { proposal, compiled: input.compiled, verification, compileRunId };
}

/** Full live compile: model synthesis + verification + candidate. */
export async function compileSourceSkill(input: {
  sourcePackId: string;
  instruction?: string;
  sessionId?: string;
  provider: string;
  modelId: string;
  apiKey: string;
  baseUrl?: string;
}): Promise<CompileSourceSkillResult> {
  const userMessage = buildSourceSkillUserMessage({
    sourcePackId: input.sourcePackId,
    instruction: input.instruction,
  });
  const result = await callModel({
    provider: input.provider as Parameters<typeof callModel>[0]["provider"],
    modelId: input.modelId,
    apiKey: input.apiKey,
    baseUrl: input.baseUrl,
    systemPrompt: SOURCE_SKILL_SYSTEM_PROMPT,
    userMessage,
    maxTokens: 8000,
    temperature: 0.2,
  });
  let parsed: unknown;
  const cleaned = stripJsonFence(result.response || "");
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Common live-model issue: literal newlines/tabs inside string values.
    try {
      parsed = JSON.parse(sanitizeJsonControlChars(cleaned));
    } catch {
      // Last resort: salvage a truncated/over-long object.
      const salvaged = salvageJsonObject(sanitizeJsonControlChars(cleaned));
      if (!salvaged) {
        throw new Error("Model did not return valid JSON for the compiled skill");
      }
      parsed = salvaged;
    }
  }
  const compiled = coerceCompiled(parsed);
  return finalizeSourceSkillCandidate({
    sourcePackId: input.sourcePackId,
    compiled,
    sessionId: input.sessionId,
  });
}
