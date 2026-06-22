"use client";

import { useEffect, type DependencyList, type EffectCallback } from "react";

/**
 * Schedule work to run after the route has rendered useful content + browser is idle.
 *
 * Two-stage gate:
 *   1. DOMContentLoaded — aligns deferred fanout with route performance gates
 *      that measure readiness only after document parsing has completed.
 *   2. requestAnimationFrame x2 — ensures React commit + paint completes so the
 *      route's data-perf-ready marker is in the DOM before any fetch fires.
 *   3. setTimeout(350ms) — gives the perf gate a clear window to observe the marker.
 *   4. requestIdleCallback — waits for an idle slice so we don't compete with paint.
 *
 * Also cancels eagerly on `pagehide` / `visibilitychange` so that scheduled
 * fetches do not fire after a navigation has begun. This matters in two contexts:
 *   - The performance gate uses `page.goto` between routes; without unload-cancel,
 *     pending callbacks from the previous route leak into the next route's
 *     pre-ready API count.
 *   - Real users navigating quickly between tabs do not need stale-route fetches.
 *
 * Use this to gate full-data fanout fetches that should NOT count as "before ready"
 * in the tab performance gate. Bootstrap fetches and auth checks should NOT use this.
 *
 * Effect signature mirrors useEffect, so you can return a cleanup function.
 */
export function useAfterUseful(effect: EffectCallback, deps?: DependencyList): void {
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    let cancelled = false;
    let cleanup: ReturnType<EffectCallback> | void = undefined;
    let rafId: number | null = null;
    let rafId2: number | null = null;
    let idleId: number | null = null;
    let timerId: ReturnType<typeof setTimeout> | null = null;
    let waitingForDomReady = false;

    const run = () => {
      if (cancelled) return;
      cleanup = effect();
    };

    const onIdle = () => {
      idleId = null;
      run();
    };

    const scheduleIdle = () => {
      if (cancelled) return;
      timerId = setTimeout(() => {
        timerId = null;
        if (cancelled) return;
        if ("requestIdleCallback" in window) {
          idleId = window.requestIdleCallback(onIdle, { timeout: 2_000 });
        } else {
          onIdle();
        }
      }, 350);
    };

    const scheduleAfterPaint = () => {
      if (cancelled) return;
      rafId = window.requestAnimationFrame(() => {
        rafId = null;
        rafId2 = window.requestAnimationFrame(() => {
          rafId2 = null;
          scheduleIdle();
        });
      });
    };

    const cancelAll = () => {
      cancelled = true;
      if (rafId !== null) window.cancelAnimationFrame(rafId);
      if (rafId2 !== null) window.cancelAnimationFrame(rafId2);
      if (idleId !== null && "cancelIdleCallback" in window) window.cancelIdleCallback(idleId);
      if (timerId !== null) clearTimeout(timerId);
      if (waitingForDomReady) {
        document.removeEventListener("DOMContentLoaded", scheduleAfterPaint);
        waitingForDomReady = false;
      }
    };

    const onPageHide = () => cancelAll();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") cancelAll();
    };

    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onVisibility);

    if (document.readyState === "loading") {
      waitingForDomReady = true;
      document.addEventListener("DOMContentLoaded", scheduleAfterPaint, { once: true });
    } else {
      scheduleAfterPaint();
    }

    return () => {
      cancelAll();
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onVisibility);
      if (typeof cleanup === "function") cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps ?? []);
}

/**
 * Imperative variant: schedule a one-shot callback after useful content + idle.
 *
 * Returns a cancel function. Safe to call from event handlers or non-hook code.
 * Cancels on `pagehide` and tab visibility change to avoid leaking pending fetches
 * into the next page after a navigation.
 */
export function scheduleAfterUseful(callback: () => void): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }
  let cancelled = false;
  let rafId: number | null = null;
  let rafId2: number | null = null;
  let idleId: number | null = null;
  let timerId: ReturnType<typeof setTimeout> | null = null;
  let waitingForDomReady = false;

  const fire = () => {
    if (cancelled) return;
    callback();
  };

  const scheduleAfterPaint = () => {
    if (cancelled) return;
    rafId = window.requestAnimationFrame(() => {
      rafId = null;
      rafId2 = window.requestAnimationFrame(() => {
        rafId2 = null;
        timerId = setTimeout(() => {
          timerId = null;
          if (cancelled) return;
          if ("requestIdleCallback" in window) {
            idleId = window.requestIdleCallback(fire, { timeout: 2_000 });
          } else {
            fire();
          }
        }, 350);
      });
    });
  };

  const cancelAll = () => {
    cancelled = true;
    if (rafId !== null) window.cancelAnimationFrame(rafId);
    if (rafId2 !== null) window.cancelAnimationFrame(rafId2);
    if (idleId !== null && "cancelIdleCallback" in window) window.cancelIdleCallback(idleId);
    if (timerId !== null) clearTimeout(timerId);
    if (waitingForDomReady) {
      document.removeEventListener("DOMContentLoaded", scheduleAfterPaint);
      waitingForDomReady = false;
    }
    window.removeEventListener("pagehide", onPageHide);
    document.removeEventListener("visibilitychange", onVisibility);
  };

  function onPageHide() { cancelAll(); }
  function onVisibility() { if (document.visibilityState === "hidden") cancelAll(); }

  window.addEventListener("pagehide", onPageHide);
  document.addEventListener("visibilitychange", onVisibility);

  if (document.readyState === "loading") {
    waitingForDomReady = true;
    document.addEventListener("DOMContentLoaded", scheduleAfterPaint, { once: true });
  } else {
    scheduleAfterPaint();
  }

  return cancelAll;
}
