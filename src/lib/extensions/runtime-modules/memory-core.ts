import { getMemorySearchManager } from "@/lib/memory/manager";
import type { ExtensionRuntimeModule } from "@/lib/extensions/runtime";

const memoryCoreRuntime: ExtensionRuntimeModule = {
  getPromptContext(context) {
    const preferSessionIndexing = context.config.preferSessionIndexing !== false;
    return [
      "Memory guidance:",
      "- Prefer durable facts, decisions, and source-backed observations over transient chatter.",
      preferSessionIndexing
        ? "- Session indexing is expected to stay on for long-running agent work."
        : "- Session indexing may be limited, so summarize important carry-over explicitly.",
    ].join("\n");
  },
  handleCommand(message) {
    if (!/^show\s+memory(?:-core)?\s+extension\s+status$/i.test(message.trim())) return null;
    const runtime = getMemorySearchManager().getRuntimeStatus();
    const sessions = runtime.sessions;
    return [
      "Memory Core",
      `Dirty sessions: ${Number(sessions.pending.length || 0)}`,
      `Last sync reason: ${String(runtime.lastSyncReason || "n/a")}`,
    ].join("\n");
  },
  getStatus() {
    const runtime = getMemorySearchManager().getRuntimeStatus();
    return {
      sessions: runtime.sessions,
      lastSyncReason: runtime.lastSyncReason,
    };
  },
};

export default memoryCoreRuntime;
