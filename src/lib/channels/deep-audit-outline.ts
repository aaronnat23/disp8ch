import type { DeepAuditProfile, DeepAuditKind, DeepAuditSection } from "@/lib/channels/deep-audit-profile";

export type OutlineAnchor = {
  kind: "file_path" | "source_url" | "artifact_path" | "function_name" | "candidate";
  value: string;
  verified: boolean;
};

export type OutlineSection = {
  id: DeepAuditSection;
  label: string;
  required: boolean;
  anchors: OutlineAnchor[];
  instruction: string;
};

export type DeepAuditOutline = {
  kind: DeepAuditKind;
  sections: OutlineSection[];
  evidenceSummary: string;
  missingAnchors: string[];
};

const SECTION_LABELS: Record<DeepAuditSection, string> = {
  pipeline_or_trace: "Pipeline / Call Chain",
  evidence_table: "Evidence Table",
  failure_gates: "Failure Gates / Vulnerable Checks",
  hollow_example: "Hollow-Pass Example",
  fix_contract: "Stricter Contract / Fix",
  regression_tests: "Regression Tests",
  remaining_gaps: "Remaining Gaps",
  uncertainty: "Uncertainty / Limitations",
};

const SECTION_INSTRUCTIONS: Record<DeepAuditSection, string> = {
  pipeline_or_trace: "Trace the exact call chain from entry point to output. Name files, functions, and decision points.",
  evidence_table: "List concrete files, source URLs, or artifacts that support each claim. Mark verified vs candidate.",
  failure_gates: "Identify each check/gate that currently allows a shallow answer. Explain how each can be fooled.",
  hollow_example: "Provide a minimal example that would pass current checks but fail the user's intent.",
  fix_contract: "Propose specific contract fields, thresholds, and checks that would catch the hollow example.",
  regression_tests: "Provide concrete test cases: input, expected pass/fail, which gate catches it.",
  remaining_gaps: "List what was NOT verified: file sizes, web sources, benchmark runs, config states.",
  uncertainty: "State what could not be determined from available evidence and what additional reads would help.",
};

export function buildDeepAuditOutline(
  profile: DeepAuditProfile,
  filesRead: string[],
  searchesRun: string[],
  verifiedUrls: string[],
  artifactPaths: string[],
): DeepAuditOutline {
  const sections: OutlineSection[] = [];
  const missingAnchors: string[] = [];

  for (const sectionId of profile.requiredSections) {
    const anchors: OutlineAnchor[] = [];

    for (const path of filesRead.slice(0, 8)) {
      anchors.push({ kind: "file_path", value: path, verified: true });
    }
    for (const url of verifiedUrls.slice(0, 4)) {
      anchors.push({ kind: "source_url", value: url, verified: true });
    }
    for (const path of artifactPaths.slice(0, 3)) {
      anchors.push({ kind: "artifact_path", value: path, verified: true });
    }
    for (const query of searchesRun.slice(0, 3)) {
      anchors.push({ kind: "candidate", value: query, verified: false });
    }

    sections.push({
      id: sectionId,
      label: SECTION_LABELS[sectionId],
      required: true,
      anchors,
      instruction: SECTION_INSTRUCTIONS[sectionId],
    });
  }

  if (filesRead.length < profile.minVerifiedReads) {
    missingAnchors.push(`Need ${profile.minVerifiedReads - filesRead.length} more file reads (have ${filesRead.length})`);
  }

  const evidenceSummary = [
    `Evidence collected: ${filesRead.length} files read, ${searchesRun.length} searches, ${verifiedUrls.length} URLs, ${artifactPaths.length} artifacts.`,
    filesRead.length > 0 ? `Files: ${filesRead.slice(0, 5).join(", ")}` : "",
    verifiedUrls.length > 0 ? `URLs: ${verifiedUrls.slice(0, 3).join(", ")}` : "",
  ].filter(Boolean).join("\n");

  return { kind: profile.kind ?? "quality_gap", sections, evidenceSummary, missingAnchors };
}

export function formatDeepAuditOutlineAsPrompt(outline: DeepAuditOutline): string {
  const lines: string[] = [
    `Deep audit outline (${outline.kind}):`,
    outline.evidenceSummary,
    "",
  ];

  for (const section of outline.sections) {
    lines.push(`## ${section.label}`);
    lines.push(section.instruction);
    if (section.anchors.length > 0) {
      lines.push("Grounded evidence:");
      for (const anchor of section.anchors.slice(0, 5)) {
        const tag = anchor.verified ? "✓" : "⚠ candidate";
        lines.push(`  [${tag}] ${anchor.kind}: ${anchor.value}`);
      }
    }
    lines.push("");
  }

  if (outline.missingAnchors.length > 0) {
    lines.push("Missing evidence:");
    for (const m of outline.missingAnchors) {
      lines.push(`  - ${m}`);
    }
  }

  return lines.join("\n");
}
