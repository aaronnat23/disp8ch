import { nanoid } from "nanoid";
import { routeToWorkflowWithDetails } from "@/lib/channels/router";
import { defaultChannelAgentId, persistChannelEvent, persistChannelMessage } from "@/lib/channels/transcript";
import {
  applyIngressProvenance,
  buildIngressProvenanceReceipt,
  createProvenance,
  normalizeIngressProvenanceMode,
  type IngressProvenanceMode,
  type ProvenanceRecord,
} from "@/lib/provenance";
import { presentChannelResponse } from "@/lib/channels/presentation";
import { scheduleSessionIndex } from "@/lib/memory/session-watcher";
import { findAcpSessionByLabel, recordAcpSessionTurn, resolveAcpSession } from "@/lib/acp/registry";

export type AcpIngressInput = {
  message: string;
  sessionId?: string | null;
  sessionLabel?: string | null;
  traceId?: string | null;
  actor?: string | null;
  client?: string | null;
  originSessionId?: string | null;
  originTraceId?: string | null;
  provenanceMode?: IngressProvenanceMode | string | null;
  requireExisting?: boolean;
  resetSession?: boolean;
  metadata?: Record<string, unknown> | null;
};

export type AcpIngressResult = {
  sessionId: string;
  response: string;
  workflowId: string | null;
  workflowName: string | null;
  receipt: string | null;
  provenance: ProvenanceRecord;
  metadata: Record<string, unknown>;
};

export async function handleAcpIngress(input: AcpIngressInput): Promise<AcpIngressResult> {
  const now = new Date().toISOString();
  const actor = String(input.actor || "acp-user").trim() || "acp-user";
  const client = String(input.client || "acp-client").trim() || "acp-client";
  const agentId = defaultChannelAgentId();
  const provenanceMode = normalizeIngressProvenanceMode(input.provenanceMode);
  const labelMatch = input.sessionLabel ? findAcpSessionByLabel(input.sessionLabel) : null;
  const session = resolveAcpSession({
    sessionId: input.sessionId || input.originSessionId || labelMatch?.sessionId || (input.sessionLabel ? null : `acp:${nanoid(10)}`),
    sessionLabel: input.sessionLabel,
    actor,
    client,
    provenanceMode,
    requireExisting: Boolean(input.requireExisting),
    resetSession: Boolean(input.resetSession),
    metadata: input.metadata ?? null,
  });
  const sessionId = session.sessionId;

  const ingressProvenance = createProvenance("api", "acp:ingress", {
    traceId: String(input.traceId || "").trim() || undefined,
    channel: "acp",
    sessionId,
    sender: actor,
    ingressProtocol: "acp",
    ingressSessionId: String(input.originSessionId || input.sessionId || sessionId).trim() || sessionId,
    originActor: actor,
    originClient: client,
    originTraceId: String(input.originTraceId || input.traceId || "").trim() || undefined,
    receiptMode: provenanceMode,
    agentId,
    routeSource: "acp-ingress",
  });

  persistChannelMessage({
    sessionId,
    role: "user",
    content: input.message,
    metadata: {
      channel: "acp",
      sender: actor,
      client,
      eventType: "acp-ingress",
      ...(input.metadata ?? {}),
    },
    provenance: ingressProvenance,
    agentId,
    createdAt: now,
  });

  const receipt =
    provenanceMode === "meta+receipt" ? buildIngressProvenanceReceipt(ingressProvenance) : null;
  if (receipt) {
    persistChannelEvent({
      sessionId,
      content: receipt,
      metadata: {
        eventType: "ingress-receipt",
        channel: "acp",
        client,
      },
      provenance: ingressProvenance,
      agentId,
      createdAt: now,
    });
  }

  const routed = await routeToWorkflowWithDetails({
    triggerNodeType: "message-trigger",
    channel: "acp",
    provenance: ingressProvenance,
    ingressModeOverride: provenanceMode,
    triggerData: applyIngressProvenance(
      {
        message: input.message,
        sender: actor,
        sessionId,
        channel: "acp",
        client,
        timestamp: now,
      },
      ingressProvenance,
      provenanceMode,
    ),
  });

  const response = presentChannelResponse(
    "webchat",
    routed.response ?? "No active workflow found to handle this ACP message.",
  );
  const responseMetadata: Record<string, unknown> = {
    routeSource: routed.source,
    channel: "acp",
    client,
  };
  if (routed.workflowId) responseMetadata.workflowId = routed.workflowId;
  if (routed.workflowName) responseMetadata.workflowName = routed.workflowName;

  persistChannelMessage({
    sessionId,
    role: "assistant",
    content: response,
    metadata: responseMetadata,
    provenance: {
      ...ingressProvenance,
      workflowId: routed.workflowId ?? undefined,
      workflowName: routed.workflowName ?? undefined,
      routeSource: routed.source,
    },
    agentId,
    createdAt: now,
  });

  scheduleSessionIndex(sessionId, agentId);
  recordAcpSessionTurn({
    sessionId,
    traceId: ingressProvenance.traceId,
    actor,
    client,
    provenanceMode,
    metadata: input.metadata ?? null,
  });

  return {
    sessionId,
    response,
    workflowId: routed.workflowId,
    workflowName: routed.workflowName,
    receipt,
    provenance: ingressProvenance,
    metadata: responseMetadata,
  };
}
