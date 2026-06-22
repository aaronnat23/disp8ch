"use client";

import { useCallback, useEffect, useRef } from "react";

export interface PollingOptions {
  intervalMs: number;
  enabled?: boolean;
  pauseWhenHidden?: boolean;
  backoffOnError?: boolean;
  maxBackoffMs?: number;
  immediate?: boolean;
}

type PollFn = () => Promise<void> | void;

export function usePolling(
  fn: PollFn,
  deps: unknown[],
  opts: PollingOptions,
) {
  const {
    intervalMs,
    enabled = true,
    pauseWhenHidden = true,
    backoffOnError = true,
    maxBackoffMs = intervalMs * 4,
    immediate = false,
  } = opts;

  const inFlightRef = useRef(false);
  const backoffRef = useRef(intervalMs);
  const visibleRef = useRef(
    typeof document !== "undefined" ? document.visibilityState === "visible" : true,
  );

  const tick = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      await fn();
      backoffRef.current = intervalMs;
    } catch {
      if (backoffOnError) {
        backoffRef.current = Math.min(backoffRef.current * 2, maxBackoffMs);
      }
    } finally {
      inFlightRef.current = false;
    }
  }, [fn, intervalMs, backoffOnError, maxBackoffMs]);

  useEffect(() => {
    if (!enabled) return;

    let mounted = true;
    let timeoutId: ReturnType<typeof setTimeout>;

    const handleVisibility = () => {
      visibleRef.current = document.visibilityState === "visible";
    };

    // pagehide fires when the browser is about to commit a navigation (including
    // Playwright's page.goto between gate routes). Stop polling immediately so
    // pending timers don't fire after navigation and leak into the next route's
    // request count.
    const handlePageHide = () => {
      mounted = false;
      clearTimeout(timeoutId);
    };

    handleVisibility();
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("pagehide", handlePageHide);

    const doTick = async () => {
      if (!mounted) return;
      if (pauseWhenHidden && !visibleRef.current) {
        timeoutId = setTimeout(doTick, backoffRef.current);
        return;
      }
      await tick();
      if (mounted) {
        timeoutId = setTimeout(doTick, backoffRef.current);
      }
    };

    if (immediate) {
      doTick();
    } else {
      timeoutId = setTimeout(doTick, backoffRef.current);
    }

    return () => {
      mounted = false;
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("pagehide", handlePageHide);
      clearTimeout(timeoutId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...deps]);
}
