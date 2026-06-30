"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAfterUseful } from "@/lib/client/use-after-useful";
import { SkillCatalogDrawer } from "@/components/skills/skill-catalog-drawer";
import LearnFromSources from "@/components/skills/learn-from-sources";

const SKILLS_UI_STATE_KEY = "disp8ch:skills-ui-state";

type AgentSummary = {
  id: string;
  name: string;
  isDefault: boolean;
  isActive: boolean;
};

type SkillEntry = {
  id: string;
  name: string;
  label: string;
  description: string;
  source: "core" | "optional" | "workspace" | "agent" | "extension" | "external";
  extensionId: string | null;
  enabled: boolean;
  globallyEnabled?: boolean;
};

type ExtensionEntry = {
  id: string;
  name: string;
  description: string;
  source: "bundled" | "external";
  skillCount: number;
  configurable: boolean;
  enabled: boolean;
  globallyEnabled?: boolean;
  eligible?: boolean;
  config?: Record<string, unknown>;
};

type SkillPackEntry = {
  id: string;
  name: string;
  description: string;
  installSource: "git" | "local";
  sourceRef: string;
  installRef?: string | null;
  sourceRevision?: string | null;
  skillCount: number;
  scanStatus?: "pass" | "warn" | "blocked" | null;
  scanSummary?: string | null;
  installedAt: string;
  updatedAt: string;
};

type SkillStewardSummary = {
  summary: {
    catalogSkills: number;
    enabledSkills: number;
    unusedSkills: number;
    agents: number;
    workflowsScanned?: number;
  };
  mostUsed: Array<{
    id: string;
    label: string;
    source: string;
    extensionId: string | null;
    stewardStatus: string;
    stewardNote: string | null;
    agentCount: number;
    workflowCount: number;
    agents: Array<{ id: string; name: string }>;
    workflows: Array<{ id: string; name: string }>;
  }>;
  unused: Array<{
    id: string;
    label: string;
    source: string;
    extensionId: string | null;
    stewardStatus: string;
    stewardNote: string | null;
  }>;
  archived: Array<{
    id: string;
    label: string;
    source: string;
    extensionId: string | null;
    stewardStatus: string;
    stewardNote: string | null;
    updatedAt: string | null;
  }>;
  externalPacks: Array<{
    id: string;
    name: string;
    scanStatus: string | null;
    scanSummary: string | null;
    skillCount: number;
    updatedAt: string;
  }>;
  proposals?: Array<{
    id: string;
    primary: { id: string; label: string; source: string; usageCount: number };
    candidate: { id: string; label: string; source: string; usageCount: number };
    confidence: number;
    reasons: string[];
    recommendedAction: string;
  }>;
};

type SelfImprovementProposal = {
  id: string;
  sessionId: string;
  kind: "memory" | "skill" | "prompt_rule" | "test_case";
  title: string;
  rationale: string;
  proposedContent: string;
  evidence: string[];
  status: "pending" | "approved" | "rejected" | "applied";
  createdAt: string;
  updatedAt?: string;
  appliedPath?: string | null;
};

type SkillUsageSummary = {
  skillId: string;
  skillName: string;
  skillSource: string;
  loadedCount: number;
  usedCount: number;
  proposedPatchCount: number;
  appliedPatchCount: number;
  dismissedCount: number;
  lastLoadedAt: string | null;
  lastUsedAt: string | null;
  lastPatchedAt: string | null;
  lastEventAt: string | null;
};

type SkillCompoundingEvaluation = {
  id: string;
  skillId: string;
  skillName: string;
  status: "active" | "stale" | "needs_review" | "archived_candidate";
  usageCount: number;
  successCount: number;
  staleScore: number;
  recommendation: string;
  rationale: string;
  evidence: string[];
  createdAt: string;
};

type SkillGroup = {
  id: string;
  label: string;
  skills: SkillEntry[];
};

function groupSkills(skills: SkillEntry[]): SkillGroup[] {
  const grouped = new Map<string, SkillEntry[]>();
  const order = ["core", "optional", "workspace", "agent", "extension", "external"] as const;
  const labels: Record<(typeof order)[number], string> = {
    core: "Core Skills",
    optional: "Optional Skills",
    workspace: "Workspace Skills",
    agent: "Agent Skills",
    extension: "Extension Skills",
    external: "External Skill Packs",
  };
  for (const skill of skills) {
    const current = grouped.get(skill.source) ?? [];
    current.push(skill);
    grouped.set(skill.source, current);
  }
  const groups: SkillGroup[] = [];
  for (const key of order) {
    const entries = grouped.get(key) ?? [];
    if (entries.length > 0) {
      groups.push({ id: key, label: labels[key], skills: entries });
    }
  }
  return groups;
}

function EligibilityChip({ skill }: { skill: SkillEntry }) {
  const blocked = skill.globallyEnabled === false;
  if (blocked) {
    return (
      <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium border-red-500/40 text-red-400">
        blocked
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium border-green-500/40 text-green-400">
      eligible
    </span>
  );
}

export default function SkillsPage() {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [extensions, setExtensions] = useState<ExtensionEntry[]>([]);
  const [skillPacks, setSkillPacks] = useState<SkillPackEntry[]>([]);
  const [execAllowlist, setExecAllowlist] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [filter, setFilter] = useState("");
  const [installSource, setInstallSource] = useState("");
  const [installRef, setInstallRef] = useState("");
  const [installing, setInstalling] = useState(false);
  const [steward, setSteward] = useState<SkillStewardSummary | null>(null);
  const [showArchivedSkills, setShowArchivedSkills] = useState(false);
  // Progressive disclosure: keep the power-user analytics (Skill Steward metrics +
  // compounding-evidence ledger) collapsed by default so the page stays approachable.
  const [showSkillAnalytics, setShowSkillAnalytics] = useState(false);
  const [selfImprovementProposals, setSelfImprovementProposals] = useState<SelfImprovementProposal[]>([]);
  const [skillUsage, setSkillUsage] = useState<SkillUsageSummary[]>([]);
  const [skillEvaluations, setSkillEvaluations] = useState<SkillCompoundingEvaluation[]>([]);
  const [proposalBusyId, setProposalBusyId] = useState<string | null>(null);
  const [showCatalog, setShowCatalog] = useState(false);
  const [hideGettingStarted, setHideGettingStarted] = useState(false);
  const [uiPreferencesLoaded, setUiPreferencesLoaded] = useState(false);

  const loadAgents = async (): Promise<string> => {
    const response = await fetch("/api/agents");
    const json = await response.json();
    if (!json.success) return "";
    const nextAgents = (json.data?.agents ?? []) as AgentSummary[];
    const defaultId = (json.data?.defaultId as string | null) ?? nextAgents[0]?.id ?? "";
    setAgents(nextAgents);
    setSelectedAgentId((current) =>
      current && nextAgents.some((agent) => agent.id === current) ? current : defaultId,
    );
    return defaultId;
  };

  const loadSkills = async (agentId: string) => {
    if (!agentId) return;
    const response = await fetch(`/api/agents/skills?agentId=${encodeURIComponent(agentId)}`);
    const json = await response.json();
    if (!json.success) return;
    setSkills((json.data?.skills ?? []) as SkillEntry[]);
    setExtensions((json.data?.extensions ?? []) as ExtensionEntry[]);
    const rawAllowlist = (json.data?.execAllowlist ?? []) as string[];
    setExecAllowlist(rawAllowlist.join(", "));
  };

  const loadSkillPacks = async () => {
    const response = await fetch("/api/skills");
    const json = await response.json();
    if (!json.success) return;
    setSkillPacks((json.data?.packs ?? []) as SkillPackEntry[]);
  };

  const loadSteward = async () => {
    const response = await fetch("/api/skills?action=steward");
    const json = await response.json();
    if (json.success) setSteward(json.data as SkillStewardSummary);
  };

  const loadSelfImprovementProposals = async () => {
    const response = await fetch("/api/learning?action=self-improvement-proposals&status=all");
    const json = await response.json();
    if (json.success) setSelfImprovementProposals((json.data ?? []) as SelfImprovementProposal[]);
  };

  const loadSkillUsage = async (evaluate = false) => {
    const response = await fetch(`/api/skills/usage?limit=80${evaluate ? "&evaluate=1" : ""}`);
    const json = await response.json();
    if (!json.success) return;
    setSkillUsage((json.data?.skills ?? []) as SkillUsageSummary[]);
    if (evaluate) setSkillEvaluations((json.data?.evaluations ?? []) as SkillCompoundingEvaluation[]);
  };

  // Skills page has no bootstrap endpoint; all data loads after useful-ready so
  // /api/agents and /api/skills don't fire pre-ready.
  const skillsInitDoneRef = useRef(false);
  useAfterUseful(() => {
    (async () => {
      setLoading(true);
      try {
        const initialAgentId = await loadAgents();
        await loadSkills(initialAgentId);
        await loadSkillPacks();
        await loadSteward();
        await loadSelfImprovementProposals();
        await loadSkillUsage(false);
      } finally {
        setLoading(false);
        skillsInitDoneRef.current = true;
      }
    })();
  }, []);

  useEffect(() => {
    if (!skillsInitDoneRef.current) return;
    if (!selectedAgentId) return;
    setLoading(true);
    void loadSkills(selectedAgentId).finally(() => setLoading(false));
  }, [selectedAgentId]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(SKILLS_UI_STATE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { hideGettingStarted?: boolean };
        setHideGettingStarted(Boolean(parsed.hideGettingStarted));
      }
    } catch {
      // Keep first-run guidance visible when preferences cannot be read.
    } finally {
      setUiPreferencesLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!uiPreferencesLoaded) return;
    try {
      window.localStorage.setItem(
        SKILLS_UI_STATE_KEY,
        JSON.stringify({ hideGettingStarted }),
      );
    } catch {
      // Preferences are optional; skill controls still work without storage.
    }
  }, [hideGettingStarted, uiPreferencesLoaded]);

  const filteredSkills = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return skills;
    return skills.filter((skill) =>
      `${skill.name} ${skill.label} ${skill.description}`.toLowerCase().includes(needle),
    );
  }, [filter, skills]);

  const groups = useMemo(() => groupSkills(filteredSkills), [filteredSkills]);

  const bundledCount = skills.filter((skill) => skill.source === "core" || skill.source === "optional").length;
  const localCount = skills.filter((skill) => skill.source === "workspace" || skill.source === "agent").length;
  const extensionCount = skills.filter((skill) => skill.source === "extension").length;
  const enabledCount = skills.filter((skill) => skill.enabled).length;

  const runSkillPackAction = async (payload: Record<string, unknown>) => {
    setInstalling(true);
    try {
      const response = await fetch("/api/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await response.json();
      if (!json.success) {
        throw new Error(String(json.error || "Skill-pack action failed"));
      }
      if (payload.action === "install") {
        setInstallSource("");
        setInstallRef("");
      }
      await loadSkillPacks();
      await loadSteward();
      if (selectedAgentId) {
        await loadSkills(selectedAgentId);
      }
    } catch (error) {
      console.error(error);
    } finally {
      setInstalling(false);
    }
  };

  const updateStewardState = async (skillId: string, status: "active" | "pinned" | "stale" | "archived") => {
    await fetch("/api/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "steward-state", skillId, status }),
    });
    await loadSteward();
  };

  const runSelfImprovementProposalAction = async (
    proposalId: string,
    action: "approve-proposal" | "reject-proposal" | "apply-proposal",
  ) => {
    setProposalBusyId(proposalId);
    try {
      const response = await fetch("/api/learning", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, proposalId }),
      });
      const json = await response.json();
      if (!json.success) throw new Error(String(json.error || "Proposal action failed"));
      await loadSelfImprovementProposals();
      if (action === "apply-proposal") {
        await loadSkillPacks();
        if (selectedAgentId) await loadSkills(selectedAgentId);
      }
    } catch (error) {
      console.error(error);
    } finally {
      setProposalBusyId(null);
    }
  };

  const onEnableAll = async () => {
    if (!selectedAgentId) return;
    setSaving(true);
    const allIds = skills.map((s) => s.id);
    setSkills((current) => current.map((s) => ({ ...s, enabled: true })));
    try {
      const res = await fetch("/api/agents/skills", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: selectedAgentId, skillUpdates: allIds.map((id) => ({ id, enabled: true })) }),
      });
      const json = await res.json();
      if (json.success) {
        setSkills((json.data?.skills ?? []) as SkillEntry[]);
        setExtensions((json.data?.extensions ?? []) as ExtensionEntry[]);
      }
    } catch {
      setSkills((c) => c.map((s) => ({ ...s, enabled: false })));
    } finally {
      setSaving(false);
    }
  };

  const onDisableAll = async () => {
    if (!selectedAgentId) return;
    setSaving(true);
    const allIds = skills.map((s) => s.id);
    setSkills((current) => current.map((s) => ({ ...s, enabled: false })));
    try {
      const res = await fetch("/api/agents/skills", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: selectedAgentId, skillUpdates: allIds.map((id) => ({ id, enabled: false })) }),
      });
      const json = await res.json();
      if (json.success) {
        setSkills((json.data?.skills ?? []) as SkillEntry[]);
        setExtensions((json.data?.extensions ?? []) as ExtensionEntry[]);
      }
    } catch {
      setSkills((c) => c.map((s) => ({ ...s, enabled: true })));
    } finally {
      setSaving(false);
    }
  };

  const onReset = async () => {
    if (!selectedAgentId) return;
    setSaving(true);
    try {
      const res = await fetch("/api/agents/skills", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: selectedAgentId, enabledSkills: [] }),
      });
      const json = await res.json();
      if (json.success) {
        setSkills((json.data?.skills ?? []) as SkillEntry[]);
        setExtensions((json.data?.extensions ?? []) as ExtensionEntry[]);
      }
    } catch {}
    finally { setSaving(false); }
  };

  const onSaveExecAllowlist = async () => {
    if (!selectedAgentId) return;
    setSaving(true);
    const patterns = execAllowlist.split(",").map((s) => s.trim()).filter(Boolean);
    try {
      await fetch("/api/agents/skills", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: selectedAgentId, execAllowlist: patterns }),
      });
    } catch {}
    finally { setSaving(false); }
  };

  const onToggle = async (skillId: string, enabled: boolean) => {
    if (!selectedAgentId) return;
    setSaving(true);
    setSkills((current) =>
      current.map((skill) => (skill.id === skillId ? { ...skill, enabled } : skill)),
    );
    try {
      await fetch("/api/agents/skills", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: selectedAgentId,
          skillUpdates: [{ id: skillId, enabled }],
        }),
      });
    } catch {
      setSkills((current) =>
        current.map((skill) => (skill.id === skillId ? { ...skill, enabled: !enabled } : skill)),
      );
    } finally {
      setSaving(false);
    }
  };

  const onToggleExtension = async (extensionId: string, enabled: boolean) => {
    if (!selectedAgentId) return;
    setSaving(true);
    setExtensions((current) =>
      current.map((extension) =>
        extension.id === extensionId ? { ...extension, enabled } : extension,
      ),
    );
    try {
      const response = await fetch("/api/agents/skills", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: selectedAgentId,
          extensionUpdates: [{ id: extensionId, enabled }],
        }),
      });
      const json = await response.json();
      if (json.success) {
        setSkills((json.data?.skills ?? []) as SkillEntry[]);
        setExtensions((json.data?.extensions ?? []) as ExtensionEntry[]);
      }
    } catch {
      setExtensions((current) =>
        current.map((extension) =>
          extension.id === extensionId ? { ...extension, enabled: !enabled } : extension,
        ),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
<main className="flex-1 overflow-auto p-6" data-perf-ready="skills">
          <div className="mb-6 flex items-center justify-between gap-3">
            <div>
              <h1 className="text-2xl font-bold">Skills & Extensions</h1>
              <p className="text-sm text-muted-foreground">
                Choose capability packs per agent. New optional skills are disabled by default; enable only what an agent needs for its role.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={() => setShowCatalog(true)}>Browse skills</Button>
              <Button size="sm" variant="outline" asChild>
                <Link href="/extensions">Manage extension sources</Link>
              </Button>
              <Button size="sm" variant="outline" asChild>
                <Link href="/mcp">Manage MCP servers</Link>
              </Button>
              <Badge variant="outline">{enabledCount}/{skills.length} enabled</Badge>
            </div>
          </div>
          <SkillCatalogDrawer open={showCatalog} onClose={() => setShowCatalog(false)} />

          {hideGettingStarted ? (
            <div className="mb-6 flex items-center justify-between gap-3 rounded-md border border-dashed px-3 py-2">
              <p className="text-sm text-muted-foreground">Enable only the capabilities each agent needs.</p>
              <Button type="button" size="sm" variant="ghost" onClick={() => setHideGettingStarted(false)}>
                Show Tips
              </Button>
            </div>
          ) : (
            <Card className="mb-6 border-amber-500/30 bg-amber-500/5">
              <CardContent className="pt-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                      Getting Started
                    </div>
                    <div className="mt-2 text-sm font-medium">Start with lean capabilities</div>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      Select an agent, then enable only the skills and extensions needed for its role. This keeps prompts focused and behavior predictable.
                    </p>
                  </div>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setHideGettingStarted(true)}>
                    Hide Tips
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          <div className="mb-6 grid gap-4 md:grid-cols-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Bundled Skills</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold">{bundledCount}</div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Local Skills</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold">{localCount}</div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Extension Skills</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold">{extensionCount}</div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">External Skill Packs</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold">{skillPacks.length}</div>
              </CardContent>
            </Card>
          </div>

          {steward ? (
            <div className="mb-4">
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={() => setShowSkillAnalytics((value) => !value)}
              >
                {showSkillAnalytics
                  ? "▾ Hide skill analytics"
                  : "▸ Skill analytics — catalog stats, usage, and compounding-evidence ledger (for power users)"}
              </Button>
            </div>
          ) : null}

          {steward && showSkillAnalytics ? (
            <Card className="mb-6">
              <CardHeader>
                <div className="flex items-center justify-between gap-2">
                  <CardTitle>Skill Steward</CardTitle>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant={showArchivedSkills ? "default" : "outline"}
                      size="sm"
                      onClick={() => setShowArchivedSkills((current) => !current)}
                    >
                      Archived ({steward.archived.length})
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => void loadSteward()}>Refresh</Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-3 md:grid-cols-4">
                  {[
                    ["Catalog", steward.summary.catalogSkills],
                    ["Enabled", steward.summary.enabledSkills],
                    ["Unused", steward.summary.unusedSkills],
                    ["Agents", steward.summary.agents],
                    ["Workflows", steward.summary.workflowsScanned ?? 0],
                  ].map(([label, value]) => (
                    <div key={String(label)} className="rounded-md border bg-muted/20 px-3 py-2">
                      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
                      <div className="text-lg font-semibold">{value}</div>
                    </div>
                  ))}
                </div>
                <div className="rounded-md border px-3 py-3">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="text-sm font-medium">Compounding Evidence</div>
                      <div className="text-xs text-muted-foreground">
                        Loaded/used/applied skill events from the sidecar ledger.
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm" onClick={() => void loadSkillUsage(false)}>Refresh</Button>
                      <Button variant="outline" size="sm" onClick={() => void loadSkillUsage(true)}>Evaluate</Button>
                    </div>
                  </div>
                  {skillUsage.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No skill usage events recorded yet.</p>
                  ) : (
                    <div className="grid gap-2 lg:grid-cols-2">
                      {skillUsage.slice(0, 8).map((skill) => (
                        <div key={skill.skillId} className="rounded-md border bg-muted/20 px-2 py-2 text-xs">
                          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-2">
                            <div className="min-w-0">
                              <div className="truncate font-medium">{skill.skillName}</div>
                              <div className="truncate text-muted-foreground">{skill.skillId}</div>
                            </div>
                            <Badge variant="secondary">{skill.skillSource}</Badge>
                          </div>
                          <div className="mt-2 flex flex-wrap gap-1">
                            <Badge variant="outline">loaded {skill.loadedCount}</Badge>
                            <Badge variant="outline">used {skill.usedCount}</Badge>
                            <Badge variant="outline">applied {skill.appliedPatchCount}</Badge>
                            <Badge variant="outline">dismissed {skill.dismissedCount}</Badge>
                          </div>
                          <div className="mt-2 text-muted-foreground">
                            last event: {skill.lastEventAt ? new Date(skill.lastEventAt).toLocaleString() : "never"}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {skillEvaluations.length > 0 ? (
                    <div className="mt-3 space-y-2">
                      <div className="text-sm font-medium">Latest Evaluations</div>
                      {skillEvaluations.slice(0, 6).map((evaluation) => (
                        <div key={evaluation.id} className="rounded-md border bg-muted/20 px-2 py-2 text-xs">
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="truncate font-medium">{evaluation.skillName}</div>
                              <div className="text-muted-foreground">{evaluation.recommendation}</div>
                            </div>
                            <Badge variant={evaluation.status === "active" ? "secondary" : "outline"}>{evaluation.status}</Badge>
                          </div>
                          <div className="mt-1 text-muted-foreground">{evaluation.rationale}</div>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
                <div className="grid gap-4 lg:grid-cols-2">
                  <div className="rounded-md border px-3 py-3">
                    <div className="mb-2 text-sm font-medium">Most Used</div>
                    {steward.mostUsed.length === 0 ? (
                      <p className="text-xs text-muted-foreground">No agent has enabled a skill yet.</p>
                    ) : (
                      <div className="space-y-2">
                        {steward.mostUsed.slice(0, 6).map((skill) => (
                          <div key={skill.id} className="flex flex-col gap-2 text-xs sm:flex-row sm:items-start sm:justify-between">
                            <div className="min-w-0">
                              <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
                                <span className="block min-w-0 max-w-full truncate font-medium">{skill.label}</span>
                                <Badge variant="secondary" className="text-[10px]">{skill.stewardStatus}</Badge>
                              </div>
                              <div className="truncate text-muted-foreground">{skill.id}</div>
                              <div className="truncate text-muted-foreground">
                                agents: {skill.agents.map((agent) => agent.name).join(", ") || "none"}
                              </div>
                              {skill.workflows.length > 0 ? (
                                <div className="truncate text-muted-foreground">
                                  workflows: {skill.workflows.map((workflow) => workflow.name).join(", ")}
                                </div>
                              ) : null}
                            </div>
                            <div className="flex flex-wrap items-center justify-end gap-1 sm:shrink-0">
                              <Badge variant="outline">{skill.agentCount} agents</Badge>
                              <Badge variant="outline">{skill.workflowCount} workflows</Badge>
                              <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={() => void updateStewardState(skill.id, "pinned")}>Pin</Button>
                              <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={() => void updateStewardState(skill.id, "active")}>Active</Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="rounded-md border px-3 py-3">
                    <div className="mb-2 text-sm font-medium">Unused Candidates</div>
                    {steward.unused.length === 0 ? (
                      <p className="text-xs text-muted-foreground">No unused skills detected.</p>
                    ) : (
                      <div className="space-y-2">
                        {steward.unused.slice(0, 10).map((skill) => (
                          <div key={skill.id} className="flex flex-col gap-2 rounded-md border bg-muted/20 px-2 py-2 text-xs sm:flex-row sm:items-center sm:justify-between">
                            <div className="min-w-0">
                              <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
                                <span className="block min-w-0 max-w-full truncate font-medium">{skill.label}</span>
                                <Badge variant="secondary" className="text-[10px]">{skill.stewardStatus}</Badge>
                              </div>
                              <div className="truncate text-muted-foreground">{skill.id}</div>
                            </div>
                            <div className="flex flex-wrap items-center justify-end gap-1 sm:shrink-0">
                              <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={() => void updateStewardState(skill.id, "pinned")}>Pin</Button>
                              <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={() => void updateStewardState(skill.id, "stale")}>Stale</Button>
                              <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px] text-destructive" onClick={() => void updateStewardState(skill.id, "archived")}>Archive</Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                {steward.proposals && steward.proposals.length > 0 ? (
                  <div className="rounded-md border px-3 py-3">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <div className="text-sm font-medium">Consolidation Proposals</div>
                      <Badge variant="secondary">{steward.proposals.length}</Badge>
                    </div>
                    <div className="space-y-2">
                      {steward.proposals.slice(0, 8).map((proposal) => (
                        <div key={proposal.id} className="rounded-md border bg-muted/20 px-2 py-2 text-xs">
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="font-medium">
                                Keep review focus on <span className="text-foreground">{proposal.primary.label}</span>
                              </div>
                              <div className="mt-1 text-muted-foreground">
                                Candidate: {proposal.candidate.label} ({proposal.candidate.id})
                              </div>
                              <div className="mt-1 text-muted-foreground">{proposal.recommendedAction}</div>
                            </div>
                            <div className="flex flex-wrap justify-end gap-1">
                              <Badge variant="outline">{proposal.confidence}% match</Badge>
                              <Badge variant="outline">primary usage {proposal.primary.usageCount}</Badge>
                              <Badge variant="outline">candidate usage {proposal.candidate.usageCount}</Badge>
                            </div>
                          </div>
                          <div className="mt-2 flex flex-wrap gap-1">
                            {proposal.reasons.map((reason) => (
                              <Badge key={reason} variant="secondary" className="text-[10px]">{reason}</Badge>
                            ))}
                            <Button
                              size="sm"
                              variant="ghost"
                              className="ml-auto h-6 px-2 text-[11px] text-destructive"
                              onClick={() => void updateStewardState(proposal.candidate.id, "archived")}
                            >
                              Archive candidate
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
                {showArchivedSkills ? (
                  <div className="rounded-md border px-3 py-3">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <div className="text-sm font-medium">Archived Skills</div>
                      <Badge variant="secondary">{steward.archived.length}</Badge>
                    </div>
                    {steward.archived.length === 0 ? (
                      <p className="text-xs text-muted-foreground">No skills are archived.</p>
                    ) : (
                      <div className="grid gap-2 md:grid-cols-2">
                        {steward.archived.map((skill) => (
                          <div key={skill.id} className="flex flex-col gap-2 rounded-md border bg-muted/20 px-2 py-2 text-xs sm:flex-row sm:items-center sm:justify-between">
                            <div className="min-w-0">
                              <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
                                <span className="block min-w-0 max-w-full truncate font-medium">{skill.label}</span>
                                <Badge variant="secondary" className="text-[10px]">archived</Badge>
                              </div>
                              <div className="truncate text-muted-foreground">{skill.id}</div>
                              {skill.updatedAt ? (
                                <div className="truncate text-muted-foreground">
                                  archived: {new Date(skill.updatedAt).toLocaleString()}
                                </div>
                              ) : null}
                            </div>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 self-end px-2 text-[11px] sm:shrink-0"
                              onClick={() => void updateStewardState(skill.id, "active")}
                            >
                              Restore
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : null}
              </CardContent>
            </Card>
          ) : null}

          <Card className="mb-6">
            <CardHeader>
              <CardTitle>Install External Skill Pack</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid gap-3 lg:grid-cols-[1.4fr,0.6fr,auto]">
                <Input
                  placeholder="GitHub repo, git URL, or local path"
                  value={installSource}
                  onChange={(event) => setInstallSource(event.target.value)}
                />
                <Input
                  placeholder="Optional ref or branch"
                  value={installRef}
                  onChange={(event) => setInstallRef(event.target.value)}
                />
                <Button
                  disabled={installing || !installSource.trim()}
                  onClick={() => void runSkillPackAction({ action: "install", source: installSource, ref: installRef || undefined })}
                >
                  Install
                </Button>
              </div>
              <div className="text-xs text-muted-foreground">
                Skill packs are stored on disk and can be installed from local folders or git sources. You can also add custom packs manually under <code>data/workspace/skills</code> or inside any agent workspace <code>skills/</code> folder.
              </div>
            </CardContent>
          </Card>

          <LearnFromSources onCompiled={() => void loadSelfImprovementProposals()} />

          <Card className="mb-6">
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle>Self-Improvement Proposals</CardTitle>
                <div className="flex items-center gap-2">
                  <Badge variant="outline">
                    {selfImprovementProposals.filter((proposal) => proposal.status === "pending").length} pending
                  </Badge>
                  <Button variant="outline" size="sm" onClick={() => void loadSelfImprovementProposals()}>
                    Refresh
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {selfImprovementProposals.length === 0 ? (
                <p className="text-sm text-muted-foreground">No pending memory or skill proposals.</p>
              ) : (
                <div className="space-y-3">
                  {selfImprovementProposals.slice(0, 8).map((proposal) => (
                    <div key={proposal.id} className="rounded-md border px-3 py-3">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="mb-1 flex flex-wrap items-center gap-2">
                            <span className="text-sm font-medium">{proposal.title}</span>
                            <Badge variant="outline" className="text-[10px]">{proposal.kind}</Badge>
                            <Badge variant={proposal.status === "pending" ? "secondary" : "outline"} className="text-[10px]">
                              {proposal.status}
                            </Badge>
                          </div>
                          <p className="text-xs text-muted-foreground">{proposal.rationale}</p>
                          <p className="mt-1 text-[11px] text-muted-foreground">
                            session {proposal.sessionId || "unknown"} &bull; {new Date(proposal.createdAt).toLocaleString()}
                          </p>
                          {proposal.appliedPath ? (
                            <p className="mt-1 break-all text-[11px] text-muted-foreground">{proposal.appliedPath}</p>
                          ) : null}
                          <details className="mt-2">
                            <summary className="cursor-pointer text-xs text-muted-foreground">Preview</summary>
                            <pre className="mt-2 max-h-48 overflow-auto rounded-md bg-muted/30 p-2 text-[11px] whitespace-pre-wrap">
                              {proposal.proposedContent}
                            </pre>
                          </details>
                        </div>
                        <div className="flex shrink-0 flex-wrap justify-end gap-2">
                          {proposal.status === "pending" ? (
                            <>
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={proposalBusyId === proposal.id}
                                onClick={() => void runSelfImprovementProposalAction(proposal.id, "approve-proposal")}
                              >
                                Approve
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={proposalBusyId === proposal.id}
                                onClick={() => void runSelfImprovementProposalAction(proposal.id, "reject-proposal")}
                              >
                                Reject
                              </Button>
                            </>
                          ) : null}
                          {proposal.status === "approved" ? (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={proposalBusyId === proposal.id}
                              onClick={() => void runSelfImprovementProposalAction(proposal.id, "apply-proposal")}
                            >
                              Apply
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="mb-6">
            <CardHeader>
              <CardTitle>External Skill Packs</CardTitle>
            </CardHeader>
            <CardContent>
              {skillPacks.length === 0 ? (
                <p className="text-sm text-muted-foreground">No external skill packs installed yet.</p>
              ) : (
                <div className="space-y-3">
                  {skillPacks.map((pack) => (
                    <div key={pack.id} className="rounded-md border px-3 py-3">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="mb-1 flex flex-wrap items-center gap-2">
                            <span className="text-sm font-medium">{pack.name}</span>
                            <Badge variant="outline" className="text-[10px]">{pack.installSource}</Badge>
                            {pack.scanStatus ? (
                              <Badge variant="secondary" className="text-[10px]">{pack.scanStatus}</Badge>
                            ) : null}
                          </div>
                          <p className="text-xs text-muted-foreground">{pack.description}</p>
                          <p className="mt-1 text-[11px] text-muted-foreground">
                            {pack.id} &bull; {pack.skillCount} skill{pack.skillCount === 1 ? "" : "s"}
                          </p>
                          <p className="text-[11px] text-muted-foreground break-all">{pack.sourceRef}</p>
                          {pack.scanSummary ? (
                            <p className="mt-1 text-[11px] text-muted-foreground">{pack.scanSummary}</p>
                          ) : null}
                        </div>
                        <div className="flex items-center gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={installing}
                            onClick={() => void runSkillPackAction({ action: "update", skillPackId: pack.id })}
                          >
                            Update
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={installing}
                            onClick={() => void runSkillPackAction({ action: "uninstall", skillPackId: pack.id })}
                          >
                            Remove
                          </Button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle>Skill Registry</CardTitle>
                <div className="flex items-center gap-2">
                  <Select value={selectedAgentId} onValueChange={setSelectedAgentId}>
                    <SelectTrigger className="w-[260px]">
                      <SelectValue placeholder="Select agent" />
                    </SelectTrigger>
                    <SelectContent>
                      {agents.map((agent) => (
                        <SelectItem key={agent.id} value={agent.id}>
                          {agent.name}
                          {agent.isDefault ? " (default)" : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      if (selectedAgentId) {
                        setLoading(true);
                        void loadSkills(selectedAgentId).finally(() => setLoading(false));
                      }
                    }}
                  >
                    Refresh
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <Input
                placeholder="Filter skills"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              />

              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" disabled={saving} onClick={() => void onEnableAll()} title="Not recommended for normal agents; prefer enabling only task-relevant skills.">Enable All Shown</Button>
                <Button variant="outline" size="sm" disabled={saving} onClick={() => void onDisableAll()}>Disable All</Button>
                <Button variant="outline" size="sm" disabled={saving} onClick={() => void onReset()} title="Clear per-agent skill allowlist">Reset</Button>
                <span className="ml-auto text-xs text-muted-foreground">{filteredSkills.length} shown</span>
              </div>

              {/* Extension Packs */}
              <div className="space-y-2 rounded-md border px-3 py-3">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-medium">Extension Packs</div>
                  <span className="text-xs text-muted-foreground">{extensions.length} total</span>
                </div>
                {extensions.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No extension packs available.</p>
                ) : (
                  <div className="space-y-2">
                    {extensions.map((extension) => (
                      <div key={extension.id} className="flex items-start justify-between gap-3 rounded-md border px-3 py-2">
                        <div>
                          <div className="mb-1 flex flex-wrap items-center gap-2">
                            <span className="text-sm font-medium">{extension.name}</span>
                            <Badge variant="outline" className="text-[10px]">{extension.source}</Badge>
                            {extension.globallyEnabled === false ? (
                              <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium border-red-500/40 text-red-400">
                                globally disabled
                              </span>
                            ) : extension.eligible === false ? (
                              <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium border-yellow-500/40 text-yellow-400">
                                channel not configured
                              </span>
                            ) : (
                              <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium border-green-500/40 text-green-400">
                                eligible
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-muted-foreground">{extension.description}</p>
                          <p className="text-[11px] text-muted-foreground">
                            {extension.id} &bull; {extension.skillCount} skill pack{extension.skillCount === 1 ? "" : "s"}
                          </p>
                        </div>
                        <label className="flex shrink-0 items-center gap-2 text-xs">
                          <input
                            type="checkbox"
                            checked={extension.enabled}
                            disabled={saving || extension.globallyEnabled === false}
                            onChange={(event) => void onToggleExtension(extension.id, event.target.checked)}
                          />
                          enabled
                        </label>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Skill Groups */}
              {loading ? (
                <p className="text-sm text-muted-foreground">Loading skills...</p>
              ) : filteredSkills.length === 0 ? (
                <p className="text-sm text-muted-foreground">No skills available for this agent.</p>
              ) : (
                <div className="space-y-4">
                  {groups.map((group) => (
                    <details key={group.id} className="group" open={group.id !== "core"}>
                      <summary className="flex cursor-pointer select-none items-center justify-between rounded-md bg-muted/40 px-3 py-2 text-sm font-medium hover:bg-muted/60">
                        <span>{group.label}</span>
                        <span className="text-xs text-muted-foreground">{group.skills.length}</span>
                      </summary>
                      <div className="mt-2 space-y-2">
                        {group.skills.map((skill) => (
                          <div key={skill.id} className="flex items-start justify-between gap-3 rounded-md border px-3 py-2">
                            <div className="min-w-0 flex-1">
                              <div className="mb-1 flex flex-wrap items-center gap-2">
                                <span className="text-sm font-medium">{skill.label}</span>
                                <Badge variant="outline" className="text-[10px]">{skill.source}</Badge>
                                {skill.extensionId ? (
                                  <Badge variant="secondary" className="text-[10px]">{skill.extensionId}</Badge>
                                ) : null}
                                <EligibilityChip skill={skill} />
                                {!skill.enabled && (
                                  <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium border-yellow-500/40 text-yellow-400">
                                    disabled
                                  </span>
                                )}
                              </div>
                              <p className="text-xs text-muted-foreground">{skill.description}</p>
                              <p className="text-[11px] text-muted-foreground">{skill.id}</p>
                              {skill.globallyEnabled === false && (
                                <p className="mt-1 text-[11px] text-red-400">
                                  Reason: blocked by extension (globally disabled)
                                </p>
                              )}
                            </div>
                            <label className="flex shrink-0 items-center gap-2 text-xs">
                              <input
                                type="checkbox"
                                checked={skill.enabled}
                                disabled={saving || skill.globallyEnabled === false}
                                onChange={(event) => void onToggle(skill.id, event.target.checked)}
                              />
                              enabled
                            </label>
                          </div>
                        ))}
                      </div>
                    </details>
                  ))}
                </div>
              )}

              {/* Exec Allowlist */}
              <div className="space-y-2 rounded-md border px-3 py-3">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-medium">Exec Allowlist</div>
                  <span className="text-xs text-muted-foreground">per-agent · case-insensitive patterns</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  Glob patterns for commands this agent may execute without per-call approval. Comma-separated. Example:{" "}
                  <code className="rounded bg-muted px-1">git *,npm run *</code>
                </p>
                <textarea
                  className="w-full rounded-md border bg-background px-3 py-2 text-xs font-mono min-h-[60px] resize-y"
                  placeholder="git *, npm run *, python *.py"
                  value={execAllowlist}
                  onChange={(e) => setExecAllowlist(e.target.value)}
                />
                <Button size="sm" disabled={saving} onClick={() => void onSaveExecAllowlist()}>Save Allowlist</Button>
              </div>

              <div className="rounded-md border px-3 py-3 text-xs text-muted-foreground">
                External skill packs live in <code>data/skills-external</code>. Workspace skills live in <code>data/workspace/skills</code>,
                and each agent workspace can define its own <code>skills/</code> folder for agent-specific playbooks.
                Enabled skill state remains per-agent so the same pack can be reused selectively.
              </div>
            </CardContent>
          </Card>
        </main>
  );
}
