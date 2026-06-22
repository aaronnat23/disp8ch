"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAfterUseful } from "@/lib/client/use-after-useful";

type Organization = { id: string; name: string };
type Goal = { id: string; name: string; organizationId: string | null };

export type ContextBarTab = "council" | "hierarchy" | "boards" | "workflows" | "agents" | "memory" | "skills" | "scheduler" | "designs" | "chat";

const TAB_LABEL: Record<ContextBarTab, string> = {
  council: "Council",
  hierarchy: "Hierarchy",
  boards: "Boards",
  workflows: "Workflows",
  agents: "Agents",
  memory: "Memory",
  skills: "Skills",
  scheduler: "Automations",
  designs: "Designs",
  chat: "Chat",
};

const TAB_PATH: Record<ContextBarTab, string> = {
  council: "/council",
  hierarchy: "/hierarchy",
  boards: "/boards",
  workflows: "/workflows",
  agents: "/agents",
  memory: "/memory",
  skills: "/skills",
  scheduler: "/scheduler",
  designs: "/designs",
  chat: "/chat",
};

function buildHref(path: string, params: { org?: string; goal?: string; documentId?: string; source?: ContextBarTab }): string {
  const qs = new URLSearchParams();
  if (params.org) qs.set("org", params.org);
  if (params.goal) qs.set("goal", params.goal);
  if (params.documentId) qs.set("documentId", params.documentId);
  if (params.source) qs.set("source", params.source);
  const query = qs.toString();
  return query ? `${path}?${query}` : path;
}

export function ContextBar({ current }: { current: ContextBarTab }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const orgId = (searchParams.get("org") || searchParams.get("organizationId") || "").trim();
  const goalId = (searchParams.get("goal") || searchParams.get("goalId") || "").trim();
  const documentId = (searchParams.get("documentId") || "").trim();
  const source = (searchParams.get("source") || "").trim() as ContextBarTab | "";

  const [orgName, setOrgName] = useState<string>("");
  const [goalName, setGoalName] = useState<string>("");
  const [documentName, setDocumentName] = useState<string>("");

  // ContextBar lookups are display-only label resolution. Defer them all behind
  // useful-ready so /api/hierarchy/organizations, /api/hierarchy/goals, and
  // /api/documents do not fire on every operator route before its ready marker.
  useAfterUseful(() => {
    if (!orgId) {
      setOrgName("");
      return;
    }
    let cancelled = false;
    fetch(`/api/hierarchy/organizations?reference=${encodeURIComponent(orgId)}`)
      .then((response) => response.json())
      .then((json) => {
        if (cancelled) return;
        if (json?.success) {
          setOrgName(String(json.data?.organization?.name || json.data?.name || ""));
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [orgId]);

  useAfterUseful(() => {
    if (!goalId) {
      setGoalName("");
      return;
    }
    let cancelled = false;
    fetch(`/api/hierarchy/goals?reference=${encodeURIComponent(goalId)}`)
      .then((response) => response.json())
      .then((json) => {
        if (cancelled) return;
        if (json?.success) {
          setGoalName(String(json.data?.name || ""));
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [goalId]);

  useAfterUseful(() => {
    if (!documentId) {
      setDocumentName("");
      return;
    }
    let cancelled = false;
    fetch(`/api/documents/${encodeURIComponent(documentId)}`)
      .then((response) => response.json())
      .then((json) => {
        if (cancelled) return;
        if (json?.success) {
          setDocumentName(String(json.data?.name || ""));
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [documentId]);

  const hasScope = Boolean(orgId || goalId || documentId);

  // Persist active org to localStorage for cross-tab consistency
  useEffect(() => {
    if (orgId) {
      try { localStorage.setItem("disp8ch-active-org", orgId); } catch { /* quota */ }
    }
  }, [orgId]);

  const scopedTabs: ContextBarTab[] = ["council", "hierarchy", "boards", "workflows", "agents", "memory", "skills", "designs"];
  const isScopedTab = scopedTabs.includes(current);
  const siblingTabs = useMemo(
    () => (Object.keys(TAB_LABEL) as ContextBarTab[]).filter((tab) => tab !== current && scopedTabs.includes(tab)),
    [current],
  );

  if (current === "hierarchy") return null;
  if (!hasScope && !source) return null;

  return (
    <div
      data-testid="context-bar"
      className="flex flex-wrap items-center gap-2 border border-border bg-card/40 px-3 py-2 text-[11px]"
    >
      <span className="font-mono uppercase tracking-widest text-muted-foreground">SCOPE</span>
      {orgId ? (
        <Badge variant="outline" title="Active organization">
          org: {orgName || orgId}
        </Badge>
      ) : isScopedTab ? (
        <a href="/hierarchy" className="no-underline">
          <Badge variant="outline" className="border-dashed cursor-pointer hover:border-primary/50 transition-colors" title="No organization selected — click to set up">
            + Select org
          </Badge>
        </a>
      ) : null}
      {goalId ? (
        <Badge variant="outline" className="border-blue-500/30 text-blue-400/80" title="Active goal">
          goal: {goalName || goalId}
        </Badge>
      ) : null}
      {documentId ? (
        <Badge variant="outline" className="border-violet-500/30 text-violet-400/80" title="Active data source">
          data: {documentName || documentId}
        </Badge>
      ) : null}

      <span className="mx-1 h-4 w-px bg-border/60" aria-hidden />

      {source && source !== current && TAB_PATH[source as ContextBarTab] ? (
        <Button
          size="sm"
          variant="outline"
          className="h-6 px-2 text-[10px]"
          onClick={() => router.push(buildHref(TAB_PATH[source as ContextBarTab], { org: orgId, goal: goalId, documentId }))}
          title={`Return to ${TAB_LABEL[source as ContextBarTab]} with current scope`}
        >
          {"←"} Back to {TAB_LABEL[source as ContextBarTab]}
        </Button>
      ) : null}

      {siblingTabs.map((tab) => (
        <Button
          key={tab}
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-[10px]"
          onClick={() => router.push(buildHref(TAB_PATH[tab], { org: orgId, goal: goalId, documentId, source: current }))}
          title={`Open ${TAB_LABEL[tab]} with current scope`}
        >
          Open in {TAB_LABEL[tab]}
        </Button>
      ))}

      {hasScope ? (
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto h-6 px-2 text-[10px] text-muted-foreground"
          onClick={() => router.push(TAB_PATH[current])}
          title="Clear scope and stay on this tab"
        >
          Clear scope
        </Button>
      ) : null}
    </div>
  );
}
