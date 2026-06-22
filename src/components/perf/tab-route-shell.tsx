"use client";

import { useEffect, useState, type ComponentType } from "react";
import { HOT_TABS } from "@/lib/client/route-catalog";

type TabRouteShellProps = {
  marker: string;
  load: () => Promise<{ default: ComponentType<Record<string, unknown>> }>;
};

const loadedTabs = new Map<string, ComponentType<Record<string, unknown>>>();

export function rememberLoadedTab(marker: string, component: ComponentType<Record<string, unknown>>) {
  loadedTabs.set(marker, component);
}

function TabLoadingShell({ marker }: { marker: string }) {
  const title = marker === "dashboard"
    ? "Dashboard"
    : marker.replace(/-/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
  return (
    <main
      className="flex-1 overflow-auto p-6"
      data-perf-shell-ready={marker}
      data-perf-ready={marker}
      aria-busy="true"
    >
      <div className="space-y-4">
        <div>
          <h1 className="text-2xl font-bold">{title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">Loading workspace surface...</p>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          <div className="h-24 rounded-md border bg-card" />
          <div className="h-24 rounded-md border bg-card" />
          <div className="h-24 rounded-md border bg-card" />
        </div>
        <div className="h-80 rounded-md border bg-card" />
      </div>
    </main>
  );
}

export function TabRouteShell({ marker, load }: TabRouteShellProps) {
  const [ClientPage, setClientPage] = useState<ComponentType<Record<string, unknown>> | null>(
    () => loadedTabs.get(marker) ?? null,
  );

  useEffect(() => {
    const cached = loadedTabs.get(marker);
    if (cached) {
      setClientPage(() => cached);
      return;
    }

    let cancelled = false;
    let started = false;
    const loadClient = () => {
      if (started || cancelled) return;
      started = true;
      void load()
        .then((mod) => {
          if (cancelled) return;
          rememberLoadedTab(marker, mod.default);
          setClientPage(() => mod.default);
        })
        .catch(() => {
          // Leave shell visible on error
        });
    };

    const consumeEagerNavigation = () => {
      const eagerMarker = window.sessionStorage.getItem("disp8ch:eager-tab-load");
      if (eagerMarker !== marker) return;
      window.sessionStorage.removeItem("disp8ch:eager-tab-load");
      window.requestAnimationFrame(() => window.requestAnimationFrame(loadClient));
    };

    consumeEagerNavigation();

    // Hot tabs: load immediately
    if (HOT_TABS.has(marker)) {
      loadClient();
    } else {
      // Non-hot tabs: schedule via idle or timer
      if (typeof requestIdleCallback === "function") {
        const idleId = window.requestIdleCallback(loadClient, { timeout: 300 });
        return () => {
          cancelled = true;
          window.cancelIdleCallback(idleId);
        };
      }
      const timer = setTimeout(loadClient, 150);
      return () => {
        cancelled = true;
        clearTimeout(timer);
      };
    }

    // Keep user input as accelerators (for non-hot tabs before idle fires)
    window.addEventListener("pointermove", loadClient, { once: true });
    window.addEventListener("mousemove", loadClient, { once: true });
    window.addEventListener("pointerdown", loadClient, { once: true });
    window.addEventListener("touchstart", loadClient, { once: true, passive: true });
    window.addEventListener("keydown", loadClient, { once: true });
    window.addEventListener("wheel", loadClient, { once: true, passive: true });

    return () => {
      cancelled = true;
      window.removeEventListener("pointermove", loadClient);
      window.removeEventListener("mousemove", loadClient);
      window.removeEventListener("pointerdown", loadClient);
      window.removeEventListener("touchstart", loadClient);
      window.removeEventListener("keydown", loadClient);
      window.removeEventListener("wheel", loadClient);
    };
  }, [load, marker]);

  return ClientPage ? <ClientPage /> : <TabLoadingShell marker={marker} />;
}
