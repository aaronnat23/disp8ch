"use client";

import { MCPSettingsDynamic } from "@/app/settings/dynamic-panels";

export default function MCPPage() {
  return (
    <main className="flex-1 overflow-auto p-6" data-perf-ready="mcp">
      <MCPSettingsDynamic />
    </main>
  );
}
