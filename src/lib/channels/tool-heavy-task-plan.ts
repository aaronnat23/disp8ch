import { determineTaskIntentContract } from "@/lib/channels/task-intent-contract";

export type EvidenceBucket =
  | "repo_architecture"
  | "benchmark_artifacts"
  | "current_web"
  | "app_capability_state"
  | "implementation_targets"
  | "tests_and_acceptance";

export type ToolHeavyTaskPlan = {
  taskType: "tool_heavy_audit" | "tool_heavy_synthesis" | "tool_heavy_capability";
  evidenceBuckets: Array<{
    bucket: EvidenceBucket;
    required: boolean;
    maxTools: number;
    targetEvidenceCount: number;
    description: string;
  }>;
  finalAnswerSections: string[];
  expectedEvidenceCount: number;
  expectedGapCount: number;
};

export function classifyToolHeavyTask(message: string): ToolHeavyTaskPlan | null {
  const lowered = message.toLowerCase();
  const contract = determineTaskIntentContract(message);

  // Multi-source audit with an explicit evidence-table requirement.
  if (
    /\b(?:evidence\s+table|at\s+least\s+\d+\s+concrete\s+files?|remaining\s+gaps?|prioritized\s+implementation\s+plan)\b/i.test(lowered) &&
    /\b(?:inspect|read|search|fetch)\b/i.test(lowered) &&
    /\b(?:benchmark|improvement\s+doc|public\s+documentation|current\s+public|web|repo)\b/i.test(lowered)
  ) {
    const evidenceCount = parseInt(lowered.match(/\bat\s+least\s+(\d+)\s+concrete/i)?.[1] ?? "8");
    const gapCount = parseInt(lowered.match(/\b(\d+)\s+remaining\s+gaps?/i)?.[1] ?? "5");
    return {
      taskType: "tool_heavy_audit",
      evidenceBuckets: [
        { bucket: "repo_architecture", required: true, maxTools: 8, targetEvidenceCount: 3, description: "Repo files for architecture, routing, and tool execution" },
        { bucket: "benchmark_artifacts", required: true, maxTools: 4, targetEvidenceCount: 2, description: "Benchmark and improvement docs" },
        { bucket: "current_web", required: true, maxTools: 4, targetEvidenceCount: 2, description: "Current public documentation and discussions" },
        { bucket: "implementation_targets", required: true, maxTools: 4, targetEvidenceCount: 2, description: "Implementation targets and risks" },
        { bucket: "tests_and_acceptance", required: true, maxTools: 2, targetEvidenceCount: 1, description: "Regression tests and acceptance criteria" },
      ],
      finalAnswerSections: ["evidence_table", "remaining_gaps", "prioritized_plan", "regression_tests", "uncertainty"],
      expectedEvidenceCount: evidenceCount,
      expectedGapCount: gapCount,
    };
  }

  // Feature synthesis that asks for multi-agent discussion design evidence.
  if (
    /\b(?:hierarchy|multi[-\s]?agent|two\s+agents?|agent\s+(?:discussion|debate))\b/i.test(lowered) &&
    /\b(?:design|feature|discussion|debate)\b/i.test(lowered) &&
    /\b(?:files?\s+to\s+touch|DB|API|UI|transcript|readiness|prompt\s+schema)/i.test(lowered)
  ) {
    return {
      taskType: "tool_heavy_synthesis",
      evidenceBuckets: [
        { bucket: "repo_architecture", required: true, maxTools: 6, targetEvidenceCount: 3, description: "Hierarchy UI/API and Council service files" },
        { bucket: "app_capability_state", required: true, maxTools: 3, targetEvidenceCount: 2, description: "Agent model/routing config and DB schema" },
        { bucket: "implementation_targets", required: true, maxTools: 4, targetEvidenceCount: 2, description: "Files to touch, API/UI/DB changes" },
        { bucket: "tests_and_acceptance", required: true, maxTools: 2, targetEvidenceCount: 1, description: "Tests, risks, acceptance criteria" },
      ],
      finalAnswerSections: ["files_to_touch", "db_api_ui_changes", "readiness_checks", "transcript_persistence", "prompt_schema", "risks", "tests"],
      expectedEvidenceCount: 6,
      expectedGapCount: 3,
    };
  }

  // Capability/runtime audit that asks to separate implementation from availability.
  if (
    /\b(?:audit|capabilit|lack|missing|planned|configured|implemented)\b/i.test(lowered) &&
    /\b(?:local.?model|image.?gen|video|transcript|memory|session.?recall|benchmark.?comparison)\b/i.test(lowered) &&
    /\b(?:distinguish|separate|state|status|file\s+reference)\b/i.test(lowered)
  ) {
    const requestsHistoricalResults =
      /\b(?:benchmark|comparison)\b[\s\S]{0,50}\b(?:artifact|result|report|score|timing|run)\b/i.test(lowered);
    return {
      taskType: "tool_heavy_capability",
      evidenceBuckets: [
        { bucket: "app_capability_state", required: true, maxTools: 6, targetEvidenceCount: 3, description: "Tool and config files for each capability" },
        ...(requestsHistoricalResults
          ? [{ bucket: "benchmark_artifacts" as const, required: true, maxTools: 3, targetEvidenceCount: 1, description: "Requested historical benchmark artifacts" }]
          : []),
        { bucket: "repo_architecture", required: false, maxTools: 3, targetEvidenceCount: 1, description: "Supporting implementation files" },
        { bucket: "implementation_targets", required: true, maxTools: 2, targetEvidenceCount: 1, description: "Implementation and verification targets" },
        { bucket: "tests_and_acceptance", required: true, maxTools: 2, targetEvidenceCount: 1, description: "Regression tests for capability audit" },
      ],
      finalAnswerSections: [
        "capability_table",
        "file_references",
        ...(requestsHistoricalResults ? ["benchmark_artifacts"] : []),
        "next_verification",
        "tests",
      ],
      expectedEvidenceCount: 5,
      expectedGapCount: 3,
    };
  }

  return null;
}

export function bucketToLabel(bucket: EvidenceBucket): string {
  const labels: Record<EvidenceBucket, string> = {
    repo_architecture: "Repo Architecture",
    benchmark_artifacts: "Benchmark Artifacts",
    current_web: "Current Web",
    app_capability_state: "App Capability State",
    implementation_targets: "Implementation Targets",
    tests_and_acceptance: "Tests & Acceptance",
  };
  return labels[bucket];
}
