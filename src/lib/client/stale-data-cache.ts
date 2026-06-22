"use client";

interface StaleEntry<T = unknown> {
  data: T;
  ts: number;
  tab: string;
}

const store = new Map<string, StaleEntry>();

export function setStaleData<T>(tab: string, data: T): void {
  store.set(tab, { data, ts: Date.now(), tab });
}

export function getStaleData<T>(tab: string): T | null {
  const entry = store.get(tab);
  if (!entry) return null;
  return entry.data as T;
}

export function getStaleAge(tab: string): number | null {
  const entry = store.get(tab);
  if (!entry) return null;
  return Date.now() - entry.ts;
}

export function hasStaleData(tab: string): boolean {
  return store.has(tab);
}
