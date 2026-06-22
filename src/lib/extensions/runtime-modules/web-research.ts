import type { ExtensionRuntimeModule } from "@/lib/extensions/runtime";

const webResearchRuntime: ExtensionRuntimeModule = {
  getPromptContext(context) {
    const maxSources = Number(context.config.maxSources) || 10;
    const requireCitations = context.config.requireCitations !== false;
    const engine = String(context.config.preferredSearchEngine || "auto");
    const lines = [
      "Web Research guidance:",
      `- Target at least 3 and up to ${maxSources} distinct sources per research task.`,
      `- Preferred search engine: ${engine === "auto" ? "use web_search; fall back to arXiv or Semantic Scholar for academic topics" : engine}.`,
    ];
    if (requireCitations) {
      lines.push("- Every factual claim must be backed by a cited source. Never fabricate URLs or paper titles.");
    }
    lines.push("- Check memory for prior findings before hitting the web.");
    lines.push("- Store all findings to memory after each research session.");
    return lines.join("\n");
  },
  handleCommand(message) {
    if (!/^show\s+web.?research\s+extension\s+status$/i.test(message.trim())) return null;
    return [
      "Web Research",
      "Status: active",
      "Sources: web_search, arXiv, Semantic Scholar, CrossRef",
      "Citations: required",
    ].join("\n");
  },
  getStatus() {
    return {
      active: true,
      sources: ["web_search", "arxiv", "semantic-scholar", "crossref"],
      citationsRequired: true,
    };
  },
};

export default webResearchRuntime;
