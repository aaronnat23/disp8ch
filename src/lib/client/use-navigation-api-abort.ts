"use client";

import { useEffect, useRef } from "react";

const PATCH_KEY = "__disp8chAbortableFetch";

type FetchPatchState = {
  originalFetch: typeof window.fetch;
  controllers: Set<AbortController>;
  abortAll: () => void;
};

function shouldAttachAbort(input: RequestInfo | URL, init?: RequestInit): boolean {
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  if (method.toUpperCase() !== "GET") return false;
  if (init?.signal) return false;
  const rawUrl = input instanceof Request ? input.url : String(input);
  let url: URL;
  try {
    url = new URL(rawUrl, window.location.origin);
  } catch {
    return false;
  }
  return url.origin === window.location.origin && url.pathname.startsWith("/api/");
}

function installAbortableFetch(): FetchPatchState {
  const existing = (window as unknown as Record<string, FetchPatchState | undefined>)[PATCH_KEY];
  if (existing) return existing;

  const originalFetch = window.fetch.bind(window);
  const controllers = new Set<AbortController>();
  const abortAll = () => {
    for (const controller of controllers) controller.abort("navigation");
    controllers.clear();
  };

  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (!shouldAttachAbort(input, init)) return originalFetch(input, init);
    const controller = new AbortController();
    controllers.add(controller);
    return originalFetch(input, { ...init, signal: controller.signal }).finally(() => {
      controllers.delete(controller);
    });
  }) as typeof window.fetch;

  const state = { originalFetch, controllers, abortAll };
  (window as unknown as Record<string, FetchPatchState>)[PATCH_KEY] = state;
  return state;
}

export function useNavigationApiAbort(pathname: string) {
  const previousPathRef = useRef(pathname);

  useEffect(() => {
    const state = installAbortableFetch();
    if (previousPathRef.current !== pathname) {
      state.abortAll();
      previousPathRef.current = pathname;
    }
  }, [pathname]);

  useEffect(() => {
    const state = installAbortableFetch();
    const abortOnNavigation = () => state.abortAll();
    window.addEventListener("disp8ch:navigation-start", abortOnNavigation);
    return () => {
      window.removeEventListener("disp8ch:navigation-start", abortOnNavigation);
    };
  }, []);
}
