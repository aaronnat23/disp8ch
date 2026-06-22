"use client";

import { useEffect, type ComponentType } from "react";
import { rememberLoadedTab } from "@/components/perf/tab-route-shell";

type LoadedTab = { default: ComponentType<Record<string, unknown>> };
type TabPayloadLoader = () => Promise<LoadedTab>;

const TAB_PAYLOADS: Record<string, TabPayloadLoader> = {
  dashboard: () => import("@/app/(operator)/client-page"),
  chat: () => import("@/app/(operator)/chat/client-page"),
  hierarchy: () => import("@/app/(operator)/hierarchy/client-page"),
};

const warmedTabs = new Set<string>();
const warmingTabs = new Map<string, Promise<void>>();

function warmTabPayload(marker: string) {
  if (warmedTabs.has(marker)) return Promise.resolve();
  const existing = warmingTabs.get(marker);
  if (existing) return existing;

  const load = TAB_PAYLOADS[marker];
  if (!load) return Promise.resolve();

  const promise = load()
    .then((mod) => {
      rememberLoadedTab(marker, mod.default);
      warmedTabs.add(marker);
    })
    .catch(() => {
      warmedTabs.delete(marker);
    })
    .finally(() => {
      warmingTabs.delete(marker);
    });

  warmingTabs.set(marker, promise);
  return promise;
}

// Auto-warm has been removed. Empirically, eagerly importing the hot-tab
// modules + their bootstrap endpoints on every operator-layout mount cost more
// CPU/network than it saved, and warmed bootstrap calls were repeatedly hitting
// the server on every navigation. After first visit each tab is already cached
// in `loadedTabs`; future visits are instant from that cache. We now warm only
// in response to explicit `disp8ch:preload-tab` events (hover/focus/click).

export function TabPayloadWarmup() {
  useEffect(() => {
    const handlePreload = (event: Event) => {
      const marker = (event as CustomEvent<{ marker?: string }>).detail?.marker;
      if (marker) void warmTabPayload(marker);
    };
    window.addEventListener("disp8ch:preload-tab", handlePreload as EventListener);
    return () => {
      window.removeEventListener("disp8ch:preload-tab", handlePreload as EventListener);
    };
  }, []);

  return null;
}
