export interface ChannelMessage {
  id: string;
  channel: "whatsapp" | "webchat" | "telegram" | "discord" | "google-chat";
  sender: string;
  content: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface ChannelConfig {
  id: string;
  type: "whatsapp" | "webchat" | "telegram" | "discord" | "google-chat";
  name: string;
  config: Record<string, unknown>;
  isActive: boolean;
  createdAt: string;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  content: string;
  metadata?: {
    model?: string;
    tokens?: number;
    tokensUsed?: number;
    tokensIn?: number;
    tokensOut?: number;
    costUsd?: number;
    duration?: number;
    workflowId?: string;
    eventType?: string;
    channel?: string;
    client?: string;
  } & Record<string, unknown>;
  provenance?: Record<string, unknown> | null;
  createdAt: string;
}

export interface ChatSession {
  id: string;
  title: string;
  lastMessage: string;
  createdAt: string;
  updatedAt: string;
}
