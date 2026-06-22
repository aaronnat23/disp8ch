import type {
  CodeEditCommandEvidence,
  CommandEvidenceKind,
  CommandEvidenceStrength,
} from "@/lib/channels/code-edit-dossier";

let commandEvidenceCounter = 0;

function nextEvidenceId(): string {
  commandEvidenceCounter += 1;
  return `cmd_${Date.now().toString(36)}_${commandEvidenceCounter}`;
}

function normalizeText(value: string): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function changedFilePattern(file: string): RegExp {
  const normalized = file.replace(/\\/g, "/");
  const base = normalized.split("/").pop() || normalized;
  const escaped = [normalized, base]
    .filter(Boolean)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  return new RegExp(`(?:${escaped})`, "i");
}

function outputLooksFailed(text: string): boolean {
  const value = String(text || "");
  if (/\bExit code:\s*(?!0\b)\d+/i.test(value)) return true;
  return /\b(?:AssertionError|Test failed|Tests failed|FAIL|FAILED|failed assertions?|SyntaxError|TypeError|ReferenceError|UnhandledPromiseRejection|ERR_ASSERTION)\b/i.test(value) ||
    /^\s*(?:Error executing tool|Tool failed|Error:)\b/i.test(value);
}

function outputLooksSuccessful(text: string): boolean {
  const value = String(text || "");
  if (outputLooksFailed(value)) return false;
  return /\b(?:PASS|PASSED|All tests passed|tests?\s+passed|assertions?\s+passed|ok\b|success|verified|Exit code:\s*0)\b/i.test(value);
}

function hasAssertionsOrExpectedOutput(command: string, output: string): boolean {
  const text = `${command}\n${output}`;
  return /\b(?:assert|expect|expected|actual|should|equals?|toEqual|strictEqual|deepStrictEqual|throw new Error|process\.exit\s*\(|PASS|FAIL|passed|failed)\b/i.test(text);
}

function mentionsChangedFile(command: string, output: string, changedFiles: string[]): boolean {
  if (changedFiles.length === 0) return false;
  const text = `${command}\n${output}`.replace(/\\/g, "/");
  return changedFiles.some((file) => changedFilePattern(file).test(text));
}

function commandCreatesHelperFileOnly(command: string): boolean {
  const text = String(command || "");
  return /^\s*(?:cat|echo|printf|set-content|new-item|out-file)\b[\s\S]{0,260}(?:>|out-file|-path|set-content|new-item)\b/i.test(text) ||
    /\b(?:cat|echo|printf)\b[\s\S]{0,260}>\s*[^\s]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|sh)\b/i.test(text) ||
    /\b(?:Set-Content|New-Item|Out-File)\b/i.test(text);
}

function commandIsVersionCheck(command: string): boolean {
  return /^\s*(?:node|python3?|pnpm|npm|yarn|bun|deno|go|cargo|rustc|tsc|npx\s+tsc)\s+(?:-v|--version|version)\s*$/i.test(command) ||
    /\btsc\s+(?:-v|--version)\b/i.test(command);
}

function commandIsReadOnly(command: string): boolean {
  return /^\s*(?:cat|type|Get-Content|sed\s+-n|rg|grep|find|ls|dir)\b/i.test(command) &&
    !hasAssertionsOrExpectedOutput(command, "");
}

function commandIsSetupOnly(command: string): boolean {
  return /\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|add)\b/i.test(command) ||
    /\b(?:pip|uv|poetry)\s+install\b/i.test(command) ||
    /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:dev|start|serve)\b/i.test(command);
}

function classifyKind(command: string, output: string): CommandEvidenceKind {
  const text = `${command}\n${output}`;
  if (commandIsVersionCheck(command)) return "version_check";
  if (commandCreatesHelperFileOnly(command)) return "file_write_only";
  if (commandIsReadOnly(command)) return "file_read_only";
  if (commandIsSetupOnly(command)) return "setup_only";
  if (/\b(?:playwright|puppeteer|browser|chromium|page\.|locator|screenshot)\b/i.test(text)) return "browser_probe";
  if (/\b(?:curl|fetch|http(?:ie)?|Invoke-WebRequest|Invoke-RestMethod)\b/i.test(command)) {
    return "api_probe";
  }
  if (/\b(?:vitest|jest|mocha|tap|pytest|node\s+--test|go\s+test|cargo\s+test|pnpm\s+(?:run\s+)?test|npm\s+(?:run\s+)?test|yarn\s+(?:run\s+)?test)\b/i.test(command)) return "unit_test";
  if (/\b(?:tsc\s+--noEmit|pnpm\s+(?:run\s+)?typecheck|npm\s+(?:run\s+)?typecheck|yarn\s+(?:run\s+)?typecheck|mypy|pyright)\b/i.test(command)) return "typecheck";
  if (/\b(?:eslint|ruff|biome|prettier\s+--check|pnpm\s+(?:run\s+)?lint|npm\s+(?:run\s+)?lint|yarn\s+(?:run\s+)?lint)\b/i.test(command)) return "lint";
  if (/\b(?:pnpm|npm|yarn|bun|cargo|go|dotnet)\s+(?:run\s+)?build\b/i.test(command)) return "build";
  if (hasAssertionsOrExpectedOutput(command, output) && /\b(?:node|python|tsx|ts-node|deno|ruby|php|perl)\b/i.test(command)) return "behavior_probe";
  return "unknown";
}

function strengthFor(input: {
  kind: CommandEvidenceKind;
  ok: boolean;
  command: string;
  output: string;
  mentionsChangedFile: boolean;
  hasAssertionsOrExpectedOutput: boolean;
  changedFiles: string[];
}): CommandEvidenceStrength {
  if (!input.ok || outputLooksFailed(input.output)) return "none";
  if (["version_check", "file_write_only", "file_read_only", "setup_only"].includes(input.kind)) return "none";
  if (input.kind === "unknown") return outputLooksSuccessful(input.output) ? "weak" : "none";
  if (input.kind === "typecheck" || input.kind === "lint" || input.kind === "build") return "medium";
  const behaviorKind = input.kind === "behavior_probe" || input.kind === "unit_test" || input.kind === "integration_test" || input.kind === "api_probe" || input.kind === "browser_probe";
  if (input.kind === "behavior_probe" && input.hasAssertionsOrExpectedOutput && (input.mentionsChangedFile || input.changedFiles.length === 0)) return "strong";
  if (["unit_test", "integration_test", "api_probe", "browser_probe"].includes(input.kind) && input.hasAssertionsOrExpectedOutput) return "strong";
  if (behaviorKind && outputLooksSuccessful(input.output)) return "medium";
  return "weak";
}

export function classifyCodeEditCommandEvidence(input: {
  toolName: string;
  commandOrSummary: string;
  outputPreview: string;
  ok: boolean;
  changedFiles: string[];
}): CodeEditCommandEvidence {
  const command = normalizeText(input.commandOrSummary);
  const output = String(input.outputPreview || "");
  const kind = classifyKind(command, output);
  const fileMention = mentionsChangedFile(command, output, input.changedFiles);
  const assertions = hasAssertionsOrExpectedOutput(command, output);
  const helperOnly = commandCreatesHelperFileOnly(command);
  const limitations: string[] = [];
  if (kind === "version_check") limitations.push("version checks do not verify changed behavior");
  if (helperOnly) limitations.push("creating a helper file is not verification by itself");
  if (kind === "file_read_only") limitations.push("reading/searching code is not behavioral verification");
  if (kind === "setup_only") limitations.push("setup/server start commands need a follow-up check");
  if (!assertions && ["behavior_probe", "api_probe", "browser_probe"].includes(kind)) limitations.push("no explicit assertion or expected output detected");
  if (!fileMention && input.changedFiles.length > 0 && ["behavior_probe", "unit_test", "api_probe", "browser_probe"].includes(kind)) {
    limitations.push("command/output does not clearly mention a changed file");
  }
  const strength = strengthFor({
    kind,
    ok: input.ok,
    command,
    output,
    mentionsChangedFile: fileMention,
    hasAssertionsOrExpectedOutput: assertions,
    changedFiles: input.changedFiles,
  });
  return {
    id: nextEvidenceId(),
    toolName: input.toolName,
    commandOrSummary: command.slice(0, 500),
    ok: input.ok && !outputLooksFailed(output),
    kind,
    strength,
    preview: output.replace(/\s+/g, " ").trim().slice(0, 800),
    provesChangedBehavior: strength === "strong",
    mentionsChangedFile: fileMention,
    hasAssertionsOrExpectedOutput: assertions,
    createdHelperFileOnly: helperOnly,
    limitations,
  };
}

export function commandEvidenceIsSuccessfulVerification(evidence: CodeEditCommandEvidence): boolean {
  return evidence.ok && (evidence.strength === "strong" || evidence.strength === "medium");
}

export function summarizeCommandEvidence(
  evidence: CodeEditCommandEvidence[],
  options: { maxItems?: number; maxChars?: number } = {},
): string {
  const maxItems = options.maxItems ?? 8;
  const maxChars = options.maxChars ?? 1800;
  const text = evidence.slice(-maxItems).map((item) => {
    const limits = item.limitations.length ? ` | limits=${item.limitations.join("; ")}` : "";
    return `- ${item.kind}/${item.strength} ok=${item.ok} changed=${item.provesChangedBehavior}: ${item.commandOrSummary}${limits}`;
  }).join("\n") || "- none";
  return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
}
