"use client";

import dynamic from "next/dynamic";
import { Loader2 } from "lucide-react";

function LoadingFallback() {
  return (
    <div className="flex items-center justify-center gap-2 border border-border bg-card p-6 text-xs text-muted-foreground font-mono uppercase tracking-wider">
      <Loader2 className="h-3 w-3 animate-spin" />
      Loading section...
    </div>
  );
}

export const OrgStatsDynamic = dynamic(
  () => import("@/components/hierarchy/OrgStats").then((m) => ({ default: m.OrgStats })),
  { ssr: false, loading: () => <LoadingFallback /> },
);

export const GettingStartedDynamic = dynamic(
  () => import("@/components/hierarchy/GettingStarted").then((m) => ({ default: m.GettingStarted })),
  { ssr: false, loading: () => <LoadingFallback /> },
);

export const CrewOpsDynamic = dynamic(
  () => import("@/components/hierarchy/CrewOps").then((m) => ({ default: m.CrewOps })),
  { ssr: false, loading: () => <LoadingFallback /> },
);

export const SourcePacksDynamic = dynamic(
  () => import("@/components/hierarchy/SourcePacks").then((m) => ({ default: m.SourcePacks })),
  { ssr: false, loading: () => <LoadingFallback /> },
);

export const TemplatesPanelDynamic = dynamic(
  () => import("@/components/hierarchy/TemplatesPanel").then((m) => ({ default: m.TemplatesPanel })),
  { ssr: false, loading: () => <LoadingFallback /> },
);

export const ResearchTeamPanelDynamic = dynamic(
  () => import("@/app/(operator)/research-department/client-page").then((m) => ({ default: m.ResearchDepartmentPanel })),
  { ssr: false, loading: () => <LoadingFallback /> },
);
