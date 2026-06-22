import type { DeepAuditProfile, DeepAuditSection } from "@/lib/channels/deep-audit-profile";

export type DeepAuditIssue =
  | "missing_pipeline_or_trace"
  | "missing_failure_gates"
  | "missing_evidence_table"
  | "missing_repro_or_hollow_example"
  | "missing_fix_contract"
  | "missing_regression_tests"
  | "unsupported_audit_claim"
  | "off_target_repo_inspection"
  | "too_generic"
  | "overlong_without_extra_evidence";

export type DeepAuditContractResult = {
  ok: boolean;
  issues: DeepAuditIssue[];
  missingSections: DeepAuditSection[];
  repairInstruction: string;
};

function hasPipelineTrace(answer: string): boolean {
  return /(?:pipeline|call\s+chain|flow|trace|entry\s+point|route\S*\s*→|path:.*line)/i.test(answer) &&
    /\b(?:src|app|lib)\//i.test(answer) &&
    answer.length > 400;
}

function hasNamedGates(answer: string): boolean {
  const gateMentions = (answer.match(/\b(?:gate|check|contract|threshold|guard|fails?\s+(?:if|when)|pass(?:es)?\s+(?:if|when))/gi) ?? []).length;
  const specificGate = /(?:evaluateBroadAnswerContract|verifyClaimsAgainstEvidence|hasNoInspectionRequest|answer-quality-gate|deep-answer-contract|evidence-contract|output-shape-contract)/i.test(answer);
  return gateMentions >= 2 || specificGate;
}

function hasConcreteFix(answer: string): boolean {
  return /\b(?:add|change|set|increase|lower|require|enforce|check|validate)\b.*\b(?:contract|field|threshold|limit|gate|rule)\b/i.test(answer) ||
    /\b(?:proposed|suggested|recommended)\s+(?:contract|fix|change)\b/i.test(answer);
}

function hasEvidenceTable(answer: string): boolean {
  return /^\|.+\|.+$/m.test(answer) || /\b(?:verified|source|file|url).*\b(?:table|list|items?)/i.test(answer);
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

function pathPattern(path: string): string {
  return normalizePath(path).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pathWasRead(path: string, filesRead: string[]): boolean {
  const normalized = normalizePath(path);
  return filesRead.some((file) => {
    const read = normalizePath(file);
    return normalized === read || normalized.includes(read) || read.includes(normalized);
  });
}

function hasExactLineCitationForPath(answer: string, path: string): boolean {
  return new RegExp(`${pathPattern(path)}:\\d+(?:[-–]\\d+)?\\b`).test(answer);
}

function hasApproximateLineReference(answer: string): boolean {
  return /\b(?:line|lines|around|approx(?:imately)?|near|about)\s*[~]?\s*\d+\b/i.test(answer) ||
    /\b(?:line|lines)\s*[~]\s*\d+\b/i.test(answer);
}

function hasBehaviorClaimNearPath(answer: string, path: string): boolean {
  const match = new RegExp(`[^\\n.]{0,220}${pathPattern(path)}[^\\n.]{0,260}`, "i").exec(answer);
  const context = match?.[0] ?? "";
  return /\b(?:handles|reads|writes|checks|validates|routes?|implements|processes|returns|classifies|defines|creates|calls|collects|enforces|guards)\b/i.test(context);
}

function hasApproximateCitationNearPath(answer: string, path: string): boolean {
  const match = new RegExp(`[^\\n.]{0,220}${pathPattern(path)}[^\\n.]{0,260}`, "i").exec(answer);
  return Boolean(match?.[0] && hasApproximateLineReference(match[0]));
}

function extractFunctionMentions(answer: string): string[] {
  const names = new Set<string>();
  for (const match of answer.matchAll(/\b([a-z][A-Za-z0-9_$]{3,}|[A-Z][A-Za-z0-9_$]{3,})\(\)/g)) {
    const name = match[1];
    if (/^(?:if|for|while|switch|catch|function|return)$/.test(name)) continue;
    if (/[A-Z]/.test(name) || /(?:Evidence|Contract|Audit|Inspection|Route|Synthesis|Provider|Transport|Tool|Model|Response)/.test(name)) {
      names.add(name);
    }
  }
  return Array.from(names);
}

function functionMentionHasNearbyCitation(answer: string, functionName: string): boolean {
  const escaped = functionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const context = answer.split(/\r?\n/).find((line) => new RegExp(`${escaped}\\(\\)`, "i").test(line)) ?? "";
  return /\b(?:src|app|lib|scripts|docs)\/[A-Za-z0-9._/-]+\.(?:ts|tsx|js|jsx|mjs|cjs|md):\d+(?:[-–]\d+)?\b/.test(context);
}

export function evaluateDeepAuditContract(
  profile: DeepAuditProfile,
  answer: string,
  filesRead: string[],
  userMessage?: string,
): DeepAuditContractResult {
  const issues: DeepAuditIssue[] = [];
  const missingSections: DeepAuditSection[] = [];

  if (answer.length < 400) {
    issues.push("too_generic");
  }

  if (profile.requiredSections.includes("pipeline_or_trace") && !hasPipelineTrace(answer)) {
    issues.push("missing_pipeline_or_trace");
    missingSections.push("pipeline_or_trace");
  }

  if (profile.requiredSections.includes("failure_gates") && !hasNamedGates(answer)) {
    issues.push("missing_failure_gates");
    missingSections.push("failure_gates");
  }

  if (profile.requiredSections.includes("fix_contract") && !hasConcreteFix(answer)) {
    issues.push("missing_fix_contract");
    missingSections.push("fix_contract");
  }

  if (profile.requiredSections.includes("evidence_table") && !hasEvidenceTable(answer)) {
    issues.push("missing_evidence_table");
    missingSections.push("evidence_table");
  }

  if (profile.requiredSections.includes("hollow_example") && !/\b(?:hollow|example|minimal|would\s+pass|fool)\b/i.test(answer)) {
    issues.push("missing_repro_or_hollow_example");
    missingSections.push("hollow_example");
  }

  if (profile.requiredSections.includes("regression_tests") && answer.length > 500 &&
    (answer.match(/\b(?:regression|test\s+case|should\s+test|verify|assert)\b/gi) ?? []).length < 2) {
    issues.push("missing_regression_tests");
    missingSections.push("regression_tests");
  }

  if (userMessage && /\brepo[-\s]?inspection\b|\brepo\b[\s\S]{0,80}\bgrounding\b|\bgrounding\b[\s\S]{0,80}\brepo\b/i.test(userMessage)) {
    const repoMarkers = (answer.match(/\b(?:repo[-\s]?inspection|collectRepoInspectionEvidence|evaluateRepoEvidenceContract|repoEvidenceToLedger|repoEvidence|evidence-contract|repo-inspection-controller|routeSource=repo-inspection)\b/gi) ?? []).length;
    const adjacentMarkers = (answer.match(/\b(?:web[-\s]?research|source[-\s]?purpose|web-research-finalizer|broad-answer|evaluateBroadAnswerContract|web-research-coverage)\b/gi) ?? []).length;
    if (repoMarkers < 2 || (adjacentMarkers >= 3 && repoMarkers < adjacentMarkers)) {
      issues.push("off_target_repo_inspection");
    }
  }

  // Check for unsupported claims about unread files
  const citedFiles = answer.match(/\b(?:src|app|lib|scripts|docs)\/[A-Za-z0-9._/-]+/g) ?? [];
  for (const path of citedFiles) {
    const isRead = pathWasRead(path, filesRead);
    if (!isRead && /\b(?:handles|reads|writes|checks|validates|routes?|implements)\b.*\b(?:the|this|data|request)\b/i.test(answer)) {
      issues.push("unsupported_audit_claim");
      break;
    }
  }

  // ── V128 citation enforcement ───────────────────────────────────────────
  // Search/list hits can discover paths, but behavior claims must be anchored
  // to read_file evidence. Exact path:line citations are required when the
  // answer gives approximate line numbers or names implementation functions.
  // File-level claims are allowed when the path was actually read, because some
  // read_file evidence paths do not expose stable line ranges.
  for (const path of citedFiles) {
    const isRead = pathWasRead(path, filesRead);
    if (!isRead) continue;

    const hasApproximateRange = hasApproximateCitationNearPath(answer, path);

    if (hasApproximateRange) {
      issues.push("off_target_repo_inspection");
      break;
    }
  }

  // If the answer mentions implementation function names, each function mention
  // needs a nearby exact file:line citation. This catches confident name-dropping
  // such as collectRepoInspectionEvidence() without evidence anchoring.
  for (const functionName of extractFunctionMentions(answer)) {
    if (!functionMentionHasNearbyCitation(answer, functionName)) {
      issues.push("unsupported_audit_claim");
      break;
    }
  }

  const repairInstruction = [
    "Deep audit contract failed.",
    issues.length > 0 ? `Issues: ${issues.join(", ")}.` : "",
    missingSections.length > 0 ? `Add: ${missingSections.join(", ")}.` : "All required sections present.",
    "Repair using only the collected evidence. Do not call more tools.",
    "If you read a file, cite exact path:line references (e.g. src/lib/foo.ts:42-56). Avoid approximate line numbers.",
    "If a function name is used, cite the file and line where it was found.",
  ].filter(Boolean).join("\n");

  return { ok: issues.length === 0, issues, missingSections, repairInstruction };
}
