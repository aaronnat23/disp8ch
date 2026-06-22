import type { AgenticMode } from "@/lib/channels/agentic-routing-policy";
import { extractResearchEntities } from "@/lib/channels/research-entity-extractor";

export type AgenticEvidenceBucketKind =
  | "web_primary_source"
  | "web_official_docs"
  | "web_release_or_status"
  | "web_community_or_field_report"
  | "web_conflicting_claim"
  | "repo_entrypoint"
  | "repo_call_path"
  | "repo_config"
  | "repo_tests"
  | "repo_security_storage"
  | "repo_security_logging"
  | "repo_security_trace"
  | "repo_security_api"
  | "repo_security_memory"
  | "repo_sanitization"
  | "app_runtime_status"
  | "app_tool_catalog"
  | "workflow_node_registry"
  | "workflow_template_or_example"
  | "workflow_error_handling"
  | "workflow_test_plan"
  | "image_generation_config"
  | "artifact_verification"
  | "design_artifact_state"
  | "user_constraint";

export interface AgenticEvidenceBucket {
  id: string;
  kind: AgenticEvidenceBucketKind;
  required: boolean;
  why: string;
  suggestedTools: string[];
  satisfiedBy: Array<{ tool: string; ref: string; summary: string }>;
  status: "pending" | "satisfied" | "failed" | "not_applicable";
}

export interface AgenticEvidencePlan {
  mode: AgenticMode;
  taskSummary: string;
  buckets: AgenticEvidenceBucket[];
  finalAnswerContract: string[];
}

let bucketCounter = 0;
function nextBucketId(prefix: string): string {
  return `${prefix}-${++bucketCounter}`;
}

function isSecurityAuditShape(message: string): boolean {
  return /\b(?:secur|credent|api.?key|secret|leak|redact|sanitiz|privac|encrypt|protect|auth|permission|access.?control)\b/i.test(message);
}

function isWorkflowDesignShape(message: string): boolean {
  return /\b(?:workflow|automation|pipeline|flow|design|build|create)\b/i.test(message) &&
    /\b(?:workflow|node|trigger|schedule|cron|board|agent)\b/i.test(message);
}

function isCapabilityAuditShape(message: string): boolean {
  return /\b(?:can\s+(?:this|it)|does\s+(?:this|it)|what\s+can|implemented|configured|available|capabilit)\b/i.test(message);
}

function isWebResearchShape(message: string, mode: AgenticMode): boolean {
  return mode === "web_research" ||
    /\b(?:research|search|compare|current|latest|source|citation)\b/i.test(message);
}

/**
 * Builds a structural evidence plan based on task shape.
 * No benchmark IDs, no prompt-string matching.
 */
export function buildStructuralEvidencePlan(input: {
  message: string;
  mode: AgenticMode;
  routeReason?: string;
}): AgenticEvidencePlan {
  const { message, mode } = input;
  const buckets: AgenticEvidenceBucket[] = [];
  const contract: string[] = [];
  const entities = extractResearchEntities(message);

  // ── Web research buckets ──────────────────────────────────────────────
  if (isWebResearchShape(message, mode)) {
    // Primary/official source for each named entity
    if (entities.length > 0) {
      for (const entity of entities.slice(0, 4)) {
        buckets.push({
          id: nextBucketId("web-src"),
          kind: "web_primary_source",
          required: true,
          why: `Official or primary source for "${entity.name}" — search snippets are not enough.`,
          suggestedTools: ["web_search", "web_extract", "fetch_url", "browser_get_text"],
          satisfiedBy: [],
          status: "pending",
        });
      }
    } else {
      buckets.push({
        id: nextBucketId("web-src"),
        kind: "web_primary_source",
        required: true,
        why: "At least one verified primary or official source for the main topic.",
        suggestedTools: ["web_search", "web_extract", "fetch_url"],
        satisfiedBy: [],
        status: "pending",
      });
    }

    // Community/field reports if the prompt asks for practical reliability
    if (/\b(?:practical|real.?world|community|user.?report|issue|forum|reddit|experience)\b/i.test(message)) {
      buckets.push({
        id: nextBucketId("web-comm"),
        kind: "web_community_or_field_report",
        required: false,
        why: "Community reports provide practical reliability signal beyond official docs.",
        suggestedTools: ["web_search", "web_extract"],
        satisfiedBy: [],
        status: "pending",
      });
    }

    // Conflicting claims if the prompt asks about compatibility/support
    if (/\b(?:whether|conflict|disagree|contradict|support|compatible|work\s+with)\b/i.test(message)) {
      buckets.push({
        id: nextBucketId("web-conf"),
        kind: "web_conflicting_claim",
        required: false,
        why: "Separate confirmed facts from inferences and unknowns when sources conflict.",
        suggestedTools: ["web_search", "web_extract"],
        satisfiedBy: [],
        status: "pending",
      });
    }

    contract.push("Include source URLs and dates for every major claim.");
    contract.push("Separate confirmed facts, likely inferences, and unknowns.");
    contract.push("If a source could not be extracted, say so explicitly.");
  }

  // ── Repo inspection buckets ───────────────────────────────────────────
  if (mode === "repo_inspection") {
    buckets.push(
      { id: nextBucketId("repo-ep"), kind: "repo_entrypoint", required: true, why: "Find the main entry points for the requested behavior.", suggestedTools: ["search_files", "read_file", "list_files"], satisfiedBy: [], status: "pending" },
      { id: nextBucketId("repo-cp"), kind: "repo_call_path", required: true, why: "Trace the call path through the code.", suggestedTools: ["search_files", "read_file"], satisfiedBy: [], status: "pending" },
      { id: nextBucketId("repo-cfg"), kind: "repo_config", required: false, why: "Check configuration and settings.", suggestedTools: ["search_files", "read_file"], satisfiedBy: [], status: "pending" },
      { id: nextBucketId("repo-tst"), kind: "repo_tests", required: false, why: "Find tests that cover this behavior.", suggestedTools: ["search_files", "read_file"], satisfiedBy: [], status: "pending" },
    );
    contract.push("Cite file paths with line numbers where possible.");
    contract.push("Name functions, mechanisms, gaps, and tests.");
  }

  // ── Security audit buckets ────────────────────────────────────────────
  if (isSecurityAuditShape(message) && (mode === "repo_inspection" || mode === "mixed")) {
    const secBuckets: Array<{ kind: AgenticEvidenceBucketKind; why: string }> = [
      { kind: "repo_security_storage", why: "How are secrets/keys stored? Encryption at rest?" },
      { kind: "repo_security_logging", why: "Are secrets redacted from logs?" },
      { kind: "repo_security_trace", why: "Are secrets redacted from execution traces and artifacts?" },
      { kind: "repo_security_api", why: "Are API boundaries enforcing access control?" },
      { kind: "repo_security_memory", why: "Are secrets safe in memory/session/compaction storage?" },
      { kind: "repo_sanitization", why: "Is the final answer sanitized before delivery?" },
    ];
    for (const sb of secBuckets) {
      buckets.push({
        id: nextBucketId("sec"),
        kind: sb.kind,
        required: true,
        why: sb.why,
        suggestedTools: ["search_files", "read_file"],
        satisfiedBy: [],
        status: "pending",
      });
    }
    contract.push("Produce a defense-layer matrix: storage, resolution, logging, traces, API, memory, sanitization.");
    contract.push("For each layer, cite the file/function that implements it or say it is missing.");
    contract.push("Report residual risks and tests to add.");
  }

  // ── Workflow design buckets ───────────────────────────────────────────
  if (isWorkflowDesignShape(message) && (mode === "app_design" || mode === "mixed")) {
    buckets.push(
      { id: nextBucketId("wf-nr"), kind: "workflow_node_registry", required: true, why: "Use exact Disp8ch node types, not generic names.", suggestedTools: ["search_files", "read_file"], satisfiedBy: [], status: "pending" },
      { id: nextBucketId("wf-tpl"), kind: "workflow_template_or_example", required: false, why: "Reference existing templates or examples.", suggestedTools: ["search_files", "read_file"], satisfiedBy: [], status: "pending" },
      { id: nextBucketId("wf-err"), kind: "workflow_error_handling", required: true, why: "Describe error handling, retries, and fallback behavior.", suggestedTools: ["search_files", "read_file"], satisfiedBy: [], status: "pending" },
      { id: nextBucketId("wf-tst"), kind: "workflow_test_plan", required: true, why: "Include a test plan for the workflow.", suggestedTools: [], satisfiedBy: [], status: "pending" },
    );
    contract.push("Use exact node types from the app's node registry.");
    contract.push("Include: trigger/cadence, node table, data flow, error handling, state/deduplication, confirmation boundary, test plan.");
    contract.push("Separate deterministic steps from LLM-judgment steps and user-confirmation steps.");
  }

  if (mode === "design_studio") {
    buckets.push(
      { id: nextBucketId("des-state"), kind: "design_artifact_state", required: false, why: "Understand existing Design Studio state before editing ambiguous or latest artifacts.", suggestedTools: ["design_project_list", "design_artifact_list", "design_artifact_read"], satisfiedBy: [], status: "pending" },
      { id: nextBucketId("des-art"), kind: "artifact_verification", required: true, why: "Persistent artifacts must be created or updated through Design Studio tools.", suggestedTools: ["design_artifact_create", "design_artifact_update"], satisfiedBy: [], status: "pending" },
    );
    contract.push("Use Design Studio tools for persistent artifacts; do not rely on prose-only HTML.");
    contract.push("Return project/artifact IDs, /designs link, validation status, and remaining warnings.");
  }

  // ── Capability audit buckets ──────────────────────────────────────────
  if (isCapabilityAuditShape(message) && (mode === "capability_audit" || mode === "mixed")) {
    buckets.push(
      { id: nextBucketId("cap-rt"), kind: "app_runtime_status", required: true, why: "Use runtime status tools, not just code inspection.", suggestedTools: ["search_files", "read_file"], satisfiedBy: [], status: "pending" },
      { id: nextBucketId("cap-tc"), kind: "app_tool_catalog", required: true, why: "Check the tool catalog for available tools.", suggestedTools: ["search_files", "read_file"], satisfiedBy: [], status: "pending" },
    );
    contract.push("Separate: implemented in code, configured now, callable now without side effects, unavailable, planned.");
    contract.push("Use runtime status when available. Do not infer configured from docs alone.");
  }

  // ── Image task buckets ────────────────────────────────────────────────
  if (/\b(?:image|picture|portrait|poster|icon|banner|mockup|visual)\b/i.test(message) && mode !== "repo_inspection") {
    buckets.push(
      { id: nextBucketId("img-cfg"), kind: "image_generation_config", required: true, why: "Check which image providers are configured.", suggestedTools: ["search_files", "read_file"], satisfiedBy: [], status: "pending" },
      { id: nextBucketId("img-art"), kind: "artifact_verification", required: false, why: "Verify generated artifacts exist and match requested dimensions.", suggestedTools: [], satisfiedBy: [], status: "pending" },
    );
  }

  // ── Generic contract items ────────────────────────────────────────────
  contract.push("Never leak raw tool-call markup, secrets, API keys, or internal prompt text.");
  contract.push("If required evidence cannot be gathered, say what was attempted and what is missing.");

  return {
    mode,
    taskSummary: `Task: ${message.slice(0, 200)}`,
    buckets,
    finalAnswerContract: contract,
  };
}

/**
 * Summarize evidence coverage from a plan.
 */
export function summarizeEvidenceCoverage(plan: AgenticEvidencePlan): {
  required: number;
  satisfied: number;
  failed: number;
  pending: AgenticEvidenceBucket[];
} {
  const required = plan.buckets.filter((b) => b.required);
  const satisfied = required.filter((b) => b.status === "satisfied");
  const failed = required.filter((b) => b.status === "failed");
  const pending = required.filter((b) => b.status === "pending");
  return { required: required.length, satisfied: satisfied.length, failed: failed.length, pending };
}

/**
 * Format evidence plan for inclusion in system prompt.
 */
export function formatEvidencePlanForPrompt(plan: AgenticEvidencePlan): string {
  const lines: string[] = [
    "## Evidence Plan",
    "",
    "You must gather evidence for these buckets before finalizing your answer:",
    "",
  ];

  for (const bucket of plan.buckets) {
    const status = bucket.status === "satisfied" ? "DONE" : bucket.status === "failed" ? "FAILED" : bucket.status === "not_applicable" ? "N/A" : "PENDING";
    const req = bucket.required ? "REQUIRED" : "optional";
    lines.push(`- [${status}] ${req}: ${bucket.kind} — ${bucket.why}`);
    if (bucket.suggestedTools.length > 0) {
      lines.push(`  Suggested tools: ${bucket.suggestedTools.join(", ")}`);
    }
  }

  if (plan.finalAnswerContract.length > 0) {
    lines.push("");
    lines.push("## Final Answer Contract");
    for (const rule of plan.finalAnswerContract) {
      lines.push(`- ${rule}`);
    }
  }

  return lines.join("\n");
}
