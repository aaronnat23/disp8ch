"use client";

import { useEffect, useRef, useState } from "react";
import { cachedJson, APP_TTL } from "@/lib/client/app-data-cache";

// ── Types ────────────────────────────────────────────────────────────────────

type RequestCategory = "critical" | "warm" | "on-demand";

interface DataRequest<T = unknown> {
  key: string;
  url: string;
  category: RequestCategory;
  ttlMs?: number;
  transform?: (data: unknown) => T;
}

interface PageDataState {
  criticalReady: boolean;
  warmReady: boolean;
  allReady: boolean;
  allData: Map<string, unknown>;
  errors: Map<string, string>;
  pendingCount: number;
}

function ttlForUrl(url: string): number {
  for (const [prefix, ttl] of Object.entries(APP_TTL)) {
    if (url.includes(prefix)) return ttl;
  }
  return 10_000;
}

// ── Hook ─────────────────────────────────────────────────────────────────────

/**
 * Mount-only bootstrap data loader.
 * Critical requests fire immediately. Warm requests fire after 50ms delay.
 * On-demand requests are never auto-loaded (call cachedJson directly).
 *
 * Requests array identity should be stable (use useMemo or module-level const).
 */
export function usePageData(requests: DataRequest[]): PageDataState {
  const [state, setState] = useState<PageDataState>({
    criticalReady: false,
    warmReady: false,
    allReady: false,
    allData: new Map(),
    errors: new Map(),
    pendingCount: 0,
  });

  const criticalDone = useRef(false);
  const warmDone = useRef(false);
  const mountedRef = useRef(true);
  const warmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    const critical = requests.filter((r) => r.category === "critical");
    const warm = requests.filter((r) => r.category === "warm");
    const onDemand = requests.filter((r) => r.category === "on-demand");

    const allData = new Map<string, unknown>();
    const errors = new Map<string, string>();
    let criticalComplete = 0;
    let warmComplete = 0;

    function updateState() {
      if (!mountedRef.current) return;
      const criticalReady = criticalComplete >= critical.length;
      const warmReady = warmComplete >= warm.length;
      setState({
        criticalReady,
        warmReady,
        allReady: criticalReady && warmReady,
        allData: new Map(allData),
        errors: new Map(errors),
        pendingCount: Math.max(
          0,
          critical.length - criticalComplete + warm.length - warmComplete,
        ),
      });
    }

    function loadOne(req: DataRequest, label: "critical" | "warm") {
      const ttl = req.ttlMs ?? ttlForUrl(req.url);
      cachedJson<unknown>(req.key, req.url, ttl)
        .then((json) => {
          const value = req.transform ? req.transform(json) : json;
          allData.set(req.key, value);
        })
        .catch((err) => {
          errors.set(req.key, String(err));
        })
        .finally(() => {
          if (label === "critical") criticalComplete++;
          else warmComplete++;
          updateState();
        });
    }

    // Phase 1: Critical — load immediately
    for (const req of critical) {
      loadOne(req, "critical");
    }

    // Phase 2: Warm — load after 50ms delay (post first paint)
    if (warm.length > 0) {
      warmTimerRef.current = setTimeout(() => {
        for (const req of warm) {
          loadOne(req, "warm");
        }
      }, 50);
    }

    // Phase 3: On-demand — exposes a getter, but never auto-loads
    // (callers can use cachedJson directly for these)

    // If no requests at all, mark ready
    if (critical.length === 0 && warm.length === 0) {
      setState((s) => ({ ...s, criticalReady: true, warmReady: true, allReady: true }));
    }

    return () => {
      mountedRef.current = false;
      if (warmTimerRef.current) {
        clearTimeout(warmTimerRef.current);
        warmTimerRef.current = null;
      }
    };
    // Only run on mount; requests array identity is expected to be stable
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return state;
}

// ── Helper: create a standardized request array for a tab ────────────────────

export function createBootstrapRequests(
  bootstrapUrl: string,
): DataRequest[] {
  return [
    { key: "bootstrap", url: bootstrapUrl, category: "critical", ttlMs: 3_000 },
  ];
}

export function createSecondaryRequests(
  requests: Omit<DataRequest, "category">[],
): DataRequest[] {
  return requests.map((r) => ({ ...r, category: "warm" as RequestCategory }));
}

export type { DataRequest, RequestCategory, PageDataState };
