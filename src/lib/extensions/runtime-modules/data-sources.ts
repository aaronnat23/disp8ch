import { listDocuments } from "@/lib/documents/store";
import type { ExtensionRuntimeModule } from "@/lib/extensions/runtime";

const dataSourcesRuntime: ExtensionRuntimeModule = {
  getPromptContext() {
    return "Data source guidance:\n- Prefer stored data sources and crawled docs before broad web search when the user already provided source material.";
  },
  handleCommand(message) {
    if (!/^show\s+data\s+sources\s+extension\s+status$/i.test(message.trim())) return null;
    const docs = listDocuments();
    return `Data Sources\nStored sources: ${docs.length}`;
  },
  getStatus() {
    const docs = listDocuments();
    return {
      sourceCount: docs.length,
      recentSource: docs[0]?.name ?? null,
    };
  },
};

export default dataSourcesRuntime;
