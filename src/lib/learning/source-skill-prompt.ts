/**
 * Builds the model prompt for compiling a source pack into a reusable skill.
 * The model only ever sees the bounded, audited pack content — never arbitrary
 * file access. Output is a strict JSON object the deterministic verifier checks.
 */
import { listSourcePackChunks, listSourcePackItems, getSourcePack } from "@/lib/source-packs/store";

export const SOURCE_SKILL_SYSTEM_PROMPT = `You compile provided source material into ONE reusable agent skill.

Rules:
- Use ONLY the supplied source excerpts. Do not invent commands, file paths, flags, endpoints, APIs, or version numbers that are not present in the sources.
- If a procedure is not supported by the sources, list it under "uncertainties" or "blocked_claims" instead of stating it as fact.
- Never include API keys, tokens, passwords, or other secrets.
- Provide at least one concrete verification check the user can run.
- Keep the skill description concise and routeable (one sentence on when to use it).
- Cite which source(s) support each major procedure section under "source_evidence".

Return ONLY a JSON object with this exact shape:
{
  "skill_name": "kebab-case-name",
  "title": "Human Title",
  "description": "One concise sentence describing when to use this skill.",
  "category": "short-category",
  "skill_markdown": "Full SKILL.md body with YAML frontmatter (name, description) and procedure sections.",
  "support_files": [{ "path": "references/notes.md", "content": "..." }],
  "test_plan": ["step 1", "step 2"],
  "verification_commands": ["command or check"],
  "source_evidence": [{ "section": "Setup", "sources": ["README.md"] }],
  "uncertainties": ["things the sources did not cover"],
  "blocked_claims": ["claims that could not be grounded in the sources"]
}`;

export function buildSourceSkillUserMessage(input: {
  sourcePackId: string;
  instruction?: string;
  maxChunkChars?: number;
}): string {
  const pack = getSourcePack(input.sourcePackId);
  if (!pack) throw new Error(`Source pack not found: ${input.sourcePackId}`);
  const items = listSourcePackItems(input.sourcePackId).filter((i) => !i.skippedReason);
  const chunks = listSourcePackChunks(input.sourcePackId, 120);
  const budget = input.maxChunkChars ?? 18000;

  const manifest = items
    .map((i) => `- ${i.displayName}${i.sourceUri ? ` [${i.sourceUri}]` : ""} (${i.mimeType ?? "text"})`)
    .join("\n");

  let used = 0;
  const excerpts: string[] = [];
  const itemNameById = new Map(items.map((i) => [i.id, i.displayName]));
  for (const chunk of chunks) {
    if (used >= budget) break;
    const name = itemNameById.get(chunk.itemId) ?? chunk.itemId;
    const piece = `### ${name} (chunk ${chunk.chunkIndex})\n${chunk.content}`;
    excerpts.push(piece);
    used += piece.length;
  }

  return [
    `Source pack: ${pack.name}`,
    pack.description ? `Description: ${pack.description}` : "",
    "",
    "Source manifest:",
    manifest || "(no usable sources)",
    "",
    input.instruction
      ? `User instruction: ${input.instruction}`
      : "Compile a reusable skill that explains setup, the most common procedures, and how to verify success.",
    "",
    "Source excerpts:",
    excerpts.join("\n\n") || "(no excerpts available)",
  ]
    .filter(Boolean)
    .join("\n");
}
