import type { ToolDefinition } from "@/lib/engine/tools";

export const WORKFLOW_NODE_CATALOG_TOOL: ToolDefinition = {
  name: "workflow_node_catalog",
  description: "Returns the complete catalog of available workflow node types with their categories, config fields, and common patterns. Use this for workflow design to get exact node types instead of inventing generic names.",
  parameters: {
    type: "object",
    properties: {
      category: {
        type: "string",
        description: "Optional filter: 'trigger', 'action', 'transform', 'condition', 'llm', 'app_tool', 'terminal', 'all' (default: all)",
      },
    },
    required: [],
  },
};

export function buildWorkflowNodeCatalogResult(filter?: string): string {
  const categories: Record<string, Array<{ type: string; label: string; configFields: string[]; description: string }>> = {
    trigger: [
      { type: "manual-trigger", label: "Manual Trigger", configFields: [], description: "Start workflow manually from UI or API" },
      { type: "message-trigger", label: "Message Trigger", configFields: ["channel"], description: "Trigger on incoming channel message (webchat, telegram, discord, whatsapp)" },
      { type: "webhook-trigger", label: "Webhook Trigger", configFields: ["path", "method"], description: "Trigger on incoming HTTP webhook" },
      { type: "cron-trigger", label: "Cron Trigger", configFields: ["expression", "timezone"], description: "Trigger on a cron schedule" },
    ],
    action: [
      { type: "claude-agent", label: "Claude Agent", configFields: ["systemPrompt", "temperature", "maxTokens", "agentId"], description: "LLM agent with system prompt and tool access" },
      { type: "integration-agent", label: "Integration Agent", configFields: ["service", "systemPrompt"], description: "Agent configured for external service integration" },
      { type: "parallel-agents", label: "Parallel Agents", configFields: ["workers", "taskTemplate", "maxParallel"], description: "Run configured LLM agent workers concurrently and collect reports; workers cannot contain rss-read, http-request, or other workflow subnodes" },
      { type: "call-workflow", label: "Call Workflow", configFields: ["workflowId"], description: "Execute another workflow as a sub-workflow" },
      { type: "http-request", label: "HTTP Request", configFields: ["url", "method", "body", "headers", "timeoutMs"], description: "Make an HTTP API call; GET is an external read while write methods can mutate the remote service" },
      { type: "rss-read", label: "RSS Read", configFields: ["url", "limit", "sinceHours", "timeoutMs"], description: "Read and parse an RSS or Atom feed" },
      { type: "run-code", label: "Run Code", configFields: ["code", "timeout"], description: "Execute JavaScript in the workflow sandbox" },
      { type: "board-task", label: "Board Task", configFields: ["action", "boardId", "taskId", "title", "description", "query", "priority", "status", "organizationId", "goalId", "assignedAgentId", "limit"], description: "List, get, create, update, delete, claim, or release board tasks. Priorities: low, medium, high, urgent" },
      { type: "memory-store", label: "Memory Store", configFields: ["extractMode", "manualContent", "type", "memoryAccess", "reviewBeforeSaving"], description: "Store information in persistent memory or propose it for review. extractMode: auto/manual; type: fact/preference/note; memoryAccess: workflow/agent; reviewBeforeSaving: off/on" },
      { type: "memory-recall", label: "Memory Recall", configFields: ["query", "limit", "mode", "memoryAccess"], description: "Search and retrieve from memory. mode: search/gpt; memoryAccess: workflow/agent" },
      { type: "document-tool", label: "Document Tool", configFields: ["action"], description: "Search, read, or manage documents" },
      { type: "system-command", label: "System Command", configFields: ["command"], description: "Execute a system command (with safety checks)" },
      { type: "date-time", label: "Date Time", configFields: [], description: "Get current date/time information" },
      { type: "workflow-template", label: "Workflow Template", configFields: ["action", "template", "name", "description"], description: "List templates/workflows or create from a built-in template" },
      { type: "scheduler-job", label: "Scheduler Job", configFields: ["action", "workflowId", "workflowName"], description: "List jobs, resync the scheduler, or run a scheduled workflow now" },
    ],
    transform: [
      { type: "set-variables", label: "Set Variables", configFields: ["assignments"], description: "Set workflow variables from expressions or static values" },
      { type: "json-transform", label: "JSON Transform", configFields: ["expression", "transform"], description: "Map, filter, or reshape JSON data" },
      { type: "split-text", label: "Split Text", configFields: ["text", "mode", "chunkSize", "separator"], description: "Split text into chunks" },
      { type: "regex-extract", label: "Regex Extract", configFields: ["text", "pattern", "flags"], description: "Extract regular-expression matches from text" },
      { type: "compare-text", label: "Compare Text", configFields: ["textA", "textB"], description: "Compare two text values line by line" },
      { type: "aggregate", label: "Aggregate", configFields: ["aggregateBy", "outputField"], description: "Collect incoming items into a single array" },
      { type: "merge", label: "Merge", configFields: ["mergeMode", "requiredSources", "outputShape"], description: "Wait for and combine upstream branches. mergeMode: wait-all, first-complete, or wait-required. outputShape: merged-object, by-node-id, by-label, or array. requiredSources is only for wait-required" },
    ],
    condition: [
      { type: "if-else", label: "If/Else", configFields: ["condition"], description: "Branch using a safe condition over upstream fields. Outputs: true, false" },
      { type: "switch", label: "Switch", configFields: ["expression", "cases"], description: "Branch based on multiple cases" },
      { type: "filter", label: "Filter", configFields: ["condition"], description: "Filter items based on a condition" },
      { type: "loop", label: "Loop", configFields: ["sourcePath", "maxIterations", "concurrency", "onItemError"], description: "Loop over an array at a context path such as run.result.items (no $. prefix). onItemError: stop, skip, or collect. Source handles: body, output (done)" },
      { type: "delay", label: "Delay", configFields: ["durationMs"], description: "Pause execution for a bounded interval" },
      { type: "rate-limiter", label: "Rate Limiter", configFields: ["key", "maxCalls", "windowMs"], description: "Throttle downstream execution" },
      { type: "error-handler", label: "Error Handler", configFields: [], description: "Route an incoming error payload to success/error handles. Put retryCount, retryDelayMs, and continueOnFail on the node that can fail; this handler does not retry its upstream node" },
      { type: "wait-for-input", label: "Wait For Input", configFields: ["prompt", "timeout"], description: "Pause for explicit user input" },
    ],
    terminal: [
      { type: "send-webchat", label: "Send WebChat", configFields: ["message"], description: "Send message to WebChat user. Supports {{template}} expressions." },
      { type: "send-telegram", label: "Send Telegram", configFields: ["message", "chatId"], description: "Send message to Telegram" },
      { type: "send-discord", label: "Send Discord", configFields: ["message", "channelId"], description: "Send message to Discord" },
      { type: "send-whatsapp", label: "Send WhatsApp", configFields: ["message", "to"], description: "Send message to WhatsApp" },
      { type: "send-slack", label: "Send Slack", configFields: ["message", "channelId"], description: "Send message to Slack" },
      { type: "send-email", label: "Send Email", configFields: ["to", "subject", "body", "host", "port"], description: "Send an email" },
      { type: "send-teams", label: "Send Teams", configFields: ["message"], description: "Send message to Microsoft Teams" },
      { type: "notification", label: "Notification", configFields: ["message", "type"], description: "Show a notification in the app" },
    ],
  };

  const selectedCategories = filter && filter !== "all"
    ? { [filter]: categories[filter] || [] }
    : categories;

  const lines: string[] = ["# Workflow Node Catalog", ""];

  for (const [cat, nodes] of Object.entries(selectedCategories)) {
    if (!nodes || nodes.length === 0) continue;
    lines.push(`## ${cat.charAt(0).toUpperCase() + cat.slice(1)} Nodes`);
    lines.push("");
    for (const node of nodes) {
      const fields = node.configFields.length > 0 ? `Config: ${node.configFields.join(", ")}` : "No config required";
      lines.push(`- **${node.type}** (${node.label}): ${node.description}. ${fields}`);
    }
    lines.push("");
  }

  lines.push("## Common Patterns");
  lines.push("");
  lines.push("- **Simple chat**: manual-trigger → claude-agent → send-webchat");
  lines.push("- **Webhook handler**: webhook-trigger → run-code → send-webchat");
  lines.push("- **Scheduled report**: cron-trigger → claude-agent → send-webchat");
  lines.push("- **Branch on condition**: message-trigger → claude-agent → if-else → (true: send-webchat, false: send-webchat)");
  lines.push("- **Parallel workers**: manual-trigger → parallel-agents → aggregate → send-webchat");
  lines.push("- **Multiple known feeds**: cron-trigger → (rss-read A, rss-read B, rss-read C) → merge (wait-all, array) → run-code");
  lines.push("- **Sub-workflow**: manual-trigger → call-workflow → send-webchat");
  lines.push("");

  lines.push("## Confirmation Boundaries");
  lines.push("");
  lines.push("- All channel output nodes (send-*) require the workflow to be explicitly saved before running.");
  lines.push("- Persisting board-task actions, memory-store, send-* nodes, write-file, and remote-write HTTP methods are side effects. RSS reads and HTTP GET are external reads, not state mutations.");
  lines.push("- Design-only requests never save, activate, schedule, execute, send, or persist deduplication state. Saving/activation and any first execution are separate operator boundaries.");
  lines.push("");

  lines.push("## Source References");
  lines.push("");
  lines.push("- Node contracts: src/lib/engine/node-contracts.ts");
  lines.push("- Node registry: src/lib/engine/node-registry.ts");
  lines.push("- Linter: src/lib/engine/linter.ts");
  lines.push("- Workflow templates: src/app/api/workflows/route.ts");
  lines.push("- Tool catalog: src/lib/engine/tools.ts");

  return lines.join("\n");
}
