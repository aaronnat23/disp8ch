"use client";

import { DesignStudioShell } from "@/components/design-studio/DesignStudioShell";

export default function DesignsClientPage() {
  return (
    <main data-perf-ready="designs" className="flex h-full min-h-0 flex-1 overflow-hidden">
      <DesignStudioShell />
    </main>
  );
}
