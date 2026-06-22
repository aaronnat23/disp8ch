import { nanoid } from "nanoid";
import { getSqlite, initializeDatabase } from "@/lib/db";
import { getDefaultAgent } from "@/lib/agents/registry";
import { scheduleSessionIndex } from "@/lib/memory/session-watcher";
import { mergeMetadataWithProvenance, type ProvenanceRecord } from "@/lib/provenance";

type ChannelTranscriptParams = {
  sessionId: string;
  role: "user" | "assistant" | "system";
  content: string;
  metadata?: Record<string, unknown> | null;
  provenance?: Partial<ProvenanceRecord> | null;
  agentId?: string | null;
  createdAt?: string;
};

export function defaultChannelAgentId(): string {
  try {
    return getDefaultAgent().id;
  } catch {
    return "main";
  }
}

export function persistChannelMessage(params: ChannelTranscriptParams): void {
  initializeDatabase();
  const db = getSqlite();
  const now = params.createdAt ?? new Date().toISOString();
  const agentId = String(params.agentId || defaultChannelAgentId()).trim() || defaultChannelAgentId();
  const mergedMetadata = mergeMetadataWithProvenance(params.metadata, params.provenance);
  db.prepare(
    "INSERT INTO messages (id, session_id, agent_id, role, content, metadata, provenance, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    nanoid(8),
    params.sessionId,
    agentId,
    params.role,
    params.content,
    mergedMetadata ? JSON.stringify(mergedMetadata) : null,
    params.provenance ? JSON.stringify(params.provenance) : null,
    now,
  );
}

export function persistChannelExchange(params: {
  sessionId: string;
  channel: string;
  sender: string;
  userMessage: string;
  assistantMessage: string;
  userMetadata?: Record<string, unknown> | null;
  assistantMetadata?: Record<string, unknown> | null;
  provenance?: Partial<ProvenanceRecord> | null;
  agentId?: string | null;
  createdAt?: string;
}): void {
  const createdAt = params.createdAt ?? new Date().toISOString();
  const agentId = String(params.agentId || defaultChannelAgentId()).trim() || defaultChannelAgentId();

  persistChannelMessage({
    sessionId: params.sessionId,
    role: "user",
    content: params.userMessage,
    metadata: {
      channel: params.channel,
      sender: params.sender,
      ...(params.userMetadata ?? {}),
    },
    provenance: params.provenance,
    agentId,
    createdAt,
  });

  persistChannelMessage({
    sessionId: params.sessionId,
    role: "assistant",
    content: params.assistantMessage,
    metadata: {
      channel: params.channel,
      ...(params.assistantMetadata ?? {}),
    },
    provenance: params.provenance,
    agentId,
    createdAt,
  });

  scheduleSessionIndex(params.sessionId, agentId);
}

export function persistChannelEvent(params: {
  sessionId: string;
  content: string;
  metadata?: Record<string, unknown> | null;
  provenance?: Partial<ProvenanceRecord> | null;
  agentId?: string | null;
  createdAt?: string;
}): void {
  persistChannelMessage({
    sessionId: params.sessionId,
    role: "system",
    content: params.content,
    metadata: {
      eventType: "system-event",
      ...(params.metadata ?? {}),
    },
    provenance: params.provenance,
    agentId: params.agentId,
    createdAt: params.createdAt,
  });
}
