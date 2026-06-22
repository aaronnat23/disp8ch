import fs from "node:fs";
import path from "node:path";

// Source-neutral skill catalog for browse + preview inside the Skills tab.
//
// Starts with bundled (`skills/`) and optional (`optional-skills/`) packs — the
// trusted, local sources. Discovery returns normalized metadata; preview returns
// the full instructions, file list, and requested tools WITHOUT executing any
// skill content. Remote hub adapters can be added later behind the same shape.

export type SkillCatalogSource = "bundled" | "optional";

export interface SkillCatalogEntry {
  name: string;
  title: string;
  description: string;
  source: SkillCatalogSource;
  category: string;
  fileCount: number;
}

export interface SkillSecurityFinding {
  level: "warning" | "info";
  message: string;
}

export interface SkillCatalogPreview extends SkillCatalogEntry {
  instructions: string;
  files: Array<{ name: string; bytes: number }>;
  requestedTools: string[];
  securityFindings: SkillSecurityFinding[];
}

const SOURCE_DIRS: Array<{ dir: string; source: SkillCatalogSource }> = [
  { dir: "skills", source: "bundled" },
  { dir: "optional-skills", source: "optional" },
];

function readSkillMd(dirPath: string): string | null {
  const candidate = path.join(dirPath, "SKILL.md");
  if (fs.existsSync(candidate)) {
    try {
      return fs.readFileSync(candidate, "utf-8");
    } catch {
      return null;
    }
  }
  return null;
}

function parseFrontmatter(md: string): { meta: Record<string, string>; body: string } {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: md };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.+)$/);
    if (kv) meta[kv[1].toLowerCase()] = kv[2].trim();
  }
  return { meta, body: m[2] };
}

function deriveTitleDescription(body: string, fallbackName: string): { title: string; description: string } {
  const heading = body.match(/^#\s+(.+)$/m);
  const title = heading ? heading[1].trim() : fallbackName;
  // First non-empty paragraph after the heading.
  const afterHeading = heading ? body.slice(body.indexOf(heading[0]) + heading[0].length) : body;
  const para = afterHeading.split(/\n\s*\n/).map((s) => s.trim()).find((s) => s && !s.startsWith("#"));
  return { title, description: (para || "").replace(/\s+/g, " ").slice(0, 280) };
}

function listFiles(dirPath: string): Array<{ name: string; bytes: number }> {
  const out: Array<{ name: string; bytes: number }> = [];
  const walk = (dir: string, prefix: string) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (out.length < 100) walk(path.join(dir, entry.name), rel);
      } else if (entry.isFile()) {
        let bytes = 0;
        try {
          bytes = fs.statSync(path.join(dir, entry.name)).size;
        } catch {
          /* ignore */
        }
        out.push({ name: rel, bytes });
      }
    }
  };
  walk(dirPath, "");
  return out.slice(0, 100);
}

function extractRequestedTools(meta: Record<string, string>): string[] {
  const raw = meta["allowed-tools"] || meta["allowed_tools"] || meta["tools"] || "";
  return raw
    .split(/[,\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

function scanSecurity(body: string): SkillSecurityFinding[] {
  const findings: SkillSecurityFinding[] = [];
  if (/\b(rm\s+-rf|sudo|curl\s+[^|]*\|\s*(ba)?sh|eval\s*\()/i.test(body)) {
    findings.push({ level: "warning", message: "References potentially destructive or pipe-to-shell commands." });
  }
  if (/https?:\/\//.test(body)) {
    findings.push({ level: "info", message: "References external network URLs." });
  }
  return findings;
}

export function listSkillCatalog(options: { query?: string; source?: SkillCatalogSource } = {}): SkillCatalogEntry[] {
  const q = (options.query || "").trim().toLowerCase();
  const entries: SkillCatalogEntry[] = [];
  for (const { dir, source } of SOURCE_DIRS) {
    if (options.source && options.source !== source) continue;
    const root = path.resolve(process.cwd(), dir);
    if (!fs.existsSync(root)) continue;
    let names: fs.Dirent[] = [];
    try {
      names = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of names) {
      if (!entry.isDirectory()) continue;
      const dirPath = path.join(root, entry.name);
      const md = readSkillMd(dirPath);
      if (!md) continue;
      const { meta, body } = parseFrontmatter(md);
      const { title, description } = deriveTitleDescription(body, entry.name);
      const category = meta["category"] || (source === "optional" ? "optional" : "core");
      const item: SkillCatalogEntry = {
        name: entry.name,
        title,
        description,
        source,
        category,
        fileCount: listFiles(dirPath).length,
      };
      if (q) {
        const hay = `${item.name} ${item.title} ${item.description} ${category}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }
      entries.push(item);
    }
  }
  return entries.sort((a, b) => a.title.localeCompare(b.title));
}

export function getSkillCatalogPreview(name: string, requestedSource?: SkillCatalogSource): SkillCatalogPreview | null {
  const safe = path.basename(String(name || "")); // no traversal
  if (!safe) return null;
  for (const { dir, source } of SOURCE_DIRS) {
    if (requestedSource && source !== requestedSource) continue;
    const dirPath = path.resolve(process.cwd(), dir, safe);
    const md = readSkillMd(dirPath);
    if (!md) continue;
    const { meta, body } = parseFrontmatter(md);
    const { title, description } = deriveTitleDescription(body, safe);
    const files = listFiles(dirPath);
    return {
      name: safe,
      title,
      description,
      source,
      category: meta["category"] || (source === "optional" ? "optional" : "core"),
      fileCount: files.length,
      instructions: body.slice(0, 4000),
      files,
      requestedTools: extractRequestedTools(meta),
      securityFindings: scanSecurity(body),
    };
  }
  return null;
}
