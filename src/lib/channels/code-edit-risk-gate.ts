import type { CodeEditDossier, CodeEditRiskAssessment } from "@/lib/channels/code-edit-dossier";
import type { VerificationContract } from "@/lib/channels/code-edit-verification-contract";
import { commandEvidenceIsSuccessfulVerification } from "@/lib/channels/code-edit-command-evidence";

function isDocsOnly(files: string[]): boolean {
  return files.length > 0 && files.every((file) => /\.(?:md|mdx|txt|rst)$/i.test(file) || /^docs\//i.test(file));
}

function isRuntimeRiskFile(file: string): boolean {
  return /(?:src\/lib\/channels|src\/lib\/engine|src\/app\/api|auth|security|credential|secret|webhook|router|runtime|tool|database|db)/i.test(file);
}

function requestLooksHighRisk(text: string): boolean {
  return /\b(?:bug|fix|parser|parse|validation|validate|security|secret|credential|auth|token|hmac|signature|api|endpoint|database|migration|webhook|sanitize|regex|normaliz|casing|permission)\b/i.test(text);
}

export function assessCodeEditRisk(input: {
  request: string;
  codeEditDossier: CodeEditDossier;
  contract: VerificationContract;
  safety: { readOnly: boolean; allowFileWrites: boolean; allowShell: boolean };
}): CodeEditRiskAssessment {
  const dossier = input.codeEditDossier;
  const reasons: string[] = [];
  const files = dossier.changedFiles;
  if (input.safety.readOnly || !input.safety.allowFileWrites || files.length === 0) {
    return { level: "none", reasons: input.safety.readOnly ? ["read-only task or no file mutations"] : ["no changed files"], shouldUseFreshVerifier: false };
  }

  const successful = dossier.commandEvidence.filter(commandEvidenceIsSuccessfulVerification);
  const strong = successful.filter((item) => item.strength === "strong");
  const failed = dossier.commandEvidence.filter((item) => !item.ok || item.strength === "none");
  const missingRequired = input.contract.probes.filter((probe) => probe.priority === "required" && !probe.satisfied);

  if (isDocsOnly(files)) {
    return {
      level: "low",
      reasons: ["docs/text-only changed files"],
      shouldUseFreshVerifier: false,
    };
  }

  if (files.length >= 3) reasons.push("three or more files changed");
  if (files.some(isRuntimeRiskFile)) reasons.push("shared runtime/tool/API/security surface changed");
  if (requestLooksHighRisk(input.request)) reasons.push("request shape implies runtime, parsing, validation, security, API, or bug-fix risk");
  if (dossier.edits.some((edit) => /\.(?:test|spec)\.(?:ts|tsx|js|jsx|py)$/i.test(edit.filePath))) reasons.push("tests were edited by the agent");
  if (failed.length > 0) reasons.push("one or more verification commands failed or had no verification strength");
  if (missingRequired.length > 0) reasons.push(`missing required verification probes: ${missingRequired.map((probe) => probe.id).join(", ")}`);
  if (successful.length === 0 && input.contract.probes.length > 0) reasons.push("no successful verification evidence for derived contract");
  if (successful.length > 0 && strong.length === 0 && input.contract.minimumEvidence.requiresBehaviorProbe) reasons.push("only medium verification evidence for behavior-sensitive change");

  let level: CodeEditRiskAssessment["level"] = "low";
  if (reasons.some((reason) => /missing required|failed|shared runtime|security|API|bug-fix|parsing|validation|three or more/i.test(reason))) {
    level = "high";
  } else if (reasons.length > 0 || input.contract.probes.length > 0) {
    level = "medium";
  }

  const shouldUseFreshVerifier = level === "high" && (
    missingRequired.length > 0 ||
    strong.length === 0 ||
    failed.length > 0 ||
    successful.length === 0
  );

  return {
    level,
    reasons: reasons.length ? reasons : ["single scoped runtime edit"],
    shouldUseFreshVerifier,
  };
}
