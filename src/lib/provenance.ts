import os from "node:os";
import { nanoid } from "nanoid";
import { getSqlite, initializeDatabase } from "@/lib/db";

export type ProvenanceKind = "channel" | "workflow" | "board-task" | "cron" | "webhook" | "api";
export const INGRESS_PROVENANCE_MODE_VALUES = ["off", "meta", "meta+receipt"] as const;
export type IngressProvenanceMode = (typeof INGRESS_PROVENANCE_MODE_VALUES)[number];

export type ProvenanceRecord = {
  traceId: string;
  kind: ProvenanceKind;
  source: string;
  createdAt: string;
  ingressProtocol?: string;
  ingressSessionId?: string;
  originActor?: string;
  originClient?: string;
  originTraceId?: string;
  receiptMode?: IngressProvenanceMode;
  channel?: string;
  sessionId?: string;
  sender?: string;
  senderId?: string;
  workflowId?: string;
  workflowName?: string;
  executionId?: string;
  parentExecutionId?: string;
  parentTraceId?: string;
  taskId?: string;
  taskTitle?: string;
  boardId?: string;
  boardName?: string;
  organizationId?: string;
  organizationName?: string;
  goalId?: string;
  goalName?: string;
  checkedOutByAgentId?: string;
  checkedOutByAgentName?: string;
  triggerType?: string;
  routeSource?: string;
  agentId?: string;
  backgroundJobId?: string;
};

export function normalizeIngressProvenanceMode(value: unknown): IngressProvenanceMode {
  const normalized = String(value || "").trim().toLowerCase();
  if ((INGRESS_PROVENANCE_MODE_VALUES as readonly string[]).includes(normalized)) {
    return normalized as IngressProvenanceMode;
  }
  return "meta";
}

export function createTraceId(prefix = "trace"): string {
  return `${prefix}_${nanoid(10)}`;
}

export function createProvenance(
  kind: ProvenanceKind,
  source: string,
  details?: Partial<ProvenanceRecord>,
): ProvenanceRecord {
  return {
    traceId: details?.traceId || createTraceId(kind),
    kind,
    source,
    createdAt: details?.createdAt || new Date().toISOString(),
    ...details,
  };
}

export function withExecutionProvenance(
  provenance: Partial<ProvenanceRecord> | null | undefined,
  details: {
    workflowId: string;
    executionId: string;
    triggerType: string;
  },
): ProvenanceRecord {
  return {
    traceId: provenance?.traceId || createTraceId("exec"),
    kind: provenance?.kind || "workflow",
    source: provenance?.source || "workflow",
    createdAt: provenance?.createdAt || new Date().toISOString(),
    ...provenance,
    workflowId: details.workflowId,
    executionId: details.executionId,
    triggerType: details.triggerType,
  };
}

export function createChildProvenance(
  parent: Partial<ProvenanceRecord> | null | undefined,
  kind: ProvenanceKind,
  source: string,
  details?: Partial<ProvenanceRecord>,
): ProvenanceRecord {
  return createProvenance(kind, source, {
    ...details,
    parentTraceId: parent?.traceId || details?.parentTraceId,
    parentExecutionId: parent?.executionId || details?.parentExecutionId,
  });
}

export function deriveChannelSessionId(
  channel: string,
  triggerData: Record<string, unknown>,
): string | null {
  const provided =
    String(triggerData.sessionId || "").trim() ||
    String(triggerData.sessionKey || "").trim();
  if (provided) return provided;

  switch (channel) {
    case "telegram":
      return triggerData.chatId ? `telegram:${String(triggerData.chatId)}` : null;
    case "discord":
      return triggerData.channelId ? `discord:${String(triggerData.channelId)}` : null;
    case "whatsapp":
      return triggerData.sender ? `whatsapp:${String(triggerData.sender)}` : null;
    case "slack":
      return triggerData.channelId ? `slack:${String(triggerData.channelId)}` : null;
    case "bluebubbles":
      return triggerData.chatGuid
        ? `bluebubbles:${String(triggerData.chatGuid)}`
        : (triggerData.sender ? `bluebubbles:${String(triggerData.sender)}` : null);
    case "teams":
      return triggerData.conversationId ? `teams:${String(triggerData.conversationId)}` : null;
    case "google-chat":
      return triggerData.spaceName ? `google-chat:${String(triggerData.spaceName)}` : null;
    case "webchat":
      return provided || null;
    case "acp":
      return provided || null;
    default:
      return null;
  }
}

export function mergeMetadataWithProvenance(
  metadata: Record<string, unknown> | null | undefined,
  provenance: Partial<ProvenanceRecord> | null | undefined,
): Record<string, unknown> | null {
  if (!metadata && !provenance) return null;
  return {
    ...(metadata ?? {}),
    ...(provenance ? { provenance } : {}),
  };
}

export function formatProvenanceReceipt(provenance: Partial<ProvenanceRecord> | null | undefined): string {
  if (!provenance) return "No provenance recorded.";
  const lines = ["Provenance:"];
  if (provenance.kind) lines.push(`- kind: ${provenance.kind}`);
  if (provenance.source) lines.push(`- source: ${provenance.source}`);
  if (provenance.ingressProtocol) lines.push(`- ingress: ${provenance.ingressProtocol}`);
  if (provenance.originClient) lines.push(`- client: ${provenance.originClient}`);
  if (provenance.originActor) lines.push(`- actor: ${provenance.originActor}`);
  if (provenance.ingressSessionId) lines.push(`- ingress session: ${provenance.ingressSessionId}`);
  if (provenance.channel) lines.push(`- channel: ${provenance.channel}`);
  if (provenance.sessionId) lines.push(`- session: ${provenance.sessionId}`);
  if (provenance.sender) lines.push(`- sender: ${provenance.sender}`);
  if (provenance.workflowName || provenance.workflowId) {
    lines.push(`- workflow: ${provenance.workflowName || provenance.workflowId}`);
  }
  if (provenance.executionId) lines.push(`- execution: ${provenance.executionId}`);
  if (provenance.taskTitle || provenance.taskId) {
    lines.push(`- task: ${provenance.taskTitle || provenance.taskId}`);
  }
  if (provenance.organizationName || provenance.organizationId) {
    lines.push(`- organization: ${provenance.organizationName || provenance.organizationId}`);
  }
  if (provenance.goalName || provenance.goalId) {
    lines.push(`- goal: ${provenance.goalName || provenance.goalId}`);
  }
  if (provenance.checkedOutByAgentName || provenance.checkedOutByAgentId) {
    lines.push(`- claimed by: ${provenance.checkedOutByAgentName || provenance.checkedOutByAgentId}`);
  }
  if (provenance.parentTraceId) lines.push(`- parent trace: ${provenance.parentTraceId}`);
  if (provenance.parentExecutionId) lines.push(`- parent execution: ${provenance.parentExecutionId}`);
  if (provenance.originTraceId) lines.push(`- origin trace: ${provenance.originTraceId}`);
  if (provenance.receiptMode) lines.push(`- receipt mode: ${provenance.receiptMode}`);
  if (provenance.traceId) lines.push(`- trace: ${provenance.traceId}`);
  if (provenance.createdAt) lines.push(`- created: ${provenance.createdAt}`);
  return lines.join("\n");
}

export function getConfiguredIngressProvenanceMode(): IngressProvenanceMode {
  initializeDatabase();
  const db = getSqlite();
  const row = db
    .prepare("SELECT provenance_mode FROM app_config WHERE id = 'default'")
    .get() as { provenance_mode?: string | null } | undefined;
  return normalizeIngressProvenanceMode(row?.provenance_mode);
}

export function buildIngressProvenanceMeta(
  provenance: Partial<ProvenanceRecord> | null | undefined,
): Record<string, string> | null {
  if (!provenance) return null;
  const meta: Record<string, string> = {};
  if (provenance.traceId) meta.traceId = provenance.traceId;
  if (provenance.kind) meta.kind = provenance.kind;
  if (provenance.source) meta.source = provenance.source;
  if (provenance.ingressProtocol) meta.ingressProtocol = provenance.ingressProtocol;
  if (provenance.ingressSessionId) meta.ingressSessionId = provenance.ingressSessionId;
  if (provenance.originActor) meta.originActor = provenance.originActor;
  if (provenance.originClient) meta.originClient = provenance.originClient;
  if (provenance.originTraceId) meta.originTraceId = provenance.originTraceId;
  if (provenance.receiptMode) meta.receiptMode = provenance.receiptMode;
  if (provenance.channel) meta.channel = provenance.channel;
  if (provenance.sessionId) meta.sessionId = provenance.sessionId;
  if (provenance.sender) meta.sender = provenance.sender;
  if (provenance.senderId) meta.senderId = provenance.senderId;
  if (provenance.parentTraceId) meta.parentTraceId = provenance.parentTraceId;
  if (provenance.workflowId) meta.workflowId = provenance.workflowId;
  if (provenance.workflowName) meta.workflowName = provenance.workflowName;
  if (provenance.taskId) meta.taskId = provenance.taskId;
  if (provenance.taskTitle) meta.taskTitle = provenance.taskTitle;
  if (provenance.organizationId) meta.organizationId = provenance.organizationId;
  if (provenance.organizationName) meta.organizationName = provenance.organizationName;
  if (provenance.goalId) meta.goalId = provenance.goalId;
  if (provenance.goalName) meta.goalName = provenance.goalName;
  if (provenance.createdAt) meta.createdAt = provenance.createdAt;
  return Object.keys(meta).length > 0 ? meta : null;
}

export function buildIngressProvenanceReceipt(
  provenance: Partial<ProvenanceRecord> | null | undefined,
): string | null {
  if (!provenance) return null;
  if (provenance.ingressProtocol === "acp") {
    return [
      "[Source Receipt]",
      "bridge=disp8ch-acp",
      `originHost=${os.hostname()}`,
      `acpSessionId=${provenance.sessionId || provenance.ingressSessionId || "unknown"}`,
      `originSessionId=${provenance.ingressSessionId || provenance.sessionId || "unknown"}`,
      `targetSession=${provenance.sessionId || "unknown"}`,
      ...(provenance.originActor ? [`originActor=${provenance.originActor}`] : []),
      ...(provenance.originClient ? [`originClient=${provenance.originClient}`] : []),
      ...(provenance.traceId ? [`traceId=${provenance.traceId}`] : []),
      "[/Source Receipt]",
    ].join("\n");
  }
  const parts: string[] = [];
  if (provenance.ingressProtocol) parts.push(`ingress=${provenance.ingressProtocol}`);
  if (provenance.channel) parts.push(`channel=${provenance.channel}`);
  if (provenance.sessionId) parts.push(`session=${provenance.sessionId}`);
  if (provenance.ingressSessionId) parts.push(`origin-session=${provenance.ingressSessionId}`);
  if (provenance.sender) parts.push(`sender=${provenance.sender}`);
  if (provenance.originActor) parts.push(`actor=${provenance.originActor}`);
  if (provenance.originClient) parts.push(`client=${provenance.originClient}`);
  if (provenance.traceId) parts.push(`trace=${provenance.traceId}`);
  if (provenance.organizationName || provenance.organizationId) {
    parts.push(`organization=${provenance.organizationName || provenance.organizationId}`);
  }
  if (provenance.goalName || provenance.goalId) {
    parts.push(`goal=${provenance.goalName || provenance.goalId}`);
  }
  return parts.length > 0 ? `Ingress provenance receipt: ${parts.join(" | ")}` : null;
}

export function applyIngressProvenance<T extends Record<string, unknown>>(
  triggerData: T,
  provenance: Partial<ProvenanceRecord> | null | undefined,
  mode: IngressProvenanceMode,
): T {
  if (!provenance || mode === "off") return triggerData;
  const systemInputProvenance = buildIngressProvenanceMeta(provenance);
  const provenanceReceipt = mode === "meta+receipt" ? buildIngressProvenanceReceipt(provenance) : null;
  return {
    ...triggerData,
    systemInputProvenance: systemInputProvenance ?? undefined,
    provenanceReceipt: provenanceReceipt ?? undefined,
  };
}
