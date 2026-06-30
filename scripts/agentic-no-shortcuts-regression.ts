#!/usr/bin/env tsx

import fs from "node:fs";
import path from "node:path";

const ROOTS = ["src", "server", "desktop", "extensions", "skills", "optional-skills"];
const TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".cmd",
  ".css",
  ".html",
  ".js",
  ".jsx",
  ".mjs",
  ".ps1",
  ".sh",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);
const SKIP_DIRECTORIES = new Set([".git", ".next", "dist", "node_modules", "out"]);

type Finding = {
  file: string;
  line: number;
  rule: string;
  excerpt: string;
};

function joinedPattern(parts: string[]): string {
  return parts.join("");
}

const prohibitedProductPatterns = [
  joinedPattern(["her", "mes", "(?:[-_ ]agent)?"]),
  joinedPattern(["paper", "clip"]),
  joinedPattern(["open", "[-_ ]?", "cl", "aw"]),
  joinedPattern(["open", "[-_ ]?", "design"]),
  joinedPattern(["open", "[-_ ]?", "notebook"]),
  joinedPattern(["open", "[-_ ]?", "agent", "[-_ ]?", "loop"]),
];
const cannedFallbackPatterns = [
  joinedPattern(["Safest Next 5 Steps", " For WebChat Latency"]),
  joinedPattern(["Why A Shallow Web-Research", " Answer Can Pass"]),
  joinedPattern(["Minimal Hollow Answer", " That Used To Look Acceptable"]),
  joinedPattern(["Toast", "\\s*\\/\\s*", "UI Plan"]),
  joinedPattern(["deterministic deep-audit", " fallback"]),
];
const prohibitedFallbackFunctions = [
  joinedPattern(["infer", "FallbackTopic"]),
  joinedPattern(["build", "TopicSpecificSections"]),
  joinedPattern(["buildToolHeavy", "AuditAnswer"]),
  joinedPattern(["buildToolHeavy", "SynthesisAnswer"]),
  joinedPattern(["buildToolHeavy", "CapabilityAnswer"]),
];

const rules: Array<{ name: string; pattern: RegExp }> = [
  {
    name: "competitor-specific runtime name",
    pattern: new RegExp(`\\b(?:${prohibitedProductPatterns.join("|")})\\b`, "i"),
  },
  {
    name: "private benchmark case identifier",
    pattern: /\b(?:H5|H6|H8|H9|H11|H13|H14|H16|H17|S7|S9|S15)\b|VR-[A-Z0-9-]+|benchmark-scenario/,
  },
  {
    name: "known canned benchmark fallback",
    pattern: new RegExp(cannedFallbackPatterns.join("|"), "i"),
  },
  {
    name: "topic-specific fallback generator",
    pattern: new RegExp(`\\b(?:${prohibitedFallbackFunctions.join("|")})\\b`),
  },
  {
    name: "private comparison harness wired into runtime",
    pattern: new RegExp(joinedPattern(["scripts\\/", "run-reference-", "comparison\\.mjs"])),
  },
];

function walk(directory: string, files: string[]): void {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, files);
    } else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(fullPath);
    }
  }
}

const files: string[] = [];
for (const root of ROOTS) walk(path.resolve(root), files);

const findings: Finding[] = [];
for (const file of files) {
  const relative = path.relative(process.cwd(), file).replace(/\\/g, "/");
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const rule of rules) {
      rule.pattern.lastIndex = 0;
      if (rule.pattern.test(line)) {
        findings.push({
          file: relative,
          line: index + 1,
          rule: rule.name,
          excerpt: line.trim().slice(0, 180),
        });
      }
    }
  });
}

const deepAuditSource = fs.readFileSync(
  path.resolve("src/lib/channels/deep-audit-synthesizer.ts"),
  "utf8",
);
const routeSource = fs.readFileSync(path.resolve("src/app/api/channels/route.ts"), "utf8");

const requiredBoundaries = [
  {
    ok: deepAuditSource.includes("does not invent a case-specific diagnosis, fix, or test plan"),
    message: "deep-audit fallback must state its non-inference boundary",
  },
  {
    ok: routeSource.includes("no topology or node plan is being fabricated"),
    message: "workflow fallback must refuse to fabricate a topology",
  },
  {
    ok: routeSource.includes("cannot provide a grounded answer from a canned fallback"),
    message: "broad synthesis fallback must fail honestly when model synthesis is unavailable",
  },
  {
    ok: fs
      .readFileSync(path.resolve("src/lib/channels/tool-heavy-evidence-controller.ts"), "utf8")
      .includes("does not fabricate a decision, architecture, capability verdict, implementation plan, or test result"),
    message: "tool-heavy fallback must expose an evidence-only recovery boundary",
  },
];

for (const boundary of requiredBoundaries) {
  if (!boundary.ok) {
    findings.push({
      file: "runtime-boundary",
      line: 0,
      rule: "missing anti-shortcut boundary",
      excerpt: boundary.message,
    });
  }
}

if (findings.length > 0) {
  console.error("\nAgentic no-shortcuts regression failed:\n");
  for (const finding of findings) {
    console.error(
      `- ${finding.file}${finding.line ? `:${finding.line}` : ""} [${finding.rule}] ${finding.excerpt}`,
    );
  }
  process.exit(1);
}

console.log(
  `agentic-no-shortcuts-regression: scanned ${files.length} shipped runtime files; no competitor-shaped or canned benchmark logic found`,
);
