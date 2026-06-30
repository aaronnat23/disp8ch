/**
 * WebChat "learn from source" intent. Deterministically recognizes requests to
 * compile a Document, data source, or Notebook into a reusable skill, resolves
 * the bounded source set (never arbitrary filesystem access from a chat string),
 * builds an auditable source pack, compiles a REVIEW-FIRST candidate, and returns
 * a message. It never silently installs the skill.
 */
import { getDocumentById, getDocumentByName } from "@/lib/documents/store";
import { getNotebook, listNotebookDocuments } from "@/lib/notebooks/store";
import { buildSourcePackFromDocuments } from "@/lib/source-packs/build";
import { compileSourceSkill } from "@/lib/learning/source-skill-compiler";

export type LearnSourceIntent = {
  matched: boolean;
  rawRef: string | null;
  notebook: boolean;
  folderRequested: boolean;
  instruction: string;
};

const SLASH_RE = /^\/learn\b\s*(.*)$/i;
const NL_RE = /\blearn\b[\s\S]{0,80}?\bas a (?:reusable )?skill\b/i;
// The natural-language path only triggers when the message clearly refers to a
// stored source, so ordinary chat ("learn React as a skill") is not hijacked.
const SOURCE_KEYWORD_RE = /\b(document|notebook|data source|source pack|sources?|folder|files?|attached)\b/i;

export function detectLearnSourceIntent(raw: string): LearnSourceIntent {
  const trimmed = String(raw || "").trim();
  const slash = trimmed.match(SLASH_RE);
  const isNl = NL_RE.test(trimmed) && SOURCE_KEYWORD_RE.test(trimmed);
  if (!slash && !isNl) {
    return { matched: false, rawRef: null, notebook: false, folderRequested: false, instruction: trimmed };
  }
  const body = slash ? slash[1] : trimmed;
  const notebook = /\bnotebook\b/i.test(body);
  const folderRequested = /\bfolder\b/i.test(body) || /[\\/].+[\\/]/.test(body);

  // Extract an explicit id (id: xxx) or "from <token>" reference.
  let rawRef: string | null = null;
  const idMatch = body.match(/\bid:\s*([\w-]{4,})/i);
  if (idMatch) rawRef = idMatch[1];
  if (!rawRef) {
    const fromMatch = body.match(/\bfrom\s+(?:the\s+)?(?:document|notebook|data source|source)?\s*["']?([\w-]{4,})["']?/i);
    if (fromMatch) rawRef = fromMatch[1];
  }
  if (!rawRef) {
    const quoted = body.match(/["']([^"']{3,})["']/);
    if (quoted) rawRef = quoted[1];
  }
  if (!rawRef) {
    // "...notebook nb-777..." / "...document doc-123..." without "from".
    const refMatch = body.match(/\b(?:document|notebook|data source|source)\s+(?:id\s+)?([\w-]{4,})/i);
    if (refMatch) rawRef = refMatch[1];
  }

  return { matched: true, rawRef, notebook, folderRequested, instruction: trimmed };
}

export type LearnSourceOutcome = {
  ok: boolean;
  message: string;
};

function buildCompileInstruction(rawInstruction: string, label: string, originType: "document" | "notebook"): string {
  const userInstruction = rawInstruction.trim();
  return [
    userInstruction || `Compile ${originType} "${label}" into one reusable skill.`,
    "",
    "Output requirements for this learned skill:",
    "- Create exactly one reusable SKILL.md-style skill candidate.",
    "- The skill_markdown field must start with YAML frontmatter delimited by --- and include both name and description.",
    "- Include concrete procedure sections grounded only in the source pack.",
    "- Include a Verification section and at least one verification_commands entry.",
    "- Include source_evidence entries that point back to the supplied source names.",
    "- Do not claim the skill is installed or enabled. This is review-first and must remain pending until the operator approves it.",
  ].join("\n");
}

/**
 * Resolve the referenced source(s) and compile a review-first skill candidate.
 * Returns a human-readable message describing the candidate and how to review.
 */
export async function handleLearnSourceIntent(input: {
  intent: LearnSourceIntent;
  sessionId?: string;
  model: { provider: string; modelId: string; apiKey: string; baseUrl?: string };
}): Promise<LearnSourceOutcome> {
  const { intent } = input;

  if (intent.folderRequested) {
    return {
      ok: false,
      message:
        "Learning from a folder needs a bounded, confirmed scope. Open **Skills → Learn from sources** (or the Documents tab) and select the folder there — the app will list the exact files before indexing. I won't index an arbitrary filesystem path from a chat message.",
    };
  }

  if (!intent.rawRef) {
    return {
      ok: false,
      message:
        "Tell me which source to learn from, e.g. `/learn from document <id>` or `learn the notebook <id> as a reusable skill`. You can also use **Skills → Learn from sources** to pick documents visually.",
    };
  }

  // Resolve to a concrete, bounded set of document ids.
  let documentIds: string[] = [];
  let label = intent.rawRef;
  let originType: "document" | "notebook" = "document";

  if (intent.notebook) {
    const notebook = getNotebook(intent.rawRef);
    if (!notebook) {
      return { ok: false, message: `I couldn't find a notebook with id \`${intent.rawRef}\`.` };
    }
    documentIds = listNotebookDocuments(notebook.id).map((d) => d.documentId).filter(Boolean);
    label = notebook.name;
    originType = "notebook";
    if (documentIds.length === 0) {
      return { ok: false, message: `Notebook "${notebook.name}" has no enabled source documents to learn from.` };
    }
  } else {
    const doc = getDocumentById(intent.rawRef) || getDocumentByName(intent.rawRef);
    if (!doc) {
      return {
        ok: false,
        message: `I couldn't find a document with id or name \`${intent.rawRef}\`. List your sources in the Documents tab and try again.`,
      };
    }
    documentIds = [doc.id];
    label = doc.name;
  }

  const built = buildSourcePackFromDocuments({
    name: `Learned: ${label}`.slice(0, 120),
    documentIds,
    originType,
    createdBySurface: "webchat",
  });

  const result = await compileSourceSkill({
    sourcePackId: built.pack.id,
    instruction: buildCompileInstruction(intent.instruction, label, originType),
    sessionId: input.sessionId,
    provider: input.model.provider,
    modelId: input.model.modelId,
    apiKey: input.model.apiKey,
    baseUrl: input.model.baseUrl,
  });

  if (!result.proposal) {
    return {
      ok: false,
      message: [
        `I compiled a draft skill from **${label}**, but it did not pass verification, so I did **not** create a candidate.`,
        "",
        "Failed checks:",
        ...result.verification.failures.map((f) => `- ${f}`),
        "",
        "This is the safety gate working: I won't propose a skill that invents endpoints, leaks secrets, or lacks a verification step.",
      ].join("\n"),
    };
  }

  return {
    ok: true,
    message: [
      `I built an auditable source pack from **${label}** (${built.added} source(s)) and compiled a **review-first** skill candidate. It is **not installed** yet.`,
      "",
      `**${result.compiled.title || result.compiled.skill_name}** — ${result.compiled.description}`,
      "",
      `Verification: ${result.verification.passed ? "passed ✓" : "failed"}.`,
      result.verification.warnings.length > 0 ? `Warnings: ${result.verification.warnings.join("; ")}` : "",
      (result.compiled.blocked_claims ?? []).length > 0
        ? `Blocked claims (not asserted): ${result.compiled.blocked_claims!.join("; ")}`
        : "",
      "",
      "Review the evidence and **approve to install** under **Skills → Self-Improvement Proposals**.",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}
