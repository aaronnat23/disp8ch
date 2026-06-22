"use client";

import { TabRouteShell } from "@/components/perf/tab-route-shell";

// Registry mapping route marker → its client-page dynamic import. Lives on the
// client so async server `page.tsx` files can render a TabRouteShell without
// passing a function across the server→client boundary.
const LOADERS: Record<string, () => Promise<{ default: React.ComponentType<Record<string, unknown>> }>> = {
  dashboard: () => import("@/app/(operator)/client-page"),
  chat: () => import("@/app/(operator)/chat/client-page"),
  workflows: () => import("@/app/(operator)/workflows/client-page"),
  boards: () => import("@/app/(operator)/boards/client-page"),
  hierarchy: () => import("@/app/(operator)/hierarchy/client-page"),
  council: () => import("@/app/(operator)/council/client-page"),
  agents: () => import("@/app/(operator)/agents/client-page"),
  activity: () => import("@/app/(operator)/activity/client-page"),
  channels: () => import("@/app/(operator)/channels/client-page"),
  documents: () => import("@/app/(operator)/documents/client-page"),
  files: () => import("@/app/(operator)/files/client-page"),
  designs: () => import("@/app/(operator)/designs/client-page"),
  scheduler: () => import("@/app/(operator)/scheduler/client-page"),
  approvals: () => import("@/app/(operator)/approvals/client-page"),
  metrics: () => import("@/app/(operator)/metrics/client-page"),
  usage: () => import("@/app/(operator)/usage/client-page"),
  logs: () => import("@/app/(operator)/logs/client-page"),
  debug: () => import("@/app/(operator)/debug/client-page"),
  maintenance: () => import("@/app/(operator)/maintenance/client-page"),
  settings: () => import("@/app/(operator)/settings/client-page"),
  docs: () => import("@/app/(operator)/docs/client-page"),
  tags: () => import("@/app/(operator)/tags/client-page"),
  skills: () => import("@/app/(operator)/skills/client-page"),
  mcp: () => import("@/app/(operator)/mcp/client-page"),
  extensions: () => import("@/app/(operator)/extensions/client-page"),
  memory: () => import("@/app/(operator)/memory/client-page"),
};

export function TabRouteShellByMarker({ marker }: { marker: string }) {
  const load = LOADERS[marker];
  if (!load) return null;
  return <TabRouteShell marker={marker} load={load} />;
}
