import fs from "node:fs";
import path from "node:path";
import { upsertDocumentFromFolderFile } from "@/lib/documents/store";

const DEFAULT_MAX_FILES = 500;
const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);
const SKIP_DIRS = new Set([".git", ".obsidian", "node_modules", ".next", "dist", "build"]);

export type MarkdownFolderImportResult = {
  imported: number;
  skipped: number;
  ids: string[];
  rootPath: string;
};

type FrontmatterResult = {
  body: string;
  frontmatter: Record<string, unknown>;
};

function parseFrontmatter(raw: string): FrontmatterResult {
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { body: normalized, frontmatter: {} };
  }
  const end = normalized.indexOf("\n---", 4);
  if (end <= 0) {
    return { body: normalized, frontmatter: {} };
  }
  const frontmatterRaw = normalized.slice(4, end).trim();
  const body = normalized.slice(end).replace(/^\n---\n?/, "");
  const frontmatter: Record<string, unknown> = {};
  for (const line of frontmatterRaw.split("\n")) {
    const match = line.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
    if (!match?.[1]) continue;
    const key = match[1].trim();
    const value = String(match[2] || "").trim();
    if (!key) continue;
    if (value.startsWith("[") && value.endsWith("]")) {
      frontmatter[key] = value
        .slice(1, -1)
        .split(",")
        .map((item) => item.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    } else if (value === "true" || value === "false") {
      frontmatter[key] = value === "true";
    } else if (/^-?\d+(?:\.\d+)?$/.test(value)) {
      frontmatter[key] = Number(value);
    } else {
      frontmatter[key] = value.replace(/^["']|["']$/g, "");
    }
  }
  return { body, frontmatter };
}

function extractWikiLinks(text: string): string[] {
  const links = new Set<string>();
  const pattern = /\[\[([^\]\n]+)\]\]/g;
  let match: RegExpExecArray | null = null;
  while ((match = pattern.exec(text))) {
    const value = String(match[1] || "").trim();
    if (value) links.add(value);
  }
  return Array.from(links).slice(0, 200);
}

function extractHashTags(text: string): string[] {
  const tags = new Set<string>();
  const pattern = /(^|\s)#([A-Za-z0-9_/-]{2,80})\b/g;
  let match: RegExpExecArray | null = null;
  while ((match = pattern.exec(text))) {
    const value = String(match[2] || "").trim();
    if (value) tags.add(value);
  }
  return Array.from(tags).slice(0, 200);
}

async function walkMarkdownFiles(params: {
  rootPath: string;
  recursive: boolean;
  maxFiles: number;
  glob?: RegExp;
}): Promise<{ files: string[]; skipped: number }> {
  const files: string[] = [];
  let skipped = 0;
  const queue = [params.rootPath];
  while (queue.length > 0 && files.length < params.maxFiles) {
    const current = queue.shift()!;
    let entries: fs.Dirent[] = [];
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      skipped += 1;
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) skipped += 1;
        continue;
      }
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) {
          skipped += 1;
        } else if (params.recursive) {
          queue.push(fullPath);
        }
        continue;
      }
      if (!entry.isFile()) {
        skipped += 1;
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (!MARKDOWN_EXTENSIONS.has(ext)) {
        skipped += 1;
        continue;
      }
      const rel = path.relative(params.rootPath, fullPath);
      if (params.glob && !params.glob.test(rel)) {
        skipped += 1;
        continue;
      }
      files.push(fullPath);
      if (files.length >= params.maxFiles) break;
    }
  }
  return { files, skipped };
}

export async function importMarkdownFolder(
  dirPath: string,
  opts?: { recursive?: boolean; maxFiles?: number; glob?: RegExp },
): Promise<MarkdownFolderImportResult> {
  const rootPath = path.resolve(dirPath);
  const stat = await fs.promises.stat(rootPath).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error(`Folder not found: ${dirPath}`);
  }
  const maxFiles = Math.max(1, Math.min(5000, Math.floor(opts?.maxFiles ?? DEFAULT_MAX_FILES)));
  const walked = await walkMarkdownFiles({
    rootPath,
    recursive: opts?.recursive !== false,
    maxFiles,
    glob: opts?.glob,
  });

  const ids: string[] = [];
  let skipped = walked.skipped;
  for (const filePath of walked.files) {
    try {
      const raw = await fs.promises.readFile(filePath, "utf8");
      const stat = await fs.promises.stat(filePath);
      const parsed = parseFrontmatter(raw);
      const relPath = path.relative(rootPath, filePath).replace(/\\/g, "/");
      const doc = await upsertDocumentFromFolderFile({
        name: relPath,
        sourcePath: filePath,
        extractedText: parsed.body,
        sizeBytes: stat.size,
        metadata: {
          importRoot: rootPath,
          relativePath: relPath,
          frontmatter: parsed.frontmatter,
          wikiLinks: extractWikiLinks(raw),
          tags: extractHashTags(raw),
        },
      });
      ids.push(doc.id);
    } catch {
      skipped += 1;
    }
  }

  return {
    imported: ids.length,
    skipped,
    ids,
    rootPath,
  };
}
