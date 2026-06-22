"use client";

import { ChannelsDashboard } from "@/components/channels/channels-dashboard";

export default function ChannelsPage() {
  return (
        <main className="flex-1 overflow-auto p-6" data-perf-ready="channels">
          <ChannelsDashboard />
        </main>
  );
}
