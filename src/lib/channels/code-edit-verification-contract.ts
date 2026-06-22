import type { CodeEditCommandEvidence, CodeEditDossier } from "@/lib/channels/code-edit-dossier";
import { commandEvidenceIsSuccessfulVerification } from "@/lib/channels/code-edit-command-evidence";

export type VerificationContractProbe = {
  id: string;
  description: string;
  source: "user_request" | "changed_hunks" | "file_type" | "risk_rule";
  priority: "required" | "recommended";
  satisfied: boolean;
  satisfiedByEvidenceIds: string[];
};

export type VerificationContract = {
  summary: string;
  probes: VerificationContractProbe[];
  minimumEvidence: {
    requiresBehaviorProbe: boolean;
    requiresBuildOrTypecheck: boolean;
    requiresFreshVerifier: boolean;
  };
  unknowns: string[];
};

function corpusFor(dossier: CodeEditDossier): string {
  return [
    dossier.request,
    dossier.edits.map((edit) => `${edit.filePath}\n${edit.oldSnippet ?? ""}\n${edit.newSnippet ?? ""}\n${edit.resultPreview}`).join("\n"),
  ].join("\n").toLowerCase();
}

function evidenceText(evidence: CodeEditCommandEvidence): string {
  return `${evidence.commandOrSummary}\n${evidence.preview}`.toLowerCase();
}

function hasStrongOrMedium(evidence: CodeEditCommandEvidence[]): boolean {
  return evidence.some(commandEvidenceIsSuccessfulVerification);
}

function addProbe(probes: VerificationContractProbe[], probe: Omit<VerificationContractProbe, "satisfied" | "satisfiedByEvidenceIds">): void {
  if (probes.some((existing) => existing.id === probe.id)) return;
  probes.push({ ...probe, satisfied: false, satisfiedByEvidenceIds: [] });
}

export function deriveVerificationContract(input: {
  request: string;
  codeEditDossier: CodeEditDossier;
}): VerificationContract {
  const dossier = input.codeEditDossier;
  const text = corpusFor(dossier);
  const probes: VerificationContractProbe[] = [];
  const changedExtensions = new Set(dossier.changedFiles.map((file) => (file.match(/\.[A-Za-z0-9]+$/)?.[0] ?? "").toLowerCase()));

  const stringNormalization = /\b(?:normaliz|format|casing|case|title\s+case|headline\s+case|slug|trim|punctuation|whitespace|acronym|connector|stop\s+word|parser|regex)\b/i.test(text);
  if (stringNormalization) {
    addProbe(probes, {
      id: "behavior_string_normalization",
      description: "Run a behavior probe or test for the changed string/text transformation.",
      source: "user_request",
      priority: "required",
    });
    if (/\b(?:whitespace|space|collapse|trim)\b/i.test(text)) {
      addProbe(probes, {
        id: "edge_whitespace",
        description: "Include leading/trailing or repeated whitespace input.",
        source: "user_request",
        priority: "required",
      });
    }
    if (/\b(?:punctuation|period|full\s+stop|[.!?])\b/i.test(text)) {
      addProbe(probes, {
        id: "edge_punctuation",
        description: "Include input with punctuation relevant to the requested rule.",
        source: "user_request",
        priority: "required",
      });
    }
    if (/\b(?:whitespace|space|collapse|trim)\b/i.test(text) && /\b(?:punctuation|period|full\s+stop|[.!?])\b/i.test(text)) {
      addProbe(probes, {
        id: "edge_whitespace_before_trailing_punctuation",
        description: "Include input where whitespace appears before trailing sentence punctuation.",
        source: "user_request",
        priority: "required",
      });
    }
    if (/\b(?:acronym|all[-\s]?caps|uppercase)\b/i.test(text) && /\b(?:connector|stop\s+word|lowercase|lower-case|except|unless)\b/i.test(text)) {
      addProbe(probes, {
        id: "edge_rule_precedence_overlap",
        description: "Include an overlap case where uppercase/acronym preservation conflicts with lowercasing or exception rules.",
        source: "user_request",
        priority: "required",
      });
      addProbe(probes, {
        id: "edge_uppercase_connector_normalization",
        description: "Include an uppercase connector word that must still become lowercase when it is not first.",
        source: "user_request",
        priority: "required",
      });
    }
    if (/\b(?:mixed\s+case|case)\b/i.test(text)) {
      addProbe(probes, {
        id: "edge_mixed_case",
        description: "Include mixed-case input to prove casing behavior.",
        source: "user_request",
        priority: "recommended",
      });
    }
  }

  if (/\b(?:parse|parser|validate|schema|json|yaml|csv|markdown|encode|decode|sanitize|regex)\b/i.test(text)) {
    addProbe(probes, {
      id: "parser_valid_input",
      description: "Verify at least one valid input path.",
      source: "user_request",
      priority: "required",
    });
    addProbe(probes, {
      id: "parser_malformed_input",
      description: "Verify malformed, empty, or missing-field input where applicable.",
      source: "user_request",
      priority: "required",
    });
  }

  if (/\b(?:route|endpoint|api|webhook|auth|database|db|persistence|signature|hmac)\b/i.test(text) || dossier.changedFiles.some((file) => /(?:api|route|webhook|auth|db|database)/i.test(file))) {
    addProbe(probes, {
      id: "api_success_shape",
      description: "Verify success path with expected response shape or persisted state.",
      source: "changed_hunks",
      priority: "required",
    });
    addProbe(probes, {
      id: "api_error_path",
      description: "Verify an error/rejection path, not just HTTP 200.",
      source: "changed_hunks",
      priority: "required",
    });
  }

  if (/\b(?:component|page|tab|button|modal|form|ui|frontend|design studio|automations|webchat)\b/i.test(text) || dossier.changedFiles.some((file) => /\.(?:tsx|jsx|css|scss)$/i.test(file))) {
    addProbe(probes, {
      id: "frontend_visible_or_build",
      description: "Verify the changed UI by browser/page check or at least build/typecheck when browser tools are unavailable.",
      source: "file_type",
      priority: "required",
    });
  }

  if (/\b(?:workflow|cron|schedule|webhook|automation|node)\b/i.test(text)) {
    addProbe(probes, {
      id: "automation_state_check",
      description: "Verify resulting automation/workflow state through an app-state/API/tool check when mutation was requested.",
      source: "user_request",
      priority: "recommended",
    });
  }

  if (/\b(?:secret|token|credential|hmac|signature|key|oauth|rls|auth)\b/i.test(text)) {
    addProbe(probes, {
      id: "security_rejection_no_leak",
      description: "Verify invalid/missing credential rejection and avoid printing real secrets.",
      source: "risk_rule",
      priority: "required",
    });
  }

  if (changedExtensions.has(".ts") || changedExtensions.has(".tsx") || changedExtensions.has(".js") || changedExtensions.has(".jsx")) {
    addProbe(probes, {
      id: "typescript_or_build_check",
      description: "Run a relevant typecheck, build, test, or focused behavior command for JS/TS runtime changes.",
      source: "file_type",
      priority: stringNormalization || probes.some((probe) => probe.priority === "required") ? "recommended" : "required",
    });
  }

  const requiresBehaviorProbe = probes.some((probe) => probe.id.startsWith("behavior_") || probe.id.startsWith("edge_") || probe.id.startsWith("parser_") || probe.id.startsWith("api_") || probe.id.startsWith("security_"));
  const requiresBuildOrTypecheck = changedExtensions.has(".ts") || changedExtensions.has(".tsx") || changedExtensions.has(".js") || changedExtensions.has(".jsx");
  return {
    summary: probes.length
      ? `Derived ${probes.length} verification probe(s) from request/change shape.`
      : "No special behavioral probes were derived beyond changed-file reporting.",
    probes,
    minimumEvidence: {
      requiresBehaviorProbe,
      requiresBuildOrTypecheck,
      requiresFreshVerifier: false,
    },
    unknowns: [],
  };
}

function probeSatisfiedBy(probe: VerificationContractProbe, evidence: CodeEditCommandEvidence): boolean {
  if (!commandEvidenceIsSuccessfulVerification(evidence)) return false;
  const text = evidenceText(evidence);
  if (probe.id === "typescript_or_build_check") return ["typecheck", "build", "unit_test", "behavior_probe"].includes(evidence.kind);
  if (probe.id === "frontend_visible_or_build") return ["browser_probe", "build", "typecheck", "unit_test"].includes(evidence.kind);
  if (probe.id === "api_success_shape") return evidence.kind === "api_probe" || /\b(?:status|json|response|created|ok|success)\b/i.test(text);
  if (probe.id === "api_error_path") return /\b(?:reject|invalid|missing|error|400|401|403|404|failure|unauthori[sz]ed)\b/i.test(text);
  if (probe.id === "automation_state_check") return /\b(?:webhook|schedule|cron|automation|workflow|state|created|active|enabled)\b/i.test(text);
  if (probe.id === "security_rejection_no_leak") return /\b(?:invalid|missing|reject|signature|hmac|secret|token|401|403)\b/i.test(text) && !/\bsk-[A-Za-z0-9_-]{12,}\b/.test(text);
  if (probe.id === "parser_valid_input") return /\b(?:valid|KEY|value|parse|input|expected|actual|pass)\b/i.test(text);
  if (probe.id === "parser_malformed_input") return /\b(?:malformed|invalid|empty|missing|reject|throw|error)\b/i.test(text);
  if (probe.id === "edge_whitespace") return / {2,}|\t|whitespace|multiple\s+spaces|leading|trailing/i.test(text);
  if (probe.id === "edge_punctuation") return /punctuation|period|trailing|[.!?].*(?:=>|expected|actual|pass)/i.test(text);
  if (probe.id === "edge_whitespace_before_trailing_punctuation") {
    const raw = `${evidence.commandOrSummary}\n${evidence.preview}`;
    return / {2,}|\t|whitespace|leading|trailing/i.test(raw) &&
      /[.!?]/.test(raw) &&
      /\b(?:PASS|passed|expected|actual|=>|strictEqual|toEqual|assert)\b/i.test(raw);
  }
  if (probe.id === "edge_rule_precedence_overlap") {
    const raw = `${evidence.commandOrSummary}\n${evidence.preview}`;
    const hasUpperConnector = /\b(?:A|AN|AND|OR|OF|IN|ON|FOR|TO|THE)\b/.test(raw);
    const hasAcronymOrPrecedence = /\b(?:NASA|FBI|USA|URL|API|HTML|CSS|SQL|uppercase|acronym|connector|overlap|precedence)\b/.test(raw);
    return hasUpperConnector && hasAcronymOrPrecedence;
  }
  if (probe.id === "edge_uppercase_connector_normalization") {
    const raw = `${evidence.commandOrSummary}\n${evidence.preview}`;
    const hasUpperConnectorInput = /\b(?:AN|AND|OR|OF|IN|ON|FOR|TO|THE)\b/.test(raw);
    const hasLowerConnectorExpectation = /(?:^|[^A-Za-z])(?:an|and|or|of|in|on|for|to|the)(?:[^A-Za-z]|$)/.test(raw) &&
      /\b(?:expected|actual|=>|PASS|passed|strictEqual|toEqual|assert)\b/i.test(raw);
    return hasUpperConnectorInput && hasLowerConnectorExpectation;
  }
  if (probe.id === "edge_mixed_case") return /\b(?:mixed|MiXeD|camel|case)\b/i.test(text);
  if (probe.id === "behavior_string_normalization") return evidence.kind === "behavior_probe" || evidence.kind === "unit_test";
  return evidence.provesChangedBehavior;
}

export function evaluateVerificationContract(input: {
  contract: VerificationContract;
  codeEditDossier: CodeEditDossier;
}): VerificationContract {
  const evidence = input.codeEditDossier.commandEvidence;
  const probes = input.contract.probes.map((probe) => {
    const satisfiedBy = evidence.filter((item) => probeSatisfiedBy(probe, item)).map((item) => item.id);
    return {
      ...probe,
      satisfied: satisfiedBy.length > 0,
      satisfiedByEvidenceIds: satisfiedBy,
    };
  });
  const missingRequired = probes.filter((probe) => probe.priority === "required" && !probe.satisfied);
  const strongBehavior = evidence.some((item) => item.provesChangedBehavior);
  const hasAnyVerification = hasStrongOrMedium(evidence);
  return {
    ...input.contract,
    probes,
    minimumEvidence: {
      ...input.contract.minimumEvidence,
      requiresFreshVerifier: missingRequired.length > 0 && hasAnyVerification && !strongBehavior,
    },
    unknowns: [
      ...input.contract.unknowns,
      ...(missingRequired.length ? [`missing required probes: ${missingRequired.map((probe) => probe.id).join(", ")}`] : []),
    ],
  };
}

export function summarizeVerificationContractForPrompt(
  contract: VerificationContract,
  options: { maxChars?: number } = {},
): string {
  const maxChars = options.maxChars ?? 2200;
  const probes = contract.probes.map((probe) =>
    `- ${probe.satisfied ? "satisfied" : "missing"} ${probe.priority}: ${probe.id} — ${probe.description}`,
  ).join("\n") || "- no special probes";
  const text = [
    contract.summary,
    `Minimum evidence: behavior=${contract.minimumEvidence.requiresBehaviorProbe}, build/typecheck=${contract.minimumEvidence.requiresBuildOrTypecheck}, fresh=${contract.minimumEvidence.requiresFreshVerifier}`,
    `Probes:\n${probes}`,
    contract.unknowns.length ? `Unknowns:\n- ${contract.unknowns.join("\n- ")}` : "",
  ].filter(Boolean).join("\n\n");
  return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
}

export function summarizeMissingRequiredProbeExecutionGuide(
  contract: VerificationContract,
  options: { maxChars?: number } = {},
): string {
  const maxChars = options.maxChars ?? 1600;
  const missing = contract.probes.filter((probe) => probe.priority === "required" && !probe.satisfied);
  if (missing.length === 0) return "No missing required probes.";
  const lines = missing.map((probe) => {
    if (probe.id === "edge_uppercase_connector_normalization") {
      return [
        `- ${probe.id}: run an artifact-linked behavior check where an uppercase connector word appears after the first word.`,
        "  Example shape: input contains `AND`, `TO`, `THE`, `OF`, `IN`, `ON`, or `FOR`; expected output keeps that connector lowercase unless it is first.",
      ].join("\n");
    }
    if (probe.id === "edge_whitespace_before_trailing_punctuation") {
      return [
        `- ${probe.id}: run an artifact-linked behavior check where whitespace appears before trailing sentence punctuation.`,
        "  sentence punctuation. Expected output must not retain a trailing space after punctuation stripping.",
      ].join("\n");
    }
    if (probe.id === "edge_rule_precedence_overlap") {
      return [
        `- ${probe.id}: run an artifact-linked behavior check where two requested rules overlap, such as acronym preservation plus connector lowercasing.`,
        "  Expected output should prove the intended precedence instead of only testing easy independent cases.",
      ].join("\n");
    }
    if (probe.id === "edge_whitespace") {
      return `- ${probe.id}: run an artifact-linked behavior check with leading, trailing, or repeated whitespace.`;
    }
    if (probe.id === "edge_punctuation") {
      return `- ${probe.id}: run an artifact-linked behavior check with punctuation relevant to the requested transformation.`;
    }
    if (probe.id === "edge_mixed_case") {
      return `- ${probe.id}: run an artifact-linked behavior check with mixed-case input.`;
    }
    if (probe.id === "behavior_string_normalization") {
      return `- ${probe.id}: run a behavior check that imports or executes the changed string/text transformation artifact.`;
    }
    if (probe.id === "typescript_or_build_check") {
      return `- ${probe.id}: run a relevant typecheck, build, existing test, or focused behavior command against the changed JS/TS artifact.`;
    }
    if (probe.id.startsWith("api_")) {
      return `- ${probe.id}: verify the API through an HTTP/app-state command with an assertion on response shape or rejection behavior.`;
    }
    if (probe.id.startsWith("parser_")) {
      return `- ${probe.id}: run the changed parser/validator on the requested input class and assert the expected result.`;
    }
    if (probe.id === "security_rejection_no_leak") {
      return `- ${probe.id}: verify rejection behavior without printing or exposing real secrets.`;
    }
    return `- ${probe.id}: ${probe.description}`;
  });
  const text = [
    "Missing required probe execution guide:",
    ...lines,
    "All behavior checks must exercise the changed artifact, route, component, or API. Do not copy the implementation into the verification script.",
  ].join("\n");
  return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
}
