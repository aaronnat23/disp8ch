export type MemoryType =
  | "fact"
  | "preference"
  | "entity"
  | "decision"
  | "correction"
  | "relationship"
  | "skill"
  | "observation"
  | "profile"
  | "event"
  | "knowledge"
  | "behavior"
  | "tool";

export interface MemoryEntry {
  id: string;
  type: MemoryType;
  content: string;
  confidence: number;
  source: string;
  tags: string[];
  created: string;
  updated: string;
  contentHash?: string;
  reinforcementCount?: number;
  lastReinforcedAt?: string;
  whenToUse?: string;
  happenedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface MemoryConfig {
  id: string;
  /** Kept in DB for schema compat but ignored at runtime — system is now unified. */
  tier?: string;
  autoThreshold: number;
  totalMemories: number;
  storageBytes: number;
  updatedAt: string;
  embeddingModel: string;       // model_id, "auto", "disabled", or local/local-only embedding spec
  vectorWeight: number;         // 0.0–1.0, weight for vector score in hybrid merge
  textWeight: number;           // 0.0–1.0, weight for BM25 score in hybrid merge
  indexSessions: boolean;       // whether to index session transcripts (off by default)
  sessionChunkTokens: number;   // approximate tokens per session chunk (default 400)
  sessionChunkOverlap: number;  // overlap tokens between chunks (default 80)
  startupIncludeFiles: string[] | null; // null = use all defaults
}

export interface MemoryStats {
  totalMemories: number;
  storageBytes: number;
  /** Always "unified" — tier system removed. */
  tier: "unified";
  /** Always "unified" — tier system removed. */
  currentMode: "unified";
  autoThreshold: number;
  workspaceMemoryFiles?: number;
  embeddingModel: string | null;  // active embedding model id, or null = FTS5-only
  vectorIndexed: number;          // count of atomic entries with cached embeddings
  sessionChunks: number;          // total indexed session transcript chunks
}
