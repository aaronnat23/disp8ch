import fs from "node:fs";
import { getWorkspaceDir } from "@/lib/workspace/files";

// Whole-message-anchored: fires only when the ENTIRE message is a list-files
// command. Any extra clause ("…and check disk space", "…also search the web",
// "compare to…") means the message no longer matches the anchored pattern,
// so the route falls through to the tool lane (which now always has read-only
// tools available — GAP-1).
//
// Anchored form (^…$). Covers the full listing vocabulary:
// "list files", "list the files", "show me files", "show me the files",
// "show the files", "what files are there", "what files are in the workspace",
// "list folders", "list directories", "show me the directory structure",
// "show the workspace structure", "display the repo structure",
// "what's in the root", "list the top-level files", "show the project structure",
// "list the repo structure", etc.
// A read-only/speed preamble ("Without changing anything, quickly ...") must
// not knock a trivial listing into the agentic loop.
const LIST_PREAMBLE = String.raw`(?:without\s+(?:changing|modifying|touching)\s+anything[,.]?\s*)?(?:please\s+|quickly\s+|just\s+|briefly\s+)*`;
const PURE_LIST = new RegExp(
  String.raw`^\s*` + LIST_PREAMBLE +
    String.raw`(list|show(?: me)?|what(?:'s| is| are)?|display|print)\s+(the\s+|all\s+)?(top[.-\s]?level\s+)?(files?|folders?|director(?:y|ies)|(?:workspace|directory|project|agent\s+workspace)\s+structur(?:e|es)|workspace\s+contents?)(\s+(in|at|of)\s+(the\s+|my\s+|this\s+|our\s+)?(agent\s+workspace|workspace|repo(?:sitory)?(?:\s+root)?|repo\s+root|repository|root|project(?:'s\s+)?root))?\s*\??\s*$`,
  "i",
);

// "list/show what sits|lives|is in|at the repo root / this workspace"
const PURE_LIST_ALT = new RegExp(
  String.raw`^\s*` + LIST_PREAMBLE +
    String.raw`(?:list|show(?: me)?|tell\s+me)\s+what(?:'s|\s+is|\s+sits|\s+lives)?\s*(?:in|at)\s+(?:the\s+|my\s+|this\s+|our\s+)?(?:agent\s+workspace|workspace|repo(?:sitory)?(?:\s+root)?|repo\s+root|repository|root|project(?:'s\s+)?root)\s*\.?\s*\??\s*$`,
  "i",
);

// When the prompt also asks to *interpret* the listing (explain/why each
// matters/purpose), bail so the route falls through to the repo-inspection
// lane, which can produce a real per-file explanation instead of a bare list.
const ANALYSIS_VERB = /\b(latency|optimi[sz]e|improve|bottleneck|review|analyz|advice|steps?|fix|debug|why|how|explain|describe|purpose|important|matters?|summari[sz]e|what\s+(?:each|every))\b/i;

// Multi-step indicators: if the message has additional clauses beyond the
// list command, bail so the full prompt reaches the tool lane.
const MULTI_STEP_INDICATOR = /\b(?:and|also|then|separately|additionally|plus|compare\s+(?:that|it|this)|in\s+addition|as\s+well|not\s+only)\b/i;

const TOP_LEVEL_EXPLANATION = /\b(?:use\s+(?:the\s+)?(?:available\s+)?tools?\s+to\s+)?(?:list|show|display|print)\b[\s\S]{0,80}\b(?:top[.-\s]?level|root|main|important)\b[\s\S]{0,80}\b(?:files?|folders?|director(?:y|ies)|workspace|repo|repository)\b[\s\S]{0,120}\b(?:explain|describe|tell\s+me|what\s+each|why|purpose|important|matters?|for)\b/i;

export function isWorkspaceReadRequest(message: string): boolean {
  if (TOP_LEVEL_EXPLANATION.test(message)) return true;
  if (ANALYSIS_VERB.test(message)) return false;
  return PURE_LIST.test(message) || PURE_LIST_ALT.test(message);
}

const EXCLUDED_DIRS = new Set(["node_modules", ".next", ".git", "tmp", "test-results", "data", ".pnpm"]);

function entryPurpose(name: string, isDir: boolean): string {
  const normalized = name.replace(/\/$/, "");
  const purposes: Record<string, string> = {
    src: "main Next.js application source: operator UI, API routes, channel routing, agent logic, and shared libraries.",
    scripts: "regression, benchmark, smoke-test, setup, and diagnostic scripts.",
    docs: "implementation plans, comparison artifacts, screenshots, and engineering notes.",
    agents: "agent profile and workspace files used by the local assistant runtime.",
    server: "standalone runtime services, including local WebSocket/server support.",
    extensions: "bundled extension/provider definitions.",
    skills: "local skill definitions available to the app and agents.",
    "optional-skills": "skill packs that are present but not necessarily part of the default startup path.",
    public: "static assets served by the Next.js app.",
    desktop: "Electron/desktop wrapper source and packaging support.",
    "package.json": "project metadata, npm scripts, and dependency declarations.",
    "pnpm-lock.yaml": "pinned pnpm dependency graph for repeatable installs.",
    "package-lock.json": "npm lockfile retained for npm-based installs or compatibility.",
    "next.config.mjs": "Next.js runtime and build configuration.",
    "tsconfig.json": "TypeScript compiler configuration.",
    "tailwind.config.ts": "Tailwind design tokens and content scanning configuration.",
    "drizzle.config.ts": "database schema/migration tooling configuration.",
    "README.md": "top-level project orientation and setup notes.",
    "CORE_ARCHITECTURE_EXPLANATION.md": "repo-specific architecture overview.",
    "AGENTS.md": "agent startup instructions and local operating rules.",
    "CLAUDE.md": "current Claude/Codex project progress, patterns, and validation ledger.",
  };
  return purposes[normalized] ?? (isDir
    ? "project directory; inspect it before making behavior-level claims."
    : "project file; read it before using its contents as evidence.");
}

function formatTopLevelExplanation(targetDir: string, entries: Array<{ name: string; isDir: boolean }>): string {
  const importantDirs = ["src", "scripts", "docs", "agents", "server", "extensions", "skills", "optional-skills", "public", "desktop"]
    .map((name) => entries.find((entry) => entry.isDir && entry.name === name))
    .filter((entry): entry is { name: string; isDir: boolean } => Boolean(entry));
  const importantFiles = [
    "package.json",
    "README.md",
    "CLAUDE.md",
    "AGENTS.md",
    "CORE_ARCHITECTURE_EXPLANATION.md",
    "next.config.mjs",
    "tsconfig.json",
    "tailwind.config.ts",
    "drizzle.config.ts",
    "pnpm-lock.yaml",
    "package-lock.json",
  ]
    .map((name) => entries.find((entry) => !entry.isDir && entry.name === name))
    .filter((entry): entry is { name: string; isDir: boolean } => Boolean(entry));
  const highlighted = new Set([...importantDirs, ...importantFiles].map((entry) => entry.name));
  const otherEntries = entries
    .filter((entry) => !highlighted.has(entry.name))
    .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name))
    .slice(0, 24);

  return [
    `Workspace root (read-only inspection): ${targetDir}`,
    "",
    "Important folders:",
    ...(importantDirs.length
      ? importantDirs.map((entry) => `- \`${entry.name}/\`: ${entryPurpose(entry.name, true)}`)
      : ["- No common source folders were found at the root."]),
    "",
    "Important files:",
    ...(importantFiles.length
      ? importantFiles.map((entry) => `- \`${entry.name}\`: ${entryPurpose(entry.name, false)}`)
      : ["- No common root config files were found."]),
    "",
    "Other visible root entries:",
    ...(otherEntries.length
      ? otherEntries.map((entry) => `- \`${entry.name}${entry.isDir ? "/" : ""}\`: ${entryPurpose(entry.name, entry.isDir)}`)
      : ["- No additional visible root entries were found within the bounded listing."]),
    "",
    "Evidence limits:",
    "- This fast path reads the root directory names only and uses known project conventions for one-sentence purposes.",
    "- Ask for a targeted repo inspection when you need file-level behavioral evidence or exact line references.",
    "",
    "This is a read-only listing and explanation. No files were modified.",
  ].join("\n");
}

/** Bounded, deterministic enrichment for a fast workspace listing. */
function buildWorkspaceReadDetail(targetDir: string, dirs: string[], files: string[]): string {
  const sections: string[] = [];

  // Canonical files/dirs present, each with a one-line purpose.
  const canonicalNames = [
    "src", "scripts", "docs", "server", "extensions", "skills", "desktop",
    "package.json", "README.md", "CLAUDE.md", "AGENTS.md", "next.config.mjs", "tsconfig.json",
  ];
  const present = canonicalNames
    .map((name) => {
      const isDir = dirs.includes(name + "/");
      const isFile = files.includes(name);
      if (!isDir && !isFile) return null;
      return `- \`${name}${isDir ? "/" : ""}\`: ${entryPurpose(name, isDir)}`;
    })
    .filter((x): x is string => Boolean(x));
  if (present.length) sections.push("\n\nKey entries:\n" + present.join("\n"));

  // package.json: name, key npm scripts, dependency counts (read-only).
  try {
    const pkgRaw = fs.readFileSync(`${targetDir}/package.json`, "utf8");
    const pkg = JSON.parse(pkgRaw) as { name?: string; scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const scriptNames = Object.keys(pkg.scripts ?? {});
    const keyScripts = ["dev", "build", "start", "test", "lint"].filter((s) => scriptNames.includes(s));
    const lines = [
      `\n\npackage.json:`,
      pkg.name ? `- name: ${pkg.name}` : null,
      scriptNames.length ? `- npm scripts (${scriptNames.length}): ${(keyScripts.length ? keyScripts : scriptNames.slice(0, 8)).join(", ")}${scriptNames.length > 8 && !keyScripts.length ? ", …" : ""}` : null,
      `- dependencies: ${Object.keys(pkg.dependencies ?? {}).length} runtime, ${Object.keys(pkg.devDependencies ?? {}).length} dev`,
    ].filter((x): x is string => Boolean(x));
    if (lines.length > 1) sections.push(lines.join("\n"));
  } catch { /* no/invalid package.json — skip */ }

  // src/ top-level subdirectories (where the real code lives).
  if (dirs.includes("src/")) {
    try {
      const subdirs = fs.readdirSync(`${targetDir}/src`, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => e.name + "/")
        .slice(0, 14);
      if (subdirs.length) sections.push(`\n\nsrc/ layout: ${subdirs.join(", ")}`);
    } catch { /* skip */ }
  }

  // scripts/ count (test/benchmark surface).
  if (dirs.includes("scripts/")) {
    try {
      const scriptFiles = fs.readdirSync(`${targetDir}/scripts`).filter((n) => /\.(ts|mjs|js|ps1|sh)$/.test(n));
      if (scriptFiles.length) sections.push(`\n\nscripts/: ${scriptFiles.length} scripts (regression, smoke, benchmark, setup).`);
    } catch { /* skip */ }
  }

  return sections.join("");
}

export function resolveWorkspaceReadResponse(params: {
  message: string;
  workspacePath?: string | null;
}): string | null {
  const { message, workspacePath } = params;
  if (!isWorkspaceReadRequest(message)) return null;

  const cwd = process.cwd();

  try {
    const targetDir = /\bagent\s+workspace\b/i.test(message)
      ? getWorkspaceDir({ workspacePath: workspacePath ?? "agents/main" })
      : cwd;
    // Read all root entries (one cheap readdir) so canonical dirs that sort late
    // alphabetically (src/, scripts/, server/) are never cut off by a pre-filter slice.
    const entries = fs.readdirSync(targetDir, { withFileTypes: true });
    if (TOP_LEVEL_EXPLANATION.test(message)) {
      return formatTopLevelExplanation(
        targetDir,
        entries
          .filter((entry) => !entry.name.startsWith("."))
          .filter((entry) => !EXCLUDED_DIRS.has(entry.name))
          .map((entry) => ({ name: entry.name, isDir: entry.isDirectory() })),
      );
    }
    const files: string[] = [];
    const dirs: string[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".env.local") continue;
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      if (entry.isDirectory()) dirs.push(entry.name + "/");
      else files.push(entry.name);
    }

    const dirList = dirs.length > 0 ? `\nDirectories: ${dirs.join(", ")}` : "";
    const shownFiles = files.slice(0, 30);
    const fileList = files.length > 0
      ? `\nFiles: ${shownFiles.join(", ")}${files.length > shownFiles.length ? `, …(+${files.length - shownFiles.length} more)` : ""}`
      : "";
    const total = dirs.length + files.length;
    // A bare listing is often too thin. Add a deterministic, bounded "what
    // matters here" section using only visible names and parsed package metadata.
    const detail = buildWorkspaceReadDetail(targetDir, dirs, files);

    return `Workspace root (read-only inspection): ${targetDir}\n${total} entries${dirList}${fileList}${detail}\n\nThis is a read-only listing. No files were modified.`;
  } catch (err) {
    return `Could not read workspace at ${cwd}: ${err instanceof Error ? err.message : String(err)}`;
  }
}
