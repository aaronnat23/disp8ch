import fs from "node:fs";
import path from "node:path";

export type ExtensionSecuritySeverity = "warn" | "error";
export type ExtensionSecurityStatus = "pass" | "warn" | "blocked";

export type ExtensionSecurityFinding = {
  ruleId: string;
  severity: ExtensionSecuritySeverity;
  title: string;
  summary: string;
  filePath: string;
  line: number | null;
  excerpt: string | null;
};

export type ExtensionSecurityScanReport = {
  status: ExtensionSecurityStatus;
  summary: string;
  warnings: number;
  errors: number;
  scannedFiles: number;
  scannedAt: string;
  findings: ExtensionSecurityFinding[];
};

type Rule = {
  id: string;
  severity: ExtensionSecuritySeverity;
  title: string;
  summary: string;
  appliesTo: (relativePath: string) => boolean;
  test: (content: string) => Array<{ line: number | null; excerpt: string | null }>;
};

const MAX_SCAN_FILE_BYTES = 512 * 1024;
const LARGE_FILE_WARN_BYTES = 1024 * 1024;
const TEXT_EXTENSIONS = new Set([
  ".json",
  ".md",
  ".txt",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".py",
  ".sh",
  ".ps1",
  ".yaml",
  ".yml",
]);
const SKIP_DIRS = new Set([".git", "node_modules", ".next", "dist", "coverage"]);

function isTextLike(relativePath: string): boolean {
  const base = path.basename(relativePath).toLowerCase();
  if (base === "skill.md" || base === "disp8ch.plugin.json") return true;
  return TEXT_EXTENSIONS.has(path.extname(base));
}

function makeLineMatcher(pattern: RegExp): Rule["test"] {
  return (content: string) => {
    const matches: Array<{ line: number | null; excerpt: string | null }> = [];
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (!pattern.test(lines[index])) continue;
      matches.push({
        line: index + 1,
        excerpt: lines[index].trim().slice(0, 240) || null,
      });
      if (matches.length >= 3) break;
    }
    return matches;
  };
}

function makeCombinedLineMatcher(primary: RegExp, secondary: RegExp): Rule["test"] {
  return (content: string) => {
    const matches: Array<{ line: number | null; excerpt: string | null }> = [];
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!primary.test(line) || !secondary.test(line)) continue;
      matches.push({
        line: index + 1,
        excerpt: line.trim().slice(0, 240) || null,
      });
      if (matches.length >= 3) break;
    }
    return matches;
  };
}

const RULES: Rule[] = [
  {
    id: "destructive-shell",
    severity: "error",
    title: "Destructive shell command",
    summary: "Install source contains a clearly destructive filesystem or host command.",
    appliesTo: (relativePath) => isTextLike(relativePath),
    test: makeLineMatcher(
      /\b(rm\s+-rf\s+\/(?!\w)|mkfs(?:\.\w+)?\b|shutdown\b|reboot\b|Remove-Item\b.*-Recurse\b.*-Force\b|del\s+\/[a-z]*\s+\*|format\s+[a-z]:)/i,
    ),
  },
  {
    id: "secret-exfiltration",
    severity: "error",
    title: "Possible secret exfiltration",
    summary: "Install source appears to combine outbound network calls with secret or env access.",
    appliesTo: (relativePath) => isTextLike(relativePath),
    test: makeCombinedLineMatcher(
      /\b(fetch|axios|wget|curl|http_request|https?:\/\/|discord\.com\/api|slack\.com\/api)\b/i,
      /\b(process\.env|authorization|api[_-]?key|secret|token|cookie|bearer)\b/i,
    ),
  },
  {
    id: "credential-harvest",
    severity: "warn",
    title: "Broad secret access",
    summary: "Install source reads environment variables that may include secrets.",
    appliesTo: (relativePath) => isTextLike(relativePath),
    test: makeLineMatcher(/\bprocess\.env\.[A-Z0-9_]{3,}\b/),
  },
  {
    id: "persistence-hooks",
    severity: "warn",
    title: "Persistence behavior",
    summary: "Install source appears to set up cron, startup, or system persistence.",
    appliesTo: (relativePath) => isTextLike(relativePath),
    test: makeLineMatcher(/\b(crontab\b|systemctl\s+enable\b|launchctl\b|HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run|Startup\\\\)\b/i),
  },
  {
    id: "prompt-injection",
    severity: "warn",
    title: "Prompt-injection phrasing",
    summary: "Skill or prompt content contains phrases associated with instruction override or secret extraction.",
    appliesTo: (relativePath) => /(^|\/)(skill\.md|.*\.md)$/i.test(relativePath),
    test: makeLineMatcher(/\b(ignore (all|any|previous) instructions|reveal (the )?system prompt|exfiltrate secrets|disable safety|bypass guardrails)\b/i),
  },
];

function walkFiles(rootDir: string, currentDir = rootDir): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(rootDir, fullPath));
      continue;
    }
    if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

function relativeToRoot(rootDir: string, filePath: string): string {
  return path.relative(rootDir, filePath).replace(/\\/g, "/");
}

export function scanExtensionSource(rootDir: string): ExtensionSecurityScanReport {
  const findings: ExtensionSecurityFinding[] = [];
  const files = walkFiles(rootDir);
  let scannedFiles = 0;

  for (const filePath of files) {
    const relativePath = relativeToRoot(rootDir, filePath);
    const stat = fs.statSync(filePath);
    if (stat.size > LARGE_FILE_WARN_BYTES) {
      findings.push({
        ruleId: "large-file",
        severity: "warn",
        title: "Large file in extension source",
        summary: "Large files reduce reviewability and should be checked manually.",
        filePath: relativePath,
        line: null,
        excerpt: `${Math.round(stat.size / 1024)} KB`,
      });
    }
    if (!isTextLike(relativePath) || stat.size > MAX_SCAN_FILE_BYTES) {
      continue;
    }
    const content = fs.readFileSync(filePath, "utf8");
    scannedFiles += 1;
    for (const rule of RULES) {
      if (!rule.appliesTo(relativePath)) continue;
      for (const match of rule.test(content)) {
        findings.push({
          ruleId: rule.id,
          severity: rule.severity,
          title: rule.title,
          summary: rule.summary,
          filePath: relativePath,
          line: match.line,
          excerpt: match.excerpt,
        });
      }
    }
  }

  const errors = findings.filter((finding) => finding.severity === "error").length;
  const warnings = findings.filter((finding) => finding.severity === "warn").length;
  const status: ExtensionSecurityStatus = errors > 0 ? "blocked" : warnings > 0 ? "warn" : "pass";
  const summary =
    status === "blocked"
      ? `${errors} blocking security finding(s) and ${warnings} warning(s) detected before install.`
      : status === "warn"
        ? `${warnings} warning(s) detected. Review the extension before enabling it.`
        : "No known high-signal security issues were detected in the extension source scan.";

  return {
    status,
    summary,
    warnings,
    errors,
    scannedFiles,
    scannedAt: new Date().toISOString(),
    findings,
  };
}
