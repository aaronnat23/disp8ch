import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { markIdentifierObservationsDeleted, recordIdentifierObservation } from "@/lib/memory/identifier-index";
import { scanContextContent } from "@/lib/memory/context-scan";

export const WORKSPACE_PATH = process.env.WORKSPACE_PATH || "./data/workspace";

const CORE_FILES = {
  "AGENTS.md": `# AGENTS

## Session Startup
1. Read SOUL.md, USER.md, IDENTITY.md, TOOLS.md, and MEMORY.md.
   When reading MEMORY.md, only treat entries as current facts if their status is active, updated, or absent.
   Skip entries marked status=replaced or status=deleted — they have been superseded by a newer entry.
2. Use memory_search first to discover relevant memory snippets quickly.
3. Use session_recall when you need past conversation history rather than durable memory.
4. Use memory_gpt when search results are noisy or semantically close.
5. Use memory_get for exact file/line reads before quoting details.
`,
  "SOUL.md": `# SOUL

You are disp8ch AI, a local-first personal AI assistant. When users say
"disp8ch", "disp8ch AI", or "this app", they mean you. Never describe disp8ch AI as an unknown
external product: you are it, and you can inspect its live state and code with tools when asked.

Your operator surfaces: WebChat, visual Workflows, Boards, Hierarchy, Council, Automations (cron +
webhooks), Skills, Memory, Design Studio, Documents/Notebooks, Channels, and Dynamic Runs.

## Style
- Be direct and concise.
- Prefer concrete, testable answers over vague wording.
`,
  "USER.md": `# USER

## Profile
- Name: User
- Timezone: UTC

## Preferences
- Keep responses practical.
`,
  "IDENTITY.md": `# IDENTITY

## Who you are
- You are disp8ch AI, the assistant built into this app.
- "disp8ch", "disp8ch AI", and "this app/this assistant" all refer to you.

## Role
- Personal assistant for this workspace.

## Invariants
- Be accurate, practical, and explicit about uncertainty.
- When asked about disp8ch AI's own capabilities or architecture, answer from self-knowledge and live
  app/repo inspection — never claim it is an unknown external product.
- Preserve user preferences and decisions over time.
`,
  "TOOLS.md": `# TOOLS

Use tools when they improve correctness or speed.

Memory tool split:
- memory_search: fast discovery of durable memory
- session_recall: find relevant past conversations by session
- memory_gpt: model rerank over discovered candidates
- memory_get: deterministic path/line read for exact details
`,
  "HOOKS.md": `# HOOKS

Hook files live in \`hooks/\` and run on runtime events.

Supported event types include:
- \`app.startup\`
- \`workflow.start\`
- \`workflow.complete\`
- \`memory.stored\`
- \`memory.updated\`
- \`memory.deleted\`
- \`tool.call\`
- \`tool.approval_queued\`
- \`tool.approval_approved\`
- \`tool.approval_denied\`

Each hook file should export either:
- \`export default async function (event) { ... }\`
- \`export async function onEvent(event) { ... }\`
`,
  "MEMORY.md": `# MEMORY

Curated durable memory: decisions, preferences, and stable facts.

Line format convention:
- \`id=<memory_id>\`
- \`status=active|updated|replaced|deleted\`
  - active/updated = current authoritative fact
  - replaced = superseded by a newer entry for the same subject
  - deleted = removed
`,
  "HEARTBEAT.md": `# HEARTBEAT

- Check pending follow-ups.
- Keep this file short.
`,
  "BOOT.md": `# BOOT

Startup checklist:
1. Review BOOTSTRAP.md for first-run tasks (if present).
2. Read HEARTBEAT.md for pending follow-ups.
3. Load recent memory files before complex tasks.
  `,
};

export const WORKSPACE_BOOTSTRAP_FILE_NAMES = [
  "AGENTS.md",
  "SOUL.md",
  "USER.md",
  "IDENTITY.md",
  "TOOLS.md",
  "HOOKS.md",
  "MEMORY.md",
  "HEARTBEAT.md",
  "BOOT.md",
  "BOOTSTRAP.md",
] as const;

export const WORKSPACE_EDITABLE_FILE_NAMES = [
  ...WORKSPACE_BOOTSTRAP_FILE_NAMES,
  "memory.md",
] as const;

const BOOTSTRAP_TEMPLATE = `# BOOTSTRAP

First-run checklist:
1. Confirm SOUL.md and USER.md are accurate.
2. Add any durable preferences to MEMORY.md.
3. Keep daily notes under memory/YYYY-MM-DD.md.
`;

const SAMPLE_HOOK_TEMPLATE = `export default async function onEvent(event) {
  // Example hook: append your own custom logic here.
  // event = { type, ts, data }
  if (event.type === "workflow.complete") {
    // eslint-disable-next-line no-console
    console.log("[hook] workflow complete", event.data?.workflowId || "");
  }
}
`;

const SKILLS_README_TEMPLATE = `# Workspace Skills

Add one folder per reusable skill pack:

\`\`\`
skills/
  release-checklist/
    SKILL.md
\`\`\`

Each \`SKILL.md\` should define a focused workflow, checklist, or operating pattern that an agent can follow.
Workspace skills show up in the Skills registry as \`workspace:your-skill\`.
`;

export interface WorkspaceSearchResult {
  path: string;
  content: string;
  score: number;
  startLine: number;
  endLine: number;
}

export interface StartupContextBundle {
  files: Array<{ path: string; content: string }>;
}

export interface WorkspaceScope {
  workspacePath?: string;
}

export interface StartupFileHygieneReport {
  defaultWorkspaceDir: string;
  activeWorkspaceDir: string;
  usingDefaultWorkspace: boolean;
  rootStartupFilesPresent: string[];
  divergentFiles: Array<{
    file: string;
    activeExists: boolean;
    defaultExists: boolean;
    activeBytes: number;
    defaultBytes: number;
    sameContent: boolean;
  }>;
  warnings: string[];
}

function resolveScopePath(scope?: WorkspaceScope | string): string {
  if (typeof scope === "string" && scope.trim()) {
    return scope;
  }
  if (scope && typeof scope === "object" && typeof scope.workspacePath === "string" && scope.workspacePath.trim()) {
    return scope.workspacePath;
  }
  return WORKSPACE_PATH;
}

export function isForeignOsPath(p: string): boolean {
  if (typeof p !== "string" || !p) return false;
  const win = /^[A-Za-z]:[\\/]/.test(p) || p.includes("\\");
  return process.platform === "win32" ? false : win;
}

export function normalizeWorkspacePath(stored: string, agentId: string): string {
  if (!stored || isForeignOsPath(stored)) return path.join("agents", agentId);
  const normalized = path.posix.normalize(stored.replace(/\\/g, "/"));
  if (normalized === "." || normalized === "data/workspace") return "data/workspace";
  const idx = normalized.indexOf("agents/");
  return idx >= 0 ? normalized.slice(idx) : path.join("agents", agentId);
}

function getWorkspaceRootDir(): string {
  const raw = WORKSPACE_PATH;
  if (isForeignOsPath(raw)) {
    return path.resolve("data", "workspace");
  }
  return path.resolve(raw);
}

export function getWorkspaceDir(scope?: WorkspaceScope | string): string {
  const raw = resolveScopePath(scope);
  if (isForeignOsPath(raw)) {
    return getWorkspaceRootDir();
  }
  const normalizedRaw = path.posix.normalize(raw.replace(/\\/g, "/"));
  const normalizedDefault = path.posix.normalize(WORKSPACE_PATH.replace(/\\/g, "/"));
  if (!path.isAbsolute(raw) && (normalizedRaw === "data/workspace" || normalizedRaw === normalizedDefault)) {
    return getWorkspaceRootDir();
  }
  if (!path.isAbsolute(raw) && raw !== WORKSPACE_PATH) {
    return path.resolve(getWorkspaceRootDir(), raw);
  }
  return path.resolve(raw);
}

export function getWorkspaceMemoryDir(scope?: WorkspaceScope | string): string {
  return path.join(getWorkspaceDir(scope), "memory");
}

const FILE_LOCK_WAIT_MS = 1500;
const FILE_LOCK_STALE_MS = 15000;

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withAdvisoryFileLock<T>(targetPath: string, fn: () => T): T {
  const lockPath = `${targetPath}.lock`;
  const deadline = Date.now() + FILE_LOCK_WAIT_MS;
  while (true) {
    try {
      fs.mkdirSync(lockPath);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== "EEXIST") throw error;
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > FILE_LOCK_STALE_MS) {
          fs.rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for memory file lock: ${path.basename(targetPath)}`);
      }
      sleepSync(25);
    }
  }

  try {
    return fn();
  } finally {
    try {
      fs.rmSync(lockPath, { recursive: true, force: true });
    } catch {
      // non-fatal
    }
  }
}

export function ensureWorkspaceScaffold(scope?: WorkspaceScope | string): { workspaceDir: string; createdBootstrap: boolean } {
  const workspaceDir = getWorkspaceDir(scope);
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(getWorkspaceMemoryDir(scope), { recursive: true });
  const hooksDir = path.join(workspaceDir, "hooks");
  const skillsDir = path.join(workspaceDir, "skills");
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.mkdirSync(skillsDir, { recursive: true });

  const corePaths = Object.keys(CORE_FILES).map((name) => path.join(workspaceDir, name));
  const isBrandNew = corePaths.every((filePath) => !fs.existsSync(filePath));

  for (const [name, template] of Object.entries(CORE_FILES)) {
    const filePath = path.join(workspaceDir, name);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, template.trimEnd() + "\n", "utf-8");
    }
  }

  const bootstrapPath = path.join(workspaceDir, "BOOTSTRAP.md");
  let createdBootstrap = false;
  if (isBrandNew && !fs.existsSync(bootstrapPath)) {
    fs.writeFileSync(bootstrapPath, BOOTSTRAP_TEMPLATE.trimEnd() + "\n", "utf-8");
    createdBootstrap = true;
  }

  const sampleHookPath = path.join(hooksDir, "sample-hook.mjs");
  if (!fs.existsSync(sampleHookPath)) {
    fs.writeFileSync(sampleHookPath, SAMPLE_HOOK_TEMPLATE.trimEnd() + "\n", "utf-8");
  }

  const skillsReadmePath = path.join(skillsDir, "README.md");
  if (!fs.existsSync(skillsReadmePath)) {
    fs.writeFileSync(skillsReadmePath, SKILLS_README_TEMPLATE.trimEnd() + "\n", "utf-8");
  }

  return { workspaceDir, createdBootstrap };
}

function normalizeRelPath(value: string): string {
  return value.trim().replace(/^[./\\]+/, "").replace(/\\/g, "/");
}

function isDailyMemoryPath(relPath: string): boolean {
  return /^memory\/\d{4}-\d{2}-\d{2}\.md$/i.test(relPath);
}

function isAllowedMemoryPath(relPath: string): boolean {
  if (relPath === "MEMORY.md" || relPath === "memory.md") return true;
  if (isDailyMemoryPath(relPath)) return true;
  if (relPath.startsWith("memory/") && relPath.endsWith(".md")) return true;
  return false;
}

export function resolveWorkspaceMemoryReadPath(rawPath: string, scope?: WorkspaceScope | string): string | null {
  const workspaceDir = getWorkspaceDir(scope);
  const relPath = normalizeRelPath(rawPath);
  if (!relPath || !isAllowedMemoryPath(relPath)) return null;

  const absPath = path.resolve(workspaceDir, relPath);
  const normalizedRoot = workspaceDir + path.sep;
  if (absPath !== workspaceDir && !absPath.startsWith(normalizedRoot)) return null;
  return absPath;
}

function listMarkdownFiles(dir: string, output: string[]) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      listMarkdownFiles(fullPath, output);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".md")) continue;
    output.push(fullPath);
  }
}

export function listWorkspaceMemoryFiles(scope?: WorkspaceScope | string): string[] {
  const workspaceDir = getWorkspaceDir(scope);
  const result: string[] = [];
  const main = path.join(workspaceDir, "MEMORY.md");
  const alt = path.join(workspaceDir, "memory.md");
  if (fs.existsSync(main)) result.push(main);
  if (fs.existsSync(alt)) result.push(alt);

  const memoryDir = getWorkspaceMemoryDir(scope);
  if (fs.existsSync(memoryDir)) {
    listMarkdownFiles(memoryDir, result);
  }

  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const filePath of result) {
    const rel = path.relative(workspaceDir, filePath).replace(/\\/g, "/");
    if (seen.has(rel)) continue;
    seen.add(rel);
    deduped.push(filePath);
  }
  return deduped;
}

export function getDailyMemoryPath(date = new Date(), scope?: WorkspaceScope | string): string {
  const iso = date.toISOString().slice(0, 10);
  return path.join(getWorkspaceMemoryDir(scope), `${iso}.md`);
}

export function appendDailyMemoryNote(note: string, date = new Date(), scope?: WorkspaceScope | string): string {
  const safeNote = note.trim();
  if (!safeNote) return path.relative(getWorkspaceDir(scope), getDailyMemoryPath(date, scope)).replace(/\\/g, "/");

  const filePath = getDailyMemoryPath(date, scope);
  const relPath = path.relative(getWorkspaceDir(scope), filePath).replace(/\\/g, "/");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  withAdvisoryFileLock(filePath, () => {
    if (!fs.existsSync(filePath)) {
      const heading = `# ${path.basename(filePath, ".md")}\n\n`;
      fs.writeFileSync(filePath, heading, "utf-8");
    }

    const time = new Date().toISOString();
    const block = `- ${time}: ${safeNote}\n`;
    fs.appendFileSync(filePath, block, "utf-8");
  });
  return relPath;
}

interface MainMemoryMeta {
  id?: string;
  type?: string;
  source?: string;
  tags?: string[];
  status?: "active" | "updated" | "deleted";
  confidence?: number;
  agentId?: string;
}

function buildMainMemoryLine(note: string, meta?: MainMemoryMeta, stamp = new Date().toISOString()): string {
  const safeNote = note.trim();
  const id = meta?.id ? ` id=${meta.id}` : "";
  const type = meta?.type ? ` type=${meta.type}` : "";
  const source = meta?.source ? ` source=${meta.source}` : "";
  const tags = meta?.tags && meta.tags.length > 0 ? ` tags=${meta.tags.join(",")}` : "";
  const status = meta?.status ? ` status=${meta.status}` : "";
  const conf = meta?.confidence !== undefined ? ` conf=${meta.confidence.toFixed(2)}` : "";
  return `- [${stamp}]${id}${status}${type}${source}${tags}${conf} ${safeNote}`;
}

function findMainMemoryLineById(lines: string[], id: string): number {
  const needle = `id=${id}`;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] || "";
    if (line.includes(needle)) return i;
  }
  return -1;
}

// ── Identifier collision detection for workspace MEMORY.md ───────────────────
// When a new entry is stored that shares the same "subject key" as an existing
// active entry (same structure, different long identifier token), mark the older
// entries status=replaced so the agent reads the newest one as authoritative.

function extractNoteTextFromMemLine(line: string): string {
  // Line format: - [timestamp] key=val ... note text
  const withoutBullet = line.replace(/^-\s+\[[^\]]+\]/, "").trim();
  return withoutBullet.replace(/\b(?:id|status|type|source|tags|conf)=[^\s]+/g, "").trim();
}

function noteHasIdentifierToken(text: string): boolean {
  // Match uppercase tokens of 10+ chars (e.g. GATE-CHECK-NEW-1776001984000)
  return /\b[A-Z][A-Z0-9_-]{9,}\b/.test(text);
}

function noteCollisionKey(text: string): string {
  return text
    .replace(/\b[A-Z][A-Z0-9_-]{9,}\b/g, "TOKEN")
    .replace(/\b\d{8,}\b/g, "NUM")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function markLineAsReplaced(line: string): string {
  if (/\bstatus=\S+/.test(line)) {
    return line.replace(/\bstatus=\S+/, "status=replaced");
  }
  // Insert status=replaced right after the closing bracket of the timestamp
  return line.replace(/^(-\s+\[[^\]]+\])/, "$1 status=replaced");
}

export function appendMainMemoryNote(note: string, meta?: MainMemoryMeta, scope?: WorkspaceScope | string): void {
  const safeNote = note.trim();
  if (!safeNote) return;

  const workspaceDir = getWorkspaceDir(scope);
  const filePath = path.join(workspaceDir, "MEMORY.md");
  withAdvisoryFileLock(filePath, () => {
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, CORE_FILES["MEMORY.md"].trimEnd() + "\n", "utf-8");
    }

    const existing = fs.readFileSync(filePath, "utf-8");
    const lines = existing.split("\n");
    const stamp = new Date().toISOString();
    const line = buildMainMemoryLine(safeNote, meta, stamp);

    if (meta?.id) {
      const idx = findMainMemoryLineById(lines, meta.id);
      if (idx >= 0) {
        lines[idx] = line;
        fs.writeFileSync(filePath, lines.join("\n").replace(/\n?$/, "\n"), "utf-8");
        return;
      }
    } else if (existing.includes(safeNote)) {
      return;
    }

    // Collision-group detection: when a new identifier-bearing entry shares the
    // same subject structure as an existing active entry, mark the older one as
    // status=replaced so the agent treats the newest entry as authoritative.
    if (noteHasIdentifierToken(safeNote)) {
      const newKey = noteCollisionKey(safeNote);
      let collisionFound = false;
      for (let i = 0; i < lines.length; i++) {
        const existingLine = lines[i] || "";
        if (!existingLine.startsWith("- [")) continue;
        if (/\bstatus=(?:replaced|deleted)\b/.test(existingLine)) continue;
        const lineNote = extractNoteTextFromMemLine(existingLine);
        if (!noteHasIdentifierToken(lineNote)) continue;
        if (noteCollisionKey(lineNote) !== newKey) continue;
        lines[i] = markLineAsReplaced(existingLine);
        collisionFound = true;
      }
      if (collisionFound) {
        fs.writeFileSync(filePath, lines.join("\n").replace(/\n?$/, "\n"), "utf-8");
      }
    }

    const block = `\n${line}\n`;
    fs.appendFileSync(filePath, block, "utf-8");
    recordIdentifierObservation({
      agentId: meta?.agentId,
      content: safeNote,
      sourcePath: filePath,
      memoryEntryId: meta?.id ?? null,
      updatedAt: stamp,
      createdAt: stamp,
      metadata: {
        ...(meta?.id ? { memoryEntryId: meta.id } : {}),
        ...(meta?.status ? { status: meta.status } : {}),
        ...(meta?.source ? { source: meta.source } : {}),
        ...(meta?.type ? { type: meta.type } : {}),
        ...(meta?.tags ? { tags: meta.tags } : {}),
      },
    });
  });
}

export function markMainMemoryEntryDeleted(id: string, details?: string, scope?: WorkspaceScope | string): void {
  const normalizedId = id.trim();
  if (!normalizedId) return;

  const workspaceDir = getWorkspaceDir(scope);
  const filePath = path.join(workspaceDir, "MEMORY.md");
  withAdvisoryFileLock(filePath, () => {
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, CORE_FILES["MEMORY.md"].trimEnd() + "\n", "utf-8");
    }

    const existing = fs.readFileSync(filePath, "utf-8");
    const lines = existing.split("\n");
    const detailText = details?.trim() || "deleted memory entry";
    const line = buildMainMemoryLine(detailText, {
      id: normalizedId,
      type: "correction",
      status: "deleted",
      source: "memory.delete",
    });
    const idx = findMainMemoryLineById(lines, normalizedId);

    if (idx >= 0) {
      lines[idx] = line;
      fs.writeFileSync(filePath, lines.join("\n").replace(/\n?$/, "\n"), "utf-8");
      markIdentifierObservationsDeleted({
        memoryEntryId: normalizedId,
        sourcePath: filePath,
      });
      return;
    }

    fs.appendFileSync(filePath, `\n${line}\n`, "utf-8");
    markIdentifierObservationsDeleted({
      agentId: undefined,
      memoryEntryId: normalizedId,
      sourcePath: filePath,
    });
  });
}

export function pruneLearningLoopMemoryNotes(params?: {
  maxEntries?: number;
  archiveRelPath?: string;
  scope?: WorkspaceScope | string;
  pinnedFingerprints?: Set<string>;
}): { kept: number; archived: number; decayed: number; archivePath: string | null } {
  const maxEntries = Math.max(1, Math.min(200, Number(params?.maxEntries ?? 20)));
  const scope = params?.scope;
  const workspaceDir = getWorkspaceDir(scope);
  const filePath = path.join(workspaceDir, "MEMORY.md");
  if (!fs.existsSync(filePath)) {
    return { kept: 0, archived: 0, decayed: 0, archivePath: null };
  }

  return withAdvisoryFileLock(filePath, () => {
  const lines = fs.readFileSync(filePath, "utf-8").split("\n");

  // Pre-compute pinned ID set: supports both old verbose format and new short-hash format.
  const pinnedIds = new Set<string>();
  const pinned = params?.pinnedFingerprints;
  if (pinned && pinned.size > 0) {
    for (const fp of pinned) {
      pinnedIds.add(`learning:${fp}`);
      pinnedIds.add(`learning:${createHash("md5").update(fp).digest("hex").slice(0, 12)}`);
    }
  }
  const isLineIdPinned = (line: string): boolean => {
    if (pinnedIds.size === 0) return false;
    const idMatch = line.match(/\bid=(learning:[^\s]+)/);
    if (!idMatch) return false;
    return pinnedIds.has(idMatch[1]);
  };

  // ── Confidence decay pass ────────────────────────────────────────────────
  // Learning entries older than 60 days get confidence halved (floor 0.10).
  // Only entries that carry a conf= field (new format) are eligible for decay.
  const DECAY_AFTER_DAYS = 60;
  const DECAY_FACTOR = 0.5;
  const CONF_FLOOR = 0.10;
  const nowMs = Date.now();
  let decayed = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] || "";
    if (!line.includes("source=learning-loop")) continue;
    const confMatch = line.match(/\bconf=([\d.]+)/);
    if (!confMatch) continue;
    const tsMatch = line.match(/^\s*-\s+\[([^\]]+)\]/);
    if (!tsMatch) continue;
    const ts = Date.parse(tsMatch[1]);
    if (!Number.isFinite(ts)) continue;
    const ageDays = (nowMs - ts) / (1000 * 60 * 60 * 24);
    if (ageDays < DECAY_AFTER_DAYS) continue;
    const currentConf = parseFloat(confMatch[1]);
    if (!Number.isFinite(currentConf) || currentConf <= CONF_FLOOR) continue;
    const newConf = Math.max(CONF_FLOOR, currentConf * DECAY_FACTOR);
    if (Math.abs(newConf - currentConf) < 0.005) continue;
    lines[i] = line.replace(/\bconf=[\d.]+/, `conf=${newConf.toFixed(2)}`);
    decayed += 1;
  }

  // Collect learning entry indexes; identify any at or below conf floor
  const learningIndexes: number[] = [];
  const lowConfIndexes: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] || "";
    if (!line.includes("source=learning-loop")) continue;
    learningIndexes.push(i);
    const confMatch = line.match(/\bconf=([\d.]+)/);
    if (confMatch) {
      const conf = parseFloat(confMatch[1]);
      if (Number.isFinite(conf) && conf <= CONF_FLOOR) lowConfIndexes.push(i);
    }
  }

  const lowConfSet = new Set(lowConfIndexes);
  // Active entries = those not already marked for low-confidence archiving
  const activeIndexes = learningIndexes.filter((i) => !lowConfSet.has(i));
  const overCap = activeIndexes.length - maxEntries;

  // Cap-based archiving: non-pinned oldest first, then pinned if still over cap
  const capCandidates = overCap > 0 ? activeIndexes.slice(0, overCap) : [];
  const nonPinnedCap = capCandidates.filter((i) => !isLineIdPinned(lines[i] || ""));
  const pinnedCap = capCandidates.filter((i) => isLineIdPinned(lines[i] || ""));
  const toArchiveCap = [...nonPinnedCap];
  const stillOver = activeIndexes.length - toArchiveCap.length - maxEntries;
  if (stillOver > 0) {
    toArchiveCap.push(...pinnedCap.slice(0, stillOver));
  }

  // Combined archive set: low-confidence entries + cap overflow
  const archiveIndexes = new Set([...lowConfSet, ...toArchiveCap]);
  const archivedLines = Array.from(archiveIndexes)
    .sort((a, b) => a - b)
    .map((index) => lines[index])
    .filter(Boolean);
  const nextLines = lines.filter((_, index) => !archiveIndexes.has(index));

  // Always write when decay changed something or when archiving entries
  const needsWrite = decayed > 0 || archivedLines.length > 0;
  if (!needsWrite) {
    return { kept: learningIndexes.length, archived: 0, decayed: 0, archivePath: null };
  }

  fs.writeFileSync(filePath, nextLines.join("\n").replace(/\n?$/, "\n"), "utf-8");

  if (archivedLines.length === 0) {
    return { kept: learningIndexes.length, archived: 0, decayed, archivePath: null };
  }

  const archiveRelPath = normalizeRelPath(params?.archiveRelPath || "memory/learning-archive.md");
  const archivePath = path.join(workspaceDir, archiveRelPath);
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  if (!fs.existsSync(archivePath)) {
    fs.writeFileSync(
      archivePath,
      "# Learning Archive\n\nArchived learning-loop entries rotated out of MEMORY.md.\n",
      "utf-8",
    );
  }
  fs.appendFileSync(archivePath, `\n${archivedLines.join("\n")}\n`, "utf-8");

  return {
    kept: Math.max(0, learningIndexes.length - archivedLines.length),
    archived: archivedLines.length,
    decayed,
    archivePath,
  };
  });
}

export function getMainMemoryLearningNotes(scope?: WorkspaceScope | string): Array<{ id: string; note: string }> {
  const workspaceDir = getWorkspaceDir(scope);
  const filePath = path.join(workspaceDir, "MEMORY.md");
  if (!fs.existsSync(filePath)) return [];

  const lines = fs.readFileSync(filePath, "utf-8").split("\n");
  const results: Array<{ id: string; note: string }> = [];
  for (const line of lines) {
    if (!line.includes("source=learning-loop")) continue;
    const m = line.match(/^-\s+\[[^\]]+\]((?:\s+\w+=\S+)*)\s+(.*)/);
    if (!m) continue;
    const metaStr = m[1] || "";
    const note = (m[2] || "").trim();
    if (!note) continue;
    const idMatch = metaStr.match(/\bid=(learning:[^\s]+)/);
    if (!idMatch) continue;
    results.push({ id: idMatch[1], note });
  }
  return results;
}

function scoreLine(line: string, tokens: string[], phrase: string): number {
  const lower = line.toLowerCase();
  if (!lower.trim()) return 0;
  if (lower.includes("status=deleted")) return 0;
  let score = 0;
  let matchedTokens = 0;
  for (const token of tokens) {
    if (token && lower.includes(token)) {
      score += 1;
      matchedTokens += 1;
    }
  }
  if (phrase && lower.includes(phrase)) score += 8;
  if (tokens.length > 0 && matchedTokens === tokens.length) score += 4;
  return score;
}

function scoreFileRecency(relPath: string): number {
  const m = relPath.match(/memory\/(\d{4})-(\d{2})-(\d{2})\.md$/);
  if (!m) return 0;
  const date = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (!Number.isFinite(date)) return 0;
  const days = Math.max(0, (Date.now() - date) / (1000 * 60 * 60 * 24));
  return 1 / (1 + days * 0.04);
}

export function searchWorkspaceMemories(
  query: string,
  limit = 10,
  scope?: WorkspaceScope | string,
  options?: { includeDaily?: boolean },
): WorkspaceSearchResult[] {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const workspaceDir = getWorkspaceDir(scope);
  const includeDaily = options?.includeDaily ?? true;
  const files = listWorkspaceMemoryFiles(scope).filter((absPath) => {
    if (includeDaily) return true;
    const relPath = path.relative(workspaceDir, absPath).replace(/\\/g, "/");
    return !isDailyMemoryPath(relPath);
  });
  const phrase = trimmed.toLowerCase();
  const tokens = phrase.split(/\s+/).filter(Boolean);

  const scored: WorkspaceSearchResult[] = [];

  for (const absPath of files) {
    let content = "";
    try {
      content = fs.readFileSync(absPath, "utf-8");
    } catch {
      continue;
    }
    if (!content) continue;
    const relPath = path.relative(workspaceDir, absPath).replace(/\\/g, "/");
    const lines = content.split("\n");

    let bestScore = 0;
    let bestLine = -1;
    for (let i = 0; i < lines.length; i += 1) {
      const s = scoreLine(lines[i] ?? "", tokens, phrase);
      if (s > bestScore) {
        bestScore = s;
        bestLine = i;
      }
    }

    if (bestScore <= 0 && !content.toLowerCase().includes(phrase)) {
      continue;
    }

    if (bestLine < 0) {
      bestLine = 0;
      bestScore = 0.5;
    }

    const start = Math.max(0, bestLine - 2);
    const end = Math.min(lines.length - 1, bestLine + 2);
    const snippet = lines.slice(start, end + 1).join("\n").trim();
    const recency = scoreFileRecency(relPath);
    scored.push({
      path: relPath,
      content: snippet,
      score: bestScore + recency,
      startLine: start + 1,
      endLine: end + 1,
    });
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, Math.max(1, limit));
}

export function readWorkspaceMemorySlice(params: {
  relPath: string;
  from?: number;
  lines?: number;
  workspacePath?: string;
}): { path: string; text: string; from?: number; lines?: number } {
  const scope = params.workspacePath ? { workspacePath: params.workspacePath } : undefined;
  const absPath = resolveWorkspaceMemoryReadPath(params.relPath, scope);
  const relPath = normalizeRelPath(params.relPath);
  if (!absPath) {
    throw new Error("Invalid memory path. Must be MEMORY.md or a .md file under memory/.");
  }
  if (!fs.existsSync(absPath)) {
    return { path: relPath, text: "" };
  }

  const content = fs.readFileSync(absPath, "utf-8");
  const from = Number.isFinite(params.from) ? Math.max(1, Math.floor(params.from as number)) : undefined;
  const lines = Number.isFinite(params.lines) ? Math.max(1, Math.floor(params.lines as number)) : undefined;
  if (!from && !lines) {
    return { path: relPath, text: content };
  }

  const chunks = content.split("\n");
  const start = from ?? 1;
  const count = lines ?? chunks.length;
  const text = chunks.slice(start - 1, start - 1 + count).join("\n");
  return { path: relPath, text, from: start, lines: count };
}

function readFileIfExists(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

const DEFAULT_STARTUP_FILES = ["AGENTS.md", "SOUL.md", "USER.md", "IDENTITY.md", "TOOLS.md", "MEMORY.md", "BOOT.md"];
const STARTUP_HYGIENE_FILES = ["SOUL.md", "USER.md", "IDENTITY.md", "TOOLS.md", "MEMORY.md", "HEARTBEAT.md", "BOOT.md"];
const STARTUP_INCLUDE_MAX_DEPTH = 4;
const STARTUP_INCLUDE_ALLOWED_EXTENSIONS = new Set([".md", ".txt", ".json", ".yml", ".yaml"]);

function readStartupFileForHygiene(filePath: string): { exists: boolean; bytes: number; hash: string | null } {
  try {
    if (!fs.existsSync(filePath)) return { exists: false, bytes: 0, hash: null };
    const buffer = fs.readFileSync(filePath);
    return {
      exists: true,
      bytes: buffer.byteLength,
      hash: createHash("sha256").update(buffer).digest("hex"),
    };
  } catch {
    return { exists: false, bytes: 0, hash: null };
  }
}

export function getStartupFileHygieneReport(scope?: WorkspaceScope | string): StartupFileHygieneReport {
  const defaultWorkspaceDir = path.resolve("data", "workspace");
  const activeWorkspaceDir = getWorkspaceDir(scope);
  const usingDefaultWorkspace = path.resolve(activeWorkspaceDir) === defaultWorkspaceDir;
  const rootDir = path.resolve(process.cwd());
  const rootStartupFilesPresent = STARTUP_HYGIENE_FILES.filter((file) => fs.existsSync(path.join(rootDir, file)));

  const divergentFiles = STARTUP_HYGIENE_FILES.map((file) => {
    const active = readStartupFileForHygiene(path.join(activeWorkspaceDir, file));
    const canonical = readStartupFileForHygiene(path.join(defaultWorkspaceDir, file));
    return {
      file,
      activeExists: active.exists,
      defaultExists: canonical.exists,
      activeBytes: active.bytes,
      defaultBytes: canonical.bytes,
      sameContent: active.exists === canonical.exists && active.hash === canonical.hash,
    };
  }).filter((entry) => !entry.sameContent);

  const warnings: string[] = [];
  if (!usingDefaultWorkspace && divergentFiles.length > 0) {
    const priority = divergentFiles
      .filter((entry) => entry.file === "USER.md" || entry.file === "MEMORY.md")
      .map((entry) => entry.file);
    const named = priority.length > 0 ? priority.join(", ") : divergentFiles.slice(0, 4).map((entry) => entry.file).join(", ");
    warnings.push(
      `Selected workspace startup files differ from data/workspace (${named}). Confirm this workspace is meant to override the default profile memory before starting long-running agents.`,
    );
  }
  if (usingDefaultWorkspace && rootStartupFilesPresent.length > 0) {
    warnings.push(
      `Repo-root startup files are present (${rootStartupFilesPresent.join(", ")}), but data/workspace is the active profile workspace. Keep root AGENTS.md for coding-agent instructions and avoid treating root MEMORY.md/USER.md as durable app memory.`,
    );
  }

  return {
    defaultWorkspaceDir,
    activeWorkspaceDir,
    usingDefaultWorkspace,
    rootStartupFilesPresent,
    divergentFiles,
    warnings,
  };
}

function normalizeStartupFilePath(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = path.posix.normalize(trimmed.replace(/\\/g, "/").replace(/^\.\//, ""));
  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized === "..") return null;
  return normalized;
}

function parseStartupFileList(raw: string | null | undefined): string[] | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      const normalized = parsed
        .map((value) => (typeof value === "string" ? normalizeStartupFilePath(value) : null))
        .filter((value): value is string => Boolean(value));
      return normalized.length ? normalized : null;
    }
  } catch {
    // Fall back to comma/newline separated lists for older config values.
  }
  const normalized = trimmed
    .split(/[\n,]/)
    .map((value) => normalizeStartupFilePath(value))
    .filter((value): value is string => Boolean(value));
  return normalized.length ? normalized : null;
}

function extractStartupIncludeTargets(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) => {
      const match = line.match(/^@include:?\s+(.+)$/i);
      return match ? match[1].trim().replace(/^(["'])(.*)\1$/, "$2") : null;
    })
    .filter((value): value is string => Boolean(value));
}

function resolveStartupIncludeTarget(parentPath: string, target: string): string | null {
  const normalizedTarget = target.trim().replace(/\\/g, "/");
  if (!normalizedTarget || normalizedTarget.startsWith("/")) return null;
  const baseDir = path.posix.dirname(parentPath);
  return normalizeStartupFilePath(path.posix.join(baseDir, normalizedTarget));
}

function isAllowedStartupIncludePath(relPath: string): boolean {
  return STARTUP_INCLUDE_ALLOWED_EXTENSIONS.has(path.extname(relPath).toLowerCase());
}

type StartupFileConfig = {
  includeFiles: string[] | null;
  excludeFiles: string[];
};

/** Read the configured startup file include/exclude lists from memory_config (server-side only). */
function loadStartupFileConfig(): StartupFileConfig | null {
  try {
    if (typeof window !== "undefined") return null;
    // eslint-disable-next-line
    const Database = require("better-sqlite3");
    // eslint-disable-next-line
    const nodePath = require("path");
    // eslint-disable-next-line
    const nodeFs = require("fs");
    const dbPath = nodePath.resolve(process.env.DATABASE_PATH || "./data/disp8ch.db");
    if (!nodeFs.existsSync(dbPath)) return null;
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare("SELECT startup_include_files, startup_exclude_files FROM memory_config WHERE id = 'default'").get() as
      | { startup_include_files?: string | null; startup_exclude_files?: string | null }
      | undefined;
    db.close();
    return {
      includeFiles: parseStartupFileList(row?.startup_include_files),
      excludeFiles: parseStartupFileList(row?.startup_exclude_files) ?? [],
    };
  } catch {
    return null;
  }
}

function appendStartupContextFile(params: {
  workspaceDir: string;
  relPath: string;
  files: Array<{ path: string; content: string }>;
  visited: Set<string>;
  excludeSet: Set<string>;
  depth?: number;
}): void {
  const depth = params.depth ?? 0;
  const relPath = normalizeStartupFilePath(params.relPath);
  if (!relPath || params.excludeSet.has(relPath) || params.visited.has(relPath)) return;
  const absPath = path.join(params.workspaceDir, relPath);
  const content = readFileIfExists(absPath);
  if (!content) return;

  params.visited.add(relPath);
  // For MEMORY.md, inject only curated durable entries.
  // Strip replaced/deleted historical entries and test/regression-only lines so startup context
  // remains stable and does not mix durable facts with synthetic collision data.
  const isMemoryMd = relPath === "MEMORY.md" || relPath.toLowerCase().endsWith("/memory.md");
  const injectedContent = isMemoryMd
    ? content
        .split("\n")
        .filter((line) => !/\bstatus=(?:replaced|deleted)\b/.test(line))
        .filter((line) => !/\b(?:scope|lane)\s*[:=]\s*test\b/i.test(line))
        .filter((line) => !/\b(?:regression|collision test)\b/i.test(line))
        .join("\n")
    : content;
  const scan = scanContextContent(injectedContent, relPath);
  params.files.push({ path: relPath, content: scan.safe ? scan.content : scan.blocked ?? "[BLOCKED: contained potential prompt injection]" });

  if (depth >= STARTUP_INCLUDE_MAX_DEPTH) return;
  for (const target of extractStartupIncludeTargets(content)) {
    const includedPath = resolveStartupIncludeTarget(relPath, target);
    if (!includedPath || !isAllowedStartupIncludePath(includedPath) || params.excludeSet.has(includedPath)) continue;
    appendStartupContextFile({
      workspaceDir: params.workspaceDir,
      relPath: includedPath,
      files: params.files,
      visited: params.visited,
      excludeSet: params.excludeSet,
      depth: depth + 1,
    });
  }
}

export function collectStartupContext(params?: {
  includeHeartbeat?: boolean;
  workspacePath?: string;
  /** Override startup file list. null = use DB config. undefined = use all defaults. */
  includeFiles?: string[] | null;
}): StartupContextBundle {
  const scope = params?.workspacePath ? { workspacePath: params.workspacePath } : undefined;
  ensureWorkspaceScaffold(scope);
  const workspaceDir = getWorkspaceDir(scope);
  const files: Array<{ path: string; content: string }> = [];

  const startupFileConfig = loadStartupFileConfig();
  let seed: string[];
  if (params?.includeFiles !== undefined) {
    seed = params.includeFiles ?? startupFileConfig?.includeFiles ?? DEFAULT_STARTUP_FILES;
  } else {
    seed = startupFileConfig?.includeFiles ?? DEFAULT_STARTUP_FILES;
  }
  const excludeSet = new Set((startupFileConfig?.excludeFiles ?? []).map((value) => normalizeStartupFilePath(value)).filter((value): value is string => Boolean(value)));
  seed = seed
    .map((value) => normalizeStartupFilePath(value))
    .filter((value): value is string => Boolean(value))
    .filter((value) => !excludeSet.has(value));

  if (params?.includeHeartbeat && !excludeSet.has("HEARTBEAT.md") && !seed.includes("HEARTBEAT.md")) {
    seed.push("HEARTBEAT.md");
  }

  const visited = new Set<string>();
  for (const rel of seed) {
    appendStartupContextFile({
      workspaceDir,
      relPath: rel,
      files,
      visited,
      excludeSet,
    });
  }

  if (!excludeSet.has("BOOTSTRAP.md")) {
    appendStartupContextFile({
      workspaceDir,
      relPath: "BOOTSTRAP.md",
      files,
      visited,
      excludeSet,
    });
  }
  return { files };
}

export const STARTUP_CONTEXT_MAX_CHARS = 32000;

export type ContextBudgetEntry = {
  path: string;
  actualChars: number;
  allocatedChars: number;
  truncatedChars: number;
  percentSurviving: number;
};

export type ContextBudgetReport = {
  totalActual: number;
  totalAllocated: number;
  budget: number;
  overBudget: boolean;
  entries: ContextBudgetEntry[];
};

export function simulateContextBudget(bundle: StartupContextBundle, maxChars = STARTUP_CONTEXT_MAX_CHARS): ContextBudgetReport {
  let used = 0;
  const entries: ContextBudgetEntry[] = [];
  let totalActual = 0;

  for (const file of bundle.files) {
    const actual = file.content.length;
    totalActual += actual;
    const remaining = Math.max(0, maxChars - used);
    const allocated = Math.min(actual, remaining);
    used += allocated;
    entries.push({
      path: file.path,
      actualChars: actual,
      allocatedChars: allocated,
      truncatedChars: Math.max(0, actual - allocated),
      percentSurviving: actual > 0 ? Math.round((allocated / actual) * 100) : 100,
    });
  }

  return {
    totalActual,
    totalAllocated: used,
    budget: maxChars,
    overBudget: totalActual > maxChars,
    entries,
  };
}

export type StaleMemoryEntry = {
  line: string;
  lineNumber: number;
  reason: string;
  file: string;
};

/**
 * Scan MEMORY.md for stale entries: old dated notes (>30 days), references to
 * files/paths that no longer exist, deleted-status markers, and empty notes.
 */
export function detectStaleMemoryEntries(scope?: WorkspaceScope | string): StaleMemoryEntry[] {
  const workspaceDir = getWorkspaceDir(scope);
  const filePath = path.join(workspaceDir, "MEMORY.md");
  if (!fs.existsSync(filePath)) return [];

  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const stale: StaleMemoryEntry[] = [];
  const now = Date.now();
  const STALE_DAYS = 30;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith("- ")) continue;

    // Check for deleted markers
    if (/status=deleted/i.test(line)) {
      stale.push({ line: line.slice(0, 120), lineNumber: i + 1, reason: "Marked as deleted", file: "MEMORY.md" });
      continue;
    }

    // Check for old timestamps (>30 days). Skip learning-loop entries — they have
    // their own confidence decay and archive logic in pruneLearningLoopMemoryNotes.
    const isLearningEntry = line.includes("source=learning-loop");
    const tsMatch = line.match(/\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\]/);
    if (tsMatch && !isLearningEntry) {
      const ts = Date.parse(tsMatch[1]);
      if (Number.isFinite(ts)) {
        const ageDays = (now - ts) / (1000 * 60 * 60 * 24);
        if (ageDays > STALE_DAYS) {
          stale.push({
            line: line.slice(0, 120),
            lineNumber: i + 1,
            reason: `Entry is ${Math.round(ageDays)} days old`,
            file: "MEMORY.md",
          });
          continue;
        }
      }
    }

    // Check for file path references that no longer exist
    const pathRefs = line.match(/(?:data\/\S+|src\/\S+|skills\/\S+)/g);
    if (pathRefs) {
      for (const ref of pathRefs) {
        const abs = path.join(process.cwd(), ref);
        if (!fs.existsSync(abs)) {
          stale.push({
            line: line.slice(0, 120),
            lineNumber: i + 1,
            reason: `References non-existent path: ${ref}`,
            file: "MEMORY.md",
          });
          break;
        }
      }
    }

    // Check for empty note content (just metadata, no actual note text)
    const bodyMatch = line.match(/^-\s+\[[^\]]+\](?:\s+\w+=\S+)*\s*(.*)/);
    if (bodyMatch && !bodyMatch[1].trim()) {
      stale.push({ line: line.slice(0, 120), lineNumber: i + 1, reason: "Empty note content", file: "MEMORY.md" });
    }
  }

  return stale;
}

/**
 * Extract a named H2 section from AGENTS.md.
 * Returns the section body (trimmed) or null if the section doesn't exist.
 * Substitutes YYYY-MM-DD placeholders with today's date when `substituteDate` is true.
 */
export function extractAgentsSection(sectionName: string, opts: { workspaceDir?: string; substituteDate?: boolean } = {}): string | null {
  const dir = opts.workspaceDir || WORKSPACE_PATH;
  try {
    const filePath = path.join(dir, "AGENTS.md");
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, "utf-8");
    const escapedName = sectionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const headingRe = new RegExp(`^## ${escapedName}\\s*$`, "m");
    const match = headingRe.exec(content);
    if (!match) return null;
    const start = match.index + match[0].length;
    const rest = content.slice(start);
    const nextHeading = /^## /m.exec(rest);
    const body = nextHeading ? rest.slice(0, nextHeading.index) : rest;
    const trimmed = body.trim();
    if (!trimmed) return null;
    if (opts.substituteDate !== false) {
      const today = new Date().toISOString().split("T")[0];
      return trimmed.replace(/YYYY-MM-DD/g, today);
    }
    return trimmed;
  } catch {
    return null;
  }
}

export function formatStartupContextForPrompt(bundle: StartupContextBundle, maxChars = STARTUP_CONTEXT_MAX_CHARS): string {
  if (!bundle.files.length) return "";
  const sections: string[] = [];
  let used = 0;

  for (const file of bundle.files) {
    if (used >= maxChars) break;
    const remaining = Math.max(0, maxChars - used);
    const text = file.content.slice(0, remaining);
    used += text.length;
    sections.push(`[${file.path}]\n${text}`);
  }

  if (!sections.length) return "";
  return [
    "Workspace startup context (read-only reference):",
    sections.join("\n\n"),
    "End workspace startup context.",
  ].join("\n\n");
}
