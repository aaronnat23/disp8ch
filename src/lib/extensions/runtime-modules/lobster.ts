import type { ExtensionRuntimeModule } from "@/lib/extensions/runtime";

const lobsterRuntime: ExtensionRuntimeModule = {
  getPromptContext(context) {
    const autoApprove = context.config.autoApprove === true;
    const timeoutSecs = Number(context.config.defaultApprovalTimeout) || 300;
    const resumeTtl = Number(context.config.resumeTokenTtlHours) || 24;
    const lines = [
      "Lobster Workflows guidance:",
      "- Design pipelines as typed linear steps with explicit approval gates.",
      `- Approval gates: use wait-for-input nodes. Default timeout: ${timeoutSecs}s.`,
      `- Resume tokens expire after ${resumeTtl}h. Store them in memory if the user may resume later.`,
    ];
    if (autoApprove) {
      lines.push("- Auto-approve mode is ON — approval gates are bypassed automatically.");
    } else {
      lines.push("- Always surface approval prompts to the user before executing irreversible actions.");
    }
    lines.push("- Make every pipeline step idempotent so resumed workflows produce consistent results.");
    return lines.join("\n");
  },
  handleCommand(message) {
    if (!/^show\s+lobster\s+extension\s+status$/i.test(message.trim())) return null;
    return [
      "Lobster Workflows",
      "Status: active",
      "Pattern: typed approval-gated pipelines",
      "Resume tokens: supported",
    ].join("\n");
  },
  getStatus() {
    return {
      active: true,
      pattern: "approval-gated-pipeline",
      resumable: true,
    };
  },
};

export default lobsterRuntime;
