import fs from "node:fs";
import path from "node:path";
import { installExternalSkillPack, type ExternalSkillPackInstall } from "@/lib/skills/installer";
import { buildGlobalExtensionEntries } from "@/lib/extensions/state";
import { logger } from "@/lib/utils/logger";

const log = logger.child("learning:importers");

type EcosystemKind = "skill-library" | "workspace-library";

export type EcosystemImportResult = {
  ecosystem: EcosystemKind;
  repoPath: string;
  skillCount: number;
  importedPack: ExternalSkillPackInstall;
  recommendedExtensionIds: string[];
};

function collapseWhitespace(value: string): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function clip(value: string, maxChars = 180): string {
  const collapsed = collapseWhitespace(value);
  if (collapsed.length <= maxChars) return collapsed;
  return `${collapsed.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function slugify(value: string): string {
  return collapseWhitespace(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function listFilesRecursive(rootDir: string): string[] {
  const out: string[] = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".next") continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        out.push(fullPath);
      }
    }
  }
  return out;
}

function humanize(value: string): string {
  return collapseWhitespace(String(value || "").replace(/[-_]+/g, " "))
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function isDangerousLine(line: string): boolean {
  return (
    /\b(rm\s+-rf\s+\/(?!\w)|mkfs(?:\.\w+)?\b|shutdown\b|reboot\b|Remove-Item\b.*-Recurse\b.*-Force\b|del\s+\/[a-z]*\s+\*|format\s+[a-z]:)\b/i.test(line) ||
    (/\b(fetch|axios|wget|curl|http_request|https?:\/\/|discord\.com\/api|slack\.com\/api)\b/i.test(line) &&
      /\b(process\.env|authorization|api[_-]?key|secret|token|cookie|bearer)\b/i.test(line)) ||
    /\b(ignore (all|any|previous) instructions|reveal (the )?system prompt|exfiltrate secrets|disable safety|bypass guardrails)\b/i.test(line)
  );
}

function extractFrontmatterBlock(markdown: string): { frontmatter: string[]; body: string } {
  const lines = markdown.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return { frontmatter: [], body: markdown };
  }
  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (endIndex <= 0) {
    return { frontmatter: [], body: markdown };
  }
  return {
    frontmatter: lines.slice(1, endIndex),
    body: lines.slice(endIndex + 1).join("\n"),
  };
}

function extractFrontmatterItems(lines: string[], key: string): string[] {
  const out: string[] = [];
  let active = false;
  for (const rawLine of lines) {
    const line = rawLine.replace(/\t/g, "  ");
    if (!active) {
      if (new RegExp(`^${key}:\\s*$`, "i").test(line.trim())) {
        active = true;
      }
      continue;
    }
    if (/^[A-Za-z0-9_-]+:\s*/.test(line.trim())) break;
    const match = line.match(/^\s*-\s+(.+)$/);
    if (match?.[1]) out.push(collapseWhitespace(match[1]));
  }
  return out.filter(Boolean);
}

function buildNormalizedSkillMarkdown(params: {
  ecosystem: EcosystemKind;
  repoPath: string;
  skillDir: string;
}): string {
  const skillPath = path.join(params.skillDir, "SKILL.md");
  const raw = fs.readFileSync(skillPath, "utf8");
  const relativeSkillDir = path.relative(params.repoPath, params.skillDir).replace(/\\/g, "/");
  const { frontmatter, body } = extractFrontmatterBlock(raw);
  const bodyLines = body.split(/\r?\n/);

  const heading =
    bodyLines.find((line) => /^#\s+/.test(line))?.replace(/^#\s+/, "").trim() ||
    humanize(path.basename(params.skillDir));

  const summaryBullets: string[] = [];
  let inCodeFence = false;
  for (const rawLine of bodyLines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("```")) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;
    if (/^#/.test(line)) continue;
    if (isDangerousLine(line)) continue;
    if (/\bhttps?:\/\//i.test(line)) continue;
    if (/\b(curl|wget|axios|fetch|http_request|npm\s+install|pnpm\s+add|pip\s+install|brew\s+install)\b/i.test(line)) continue;
    if (/\b(token|bearer|authorization|api[_-]?key|secret|cookie)\b/i.test(line)) continue;
    const cleaned = collapseWhitespace(line.replace(/^[-*]\s+/, "").replace(/^\d+\.\s+/, ""));
    if (!cleaned || cleaned.length < 24) continue;
    if (summaryBullets.some((existing) => existing.toLowerCase() === cleaned.toLowerCase())) continue;
    summaryBullets.push(cleaned);
    if (summaryBullets.length >= 5) break;
  }

  const requiredEnv = extractFrontmatterItems(frontmatter, "required_env")
    .map((item) => item.replace(/[^A-Za-z0-9_,-]+/g, " ").trim())
    .filter(Boolean);
  const setupNotes = extractFrontmatterItems(frontmatter, "setup_notes")
    .filter((item) => !isDangerousLine(item))
    .map((item) => clip(item, 180))
    .filter(Boolean);

  const safeSummary =
    summaryBullets.length > 0
      ? summaryBullets
      : ["Imported skill adapted into a safe disp8ch skill summary."];

  return [
    `# ${heading}`,
    "",
    `Imported from external skill library: \`${relativeSkillDir}/SKILL.md\``,
    "This imported version keeps safe high-level guidance and provenance, without copying risky command or credential examples verbatim.",
    "",
    "## Use When",
    ...safeSummary.map((line) => `- ${line}`),
    ...(requiredEnv.length > 0
      ? [
          "",
          "## Setup Hints",
          `- Original skill referenced these env vars: ${requiredEnv.join(", ")}.`,
          "- Add secrets through Settings, Secrets, or the plain-English setup helpers before running connected tasks.",
        ]
      : []),
    ...(setupNotes.length > 0
      ? [
          "",
          "## Imported Notes",
          ...setupNotes.map((line) => `- ${line}`),
        ]
      : []),
    "",
    "## Playbook",
    "1. Match the task to the original skill intent described above.",
    "2. Prefer disp8ch builtin app-control routes, enabled skills, and runtime-backed extensions before generic tool loops.",
    "3. Ask for missing credentials or setup only when the current task genuinely depends on them.",
    "4. Keep outputs structured, concise, and grounded in the current workspace or org state.",
    "",
    "## Source",
    `- Ecosystem: ${params.ecosystem}`,
    `- Original path: ${relativeSkillDir}/SKILL.md`,
    "- Imported by disp8ch evidence-safe skill importer.",
    "",
  ].join("\n");
}

function collectSkillDirectories(repoPath: string, ecosystem: EcosystemKind): string[] {
  const files = listFilesRecursive(repoPath);
  const skillDirs = files
    .filter((filePath) => path.basename(filePath).toLowerCase() === "skill.md")
    .map((filePath) => path.dirname(filePath));

  if (ecosystem === "skill-library") {
    return skillDirs.filter((dirPath) => /[\\/](skills|optional-skills)[\\/]/i.test(dirPath));
  }
  return skillDirs.filter((dirPath) => /[\\/](skills|extensions[\\/].+[\\/]skills)[\\/]/i.test(dirPath));
}

function collectRecommendedExtensions(repoPath: string): string[] {
  const supported = new Set(buildGlobalExtensionEntries().map((entry) => entry.id));
  const extensionRoot = path.join(repoPath, "extensions");
  if (!fs.existsSync(extensionRoot) || !fs.statSync(extensionRoot).isDirectory()) return [];
  const recommended = new Set<string>();
  for (const entry of fs.readdirSync(extensionRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const id = entry.name.trim().toLowerCase();
    if (supported.has(id)) recommended.add(id);
  }
  return [...recommended].sort();
}

function buildPersistentImportPack(params: {
  ecosystem: EcosystemKind;
  repoPath: string;
  skillDirs: string[];
}): { packRoot: string; skillCount: number } {
  const cacheRoot = path.resolve("data", "imports", "ecosystems");
  fs.mkdirSync(cacheRoot, { recursive: true });
  const repoName = path.basename(path.resolve(params.repoPath));
  const packId = `${params.ecosystem}-${slugify(repoName || params.ecosystem)}-import`;
  const packRoot = path.join(cacheRoot, packId);
  fs.rmSync(packRoot, { recursive: true, force: true });
  fs.mkdirSync(packRoot, { recursive: true });

  const manifestSkills: string[] = [];
  const usedNames = new Set<string>();
  for (const skillDir of params.skillDirs) {
    const relative = path.relative(params.repoPath, skillDir).replace(/\\/g, "/");
    let targetName = slugify(relative.replace(/\//g, "-")) || `skill-${manifestSkills.length + 1}`;
    let counter = 2;
    while (usedNames.has(targetName)) {
      targetName = `${targetName}-${counter++}`;
    }
    usedNames.add(targetName);
    const targetDir = path.join(packRoot, targetName);
    fs.mkdirSync(targetDir, { recursive: true });
    const markdown = buildNormalizedSkillMarkdown({
      ecosystem: params.ecosystem,
      repoPath: params.repoPath,
      skillDir,
    });
    fs.writeFileSync(path.join(targetDir, "SKILL.md"), `${markdown.trimEnd()}\n`, "utf8");
    fs.writeFileSync(
      path.join(targetDir, "import-source.json"),
      `${JSON.stringify(
        {
          ecosystem: params.ecosystem,
          originalPath: relative,
          importedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    manifestSkills.push(targetName);
  }

  const manifest = {
    id: packId,
    name: params.ecosystem === "workspace-library" ? "Imported Workspace Skills" : "Imported Skills",
    description: `Imported from ${path.resolve(params.repoPath)}`,
    skills: manifestSkills,
  };
  fs.writeFileSync(
    path.join(packRoot, "disp8ch.skill-pack.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return { packRoot, skillCount: manifestSkills.length };
}

function importEcosystemRepo(repoPathRaw: string, ecosystem: EcosystemKind): EcosystemImportResult {
  const repoPath = path.resolve(repoPathRaw);
  if (!fs.existsSync(repoPath) || !fs.statSync(repoPath).isDirectory()) {
    throw new Error(`Repository path not found: ${repoPath}`);
  }
  const skillDirs = collectSkillDirectories(repoPath, ecosystem);
  if (skillDirs.length === 0) {
    throw new Error(`No SKILL.md directories found in ${repoPath}`);
  }
  const { packRoot, skillCount } = buildPersistentImportPack({ ecosystem, repoPath, skillDirs });
  const importedPack = installExternalSkillPack({ source: packRoot });
  const recommendedExtensionIds = ecosystem === "workspace-library" ? collectRecommendedExtensions(repoPath) : [];

  log.info("Imported external ecosystem repo", {
    ecosystem,
    repoPath,
    skillCount,
    importedPackId: importedPack.id,
    recommendedExtensionIds,
  });

  return {
    ecosystem,
    repoPath,
    skillCount,
    importedPack,
    recommendedExtensionIds,
  };
}

export function importExternalSkillLibraryRepo(repoPath: string): EcosystemImportResult {
  return importEcosystemRepo(repoPath, "skill-library");
}

export function importWorkspaceSkillLibraryRepo(repoPath: string): EcosystemImportResult {
  return importEcosystemRepo(repoPath, "workspace-library");
}
