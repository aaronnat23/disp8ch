export type WorkflowNodeLike = {
  id: string;
  type: string;
  data?: Record<string, unknown>;
};

export type CronNodeDetails = {
  nodeId: string;
  label: string;
  expression: string;
  timezone: string;
};

const OUTPUT_CHANNEL_BY_NODE: Record<string, string> = {
  "send-webchat": "webchat",
  "send-whatsapp": "whatsapp",
  "send-telegram": "telegram",
  "send-discord": "discord",
  "send-email": "email",
};

function normalizeChannel(value: unknown): string {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return "webchat";
  return raw;
}

export function parseWorkflowNodes(rawNodes: string): WorkflowNodeLike[] {
  try {
    const parsed = JSON.parse(rawNodes) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: WorkflowNodeLike[] = [];
    for (const node of parsed) {
      if (!node || typeof node !== "object") continue;
      const candidate = node as {
        id?: unknown;
        type?: unknown;
        data?: unknown;
      };
      const id = String(candidate.id ?? "").trim();
      const type = String(candidate.type ?? "").trim();
      if (!id || !type) continue;
      out.push({
        id,
        type,
        data:
          candidate.data && typeof candidate.data === "object"
            ? (candidate.data as Record<string, unknown>)
            : {},
      });
    }
    return out;
  } catch {
    return [];
  }
}

export function workflowUsesAgent(
  nodes: WorkflowNodeLike[],
  agentId: string,
  defaultAgentId: string,
): boolean {
  const agentNodes = nodes.filter((node) => node.type === "claude-agent");
  if (agentNodes.length === 0) return false;

  for (const node of agentNodes) {
    const configured = String(node.data?.agentId ?? "").trim();
    if (configured) {
      if (configured === agentId) return true;
      continue;
    }
    if (agentId === defaultAgentId) return true;
  }
  return false;
}

export function extractTriggerChannels(nodes: WorkflowNodeLike[]): string[] {
  const channels = new Set<string>();
  for (const node of nodes) {
    if (node.type === "message-trigger") {
      channels.add(normalizeChannel(node.data?.channel));
      continue;
    }
    if (node.type === "telegram-trigger") {
      channels.add("telegram");
      continue;
    }
    if (node.type === "discord-trigger") {
      channels.add("discord");
      continue;
    }
    if (node.type === "webhook-trigger") {
      channels.add("webhook");
    }
  }
  return [...channels];
}

export function extractOutputChannels(nodes: WorkflowNodeLike[]): string[] {
  const channels = new Set<string>();
  for (const node of nodes) {
    const channel = OUTPUT_CHANNEL_BY_NODE[node.type];
    if (channel) {
      channels.add(channel);
    }
  }
  return [...channels];
}

export function extractCronNodes(nodes: WorkflowNodeLike[]): CronNodeDetails[] {
  const out: CronNodeDetails[] = [];
  for (const node of nodes) {
    if (node.type !== "cron-trigger") continue;
    const expression =
      String(node.data?.expression ?? "").trim() ||
      String(node.data?.cronExpression ?? "").trim();
    if (!expression) continue;
    out.push({
      nodeId: node.id,
      label: String(node.data?.label ?? "Cron Trigger").trim() || "Cron Trigger",
      expression,
      timezone: String(node.data?.timezone ?? "UTC").trim() || "UTC",
    });
  }
  return out;
}
