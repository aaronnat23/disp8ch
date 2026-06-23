/**
 * Repo-grounded read-only inspection lane.
 * Detects analysis/inspection intent and provides a cached repo map so the
 * fallback assistant can answer codebase questions with real file:line findings.
 */

const REPO_INSPECT = /\b(inspect\b|analyz|review|audit|bottleneck|latency|files?\s+to\s+touch|where\s+(is|are)|how\s+does\s+this\s+(app|repo|code)|grounded|in\s+this\s+(repo|app|codebase))\b/i;

// "List the files ... then explain what each is for", "show the main files and
// tell me why each matters" — a listing request that also wants per-entry
// explanation. The bare workspace-read handler cannot explain; route here.
const EXPLAIN_FILES = /\b(explain|describe|why|what|tell\s+me|summari[sz]e)\b[\s\S]{0,60}\b(files?|folders?|director|workspace|repo|codebase|each|important|matters?)\b/i;

export function isRootWorkspaceExplanationRequest(message: string): boolean {
  return /\b(?:top[.-\s]?level|root|main|important)\b[\s\S]{0,80}\b(?:files?|folders?|director(?:y|ies)|workspace|repo|repository)\b/i.test(message) &&
    /\b(?:explain|describe|tell\s+me|why|what\s+each|matters?|for)\b/i.test(message);
}

export function isRepoInspectRequest(message: string): boolean {
  if (
    /\b(?:bakery|camping|toddler|board\s+game|robots|kitchen|poem|diet|running\s+plan|career\s+change|fantasy\s+football|kids?|school|story|bicycle|groceries)\b/i.test(message) &&
    /\b(?:don'?t|do\s+not|without)\s+(?:create|change|touch|modify).*\b(?:this\s+app|app|repo|codebase)\b/i.test(message)
  ) {
    return false;
  }
  return REPO_INSPECT.test(message) || EXPLAIN_FILES.test(message) || isRootWorkspaceExplanationRequest(message);
}

let cachedRepoMap: { text: string; ts: number } | null = null;
const REPO_MAP_TTL = 60_000;

export function buildRepoMap(): string {
  const now = Date.now();
  if (cachedRepoMap && now - cachedRepoMap.ts < REPO_MAP_TTL) return cachedRepoMap.text;

  try {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const cwd = process.cwd();
    const parts: string[] = [];

    const root = fs.readdirSync(cwd, { withFileTypes: true }).slice(0, 40);
    const rootFiles = root.filter((e) => e.isFile() && !e.name.startsWith(".")).map((e) => e.name);
    const rootDirs = root
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !["node_modules", ".next", ".git", "data", "tmp"].includes(e.name))
      .map((e) => `${e.name}/`);
    parts.push(`Repo root: dirs=[${rootDirs.slice(0, 10).join(", ")}] files=[${rootFiles.slice(0, 8).join(", ")}]`);

    if (fs.existsSync(path.join(cwd, "src", "app"))) {
      const appDirs = fs
        .readdirSync(path.join(cwd, "src", "app"), { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith("("))
        .map((e) => e.name);
      parts.push(`src/app: ${appDirs.slice(0, 12).join(", ")}`);
    }

    if (fs.existsSync(path.join(cwd, "src", "components"))) {
      const compDirs = fs
        .readdirSync(path.join(cwd, "src", "components"), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
      parts.push(`src/components/: ${compDirs.slice(0, 12).join(", ")}`);
    }

    if (fs.existsSync(path.join(cwd, "src", "app", "(operator)", "chat"))) {
      const chatAppFiles = fs
        .readdirSync(path.join(cwd, "src", "app", "(operator)", "chat"), { withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => `src/app/(operator)/chat/${e.name}`);
      const chatComponentDir = path.join(cwd, "src", "components", "chat");
      const chatComponentFiles = fs.existsSync(chatComponentDir)
        ? fs
            .readdirSync(chatComponentDir, { withFileTypes: true })
            .filter((e) => e.isFile())
            .map((e) => `src/components/chat/${e.name}`)
        : [];
      parts.push(`Chat files: ${[...chatAppFiles, ...chatComponentFiles].slice(0, 16).join(", ") || "none discovered"}`);
    }

    if (fs.existsSync(path.join(cwd, "src", "lib"))) {
      const libDirs = fs
        .readdirSync(path.join(cwd, "src", "lib"), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
      parts.push(`src/lib/: ${libDirs.slice(0, 12).join(", ")}`);
    }

    parts.push("Config: package.json, tsconfig.json, next.config.mjs, tailwind.config.ts, globals.css");

    const text = parts.join("\n");
    cachedRepoMap = { text, ts: now };
    return text;
  } catch {
    return "Repo map unavailable";
  }
}
