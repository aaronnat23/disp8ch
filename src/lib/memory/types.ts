export type { MemoryType, MemoryEntry, MemoryConfig, MemoryStats } from "@/types/memory";

export interface Message {
  role: "user" | "assistant";
  content: string;
}

export interface MemoryProvider {
  store(entry: import("@/types/memory").MemoryEntry): Promise<import("@/types/memory").MemoryEntry>;
  search(query: string, limit?: number): Promise<import("@/types/memory").MemoryEntry[]>;
  getAll(): Promise<import("@/types/memory").MemoryEntry[]>;
  get(id: string): Promise<import("@/types/memory").MemoryEntry | null>;
  update(id: string, content: string): Promise<void>;
  delete(id: string): Promise<void>;
  extract(messages: Message[]): Promise<import("@/types/memory").MemoryEntry[]>;
  compress(messages: Message[]): Promise<string | null>;
  getStats(): Promise<import("@/types/memory").MemoryStats>;
}
