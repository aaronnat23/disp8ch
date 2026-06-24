/**
 * evidence-rich self-learning reviewer.
 *
 * Goal: combine an evidence-rich background review (a real agent
 * decision that can update memory AND skills) with disp8ch's existing
 * approval-queue safety (proposals are visible in the Skills UI and
 * require explicit operator action before any write).
 *
 * Behavior:
 * - Inspect the conversation, the tool trace, the critic reports, and the
 *   loaded/available skills.
 * - Emit proposals of kind memory / skill_patch / skill_support_file /
 *   new_skill / test_case.
 * - The existing self-improvement-proposals pipeline persists the
 *   proposals. Auto-promotion is gated on confidence, safety scans, and
 *   the target skill being unprotected.
 * - The reviewer prefers patching the loaded or umbrella skill before
 *   proposing a new narrow skill. It refuses to persist transient
 *   negative tool claims or one-off task status.
 */

import { logger } from "@/lib/utils/logger";
import { callModel } from "@/lib/agents/multi-provider";
import { scanLearningWrite } from "@/lib/learning/memory-guard";
import { scanSkillContent } from "@/lib/learning/skill-guard";
import {
  automaticSelfImprovementProposalsDisabled,
  writeSelfImprovementProposal,
} from "@/lib/channels/self-improvement-proposals";

const log = logger.child("learning:self-learning-reviewer");

export type SelfLearningReviewInput = {
  sessionId: string;
  agentId: string | null;
  conversation: Array<{ role: string; content: string; createdAt?: string }>;
  routeSource?: string | null;
  toolTrace?: Array<{ name: string; ok: boolean; argsSummary?: string; outputSummary?: string }>;
  filesChanged?: string[];
  testsRun?: Array<{ command: string; ok: boolean; outputSummary: string }>;
  criticReports?: Array<{ decision: string; confidence: string; findings?: string[]; missingEvidence?: string[] }>;
  loadedSkills?: Array<{ slug: string; title: string; path: string }>;
  availableSkills?: Array<{ slug: string; title: string; path: string; protected?: boolean; pinned?: boolean }>;
  learningMode: "off" | "review" | "auto";
};

export type SelfLearningProposalBase = {
  confidence: number;
  evidence: string[];
  rationale: string;
};

export type MemoryProposal = SelfLearningProposalBase & {
  kind: "memory";
  title: string;
  summary: string;
};

export type SkillPatchProposal = SelfLearningProposalBase & {
  kind: "skill_patch";
  targetSkillPath: string;
  title: string;
  patchMarkdown: string;
};

export type SkillSupportFileProposal = SelfLearningProposalBase & {
  kind: "skill_support_file";
  targetSkillPath: string;
  title: string;
  relativePath: "references/" | "templates/" | "scripts/" | "tests/";
  fileName: string;
  content: string;
  patchMarkdown?: string;
};

export type NewSkillProposal = SelfLearningProposalBase & {
  kind: "new_skill";
  slug: string;
  title: string;
  markdown: string;
};

export type TestCaseProposal = SelfLearningProposalBase & {
  kind: "test_case";
  title: string;
  prompt: string;
  expectedSignals: string[];
};

export type SelfLearningProposal =
  | MemoryProposal
  | SkillPatchProposal
  | SkillSupportFileProposal
  | NewSkillProposal
  | TestCaseProposal;

const REVIEW_SYSTEM_PROMPT = `You are a self-learning reviewer for a personal AI assistant.

You decide what durable memory or skill update (if any) should come out of a recent conversation.

Output ONLY compact JSON. No markdown, no prose, no code fences.

Top-level shape:
{
  "proposals": [
    ...one or more of: memory / skill_patch / skill_support_file / new_skill / test_case
  ]
}

Decision rules:
- Be active when there is a real correction, a reusable technique, a missing step, a workflow improvement, or a skill defect.
- Prefer patching a loaded or umbrella skill (skill_patch) before creating a new narrow skill.
- If the patch is too long for SKILL.md, propose a support file under references/, templates/, scripts/, or tests/ and pair it with a small skill_patch that points at it.
- Create a new class-level skill only when no existing umbrella fits.
- User corrections about style, format, depth, tool use, or workflow are first-class skill signals, not only memory signals.
- Save durable user facts / preferences as memory candidates.
- Save "how to do this class of task" as skills.
- NEVER save one-off task progress, PR numbers, temporary failures, environment setup failures, or negative claims like "browser is broken" as durable constraints.
- If a tool failed because of setup, capture the recovery pattern or required config, not "tool does not work."
- Do not propose modifying a protected bundled skill; propose a local override or companion skill instead.

Each proposal must include:
- kind: "memory" | "skill_patch" | "skill_support_file" | "new_skill" | "test_case"
- title, rationale, confidence (0-1), evidence (array of short strings)
- kind-specific fields (see schema below)

memory:        { title, summary, rationale, confidence, evidence }
skill_patch:   { targetSkillPath, title, patchMarkdown, rationale, confidence, evidence }
skill_support_file: { targetSkillPath, relativePath ("references/"|"templates/"|"scripts/"|"tests/"), fileName, content, patchMarkdown?, rationale, confidence, evidence }
new_skill:     { slug, title, markdown, rationale, confidence, evidence }
test_case:     { title, prompt, expectedSignals (array of strings), rationale, confidence, evidence }

If nothing durable stands out, return: { "proposals": [] }.`;

const TRANSIENT_NEGATIVE_PATTERNS = [
  /\b(?:is|are|seems?)\s+broken\b/i,
  /\bdoes(?:n't| not)\s+work\b/i,
  /\bcan'?t\s+(?:be\s+used|use|use\s+it)\b/i,
  /\bwill\s+never\b/i,
  /\bcompletely\s+useless\b/i,
  /\btool\s+(?:is|is\s+not)\s+(?:broken|dead|gone)\b/i,
];

function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) return fenced[1].trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

function isTransientNegative(text: string): boolean {
  return TRANSIENT_NEGATIVE_PATTERNS.some((pattern) => pattern.test(text));
}

function looksLikeOneOffStatus(text: string): boolean {
  if (/\b(?:pr|issue|task|commit|workflow|board)\s*#?\d+\b/i.test(text)) return true;
  if (/\b(?:running|executed|queued|completed|failed)\s+(?:in|at|on)\s+\d/i.test(text)) return true;
  if (/\b(?:today|yesterday|this\s+(?:morning|afternoon|evening))\b/i.test(text)) return true;
  return false;
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return Math.round(value * 100) / 100;
}

function safeString(value: unknown, max = 600): string {
  const v = String(value ?? "").replace(/\s+/g, " ").trim();
  return v.length <= max ? v : `${v.slice(0, max - 1).trimEnd()}…`;
}

function safeArray(value: unknown, max = 6): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .slice(0, max)
    .map((item) => safeString(item, 240));
}

function normalizeProposal(raw: unknown): SelfLearningProposal | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const kind = String(obj.kind || "").trim();
  const confidence = clampConfidence(Number(obj.confidence ?? 0.6));
  const rationale = safeString(obj.rationale, 600);
  const evidence = safeArray(obj.evidence, 8);

  if (kind === "memory") {    const title = safeString(obj.title, 200);
    const summary = safeString(obj.summary, 800);
    if (!title || !summary) return null;
    if (isTransientNegative(summary) || isTransientNegative(rationale)) return null;
    if (looksLikeOneOffStatus(summary)) return null;
    return { kind, title, summary, rationale, confidence, evidence };
  }

  if (kind === "skill_patch") {
    const targetSkillPath = safeString(obj.targetSkillPath, 600);
    const title = safeString(obj.title, 200);
    const patchMarkdown = safeString(obj.patchMarkdown, 6000);
    if (!targetSkillPath || !title || !patchMarkdown) return null;
    if (isTransientNegative(patchMarkdown) || isTransientNegative(title)) return null;
    if (patchMarkdown.length < 40) return null;
    return { kind, targetSkillPath, title, patchMarkdown, rationale, confidence, evidence };
  }

  if (kind === "skill_support_file") {
    const targetSkillPath = safeString(obj.targetSkillPath, 600);
    const relativeRaw = safeString(obj.relativePath, 40);
    const allowedFolders = ["references/", "templates/", "scripts/", "tests/"] as const;
    const relativePath = (allowedFolders as readonly string[]).includes(relativeRaw)
      ? (relativeRaw as SkillSupportFileProposal["relativePath"])
      : "references/";
    const fileName = safeString(obj.fileName, 100).replace(/[^a-zA-Z0-9._-]/g, "-");
    const content = safeString(obj.content, 6000);
    const title = safeString(obj.title, 200) || `Support file: ${fileName}`;
    if (!targetSkillPath || !fileName || !content) return null;
    if (content.length < 40) return null;
    if (isTransientNegative(content)) return null;
    const patchMarkdown = obj.patchMarkdown ? safeString(obj.patchMarkdown, 2000) : undefined;
    return {
      kind,
      targetSkillPath,
      title,
      relativePath,
      fileName,
      content,
      patchMarkdown,
      rationale,
      confidence,
      evidence,
    };
  }

  if (kind === "new_skill") {
    const slug = safeString(obj.slug, 80).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
    const title = safeString(obj.title, 200);
    const markdown = safeString(obj.markdown, 8000);
    if (!slug || !title || !markdown) return null;
    if (markdown.length < 80) return null;
    if (isTransientNegative(markdown) || isTransientNegative(title)) return null;
    return { kind, slug, title, markdown, rationale, confidence, evidence };
  }

  if (kind === "test_case") {
    const title = safeString(obj.title, 200);
    const prompt = safeString(obj.prompt, 1200);
    const expectedSignals = safeArray(obj.expectedSignals, 10);
    if (!title || !prompt || expectedSignals.length === 0) return null;
    return { kind, title, prompt, expectedSignals, rationale, confidence, evidence };
  }

  return null;
}

export const __test_normalizeProposal = normalizeProposal;
function buildUserMessage(input: SelfLearningReviewInput): string {
  const conversation = input.conversation
    .slice(-12)
    .map((turn, i) => `Turn ${i + 1}\n${turn.role.toUpperCase()}: ${safeString(turn.content, 800)}`)
    .join("\n\n");
  const toolTrace = (input.toolTrace ?? []).slice(-20)
    .map((tool) => `- ${tool.ok ? "OK" : "FAIL"} ${tool.name}${tool.argsSummary ? ` (${safeString(tool.argsSummary, 200)})` : ""}${tool.outputSummary ? `: ${safeString(tool.outputSummary, 200)}` : ""}`)
    .join("\n");
  const files = (input.filesChanged ?? []).map((f) => `- ${f}`).join("\n");
  const tests = (input.testsRun ?? []).map((t) => `- ${t.ok ? "OK" : "FAIL"} ${safeString(t.command, 200)}: ${safeString(t.outputSummary, 240)}`).join("\n");
  const critic = (input.criticReports ?? []).slice(-6)
    .map((c) => `- ${c.decision} (${c.confidence}) findings=${(c.findings ?? []).join("; ").slice(0, 240)}`)
    .join("\n");
  const loaded = (input.loadedSkills ?? []).map((s) => `- ${s.slug} (${s.path})`).join("\n");
  const available = (input.availableSkills ?? [])
    .filter((s) => !s.protected)
    .slice(0, 24)
    .map((s) => `- ${s.slug}${s.pinned ? " (pinned)" : ""} (${s.path})`)
    .join("\n");

  return [
    `Session: ${input.sessionId}`,
    input.agentId ? `Agent: ${input.agentId}` : "",
    `Route source: ${input.routeSource ?? "unknown"}`,
    `Learning mode: ${input.learningMode}`,
    "",
    "Conversation (last turns):",
    conversation || "(none)",
    toolTrace ? `\nTool trace (last 20):\n${toolTrace}` : "",
    files ? `\nFiles changed:\n${files}` : "",
    tests ? `\nTests run:\n${tests}` : "",
    critic ? `\nCritic reports:\n${critic}` : "",
    loaded ? `\nLoaded skills (prefer patching these):\n${loaded}` : "",
    available ? `\nAvailable workspace skills:\n${available}` : "",
  ].filter(Boolean).join("\n");
}

function loadWorkspaceSkills(): Array<{ slug: string; title: string; path: string; protected?: boolean; pinned?: boolean }> {
  try {
    const { listSkillsForPrompt } = require("@/lib/skills/prompt-index") as typeof import("@/lib/skills/prompt-index");
    const result = listSkillsForPrompt({ agentId: "default", lane: "read_only_workspace", availableTools: new Set() });
    return result.map((entry) => ({
      slug: entry.name,
      title: entry.name,
      path: entry.source,
      protected: entry.source === "builtin" || entry.source === "bundled",
      pinned: entry.source === "builtin" || entry.source === "bundled",
    }));
  } catch {
    return [];
  }
}

export async function runSelfLearningReview(
  input: SelfLearningReviewInput,
  opts: { provider: string; modelId: string; apiKey: string; baseUrl?: string },
): Promise<SelfLearningProposal[]> {
  if (automaticSelfImprovementProposalsDisabled()) return [];
  if (input.learningMode === "off") return [];
  if (input.conversation.length < 2) return [];

  const availableSkills = input.availableSkills ?? loadWorkspaceSkills();

  try {
    const result = await callModel({
      provider: opts.provider as Parameters<typeof callModel>[0]["provider"],
      modelId: opts.modelId,
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl,
      systemPrompt: REVIEW_SYSTEM_PROMPT,
      userMessage: buildUserMessage({ ...input, availableSkills }),
      maxTokens: 1800,
      temperature: 0.2,
    });
    const cleaned = stripJsonFence(result.response || "");
    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      return [];
    }
    const rawProposals = Array.isArray((parsed as { proposals?: unknown[] })?.proposals)
      ? (parsed as { proposals: unknown[] }).proposals
      : [];
    const normalized: SelfLearningProposal[] = [];
    for (const raw of rawProposals) {
      const candidate = normalizeProposal(raw);
      if (!candidate) continue;
      if (candidate.confidence < 0.55) continue;
      normalized.push(candidate);
    }
    return normalized;
  } catch (err) {
    log.warn("Self-learning review failed (non-fatal)", { error: String(err) });
    return [];
  }
}

function proposalToSelfImprovement(
  proposal: SelfLearningProposal,
  sessionId: string,
  agentId?: string | null,
): { kind: string; title: string } | null {
  switch (proposal.kind) {
    case "memory": {
      const guard = scanLearningWrite("memory", proposal.summary);
      if (!guard.safe) return null;
      // The memory proposal path is migrated to the cross-surface candidate
      // model: it becomes a reviewable, source-linked candidate (origin webchat)
      // instead of a file-based self-improvement proposal that writes the
      // generic workspace MEMORY.md. Skill/test proposals keep their queue.
      try {
        const { createMemoryCandidate } = require("@/lib/memory/candidates") as typeof import("@/lib/memory/candidates");
        const { resolveMemoryScope } = require("@/lib/memory/scope-resolver") as typeof import("@/lib/memory/scope-resolver");
        // Resolve the originating agent at the persistence boundary. Candidate
        // visibility must follow the agent that produced the conversation,
        // rather than silently falling back to the default agent.
        const scope = resolveMemoryScope(agentId);
        createMemoryCandidate({
          agentId: scope.memoryAgentId,
          content: proposal.summary,
          type: "preference",
          confidence: proposal.confidence,
          scopeKind: "agent",
          originType: "webchat",
          originId: sessionId,
          sessionId,
          sourceSummary: proposal.title,
          evidence: proposal.evidence,
        });
      } catch {
        // Candidate creation is best-effort; never block the review loop.
        return null;
      }
      return { kind: "memory", title: proposal.title };
    }
    case "skill_patch": {
      const scan = scanSkillContent(proposal.patchMarkdown);
      if (!scan.safe) return null;
      return writeSelfImprovementProposal({
        sessionId,
        kind: "skill",
        title: `[patch] ${proposal.title}`,
        rationale: proposal.rationale,
        proposedContent: proposal.patchMarkdown,
        evidence: [`target=${proposal.targetSkillPath}`, ...proposal.evidence],
      });
    }
    case "skill_support_file": {
      const fullPath = `${proposal.targetSkillPath.replace(/[\\/]+$/, "")}/${proposal.relativePath}${proposal.fileName}`;
      const scan = scanSkillContent(proposal.content);
      if (!scan.safe) return null;
      const composed = proposal.patchMarkdown
        ? `${proposal.patchMarkdown}\n\n<!--\nNew support file: ${fullPath}\n-->\n`
        : `<!-- support file: ${fullPath} -->\n\n${proposal.content}`;
      return writeSelfImprovementProposal({
        sessionId,
        kind: "skill",
        title: `[support] ${proposal.title}`,
        rationale: proposal.rationale,
        proposedContent: composed,
        evidence: [`file=${fullPath}`, ...proposal.evidence],
      });
    }
    case "new_skill": {
      const scan = scanSkillContent(proposal.markdown);
      if (!scan.safe) return null;
      return writeSelfImprovementProposal({
        sessionId,
        kind: "skill",
        title: proposal.title,
        rationale: proposal.rationale,
        proposedContent: proposal.markdown,
        evidence: [`new_skill=${proposal.slug}`, ...proposal.evidence],
      });
    }
    case "test_case": {
      return writeSelfImprovementProposal({
        sessionId,
        kind: "test_case",
        title: proposal.title,
        rationale: proposal.rationale,
        proposedContent: `${proposal.prompt}\n\nExpected signals:\n${proposal.expectedSignals.map((s) => `- ${s}`).join("\n")}`,
        evidence: proposal.evidence,
      });
    }
    default:
      return null;
  }
}

const PROPOSAL_KIND_MAP: Record<SelfLearningProposal["kind"], string> = {
  memory: "memory",
  skill_patch: "skill",
  skill_support_file: "skill",
  new_skill: "skill",
  test_case: "test_case",
};

function proposalDisplayTitle(proposal: SelfLearningProposal): string {
  if (proposal.kind === "skill_patch") return `[patch] ${proposal.title}`;
  if (proposal.kind === "skill_support_file") return `[support] ${proposal.title}`;
  return proposal.title;
}

export async function persistSelfLearningProposals(
  proposals: SelfLearningProposal[],
  sessionId: string,
  opts: { agentId?: string | null } = {},
): Promise<{ written: number; rejected: number; deduped: number }> {
  let written = 0;
  let rejected = 0;
  let deduped = 0;
  // Repeated reviews over similar interactions must not stack duplicates: a
  // pending proposal with the same kind + display title already covers it.
  let pending: Array<{ kind: string; title: string }> = [];
  try {
    const { listSelfImprovementProposals } = await import("@/lib/channels/self-improvement-proposals");
    pending = listSelfImprovementProposals()
      .filter((entry) => entry.status === "pending")
      .map((entry) => ({ kind: entry.kind, title: entry.title }));
  } catch {
    // Listing failures must not block persistence.
  }
  for (const proposal of proposals) {
    try {
      const expectedKind = PROPOSAL_KIND_MAP[proposal.kind];
      const expectedTitle = proposalDisplayTitle(proposal).trim().toLowerCase();
      const duplicate = pending.some(
        (entry) => entry.kind === expectedKind && entry.title.trim().toLowerCase() === expectedTitle,
      );
      if (duplicate) {
        deduped += 1;
        continue;
      }
      const persisted = proposalToSelfImprovement(proposal, sessionId, opts.agentId);
      if (persisted) {
        written += 1;
        pending.push({ kind: persisted.kind, title: persisted.title });
      } else rejected += 1;
    } catch (err) {
      log.warn("Failed to persist self-learning proposal", { error: String(err), kind: proposal.kind });
      rejected += 1;
    }
  }
  return { written, rejected, deduped };
}

export function shouldRunSelfLearningReview(input: {
  routeSource?: string | null;
  message?: string;
  toolTrace?: Array<{ name: string; ok: boolean }>;
  filesChanged?: string[];
  criticReports?: Array<{ decision: string }>;
}): boolean {
  if (input.routeSource && String(input.routeSource).startsWith("agentic:")) return true;
  if ((input.filesChanged ?? []).length > 0) return true;
  if ((input.toolTrace ?? []).some((tool) => !tool.ok)) return true;
  if ((input.criticReports ?? []).some((report) => report.decision === "repair" || report.decision === "continue")) return true;
  if (input.message && /\b(?:next time|from now on|do not|always|never|stop doing|in the future|going forward|does\s+.+\s+better|this is better|prefer|don't)\b/i.test(input.message)) return true;
  return false;
}
