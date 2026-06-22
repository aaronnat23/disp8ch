import type { WorkflowNode } from "@/types/workflow";

export type WorkflowNodeConfigField = {
  key: string;
  label: string;
  type: "text" | "textarea" | "number" | "boolean" | "select" | "json" | "credential";
  required?: boolean;
  options?: string[];
  placeholder?: string;
  description?: string;
};

export type WorkflowNodeConfigSpec = {
  type: string;
  title: string;
  category: string;
  fields: WorkflowNodeConfigField[];
  recoveryHints: string[];
};

const COMMON_SPECS: Record<string, WorkflowNodeConfigSpec> = {
  "http-request": {
    type: "http-request",
    title: "HTTP Request",
    category: "tool",
    fields: [
      { key: "method", label: "Method", type: "select", required: true, options: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
      { key: "url", label: "URL", type: "text", required: true, placeholder: "https://api.example.com/resource" },
      { key: "headers", label: "Headers", type: "json" },
      { key: "body", label: "Body", type: "json" },
      { key: "credentialId", label: "Credential", type: "credential" },
    ],
    recoveryHints: ["Check URL validity.", "Confirm method/body pairing.", "Attach a credential if the API returned 401 or 403."],
  },
  "claude-agent": {
    type: "claude-agent",
    title: "Agent",
    category: "agent",
    fields: [
      { key: "systemPrompt", label: "System Prompt", type: "textarea", required: true },
      { key: "modelId", label: "Model", type: "text" },
      { key: "temperature", label: "Temperature", type: "number" },
      { key: "maxTokens", label: "Max Tokens", type: "number" },
      { key: "enabledTools", label: "Enabled Tools", type: "json" },
    ],
    recoveryHints: ["Lower temperature for deterministic steps.", "Increase max tokens if output is truncated.", "Use explicit output contracts for app-facing tasks."],
  },
  "memory-recall": {
    type: "memory-recall",
    title: "Memory Recall",
    category: "memory",
    fields: [
      { key: "query", label: "Query", type: "text", required: true },
      { key: "limit", label: "Limit", type: "number" },
    ],
    recoveryHints: ["Use a narrower query.", "Lower the result limit if context is too large."],
  },
  "send-webchat": {
    type: "send-webchat",
    title: "Send WebChat",
    category: "channel",
    fields: [
      { key: "message", label: "Message", type: "textarea" },
      { key: "format", label: "Format", type: "select", options: ["text", "markdown", "json"] },
    ],
    recoveryHints: ["Map the previous node output into message.", "Keep final responses concise and user-facing."],
  },
  "manual-trigger": {
    type: "manual-trigger",
    title: "Manual Trigger",
    category: "trigger",
    fields: [{ key: "label", label: "Label", type: "text" }],
    recoveryHints: ["Use manual trigger for testing isolated workflows."],
  },
  "webhook-trigger": {
    type: "webhook-trigger",
    title: "Webhook Trigger",
    category: "trigger",
    fields: [
      { key: "path", label: "Path", type: "text", required: true },
      { key: "method", label: "Method", type: "select", options: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
    ],
    recoveryHints: ["Ensure the webhook path is unique.", "Check method matches the calling service."],
  },
};

function readConfig(node: WorkflowNode): Record<string, unknown> {
  const data = (node.data ?? {}) as Record<string, unknown>;
  const config = data.config && typeof data.config === "object" ? (data.config as Record<string, unknown>) : {};
  return { ...config, ...data };
}

export function getWorkflowNodeConfigSpec(type: string): WorkflowNodeConfigSpec {
  const normalized = String(type || "").trim();
  if (COMMON_SPECS[normalized]) return COMMON_SPECS[normalized];
  return {
    type: normalized || "unknown",
    title: normalized || "Unknown Node",
    category: /trigger/i.test(normalized) ? "trigger" : /agent/i.test(normalized) ? "agent" : "tool",
    fields: [
      { key: "label", label: "Label", type: "text" },
      { key: "config", label: "Config", type: "json" },
    ],
    recoveryHints: ["Inspect required fields for this node type.", "Run this node with pinned input before full workflow execution."],
  };
}

export function listWorkflowNodeConfigSpecs(): WorkflowNodeConfigSpec[] {
  return Object.values(COMMON_SPECS).sort((a, b) => a.title.localeCompare(b.title));
}

export function validateWorkflowNodeConfig(node: WorkflowNode): {
  nodeId: string;
  nodeType: string;
  valid: boolean;
  missingFields: string[];
  warnings: string[];
  spec: WorkflowNodeConfigSpec;
} {
  const nodeType = String(node.type || "unknown");
  const spec = getWorkflowNodeConfigSpec(nodeType);
  const config = readConfig(node);
  const missingFields = spec.fields
    .filter((field) => field.required)
    .filter((field) => {
      const value = config[field.key];
      return value === undefined || value === null || String(value).trim() === "";
    })
    .map((field) => field.key);
  const warnings: string[] = [];
  if (nodeType === "http-request" && config.method && !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(String(config.method).toUpperCase())) {
    warnings.push("HTTP method is unusual; confirm this is intentional.");
  }
  if (nodeType === "claude-agent" && Number(config.temperature) > 1) {
    warnings.push("Temperature should usually be between 0 and 1.");
  }
  return {
    nodeId: node.id,
    nodeType,
    valid: missingFields.length === 0,
    missingFields,
    warnings,
    spec,
  };
}

export function suggestNodeErrorRepair(input: {
  node: WorkflowNode;
  error?: string | null;
  output?: Record<string, unknown> | null;
}): { nodeId: string; suggestions: string[] } {
  const spec = getWorkflowNodeConfigSpec(String(input.node.type || "unknown"));
  const error = String(input.error || "").toLowerCase();
  const suggestions = [...spec.recoveryHints];
  if (/401|403|unauthorized|forbidden|credential|token|api key/.test(error)) {
    suggestions.unshift("Attach or test the credential for this node before rerunning.");
  }
  if (/timeout|timed out|rate limit|429/.test(error)) {
    suggestions.unshift("Increase timeout, add retry/backoff, or lower concurrency for this branch.");
  }
  if (/json|parse|schema/.test(error)) {
    suggestions.unshift("Validate the mapped JSON input and pin a known-good sample for this node.");
  }
  return { nodeId: input.node.id, suggestions: Array.from(new Set(suggestions)).slice(0, 6) };
}
