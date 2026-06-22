import type { WorkflowCredentialHealth } from "@/lib/workflows/credential-health";
import type { WorkflowExecutionNodeTrace } from "@/lib/workflows/execution-traces";

type CredentialHealthSummary = {
  items: WorkflowCredentialHealth[];
  summary: { ok: number; missing: number; untested: number; notRequired: number };
};

type NodeConfigSummary = {
  nodeId: string;
  nodeType: string;
  valid: boolean;
  missingFields: string[];
  warnings: string[];
};

type LatestFailure = {
  trace: WorkflowExecutionNodeTrace;
  repair: { suggestions: string[] } | null;
};

type TraceSummary = {
  totals: { nodeCount: number; failedCount: number; totalDurationMs: number; totalCostUsd: number; totalTokens: number };
  bottlenecks: Array<{ nodeId: string; nodeName: string | null; nodeType: string; durationMs: number | null; status: string }>;
  failures: WorkflowExecutionNodeTrace[];
};

export type WorkflowRecoveryPlan = {
  title: string;
  summary: string;
  priority: "low" | "medium" | "high";
  actions: string[];
  prompt: string;
  evidence: string[];
};

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function namedNode(trace: { nodeName?: string | null; nodeId: string }): string {
  return String(trace.nodeName || trace.nodeId || "the failed node");
}

export function buildWorkflowRecoveryPlan(input: {
  workflow: { id: string; name: string; nodeCount: number; edgeCount: number };
  trace: TraceSummary;
  credentialHealth: CredentialHealthSummary;
  nodeConfig: NodeConfigSummary[];
  latestFailures: LatestFailure[];
}): WorkflowRecoveryPlan {
  const missingCredentials = input.credentialHealth.items.filter((item) => item.status === "missing");
  const invalidConfigs = input.nodeConfig.filter((item) => !item.valid);
  const warningConfigs = input.nodeConfig.filter((item) => item.valid && item.warnings.length > 0);
  const failures = input.latestFailures.filter((item) => item.trace.status === "failed");
  const slowest = input.trace.bottlenecks.find((item) => (item.durationMs ?? 0) > 0) ?? null;

  if (missingCredentials.length > 0) {
    const first = missingCredentials[0];
    return {
      title: "Fix missing credentials first",
      summary: `${missingCredentials.length} node(s) need saved credentials before this workflow can run reliably.`,
      priority: "high",
      actions: unique([
        `Attach a ${first.serviceType || first.nodeType} credential to ${first.nodeName}.`,
        "Use the Inspector credential form, then rerun the workflow.",
        invalidConfigs.length > 0 ? "Review required node config after credentials are attached." : "",
      ]).slice(0, 4),
      prompt: `Review workflow "${input.workflow.name}" (${input.workflow.id}). Start by fixing missing credentials for ${missingCredentials.map((item) => `${item.nodeName} (${item.nodeId})`).join(", ")}. Propose the smallest safe repair plan and wait for confirmation before changing the workflow.`,
      evidence: unique([
        `${missingCredentials.length} missing credential(s)`,
        `${input.workflow.nodeCount} nodes`,
        input.trace.totals.failedCount > 0 ? `${input.trace.totals.failedCount} failed trace node(s)` : "",
      ]).slice(0, 4),
    };
  }

  if (failures.length > 0) {
    const first = failures[0];
    const suggestions = first.repair?.suggestions ?? [];
    return {
      title: "Repair the failed node path",
      summary: `${failures.length} failed node trace(s) were found in the latest execution data.`,
      priority: "high",
      actions: unique([
        suggestions[0] || `Inspect ${namedNode(first.trace)} input and output.`,
        suggestions[1] || "Pin a known-good sample before rerunning.",
        slowest ? `Check whether ${slowest.nodeName || slowest.nodeId} is also creating latency.` : "",
      ]).slice(0, 4),
      prompt: `Debug workflow "${input.workflow.name}" (${input.workflow.id}). Focus on failed node ${namedNode(first.trace)} (${first.trace.nodeId}). Use the latest trace evidence and repair hints, propose a minimal fix, and wait for confirmation before editing nodes.`,
      evidence: unique([
        `${failures.length} failed trace node(s)`,
        `First failed node: ${namedNode(first.trace)}`,
        suggestions[0] || "",
      ]).slice(0, 4),
    };
  }

  if (invalidConfigs.length > 0) {
    const first = invalidConfigs[0];
    return {
      title: "Complete required node config",
      summary: `${invalidConfigs.length} node(s) are missing required settings.`,
      priority: "medium",
      actions: unique([
        `Set ${first.missingFields.join(", ")} on ${first.nodeType}.`,
        "Run the workflow with pinned test input after config is complete.",
        warningConfigs.length > 0 ? "Review non-blocking config warnings too." : "",
      ]).slice(0, 4),
      prompt: `Review workflow "${input.workflow.name}" (${input.workflow.id}) for missing node configuration. Start with node ${first.nodeId} (${first.nodeType}) missing ${first.missingFields.join(", ")}. Propose exact config changes and wait for confirmation before editing.`,
      evidence: unique([
        `${invalidConfigs.length} invalid config node(s)`,
        `Missing: ${first.missingFields.join(", ")}`,
      ]).slice(0, 4),
    };
  }

  if (slowest && (slowest.durationMs ?? 0) >= 5000) {
    return {
      title: "Reduce the slowest node",
      summary: `${slowest.nodeName || slowest.nodeId} is the current bottleneck at ${slowest.durationMs ?? 0} ms.`,
      priority: "medium",
      actions: [
        "Inspect timeout, retry, and batch-size settings.",
        "Add a smaller pinned test case for this node.",
        "Rerun only from the bottleneck node if the graph supports partial execution.",
      ],
      prompt: `Optimize workflow "${input.workflow.name}" (${input.workflow.id}). Focus on bottleneck ${slowest.nodeName || slowest.nodeId} (${slowest.nodeId}) at ${slowest.durationMs ?? 0} ms. Propose low-risk latency improvements and wait for confirmation before editing.`,
      evidence: [`Slowest node: ${slowest.nodeName || slowest.nodeId}`, `${slowest.durationMs ?? 0} ms`],
    };
  }

  return {
    title: "Add a reusable workflow test case",
    summary: "No blocking credential, config, or trace issue is visible. The next improvement is repeatable validation.",
    priority: "low",
    actions: [
      "Pin a representative input sample.",
      "Run a partial execution from the first meaningful node.",
      "Save the expected output shape for regression checks.",
    ],
    prompt: `Create a practical test case for workflow "${input.workflow.name}" (${input.workflow.id}). Use a representative input, identify expected outputs, and wait for confirmation before changing the workflow.`,
    evidence: [`${input.workflow.nodeCount} nodes`, `${input.trace.totals.nodeCount} traced node(s)`, "No blocking issue detected"],
  };
}
