import crypto from "node:crypto";
import type { UniversalEvidenceDossier } from "@/lib/channels/universal-evidence-dossier";
import {
  classifyCodeEditCommandEvidence,
  summarizeCommandEvidence,
} from "@/lib/channels/code-edit-command-evidence";

export type CodeEditToolName = "write_file" | "edit_file";

export type CodeEditArtifact = {
  id: string;
  toolName: CodeEditToolName;
  filePath: string;
  ok: boolean;
  createdAt: string;
  argsSummary: string;
  resultPreview: string;
  beforeHash?: string;
  afterHash?: string;
  beforeBytes?: number;
  afterBytes?: number;
  changedLineCount?: number;
  oldSnippet?: string;
  newSnippet?: string;
  unifiedDiffPreview?: string;
  structuredHunks?: Array<{
    oldStart?: number;
    oldLines?: number;
    newStart?: number;
    newLines?: number;
    header?: string;
    removedPreview: string;
    addedPreview: string;
  }>;
  userModifiedDuringEdit?: boolean;
  lintSummary?: string;
  lspDiagnosticsPreview?: string;
  landed?: boolean;
  limitations: string[];
};

export type CommandEvidenceKind =
  | "behavior_probe"
  | "unit_test"
  | "integration_test"
  | "typecheck"
  | "lint"
  | "build"
  | "api_probe"
  | "browser_probe"
  | "version_check"
  | "file_write_only"
  | "file_read_only"
  | "setup_only"
  | "unknown";

export type CommandEvidenceStrength = "strong" | "medium" | "weak" | "none";

export type CodeEditCommandEvidence = {
  id: string;
  toolName: string;
  commandOrSummary: string;
  ok: boolean;
  kind: CommandEvidenceKind;
  strength: CommandEvidenceStrength;
  exitCode?: number;
  preview: string;
  provesChangedBehavior: boolean;
  mentionsChangedFile: boolean;
  hasAssertionsOrExpectedOutput: boolean;
  createdHelperFileOnly: boolean;
  limitations: string[];
};

export type CodeEditRiskLevel = "none" | "low" | "medium" | "high";

export type CodeEditRiskAssessment = {
  level: CodeEditRiskLevel;
  reasons: string[];
  shouldUseFreshVerifier: boolean;
};

export type CodeEditDossier = {
  request: string;
  safety: {
    readOnly: boolean;
    allowFileWrites: boolean;
    allowShell: boolean;
  };
  edits: CodeEditArtifact[];
  commandEvidence: CodeEditCommandEvidence[];
  changedFiles: string[];
  risk: CodeEditRiskAssessment;
  unknowns: string[];
};

const MUTATION_TOOLS = new Set(["write_file", "edit_file"]);
const COMMAND_TOOLS = new Set(["bash_exec", "run_python", "run_python_script"]);

let editCounter = 0;

function nextEditId(): string {
  editCounter += 1;
  return `edit_${Date.now().toString(36)}_${editCounter}`;
}

function sanitize(text: string): string {
  return String(text || "")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[redacted]")
    .replace(/\bAIza[0-9A-Za-z_-]{12,}\b/g, "[redacted]")
    .replace(/\bghp_[A-Za-z0-9]{16,}\b/g, "[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]{16,}\b/gi, "Bearer [redacted]");
}

function clip(text: string, max: number): string {
  const normalized = sanitize(String(text || "").replace(/\s+/g, " ").trim());
  return normalized.length > max ? `${normalized.slice(0, max)}...` : normalized;
}

function normalizeSlashPath(value: string): string {
  return String(value || "").replace(/\\/g, "/").replace(/^["']|["']$/g, "").trim();
}

function parseArgsSummary(summary: string): Record<string, unknown> | null {
  const text = String(summary || "").trim();
  if (!text.startsWith("{")) return null;
  try {
    return JSON.parse(text.replace(/…$/, ""));
  } catch {
    return null;
  }
}

function extractPathFromText(text: string): string | null {
  const normalized = normalizeSlashPath(text);
  const absolute = normalized.match(/\b[A-Za-z]:\/[^\s"'<>]+\.[A-Za-z0-9]+\b/);
  if (absolute?.[0]) return absolute[0];
  const relative = normalized.match(/\b(?:src|app|server|scripts|lib|components|docs|data|test|tests|__tests__)\/[^\s"'<>]+\.[A-Za-z0-9]+\b/);
  return relative?.[0] ?? null;
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values.map(normalizeSlashPath).filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

function commandOrSummary(item: UniversalEvidenceDossier["items"][number]): string {
  const parsed = parseArgsSummary(item.queryOrArgsSummary);
  const command = typeof parsed?.command === "string"
    ? parsed.command
    : typeof parsed?.code === "string"
      ? parsed.code
      : item.queryOrArgsSummary;
  return String(command || "").replace(/\s+/g, " ").trim().slice(0, 800);
}

function shortHash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function parseEditResultJson(preview: string): Record<string, unknown> | null {
  const text = String(preview || "");
  const tagged = text.match(/<edit_result_json>\s*({[\s\S]*?})\s*<\/edit_result_json>/i);
  const inline = text.match(/Edit result:\s*({[\s\S]*?})(?:\s|$)/i);
  const candidate = tagged?.[1] ?? inline?.[1];
  if (!candidate) return null;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function artifactFromItem(item: UniversalEvidenceDossier["items"][number]): CodeEditArtifact | null {
  if (!MUTATION_TOOLS.has(item.toolName)) return null;
  const parsedArgs = parseArgsSummary(item.queryOrArgsSummary);
  const parsedResult = parseEditResultJson(item.rawPreview);
  const pathFromArgs = typeof parsedArgs?.path === "string" ? parsedArgs.path : null;
  const pathFromResult = typeof parsedResult?.filePath === "string" ? parsedResult.filePath : null;
  const pathFromItem = item.filePath ?? null;
  const pathFromPreview = extractPathFromText(item.rawPreview);
  const filePath = pathFromResult || pathFromArgs || pathFromItem || pathFromPreview;
  if (!filePath) return null;
  const contentArg = typeof parsedArgs?.content === "string" ? parsedArgs.content : "";
  const searchArg = typeof parsedArgs?.search === "string" ? parsedArgs.search : "";
  const replaceArg = typeof parsedArgs?.replace === "string" ? parsedArgs.replace : "";
  const limitations: string[] = [];
  if (!parsedResult) limitations.push("structured edit metadata was not present in tool output");
  if (!item.ok) limitations.push("edit tool reported failure");
  const afterHash = typeof parsedResult?.afterHash === "string"
    ? parsedResult.afterHash
    : contentArg
      ? shortHash(contentArg)
      : undefined;
  return {
    id: nextEditId(),
    toolName: item.toolName as CodeEditToolName,
    filePath: normalizeSlashPath(filePath),
    ok: item.ok,
    createdAt: item.retrievedAt,
    argsSummary: item.queryOrArgsSummary,
    resultPreview: clip(item.rawPreview, 900),
    beforeHash: typeof parsedResult?.beforeHash === "string" ? parsedResult.beforeHash : undefined,
    afterHash,
    beforeBytes: typeof parsedResult?.beforeBytes === "number" ? parsedResult.beforeBytes : undefined,
    afterBytes: typeof parsedResult?.afterBytes === "number" ? parsedResult.afterBytes : undefined,
    changedLineCount: typeof parsedResult?.changedLineCount === "number"
      ? parsedResult.changedLineCount
      : searchArg || replaceArg
        ? Math.max(searchArg.split(/\r?\n/).length, replaceArg.split(/\r?\n/).length)
        : undefined,
    oldSnippet: searchArg ? clip(searchArg, 500) : undefined,
    newSnippet: replaceArg || contentArg ? clip(replaceArg || contentArg, 500) : undefined,
    unifiedDiffPreview: typeof parsedResult?.unifiedDiffPreview === "string" ? clip(parsedResult.unifiedDiffPreview, 1200) : undefined,
    lintSummary: typeof parsedResult?.lintSummary === "string" ? clip(parsedResult.lintSummary, 400) : undefined,
    lspDiagnosticsPreview: typeof parsedResult?.lspDiagnosticsPreview === "string" ? clip(parsedResult.lspDiagnosticsPreview, 600) : undefined,
    landed: typeof parsedResult?.landed === "boolean" ? parsedResult.landed : item.ok,
    limitations,
  };
}

function initialRisk(): CodeEditRiskAssessment {
  return { level: "none", reasons: [], shouldUseFreshVerifier: false };
}

export function createCodeEditDossier(input: {
  request: string;
  safety: { readOnly: boolean; allowFileWrites: boolean; allowShell: boolean };
}): CodeEditDossier {
  return {
    request: String(input.request || "").slice(0, 8000),
    safety: input.safety,
    edits: [],
    commandEvidence: [],
    changedFiles: [],
    risk: initialRisk(),
    unknowns: [],
  };
}

export function buildCodeEditDossierFromEvidence(input: {
  request: string;
  safety: { readOnly: boolean; allowFileWrites: boolean; allowShell: boolean };
  evidenceDossier: UniversalEvidenceDossier;
}): CodeEditDossier {
  const dossier = createCodeEditDossier({ request: input.request, safety: input.safety });
  dossier.edits = input.evidenceDossier.items
    .map(artifactFromItem)
    .filter((item): item is CodeEditArtifact => Boolean(item));
  dossier.changedFiles = uniqueSorted(dossier.edits.filter((edit) => edit.ok).map((edit) => edit.filePath));
  dossier.commandEvidence = input.evidenceDossier.items
    .filter((item) => COMMAND_TOOLS.has(item.toolName))
    .map((item) => classifyCodeEditCommandEvidence({
      toolName: item.toolName,
      commandOrSummary: commandOrSummary(item),
      outputPreview: item.rawPreview,
      ok: item.ok,
      changedFiles: dossier.changedFiles,
    }));
  if (dossier.edits.some((edit) => edit.limitations.length > 0)) {
    dossier.unknowns.push("some edit tools did not return full structured metadata");
  }
  return dossier;
}

export function summarizeCodeEditDossierForPrompt(
  dossier: CodeEditDossier,
  options: { maxChars?: number; includeCommandPreviews?: boolean } = {},
): string {
  const maxChars = options.maxChars ?? 3000;
  const edits = dossier.edits.slice(-12).map((edit) => {
    const parts = [
      `- ${edit.filePath} ok=${edit.ok} tool=${edit.toolName}`,
      edit.changedLineCount != null ? `changedLines~${edit.changedLineCount}` : "",
      edit.beforeHash ? `before=${edit.beforeHash}` : "",
      edit.afterHash ? `after=${edit.afterHash}` : "",
      edit.landed === false ? "landed=false" : "",
      edit.limitations.length ? `limits=${edit.limitations.join("; ")}` : "",
    ].filter(Boolean);
    return parts.join(" | ");
  }).join("\n") || "- none";
  const commands = summarizeCommandEvidence(dossier.commandEvidence, { maxItems: 8, maxChars: 1500 });
  const text = [
    `Changed files (${dossier.changedFiles.length}): ${dossier.changedFiles.join(", ") || "none"}`,
    `Edits:\n${edits}`,
    `Command evidence:\n${commands}`,
    dossier.unknowns.length ? `Unknowns:\n- ${dossier.unknowns.join("\n- ")}` : "",
  ].filter(Boolean).join("\n\n");
  return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
}

export function clipForVerifier(text: string, maxChars: number): string {
  return clip(text, maxChars);
}
