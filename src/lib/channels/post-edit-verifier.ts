import type { UniversalEvidenceDossier } from "@/lib/channels/universal-evidence-dossier";
import {
  buildCodeEditDossierFromEvidence,
  type CodeEditDossier,
} from "@/lib/channels/code-edit-dossier";
import {
  deriveVerificationContract,
  evaluateVerificationContract,
  type VerificationContract,
} from "@/lib/channels/code-edit-verification-contract";
import { commandEvidenceIsSuccessfulVerification } from "@/lib/channels/code-edit-command-evidence";
import { assessCodeEditRisk } from "@/lib/channels/code-edit-risk-gate";

export type TraceToolResult = {
  name: string;
  ok: boolean;
  preview: string;
};

export type PostEditVerificationAnalysis = {
  isCodeEditTask: boolean;
  changedFiles: string[];
  requiredVerificationProbes: Array<{
    id: string;
    description: string;
    satisfied: boolean;
  }>;
  verificationAttempts: Array<{
    toolName: string;
    ok: boolean;
    commandOrSummary: string;
    preview: string;
    kind?: string;
    strength?: string;
  }>;
  successfulVerificationCount: number;
  failedVerificationCount: number;
  answerClaimsVerificationPass: boolean;
  answerMentionsChangedFiles: boolean;
  issues: string[];
  requiresContinuation: boolean;
  continuationInstruction: string;
  codeEditDossier?: CodeEditDossier;
  verificationContract?: VerificationContract;
};

function normalizeSlashPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^["']|["']$/g, "").trim();
}

function answerClaimsPass(answer: string): boolean {
  return /\b(?:verified|verification|tested|tests?|check(?:ed)?|validated|confirmed)\b/i.test(answer) &&
    /\b(?:pass(?:ed)?|green|success(?:ful)?|works?|ok|clean)\b/i.test(answer);
}

function answerMentionsFiles(answer: string, files: string[]): boolean {
  if (files.length === 0) return true;
  const normalizedAnswer = normalizeSlashPath(answer).toLowerCase();
  return files.every((file) => {
    const normalized = normalizeSlashPath(file).toLowerCase();
    const basename = normalized.split("/").pop() ?? normalized;
    return normalizedAnswer.includes(normalized) || normalizedAnswer.includes(basename);
  });
}

function isLikelyCodeEditTask(input: {
  message: string;
  taskHints?: Record<string, unknown>;
  safety: { readOnly: boolean; allowFileWrites: boolean };
  changedFiles: string[];
}): boolean {
  return input.taskHints?.likelyNeedsCodeEdit === true ||
    input.changedFiles.length > 0 ||
    (!input.safety.readOnly && input.safety.allowFileWrites && /\b(?:edit|change|fix|implement|write|update|modify|refactor|create)\b/i.test(input.message));
}

export function analyzePostEditTrace(input: {
  message: string;
  answer: string;
  taskHints?: Record<string, unknown>;
  safety: { readOnly: boolean; allowFileWrites: boolean; allowShell?: boolean };
  dossier: UniversalEvidenceDossier;
}): PostEditVerificationAnalysis {
  const codeEditDossier = buildCodeEditDossierFromEvidence({
    request: input.message,
    safety: {
      readOnly: input.safety.readOnly,
      allowFileWrites: input.safety.allowFileWrites,
      allowShell: input.safety.allowShell ?? true,
    },
    evidenceDossier: input.dossier,
  });
  let verificationContract = deriveVerificationContract({ request: input.message, codeEditDossier });
  verificationContract = evaluateVerificationContract({ contract: verificationContract, codeEditDossier });
  const risk = assessCodeEditRisk({
    request: input.message,
    codeEditDossier,
    contract: verificationContract,
    safety: {
      readOnly: input.safety.readOnly,
      allowFileWrites: input.safety.allowFileWrites,
      allowShell: input.safety.allowShell ?? true,
    },
  });
  codeEditDossier.risk = risk;

  const changedFiles = codeEditDossier.changedFiles;
  const isCodeEditTask = isLikelyCodeEditTask({
    message: input.message,
    taskHints: input.taskHints,
    safety: input.safety,
    changedFiles,
  });
  const verificationAttempts = codeEditDossier.commandEvidence.map((attempt) => ({
    toolName: attempt.toolName,
    ok: commandEvidenceIsSuccessfulVerification(attempt),
    commandOrSummary: attempt.commandOrSummary,
    preview: attempt.preview,
    kind: attempt.kind,
    strength: attempt.strength,
  }));
  const successfulVerificationCount = codeEditDossier.commandEvidence.filter(commandEvidenceIsSuccessfulVerification).length;
  const failedVerificationCount = codeEditDossier.commandEvidence.filter((attempt) => !commandEvidenceIsSuccessfulVerification(attempt)).length;
  const answerClaimsVerificationPass = answerClaimsPass(input.answer);
  const answerMentionsChangedFiles = answerMentionsFiles(input.answer, changedFiles);
  const requiredVerificationProbes = verificationContract.probes.map((probe) => ({
    id: probe.id,
    description: probe.description,
    satisfied: probe.satisfied,
  }));
  const issues: string[] = [];
  const missingRequired = verificationContract.probes.filter((probe) => probe.priority === "required" && !probe.satisfied);

  if (isCodeEditTask && changedFiles.length > 0 && verificationAttempts.length === 0) {
    issues.push("changed_files_without_verification_attempt");
  }
  if (isCodeEditTask && changedFiles.length > 0 && successfulVerificationCount === 0 && failedVerificationCount > 0) {
    issues.push("changed_files_with_only_failed_verification");
  }
  if (answerClaimsVerificationPass && successfulVerificationCount === 0) {
    issues.push("answer_claims_pass_without_successful_verification");
  }
  if (changedFiles.length > 0 && !answerMentionsChangedFiles) {
    issues.push("answer_omits_actual_changed_files");
  }
  for (const probe of missingRequired) {
    issues.push(`verification_missing_probe:${probe.id}`);
  }
  if (risk.shouldUseFreshVerifier) {
    issues.push("fresh_verifier_recommended");
  }

  const requiresContinuation = isCodeEditTask &&
    changedFiles.length > 0 &&
    (
      successfulVerificationCount === 0 ||
      issues.includes("answer_claims_pass_without_successful_verification") ||
      missingRequired.length > 0
    );

  const changedFileList = changedFiles.length ? changedFiles.map((file) => `- ${file}`).join("\n") : "- none recorded";
  const verificationList = verificationAttempts.length
    ? verificationAttempts.map((attempt) =>
      `- ${attempt.toolName}: ${attempt.ok ? "success" : "weak/failed"} | ${attempt.kind ?? "unknown"}/${attempt.strength ?? "unknown"} | ${attempt.commandOrSummary || attempt.preview.slice(0, 160)}`,
    ).join("\n")
    : "- none recorded";
  const probeList = verificationContract.probes.length
    ? verificationContract.probes.map((probe) => `- ${probe.satisfied ? "satisfied" : "missing"} ${probe.priority}: ${probe.description}`).join("\n")
    : "- no structural probes derived";
  const continuationInstruction = [
    "Post-edit verification gate found that the trace does not yet support a clean final answer.",
    `Issues: ${issues.join(", ") || "none"}.`,
    `Risk: ${risk.level} (${risk.reasons.join("; ") || "no risk reasons"})`,
    `Changed files recorded:\n${changedFileList}`,
    `Verification attempts recorded:\n${verificationList}`,
    `Verification contract probes:\n${probeList}`,
    "Use focused non-destructive verification now. Run commands that prove changed behavior, not just environment/version/read checks.",
    "If verification fails, inspect and fix the changed file rather than claiming success. If you cannot make it pass safely, report the failure honestly.",
    "Final answer must list every changed file and describe verification status based only on successful command output.",
  ].join("\n");

  return {
    isCodeEditTask,
    changedFiles,
    requiredVerificationProbes,
    verificationAttempts,
    successfulVerificationCount,
    failedVerificationCount,
    answerClaimsVerificationPass,
    answerMentionsChangedFiles,
    issues,
    requiresContinuation,
    continuationInstruction,
    codeEditDossier,
    verificationContract,
  };
}

export function appendPostEditVerificationAppendix(answer: string, analysis: PostEditVerificationAnalysis): string {
  if (!analysis.isCodeEditTask || analysis.changedFiles.length === 0 || analysis.issues.length === 0) return answer;
  const normalized = normalizeSlashPath(answer);
  const alreadyHasTraceSection = /\bActual changed files\b/i.test(normalized) && /\bVerification status\b/i.test(normalized);
  if (alreadyHasTraceSection && !analysis.answerClaimsVerificationPass) return answer;

  const files = analysis.changedFiles.map((file) => `- ${file}`).join("\n");
  const attempts = analysis.verificationAttempts.length
    ? analysis.verificationAttempts
        .map((attempt) => `- ${attempt.kind ?? attempt.toolName}/${attempt.strength ?? "unknown"}: ${attempt.ok ? "passed" : "weak or failed"}${attempt.commandOrSummary ? ` — ${attempt.commandOrSummary}` : ""}`)
        .join("\n")
    : "- No verification command was recorded.";
  const missing = analysis.requiredVerificationProbes.filter((probe) => !probe.satisfied);
  const status = analysis.successfulVerificationCount > 0 && missing.length === 0
    ? "Verification evidence is present, but the trace still had a reporting issue."
    : analysis.successfulVerificationCount > 0
      ? "Some verification passed, but required probes are still missing. Do not treat the edit as fully verified yet."
      : analysis.failedVerificationCount > 0
        ? "Verification was attempted but did not pass strongly enough. Do not treat the edit as fully verified yet."
        : "No successful verification was recorded. Treat the edit as unverified until a focused check passes.";

  return [
    answer.trim(),
    "### Actual changed files",
    files,
    "### Verification status",
    status,
    attempts,
    missing.length ? `Missing required probes:\n${missing.map((probe) => `- ${probe.id}: ${probe.description}`).join("\n")}` : "",
  ].filter(Boolean).join("\n");
}
