"use client";

/**
 * Typed accessor for the Electron desktop bridge. Returns null in the browser,
 * so all desktop integrations stay progressive: the web experience is unchanged
 * when `window.disp8chDesktop` is absent.
 */

export type DesktopBridge = {
  getHealth: () => Promise<unknown>;
  runDoctor: () => Promise<unknown>;
  checkUpdates: () => Promise<unknown>;
  downloadUpdate: () => Promise<unknown>;
  restartRuntime: () => Promise<unknown>;
  importDatabase: () => Promise<unknown>;
  openDataDir: () => Promise<unknown>;
  openLogsDir: () => Promise<unknown>;
  notify: (payload: { id: string; title: string; body?: string; href?: string; severity?: string }) => Promise<{ shown: boolean; reason: string }>;
  setAttention: (payload: { count: number; critical?: number }) => Promise<{ ok: boolean }>;
  openSessionWindow: (payload: { sessionId: string; interactive?: boolean }) => Promise<{ ok: boolean; reason?: string }>;
};

export function getDesktopBridge(): DesktopBridge | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { disp8chDesktop?: DesktopBridge };
  return w.disp8chDesktop ?? null;
}

export function isDesktop(): boolean {
  return getDesktopBridge() !== null;
}
