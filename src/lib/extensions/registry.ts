import fs from "node:fs";
import path from "node:path";
import { TOOL_LABELS } from "@/lib/engine/tools";
import { listExternalExtensionInstalls } from "@/lib/extensions/installer";
import { listExternalSkillPacks } from "@/lib/skills/installer";
import { getWorkspaceDir } from "@/lib/workspace/files";

export type ExtensionManifest = {
  id: string;
  name: string;
  description: string;
  skills?: string[];
  runtime?: string;
  configSchema?: Record<string, unknown>;
  uiHints?: Record<string, unknown>;
};

export type ExtensionCatalogEntry = {
  id: string;
  name: string;
  description: string;
  source: "bundled" | "external";
  skillCount: number;
  configurable: boolean;
  manifestPath: string;
  installSource: "bundled" | "git" | "local";
  sourceRef?: string | null;
  sourceRevision?: string | null;
  runtimePath?: string | null;
  scanStatus?: "pass" | "warn" | "blocked" | null;
  scanSummary?: string | null;
  scanFindings?: Array<{
    ruleId: string;
    severity: "warn" | "error";
    title: string;
    summary: string;
    filePath: string;
    line: number | null;
    excerpt: string | null;
  }> | null;
  scannedAt?: string | null;
  installedAt?: string | null;
  updatedAt?: string | null;
};

export type AgentSkillEntry = {
  id: string;
  name: string;
  label: string;
  description: string;
  source: "core" | "optional" | "workspace" | "agent" | "extension" | "external";
  extensionId: string | null;
  skillPath: string;
  enabled: boolean;
  requiredEnv?: string[];
  platforms?: string[];
  setupNotes?: string[];
};

export type AgentSkillInventoryEntry = {
  id: string;
  label: string;
  source: "core" | "optional" | "workspace" | "agent" | "extension" | "external";
  extensionId: string | null;
  skillPath: string;
};

export type AgentExtensionEntry = {
  id: string;
  name: string;
  description: string;
  source: "bundled" | "external";
  skillCount: number;
  configurable: boolean;
  installSource: "bundled" | "git" | "local";
  enabled: boolean;
  eligible?: boolean;
};

export type IntegrationPresetEntry = {
  id: string;
  name: string;
  description: string;
  extensions: string[];
  skills: string[];
  recommendedRoleTypes?: string[];
};

type ParsedSkillFile = {
  label: string;
  description: string;
  content: string;
  requiredEnv: string[];
  platforms: string[];
  setupNotes: string[];
};

type SkillCatalogOptions = {
  workspacePath?: string | null;
  agentWorkspacePath?: string | null;
};

const INTEGRATION_PRESETS: IntegrationPresetEntry[] = [
  {
    id: "ops-commander",
    name: "Ops Commander",
    description: "Observability, incident response, and team chat delivery for operational leaders.",
    extensions: ["diagnostics-otel", "incidents", "slack", "msteams"],
    skills: [
      "ops-governance",
      "incident-triage",
      "diagnostics-otel:ops-observability",
      "incidents:incident-commander",
      "slack:slack-ops",
      "msteams:teams-ops",
    ],
    recommendedRoleTypes: ["operations", "orchestrator"],
  },
  {
    id: "research-analyst",
    name: "Research Analyst",
    description: "Data-source, memory, and document-heavy analysis for specialist agents.",
    extensions: ["data-sources", "memory-core", "slack"],
    skills: [
      "document-intelligence",
      "document-ingestion-operator",
      "data-sources:source-research",
      "memory-core:memory-curator",
      "slack:slack-ops",
    ],
    recommendedRoleTypes: ["specialist", "worker"],
  },
  {
    id: "launch-manager",
    name: "Launch Manager",
    description: "Release coordination, board execution, and backup discipline for launches.",
    extensions: ["release-ops", "backup", "slack", "msteams"],
    skills: [
      "board-ops",
      "release-manager",
      "backup:backup-operator",
      "release-ops:release-ops",
      "slack:slack-ops",
      "msteams:teams-ops",
    ],
    recommendedRoleTypes: ["operations", "orchestrator", "worker"],
  },
  {
    id: "hierarchy-lead",
    name: "Hierarchy Lead",
    description: "Org-scoped delegation, councils, and cross-team coordination.",
    extensions: ["hierarchy", "slack", "msteams", "googlechat"],
    skills: [
      "board-ops",
      "council-facilitator",
      "hierarchy:team-delegation",
      "googlechat:googlechat-ops",
      "slack:slack-ops",
      "msteams:teams-ops",
    ],
    recommendedRoleTypes: ["orchestrator", "operations"],
  },
  {
    id: "community-ops",
    name: "Community Ops",
    description: "Multi-channel coordination for external-facing support and community agents.",
    extensions: ["discord", "slack", "googlechat", "mattermost", "matrix"],
    skills: [
      "discord:discord-ops",
      "slack:slack-ops",
      "googlechat:googlechat-ops",
      "mattermost:mattermost-ops",
      "matrix:matrix-ops",
    ],
    recommendedRoleTypes: ["support", "worker"],
  },
  {
    id: "autonomous-researcher",
    name: "Autonomous Researcher",
    description: "End-to-end research pipeline: literature review, hypothesis formation, empirical validation, synthesis, and written reports.",
    extensions: ["web-research", "data-sources", "memory-core"],
    skills: [
      "autonomous-researcher",
      "experiment-loop",
      "document-intelligence",
      "web-research:web-research",
      "data-sources:source-research",
      "memory-core:memory-curator",
    ],
    recommendedRoleTypes: ["specialist", "worker"],
  },
  {
    id: "coding-agent",
    name: "Coding Agent",
    description: "Autonomous code generation, self-healing execution, metric-driven optimization, and GitHub integration.",
    extensions: ["coding", "github", "diffs"],
    skills: [
      "coding:coding-agent",
      "experiment-loop",
      "github:github-ops",
      "diffs:diff-review",
      "code-dispatch",
    ],
    recommendedRoleTypes: ["worker", "specialist"],
  },
  {
    id: "content-curator",
    name: "Content Curator",
    description: "Summarize, monitor, and archive web content — URLs, feeds, PDFs, and documents.",
    extensions: ["web-research", "data-sources"],
    skills: [
      "summarize",
      "blogwatcher",
      "nano-pdf",
      "document-intelligence",
      "web-research:web-research",
      "data-sources:source-research",
    ],
    recommendedRoleTypes: ["specialist", "worker"],
  },
  {
    id: "productivity-assistant",
    name: "Productivity Assistant",
    description: "Integrate with Notion, Obsidian, weather, and cross-platform note-taking tools.",
    extensions: ["web-research"],
    skills: [
      "google-workspace-ops",
      "notion",
      "obsidian",
      "proactive-memory",
      "weather",
      "summarize",
      "board-ops",
    ],
    recommendedRoleTypes: ["support", "worker"],
  },
  {
    id: "workspace-chief-of-staff",
    name: "Workspace Chief of Staff",
    description: "Google Workspace coordination, proactive memory capture, and follow-up execution across meetings, docs, and tasks.",
    extensions: ["web-research", "data-sources", "memory-core"],
    skills: [
      "google-workspace-ops",
      "proactive-memory",
      "board-ops",
      "summarize",
      "document-intelligence",
      "data-sources:source-research",
      "memory-core:memory-curator",
    ],
    recommendedRoleTypes: ["operations", "support", "worker"],
  },
  {
    id: "feishu-operator",
    name: "Feishu Operator",
    description: "Feishu/Lark enterprise document management, wiki, drive, and permissions.",
    extensions: ["feishu"],
    skills: [
      "feishu:feishu-doc",
      "feishu:feishu-drive",
      "feishu:feishu-perm",
      "feishu:feishu-wiki",
    ],
    recommendedRoleTypes: ["worker", "specialist"],
  },
  {
    id: "team-orchestrator",
    name: "Team Orchestrator (Disp8chTeam)",
    description: "Disp8chTeam-style multi-agent crew orchestration: plan approvals, lifecycle control, task dependencies, workspace isolation, inbox messaging, and synthesis.",
    extensions: ["coding"],
    skills: [
      "team-coordination",
      "team-plan-review",
      "crew-lifecycle",
      "code-dispatch",
      "experiment-loop",
      "ops-governance",
      "board-ops",
    ],
    recommendedRoleTypes: ["orchestrator", "specialist"],
  },
  {
    id: "release-qa-operator",
    name: "Release QA Operator",
    description: "Regression testing, workflow audit, and explicit ship gating for release candidates.",
    extensions: ["release-ops", "github", "diffs", "slack"],
    skills: [
      "optional:qa-release-gate",
      "optional:api-regression-runner",
      "optional:workflow-auditor",
      "release-ops:release-ops",
      "github:github-ops",
      "diffs:diff-review",
      "slack:slack-ops",
    ],
    recommendedRoleTypes: ["operations", "worker", "specialist"],
  },
  {
    id: "security-response",
    name: "Security Response",
    description: "Security review, incident coordination, observability triage, and post-incident follow-up.",
    extensions: ["diagnostics-otel", "incidents", "github", "slack"],
    skills: [
      "optional:security-review",
      "optional:postmortem-writer",
      "incident-triage",
      "diagnostics-otel:ops-observability",
      "incidents:incident-commander",
      "github:github-ops",
      "slack:slack-ops",
    ],
    recommendedRoleTypes: ["operations", "specialist"],
  },
  {
    id: "support-desk",
    name: "Support Desk",
    description: "Customer issue triage, escalation handling, SOP-driven replies, and multi-channel follow-up.",
    extensions: ["slack", "discord", "googlechat"],
    skills: [
      "optional:customer-support-triage",
      "optional:meeting-brief",
      "optional:sop-author",
      "proactive-memory",
      "slack:slack-ops",
      "discord:discord-ops",
      "googlechat:googlechat-ops",
    ],
    recommendedRoleTypes: ["support", "worker"],
  },
  {
    id: "product-research",
    name: "Product Research",
    description: "User-problem framing, source gathering, documentation upkeep, and migration planning for product teams.",
    extensions: ["web-research", "data-sources", "github"],
    skills: [
      "optional:research-librarian",
      "optional:product-planner",
      "optional:docs-maintainer",
      "optional:migration-planner",
      "web-research:web-research",
      "data-sources:source-research",
      "github:github-ops",
    ],
    recommendedRoleTypes: ["specialist", "worker"],
  },
];

function rootPath(...parts: string[]): string {
  return path.resolve(process.cwd(), ...parts);
}

function safeReadDir(dirPath: string): string[] {
  try {
    return fs.readdirSync(dirPath);
  } catch {
    return [];
  }
}

function safeReadFile(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function findBundledManifestPath(extensionDir: string): string | null {
  const manifestPath = path.join(extensionDir, "disp8ch.plugin.json");
  return fs.existsSync(manifestPath) ? manifestPath : null;
}

function parseFrontmatterListValue(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed
      .slice(1, -1)
      .split(",")
      .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ""))
      .filter(Boolean);
  }
  return [trimmed.replace(/^['"]|['"]$/g, "")].filter(Boolean);
}

function parseSkillFrontmatter(content: string): {
  body: string;
  requiredEnv: string[];
  platforms: string[];
  setupNotes: string[];
} {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    return { body: content, requiredEnv: [], platforms: [], setupNotes: [] };
  }

  const raw: Record<string, string[]> = {};
  let currentKey = "";
  for (const line of (match[1] || "").split(/\r?\n/)) {
    const keyMatch = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (keyMatch) {
      currentKey = keyMatch[1].trim().toLowerCase();
      raw[currentKey] = parseFrontmatterListValue(keyMatch[2] || "");
      continue;
    }
    const listMatch = line.match(/^\s*-\s+(.+)$/);
    if (listMatch?.[1] && currentKey) {
      raw[currentKey] = [...(raw[currentKey] ?? []), listMatch[1].trim().replace(/^['"]|['"]$/g, "")];
    }
  }

  return {
    body: content.slice(match[0].length),
    requiredEnv: [...(raw.required_env ?? []), ...(raw.requiredenv ?? []), ...(raw.env_vars ?? [])]
      .map((entry) => entry.trim())
      .filter(Boolean),
    platforms: [...(raw.platforms ?? []), ...(raw.supported_platforms ?? [])]
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
    setupNotes: [...(raw.setup_notes ?? []), ...(raw.setupnotes ?? [])]
      .map((entry) => entry.trim())
      .filter(Boolean),
  };
}

function parseSkillFile(skillPath: string): ParsedSkillFile | null {
  const rawContent = safeReadFile(skillPath).trim();
  if (!rawContent) return null;
  const frontmatter = parseSkillFrontmatter(rawContent);
  const content = frontmatter.body.trim();
  if (!content) return null;
  const lines = content.split(/\r?\n/);
  const heading = lines.find((line) => /^#\s+/.test(line))?.replace(/^#\s+/, "").trim();
  const description = lines
    .filter((line) => line.trim() && !/^#/.test(line.trim()))
    .slice(0, 2)
    .join(" ")
    .trim();
  const label = heading || path.basename(path.dirname(skillPath)).replace(/[-_]+/g, " ");
  return {
    label,
    description: description || "Reusable skill pack.",
    content,
    requiredEnv: frontmatter.requiredEnv,
    platforms: frontmatter.platforms,
    setupNotes: frontmatter.setupNotes,
  };
}

function buildSkillPromptExcerpt(content: string, maxChars: number): string {
  const lines = content.split(/\r?\n/).map((line) => line.trim());
  const excerpt: string[] = [];

  for (const line of lines) {
    if (!line) continue;
    if (/^#\s+/.test(line)) {
      excerpt.push(line.replace(/^#\s+/, "Title: "));
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      excerpt.push(`Guidance: ${line.replace(/^[-*]\s+/, "")}`);
      if (excerpt.length >= 6) break;
      continue;
    }
    if (!excerpt.some((entry) => entry.startsWith("Summary:"))) {
      excerpt.push(`Summary: ${line}`);
    }
    if (excerpt.length >= 6) break;
  }

  return excerpt.join("\n").slice(0, maxChars).trim();
}

function listSkillPathsInDir(dirPath: string): string[] {
  const out: string[] = [];
  for (const entry of safeReadDir(dirPath)) {
    const fullPath = path.join(dirPath, entry);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    const skillPath = path.join(fullPath, "SKILL.md");
    if (fs.existsSync(skillPath)) {
      out.push(skillPath);
    }
  }
  return out.sort();
}

function createSkillEntry(params: {
  skillPath: string;
  id: string;
  source: AgentSkillEntry["source"];
  extensionId?: string | null;
}): AgentSkillEntry | null {
  const parsed = parseSkillFile(params.skillPath);
  if (!parsed) return null;
  return {
    id: params.id,
    name: params.id,
    label: parsed.label,
    description: parsed.description,
    source: params.source,
    extensionId: params.extensionId ?? null,
    skillPath: params.skillPath,
    enabled: false,
    requiredEnv: parsed.requiredEnv,
    platforms: parsed.platforms,
    setupNotes: parsed.setupNotes,
  };
}

function appendSkillDirectoryEntries(params: {
  output: AgentSkillEntry[];
  rootDir: string;
  source: AgentSkillEntry["source"];
  idPrefix?: string;
  extensionId?: string | null;
}): void {
  for (const skillPath of listSkillPathsInDir(params.rootDir)) {
    const folderName = path.basename(path.dirname(skillPath));
    const entry = createSkillEntry({
      skillPath,
      id: `${params.idPrefix ?? ""}${folderName}`,
      source: params.source,
      extensionId: params.extensionId ?? null,
    });
    if (entry) params.output.push(entry);
  }
}

function humanizeSkillFolderName(raw: string): string {
  return raw
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function appendSkillInventoryDirectoryEntries(params: {
  output: AgentSkillInventoryEntry[];
  rootDir: string;
  source: AgentSkillInventoryEntry["source"];
  idPrefix?: string;
  extensionId?: string | null;
}): void {
  for (const skillPath of listSkillPathsInDir(params.rootDir)) {
    const folderName = path.basename(path.dirname(skillPath));
    params.output.push({
      id: `${params.idPrefix ?? ""}${folderName}`,
      label: humanizeSkillFolderName(folderName),
      source: params.source,
      extensionId: params.extensionId ?? null,
      skillPath,
    });
  }
}

function appendExternalSkillInventoryEntries(output: AgentSkillInventoryEntry[]): void {
  for (const pack of listExternalSkillPacks()) {
    const multiple = pack.skillDirs.length > 1;
    for (const skillDir of pack.skillDirs) {
      const skillPath = path.join(skillDir, "SKILL.md");
      if (!fs.existsSync(skillPath)) continue;
      const folderName = path.basename(skillDir);
      output.push({
        id: multiple ? `external:${pack.id}:${folderName}` : `external:${pack.id}`,
        label: humanizeSkillFolderName(folderName),
        source: "external",
        extensionId: null,
        skillPath,
      });
    }
  }
}

function collectStandaloneSkillInventoryEntries(output: AgentSkillInventoryEntry[], options?: SkillCatalogOptions): void {
  appendSkillInventoryDirectoryEntries({
    output,
    rootDir: rootPath("skills"),
    source: "core",
  });

  appendSkillInventoryDirectoryEntries({
    output,
    rootDir: rootPath("optional-skills"),
    source: "optional",
    idPrefix: "optional:",
  });

  const workspaceSkillRoot = path.join(getWorkspaceDir(options?.workspacePath || undefined), "skills");
  appendSkillInventoryDirectoryEntries({
    output,
    rootDir: workspaceSkillRoot,
    source: "workspace",
    idPrefix: "workspace:",
  });

  const agentWorkspaceRoot = String(options?.agentWorkspacePath || "").trim();
  if (agentWorkspaceRoot) {
    appendSkillInventoryDirectoryEntries({
      output,
      rootDir: path.join(getWorkspaceDir(agentWorkspaceRoot), "skills"),
      source: "agent",
      idPrefix: "agent:",
    });
  }

  appendExternalSkillInventoryEntries(output);
}

function appendExternalSkillEntries(output: AgentSkillEntry[]): void {
  for (const pack of listExternalSkillPacks()) {
    const multiple = pack.skillDirs.length > 1;
    for (const skillDir of pack.skillDirs) {
      const skillPath = path.join(skillDir, "SKILL.md");
      if (!fs.existsSync(skillPath)) continue;
      const folderName = path.basename(skillDir);
      const entry = createSkillEntry({
        skillPath,
        id: multiple ? `external:${pack.id}:${folderName}` : `external:${pack.id}`,
        source: "external",
        extensionId: null,
      });
      if (entry) output.push(entry);
    }
  }
}

function collectStandaloneSkillEntries(output: AgentSkillEntry[], options?: SkillCatalogOptions): void {
  appendSkillDirectoryEntries({
    output,
    rootDir: rootPath("skills"),
    source: "core",
  });

  appendSkillDirectoryEntries({
    output,
    rootDir: rootPath("optional-skills"),
    source: "optional",
    idPrefix: "optional:",
  });

  const workspaceSkillRoot = path.join(getWorkspaceDir(options?.workspacePath || undefined), "skills");
  appendSkillDirectoryEntries({
    output,
    rootDir: workspaceSkillRoot,
    source: "workspace",
    idPrefix: "workspace:",
  });

  const agentWorkspaceRoot = String(options?.agentWorkspacePath || "").trim();
  if (agentWorkspaceRoot) {
    appendSkillDirectoryEntries({
      output,
      rootDir: path.join(getWorkspaceDir(agentWorkspaceRoot), "skills"),
      source: "agent",
      idPrefix: "agent:",
    });
  }

  appendExternalSkillEntries(output);
}

export function listBundledExtensions(): ExtensionCatalogEntry[] {
  const extensionsRoot = rootPath("extensions");
  const out: ExtensionCatalogEntry[] = [];
  for (const entry of safeReadDir(extensionsRoot)) {
    const manifestPath = findBundledManifestPath(path.join(extensionsRoot, entry));
    if (!manifestPath) continue;
    try {
      const manifest = JSON.parse(safeReadFile(manifestPath)) as ExtensionManifest;
      const skillDirs = (manifest.skills ?? []).map((rel) => path.resolve(path.dirname(manifestPath), rel));
      const skillCount = skillDirs.reduce((count, skillDir) => count + listSkillPathsInDir(skillDir).length, 0);
      out.push({
        id: manifest.id,
        name: manifest.name,
        description: manifest.description,
        source: "bundled",
        skillCount,
        configurable: Boolean(
          manifest.configSchema &&
            typeof manifest.configSchema === "object" &&
            Object.keys(manifest.configSchema).length > 0,
        ),
        manifestPath,
        installSource: "bundled",
        sourceRef: null,
        sourceRevision: null,
        runtimePath: typeof manifest.runtime === "string" ? path.resolve(path.dirname(manifestPath), manifest.runtime) : null,
        scanStatus: null,
        scanSummary: null,
        scanFindings: null,
        scannedAt: null,
        installedAt: null,
        updatedAt: null,
      });
    } catch {
      // Ignore malformed extension manifests.
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function listInstalledExtensions(): ExtensionCatalogEntry[] {
  const bundled = listBundledExtensions();
  const bundledIds = new Set(bundled.map((entry) => entry.id));
  const external: ExtensionCatalogEntry[] = [];

  for (const install of listExternalExtensionInstalls()) {
    if (bundledIds.has(install.id)) {
      continue;
    }
    try {
      const manifest = JSON.parse(safeReadFile(install.manifestPath)) as ExtensionManifest;
      const skillDirs = (manifest.skills ?? []).map((rel) => path.resolve(path.dirname(install.manifestPath), rel));
      const skillCount = skillDirs.reduce((count, skillDir) => count + listSkillPathsInDir(skillDir).length, 0);
      external.push({
        id: manifest.id,
        name: manifest.name,
        description: manifest.description,
        source: "external",
        skillCount,
        configurable: Boolean(
          manifest.configSchema &&
            typeof manifest.configSchema === "object" &&
            Object.keys(manifest.configSchema).length > 0,
        ),
        manifestPath: install.manifestPath,
        installSource: install.installSource,
        sourceRef: install.sourceRef,
        sourceRevision: install.sourceRevision,
        runtimePath: install.runtimePath,
        scanStatus: install.scanStatus,
        scanSummary: install.scanSummary,
        scanFindings: install.scanFindings,
        scannedAt: install.scannedAt,
        installedAt: install.installedAt,
        updatedAt: install.updatedAt,
      });
    } catch {
      // Ignore malformed external manifests.
    }
  }

  return [...bundled, ...external].sort((a, b) => a.name.localeCompare(b.name));
}

export function listBundledSkillCatalog(): AgentSkillEntry[] {
  const out: AgentSkillEntry[] = [];
  collectStandaloneSkillEntries(out);
  const standaloneBundled = out.filter((entry) => entry.source !== "workspace" && entry.source !== "agent" && entry.source !== "external");

  for (const extension of listBundledExtensions()) {
    try {
      const manifest = JSON.parse(safeReadFile(extension.manifestPath)) as ExtensionManifest;
      const skillDirs = (manifest.skills ?? []).map((rel) => path.resolve(path.dirname(extension.manifestPath), rel));
      for (const skillDir of skillDirs) {
        appendSkillDirectoryEntries({
          output: standaloneBundled,
          rootDir: skillDir,
          source: "extension",
          idPrefix: `${extension.id}:`,
          extensionId: extension.id,
        });
      }
    } catch {
      // Ignore malformed extension skill packs.
    }
  }

  return standaloneBundled.sort((a, b) => a.label.localeCompare(b.label));
}

export function listInstalledSkillCatalog(options?: SkillCatalogOptions): AgentSkillEntry[] {
  const out: AgentSkillEntry[] = [];
  collectStandaloneSkillEntries(out, options);

  for (const extension of listInstalledExtensions()) {
    try {
      const manifest = JSON.parse(safeReadFile(extension.manifestPath)) as ExtensionManifest;
      const skillDirs = (manifest.skills ?? []).map((rel) => path.resolve(path.dirname(extension.manifestPath), rel));
      for (const skillDir of skillDirs) {
        appendSkillDirectoryEntries({
          output: out,
          rootDir: skillDir,
          source: "extension",
          idPrefix: `${extension.id}:`,
          extensionId: extension.id,
        });
      }
    } catch {
      // Ignore malformed extension skill packs.
    }
  }

  return out.sort((a, b) => a.label.localeCompare(b.label));
}

export function listInstalledSkillInventory(options?: SkillCatalogOptions): AgentSkillInventoryEntry[] {
  const out: AgentSkillInventoryEntry[] = [];
  collectStandaloneSkillInventoryEntries(out, options);

  for (const extension of listInstalledExtensions()) {
    try {
      const manifest = JSON.parse(safeReadFile(extension.manifestPath)) as ExtensionManifest;
      const skillDirs = (manifest.skills ?? []).map((rel) => path.resolve(path.dirname(extension.manifestPath), rel));
      for (const skillDir of skillDirs) {
        appendSkillInventoryDirectoryEntries({
          output: out,
          rootDir: skillDir,
          source: "extension",
          idPrefix: `${extension.id}:`,
          extensionId: extension.id,
        });
      }
    } catch {
      // Ignore malformed extension skill packs.
    }
  }

  return out.sort((a, b) => a.label.localeCompare(b.label));
}

export function buildAgentExtensionEntries(enabledExtensions: string[]): AgentExtensionEntry[] {
  const enabled = new Set(enabledExtensions);
  return listInstalledExtensions().map((entry) => ({
    ...entry,
    enabled: enabled.has(entry.id),
  }));
}

export function buildAgentSkillEntries(params: {
  enabledExtensions: string[];
  enabledSkills: string[];
  workspacePath?: string | null;
  agentWorkspacePath?: string | null;
}): AgentSkillEntry[] {
  const enabledExtensions = new Set(params.enabledExtensions);
  const enabledSkills = new Set(params.enabledSkills);
  return listInstalledSkillCatalog({
    workspacePath: params.workspacePath,
    agentWorkspacePath: params.agentWorkspacePath,
  }).map((entry) => ({
    ...entry,
    enabled:
      enabledSkills.has(entry.id) &&
      (entry.extensionId ? enabledExtensions.has(entry.extensionId) : true),
  }));
}

export function listBundledIntegrationPresets(): IntegrationPresetEntry[] {
  return [...INTEGRATION_PRESETS].sort((a, b) => a.name.localeCompare(b.name));
}

export function getBundledIntegrationPreset(presetIdRaw: string | null | undefined): IntegrationPresetEntry | null {
  const presetId = String(presetIdRaw || "").trim();
  if (!presetId) return null;
  return INTEGRATION_PRESETS.find((entry) => entry.id === presetId) ?? null;
}

export type ActiveSkillContextEntry = {
  id: string;
  label: string;
};

function resolveEnabledSkillContextDetails(params: {
  enabledExtensions: string[];
  enabledSkills: string[];
  workspacePath?: string | null;
  agentWorkspacePath?: string | null;
  maxChars?: number;
}): { context: string; activeSkills: ActiveSkillContextEntry[] } {
  const enabledExtensions = new Set(params.enabledExtensions);
  const enabledSkills = new Set(params.enabledSkills);
  const sections: string[] = [];
  const compactLines: Array<{ line: string; skill: ActiveSkillContextEntry }> = [];
  const activeSkills: ActiveSkillContextEntry[] = [];
  let used = 0;
  const maxChars = Math.max(1000, params.maxChars ?? 5000);
  const catalog = listInstalledSkillCatalog({
    workspacePath: params.workspacePath,
    agentWorkspacePath: params.agentWorkspacePath,
  });

  for (const skill of catalog) {
    if (!enabledSkills.has(skill.id)) continue;
    if (skill.extensionId && !enabledExtensions.has(skill.extensionId)) continue;
    const parsed = parseSkillFile(skill.skillPath);
    if (!parsed) continue;
    const body = buildSkillPromptExcerpt(parsed.content, 550);
    if (!body) continue;
    const chunk = `Skill Pack: ${parsed.label}\n${body}`;
    const entry = { id: skill.id, label: parsed.label };
    if (used + chunk.length <= maxChars) {
      sections.push(chunk);
      activeSkills.push(entry);
      used += chunk.length;
      continue;
    }
    compactLines.push({
      line: `- ${parsed.label} (${skill.id}): ${skill.description}` ,
      skill: entry,
    });
  }

  if (compactLines.length > 0) {
    let compactSection = "Additional enabled skill packs (compact catalog):\n";
    const compactActiveSkills: ActiveSkillContextEntry[] = [];
    for (const item of compactLines) {
      const next = `${compactSection}${item.line}\n`;
      if (used + next.length > maxChars) break;
      compactSection = next;
      compactActiveSkills.push(item.skill);
    }
    const trimmed = compactSection.trim();
    if (trimmed !== "Additional enabled skill packs (compact catalog):") {
      sections.push(trimmed);
      activeSkills.push(...compactActiveSkills);
    }
  }

  return { context: sections.join("\n\n").trim(), activeSkills };
}

export function resolveEnabledSkillContext(params: {
  enabledExtensions: string[];
  enabledSkills: string[];
  workspacePath?: string | null;
  agentWorkspacePath?: string | null;
  maxChars?: number;
}): string {
  return resolveEnabledSkillContextDetails(params).context;
}

export function resolveActiveEnabledSkillEntries(params: {
  enabledExtensions: string[];
  enabledSkills: string[];
  workspacePath?: string | null;
  agentWorkspacePath?: string | null;
  maxChars?: number;
}): ActiveSkillContextEntry[] {
  return resolveEnabledSkillContextDetails(params).activeSkills;
}

export function listToolSkillCatalog(): Array<{
  name: string;
  label: string;
  description: string;
  source: "built-in" | "custom";
}> {
  return Object.entries(TOOL_LABELS)
    .map(([name, meta]) => ({
      name,
      label: meta.label,
      description: meta.description,
      source: "built-in" as const,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}
