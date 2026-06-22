import { create } from "zustand";
import type { MemoryEntry, MemoryStats } from "@/types/memory";

interface MemoryState {
  memories: MemoryEntry[];
  stats: MemoryStats | null;

  setMemories: (memories: MemoryEntry[]) => void;
  setStats: (stats: MemoryStats) => void;
}

export const useMemoryStore = create<MemoryState>((set) => ({
  memories: [],
  stats: null,

  setMemories: (memories) => set({ memories }),
  setStats: (stats) => set({ stats }),
}));
