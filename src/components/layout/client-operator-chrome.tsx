"use client";

import { memo, useMemo } from "react";
import { usePathname } from "next/navigation";
import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";
import { ContextBar, type ContextBarTab } from "@/components/layout/context-bar";
import { TabPayloadWarmup } from "@/components/perf/tab-payload-warmup";

const PATH_TO_TAB: Record<string, ContextBarTab> = {
  "/council": "council",
  "/hierarchy": "hierarchy",
  "/boards": "boards",
  "/workflows": "workflows",
  "/agents": "agents",
  "/memory": "memory",
  "/skills": "skills",
  "/scheduler": "scheduler",
  "/designs": "designs",
  "/chat": "chat",
};

// Memoized chrome: Sidebar and Header take no props, so React.memo lets them
// skip re-render entirely on route change. The pathname-dependent piece
// (ContextBar) is isolated in its own small component below so only it
// re-renders on navigation, not the whole chrome.
const MemoSidebar = memo(Sidebar);
const MemoHeader = memo(Header);
const MemoWarmup = memo(TabPayloadWarmup);

function ContextBarSlot() {
  const pathname = usePathname();
  const contextBarTab = useMemo(() => {
    for (const [path, tab] of Object.entries(PATH_TO_TAB)) {
      if (pathname === path || pathname.startsWith(path + "/")) return tab;
    }
    return null;
  }, [pathname]);
  return contextBarTab ? <ContextBar current={contextBarTab} /> : null;
}

export function ClientOperatorChrome({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen">
      <MemoWarmup />
      <MemoSidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <MemoHeader />
        <ContextBarSlot />
        {children}
      </div>
    </div>
  );
}
