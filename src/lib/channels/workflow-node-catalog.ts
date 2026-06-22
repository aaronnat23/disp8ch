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
      { type: "parallel-agents", label: "Parallel Agents", configFields: [], description: "Run multiple agents in parallel and collect results" },
      { type: "call-workflow", label: "Call Workflow", configFields: ["workflowId"], description: "Execute another workflow as a sub-workflow" },
      { type: "http-request", label: "HTTP Request", configFields: ["url", "method", "body", "headers"], description: "Make an HTTP API call" },
      { type: "run-code", label: "Run Code", configFields: ["code", "language"], description: "Execute JavaScript or Python code" },
      { type: "board-task", label: "Board Task", configFields: ["action", "boardId", "title", "description", "priority", "status"], description: "Create, update, or query board tasks" },
      { type: "memory-store", label: "Memory Store", configFields: ["extractMode", "manualContent", "type"], description: "Store information in persistent memory" },
      { type: "memory-recall", label: "Memory Recall", configFields: ["query", "limit"], description: "Search and retrieve from memory" },
      { type: "document-tool", label: "Document Tool", configFields: ["action"], description: "Search, read, or manage documents" },
      { type: "system-command", label: "System Command", configFields: ["command"], description: "Execute a system command (with safety checks)" },
      { type: "date-time", label: "Date Time", configFields: [], description: "Get current date/time information" },
    ],
    transform: [
      { type: "set-variables", label: "Set Variables", configFields: ["assignments"], description: "Set workflow variables from expressions or static values" },
      { type: "json-transform", label: "JSON Transform", configFields: ["transform"], description: "Transform JSON data using a template" },
      { type: "split-text", label: "Split Text", configFields: ["separator"], description: "Split text into an array by separator" },
      { type: "regex-extract", label: "Regex Extract", configFields: ["pattern"], description: "Extract matches from text using regex" },
      { type: "aggregate", label: "Aggregate", configFields: [], description: "Aggregate multiple inputs into a single output" },
      { type: "merge", label: "Merge", configFields: [], description: "Merge multiple branches into one" },
    ],
    condition: [
      { type: "if-else", label: "If/Else", configFields: ["condition"], description: "Branch based on a condition expression. Outputs: true, false" },
      { type: "switch", label: "Switch", configFields: ["expression"], description: "Branch based on multiple cases" },
      { type: "filter", label: "Filter", configFields: ["condition"], description: "Filter items based on a condition" },
      { type: "loop", label: "Loop", configFields: ["maxIterations"], description: "Loop over items or repeat until condition. Source handles: body, complete" },
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
  lines.push("- **Sub-workflow**: manual-trigger → call-workflow → send-webchat");
  lines.push("");

  lines.push("## Confirmation Boundaries");
  lines.push("");
  lines.push("- All channel output nodes (send-*) require the workflow to be explicitly saved before running.");
  lines.push("- Nodes that mutate state (board-task, memory-store, http-request, run-code, system-command) have risk tier 'moderate' or 'high'.");
  lines.push("- Workflows with side-effect nodes require confirmation before execution from WebChat.");
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
