"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

export function useIdlePrefetch(routes: string[]) {
  const router = useRouter();
  const prefetchedRef = useRef(new Set<string>());
  const startTimeRef = useRef(Date.now());

  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;

    const MIN_PAGE_VISIBLE_MS = 2_500;
    const PREFETCH_SPACING_MS = 1_000;
    const MAX_AUTO_PREFETCH = 3;
    let idleId: number | null = null;
    let timerId: ReturnType<typeof setTimeout> | null = null;
    const timeoutRef = { current: null as ReturnType<typeof setTimeout> | null };

    const doPrefetch = (url: string) => {
      if (document.visibilityState !== "visible") return;
      if (prefetchedRef.current.has(url)) return;
      prefetchedRef.current.add(url);
      router.prefetch(url);
    };

    const prefetchSequential = (remaining: string[]) => {
      if (remaining.length === 0) return;
      const [next, ...rest] = remaining;
      doPrefetch(next);
      timeoutRef.current = setTimeout(() => prefetchSequential(rest), PREFETCH_SPACING_MS);
    };

    const prefetchRemaining = () => {
      const elapsed = Date.now() - startTimeRef.current;
      if (elapsed < MIN_PAGE_VISIBLE_MS) {
        timerId = setTimeout(prefetchLowPriority, MIN_PAGE_VISIBLE_MS - elapsed);
        return;
      }

      if (document.visibilityState !== "visible") return;
      prefetchSequential(routes.slice(0, MAX_AUTO_PREFETCH));
    };

    const prefetchLowPriority = () => {
      if ("requestIdleCallback" in window) {
        idleId = window.requestIdleCallback(prefetchRemaining, { timeout: 5_000 });
      } else {
        timerId = setTimeout(prefetchRemaining, 2_000);
      }
    };

    timerId = setTimeout(prefetchLowPriority, MIN_PAGE_VISIBLE_MS);

    return () => {
      if (timerId) clearTimeout(timerId);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      if (idleId && "cancelIdleCallback" in window) {
        window.cancelIdleCallback(idleId);
      }
    };
  }, [router, routes]);
}
