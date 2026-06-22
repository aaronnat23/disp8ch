import type { ExtensionRuntimeModule } from "@/lib/extensions/runtime";

const githubRuntime: ExtensionRuntimeModule = {
  getPromptContext(context) {
    const defaultOwner = String(context.config.defaultOwner || "");
    const defaultRepo = String(context.config.defaultRepo || "");
    const labelPrefix = String(context.config.labelPrefix || "");
    const lines = [
      "GitHub Ops guidance:",
      "- Use GitHub REST API v3 at https://api.github.com with Bearer token auth.",
      "- Always check X-RateLimit-Remaining; pause if below 5.",
    ];
    if (defaultOwner && defaultRepo) {
      lines.push(`- Default repository: ${defaultOwner}/${defaultRepo}.`);
    }
    if (labelPrefix) {
      lines.push(`- Prefix auto-created labels with: ${labelPrefix}`);
    }
    lines.push("- Link board task IDs in issue bodies for cross-tracking.");
    return lines.join("\n");
  },
  handleCommand(message) {
    if (!/^show\s+github\s+extension\s+status$/i.test(message.trim())) return null;
    return [
      "GitHub Ops",
      "Status: active",
      "API: https://api.github.com",
      "Auth: Bearer token via secrets",
    ].join("\n");
  },
  getStatus() {
    return {
      active: true,
      apiBase: "https://api.github.com",
      authMethod: "bearer",
    };
  },
};

export default githubRuntime;
