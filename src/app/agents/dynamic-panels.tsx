"use client";

import dynamic from "next/dynamic";

const LoadingPanel = () => (
  <div className="animate-pulse p-6 text-muted-foreground">Loading panel...</div>
);

export const AgentOverview = dynamic(
  () => import("@/components/agents/AgentOverview").then((mod) => mod.AgentOverview),
  { ssr: false, loading: () => <LoadingPanel /> },
);

export const AgentFiles = dynamic(
  () => import("@/components/agents/AgentFiles").then((mod) => mod.AgentFiles),
  { ssr: false, loading: () => <LoadingPanel /> },
);

export const AgentTools = dynamic(
  () => import("@/components/agents/AgentTools").then((mod) => mod.AgentTools),
  { ssr: false, loading: () => <LoadingPanel /> },
);

export const AgentSkills = dynamic(
  () => import("@/components/agents/AgentSkills").then((mod) => mod.AgentSkills),
  { ssr: false, loading: () => <LoadingPanel /> },
);

export const AgentChannels = dynamic(
  () => import("@/components/agents/AgentChannels").then((mod) => mod.AgentChannels),
  { ssr: false, loading: () => <LoadingPanel /> },
);

export const AgentScheduler = dynamic(
  () => import("@/components/agents/AgentScheduler").then((mod) => mod.AgentScheduler),
  { ssr: false, loading: () => <LoadingPanel /> },
);

export const AgentRoles = dynamic(
  () => import("@/components/agents/AgentRoles").then((mod) => mod.AgentRoles),
  { ssr: false, loading: () => <LoadingPanel /> },
);

export const AgentSidebar = dynamic(
  () => import("@/components/agents/AgentSidebar").then((mod) => ({ default: mod.AgentSidebar })),
  { ssr: false, loading: () => <LoadingPanel /> },
);
