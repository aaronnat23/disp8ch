import type { ModelLedLane } from "@/lib/channels/model-led-context";

export type PromptSkill = {
  category: string;
  name: string;
  description: string;
  requiresTools: string[];
  source: "builtin" | "bundled" | "optional" | "agent-local" | "extension" | "workspace" | "external";
};

const MAX_SKILLS = 32;
const DESC_LIMIT = 220;

function hasAnyTool(availableTools: Set<string>, tools: string[]): boolean {
  return tools.length === 0 || tools.some((tool) => availableTools.has(tool));
}

function builtInPromptSkills(lane: ModelLedLane): PromptSkill[] {
  const skills: PromptSkill[] = [
    {
      category: "research",
      name: "web-research",
      description:
        "Multi-source web research with citation discipline. Search first, fetch sources, cite only verified URLs, label limited evidence.",
      requiresTools: ["web_search", "web_extract"],
      source: "builtin",
    },
    {
      category: "repo",
      name: "repo-inspection",
      description:
        "Map/search/read files before claiming behavior. Cite real file paths with line numbers.",
      requiresTools: ["read_file", "search_files"],
      source: "builtin",
    },
    {
      category: "workflows",
      name: "workflow-design",
      description:
        "Design disp8ch AI visual workflows using the real node registry. Include trigger, nodes, data flow, risks, tests.",
      requiresTools: ["workflow_templates"],
      source: "builtin",
    },
    {
      category: "memory",
      name: "memory-recall",
      description:
        "Search past sessions and stored facts. Use for user preferences, recurring patterns, and prior context.",
      requiresTools: ["memory_search", "memory_get", "session_recall"],
      source: "builtin",
    },
  ];

  if (lane === "broad_research") {
    return skills.filter((skill) => skill.category === "research" || skill.category === "memory");
  }
  if (lane === "repo_inspection") {
    return skills.filter(
      (skill) => skill.category === "repo" || skill.category === "research" || skill.category === "memory",
    );
  }
  if (lane === "app_design" || lane === "app_mutation_proposal") {
    return skills.filter(
      (skill) => skill.category === "workflows" || skill.category === "repo" || skill.category === "memory",
    );
  }
  if (lane === "memory_recall") return skills.filter((skill) => skill.category === "memory");
  return [];
}

type Frontmatter = { name?: string; description?: string; requires_tools?: string[]; category?: string };

function parseFrontmatter(raw: string): { fm: Frontmatter; body: string } {
  if (!raw.startsWith("---")) return { fm: {}, body: raw };
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return { fm: {}, body: raw };
  const block = raw.slice(3, end).trim();
  const body = raw.slice(end + 4).replace(/^\s*\n/, "");
  const fm: Frontmatter = {};
  for (const line of block.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const valueRaw = m[2].trim().replace(/^['"]|['"]$/g, "");
    if (key === "name") fm.name = valueRaw;
    else if (key === "description") fm.description = valueRaw;
    else if (key === "category") fm.category = valueRaw;
    else if (key === "requires_tools") {
      const arr = valueRaw.match(/\[(.*)\]/)?.[1] ?? valueRaw;
      fm.requires_tools = arr
        .split(",")
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
        .filter(Boolean);
    }
  }
  return { fm, body };
}

function descriptionFromBody(body: string): string {
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("#")) continue;
    if (line.startsWith("- ") || line.startsWith("* ") || line.startsWith("1.")) continue;
    return line.slice(0, DESC_LIMIT);
  }
  return "";
}

function nameFromDir(dir: string): string {
  return dir.split(/[\\/]/).filter(Boolean).pop() ?? dir;
}

type ScanSpec = {
  rootPath: string;
  source: PromptSkill["source"];
  defaultCategory: string;
  maxDepth?: number;
};

function scanSkillTree(spec: ScanSpec): PromptSkill[] {
  try {
    if (typeof window !== "undefined") return [];
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");

    const root = path.resolve(spec.rootPath);
    if (!fs.existsSync(root)) return [];

    const results: PromptSkill[] = [];
    const maxDepth = spec.maxDepth ?? 5;
    const maxResults = 40;

    function walk(dir: string, depth: number): void {
      if (depth > maxDepth || results.length >= maxResults) return;
      let entries: import("node:fs").Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (results.length >= maxResults) return;
        if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".disp8ch.install.json") continue;
        const entryPath = path.join(dir, entry.name);
        if (entry.isFile() && entry.name === "SKILL.md") {
          try {
            const raw = fs.readFileSync(entryPath, "utf8");
            const { fm, body } = parseFrontmatter(raw);
            const skillDirName = nameFromDir(path.dirname(entryPath));
            const name = (fm.name && fm.name.trim()) || skillDirName;
            const description =
              (fm.description && fm.description.trim()) || descriptionFromBody(body) || `${name} skill`;
            const requiresTools = fm.requires_tools ?? [];
            const category = (fm.category && fm.category.trim()) || spec.defaultCategory;
            results.push({
              category,
              name,
              description: description.slice(0, DESC_LIMIT),
              requiresTools,
              source: spec.source,
            });
          } catch {
            // skip unreadable skill file
          }
          continue;
        }
        if (entry.isDirectory()) walk(entryPath, depth + 1);
      }
    }

    walk(root, 0);
    return results;
  } catch {
    return [];
  }
}

function bundledPromptSkills(): PromptSkill[] {
  return scanSkillTree({ rootPath: "skills", source: "bundled", defaultCategory: "bundled" });
}

function optionalPromptSkills(): PromptSkill[] {
  // Optional skills only appear when the operator has explicitly opted in via
  // data/skills-optional-enabled.json. If absent, optional skills stay hidden so
  // the prompt index doesn't bloat with dozens of unused entries.
  try {
    if (typeof window !== "undefined") return [];
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const optInPath = path.resolve("data", "skills-optional-enabled.json");
    if (!fs.existsSync(optInPath)) return [];
    const raw = fs.readFileSync(optInPath, "utf8");
    const enabled: string[] = JSON.parse(raw)?.enabled ?? [];
    if (!Array.isArray(enabled) || enabled.length === 0) return [];
    const all = scanSkillTree({ rootPath: "optional-skills", source: "optional", defaultCategory: "optional" });
    const wanted = new Set(enabled.map((s) => String(s).trim()));
    return all.filter((skill) => wanted.has(skill.name));
  } catch {
    return [];
  }
}

function agentLocalPromptSkills(agentId: string): PromptSkill[] {
  const safeAgent = agentId.replace(/[^A-Za-z0-9_-]/g, "");
  if (!safeAgent) return [];
  return scanSkillTree({
    rootPath: `agents/${safeAgent}/skills`,
    source: "agent-local",
    defaultCategory: "agent",
  });
}

function extensionPromptSkills(): PromptSkill[] {
  try {
    if (typeof window !== "undefined") return [];
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const root = path.resolve("extensions");
    if (!fs.existsSync(root)) return [];
    const results: PromptSkill[] = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillsDir = path.join(root, entry.name, "skills");
      if (!fs.existsSync(skillsDir)) continue;
      for (const found of scanSkillTree({
        rootPath: skillsDir,
        source: "extension",
        defaultCategory: entry.name,
      })) {
        results.push(found);
        if (results.length >= 24) return results;
      }
    }
    return results;
  } catch {
    return [];
  }
}

function workspacePromptSkills(): PromptSkill[] {
  return scanSkillTree({
    rootPath: "data/workspace/skills",
    source: "workspace",
    defaultCategory: "workspace",
  });
}

function externalPackPromptSkills(): PromptSkill[] {
  return scanSkillTree({
    rootPath: "data/skills-external",
    source: "external",
    defaultCategory: "external",
  });
}

export function listSkillsForPrompt(input: {
  agentId: string;
  lane: ModelLedLane;
  availableTools: Set<string>;
}): PromptSkill[] {
  const all: PromptSkill[] = [
    ...builtInPromptSkills(input.lane),
    ...bundledPromptSkills(),
    ...optionalPromptSkills(),
    ...agentLocalPromptSkills(input.agentId),
    ...extensionPromptSkills(),
    ...workspacePromptSkills(),
    ...externalPackPromptSkills(),
  ];

  const seen = new Set<string>();
  return all
    .filter((skill) => hasAnyTool(input.availableTools, skill.requiresTools))
    .filter((skill) => {
      const key = `${skill.category}:${skill.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_SKILLS);
}

export function listSkillsForPromptWithTelemetry(input: {
  agentId: string;
  lane: ModelLedLane;
  availableTools: Set<string>;
  sessionId?: string | null;
  triggerText?: string | null;
}): PromptSkill[] {
  const skills = listSkillsForPrompt(input);
  if (skills.length > 0) {
    try {
      const { recordLoadedPromptSkills } = require("@/lib/skills/usage-ledger") as typeof import("@/lib/skills/usage-ledger");
      recordLoadedPromptSkills({
        skills,
        sessionId: input.sessionId ?? null,
        agentId: input.agentId,
        triggerText: input.triggerText ?? null,
        lane: input.lane,
      });
    } catch {
      // Skill telemetry must never block prompt construction.
    }
  }
  return skills;
}
