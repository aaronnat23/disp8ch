import type { ExtensionRuntimeModule } from "@/lib/extensions/runtime";

const memoryLancedbRuntime: ExtensionRuntimeModule = {
  getPromptContext(context) {
    const autoCapture = context.config.autoCapture === true;
    const autoRecall = context.config.autoRecall !== false;
    const dbPath = String(context.config.dbPath || "data/lancedb/");
    const lines = [
      "Memory LanceDB guidance:",
      `- LanceDB vector backend active at: ${dbPath}`,
      `- Auto-capture: ${autoCapture ? "enabled — conversation context stored automatically" : "disabled — use memory_store explicitly"}.`,
      `- Auto-recall: ${autoRecall ? "enabled — relevant memories injected at session start" : "disabled — use memory_search explicitly"}.`,
      "- For high-volume workloads, LanceDB outperforms sqlite-vec significantly. Prefer batch memory operations.",
    ];
    return lines.join("\n");
  },
  handleCommand(message) {
    if (!/^show\s+memory.?lancedb\s+extension\s+status$/i.test(message.trim())) return null;
    return [
      "Memory LanceDB",
      "Status: active",
      "Backend: LanceDB columnar vector store",
      "Use case: high-volume embedding workloads",
    ].join("\n");
  },
  getStatus() {
    return {
      active: true,
      backend: "lancedb",
      format: "lance-columnar",
    };
  },
};

export default memoryLancedbRuntime;
