"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import ProposeMemoryButton from "@/components/memory/propose-memory-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { ChevronDown, ChevronRight, Loader2, Scale, Sparkles, Trash2 } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { saveCouncilSession, listCouncilSessions, deleteCouncilSession } from "@/lib/council/persistence";
import { APP_TTL, cachedJson, invalidateCache } from "@/lib/client/app-data-cache";
import { useAfterUseful } from "@/lib/client/use-after-useful";
import { CourtStage, type CourtParticipant, type CourtOpinion, type CourtAgentState, type CourtStageWebChatAction } from "@/components/council/court-stage";
import { EmptyState } from "@/components/app/empty-state";
import { RelatedWorkTrailStrip } from "@/components/work-trails/related-work-trail-strip";

const DEFAULT_TOPIC =
  "How should an AI system balance user autonomy vs. safety guardrails when the user's explicit request conflicts with the system's ethical training — who has final authority and under what circumstances?";

const DEFAULT_OPTIONS_TEXT =
  "User autonomy is paramount: the AI must always execute explicit instructions and cannot override informed adult decisions, Graduated trust model: the AI follows instructions by default but escalates to human oversight for irreversible or high-risk actions, Safety-first absolute guardrails: certain categories of harm are hardcoded and no user instruction can override them regardless of stated intent, Contextual ethics engine: the AI uses real-time reasoning to weigh intent, context, and consequence before each action with no fixed rules, Delegated governance: enterprise deployers set per-deployment policies and the AI defers to those policies rather than individual user or developer judgment";

type Agent = {
  id: string;
  name: string;
  isActive: boolean;
  isDefault: boolean;
  modelRef?: string | null;
};

type ModelOption = {
  id: string;
  provider: string;
  modelId: string;
  name: string;
  isActive: boolean;
  priority: number;
};

type OrganizationOption = {
  id: string;
  name: string;
  memberCount: number;
  isActive: boolean;
};

type GoalOption = {
  id: string;
  name: string;
  description: string | null;
  organizationId: string | null;
  parentGoalName: string | null;
  linkedDocumentIds?: string[];
};

type OrganizationMember = {
  agent: {
    id: string;
    name: string;
    isActive: boolean;
    isDefault: boolean;
  };
  role: {
    roleTitle: string;
    voteWeight?: number;
  };
  agentActive: boolean;
};

type DocumentOption = {
  id: string;
  name: string;
  sourceType: "upload" | "scrape" | "integration";
  sourceUrl: string | null;
  excerpt: string;
};

type CouncilOpinion = {
  agentId: string;
  agentName: string;
  roleTitle: string;
  vote: string;
  decisionProcess: string[];
  stance: string;
  confidence: number;
  concerns: string;
  model: string;
  provider: string;
  tokensUsed: number;
  costUsd: number;
  simulated: boolean;
  error: string | null;
  round?: number;
};

type CouncilDissent = {
  vote: string;
  agentNames: string[];
  summary: string;
};

type CouncilResult = {
  topic: string;
  decisionMode: "majority" | "consensus" | "weighted" | "ranked";
  options: string[];
  participants: number;
  tally: Array<{ option: string; votes: number }>;
  winner: string | null;
  reachedConsensus: boolean;
  conclusion: string;
  synthesis: string | null;
  dissent: CouncilDissent[];
  totalTokens: number;
  totalCostUsd: number;
  simulatedCount: number;
  createdAt: string;
  opinions: CouncilOpinion[];
  rounds?: number;
  debateTranscript?: Array<{ round: number; agentId: string; agentName: string; response: string }>;
};

type CouncilHistoryEntry = CouncilResult & {
  sessionConfig?: {
    organizationId: string;
    goalId: string;
    documentIds: string[];
    agentIds: string[];
    councilMode: "poll" | "debate";
    debateRounds: number;
    synthesizerAgentId: string;
    discoverOptions: boolean;
    costCapUsd: number | null;
  };
};

// C7: council templates
type CouncilTemplate = {
  id: string;
  label: string;
  topic: string;
  optionsText: string;
  decisionMode: "majority" | "consensus";
  mode: "poll" | "debate";
};

const COUNCIL_TEMPLATES: CouncilTemplate[] = [
  {
    id: "tech-decision",
    label: "Technical Decision",
    topic: "Which architectural approach should we adopt for this system component?",
    optionsText: "Option A: Build from scratch for full control\nOption B: Adopt an existing open-source solution\nOption C: Use a managed/hosted third-party service",
    decisionMode: "majority",
    mode: "poll",
  },
  {
    id: "product-launch",
    label: "Product Launch",
    topic: "Should we proceed with the planned product launch given current readiness?",
    optionsText: "Launch as planned\nDelay 2-4 weeks for polish\nSoft launch to limited users first\nPostpone indefinitely",
    decisionMode: "majority",
    mode: "debate",
  },
  {
    id: "security-review",
    label: "Security Review",
    topic: "Does this feature or change meet our security and compliance requirements?",
    optionsText: "Approve — meets all requirements\nApprove with conditions — minor issues to address\nRevise and resubmit — significant gaps found\nReject — unacceptable risk",
    decisionMode: "consensus",
    mode: "poll",
  },
  {
    id: "budget-call",
    label: "Budget Call",
    topic: "How should we allocate the remaining quarterly budget?",
    optionsText: "Invest in infrastructure and reliability\nFocus on new feature development\nExpand team and hiring\nHold reserves for Q4",
    decisionMode: "majority",
    mode: "poll",
  },
  {
    id: "strategy",
    label: "Strategy Vote",
    topic: "Which strategic direction best positions us for the next 12 months?",
    optionsText: "Double down on existing market\nExpand to adjacent markets\nPivot to new product line\nAcquisition or partnership",
    decisionMode: "majority",
    mode: "debate",
  },
];

const MAX_COUNCIL_PARTICIPANTS = 12;

function formatUsd(value: number): string {
  return `$${value.toFixed(4)}`;
}

function hashSeed(seed: string): number {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function paletteFromSeed(seed: string): { primary: string; secondary: string } {
  const baseHue = hashSeed(seed) % 360;
  return {
    primary: `hsl(${baseHue} 86% 64%)`,
    secondary: `hsl(${(baseHue + 48) % 360} 78% 54%)`,
  };
}

function isLikelyJudge(text: string): boolean {
  return /(orchestrator|lead|chief|manager|director|main)/i.test(text);
}

type HistorySummary = {
  topic: string;
  winner: string | null;
  reachedConsensus: boolean;
  decisionMode: string;
  mode: string;
  rounds: number;
  participantsCount: number;
  concernsCount: number;
  dissentCount: number;
  simulatedCount: number;
  createdAt: string;
  orgId: string | null;
  goalId: string | null;
};

/**
 * Normalize a stored council session into display fields. Tolerates both the
 * flat in-session shape (CouncilResult + sessionConfig) and the API shape where
 * the result is nested under `result` and participants is an id array.
 */
function summarizeHistoryEntry(entry: CouncilHistoryEntry): HistorySummary {
  const e = entry as unknown as Record<string, unknown>;
  const result = (e.result && typeof e.result === "object" ? e.result : e) as Record<string, unknown>;
  const cfg = (e.sessionConfig ?? {}) as Record<string, unknown>;
  const opinions = Array.isArray(result.opinions) ? (result.opinions as Array<Record<string, unknown>>) : [];
  const participantsCount = Array.isArray(e.participants)
    ? (e.participants as unknown[]).length
    : typeof result.participants === "number"
      ? (result.participants as number)
      : typeof e.participants === "number"
        ? (e.participants as number)
        : 0;
  const rounds = Number(result.rounds ?? e.rounds ?? 1) || 1;
  return {
    topic: String(e.topic ?? result.topic ?? ""),
    winner: (result.winner ?? e.winner ?? null) as string | null,
    reachedConsensus: Boolean(result.reachedConsensus ?? e.reachedConsensus),
    decisionMode: String(result.decisionMode ?? e.votingMethod ?? e.decisionMode ?? "majority"),
    mode: String(e.mode ?? cfg.councilMode ?? (rounds > 1 ? "debate" : "poll")),
    rounds,
    participantsCount,
    concernsCount: opinions.filter((o) => o?.concerns && String(o.concerns).length > 10).length,
    dissentCount: Array.isArray(result.dissent) ? (result.dissent as unknown[]).length : 0,
    simulatedCount: Number(result.simulatedCount ?? e.simulatedCount ?? 0) || 0,
    createdAt: String(e.createdAt ?? result.createdAt ?? ""),
    orgId: (cfg.organizationId ?? e.orgId ?? null) as string | null,
    goalId: (cfg.goalId ?? e.goalId ?? null) as string | null,
  };
}

function AgentGlyph({ seed, className }: { seed: string; className?: string }) {
  const palette = paletteFromSeed(seed);
  return (
    <div className={cn("relative h-11 w-11 shrink-0", className)}>
      <div
        className="absolute inset-0 rounded-full opacity-90"
        style={{
          background: `radial-gradient(circle at 30% 20%, ${palette.primary}, ${palette.secondary})`,
        }}
      />
      <div className="absolute left-1/2 top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-md border border-white/40 bg-white/20 backdrop-blur-sm" />
      <div className="absolute left-1.5 top-1.5 h-2.5 w-2.5 rotate-45 rounded-[2px] border border-white/35 bg-white/25" />
      <div className="absolute bottom-1.5 right-1.5 h-2.5 w-2.5 rounded-full border border-white/35 bg-white/20" />
    </div>
  );
}

const COUNCIL_UI_STATE_KEY = "disp8ch:council-ui";

function readCouncilUiState(): { hideGettingStarted?: boolean } {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(COUNCIL_UI_STATE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as { hideGettingStarted?: boolean };
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeCouncilUiState(patch: { hideGettingStarted?: boolean }) {
  if (typeof window === "undefined") return;
  const current = readCouncilUiState();
  window.localStorage.setItem(
    COUNCIL_UI_STATE_KEY,
    JSON.stringify({
      ...current,
      ...patch,
    }),
  );
}

function CouncilPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const courtStageRegionRef = useRef<HTMLDivElement | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [organizations, setOrganizations] = useState<OrganizationOption[]>([]);
  const [goals, setGoals] = useState<GoalOption[]>([]);
  const [organizationMembers, setOrganizationMembers] = useState<OrganizationMember[]>([]);
  const [documents, setDocuments] = useState<DocumentOption[]>([]);
  const [selectedDocumentIds, setSelectedDocumentIds] = useState<string[]>([]);
  const [documentPickerId, setDocumentPickerId] = useState("");
  const [selectedOrganizationId, setSelectedOrganizationId] = useState("");
  const [selectedGoalId, setSelectedGoalId] = useState("");
  const [topic, setTopic] = useState(DEFAULT_TOPIC);
  const [optionsText, setOptionsText] = useState(DEFAULT_OPTIONS_TEXT);
  const [decisionMode, setDecisionMode] = useState<"majority" | "consensus" | "weighted" | "ranked">("majority");
  const [councilMode, setCouncilMode] = useState<"poll" | "debate">("poll");
  const [debateRounds, setDebateRounds] = useState(3);
  const [synthesizerAgentId, setSynthesizerAgentId] = useState("");
  const [discoverOptions, setDiscoverOptions] = useState(false);
  const [costCapUsd, setCostCapUsd] = useState<number | null>(null);
  // Progressive disclosure: hide power-user controls (decision method, mode/rounds,
  // moderator, discover, cost cap, data sources) behind a toggle so the default form
  // stays approachable for non-technical users.
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [debateFeedFilter, setDebateFeedFilter] = useState<"all" | "dissent" | "high" | "issues" | "round">("all");
  const [debateRoundFilter, setDebateRoundFilter] = useState<number | "all">("all");
  const [error, setError] = useState<string | null>(null);
  const [latest, setLatest] = useState<CouncilResult | null>(null);
  const [history, setHistory] = useState<CouncilHistoryEntry[]>([]);
  const [showPresetTopics, setShowPresetTopics] = useState(false);
  const [showOptionEditor, setShowOptionEditor] = useState(false);
  const [restoredOrgFromUrl, setRestoredOrgFromUrl] = useState(false);
  const [restoredGoalFromUrl, setRestoredGoalFromUrl] = useState(false);
  const [hideGettingStarted, setHideGettingStarted] = useState(false);
  const [streamingOpinions, setStreamingOpinions] = useState<CouncilOpinion[]>([]);
  const [verdictTaskStatus, setVerdictTaskStatus] = useState<"idle" | "creating" | "created" | "error">("idle");
  const [verdictTaskMessage, setVerdictTaskMessage] = useState("");
  const [savedTemplates, setSavedTemplates] = useState<Array<{
    name: string;
    topic: string;
    optionsText: string;
    mode: "poll" | "debate";
    votingMethod: string;
    participants: string[];
  }>>([]);

  const pickDefaultAgentIds = useCallback(
    (pool: Agent[]) => pool.filter((agent) => agent.isActive).slice(0, Math.min(4, pool.length)).map((agent) => agent.id),
    [],
  );

  // Agents + models — needed for the council picker form. Deferred behind
  // useful-ready so /api/agents and /api/models do not fire pre-ready.
  useAfterUseful(() => {
    Promise.all([
      cachedJson<any>("agents", "/api/agents", APP_TTL.agents),
      cachedJson<any>("models", "/api/models", APP_TTL.models),
    ])
      .then(([agentsJson, modelsJson]) => {
        if (agentsJson?.success) {
          const agentRows = Array.isArray(agentsJson.data)
            ? agentsJson.data
            : (agentsJson.data?.agents ?? []);
          const next = agentRows.filter((agent: Agent) => agent.isActive) as Agent[];
          setAgents(next);
          setSelectedAgentIds((current) => (current.length >= 2 ? current : pickDefaultAgentIds(next)));
        }
        if (modelsJson?.success) {
          setModels((modelsJson.data ?? []) as ModelOption[]);
        }
      })
      .catch(() => {});
  }, [pickDefaultAgentIds]);

  // Enrichment: orgs, goals, docs — deferred behind useful-ready.
  useAfterUseful(() => {
    Promise.allSettled([
      cachedJson<any>("hierarchy/organizations", "/api/hierarchy/organizations", APP_TTL["hierarchy/organizations"]),
      cachedJson<any>("hierarchy/goals", "/api/hierarchy/goals", APP_TTL["hierarchy/goals"]),
      cachedJson<any>("documents:100", "/api/documents?limit=100", APP_TTL.documents),
    ]).then(([orgsR, goalsR, docsR]) => {
      if (orgsR.status === "fulfilled" && orgsR.value?.success) {
        const next = (orgsR.value.data?.organizations ?? []) as OrganizationOption[];
        setOrganizations(next);
        const activeId = String(orgsR.value.data?.activeOrganizationId || "");
        if (activeId && activeId !== "default-org") {
          setSelectedOrganizationId(activeId);
        }
      }
      if (goalsR.status === "fulfilled" && goalsR.value?.success) {
        setGoals((goalsR.value.data ?? []) as GoalOption[]);
      }
      if (docsR.status === "fulfilled" && docsR.value?.success) {
        setDocuments((docsR.value.data ?? []) as DocumentOption[]);
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    const saved = readCouncilUiState();
    setHideGettingStarted(Boolean(saved.hideGettingStarted));
  }, []);

  // Load saved council templates from localStorage on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem("disp8ch-council-templates");
      if (saved) setSavedTemplates(JSON.parse(saved));
    } catch { /* ignore */ }
  }, []);

  // Restore council session history — deferred behind useful-ready.
  useAfterUseful(() => {
    (async () => {
      try {
        const params = new URLSearchParams();
        if (selectedOrganizationId) params.set("orgId", selectedOrganizationId);
        params.set("limit", "50");
        const res = await fetch(`/api/council/sessions?${params.toString()}`);
        const json = await res.json();
        if (json?.success && Array.isArray(json.data)) {
          const sessions = json.data;
          if (sessions.length > 0) {
            setHistory(sessions.map((s: Record<string, unknown>) => ({
              id: s.id,
              topic: s.topic,
              mode: s.mode,
              votingMethod: s.voting_method,
              participants: JSON.parse(String(s.participants || "[]")),
              options: JSON.parse(String(s.options || "[]")),
              result: s.result ? JSON.parse(String(s.result)) : null,
              verdict: s.verdict,
              createdAt: s.created_at,
            })) as CouncilHistoryEntry[]);
          }
        }
      } catch { /* ignore */ }
    })();
  }, [selectedOrganizationId]);

  useEffect(() => {
    writeCouncilUiState({ hideGettingStarted });
  }, [hideGettingStarted]);

  useEffect(() => {
    if (restoredOrgFromUrl || organizations.length === 0 || selectedOrganizationId) return;
    const requestedOrganizationId = String(
      searchParams.get("organizationId") ||
      searchParams.get("organization") ||
      searchParams.get("org") ||
      "",
    ).trim();
    if (!requestedOrganizationId) {
      setRestoredOrgFromUrl(true);
      return;
    }
    const matchedOrganization = organizations.find((organization) =>
      organization.id === requestedOrganizationId ||
      organization.name.toLowerCase() === requestedOrganizationId.toLowerCase(),
    );
    if (matchedOrganization) {
      setSelectedOrganizationId(matchedOrganization.id);
    }
    setRestoredOrgFromUrl(true);
  }, [organizations, restoredOrgFromUrl, searchParams, selectedOrganizationId]);

  useEffect(() => {
    if (!selectedOrganizationId) {
      setOrganizationMembers([]);
      setSelectedAgentIds((current) =>
        current.filter((agentId) => agents.some((agent) => agent.id === agentId)),
      );
      return;
    }

    let cancelled = false;
    // Defer member resolution by a short paint-clear delay so the page paints first.
    const memberTimer = setTimeout(() => {
      if (cancelled) return;
      fetch(`/api/hierarchy/organizations?reference=${encodeURIComponent(selectedOrganizationId)}&members=1`)
        .then((response) => response.json())
        .then((json) => {
          if (cancelled || !json?.success) return;
          const nextMembers = (json.data?.members ?? []) as OrganizationMember[];
          setOrganizationMembers(nextMembers);
          const scopedIds = nextMembers
            .filter((member) => member.agentActive !== false)
            .map((member) => member.agent.id)
            .slice(0, MAX_COUNCIL_PARTICIPANTS);
          setSelectedAgentIds(scopedIds);
        })
        .catch(() => {
          if (!cancelled) {
            setOrganizationMembers([]);
            setSelectedAgentIds([]);
          }
        });
    }, 500);

    return () => {
      cancelled = true;
      clearTimeout(memberTimer);
    };
  }, [agents, pickDefaultAgentIds, selectedOrganizationId]);

  useEffect(() => {
    if (restoredGoalFromUrl || goals.length === 0 || selectedGoalId) return;
    const requestedGoalId = String(
      searchParams.get("goalId") ||
      searchParams.get("goal") ||
      "",
    ).trim();
    if (!requestedGoalId) {
      setRestoredGoalFromUrl(true);
      return;
    }
    const matchedGoal = goals.find((goal) =>
      goal.id === requestedGoalId ||
      goal.name.toLowerCase() === requestedGoalId.toLowerCase(),
    );
    if (matchedGoal) {
      if (matchedGoal.organizationId && !selectedOrganizationId) {
        setSelectedOrganizationId(matchedGoal.organizationId);
      }
      setSelectedGoalId(matchedGoal.id);
    }
    setRestoredGoalFromUrl(true);
  }, [goals, restoredGoalFromUrl, searchParams, selectedGoalId, selectedOrganizationId]);

  useEffect(() => {
    const requestedTopic = String(searchParams.get("topic") || "").trim();
    if (requestedTopic) {
      setTopic((current) => (current === DEFAULT_TOPIC ? requestedTopic : current));
    }
  }, [searchParams]);

  useEffect(() => {
    if (documents.length === 0) return;
    const requestedIds = Array.from(
      new Set(
        [
          ...String(searchParams.get("documentIds") || "")
            .split(",")
            .map((value) => value.trim()),
          String(searchParams.get("documentId") || "").trim(),
        ].filter(Boolean),
      ),
    ).filter((id) => documents.some((document) => document.id === id));

    if (requestedIds.length > 0) {
      setSelectedDocumentIds((current) => (current.length > 0 ? current : requestedIds.slice(0, 6)));
    }
  }, [documents, searchParams]);

  const options = useMemo(
    () =>
      Array.from(
        new Set(
          optionsText
            .split(",")
            .map((option) => option.trim())
            .filter(Boolean),
        ),
      ),
    [optionsText],
  );

  const canRun = topic.trim().length >= 3 && selectedAgentIds.length >= 2 && options.length >= 2;

  const activeModels = useMemo(
    () =>
      models
        .filter((model) => model.isActive)
        .sort((a, b) => b.priority - a.priority),
    [models],
  );

  const selectedAgents = useMemo(
    () => agents.filter((agent) => selectedAgentIds.includes(agent.id)),
    [agents, selectedAgentIds],
  );

  const selectedOrganization = useMemo(
    () => organizations.find((organization) => organization.id === selectedOrganizationId) ?? null,
    [organizations, selectedOrganizationId],
  );

  const filteredGoals = useMemo(
    () => goals.filter((goal) => !selectedOrganizationId || goal.organizationId === selectedOrganizationId),
    [goals, selectedOrganizationId],
  );

  useEffect(() => {
    if (!selectedGoalId) return;
    const goalStillVisible = filteredGoals.some((goal) => goal.id === selectedGoalId);
    if (!goalStillVisible) {
      setSelectedGoalId("");
    }
  }, [filteredGoals, selectedGoalId]);

  const selectedGoal = useMemo(
    () => filteredGoals.find((goal) => goal.id === selectedGoalId) ?? null,
    [filteredGoals, selectedGoalId],
  );
  const organizationMemberByAgentId = useMemo(
    () => new Map(organizationMembers.map((member) => [member.agent.id, member])),
    [organizationMembers],
  );

  const participantRoleGroups = useMemo(() => {
    if (selectedAgentIds.length === 0) return [] as Array<{ role: string; count: number }>;
    const counts = new Map<string, number>();
    for (const agentId of selectedAgentIds) {
      const member = organizationMemberByAgentId.get(agentId);
      const role = member?.role.roleTitle?.trim() || "Unscoped";
      counts.set(role, (counts.get(role) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([role, count]) => ({ role, count }))
      .sort((a, b) => b.count - a.count || a.role.localeCompare(b.role));
  }, [selectedAgentIds, organizationMemberByAgentId]);

  const goalDocumentIds = useMemo(() => {
    const ids = selectedGoal?.linkedDocumentIds ?? [];
    return Array.isArray(ids) ? ids.filter((id) => documents.some((doc) => doc.id === id)) : [];
  }, [selectedGoal, documents]);

  const canApplyGoalDocuments = goalDocumentIds.length > 0 &&
    goalDocumentIds.some((id) => !selectedDocumentIds.includes(id));

  const applyGoalDocuments = () => {
    if (goalDocumentIds.length === 0) return;
    setSelectedDocumentIds((current) => {
      const merged = new Set([...current, ...goalDocumentIds]);
      return Array.from(merged).slice(0, 6);
    });
  };

  const selectedDocuments = useMemo(
    () => documents.filter((document) => selectedDocumentIds.includes(document.id)),
    [documents, selectedDocumentIds],
  );

  const visibleAgents = useMemo(() => {
    if (!selectedOrganizationId) return agents;
    if (organizationMembers.length === 0) return agents;
    const memberIds = new Set(
      organizationMembers.filter((member) => member.agentActive !== false).map((member) => member.agent.id),
    );
    return agents.filter((agent) => memberIds.has(agent.id));
  }, [agents, organizationMembers, selectedOrganizationId]);

  const resolveAgentModelLabel = useCallback(
    (agent: Agent) => {
      const modelRef = (agent.modelRef || "").trim();
      if (!modelRef) {
        const global = activeModels[0];
        return global ? `global: ${global.provider}/${global.modelId}` : "global default";
      }
      const byId = activeModels.find((model) => model.id === modelRef);
      if (byId) {
        return `${byId.provider}/${byId.modelId}`;
      }
      return modelRef;
    },
    [activeModels],
  );

  const openWebChatWithPrompt = useCallback(
    (prompt: string) => {
      const params = new URLSearchParams({ draft: prompt, returnTo: `${window.location.pathname}${window.location.search}` });
      router.push(`/chat?${params.toString()}`);
    },
    [router],
  );

  // Session has finished (a verdict exists and we are no longer streaming).
  const settled = !running && Boolean(latest);

  // The active opinions feeding the stage: final result when present, otherwise
  // whatever has streamed in so far during a live run.
  const courtOpinionSource = useMemo<CouncilOpinion[]>(
    () => (latest?.opinions?.length ? latest.opinions : streamingOpinions),
    [latest, streamingOpinions],
  );

  // Pure UI participants for the Court Stage. Built from the full selected
  // roster (so waiting agents are seated) merged with whatever has voted. The
  // "speaking" agent is the next un-voted floor agent — derived, no timer.
  const courtParticipants = useMemo<CourtParticipant[]>(() => {
    const opinionByAgent = new Map(courtOpinionSource.map((o) => [o.agentId, o] as const));
    const roster: Array<{ agentId: string; agentName: string; roleTitle: string }> = [];
    const seen = new Set<string>();
    for (const agent of selectedAgents) {
      const role = organizationMemberByAgentId.get(agent.id)?.role.roleTitle?.trim();
      roster.push({
        agentId: agent.id,
        agentName: agent.name,
        roleTitle: role || (isLikelyJudge(agent.name) ? "Orchestrator" : "Council Advocate"),
      });
      seen.add(agent.id);
    }
    for (const opinion of courtOpinionSource) {
      if (seen.has(opinion.agentId)) continue;
      roster.push({ agentId: opinion.agentId, agentName: opinion.agentName, roleTitle: opinion.roleTitle || "Council Advocate" });
      seen.add(opinion.agentId);
    }

    const judgeId = roster.find((r) => isLikelyJudge(`${r.roleTitle} ${r.agentName}`))?.agentId ?? roster[0]?.agentId ?? null;

    const dissentNames = new Set<string>();
    for (const d of latest?.dissent ?? []) for (const name of d.agentNames) dissentNames.add(name);

    const speakerId = running
      ? (roster.find((r) => r.agentId !== judgeId && !opinionByAgent.get(r.agentId)?.vote)?.agentId
        ?? roster.find((r) => !opinionByAgent.get(r.agentId)?.vote)?.agentId
        ?? null)
      : null;

    return roster.map((r) => {
      const opinion = opinionByAgent.get(r.agentId);
      const isWinner = Boolean(latest?.winner && opinion?.vote === latest.winner);
      let state: CourtAgentState;
      if (opinion?.error) state = "error";
      else if (settled && dissentNames.has(r.agentName) && !isWinner) state = "dissenting";
      else if (opinion?.vote) state = opinion.simulated ? "simulated" : "voted";
      else if (running && r.agentId === speakerId) state = "speaking";
      else if (running) state = "waiting";
      else state = "waiting";
      return {
        agentId: r.agentId,
        agentName: r.agentName,
        roleTitle: r.roleTitle,
        state,
        vote: opinion?.vote ?? null,
        confidence: typeof opinion?.confidence === "number" ? opinion.confidence : null,
        isJudge: r.agentId === judgeId,
        isWinner,
        simulated: opinion?.simulated,
        error: opinion?.error ?? null,
      };
    });
  }, [courtOpinionSource, latest, organizationMemberByAgentId, running, selectedAgents, settled]);

  const courtOpinions = useMemo<CourtOpinion[]>(
    () =>
      courtOpinionSource.map((o) => ({
        agentId: o.agentId,
        agentName: o.agentName,
        roleTitle: o.roleTitle || "Council Advocate",
        stance: o.stance,
        vote: o.vote,
        confidence: o.confidence,
        concerns: o.concerns,
        simulated: o.simulated,
        error: o.error,
      })),
    [courtOpinionSource],
  );

  const courtTally = useMemo(() => {
    if (latest?.tally?.length) return latest.tally.map((t) => ({ option: t.option, votes: t.votes }));
    if (streamingOpinions.length) {
      const counts = new Map<string, number>();
      for (const opt of options) counts.set(opt, 0);
      for (const o of streamingOpinions) {
        if (o.vote) counts.set(o.vote, (counts.get(o.vote) ?? 0) + 1);
      }
      return Array.from(counts.entries()).map(([option, votes]) => ({ option, votes }));
    }
    return [];
  }, [latest, options, streamingOpinions]);

  const courtTotalRounds = useMemo(
    () => latest?.rounds ?? (councilMode === "debate" ? debateRounds : 1),
    [councilMode, debateRounds, latest],
  );

  const courtRound = useMemo(() => {
    if (settled) return courtTotalRounds;
    if (!running) return 1;
    const maxRound = streamingOpinions.reduce((max, o) => Math.max(max, o.round ?? 1), 1);
    return Math.min(courtTotalRounds, Math.max(1, maxRound));
  }, [courtTotalRounds, running, settled, streamingOpinions]);

  const courtSources = useMemo(
    () => selectedDocuments.map((doc) => ({ id: doc.id, label: doc.name, kind: doc.sourceType })),
    [selectedDocuments],
  );

  const courtHasModerator = Boolean(synthesizerAgentId) || Boolean(latest?.synthesis);

  // WebChat follow-ups built from real, settled session state (no canned advice).
  const courtWebChatActions = useMemo<CourtStageWebChatAction[]>(() => {
    if (!settled || !latest) return [];
    const topicShort = latest.topic.split("\n")[0].slice(0, 140);
    const winner = latest.winner ?? "no decision";
    const actions: CourtStageWebChatAction[] = [
      {
        label: "Board task from verdict",
        prompt: `Create a board task from the council verdict on "${topicShort}". Winner: ${winner}. Mode: ${latest.decisionMode}. Summarize the conclusion and next steps.`,
      },
      {
        label: `Rerun with ${(latest.rounds ?? debateRounds) + 1} rounds`,
        prompt: `Rerun the council debate on "${topicShort}" with ${(latest.rounds ?? debateRounds) + 1} debate rounds and the same participants, then compare the new verdict to the previous winner (${winner}).`,
      },
    ];
    if ((latest.dissent?.length ?? 0) > 0) {
      const dissentNames = latest.dissent.flatMap((d) => d.agentNames).slice(0, 4).join(", ");
      actions.push({
        label: "Explore dissent risks",
        prompt: `Ask the dissenting council agents (${dissentNames}) to expand on the risks they raised against winner "${winner}" for topic "${topicShort}", and list mitigations.`,
      });
    }
    actions.push({
      label: "Turn verdict into workflow",
      prompt: `Design a workflow that operationalizes the council verdict "${winner}" for "${topicShort}". Plan it first; do not create it until I confirm.`,
    });
    return actions;
  }, [debateRounds, latest, settled]);

  const showCourtStage = running || streamingOpinions.length > 0 || Boolean(latest);

  useEffect(() => {
    if (!running || !showCourtStage) return;
    const frame = window.requestAnimationFrame(() => {
      courtStageRegionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [running, showCourtStage]);

  // Debate-feed filters (P1). All derived from real opinion fields.
  const debateRoundsAvailable = useMemo(() => {
    if (!latest) return [] as number[];
    const set = new Set<number>();
    for (const o of latest.opinions) set.add(o.round ?? 1);
    return Array.from(set).sort((a, b) => a - b);
  }, [latest]);

  const filteredOpinions = useMemo(() => {
    if (!latest) return [] as CouncilOpinion[];
    let list = latest.opinions;
    if (debateFeedFilter === "dissent") {
      list = list.filter((o) => (latest.winner ? o.vote !== latest.winner : true));
    } else if (debateFeedFilter === "high") {
      list = list.filter((o) => (o.confidence ?? 0) >= 70);
    } else if (debateFeedFilter === "issues") {
      list = list.filter((o) => o.simulated || Boolean(o.error));
    } else if (debateFeedFilter === "round" && debateRoundFilter !== "all") {
      list = list.filter((o) => (o.round ?? 1) === debateRoundFilter);
    }
    return list;
  }, [latest, debateFeedFilter, debateRoundFilter]);

  const debateFilterCounts = useMemo(() => {
    const ops = latest?.opinions ?? [];
    return {
      all: ops.length,
      dissent: latest?.winner ? ops.filter((o) => o.vote !== latest.winner).length : 0,
      high: ops.filter((o) => (o.confidence ?? 0) >= 70).length,
      issues: ops.filter((o) => o.simulated || Boolean(o.error)).length,
    };
  }, [latest]);

  const toggleAgent = (agentId: string) => {
    setSelectedAgentIds((current) =>
      current.includes(agentId)
        ? current.filter((id) => id !== agentId)
        : current.length >= MAX_COUNCIL_PARTICIPANTS
          ? current
          : [...current, agentId],
    );
  };

  const addDocument = () => {
    const nextId = documentPickerId.trim();
    if (!nextId) return;
    setSelectedDocumentIds((current) => {
      if (current.includes(nextId)) return current;
      return [...current, nextId].slice(0, 6);
    });
    setDocumentPickerId("");
  };

  const removeDocument = (documentId: string) => {
    setSelectedDocumentIds((current) => current.filter((entry) => entry !== documentId));
  };

  const saveTemplate = () => {
    const name = prompt("Template name:") || `Template ${savedTemplates.length + 1}`;
    const newTemplate = { name, topic, optionsText, mode: councilMode, votingMethod: decisionMode, participants: [...selectedAgentIds] };
    const updated = [...savedTemplates, newTemplate].slice(0, 20);
    setSavedTemplates(updated);
    localStorage.setItem("disp8ch-council-templates", JSON.stringify(updated));
  };

  const loadTemplate = (tpl: typeof savedTemplates[0]) => {
    setTopic(tpl.topic);
    setOptionsText(tpl.optionsText);
    setCouncilMode(tpl.mode);
    setDecisionMode(tpl.votingMethod as "majority" | "consensus" | "weighted" | "ranked");
    tpl.participants.forEach(id => {
      const checkbox = document.querySelector(`input[value="${id}"]`) as HTMLInputElement;
      if (checkbox) checkbox.click();
    });
  };

  const runCouncil = async () => {
    if (!canRun) return;
    setRunning(true);
    setLatest(null);
    setError(null);
    setVerdictTaskStatus("idle");
    setVerdictTaskMessage("");
    setStreamingOpinions([]);
    const effectiveTopic = [
      topic.trim(),
      selectedOrganization ? `Organization context: ${selectedOrganization.name}` : "",
      selectedGoal ? `Goal context: ${selectedGoal.name}${selectedGoal.description ? ` — ${selectedGoal.description}` : ""}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    const payload = {
      topic: effectiveTopic,
      agentIds: selectedAgentIds,
      documentIds: selectedDocumentIds,
      options,
      decisionMode,
      mode: councilMode,
      rounds: councilMode === "debate" ? debateRounds : undefined,
      synthesizerAgentId: synthesizerAgentId || undefined,
      discoverOptions: discoverOptions || undefined,
      costCapUsd: costCapUsd ?? undefined,
    };
    try {
      // C4: Use streaming endpoint for live progress
      const response = await fetch("/api/council/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok || !response.body) throw new Error("Stream request failed");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";
        for (const chunk of events) {
          const lines = chunk.split("\n");
          const eventLine = lines.find((l) => l.startsWith("event: "));
          const dataLine = lines.find((l) => l.startsWith("data: "));
          if (!eventLine || !dataLine) continue;
          const eventType = eventLine.slice(7).trim();
          try {
            const data = JSON.parse(dataLine.slice(5));
            if (eventType === "opinion") {
              setStreamingOpinions((prev) => [...prev, data as CouncilOpinion]);
            } else if (eventType === "done") {
              const result = data as CouncilResult;
              const entry: CouncilHistoryEntry = {
                ...result,
                sessionConfig: {
                  organizationId: selectedOrganizationId,
                  goalId: selectedGoalId,
                  documentIds: [...selectedDocumentIds],
                  agentIds: [...selectedAgentIds],
                  councilMode,
                  debateRounds,
                  synthesizerAgentId,
                  discoverOptions,
                  costCapUsd,
                },
              };
              setLatest(entry);
              setHistory((current) => [entry, ...current].slice(0, 50));
              setStreamingOpinions([]);
              // Persist to SQLite so sessions survive page refresh
              try {
                await fetch("/api/council/sessions", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    action: "save",
                    id: `council-${Date.now()}`,
                    orgId: selectedOrganizationId || null,
                    topic: entry.topic,
                    mode: councilMode,
                    votingMethod: decisionMode,
                    participants: selectedAgentIds,
                    options: options.map(o => o.trim()).filter(Boolean),
                    result: result,
                    verdict: result.conclusion ?? null,
                  }),
                });
              } catch { /* best-effort */ }
            } else if (eventType === "error") {
              setError(String((data as { message?: string }).message ?? data));
            }
          } catch { /* parse error — skip */ }
        }
      }
    } catch (runError) {
      setError(String(runError));
    } finally {
      setRunning(false);
    }
  };

  return (
        <main className="flex-1 overflow-auto p-6" data-perf-ready="council">
          <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <h1 className="text-2xl font-bold">Council</h1>
              <p className="text-sm text-muted-foreground">
                Stage a structured multi-agent debate and record a final verdict.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2 sm:justify-end">
              <Button variant="outline" size="sm" onClick={() => setHideGettingStarted((current) => !current)}>
                {hideGettingStarted ? "Show Tips" : "Hide Tips"}
              </Button>
              <Badge variant="outline">{selectedAgentIds.length}/{MAX_COUNCIL_PARTICIPANTS} selected</Badge>
              <Badge variant={running ? "default" : "secondary"}>{running ? "debating" : "idle"}</Badge>
            </div>
          </div>

          {/* ── Court Stage: compact readiness preview before a session, full live stage during/after a run ── */}
          {showCourtStage ? (
            <Card ref={courtStageRegionRef} className="mb-6 overflow-hidden border-border">
              <CardHeader className="border-b border-border py-3">
                <CardTitle className="inline-flex items-center gap-2 text-base">
                  <Scale className="h-4 w-4 text-terminal-red" />
                  Court Stage
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-4">
                <CourtStage
                  topic={topic.split("\n")[0]}
                  isRunning={running}
                  complete={settled}
                  mode={councilMode === "debate" ? "Debate" : "Poll"}
                  decisionMode={decisionMode}
                  round={courtRound}
                  totalRounds={courtTotalRounds}
                  participants={courtParticipants}
                  opinions={courtOpinions}
                  tally={courtTally}
                  verdict={latest?.winner ?? null}
                  conclusion={latest?.conclusion ?? null}
                  sources={courtSources}
                  hasModerator={courtHasModerator}
                  webChatActions={courtWebChatActions}
                  onAskWebChat={openWebChatWithPrompt}
                />
              </CardContent>
            </Card>
          ) : selectedAgentIds.length > 0 ? (
            <div className="mb-6 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card/60 px-3 py-2 text-[11px]" data-council-preview="1">
              <span className="inline-flex items-center gap-1.5 font-mono uppercase tracking-widest text-muted-foreground">
                <Scale className="h-3.5 w-3.5 text-terminal-red" />
                Ready
              </span>
              <Badge variant="secondary">{selectedAgentIds.length} participant{selectedAgentIds.length === 1 ? "" : "s"}</Badge>
              <Badge variant="outline">{councilMode === "debate" ? `Debate · ${debateRounds} rounds` : "Poll · single round"}</Badge>
              <Badge variant="outline" className="capitalize">{decisionMode}</Badge>
              <Badge variant="outline">{options.length} option{options.length === 1 ? "" : "s"}</Badge>
              {selectedDocuments.length > 0 ? <Badge variant="outline">Sources: {selectedDocuments.length}</Badge> : null}
              {courtHasModerator ? <Badge variant="outline">Moderator synthesis</Badge> : null}
              <span className="text-muted-foreground">Configure below, then run the session.</span>
            </div>
          ) : null}

          <Card className="mb-6 border-slate-700/60">
            <CardHeader>
              <CardTitle>New Council Session</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* ── Getting Started panel (only on first visit, before any vote) ── */}
              {!latest && !running && !hideGettingStarted ? (
                <div className="rounded-lg border border-slate-600/60 bg-slate-800/40 p-5 space-y-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="text-[10px] font-mono uppercase tracking-widest text-slate-400">GETTING STARTED — COUNCIL</div>
                    <button
                      type="button"
                      className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground transition-colors hover:text-terminal-red"
                      onClick={() => setHideGettingStarted(true)}
                    >
                      Dismiss
                    </button>
                  </div>
                  <p className="text-sm text-slate-300 max-w-2xl">
                    Council lets your AI agents debate a topic and vote on the best path forward. Pick individual agents directly, or use an organization only as a team filter. Agents argue, vote, and deliver a verdict.
                  </p>
                  <div className="grid gap-2 sm:grid-cols-2 text-[11px]">
                    <div className="border border-slate-700/60 p-3 space-y-1">
                      <div className="font-mono uppercase tracking-wide text-slate-400">How it works</div>
                      <ol className="list-decimal list-inside space-y-0.5 text-slate-400">
                        <li>Enter a debate topic or pick a preset</li>
	                        <li>Select individual agents, or filter by organization first</li>
                        <li>Define 2-5 options to vote on</li>
                        <li>Optionally attach data sources</li>
                        <li>Click <strong className="text-slate-300">Run Council Vote</strong></li>
                      </ol>
                    </div>
                    <div className="border border-slate-700/60 p-3 space-y-2">
                      <div className="font-mono uppercase tracking-wide text-slate-400">Best flow</div>
                      <div className="space-y-1.5 text-slate-400">
	                        <p>You do not need an organization. Use one only when you want the debate scoped to a saved team.</p>
                        <p>Add a goal when the debate should stay tied to one hierarchy objective.</p>
                        <p>Attach data sources when the council should argue from the same uploaded or crawled material.</p>
                      </div>
                    </div>
                  </div>
                </div>
              ) : null}

              {/* C7: Council Templates */}
              <div className="rounded-lg border border-border/70 bg-card/40 p-3">
                <div className="mb-2 text-xs font-mono uppercase tracking-widest text-muted-foreground">Council Templates</div>
                <div className="flex flex-wrap gap-2">
                  {COUNCIL_TEMPLATES.map((tpl) => (
                    <Button
                      key={tpl.id}
                      size="sm"
                      variant="outline"
                      className="text-[11px]"
                      onClick={() => {
                        setTopic(tpl.topic);
                        setOptionsText(tpl.optionsText);
                        setDecisionMode(tpl.decisionMode);
                        setCouncilMode(tpl.mode);
                      }}
                    >
                      {tpl.label}
                    </Button>
                  ))}
                </div>
              </div>

              <div className="rounded-lg border border-border/70 bg-card/40">
                <button
                  type="button"
                  className="flex w-full items-center justify-between px-3 py-2 text-left"
                  onClick={() => setShowPresetTopics((current) => !current)}
                >
                  <div>
                    <div className="text-xs text-muted-foreground">Preset topics</div>
                    <div className="text-[11px] text-muted-foreground">Optional starter topics and option sets.</div>
                  </div>
                  {showPresetTopics ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                </button>
                {showPresetTopics ? (
                  <div className="border-t border-border/60 px-3 py-3">
                    <div className="flex flex-wrap gap-2">
                      {[
                        {
                          label: "AI autonomy vs. safety",
                          topic: "How should an AI system balance user autonomy vs. safety guardrails when the user's explicit request conflicts with the system's ethical training — who has final authority and under what circumstances?",
                          options: "User autonomy is paramount: always execute explicit instructions, Graduated trust model: escalate to oversight for irreversible high-risk actions, Safety-first absolute guardrails: certain harm categories are hardcoded, Contextual ethics engine: real-time reasoning per action with no fixed rules, Delegated governance: enterprise deployers set per-deployment policies",
                        },
                        {
                          label: "Build vs. Buy AI infra",
                          topic: "Should a fast-growing startup build its own AI infrastructure (fine-tuned models, self-hosted vector DBs, custom orchestration) or rely entirely on third-party API services?",
                          options: "Build everything in-house for control and long-term cost savings, Buy all services from providers to maximise speed and reduce ops burden, Hybrid: use APIs for experimentation then migrate high-traffic paths in-house, Fully serverless third-party with multi-vendor lock-in mitigation contracts",
                        },
                        {
                          label: "RAG vs. fine-tuning",
                          topic: "For a production AI assistant that needs deep domain knowledge, should the team invest in RAG pipelines, fine-tuning foundation models, or a combination?",
                          options: "Pure RAG with hybrid search and reranking, Full fine-tune on domain corpus with no retrieval, Fine-tune for style and tone then add RAG for factual grounding, Agentic RAG with tool-calling and reflective eval loops",
                        },
                        {
                          label: "Monolith vs. microservices",
                          topic: "Should a team of 8 engineers building an AI platform migrate their working monolith to microservices, or continue iterating on the monolith?",
                          options: "Stay monolith until clear scaling bottleneck emerges, Migrate to microservices now to enable independent deployments, Modular monolith with clear domain boundaries as a middle path, Serverless functions for new features only, leaving core monolith intact",
                        },
                      ].map((preset) => (
                        <button
                          key={preset.label}
                          onClick={() => {
                            setTopic(preset.topic);
                            setOptionsText(preset.options);
                            setShowOptionEditor(false);
                          }}
                          className="rounded-full border border-border/60 px-3 py-1 text-xs text-muted-foreground hover:border-primary/60 hover:text-foreground transition-colors"
                        >
                          {preset.label}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
              <div className="space-y-1">
                <Label>Topic</Label>
                <Textarea rows={3} value={topic} onChange={(event) => setTopic(event.target.value)} />
              </div>

	              <div className="grid gap-4 md:grid-cols-2">
	                <div className="space-y-1">
	                  <Label>Team Filter (optional)</Label>
	                  <select
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                    value={selectedOrganizationId}
                    onChange={(event) => {
                      setSelectedOrganizationId(event.target.value);
                      setSelectedGoalId("");
                    }}
                  >
	                    <option value="">No team filter — choose from all agents</option>
                    {organizations.map((organization) => (
                      <option key={organization.id} value={organization.id}>
                        {organization.name} ({organization.memberCount} members)
                      </option>
                    ))}
	                  </select>
	                  <p className="text-[11px] text-muted-foreground">
	                    This only filters the participant list below. A council can run with any two active agents.
	                  </p>
	                </div>
                <div className="space-y-1">
                  <Label>Goal Context</Label>
                  <select
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                    value={selectedGoalId}
                    onChange={(event) => setSelectedGoalId(event.target.value)}
                    disabled={filteredGoals.length === 0}
                  >
                    <option value="">No goal context</option>
                    {filteredGoals.map((goal) => (
                      <option key={goal.id} value={goal.id}>
                        {goal.name}
                        {goal.parentGoalName ? ` <- ${goal.parentGoalName}` : ""}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

	              {selectedOrganization && organizationMembers.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-border/60 bg-muted/10 px-2 py-1.5">
                  <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">ORG PARTICIPANTS</span>
                  {organizationMembers.slice(0, MAX_COUNCIL_PARTICIPANTS).map((member) => (
                    <Badge key={`scope-member-${member.agent.id}`} variant="secondary" className="text-[11px]">
                      {member.agent.name}
                    </Badge>
                  ))}
                </div>
	              ) : null}

	              <div className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 bg-muted/10 px-3 py-2">
	                <div className="min-w-0 flex-1">
	                  <div className="text-xs font-semibold">Participants</div>
	                  <p className="text-[11px] text-muted-foreground">
	                    Select agents individually. {selectedOrganization ? `Currently filtered to ${selectedOrganization.name}.` : "Showing all active agents."}
	                  </p>
	                </div>
	                <Button
	                  type="button"
	                  size="sm"
	                  variant="outline"
	                  onClick={() => setSelectedAgentIds(visibleAgents.slice(0, MAX_COUNCIL_PARTICIPANTS).map((agent) => agent.id))}
                  disabled={visibleAgents.length === 0}
	                >
	                  Use visible agents
	                </Button>
	                <Button
	                  type="button"
	                  size="sm"
	                  variant="ghost"
	                  onClick={() => {
	                    setSelectedOrganizationId("");
	                    setSelectedGoalId("");
	                    setSelectedAgentIds(pickDefaultAgentIds(agents));
	                  }}
	                >
	                  Clear team filter
	                </Button>
	              </div>
              {selectedOrganization && organizationMembers.length === 0 && agents.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-border/60 bg-muted/10 px-2 py-1.5">
                  <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">AVAILABLE AGENTS</span>
                  {agents.slice(0, MAX_COUNCIL_PARTICIPANTS).map((agent) => (
                    <Badge key={`scope-agent-${agent.id}`} variant="secondary" className="text-[11px]">
                      {agent.name}
                    </Badge>
                  ))}
                </div>
              ) : null}

              {(selectedOrganization || selectedGoal || selectedDocuments.length > 0) ? (
                <div className="flex flex-wrap items-center gap-2">
                  {selectedOrganization ? <Badge variant="outline">org: {selectedOrganization.name}</Badge> : null}
                  {selectedGoal ? <Badge variant="secondary">goal: {selectedGoal.name}</Badge> : null}
                  {selectedDocuments.length > 0 ? <Badge variant="outline">data sources: {selectedDocuments.length}</Badge> : null}
                  {(selectedOrganizationId || selectedGoalId) ? (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          const params = new URLSearchParams();
                          if (selectedOrganizationId) params.set("org", selectedOrganizationId);
                          if (selectedGoalId) params.set("goal", selectedGoalId);
                          router.push(`/hierarchy?${params.toString()}`);
                        }}
                      >
                        Open Hierarchy
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          const params = new URLSearchParams();
                          if (selectedOrganizationId) params.set("org", selectedOrganizationId);
                          if (selectedGoalId) params.set("goal", selectedGoalId);
                          router.push(`/boards?${params.toString()}`);
                        }}
                      >
                        Open Boards
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          const params = new URLSearchParams();
                          if (selectedOrganizationId) params.set("org", selectedOrganizationId);
                          if (selectedGoalId) params.set("goal", selectedGoalId);
                          router.push(`/workflows?${params.toString()}`);
                        }}
                      >
                        Open Workflows
                      </Button>
                    </>
                  ) : null}
                </div>
              ) : null}

              <div className="grid gap-4 md:grid-cols-[minmax(0,1.6fr)_minmax(260px,0.8fr)]">
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <Label>Vote Options</Label>
                      <p className="text-[11px] text-muted-foreground">
                        Define the positions the council will debate and vote on.
                      </p>
                    </div>
                    <Button variant="outline" size="sm" onClick={() => setShowOptionEditor((current) => !current)}>
                      {showOptionEditor ? "Hide Options" : "Edit Options"}
                    </Button>
                  </div>
                  <div className="rounded-md border border-border/70 bg-card/40 px-3 py-3">
                    <div className="mb-2 flex items-center gap-2">
                      <Badge variant="secondary">{options.length} options</Badge>
                      {!showOptionEditor ? (
                        <span className="text-[11px] text-muted-foreground">Showing a compact preview.</span>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {(showOptionEditor ? options : options.slice(0, 3)).map((option) => (
                        <Badge key={`option-${option}`} variant="outline" className="max-w-full whitespace-normal text-left leading-5">
                          {option}
                        </Badge>
                      ))}
                      {!showOptionEditor && options.length > 3 ? (
                        <Badge variant="outline">+{options.length - 3} more</Badge>
                      ) : null}
                    </div>
                    {showOptionEditor ? (
                      <Textarea
                        rows={6}
                        className="mt-3"
                        value={optionsText}
                        onChange={(event) => setOptionsText(event.target.value)}
                      />
                    ) : null}
                  </div>
                </div>
                <div className="md:col-span-2 border-t border-border/40 pt-3">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground"
                    onClick={() => setShowAdvanced((value) => !value)}
                  >
                    {showAdvanced
                      ? "▾ Hide advanced options"
                      : "▸ Advanced options — decision method, debate rounds, moderator, cost cap, data sources"}
                  </Button>
                </div>
                {showAdvanced && (<>
                <div className="space-y-1">
                  <Label>Decision Mode</Label>
                  <select
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                    value={decisionMode}
                    onChange={(event) => setDecisionMode(event.target.value as "majority" | "consensus" | "weighted" | "ranked")}
                  >
                    <option value="majority">Majority</option>
                    <option value="consensus">Consensus</option>
                    <option value="weighted">Weighted (by role)</option>
                    <option value="ranked">Ranked Choice</option>
                  </select>
                  <p className="text-[11px] text-muted-foreground">
                    {decisionMode === "weighted"
                      ? "Weighted mode uses each participant's saved hierarchy vote weight."
                      : decisionMode === "ranked"
                        ? "Ranked mode scores each participant's ranked alternatives instead of one top vote."
                        : decisionMode === "consensus"
                          ? "Consensus requires the full council to converge on one option."
                          : "Majority counts one top vote per participant."}
                  </p>
                </div>
                <div className="space-y-1">
                  <Label>Council Mode</Label>
                  <select
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                    value={councilMode}
                    onChange={(event) => setCouncilMode(event.target.value as "poll" | "debate")}
                  >
                    <option value="poll">Poll (single round)</option>
                    <option value="debate">Debate (multi-round)</option>
                  </select>
                </div>
                {councilMode === "debate" && (
                  <div className="space-y-1">
                    <Label>Debate Rounds</Label>
                    <select
                      className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                      value={debateRounds}
                      onChange={(event) => setDebateRounds(Number(event.target.value))}
                    >
                      <option value={2}>2 rounds</option>
                      <option value={3}>3 rounds (recommended)</option>
                      <option value={4}>4 rounds</option>
                      <option value={5}>5 rounds</option>
                    </select>
                  </div>
                )}
                <div className="space-y-1">
                  <Label>Moderator Agent (optional)</Label>
                  <select
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                    value={synthesizerAgentId}
                    onChange={(event) => setSynthesizerAgentId(event.target.value)}
                  >
                    <option value="">No synthesis</option>
                    {agents.filter((a) => a.isActive).map((a, index) => (
                      <option key={a.id} value={a.id}>
                        Agent {index + 1}
                      </option>
                    ))}
                  </select>
                  <p className="text-[11px] text-muted-foreground">Chosen agent writes a synthesis verdict after voting.</p>
                </div>
                <div className="flex items-center gap-2 pt-1">
                  <input
                    type="checkbox"
                    id="discover-options"
                    checked={discoverOptions}
                    onChange={(e) => setDiscoverOptions(e.target.checked)}
                    className="h-4 w-4"
                  />
                  <Label htmlFor="discover-options" className="cursor-pointer text-sm">Discover options from agents</Label>
                </div>
                <div className="space-y-1">
                  <Label>Cost Cap (USD, optional)</Label>
                  <Input
                    type="number"
                    min="0.01"
                    step="0.01"
                    placeholder="e.g. 0.50"
                    value={costCapUsd ?? ""}
                    onChange={(e) => setCostCapUsd(e.target.value ? Number(e.target.value) : null)}
                    className="text-sm"
                  />
                </div>
                </>)}
              </div>

              {showAdvanced && (
              <div className="space-y-2">
                <Label>Data Sources</Label>
                <p className="text-xs text-muted-foreground">
                  Attach stored sources from the Data Sources tab so the council argues from the same uploaded or crawled material.
                </p>
                <div className="flex flex-wrap gap-2">
                  <select
                    className="min-w-[260px] flex-1 rounded-md border bg-background px-3 py-2 text-sm"
                    value={documentPickerId}
                    onChange={(event) => setDocumentPickerId(event.target.value)}
                  >
                    <option value="">Select data source</option>
                    {documents
                      .filter((document) => !selectedDocumentIds.includes(document.id))
                      .map((document) => (
                        <option key={document.id} value={document.id}>
                          {document.name} ({document.sourceType})
                        </option>
                      ))}
                  </select>
                  <Button variant="outline" onClick={addDocument} disabled={!documentPickerId}>
                    Add Source
                  </Button>
                  {selectedGoal && goalDocumentIds.length > 0 ? (
                    <Button
                      variant="outline"
                      onClick={applyGoalDocuments}
                      disabled={!canApplyGoalDocuments}
                      title={`Add ${goalDocumentIds.length} document(s) linked to goal "${selectedGoal.name}"`}
                    >
                      Use Goal Documents ({goalDocumentIds.length})
                    </Button>
                  ) : null}
                </div>
                {selectedDocuments.length === 0 ? (
                  <div className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
                    No data sources attached to this council session.
                  </div>
                ) : (
                  <div className="space-y-2 rounded-md border bg-muted/20 p-3">
                    {selectedDocuments.map((document) => (
                      <div key={document.id} className="flex items-start justify-between gap-3 rounded-md border bg-background/70 px-3 py-2">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-medium">{document.name}</span>
                            <Badge variant="outline" className="text-[10px]">{document.sourceType}</Badge>
                            <Badge variant="secondary" className="text-[10px]">{document.id}</Badge>
                          </div>
                          {document.sourceUrl ? (
                            <div className="truncate text-[11px] text-muted-foreground">{document.sourceUrl}</div>
                          ) : null}
                          <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">{document.excerpt}</div>
                        </div>
                        <Button variant="ghost" size="sm" onClick={() => removeDocument(document.id)}>
                          Remove
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              )}

              <div className="space-y-2">
                <Label>Participants</Label>
                {selectedOrganization ? (
                  <p className="text-xs text-muted-foreground">
                    Scoped to {selectedOrganization.name}. Participants come from the saved organization snapshot, up to {MAX_COUNCIL_PARTICIPANTS} agents.
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Select any active agents, or choose an organization to load its hierarchy members automatically. Council supports up to {MAX_COUNCIL_PARTICIPANTS} participants.
                  </p>
                )}
                {selectedOrganization && organizationMembers.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-border/60 bg-muted/10 px-2 py-1.5">
                    <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">ORG PARTICIPANTS</span>
                    {organizationMembers.slice(0, MAX_COUNCIL_PARTICIPANTS).map((member) => (
                      <Badge key={`member-${member.agent.id}`} variant="secondary" className="text-[11px]">
                        {member.agent.name}
                      </Badge>
                    ))}
                  </div>
                ) : null}
                {participantRoleGroups.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-border/60 bg-muted/10 px-2 py-1.5">
                    <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">BY ROLE</span>
                    {participantRoleGroups.map((group) => (
                      <Badge key={`role-${group.role}`} variant="outline" className="text-[11px]">
                        {group.role} ×{group.count}
                      </Badge>
                    ))}
                  </div>
                ) : null}
                <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                      {visibleAgents.map((agent) => {
                        const selected = selectedAgentIds.includes(agent.id);
                        const orgMember = organizationMemberByAgentId.get(agent.id);
                        return (
                          <label
                            key={agent.id}
                            className={cn(
                              "flex items-center gap-3 rounded-lg border px-3 py-2 text-sm transition-colors",
                              selected
                                ? "border-primary/60 bg-primary/10"
                                : "border-border/70 bg-card/40 hover:border-primary/40",
                            )}
                          >
                            <input type="checkbox" checked={selected} onChange={() => toggleAgent(agent.id)} />
                            <AgentGlyph seed={agent.id} className="h-8 w-8" />
                            <div className="min-w-0">
                              <div className="flex items-center gap-1.5">
                                <span className="truncate">{agent.name}</span>
                                {orgMember?.role.roleTitle ? (
                                  <Badge variant="outline" className="text-[10px] shrink-0">{orgMember.role.roleTitle}</Badge>
                                ) : null}
                              </div>
                              <div className="truncate text-[11px] text-muted-foreground">{resolveAgentModelLabel(agent)}</div>
                            </div>
                            {decisionMode === "weighted" && orgMember?.role.voteWeight ? (
                              <Badge variant="outline">wt {orgMember.role.voteWeight}</Badge>
                            ) : null}
                            {agent.isDefault ? <Badge variant="secondary">default</Badge> : null}
                          </label>
                        );
                      })}
                </div>
              </div>

              {error ? (
                <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">{error}</div>
              ) : null}

              <div className="flex items-center gap-2">
                <Button disabled={!canRun || running} onClick={() => void runCouncil()}>
                  {running ? (
                    <span className="inline-flex items-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Running Council...
                    </span>
                  ) : (
                    "Run Council Vote"
                  )}
                </Button>
                <Button variant="outline" size="sm" onClick={saveTemplate} disabled={!canRun}>
                  Save Template
                </Button>
                {savedTemplates.length > 0 ? (
                  <select
                    className="h-7 rounded-md border bg-background px-2 text-xs"
                    onChange={(e) => {
                      const tpl = savedTemplates[Number(e.target.value)];
                      if (tpl) loadTemplate(tpl);
                    }}
                    defaultValue=""
                  >
                    <option value="" disabled>Load template...</option>
                    {savedTemplates.map((tpl, i) => (
                      <option key={i} value={i}>{tpl.name}</option>
                    ))}
                  </select>
                ) : null}
              </div>
            </CardContent>
          </Card>

          {latest ? (
            <Card className="mb-6 border-slate-700/60">
              <CardHeader>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle>Final Verdict</CardTitle>
                  <Badge variant={latest.reachedConsensus ? "default" : "secondary"}>
                    {latest.reachedConsensus ? "Decision Reached" : "No Final Decision"}
                  </Badge>
                </div>
                <RelatedWorkTrailStrip
                  className="mt-3"
                  surface="council"
                  objectType="council-session"
                  objectId={latest.createdAt}
                  objectName={latest.topic.slice(0, 80)}
                />
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={verdictTaskStatus === "creating"}
                    onClick={async () => {
                      const verdictLine = latest.winner ? `Winner: ${latest.winner}` : "Verdict: Undecided";
                      setVerdictTaskStatus("creating");
                      setVerdictTaskMessage("");
                      try {
                        const response = await fetch("/api/boards/tasks", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({
                            title: `Council verdict: ${latest.topic.slice(0, 80)}`,
                            description: `${verdictLine}\nMode: ${latest.decisionMode}\nParticipants: ${latest.participants}\n\n${latest.conclusion}`,
                            status: "inbox",
                            priority: "medium",
                            organizationId: selectedOrganizationId || undefined,
                            goalId: selectedGoalId || undefined,
                          }),
                        });
                        const json = await response.json().catch(() => null);
                        if (!response.ok || !json?.success) {
                          setVerdictTaskStatus("error");
                          setVerdictTaskMessage(String(json?.error || "Failed to create board task."));
                          return;
                        }
                        invalidateCache(/^boards/);
                        setVerdictTaskStatus("created");
                        setVerdictTaskMessage("Board task created from this verdict.");
                        setError(null);
                      } catch (taskError) {
                        setVerdictTaskStatus("error");
                        setVerdictTaskMessage(`Failed to create board task: ${String(taskError)}`);
                      }
                    }}
                  >
                    {verdictTaskStatus === "creating" ? "Creating task..." : "+ Board task from verdict"}
                  </Button>
                  <ProposeMemoryButton
                    originType="council"
                    originId={latest.createdAt}
                    defaultContent={`${latest.winner ? `Council decision: ${latest.winner}. ` : ""}${latest.conclusion}`}
                    defaultType="decision"
                    sourceSummary={`Council verdict on "${latest.topic.slice(0, 80)}"`}
                    evidence={[`council_session=${latest.createdAt}`, `mode=${latest.decisionMode}`]}
                    label="Propose memory"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      const params = new URLSearchParams();
                      if (selectedOrganizationId) params.set("org", selectedOrganizationId);
                      if (selectedGoalId) params.set("goal", selectedGoalId);
                      router.push(`/boards${params.toString() ? `?${params.toString()}` : ""}`);
                    }}
                  >
                    Open in Boards
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      const params = new URLSearchParams();
                      if (selectedOrganizationId) params.set("org", selectedOrganizationId);
                      if (selectedGoalId) params.set("goal", selectedGoalId);
                      router.push(`/workflows${params.toString() ? `?${params.toString()}` : ""}`);
                    }}
                  >
                    Open in Workflows
                  </Button>
                </div>
                {verdictTaskMessage ? (
                  <div
                    className={[
                      "mt-2 rounded-md border px-3 py-2 text-xs",
                      verdictTaskStatus === "created"
                        ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                        : "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300",
                    ].join(" ")}
                    role="status"
                  >
                    {verdictTaskMessage}
                  </div>
                ) : null}
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-3 md:grid-cols-6">
                  <div className="rounded-lg border p-3">
                    <div className="text-xs text-muted-foreground">Winner</div>
                    <div className="text-base font-semibold">{latest.winner ?? "Undecided"}</div>
                  </div>
                  <div className="rounded-lg border p-3">
                    <div className="text-xs text-muted-foreground">Participants</div>
                    <div className="text-base font-semibold">{latest.participants}</div>
                  </div>
                  <div className="rounded-lg border p-3">
                    <div className="text-xs text-muted-foreground">Total Tokens</div>
                    <div className="text-base font-semibold">{latest.totalTokens}</div>
                  </div>
                  <div className="rounded-lg border p-3">
                    <div className="text-xs text-muted-foreground">Total Cost</div>
                    <div className="text-base font-semibold">{formatUsd(latest.totalCostUsd)}</div>
                  </div>
                  <div className="rounded-lg border p-3">
                    <div className="text-xs text-muted-foreground">Simulated Votes</div>
                    <div className="text-base font-semibold">{latest.simulatedCount}</div>
                  </div>
                  <div className="rounded-lg border p-3">
                    <div className="text-xs text-muted-foreground">Mode</div>
                    <div className="text-base font-semibold capitalize">{latest.decisionMode}</div>
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-medium">Vote Tally</div>
                    <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                      {latest.decisionMode === "ranked"
                        ? "RANKED CHOICE · POINTS BY OPTION"
                        : latest.decisionMode === "weighted"
                          ? "WEIGHTED · ROLE-VOTE SUM"
                          : latest.decisionMode === "consensus"
                            ? "CONSENSUS · FULL CONVERGENCE REQUIRED"
                            : "MAJORITY · ONE VOTE PER PARTICIPANT"}
                    </span>
                  </div>
                  {(() => {
                    const totalPoints = latest.tally.reduce((sum, item) => sum + item.votes, 0);
                    const sortedTally = [...latest.tally].sort((a, b) => b.votes - a.votes);
                    const rankMedal = (index: number) => (index === 0 ? "1st" : index === 1 ? "2nd" : index === 2 ? "3rd" : `#${index + 1}`);
                    return sortedTally.map((item, index) => {
                      const isRanked = latest.decisionMode === "ranked";
                      const denom = isRanked ? totalPoints : latest.participants;
                      const percent = denom > 0 ? (item.votes / denom) * 100 : 0;
                      const isWinner = latest.winner === item.option;
                      const label = isRanked ? "points" : latest.decisionMode === "weighted" ? "weight" : "votes";
                      return (
                        <div
                          key={`${latest.createdAt}-${item.option}`}
                          className={cn(
                            "rounded-lg border p-2",
                            isWinner ? "border-emerald-500/50 bg-emerald-500/5" : "",
                          )}
                        >
                          <div className="mb-1 flex items-center justify-between gap-2 text-sm">
                            <div className="flex min-w-0 items-center gap-2">
                              {isRanked ? (
                                <Badge variant={index < 3 ? "default" : "secondary"} className="shrink-0 text-[10px]">
                                  {rankMedal(index)}
                                </Badge>
                              ) : null}
                              <span className="truncate">{item.option}</span>
                            </div>
                            <span className="shrink-0 text-muted-foreground">
                              {item.votes} {label} · {percent.toFixed(0)}%
                            </span>
                          </div>
                          <div className="h-2 rounded bg-muted">
                            <div
                              className={cn(
                                "h-2 rounded",
                                isWinner ? "bg-emerald-500" : isRanked && index < 3 ? "bg-primary/80" : "bg-primary/50",
                              )}
                              style={{ width: `${percent}%` }}
                            />
                          </div>
                        </div>
                      );
                    });
                  })()}
                </div>

                <div className="rounded-lg border border-emerald-400/50 bg-emerald-500/10 p-3 text-sm">
                  <div className="mb-1 font-medium">Court Conclusion</div>
                  <p className="text-muted-foreground">{latest.conclusion}</p>
                  {typeof latest.rounds === "number" && latest.rounds > 1 && (
                    <p className="mt-1 text-[11px] text-emerald-300/70">{latest.rounds}-round debate</p>
                  )}
                </div>

                {/* C2: Moderator Synthesis */}
                {latest.synthesis && (
                  <div className="rounded-lg border border-blue-400/40 bg-blue-500/10 p-3 text-sm space-y-1">
                    <div className="flex items-center gap-2 font-medium">
                      <Sparkles className="h-4 w-4 text-blue-300" />
                      Moderator Synthesis
                    </div>
                    <p className="text-muted-foreground whitespace-pre-line">{latest.synthesis}</p>
                  </div>
                )}

                {/* C5: Dissent */}
                {latest.dissent && latest.dissent.length > 0 && (
                  <div className="rounded-lg border border-amber-400/40 bg-amber-500/10 p-3 text-sm space-y-2">
                    <div className="font-medium text-amber-200">Dissenting Positions</div>
                    {latest.dissent.map((d) => (
                      <div key={d.vote} className="space-y-0.5">
                        <div className="text-xs font-mono text-amber-300">&quot;{d.vote}&quot; — {d.agentNames.join(", ")}</div>
                        <p className="text-xs text-muted-foreground">{d.summary}</p>
                      </div>
                    ))}
                  </div>
                )}

                {latest.simulatedCount > 0 ? (
                  <div className="rounded-lg border border-yellow-500/40 bg-yellow-500/10 p-3 text-xs text-yellow-200">
                    {latest.simulatedCount} vote(s) were simulated because those agents do not have an active provider
                    key configured.
                  </div>
                ) : null}

                {/* C9: Follow-up tasks from concerns */}
                {latest.opinions.some((o) => o.concerns && o.concerns.length > 10) && (
                  <div className="rounded-lg border border-border/60 bg-muted/10 p-3 space-y-2">
                    <div className="text-sm font-medium">Follow-up Actions</div>
                    <p className="text-xs text-muted-foreground">Create a board task for each concern raised by participants.</p>
                    <div className="flex flex-wrap gap-2">
                      {latest.opinions
                        .filter((o) => o.concerns && o.concerns.length > 10)
                        .slice(0, 5)
                        .map((o) => (
                          <Button
                            key={`followup-${o.agentId}-${latest.createdAt}`}
                            size="sm"
                            variant="outline"
                            className="text-[11px] max-w-[260px] truncate"
                            title={o.concerns}
                            onClick={async () => {
                              try {
                                await fetch("/api/boards/tasks", {
                                  method: "POST",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({
                                    title: `Council concern: ${o.concerns.slice(0, 80)}`,
                                    description: `Raised by ${o.agentName} (${o.roleTitle}) in council vote on: ${latest.topic.slice(0, 120)}`,
                                    status: "inbox",
                                    priority: "medium",
                                  }),
                                });
                                invalidateCache(/^boards/);
                              } catch { /* ignore */ }
                            }}
                          >
                            + {o.agentName}: {o.concerns.slice(0, 40)}…
                          </Button>
                        ))}
                    </div>
                  </div>
                )}

                <div className="space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-sm font-medium">Debate Feed</div>
                    <div className="flex flex-wrap items-center gap-1">
                      {([
                        { id: "all", label: `All${debateFilterCounts.all ? ` (${debateFilterCounts.all})` : ""}` },
                        { id: "dissent", label: `Dissent${debateFilterCounts.dissent ? ` (${debateFilterCounts.dissent})` : ""}` },
                        { id: "high", label: `High confidence${debateFilterCounts.high ? ` (${debateFilterCounts.high})` : ""}` },
                        { id: "issues", label: `Errors/sim${debateFilterCounts.issues ? ` (${debateFilterCounts.issues})` : ""}` },
                        ...(debateRoundsAvailable.length > 1 ? [{ id: "round", label: "By round" }] : []),
                      ] as Array<{ id: typeof debateFeedFilter; label: string }>).map((chip) => (
                        <button
                          key={chip.id}
                          type="button"
                          onClick={() => setDebateFeedFilter(chip.id)}
                          className={cn(
                            "rounded-full border px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider transition-colors",
                            debateFeedFilter === chip.id
                              ? "border-terminal-red/60 bg-terminal-red/10 text-terminal-red"
                              : "border-border bg-card text-muted-foreground hover:text-foreground",
                          )}
                        >
                          {chip.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  {debateFeedFilter === "round" && debateRoundsAvailable.length > 1 ? (
                    <div className="flex flex-wrap items-center gap-1">
                      <button
                        type="button"
                        onClick={() => setDebateRoundFilter("all")}
                        className={cn(
                          "rounded border px-1.5 py-0.5 text-[10px] font-mono",
                          debateRoundFilter === "all" ? "border-terminal-red/60 text-terminal-red" : "border-border text-muted-foreground",
                        )}
                      >
                        All rounds
                      </button>
                      {debateRoundsAvailable.map((r) => (
                        <button
                          key={`round-${r}`}
                          type="button"
                          onClick={() => setDebateRoundFilter(r)}
                          className={cn(
                            "rounded border px-1.5 py-0.5 text-[10px] font-mono",
                            debateRoundFilter === r ? "border-terminal-red/60 text-terminal-red" : "border-border text-muted-foreground",
                          )}
                        >
                          Round {r}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {filteredOpinions.length === 0 ? (
                    <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
                      No opinions match this filter.
                    </p>
                  ) : null}
                  {filteredOpinions.map((opinion) => (
                    <article
                      key={`${latest.createdAt}-${opinion.agentId}`}
                      className={cn(
                        "rounded-xl border p-3",
                        latest.winner && opinion.vote === latest.winner
                          ? "border-emerald-500/40 bg-emerald-500/5"
                          : "border-border/70",
                      )}
                    >
                      <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
                        <AgentGlyph seed={opinion.agentId} className="h-8 w-8" />
                        <span className="font-semibold">{opinion.agentName}</span>
                        <Badge variant="outline">{opinion.roleTitle || "Role"}</Badge>
                        <Badge>{opinion.vote}</Badge>
                        <Badge variant="secondary">confidence {opinion.confidence}%</Badge>
                        <Badge variant="outline">
                          {opinion.provider}/{opinion.model}
                        </Badge>
                        {opinion.simulated ? <Badge variant="secondary">simulated</Badge> : null}
                        {opinion.error ? <Badge variant="destructive">error</Badge> : null}
                      </div>

                      <p className="text-sm text-muted-foreground">{opinion.stance}</p>

                      {opinion.decisionProcess?.length ? (
                        <div className="mt-2 rounded-lg border bg-muted/20 p-2">
                          <div className="mb-1 text-xs font-medium text-muted-foreground">Decision Process</div>
                          <ol className="list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
                            {opinion.decisionProcess.slice(0, 6).map((step, stepIndex) => (
                              <li key={`${latest.createdAt}-${opinion.agentId}-step-${stepIndex}`}>{step}</li>
                            ))}
                          </ol>
                        </div>
                      ) : null}

                      {opinion.concerns ? (
                        <p className="mt-2 text-xs text-muted-foreground">Concerns: {opinion.concerns}</p>
                      ) : null}
                    </article>
                  ))}
                </div>
              </CardContent>
            </Card>
          ) : null}

          <Card className="border-slate-700/60">
            <CardHeader>
              <CardTitle>Recent Council Sessions</CardTitle>
            </CardHeader>
            <CardContent>
              {history.length === 0 ? (
                <EmptyState
                  title="No council sessions yet"
                  description="Run a debate from this tab, or ask WebChat to have an organization debate a decision and create follow-up work."
                  secondaryAction={(
                    <button
                      type="button"
                      className="inline-flex h-9 items-center rounded-md border border-input bg-transparent px-3 text-xs font-medium hover:bg-primary hover:text-primary-foreground"
                      onClick={() => openWebChatWithPrompt("Have my active organization debate the next important decision, summarize dissent, and create board follow-ups after I confirm.")}
                    >
                      Draft in WebChat
                    </button>
                  )}
                />
              ) : (
                <div className="space-y-2">
                  {history.map((entry) => {
                    const sum = summarizeHistoryEntry(entry);
                    const orgName = sum.orgId ? organizations.find((o) => o.id === sum.orgId)?.name : null;
                    const goalName = sum.goalId ? goals.find((g) => g.id === sum.goalId)?.name : null;
                    const startedFromWebChat = Boolean((entry as unknown as Record<string, unknown>).source === "webchat");
                    return (
                    <div key={`history-${sum.createdAt || entry.createdAt}`} className="rounded-lg border px-3 py-2 text-sm">
                      <div className="mb-1 flex items-center justify-between gap-2">
                        <span className="font-medium truncate max-w-[60%]" title={sum.topic}>{sum.topic.slice(0, 80)}{sum.topic.length > 80 ? "…" : ""}</span>
                        <div className="flex items-center gap-1 shrink-0">
                          <Badge variant={sum.reachedConsensus ? "default" : "secondary"}>
                            {sum.winner ?? "Undecided"}
                          </Badge>
                          {/* C8: Rerun */}
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 px-2 text-[10px]"
                            onClick={() => {
                              setTopic(entry.topic);
                              setOptionsText(entry.options.join("\n"));
                              setDecisionMode(entry.decisionMode);
                              const cfg = entry.sessionConfig;
                              if (cfg) {
                                setSelectedOrganizationId(cfg.organizationId || "");
                                setSelectedGoalId(cfg.goalId || "");
                                setSelectedDocumentIds([...cfg.documentIds]);
                                if (cfg.agentIds.length > 0) {
                                  setSelectedAgentIds([...cfg.agentIds]);
                                }
                                setCouncilMode(cfg.councilMode);
                                setDebateRounds(cfg.debateRounds);
                                setSynthesizerAgentId(cfg.synthesizerAgentId);
                                setDiscoverOptions(cfg.discoverOptions);
                                setCostCapUsd(cfg.costCapUsd);
                              }
                              setLatest(null);
                              window.scrollTo({ top: 0, behavior: "smooth" });
                            }}
                            title="Restore full session state (topic, options, mode, org, goal, documents, participants, rounds)"
                          >
                            Rerun
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 px-2 text-[10px] text-red-400 hover:text-red-300"
                            onClick={async () => {
                              if (!confirm("Delete this council session?")) return;
                              setHistory((current) => current.filter((e) => e.createdAt !== entry.createdAt));
                              try {
                                await fetch("/api/council/sessions", {
                                  method: "POST",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({ action: "delete", id: (entry as Record<string, unknown>).id }),
                                });
                              } catch { /* best-effort */ }
                            }}
                            title="Delete this session"
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                        <span>{sum.createdAt ? new Date(sum.createdAt).toLocaleString() : "—"}</span>
                        <Badge variant="outline" className="text-[10px] capitalize">{sum.mode}</Badge>
                        <Badge variant="outline" className="text-[10px] capitalize">{sum.decisionMode}</Badge>
                        <Badge variant="outline" className="text-[10px]">{sum.participantsCount} agents</Badge>
                        {sum.rounds > 1 ? <Badge variant="outline" className="text-[10px]">{sum.rounds} rounds</Badge> : null}
                        {orgName ? <Badge variant="secondary" className="text-[10px]">org: {orgName}</Badge> : null}
                        {goalName ? <Badge variant="secondary" className="text-[10px]">goal: {goalName}</Badge> : null}
                        {sum.dissentCount > 0 ? <Badge variant="outline" className="text-[10px] border-amber-500/40 text-amber-300">{sum.dissentCount} dissent</Badge> : null}
                        {sum.concernsCount > 0 ? <Badge variant="outline" className="text-[10px]">{sum.concernsCount} follow-up{sum.concernsCount === 1 ? "" : "s"}</Badge> : null}
                        {sum.simulatedCount > 0 ? <Badge variant="outline" className="text-[10px]">{sum.simulatedCount} simulated</Badge> : null}
                        {startedFromWebChat ? <Badge variant="outline" className="text-[10px] border-blue-400/40 text-blue-300">Started from WebChat</Badge> : null}
                      </div>
                    </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </main>
  );
}

export default function CouncilPage() {
  return (
    <Suspense>
      <CouncilPageInner />
    </Suspense>
  );
}
