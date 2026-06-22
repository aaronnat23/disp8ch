import type { AgenticEvidencePlan, AgenticEvidenceBucket } from "@/lib/channels/agentic-evidence-plan";

export interface AgenticCoverageIssue {
  code:
    | "required_bucket_missing"
    | "search_snippet_only"
    | "generic_workflow_node"
    | "missing_exact_file_citation"
    | "missing_runtime_status"
    | "missing_security_layer"
    | "missing_design_artifact"
    | "unsupported_claim"
    | "alternate_tool_not_attempted";
  severity: "error" | "warning";
  bucketId?: string;
  message: string;
}

export interface AgenticCoverageResult {
  ok: boolean;
  issues: AgenticCoverageIssue[];
  satisfiedBucketIds: string[];
  pendingRequiredBucketIds: string[];
}

/**
 * Verifies evidence coverage by mapping tool results back onto evidence buckets.
 * Structural checks, no benchmark IDs.
 */
export function verifyEvidenceCoverage(params: {
  plan: AgenticEvidencePlan;
  toolsUsed: string[];
  toolResults: Array<{ name: string; output: string }>;
  answer: string;
}): AgenticCoverageResult {
  const { plan, toolsUsed, toolResults, answer } = params;
  const issues: AgenticCoverageIssue[] = [];
  const satisfiedIds: string[] = [];

  // ── Map tool results to buckets ───────────────────────────────────────
  for (const bucket of plan.buckets) {
    if (bucket.status === "not_applicable") {
      satisfiedIds.push(bucket.id);
      continue;
    }

    // Check if any tool result satisfies this bucket
    const relevantResults = toolResults.filter((tr) =>
      bucket.suggestedTools.includes(tr.name) || bucket.suggestedTools.length === 0,
    );

    if (relevantResults.length > 0) {
      // Check if the answer actually uses the evidence
      const hasEvidenceInAnswer = checkEvidenceInAnswer(bucket, relevantResults, answer);
      if (hasEvidenceInAnswer) {
        bucket.status = "satisfied";
        satisfiedIds.push(bucket.id);
      } else if (bucket.required) {
        issues.push({
          code: "missing_exact_file_citation",
          severity: "warning",
          bucketId: bucket.id,
          message: `Bucket "${bucket.kind}" had tool results but the answer doesn't clearly cite the evidence.`,
        });
      }
    }
  }

  // ── Check for required buckets still pending ──────────────────────────
  const pendingRequired = plan.buckets.filter((b) => b.required && b.status === "pending");
  for (const bucket of pendingRequired) {
    issues.push({
      code: "required_bucket_missing",
      severity: "error",
      bucketId: bucket.id,
      message: `Required evidence bucket "${bucket.kind}" was not satisfied: ${bucket.why}`,
    });
  }

  // ── Check for snippet-only web evidence ───────────────────────────────
  const webBuckets = plan.buckets.filter((b) => b.kind.startsWith("web_"));
  const usedWebSearch = toolsUsed.includes("web_search");
  const usedWebExtract = toolsUsed.includes("web_extract") || toolsUsed.includes("fetch_url") || toolsUsed.includes("browser_get_text");
  if (usedWebSearch && !usedWebExtract && webBuckets.some((b) => b.required)) {
    issues.push({
      code: "search_snippet_only",
      severity: "warning",
      message: "Web research used only search snippets without fetching/extracting primary sources.",
    });
  }

  // ── Check for generic workflow node names ─────────────────────────────
  if (plan.buckets.some((b) => b.kind === "workflow_node_registry")) {
    const genericNodePattern = /\b(?:code\s+node|condition\s+node|api\s+call\s+node|transform\s+node|action\s+node)\b/i;
    if (genericNodePattern.test(answer)) {
      issues.push({
        code: "generic_workflow_node",
        severity: "warning",
        message: "Workflow design uses generic node names instead of exact app node types.",
      });
    }
  }

  // ── Check for missing security layers ─────────────────────────────────
  const secBuckets = plan.buckets.filter((b) => b.kind.startsWith("repo_security_") || b.kind === "repo_sanitization");
  if (secBuckets.length >= 3) {
    const satisfiedSec = secBuckets.filter((b) => b.status === "satisfied");
    if (satisfiedSec.length < 3) {
      issues.push({
        code: "missing_security_layer",
        severity: "warning",
        message: `Security audit covered ${satisfiedSec.length}/${secBuckets.length} defense layers. At least 3 required.`,
      });
    }
  }

  return {
    ok: issues.filter((i) => i.severity === "error").length === 0,
    issues,
    satisfiedBucketIds: satisfiedIds,
    pendingRequiredBucketIds: pendingRequired.map((b) => b.id),
  };
}

function checkEvidenceInAnswer(
  bucket: AgenticEvidenceBucket,
  toolResults: Array<{ name: string; output: string }>,
  answer: string,
): boolean {
  // For repo/security buckets, check if the answer cites file paths
  if (bucket.kind.startsWith("repo_") || bucket.kind.startsWith("repo_security_")) {
    const hasFilePaths = /\b(?:src|server|scripts|lib|components|app)\/[A-Za-z0-9._/-]+\.(?:ts|tsx|js|jsx)\b/.test(answer);
    if (hasFilePaths) return true;
    // Check if tool results contain file content that was used
    const hasRelevantContent = toolResults.some((tr) => tr.output.length > 100);
    return hasRelevantContent;
  }

  // For web buckets, check if the answer cites URLs
  if (bucket.kind.startsWith("web_")) {
    const hasUrls = /https?:\/\/[^\s)]+/.test(answer);
    if (hasUrls) return true;
    // Check if tool results contain extracted content
    const hasExtractedContent = toolResults.some((tr) =>
      tr.name === "web_extract" || tr.name === "fetch_url" || tr.name === "browser_get_text",
    );
    return hasExtractedContent;
  }

  // For workflow buckets, check if node types are mentioned
  if (bucket.kind.startsWith("workflow_")) {
    return /\b(?:trigger|claude-agent|send-webchat|if-else|switch|loop|aggregate|merge|set-variables|memory-store|board-task|run-code|http-request)\b/i.test(answer);
  }

  // For capability buckets, check if implemented/configured separation exists
  if (bucket.kind.startsWith("app_")) {
    return /\b(?:implemented|configured|callable|available|unavailable)\b/i.test(answer);
  }

  // For image buckets, check if provider status is mentioned
  if (bucket.kind.startsWith("image_")) {
    return /\b(?:provider|configured|fallback|artifact)\b/i.test(answer);
  }

  if (bucket.kind.startsWith("design_") || bucket.kind === "artifact_verification") {
    return /\b(?:desproj_|desart_|\/designs\?|validation|version)\b/i.test(answer);
  }

  // Default: any tool result is evidence
  return toolResults.length > 0;
}
