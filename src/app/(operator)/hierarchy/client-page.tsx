"use client";

import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetBody } from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { SurfaceHeader } from "@/components/app/surface-header";
import { RelatedWorkTrailStrip } from "@/components/work-trails/related-work-trail-strip";
import { ShapeAvatar } from "@/components/agents/shape-avatar";
import { workflowUsesAgent } from "@/lib/agents/workflow-insights";
import {
  OrgStatsDynamic,
  GettingStartedDynamic,
  CrewOpsDynamic,
  SourcePacksDynamic,
  TemplatesPanelDynamic,
  ResearchTeamPanelDynamic,
} from "@/app/hierarchy/dynamic-panels";
import { APP_TTL, cachedJson, invalidateCache } from "@/lib/client/app-data-cache";
import { useAfterUseful } from "@/lib/client/use-after-useful";
import { readPreloadedBootstrap } from "@/lib/client/preloaded-bootstrap";

type AgentRoleType = "orchestrator" | "operations" | "specialist" | "worker" | "support";

type AgentRole = {
  agentId: string;
  agentName: string;
  agentActive: boolean;
  isDefault: boolean;
  roleType: AgentRoleType;
  roleTitle: string;
  roleDescription: string;
  reportsTo: string | null;
  capabilities: string[];
  voteWeight: number;
};

type AgentRoleDraft = {
  roleType: AgentRoleType;
  roleTitle: string;
  roleDescription: string;
  reportsTo: string | null;
  capabilitiesText: string;
  voteWeight: number;
};

type HierarchyLedgerEvent = {
  id: string;
  organizationId: string | null;
  goalId: string | null;
  agentId: string | null;
  eventType: string;
  title: string;
  summary: string | null;
  status: string | null;
  costUsd: number;
  tokenCount: number;
  createdAt: string;
};

type BoardTask = {
  id: string;
  boardId: string;
  boardName: string | null;
  organizationId: string | null;
  goalId: string | null;
  goalName: string | null;
  title: string;
  description: string | null;
  workflowTemplateKey: string | null;
  workflowId: string | null;
  assignedAgentId: string | null;
  assignedAgentName?: string | null;
  checkedOutByAgentId?: string | null;
  checkedOutByAgentName?: string | null;
  priority?: "low" | "medium" | "high";
  sourceType?: string | null;
  sourceRef?: string | null;
  linkedDocumentIds: string[];
  deliverables: string[];
  updatedAt?: string;
  blockedBy?: string[];
  status: "inbox" | "in_progress" | "review" | "done" | "blocked";
};

type WorkflowNode = {
  id: string;
  type: string;
  data?: Record<string, unknown>;
};

type WorkflowSummary = {
  id: string;
  name: string;
  description?: string | null;
  organizationId?: string | null;
  goalId?: string | null;
  sourceType?: string | null;
  sourceRef?: string | null;
  isActive: boolean;
  nodes: WorkflowNode[];
  lastExecution: {
    id: string;
    status: string;
    triggerType: string;
    startedAt: string;
    completedAt: string | null;
  } | null;
};

type CronJob = {
  workflowId: string;
  isLive: boolean;
  workflowActive: boolean;
};

type RunningExecution = {
  executionId: string;
  workflowId: string;
  triggerType: "message" | "webhook" | "manual" | "cron";
  startedAt: string;
  activeNodeId: string | null;
  completedNodes: number;
  totalNodes: number;
};

type AgentWorkload = {
  assignedTasks: number;
  activeTasks: number;
  inProgressTasks: number;
  reviewTasks: number;
  workflows: number;
  scheduledWorkflows: number;
  liveSchedules: number;
  runningNow: boolean;
  heartbeatStatus: "running" | "scheduled" | "recent" | "idle" | "inactive";
  lastRunAt: string | null;
  lastRunStatus: string | null;
  failedWorkflowId: string | null;
  failedWorkflowName: string | null;
};

type TelemetryEvent = {
  ts: string;
  type: string;
  data: Record<string, unknown>;
};

type AgentBudgetSummary = {
  spendCapUsd: number | null;
  spendWindowDays: number;
  budgetAction: "warn" | "block";
  spentUsd: number;
  remainingUsd: number | null;
  usagePercent: number | null;
  recentCalls: number;
  lastSpendAt: string | null;
  overCap: boolean;
  warningLevel: "ok" | "near" | "over";
};

type AgentSettingsRecord = {
  id: string;
  isActive: boolean;
  enabledExtensions: string[];
  enabledSkills: string[];
  budgetSummary?: AgentBudgetSummary | null;
  modelRef?: string | null;
};

type ActiveModelSummary = {
  id: string;
  provider: string;
  modelId: string;
  name: string;
  isActive: boolean;
};

type AgentSkillPackEntry = {
  id: string;
  name: string;
  label: string;
  description: string;
  source: "core" | "optional" | "workspace" | "agent" | "extension" | "external";
  extensionId: string | null;
  enabled: boolean;
  globallyEnabled?: boolean;
};

type AgentExtensionPackEntry = {
  id: string;
  name: string;
  description: string;
  source: "bundled" | "external";
  skillCount: number;
  configurable: boolean;
  enabled: boolean;
  globallyEnabled?: boolean;
};

type IntegrationPresetEntry = {
  id: string;
  name: string;
  description: string;
  extensions: string[];
  skills: string[];
  recommendedRoleTypes?: string[];
};

type AgentIntegrationState = {
  open: boolean;
  loaded: boolean;
  loading: boolean;
  saving: boolean;
  error: string | null;
  extensions: AgentExtensionPackEntry[];
  skills: AgentSkillPackEntry[];
  presets: IntegrationPresetEntry[];
};

type HierarchyOrganization = {
  id: string;
  name: string;
  description: string | null;
  mission: string | null;
  memberCount: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

type HeartbeatRunEntry = {
  id: string;
  agentId: string;
  status: "running" | "succeeded" | "failed";
  invocationSource: "scheduled" | "on_demand";
  wakeupsProcessed: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
};

type GoalSpendSummary = {
  goalId: string;
  totalCostUsd: number;
  totalTokens: number;
  eventCount: number;
  agentBreakdown: Array<{ agentId: string; costUsd: number; tokens: number; calls: number }>;
  lastSpendAt: string | null;
};

type CompanyTemplate = {
  id: string;
  name: string;
  description: string;
  mission: string;
  tags: string[];
  roles: Array<{
    key: string;
    roleTitle: string;
    presetIds?: string[];
  }>;
  goals: Array<{
    key: string;
    name: string;
  }>;
};

type HierarchyGoal = {
  id: string;
  name: string;
  description: string | null;
  organizationId: string | null;
  organizationName: string | null;
  parentGoalId: string | null;
  parentGoalName: string | null;
  linkedDocumentIds: string[];
  deliverables: string[];
  status: "planned" | "active" | "blocked" | "done";
  level: "vision" | "mission" | "objective" | "key_result" | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

type GoalRunDashboardGoal = HierarchyGoal & {
  taskSummary: {
    total: number;
    ready: number;
    review: number;
    blocked: number;
    done: number;
  };
  runs: Array<{
    id: string;
    taskId: string | null;
    status: string;
    lastVerdict: string | null;
    lastReason: string | null;
    updatedAt: string;
  }>;
  judgments: Array<{
    id: string;
    verdict: string;
    reason: string;
    createdAt: string;
  }>;
};

type HierarchyRuntimeSnapshot = {
  tasks: BoardTask[];
  workflows: WorkflowSummary[];
  cronJobs: CronJob[];
  running: RunningExecution[];
  telemetry: TelemetryEvent[];
};

type HierarchyNextAction = {
  evidence: {
    counts?: Record<string, number | null>;
    highlights?: string[];
  };
  recommendation: {
    title: string;
    reason: string;
    impact: string;
    confidence: number;
    prompt: string;
    requiresConfirmation: boolean;
    evidence: string[];
    source: "model" | "fallback";
  };
};

type LinkedDocumentSummary = {
  id: string;
  sourceType: "upload" | "scrape" | "integration";
  name: string;
  mimeType: string | null;
  sourceUrl: string | null;
  sizeBytes: number | null;
  excerpt: string;
  createdAt: string;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
};

type DocumentOption = {
  id: string;
  name: string;
  sourceType: "upload" | "scrape" | "integration";
  sourceUrl: string | null;
  excerpt: string;
};

type GoalSourcePackItem = {
  key: string;
  sourceType: string | null;
  sourceRef: string | null;
  label: string;
  taskCount: number;
  workflowCount: number;
  document: LinkedDocumentSummary | null;
};

function parseListText(raw: string): string[] {
  return raw
    .split(/\r?\n|,/g)
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value, index, list) => list.indexOf(value) === index)
    .slice(0, 24);
}

type CrewOpsMemberSummary = {
  agentId: string;
  name: string;
  roleType: AgentRoleType;
  roleTitle: string;
  agentActive: boolean;
  inboxUnread: number;
  assignedOpenTasks: number;
  checkedOutTasks: number;
  blockedTasks: number;
  pendingApprovals: number;
  pendingToolApprovals: number;
  queuedWakeups: number;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  lastRunStatus: string | null;
  lastError: string | null;
  updatedAt: string | null;
};

type CrewOpsSummary = {
  organization: {
    id: string;
    name: string;
    mission: string | null;
    memberCount: number;
  };
  goal: {
    id: string;
    name: string;
    scopeSize: number;
  } | null;
  summary: {
    totalMembers: number;
    activeMembers: number;
    scopedTasks: number;
    blockedTasks: number;
    pendingTaskApprovals: number;
    pendingToolApprovals: number;
    queuedWakeups: number;
    runningExecutions: number;
    activeWorktrees: number;
    codingSessions: number;
    inboxUnread: number;
    budgetSpendUsd: number;
    failedMembers: number;
  };
  members: CrewOpsMemberSummary[];
  blockedTaskSamples: Array<{
    id: string;
    title: string;
    assignedAgentName?: string | null;
    checkedOutByAgentName?: string | null;
    blockedBy: string[];
  }>;
  pendingApprovalSamples: Array<{
    id: string;
    taskId: string;
    comments?: Array<{ id: string; comment: string; createdAt: string }>;
  }>;
  queuedWakeupSamples: Array<{
    id: string;
    agentId: string;
    source: string;
    coalescedCount: number;
  }>;
  pendingToolApprovalSamples: Array<{
    id: string;
    name: string;
    agentId?: string;
  }>;
  runningExecutionSamples: Array<{
    executionId: string;
    workflowId: string;
    workflowName?: string;
    triggerType: string;
    completedNodes: number;
    totalNodes: number;
  }>;
};

type HierarchyUiState = {
  collapsedSections?: Record<string, boolean>;
  selectedGoalByOrganization?: Record<string, string>;
  lastGoalId?: string;
  lastOrganizationId?: string;
  hideGettingStarted?: boolean;
  viewMode?: "simple" | "advanced";
};

const ROLE_TYPE_OPTIONS: Array<{ value: AgentRoleType; label: string }> = [
  { value: "orchestrator", label: "Orchestrator" },
  { value: "operations", label: "Operations Lead" },
  { value: "specialist", label: "Specialist" },
  { value: "worker", label: "Worker" },
  { value: "support", label: "Support" },
];

const ROLE_TYPE_LABELS = ROLE_TYPE_OPTIONS.reduce<Record<string, string>>((acc, option) => {
  acc[option.value] = option.label;
  return acc;
}, {});

const ROLE_TYPE_ORDER: Record<AgentRoleType, number> = {
  orchestrator: 0,
  operations: 1,
  specialist: 2,
  worker: 3,
  support: 4,
};

const TASK_STATUS_LABELS: Record<BoardTask["status"], string> = {
  inbox: "Inbox",
  in_progress: "In Progress",
  review: "Review",
  done: "Done",
  blocked: "Blocked",
};

const ROLE_EMOJI: Record<string, string> = {
  ceo: "👑",
  orchestrator: "🎯",
  coordinator: "🔗",
  analyst: "🔍",
  executor: "⚡",
  reviewer: "👁️",
  specialist: "💎",
  worker: "🔧",
  researcher: "🔬",
  assistant: "🤖",
  default: "👤",
};

function getRoleEmoji(role?: string): string {
  if (!role) return ROLE_EMOJI.default;
  const normalized = role.toLowerCase();
  for (const [key, emoji] of Object.entries(ROLE_EMOJI)) {
    if (normalized.includes(key)) return emoji;
  }
  return ROLE_EMOJI.default;
}

const LINKED_SOURCE_LABELS: Record<string, string> = {
  upload: "Uploaded Source",
  scrape: "Scraped Source",
  integration: "Connected Source",
  document: "Document",
  "data-source": "Data Source",
  "board-task": "Board Task",
  "cron-generated": "Cron Generated",
};

const DEFAULT_COLLAPSED_SECTIONS: Record<string, boolean> = {
  orgs: true,
  goals: true,
  editor: true,
  stats: true,
  composition: true,
};

const HIERARCHY_UI_STATE_KEY = "disp8ch:hierarchy-ui-state";

function sortRolesForTree(items: AgentRole[]): AgentRole[] {
  return [...items].sort((left, right) => {
    const byRole = ROLE_TYPE_ORDER[left.roleType] - ROLE_TYPE_ORDER[right.roleType];
    if (byRole !== 0) return byRole;
    return left.agentName.localeCompare(right.agentName);
  });
}

function clampTreeScale(value: number) {
  return Math.max(0.7, Math.min(1.8, Number(value.toFixed(2))));
}

function formatLinkedSource(sourceType?: string | null, sourceRef?: string | null) {
  const normalized = String(sourceType || "").trim().toLowerCase();
  if (!normalized && !sourceRef) return null;
  const label = LINKED_SOURCE_LABELS[normalized] ?? sourceType ?? "Source";
  return sourceRef ? `${label}: ${sourceRef}` : label;
}

function formatSourceSize(size: number | null): string {
  if (!size || size < 0) return "-";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function normalizeCollapsedSections(input?: Record<string, unknown> | null) {
  const next = { ...DEFAULT_COLLAPSED_SECTIONS };
  if (!input) return next;
  for (const key of Object.keys(next)) {
    if (typeof input[key] === "boolean") {
      next[key] = input[key] as boolean;
    }
  }
  return next;
}

function sameCollapsedSections(left: Record<string, boolean>, right: Record<string, boolean>) {
  return Object.keys(DEFAULT_COLLAPSED_SECTIONS).every((key) => left[key] === right[key]);
}

function parseOpenPanels(raw: string | null) {
  if (!raw) return null;
  const openPanels = new Set(
    raw
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  const next = { ...DEFAULT_COLLAPSED_SECTIONS };
  for (const key of Object.keys(next)) {
    next[key] = !openPanels.has(key);
  }
  return next;
}

function readHierarchyUiState(): HierarchyUiState {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(HIERARCHY_UI_STATE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as HierarchyUiState;
    }
  } catch {
    // Ignore malformed UI state.
  }
  return {};
}

function writeHierarchyUiState(patch: Partial<HierarchyUiState>) {
  if (typeof window === "undefined") return;
  const current = readHierarchyUiState();
  window.localStorage.setItem(
    HIERARCHY_UI_STATE_KEY,
    JSON.stringify({
      ...current,
      ...patch,
    }),
  );
}

function HierarchyPageInner() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [roles, setRoles] = useState<AgentRole[]>([]);
  const [drafts, setDrafts] = useState<Record<string, AgentRoleDraft>>({});
  const [runtimeSnapshot, setRuntimeSnapshot] = useState<HierarchyRuntimeSnapshot>({
    tasks: [],
    workflows: [],
    cronJobs: [],
    running: [],
    telemetry: [],
  });
  const [organizations, setOrganizations] = useState<HierarchyOrganization[]>([]);
  const [goals, setGoals] = useState<HierarchyGoal[]>([]);
  const [goalRunDashboard, setGoalRunDashboard] = useState<GoalRunDashboardGoal[]>([]);
  const [hierarchyLedgerEvents, setHierarchyLedgerEvents] = useState<HierarchyLedgerEvent[]>([]);
  const [selectedGoalId, setSelectedGoalId] = useState<string>("");
  // True only after the user explicitly clicks a goal in this session. Keeps the
  // pinned Goal Focus panel hidden on first org inspection (org shape first).
  const [goalSelectedByUserThisSession, setGoalSelectedByUserThisSession] = useState(false);
  const [activeOrganizationId, setActiveOrganizationId] = useState<string>("");
  const [selectedOrganizationId, setSelectedOrganizationId] = useState<string>("");
  const [organizationName, setOrganizationName] = useState("");
  const [organizationDescription, setOrganizationDescription] = useState("");
  const [organizationMission, setOrganizationMission] = useState("");
  const [companyTemplates, setCompanyTemplates] = useState<CompanyTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [templateOrganizationName, setTemplateOrganizationName] = useState("");
  const [goalName, setGoalName] = useState("");
  const [goalDescription, setGoalDescription] = useState("");
  const [goalParentId, setGoalParentId] = useState("");
  const [goalDeliverablesText, setGoalDeliverablesText] = useState("");
  const [goalDocumentCandidateId, setGoalDocumentCandidateId] = useState("");
  const [goalLinkedDocumentIds, setGoalLinkedDocumentIds] = useState<string[]>([]);
  const [requestedGoalFocus, setRequestedGoalFocus] = useState<HierarchyGoal | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingRoleId, setSavingRoleId] = useState<string | null>(null);
  const [savingOrganization, setSavingOrganization] = useState(false);
  const [applyingOrganization, setApplyingOrganization] = useState(false);
  const [applyingCompanyTemplate, setApplyingCompanyTemplate] = useState(false);
  const [orgPackageBusy, setOrgPackageBusy] = useState(false);
  const [savingGoal, setSavingGoal] = useState(false);
  const [quickGoalOpen, setQuickGoalOpen] = useState(false);
  const [quickGoalName, setQuickGoalName] = useState("");
  const [quickGoalStatus, setQuickGoalStatus] = useState<"planned" | "active" | "blocked" | "done">("planned");
  const [quickGoalLevel, setQuickGoalLevel] = useState<"vision" | "mission" | "objective" | "key_result" | "">("");
  const [quickGoalSaving, setQuickGoalSaving] = useState(false);
  const [collapsedGoalIds, setCollapsedGoalIds] = useState<Set<string>>(new Set());
  const [updatingGoalField, setUpdatingGoalField] = useState<string | null>(null);
  const [agentSettings, setAgentSettings] = useState<Record<string, AgentSettingsRecord>>({});
  const [activeGlobalModel, setActiveGlobalModel] = useState<ActiveModelSummary | null | undefined>(undefined);
  const [agentIntegrations, setAgentIntegrations] = useState<Record<string, AgentIntegrationState>>({});
  const [heartbeatRunsMap, setHeartbeatRunsMap] = useState<Record<string, HeartbeatRunEntry[]>>({});
  const [heartbeatRunsLoading, setHeartbeatRunsLoading] = useState<Record<string, boolean>>({});
  const [goalSpendMap, setGoalSpendMap] = useState<Record<string, GoalSpendSummary>>({});
  const [hydratedGoalDetails, setHydratedGoalDetails] = useState<Record<string, HierarchyGoal>>({});
  const [goalFocusDetail, setGoalFocusDetail] = useState<HierarchyGoal | null>(null);
  const [goalFocusAttachmentIdsState, setGoalFocusAttachmentIdsState] = useState<string[]>([]);
  const [goalFocusDeliverablesState, setGoalFocusDeliverablesState] = useState<string[]>([]);
  const [linkedDocumentsById, setLinkedDocumentsById] = useState<Record<string, LinkedDocumentSummary | null>>({});
  const [documents, setDocuments] = useState<DocumentOption[]>([]);
  const [crewOpsSummary, setCrewOpsSummary] = useState<CrewOpsSummary | null>(null);
  const [crewOpsLoading, setCrewOpsLoading] = useState(false);
  const [nextAction, setNextAction] = useState<HierarchyNextAction | null>(null);
  const [nextActionLoading, setNextActionLoading] = useState(false);
  const [nextActionError, setNextActionError] = useState("");
  const [actingAgentId, setActingAgentId] = useState<string | null>(null);
  const [treeScale, setTreeScale] = useState(1);
  const [treeOffset, setTreeOffset] = useState({ x: 0, y: 0 });
  const [treePanning, setTreePanning] = useState(false);
  const [expandedNodeId, setExpandedNodeId] = useState<string | null>(null);
  // Right-side drawers (progressive disclosure): agent + goal detail.
  const [agentDrawerTab, setAgentDrawerTab] = useState<"profile" | "work" | "governance" | "activity">("profile");
  const [goalDrawerOpen, setGoalDrawerOpen] = useState(false);
  const [researchTeamsOpen, setResearchTeamsOpen] = useState(false);
  const [teamPresetOpen, setTeamPresetOpen] = useState(false);
  const [teamPresetOptions, setTeamPresetOptions] = useState<IntegrationPresetEntry[]>([]);
  const [selectedTeamPresetId, setSelectedTeamPresetId] = useState("");
  const [teamPresetLoading, setTeamPresetLoading] = useState(false);
  const [teamPresetApplying, setTeamPresetApplying] = useState(false);
  const [teamPresetStatus, setTeamPresetStatus] = useState<string | null>(null);
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>(DEFAULT_COLLAPSED_SECTIONS);
  const [hideGettingStarted, setHideGettingStarted] = useState(false);
  const [viewMode, setViewMode] = useState<"simple" | "advanced">("simple");
  const [assignAllOpen, setAssignAllOpen] = useState(false);
  const [assignAllTitle, setAssignAllTitle] = useState("");
  const [assignAllDesc, setAssignAllDesc] = useState("");
  const [assignAllPriority, setAssignAllPriority] = useState<"low" | "medium" | "high">("medium");
  const [assignAllSaving, setAssignAllSaving] = useState(false);
  const [assignAllProgress, setAssignAllProgress] = useState(0);
  const [assignAllResult, setAssignAllResult] = useState<{ created: number; total: number; agentNames: string[] } | null>(null);
  const [discussionOpen, setDiscussionOpen] = useState(false);
  const [discussionTopic, setDiscussionTopic] = useState("");
  const [discussionAgentA, setDiscussionAgentA] = useState("");
  const [discussionAgentB, setDiscussionAgentB] = useState("");
  const [discussionRunning, setDiscussionRunning] = useState(false);
  const [discussionError, setDiscussionError] = useState<string | null>(null);
  const [discussionResult, setDiscussionResult] = useState<{ sessionId: string; conclusion?: string; totalCostUsd?: number } | null>(null);
  const [inlineEditGoal, setInlineEditGoal] = useState<{ id: string; field: "name" | "description"; value: string } | null>(null);
  const [inlineEditSaving, setInlineEditSaving] = useState(false);
  const [treeSearch, setTreeSearch] = useState("");
  const [showAllTreeAgents, setShowAllTreeAgents] = useState(false);
  const [hierarchyBoot, setHierarchyBoot] = useState<any>(null);
  const hierarchyBootstrappedRef = useRef(false);
  const TREE_COLLAPSE_THRESHOLD = 15;
  const treePanRef = useRef<{
    pointerId: number | null;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    moved: boolean;
  }>({
    pointerId: null,
    startX: 0,
    startY: 0,
    originX: 0,
    originY: 0,
    moved: false,
  });
  const ignoreNextTreeClickRef = useRef(false);
  const autoAppliedOrganizationRef = useRef<string | null>(null);
  const goalsSectionRef = useRef<HTMLDivElement | null>(null);
  const goalAutoFocusRef = useRef<string | null>(null);
  const treeStageRef = useRef<HTMLDivElement | null>(null);
  const orgImportInputRef = useRef<HTMLInputElement | null>(null);
  const browserLocationSearch =
    typeof window === "undefined"
      ? ""
      : window.location.search || "";
  const effectiveSearchParams = useMemo(() => {
    const next = new URLSearchParams(searchParams.toString());
    if ([...next.keys()].length > 0) return next;
    if (!browserLocationSearch) return next;
    return new URLSearchParams(
      browserLocationSearch.startsWith("?") ? browserLocationSearch.slice(1) : browserLocationSearch,
    );
  }, [browserLocationSearch, searchParams]);
  const requestedOrganizationId = useMemo(
    () =>
      String(effectiveSearchParams.get("org") || effectiveSearchParams.get("organizationId") || "")
        .trim(),
    [effectiveSearchParams],
  );
  const requestedGoalId = useMemo(
    () =>
      String(effectiveSearchParams.get("goal") || effectiveSearchParams.get("goalId") || "")
        .trim(),
    [effectiveSearchParams],
  );
  const requestedPanels = useMemo(() => parseOpenPanels(effectiveSearchParams.get("panels")), [effectiveSearchParams]);
  const shouldOpenResearchTeams = useMemo(() => {
    const panel = String(effectiveSearchParams.get("panel") || "").trim().toLowerCase();
    const panels = String(effectiveSearchParams.get("panels") || "")
      .split(",")
      .map((value) => value.trim().toLowerCase());
    return panel === "research" || panels.includes("research");
  }, [effectiveSearchParams]);
  const handleResearchTeamsOpenChange = useCallback(
    (open: boolean) => {
      setResearchTeamsOpen(open);
      if (open || !shouldOpenResearchTeams) return;

      const params = new URLSearchParams(effectiveSearchParams.toString());
      const remainingPanels = String(params.get("panels") || "")
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value && value.toLowerCase() !== "research");
      if (remainingPanels.length > 0) params.set("panels", remainingPanels.join(","));
      else params.delete("panels");
      if (String(params.get("panel") || "").trim().toLowerCase() === "research") params.delete("panel");
      router.replace(params.size > 0 ? `${pathname}?${params.toString()}` : pathname, { scroll: false });
    },
    [effectiveSearchParams, pathname, router, shouldOpenResearchTeams],
  );
  const isAdvancedView = viewMode === "advanced";

  const extractAgentIds = (value: unknown): string[] => {
    if (!value || typeof value !== "object") return [];
    const found = new Set<string>();
    const visit = (input: unknown) => {
      if (!input || typeof input !== "object") return;
      for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
        if (typeof raw === "string" && key.toLowerCase().includes("agentid") && raw.trim()) {
          found.add(raw.trim());
          continue;
        }
        if (Array.isArray(raw)) {
          raw.forEach(visit);
          continue;
        }
        if (raw && typeof raw === "object") {
          visit(raw);
        }
      }
    };
    visit(value);
    return Array.from(found);
  };

  const buildWorkload = (
    rolesInput: AgentRole[],
    tasks: BoardTask[],
    workflows: WorkflowSummary[],
    jobs: CronJob[],
    running: RunningExecution[],
  ): Record<string, AgentWorkload> => {
    const next: Record<string, AgentWorkload> = {};
    const workflowScheduleMap = new Map<string, { scheduled: number; live: number }>();
    const defaultAgentId = rolesInput.find((item) => item.isDefault)?.agentId ?? "main";

    for (const job of jobs) {
      const current = workflowScheduleMap.get(job.workflowId) ?? { scheduled: 0, live: 0 };
      current.scheduled += job.workflowActive ? 1 : 0;
      current.live += job.isLive ? 1 : 0;
      workflowScheduleMap.set(job.workflowId, current);
    }

    for (const role of rolesInput) {
      const assigned = tasks.filter((task) => task.assignedAgentId === role.agentId);
      const relevantWorkflows = workflows.filter((workflow) => {
        if (workflowUsesAgent(workflow.nodes, role.agentId, defaultAgentId)) return true;
        if (workflow.nodes.some((node) => extractAgentIds(node.data).includes(role.agentId))) return true;
        const hasExplicitAgent = workflow.nodes.some((node) => extractAgentIds(node.data).length > 0);
        const hasAgentNode = workflow.nodes.some((node) => node.type === "claude-agent");
        if (!hasExplicitAgent && !hasAgentNode && role.agentId === defaultAgentId) return true;
        return false;
      });
      const runningNow = running.some((entry) =>
        relevantWorkflows.some((workflow) => workflow.id === entry.workflowId),
      );
      const lastExecution = relevantWorkflows
        .map((workflow) => workflow.lastExecution)
        .filter(Boolean)
        .sort((a, b) => new Date(b!.startedAt).getTime() - new Date(a!.startedAt).getTime())[0] ?? null;
      const lastFailedWorkflow =
        relevantWorkflows
          .filter((workflow) => workflow.lastExecution?.status === "failed")
          .sort(
            (a, b) =>
              new Date(b.lastExecution?.startedAt || 0).getTime() - new Date(a.lastExecution?.startedAt || 0).getTime(),
          )[0] ?? null;
      const scheduleSummary = relevantWorkflows.reduce(
        (acc, workflow) => {
          const current = workflowScheduleMap.get(workflow.id);
          if (!current) return acc;
          acc.scheduled += current.scheduled;
          acc.live += current.live;
          return acc;
        },
        { scheduled: 0, live: 0 },
      );

      next[role.agentId] = {
        assignedTasks: assigned.length,
        activeTasks: assigned.filter((task) => task.status !== "done").length,
        inProgressTasks: assigned.filter((task) => task.status === "in_progress").length,
        reviewTasks: assigned.filter((task) => task.status === "review").length,
        workflows: relevantWorkflows.length,
        scheduledWorkflows: scheduleSummary.scheduled,
        liveSchedules: scheduleSummary.live,
        runningNow,
        heartbeatStatus: !role.agentActive
          ? "inactive"
          : runningNow
            ? "running"
            : scheduleSummary.live > 0
              ? "scheduled"
              : lastExecution && Date.now() - new Date(lastExecution.startedAt).getTime() < 6 * 60 * 60 * 1000
                ? "recent"
                : "idle",
        lastRunAt: lastExecution?.startedAt ?? null,
        lastRunStatus: lastExecution?.status ?? null,
        failedWorkflowId: lastFailedWorkflow?.id ?? null,
        failedWorkflowName: lastFailedWorkflow?.name ?? null,
      };
    }
    return next;
  };

  const loadCriticalRolesData = async (organizationId?: string): Promise<boolean> => {
    const roleCacheKey = organizationId ? `agents/roles:${organizationId}` : "agents/roles";
    const roleUrl = organizationId
      ? `/api/agents/roles?organizationId=${encodeURIComponent(organizationId)}`
      : "/api/agents/roles";
    const [rolesJson, agentsJson] = await Promise.all([
      cachedJson<any>(roleCacheKey, roleUrl, 15_000),
      cachedJson<any>("agents", "/api/agents", APP_TTL.agents),
    ]);
    if (!rolesJson.success) return false;
    const next = (rolesJson.data ?? []) as AgentRole[];
    setRoles(next);
    const d: Record<string, AgentRoleDraft> = {};
    for (const role of next) {
      d[role.agentId] = {
        roleType: role.roleType,
        roleTitle: role.roleTitle,
        roleDescription: role.roleDescription,
        reportsTo: role.reportsTo,
        capabilitiesText: role.capabilities.join(", "),
        voteWeight: role.voteWeight ?? 1,
      };
    }
    setDrafts(d);
    const nextAgentSettings: Record<string, AgentSettingsRecord> = {};
    const agentRows = (agentsJson?.data?.agents ?? []) as AgentSettingsRecord[];
    for (const agent of agentRows) {
      nextAgentSettings[agent.id] = agent;
    }
    setAgentSettings(nextAgentSettings);
    setAgentIntegrations({});
    return true;
  };

  const loadRuntimeEnrichmentData = async () => {
    const [tasksJson, workflowsJson, cronJson, runningJson, telemetryJson] = await Promise.all([
      cachedJson<any>("boards/tasks:all", "/api/boards/tasks", 5_000),
      cachedJson<any>("workflows", "/api/workflows", APP_TTL.workflows),
      cachedJson<any>("cron", "/api/cron", 10_000),
      cachedJson<any>("execute/running", "/api/execute/running", APP_TTL["execute/running"]),
      cachedJson<any>("telemetry:recent:200", "/api/telemetry?action=recent&limit=200", APP_TTL.telemetry),
    ]);
    setRuntimeSnapshot({
      tasks: (tasksJson?.data ?? []) as BoardTask[],
      workflows: (workflowsJson?.data ?? []) as WorkflowSummary[],
      cronJobs: (cronJson?.data?.jobs ?? []) as CronJob[],
      running: (runningJson?.data ?? []) as RunningExecution[],
      telemetry: (telemetryJson?.data ?? []) as TelemetryEvent[],
    });
  };

  const loadModelFallback = async () => {
    try {
      const json = await cachedJson<any>("models", "/api/models", APP_TTL.models);
      if (!json?.success) {
        setActiveGlobalModel(null);
        return;
      }
      const models = (json.data ?? []) as ActiveModelSummary[];
      setActiveGlobalModel(models.find((model) => model.isActive) ?? null);
    } catch {
      setActiveGlobalModel(null);
    }
  };

  const loadRoles = async () => {
    setLoading(true);
    try {
      const ok = await loadCriticalRolesData();
      if (!ok) return;
      await Promise.all([loadRuntimeEnrichmentData(), loadModelFallback()]);
    } finally {
      setLoading(false);
    }
  };

  const loadAgentIntegrations = async (agentId: string) => {
    setAgentIntegrations((current) => ({
      ...current,
      [agentId]: {
        open: true,
        loaded: current[agentId]?.loaded ?? false,
        loading: true,
        saving: false,
        error: null,
        extensions: current[agentId]?.extensions ?? [],
        skills: current[agentId]?.skills ?? [],
        presets: current[agentId]?.presets ?? [],
      },
    }));
    try {
      const response = await fetch(`/api/agents/skills?agentId=${encodeURIComponent(agentId)}`);
      const json = await response.json();
      if (!json.success) {
        throw new Error(String(json.error || "Failed to load agent integrations"));
      }
      setAgentIntegrations((current) => ({
        ...current,
        [agentId]: {
          open: true,
          loaded: true,
          loading: false,
          saving: false,
          error: null,
          extensions: (json.data?.extensions ?? []) as AgentExtensionPackEntry[],
          skills: (json.data?.skills ?? []) as AgentSkillPackEntry[],
          presets: (json.data?.presets ?? []) as IntegrationPresetEntry[],
        },
      }));
    } catch (error) {
      setAgentIntegrations((current) => ({
        ...current,
        [agentId]: {
          open: true,
          loaded: current[agentId]?.loaded ?? false,
          loading: false,
          saving: false,
          error: String(error),
          extensions: current[agentId]?.extensions ?? [],
          skills: current[agentId]?.skills ?? [],
          presets: current[agentId]?.presets ?? [],
        },
      }));
    }
  };

  const loadHeartbeatRuns = async (agentId: string) => {
    if (heartbeatRunsLoading[agentId]) return;
    setHeartbeatRunsLoading((s) => ({ ...s, [agentId]: true }));
    try {
      const res = await fetch(`/api/governance?action=heartbeat-runs&agentId=${encodeURIComponent(agentId)}&limit=20`);
      const json = await res.json() as { success: boolean; data?: HeartbeatRunEntry[] };
      if (json.success && json.data) {
        setHeartbeatRunsMap((s) => ({ ...s, [agentId]: json.data! }));
      }
    } catch { /* non-fatal */ } finally {
      setHeartbeatRunsLoading((s) => ({ ...s, [agentId]: false }));
    }
  };

  const loadGoalSpend = async (goalId: string) => {
    if (goalSpendMap[goalId]) return;
    try {
      const res = await fetch(`/api/governance?action=spend-by-goal&goalId=${encodeURIComponent(goalId)}`);
      const json = await res.json() as { success: boolean; data?: GoalSpendSummary };
      if (json.success && json.data) {
        setGoalSpendMap((s) => ({ ...s, [goalId]: json.data! }));
      }
    } catch { /* non-fatal */ }
  };

  const loadCrewOps = async (organizationId?: string, goalId?: string) => {
    if (!organizationId) {
      setCrewOpsSummary(null);
      return;
    }
    setCrewOpsLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("organizationId", organizationId);
      if (goalId) params.set("goalId", goalId);
      const res = await fetch(`/api/hierarchy/crew-ops?${params.toString()}`);
      const json = (await res.json()) as { success: boolean; data?: CrewOpsSummary };
      if (json.success && json.data) {
        setCrewOpsSummary(json.data);
      }
    } catch {
      // non-fatal
    } finally {
      setCrewOpsLoading(false);
    }
  };

  const toggleAgentIntegrationsPanel = (agentId: string) => {
    const current = agentIntegrations[agentId];
    if (current?.open) {
      setAgentIntegrations((state) => ({
        ...state,
        [agentId]: {
          ...(state[agentId] as AgentIntegrationState),
          open: false,
        },
      }));
      return;
    }
    if (current?.loaded) {
      setAgentIntegrations((state) => ({
        ...state,
        [agentId]: {
          ...(state[agentId] as AgentIntegrationState),
          open: true,
          error: null,
        },
      }));
      return;
    }
    void loadAgentIntegrations(agentId);
  };

  const patchAgentIntegrations = async (agentId: string, payload: Record<string, unknown>) => {
    setAgentIntegrations((current) => ({
      ...current,
      [agentId]: {
        open: true,
        loaded: current[agentId]?.loaded ?? false,
        loading: current[agentId]?.loading ?? false,
        saving: true,
        error: null,
        extensions: current[agentId]?.extensions ?? [],
        skills: current[agentId]?.skills ?? [],
        presets: current[agentId]?.presets ?? [],
      },
    }));
    try {
      const response = await fetch("/api/agents/skills", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId,
          ...payload,
        }),
      });
      const json = await response.json();
      if (!json.success) {
        throw new Error(String(json.error || "Failed to update agent integrations"));
      }
      const enabledExtensions = (json.data?.enabledExtensions ?? []) as string[];
      const enabledSkills = (json.data?.enabledSkills ?? []) as string[];
      setAgentSettings((current) => ({
        ...current,
        [agentId]: {
          id: agentId,
          isActive: current[agentId]?.isActive ?? true,
          enabledExtensions,
          enabledSkills,
          budgetSummary: current[agentId]?.budgetSummary ?? null,
        },
      }));
      setAgentIntegrations((current) => ({
        ...current,
        [agentId]: {
          open: true,
          loaded: true,
          loading: false,
          saving: false,
          error: null,
          extensions: (json.data?.extensions ?? []) as AgentExtensionPackEntry[],
          skills: (json.data?.skills ?? []) as AgentSkillPackEntry[],
          presets: (json.data?.presets ?? []) as IntegrationPresetEntry[],
        },
      }));
    } catch (error) {
      setAgentIntegrations((current) => ({
        ...current,
        [agentId]: {
          open: true,
          loaded: current[agentId]?.loaded ?? false,
          loading: false,
          saving: false,
          error: String(error),
          extensions: current[agentId]?.extensions ?? [],
          skills: current[agentId]?.skills ?? [],
          presets: current[agentId]?.presets ?? [],
        },
      }));
    }
  };

  const onToggleAgentExtensionPack = async (agentId: string, extensionId: string, enabled: boolean) => {
    await patchAgentIntegrations(agentId, {
      extensionUpdates: [{ id: extensionId, enabled }],
    });
  };

  const onToggleAgentSkillPack = async (agentId: string, skillId: string, enabled: boolean) => {
    await patchAgentIntegrations(agentId, {
      skillUpdates: [{ id: skillId, enabled }],
    });
  };

  const onApplyAgentPreset = async (agentId: string, presetId: string) => {
    await patchAgentIntegrations(agentId, {
      presetId,
      presetMode: "merge",
    });
  };

  const openTeamPreset = async () => {
    setTeamPresetOpen(true);
    setTeamPresetStatus(null);
    setTeamPresetLoading(true);
    try {
      const agentId = roles[0]?.agentId || "main";
      const response = await fetch(`/api/agents/skills?agentId=${encodeURIComponent(agentId)}`);
      const json = await response.json();
      if (!json.success) throw new Error(String(json.error || "Failed to load team presets"));
      const presets = (json.data?.presets ?? []) as IntegrationPresetEntry[];
      setTeamPresetOptions(presets);
      setSelectedTeamPresetId((current) => current || presets[0]?.id || "");
    } catch (error) {
      setTeamPresetStatus(String(error));
    } finally {
      setTeamPresetLoading(false);
    }
  };

  const applyTeamPreset = async () => {
    if (!activeOrganizationId || !selectedTeamPresetId || teamPresetApplying) return;
    const preset = teamPresetOptions.find((item) => item.id === selectedTeamPresetId);
    const label = preset?.name || selectedTeamPresetId;
    if (!window.confirm(`Merge ${label} into every current member of this organization? Existing capabilities stay enabled.`)) return;

    setTeamPresetApplying(true);
    setTeamPresetStatus(null);
    try {
      const response = await fetch("/api/hierarchy/organizations", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId: activeOrganizationId, presetId: selectedTeamPresetId }),
      });
      const json = await response.json();
      if (!json.success) throw new Error(String(json.error || "Failed to apply team preset"));
      const updatedAgentIds = (json.data?.updatedAgentIds ?? []) as string[];
      const skippedAgentIds = (json.data?.skippedAgentIds ?? []) as string[];
      setTeamPresetStatus(
        `${label} merged into ${updatedAgentIds.length} member${updatedAgentIds.length === 1 ? "" : "s"}${
          skippedAgentIds.length > 0 ? `; ${skippedAgentIds.length} stale member record${skippedAgentIds.length === 1 ? "" : "s"} skipped` : ""
        }.`,
      );
      invalidateCache(/^(agents|hierarchy|extensions|skills)/);
      await loadRoles();
    } catch (error) {
      setTeamPresetStatus(String(error));
    } finally {
      setTeamPresetApplying(false);
    }
  };

  const loadOrganizations = async (): Promise<string> => {
    const json = await cachedJson<any>("hierarchy/organizations", "/api/hierarchy/organizations", APP_TTL["hierarchy/organizations"]);
    if (!json.success) return "";
    const next = (json.data?.organizations ?? []) as HierarchyOrganization[];
    const activeId = String(json.data?.activeOrganizationId ?? next.find((item) => item.isActive)?.id ?? "");
    const active = next.find((item) => item.id === activeId) ?? null;
    setOrganizations(next);
    setActiveOrganizationId(activeId);
    setSelectedOrganizationId((current) => (current && next.some((item) => item.id === current) ? current : activeId));
    if (active) {
      setOrganizationName(active.name);
      setOrganizationDescription(active.description ?? "");
      setOrganizationMission(active.mission ?? "");
    }
    return activeId;
  };

  const loadGoals = async (organizationId?: string) => {
    const query = organizationId ? `?organizationId=${encodeURIComponent(organizationId)}` : "";
    const cacheKey = organizationId ? `hierarchy/goals:${organizationId}` : "hierarchy/goals";
    const json = await cachedJson<any>(cacheKey, `/api/hierarchy/goals${query}`, APP_TTL["hierarchy/goals"]);
    if (!json.success) return;
    const loadedGoals = (json.data ?? []) as HierarchyGoal[];
    setGoals(loadedGoals);
  };

  const loadGoalRuns = async () => {
    try {
      const response = await fetch("/api/goals?includeInactive=1&limit=20");
      const json = await response.json();
      if (json.success) setGoalRunDashboard((json.data?.goals ?? []) as GoalRunDashboardGoal[]);
    } catch {
      // Non-critical sidecar.
    }
  };

  const loadHierarchyLedger = async (organizationId?: string, goalId?: string) => {
    const params = new URLSearchParams();
    if (organizationId) params.set("organizationId", organizationId);
    if (goalId) params.set("goalId", goalId);
    params.set("limit", "16");
    try {
      const response = await fetch(`/api/hierarchy/activity?${params.toString()}`);
      const json = await response.json();
      if (json.success) setHierarchyLedgerEvents((json.data?.events ?? []) as HierarchyLedgerEvent[]);
    } catch {
      setHierarchyLedgerEvents([]);
    }
  };

  const loadNextAction = async (organizationId?: string, goalId?: string) => {
    if (!organizationId) {
      setNextAction(null);
      setNextActionError("");
      return;
    }
    setNextActionLoading(true);
    setNextActionError("");
    try {
      const params = new URLSearchParams();
      params.set("organizationId", organizationId);
      if (goalId) params.set("goalId", goalId);
      const response = await fetch(`/api/hierarchy/next-action?${params.toString()}`);
      const json = (await response.json()) as { success: boolean; data?: HierarchyNextAction; error?: string };
      if (!response.ok || !json.success || !json.data) {
        throw new Error(json.error || "Could not load next action.");
      }
      setNextAction(json.data);
    } catch (error) {
      setNextAction(null);
      setNextActionError(String(error));
    } finally {
      setNextActionLoading(false);
    }
  };

  const createQuickGoal = async () => {
    const name = quickGoalName.trim();
    if (!name) return;
    setQuickGoalSaving(true);
    try {
      const body: Record<string, unknown> = { name, status: quickGoalStatus };
      if (quickGoalLevel) body.level = quickGoalLevel;
      if (activeOrganizationId) body.organizationId = activeOrganizationId;
      const res = await fetch("/api/hierarchy/goals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "Failed to create goal");
      setQuickGoalName("");
      setQuickGoalStatus("planned");
      setQuickGoalLevel("");
      setQuickGoalOpen(false);
      invalidateCache(/^hierarchy\/goals/);
      await loadGoals(activeOrganizationId ?? undefined);
      await loadGoalRuns();
    } catch {
      // silently fail — user can retry
    } finally {
      setQuickGoalSaving(false);
    }
  };

  const assignGoalToAllAgents = async () => {
    if (!goalFocus) return;
    const orgId = goalFocus.organizationId ?? selectedOrganizationId ?? activeOrganizationId;
    const title = assignAllTitle.trim() || `Work on: ${goalFocus.name}`;
    const activeRoles = roles.filter((r) => r.agentActive);
    if (activeRoles.length === 0) return;
    setAssignAllSaving(true);
    setAssignAllProgress(0);
    let created = 0;
    const createdAgentNames: string[] = [];
    for (let i = 0; i < activeRoles.length; i++) {
      const role = activeRoles[i];
      setAssignAllProgress(i + 1);
      try {
        const res = await fetch("/api/boards/tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            boardId: "main-board",
            title,
            description: assignAllDesc.trim() || `Task assigned for goal: ${goalFocus.name}`,
            organizationId: orgId,
            goalId: goalFocus.id,
            status: "inbox",
            priority: assignAllPriority,
            assignedAgentId: role.agentId,
          }),
        });
        const json = (await res.json()) as { success: boolean };
        if (json.success) {
          created++;
          createdAgentNames.push(role.agentName);
        }
      } catch {
        // continue — partial failures are acceptable
      }
    }
    setAssignAllResult({ created, total: activeRoles.length, agentNames: createdAgentNames });
    setAssignAllSaving(false);
    setAssignAllProgress(0);
    setAssignAllTitle("");
    setAssignAllDesc("");
    setAssignAllPriority("medium");
    setAssignAllOpen(false);
    invalidateCache(/^boards/);
    await loadRoles();
  };

  const classifyDiscussionRole = (role: AgentRole): "claude" | "codex" | "openai" | "local" | "other" => {
    const model = String(agentSettings[role.agentId]?.modelRef || "").toLowerCase();
    const text = `${model} ${role.agentName} ${role.roleTitle} ${role.capabilities.join(" ")}`.toLowerCase();
    if (/\bclaude\b|anthropic/.test(text)) return "claude";
    if (/\bcodex\b/.test(text)) return "codex";
    if (/\bgpt\b|openai/.test(text)) return "openai";
    if (/\bqwen\b|\bllama\b|\bmistral\b|ollama|vllm|lm-studio/.test(text)) return "local";
    return "other";
  };

  const suggestDiscussionAgents = () => {
    const activeRoles = roles.filter((role) => role.agentActive);
    const claude = activeRoles.find((role) => classifyDiscussionRole(role) === "claude");
    const codex =
      activeRoles.find((role) => ["codex", "openai"].includes(classifyDiscussionRole(role))) ??
      activeRoles.find((role) => role.agentId !== claude?.agentId && classifyDiscussionRole(role) === "local") ??
      activeRoles.find((role) => role.agentId !== claude?.agentId);
    const first = claude ?? activeRoles[0] ?? null;
    const second =
      codex && codex.agentId !== first?.agentId
        ? codex
        : activeRoles.find((role) => role.agentId !== first?.agentId) ?? null;
    return { first, second };
  };

  const openGoalDiscussion = () => {
    if (!goalFocus) return;
    const { first, second } = suggestDiscussionAgents();
    setDiscussionTopic(
      `Discuss the next best action for goal "${goalFocus.name}". Include risks, owner, concrete follow-up task, and unresolved disagreement.`,
    );
    setDiscussionAgentA(first?.agentId ?? "");
    setDiscussionAgentB(second?.agentId ?? "");
    setDiscussionError(null);
    setDiscussionResult(null);
    setDiscussionOpen(true);
  };

  const startGoalDiscussion = async () => {
    if (!goalFocus) return;
    const topic = discussionTopic.trim();
    if (!topic || !discussionAgentA || !discussionAgentB || discussionAgentA === discussionAgentB) {
      setDiscussionError("Choose two different active agents and enter a discussion topic.");
      return;
    }
    setDiscussionRunning(true);
    setDiscussionError(null);
    setDiscussionResult(null);
    try {
      const res = await fetch("/api/hierarchy/discussions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic,
          agentIds: [discussionAgentA, discussionAgentB],
          organizationId: (goalFocus.organizationId ?? activeOrganizationId) || undefined,
          goalId: goalFocus.id,
          documentIds: goalFocus.linkedDocumentIds.slice(0, 6),
          rounds: 3,
          costCapUsd: 1,
        }),
      });
      const json = (await res.json()) as {
        success?: boolean;
        error?: string;
        data?: { sessionId: string; conclusion?: string; totalCostUsd?: number };
      };
      if (!res.ok || !json.success || !json.data) {
        throw new Error(json.error || `Discussion failed with HTTP ${res.status}`);
      }
      setDiscussionResult({
        sessionId: json.data.sessionId,
        conclusion: json.data.conclusion,
        totalCostUsd: json.data.totalCostUsd,
      });
    } catch (error) {
      setDiscussionError(error instanceof Error ? error.message : String(error));
    } finally {
      setDiscussionRunning(false);
    }
  };

  const updateGoalField = async (goalId: string, field: "status" | "level" | "name" | "description", value: string) => {
    const key = `${goalId}:${field}`;
    setUpdatingGoalField(key);
    try {
      await fetch("/api/hierarchy/goals", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: goalId, [field]: value || null }),
      });
      invalidateCache(/^hierarchy\/goals/);
      await loadGoals(activeOrganizationId ?? undefined);
      await loadGoalRuns();
    } finally {
      setUpdatingGoalField(null);
    }
  };

  const saveInlineGoalEdit = async () => {
    if (!inlineEditGoal) return;
    const trimmed = inlineEditGoal.value.trim();
    if (!trimmed && inlineEditGoal.field === "name") { setInlineEditGoal(null); return; }
    setInlineEditSaving(true);
    await updateGoalField(inlineEditGoal.id, inlineEditGoal.field, trimmed);
    setInlineEditGoal(null);
    setInlineEditSaving(false);
  };

  const loadCompanyTemplates = async () => {
    const json = await cachedJson<any>("hierarchy/templates", "/api/hierarchy/templates", 30_000);
    if (!json.success) return;
    const next = (json.data ?? []) as CompanyTemplate[];
    setCompanyTemplates(next);
    setSelectedTemplateId((current) => current || next[0]?.id || "");
  };

  const loadDocuments = async () => {
    const json = await cachedJson<any>("documents:100", "/api/documents?limit=100", APP_TTL.documents);
    if (!json.success) return;
    setDocuments((json.data ?? []) as DocumentOption[]);
  };

  // Bootstrap-first: prefer the SSR-injected snapshot from page.tsx; fall back
  // to a network fetch on soft nav / dev fast-refresh.
  useEffect(() => {
    hierarchyBootstrappedRef.current = true;
    const preloaded = readPreloadedBootstrap("hierarchy");
    if (preloaded) {
      setHierarchyBoot(preloaded);
      setLoading(false);
      return;
    }
    let cancelled = false;
    fetch("/api/hierarchy/bootstrap")
      .then((r) => r.json())
      .then((json) => {
        if (cancelled || !json.success) return;
        setHierarchyBoot(json.data);
        setLoading(false);
      })
      .catch(() => {});

    return () => { cancelled = true; };
  }, []);

  // Critical org data (orgs + roles) loaded after useful-ready + idle.
  const rolesLoadedOnceRef = useRef(false);
  useAfterUseful(() => {
    void (async () => {
      const activeId = await loadOrganizations();
      await loadCriticalRolesData(activeId || undefined);
      void loadModelFallback();
      rolesLoadedOnceRef.current = true;
    })();
  }, []);

  useEffect(() => {
    if (!rolesLoadedOnceRef.current) return;
    if (!activeOrganizationId) return;
    void loadCriticalRolesData(activeOrganizationId);
  }, [activeOrganizationId]);

  // Enrichment: runtime + templates + documents — even further deferred.
  useAfterUseful(() => {
    void loadRuntimeEnrichmentData();
    void loadModelFallback();
    void loadCompanyTemplates();
    void loadDocuments();
  }, []);

  useEffect(() => {
    if (requestedPanels) {
      setCollapsedSections((current) => (sameCollapsedSections(current, requestedPanels) ? current : requestedPanels));
      return;
    }
    const saved = readHierarchyUiState();
    const next = normalizeCollapsedSections(saved.collapsedSections as Record<string, unknown> | undefined);
    setCollapsedSections((current) => (sameCollapsedSections(current, next) ? current : next));
  }, [requestedPanels]);

  useEffect(() => {
    if (shouldOpenResearchTeams) setResearchTeamsOpen(true);
  }, [shouldOpenResearchTeams]);

  useEffect(() => {
    const saved = readHierarchyUiState();
    setHideGettingStarted(Boolean(saved.hideGettingStarted));
    setViewMode(saved.viewMode === "advanced" ? "advanced" : "simple");
  }, []);

  // Restore active org from localStorage if none is set
  useEffect(() => {
    try {
      const saved = localStorage.getItem("disp8ch-active-org");
      if (saved && !activeOrganizationId) {
        setActiveOrganizationId(saved);
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (!requestedOrganizationId) return;
    if (organizations.length > 0 && !organizations.some((item) => item.id === requestedOrganizationId)) return;
    setSelectedOrganizationId(requestedOrganizationId);
    if (requestedOrganizationId === activeOrganizationId) return;
    if (autoAppliedOrganizationRef.current === requestedOrganizationId) return;
    autoAppliedOrganizationRef.current = requestedOrganizationId;
    void applyOrganizationById(requestedOrganizationId);
  }, [activeOrganizationId, organizations, requestedOrganizationId]);

  useEffect(() => {
    if (!requestedGoalId || !selectedGoalId || requestedGoalId !== selectedGoalId) return;
    if (goalAutoFocusRef.current === selectedGoalId) return;
    goalAutoFocusRef.current = selectedGoalId;
    // Deep link (?goal= / /hierarchy/goal/:id) opens the goal drawer.
    setGoalDrawerOpen(true);
    const timer = window.setTimeout(() => {
      goalsSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [requestedGoalId, selectedGoalId]);

  // Initial goals load is deferred until useful-ready so /api/hierarchy/goals
  // does not fire pre-ready. Org changes after first paint still refetch immediately.
  const goalsLoadedOnceRef = useRef(false);
  useEffect(() => {
    if (!goalsLoadedOnceRef.current) return;
    void loadGoals(activeOrganizationId || undefined);
    void loadGoalRuns();
  }, [activeOrganizationId]);
  useAfterUseful(() => {
    goalsLoadedOnceRef.current = true;
    void loadGoals(activeOrganizationId || undefined);
    void loadGoalRuns();
  }, []);

  useEffect(() => {
    const saved = readHierarchyUiState();
    const savedGoalByOrganization = saved.selectedGoalByOrganization ?? {};
    const persistedGoalId = activeOrganizationId
      ? String(savedGoalByOrganization[activeOrganizationId] || "")
      : String(saved.lastGoalId || "");
    const requestedGoal =
      requestedGoalId && goals.some((goal) => goal.id === requestedGoalId)
        ? requestedGoalId
        : "";
    const persistedGoal =
      persistedGoalId && goals.some((goal) => goal.id === persistedGoalId)
        ? persistedGoalId
        : "";

    setSelectedGoalId((current) => {
      if (requestedGoal && current !== requestedGoal) {
        return requestedGoal;
      }
      if (current && goals.some((goal) => goal.id === current)) {
        return current;
      }
      return requestedGoal || persistedGoal || goals[0]?.id || "";
    });
  }, [activeOrganizationId, goals, requestedGoalId]);

  useEffect(() => {
    writeHierarchyUiState({ collapsedSections });
  }, [collapsedSections]);

  useEffect(() => {
    writeHierarchyUiState({ hideGettingStarted });
  }, [hideGettingStarted]);

  useEffect(() => {
    writeHierarchyUiState({ viewMode });
  }, [viewMode]);

  useEffect(() => {
    const saved = readHierarchyUiState();
    writeHierarchyUiState({
      lastOrganizationId: activeOrganizationId || saved.lastOrganizationId,
    });
  }, [activeOrganizationId]);

  useEffect(() => {
    if (!selectedGoalId) return;
    const saved = readHierarchyUiState();
    writeHierarchyUiState({
      selectedGoalByOrganization: {
        ...(saved.selectedGoalByOrganization ?? {}),
        ...(activeOrganizationId ? { [activeOrganizationId]: selectedGoalId } : {}),
      },
      lastGoalId: selectedGoalId,
    });
  }, [activeOrganizationId, selectedGoalId]);

  useEffect(() => {
    if (!pathname) return;
    const organizationSyncPending = Boolean(
      requestedOrganizationId &&
        organizations.some((item) => item.id === requestedOrganizationId) &&
        requestedOrganizationId !== activeOrganizationId,
    );
    if (organizationSyncPending) return;
    const goalSyncPending = Boolean(
      requestedGoalId &&
        !selectedGoalId &&
        goals.some((goal) => goal.id === requestedGoalId),
    );
    if (goalSyncPending) return;

    const params = new URLSearchParams(effectiveSearchParams.toString());
    if (activeOrganizationId) {
      params.set("org", activeOrganizationId);
    } else {
      params.delete("org");
    }
    params.delete("organizationId");
    const shouldSyncGoalToUrl = isAdvancedView || goalSelectedByUserThisSession || Boolean(requestedGoalId);
    const effectiveGoalId = shouldSyncGoalToUrl ? selectedGoalId || requestedGoalId : "";
    if (effectiveGoalId) {
      params.set("goal", effectiveGoalId);
    } else {
      params.delete("goal");
    }
    params.delete("goalId");
    const openPanels = new Set(Object.entries(collapsedSections)
      .filter(([, isCollapsed]) => !isCollapsed)
      .map(([key]) => key)
    );
    if (shouldOpenResearchTeams) openPanels.add("research");
    if (openPanels.size > 0) {
      params.set("panels", [...openPanels].sort().join(","));
    } else {
      params.delete("panels");
    }
    params.delete("panel");
    const currentQuery = effectiveSearchParams.toString();
    const nextQuery = params.toString();
    if (currentQuery === nextQuery) return;
    router.replace(nextQuery ? `${pathname}?${nextQuery}` : pathname, { scroll: false });
  }, [
    activeOrganizationId,
    collapsedSections,
    effectiveSearchParams,
    organizations,
    pathname,
    goals,
    requestedOrganizationId,
    requestedGoalId,
    router,
    selectedGoalId,
    isAdvancedView,
    goalSelectedByUserThisSession,
    shouldOpenResearchTeams,
  ]);

  // Spend-by-goal and crew-ops are deferred after useful-ready. These are
  // expensive per-goal calls that should not block first paint and were
  // previously contributing N+1 fanout to hierarchy.
  const hierarchySidecarsLoadedRef = useRef(false);
  useEffect(() => {
    if (!hierarchySidecarsLoadedRef.current) return;
    if (selectedGoalId && !goalSpendMap[selectedGoalId]) {
      void loadGoalSpend(selectedGoalId);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedGoalId]);

  useEffect(() => {
    if (!hierarchySidecarsLoadedRef.current) return;
    void loadCrewOps(activeOrganizationId || undefined, selectedGoalId || undefined);
  }, [activeOrganizationId, selectedGoalId]);

  useEffect(() => {
    if (!hierarchySidecarsLoadedRef.current) return;
    void loadHierarchyLedger(activeOrganizationId || undefined, selectedGoalId || undefined);
  }, [activeOrganizationId, selectedGoalId]);

  useEffect(() => {
    if (!hierarchySidecarsLoadedRef.current) return;
    void loadNextAction(activeOrganizationId || undefined, selectedGoalId || undefined);
  }, [activeOrganizationId, selectedGoalId]);

  useAfterUseful(() => {
    hierarchySidecarsLoadedRef.current = true;
    if (selectedGoalId && !goalSpendMap[selectedGoalId]) {
      void loadGoalSpend(selectedGoalId);
    }
    void loadCrewOps(activeOrganizationId || undefined, selectedGoalId || undefined);
    void loadHierarchyLedger(activeOrganizationId || undefined, selectedGoalId || undefined);
    void loadNextAction(activeOrganizationId || undefined, selectedGoalId || undefined);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const orchestrator = useMemo(
    () => roles.find((role) => role.roleType === "orchestrator") ?? roles[0] ?? null,
    [roles],
  );
  const selectedCompanyTemplate = useMemo(
    () => companyTemplates.find((template) => template.id === selectedTemplateId) ?? null,
    [companyTemplates, selectedTemplateId],
  );
  const documentById = useMemo(() => new Map(documents.map((document) => [document.id, document])), [documents]);

  const roleById = useMemo(() => new Map(roles.map((role) => [role.agentId, role])), [roles]);

  const chainOfCommandByAgent = useMemo(() => {
    const chains = new Map<string, AgentRole[]>();
    for (const role of roles) {
      const chain: AgentRole[] = [];
      const seen = new Set<string>();
      let cursor: AgentRole | null = role;
      while (cursor && !seen.has(cursor.agentId)) {
        chain.unshift(cursor);
        seen.add(cursor.agentId);
        cursor = cursor.reportsTo ? roleById.get(cursor.reportsTo) ?? null : null;
      }
      chains.set(role.agentId, chain);
    }
    return chains;
  }, [roleById, roles]);

  const childrenByParent = useMemo(() => {
    const map = new Map<string, AgentRole[]>();
    for (const role of roles) {
      if (!role.reportsTo) continue;
      const list = map.get(role.reportsTo) ?? [];
      list.push(role);
      map.set(role.reportsTo, list);
    }
    for (const [parentId, list] of map.entries()) {
      map.set(parentId, sortRolesForTree(list));
    }
    return map;
  }, [roles]);

  const rootTreeRoles = useMemo(() => {
    if (orchestrator) return [orchestrator];
    return sortRolesForTree(
      roles.filter((role) => !role.reportsTo || !roleById.has(role.reportsTo)),
    );
  }, [orchestrator, roleById, roles]);

  const linkedRoleIds = useMemo(() => {
    const visited = new Set<string>();
    const visit = (role: AgentRole) => {
      if (visited.has(role.agentId)) return;
      visited.add(role.agentId);
      const children = childrenByParent.get(role.agentId) ?? [];
      for (const child of children) visit(child);
    };
    for (const role of rootTreeRoles) visit(role);
    return visited;
  }, [childrenByParent, rootTreeRoles]);

  const unlinked = useMemo(
    () => roles.filter((role) => !linkedRoleIds.has(role.agentId)),
    [linkedRoleIds, roles],
  );

  const directReportsCount = useMemo(() => {
    const counts = new Map<string, number>();
    for (const role of roles) {
      if (!role.reportsTo) continue;
      counts.set(role.reportsTo, (counts.get(role.reportsTo) ?? 0) + 1);
    }
    return counts;
  }, [roles]);

  const filteredAgents = useMemo(() => {
    if (!treeSearch.trim()) return roles;
    const q = treeSearch.toLowerCase();
    return roles.filter((a) =>
      a.agentName?.toLowerCase().includes(q) ||
      a.roleTitle?.toLowerCase().includes(q) ||
      a.roleType?.toLowerCase().includes(q) ||
      a.agentId?.toLowerCase().includes(q)
    );
  }, [roles, treeSearch]);

  const maxOrgDepth = useMemo(() => {
    if (rootTreeRoles.length === 0) return 0;
    const visited = new Set<string>();
    const visit = (role: AgentRole, depth: number): number => {
      if (visited.has(role.agentId)) return depth;
      visited.add(role.agentId);
      const children = childrenByParent.get(role.agentId) ?? [];
      if (children.length === 0) return depth;
      return Math.max(...children.map((child) => visit(child, depth + 1)));
    };
    return Math.max(...rootTreeRoles.map((role) => visit(role, 1)));
  }, [childrenByParent, rootTreeRoles]);

  const goalsById = useMemo(() => new Map(goals.map((goal) => [goal.id, goal])), [goals]);

  const childGoalsByParent = useMemo(() => {
    const map = new Map<string, HierarchyGoal[]>();
    for (const goal of goals) {
      if (!goal.parentGoalId) continue;
      const list = map.get(goal.parentGoalId) ?? [];
      list.push(goal);
      map.set(goal.parentGoalId, list);
    }
    for (const [goalId, list] of map.entries()) {
      map.set(goalId, [...list].sort((left, right) => left.name.localeCompare(right.name)));
    }
    return map;
  }, [goals]);

  const selectedGoalByState = useMemo(
    () => (selectedGoalId ? goalsById.get(selectedGoalId) ?? null : null),
    [goalsById, selectedGoalId],
  );

  const requestedGoalFromList = useMemo(
    () => (requestedGoalId ? goalsById.get(requestedGoalId) ?? null : null),
    [goalsById, requestedGoalId],
  );

  useEffect(() => {
    if (!requestedGoalId) {
      setRequestedGoalFocus(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/hierarchy/goals?id=${encodeURIComponent(requestedGoalId)}`);
        const json = await response.json();
        if (!json.success || !json.data || cancelled) return;
        setRequestedGoalFocus(json.data as HierarchyGoal);
      } catch {
        // non-fatal
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [requestedGoalId]);

  const selectedGoal = requestedGoalFromList ?? requestedGoalFocus ?? selectedGoalByState;
  const goalFocus = selectedGoal;
  const activeOrganization = useMemo(
    () => organizations.find((item) => item.id === activeOrganizationId) ?? null,
    [activeOrganizationId, organizations],
  );

  const openHierarchyDraftInWebChat = (intent: "setup" | "execute" | "workflow" = "execute") => {
    const params = new URLSearchParams();
    const orgName = activeOrganization?.name || "the active organization";
    const goalNameForPrompt = goalFocus?.name || selectedGoalByState?.name || "";
    const promptByIntent: Record<typeof intent, string> = {
      setup: `Set up ${orgName} as an agent organization. Organization ID: ${activeOrganizationId || "not selected"}. Review the current org shape, identify the first practical goal, recommend the right agent roles, and create only the useful agents/tasks/workflows after showing me the plan.`,
      execute: goalNameForPrompt
        ? `Use ${orgName} to execute this goal: ${goalNameForPrompt}. Organization ID: ${activeOrganizationId || "not selected"}. Goal ID: ${(goalFocus?.id || selectedGoalByState?.id) || "not selected"}. Break it into agent-owned work, identify blockers, and create tasks/workflows only where useful. Show the execution plan first.`
        : `Use ${orgName} as an agent organization. Organization ID: ${activeOrganizationId || "not selected"}. Decide the next useful goal, assign agent-owned work, and create tasks/workflows only where useful. Show the execution plan first.`,
      workflow: `Design the simplest workflow support for ${orgName}. Organization ID: ${activeOrganizationId || "not selected"}. Look at the org goals and agent roles, then propose the minimum workflow automation needed before creating anything.`,
    };
    params.set("draft", promptByIntent[intent]);
    router.push(`/chat?${params.toString()}`);
  };

  // Open WebChat prefilled with an arbitrary prompt (used by drawer actions so
  // complex mutations route through the agentic confirmation flow).
  const openWebChatWithPrompt = (prompt: string) => {
    router.push(`/chat?draft=${encodeURIComponent(prompt)}`);
  };

  useEffect(() => {
    const targetGoalId = goalFocus?.id || "";
    if (!targetGoalId || hydratedGoalDetails[targetGoalId]) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/hierarchy/goals?id=${encodeURIComponent(targetGoalId)}`);
        const json = await response.json();
        if (!json.success || !json.data || cancelled) return;
        setHydratedGoalDetails((current) =>
          current[targetGoalId]
            ? current
            : {
                ...current,
                [targetGoalId]: json.data as HierarchyGoal,
              },
        );
      } catch {
        // non-fatal
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [goalFocus, hydratedGoalDetails]);

  useEffect(() => {
    const targetGoalId = goalFocus?.id || "";
    if (!targetGoalId) {
      setGoalFocusDetail(null);
      setGoalFocusAttachmentIdsState([]);
      setGoalFocusDeliverablesState([]);
      return;
    }
    const fallback =
      goalsById.get(targetGoalId) ??
      (requestedGoalFocus?.id === targetGoalId ? requestedGoalFocus : null) ??
      (hydratedGoalDetails[targetGoalId] ?? null) ??
      goalFocus;
    setGoalFocusDetail(fallback);
    setGoalFocusAttachmentIdsState(fallback.linkedDocumentIds ?? []);
    setGoalFocusDeliverablesState(fallback.deliverables ?? []);

    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/hierarchy/goals?id=${encodeURIComponent(targetGoalId)}`);
        const json = await response.json();
        if (!json.success || !json.data || cancelled) return;
        const detail = json.data as HierarchyGoal;
        setGoalFocusDetail(detail);
        setGoalFocusAttachmentIdsState(detail.linkedDocumentIds ?? []);
        setGoalFocusDeliverablesState(detail.deliverables ?? []);
      } catch {
        // non-fatal
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [goalFocus, goalsById, hydratedGoalDetails, requestedGoalFocus]);

  const hydratedGoalFocus = goalFocus ? hydratedGoalDetails[goalFocus.id] ?? goalFocus : null;
  const mergedGoalFocus = useMemo(() => {
    if (!goalFocus) return null;
    const candidates = [
      goalsById.get(goalFocus.id) ?? null,
      selectedGoal?.id === goalFocus.id ? selectedGoal : null,
      requestedGoalFocus?.id === goalFocus.id ? requestedGoalFocus : null,
      hydratedGoalFocus?.id === goalFocus.id ? hydratedGoalFocus : null,
      goalFocusDetail?.id === goalFocus.id ? goalFocusDetail : null,
    ].filter((candidate): candidate is HierarchyGoal => Boolean(candidate));
    if (candidates.length === 0) return goalFocus;
    const linkedDocumentIds = Array.from(
      new Set(
        candidates
          .flatMap((candidate) => candidate.linkedDocumentIds ?? [])
          .map((documentId) => String(documentId || "").trim())
          .filter(Boolean),
      ),
    );
    const deliverables = Array.from(
      new Set(
        candidates
          .flatMap((candidate) => candidate.deliverables ?? [])
          .map((deliverable) => String(deliverable || "").trim())
          .filter(Boolean),
      ),
    );
    const primary = candidates[candidates.length - 1] ?? goalFocus;
    return {
      ...primary,
      linkedDocumentIds,
      deliverables,
    } satisfies HierarchyGoal;
  }, [goalFocus, goalFocusDetail, goalsById, hydratedGoalFocus, requestedGoalFocus, selectedGoal]);

  const selectedGoalAncestry = useMemo(() => {
    if (!selectedGoal) return [];
    const ancestry: HierarchyGoal[] = [];
    const seen = new Set<string>();
    let cursor: HierarchyGoal | null = selectedGoal;
    while (cursor && !seen.has(cursor.id)) {
      ancestry.push(cursor);
      seen.add(cursor.id);
      cursor = cursor.parentGoalId ? goalsById.get(cursor.parentGoalId) ?? null : null;
    }
    return ancestry.reverse();
  }, [goalsById, selectedGoal]);

  const selectedGoalScopeIds = useMemo(() => {
    if (!selectedGoal) return new Set<string>();
    const scopeIds = new Set<string>();
    const visit = (goal: HierarchyGoal) => {
      if (scopeIds.has(goal.id)) return;
      scopeIds.add(goal.id);
      const children = childGoalsByParent.get(goal.id) ?? [];
      for (const child of children) visit(child);
    };
    visit(selectedGoal);
    return scopeIds;
  }, [childGoalsByParent, selectedGoal]);

  const selectedGoalChildGoals = useMemo(
    () => (selectedGoal ? childGoalsByParent.get(selectedGoal.id) ?? [] : []),
    [childGoalsByParent, selectedGoal],
  );

  const scopedGoalTasks = useMemo(() => {
    if (!selectedGoal) return [];
    return [...runtimeSnapshot.tasks]
      .filter((task) => task.goalId && selectedGoalScopeIds.has(task.goalId))
      .sort(
        (left, right) =>
          new Date(right.updatedAt || 0).getTime() - new Date(left.updatedAt || 0).getTime(),
      );
  }, [runtimeSnapshot.tasks, selectedGoal, selectedGoalScopeIds]);

  const scopedGoalWorkflows = useMemo(() => {
    if (!selectedGoal) return [];
    return [...runtimeSnapshot.workflows]
      .filter((workflow) => workflow.goalId && selectedGoalScopeIds.has(workflow.goalId))
      .sort(
        (left, right) =>
          new Date(right.lastExecution?.startedAt || 0).getTime() -
          new Date(left.lastExecution?.startedAt || 0).getTime(),
      );
  }, [runtimeSnapshot.workflows, selectedGoal, selectedGoalScopeIds]);

  const scopedGoalWorkflowIds = useMemo(
    () => new Set(scopedGoalWorkflows.map((workflow) => workflow.id)),
    [scopedGoalWorkflows],
  );

  const scopedGoalRunning = useMemo(
    () => runtimeSnapshot.running.filter((execution) => scopedGoalWorkflowIds.has(execution.workflowId)),
    [runtimeSnapshot.running, scopedGoalWorkflowIds],
  );

  const scopedGoalBoards = useMemo(
    () =>
      Array.from(
        new Set(
          scopedGoalTasks
            .map((task) => task.boardName)
            .filter((boardName): boardName is string => Boolean(boardName)),
        ),
      ).sort((left, right) => left.localeCompare(right)),
    [scopedGoalTasks],
  );

  const scopedGoalOwners = useMemo(
    () =>
      Array.from(
        new Set(
          scopedGoalTasks
            .flatMap((task) => [task.assignedAgentName, task.checkedOutByAgentName])
            .filter((value): value is string => Boolean(value)),
        ),
      ).sort((left, right) => left.localeCompare(right)),
    [scopedGoalTasks],
  );

  const selectedGoalDocumentIds = useMemo(
    () =>
      Array.from(
        new Set(
          [
            ...(mergedGoalFocus?.linkedDocumentIds ?? []),
            ...scopedGoalTasks.flatMap((task) => task.linkedDocumentIds ?? []),
          ]
            .map((id) => String(id || "").trim())
            .filter(Boolean),
        ),
      ),
    [mergedGoalFocus, scopedGoalTasks],
  );

  const scopedGoalSourceRefs = useMemo(
    () =>
      Array.from(
        new Set(
          [...scopedGoalTasks, ...scopedGoalWorkflows]
            .map((item) => String(item.sourceRef || "").trim())
            .filter(Boolean),
        ),
      ),
    [scopedGoalTasks, scopedGoalWorkflows],
  );

  useEffect(() => {
    const missingIds = Array.from(new Set([...scopedGoalSourceRefs, ...selectedGoalDocumentIds])).filter(
      (id) => !Object.prototype.hasOwnProperty.call(linkedDocumentsById, id),
    );
    if (missingIds.length === 0) return;

    let cancelled = false;
    void (async () => {
      const loadedEntries = await Promise.all(
        missingIds.map(async (documentId) => {
          try {
            const response = await fetch(`/api/documents/${encodeURIComponent(documentId)}`);
            const json = await response.json();
            if (!json.success || !json.data) {
              return [documentId, null] as const;
            }
            const data = json.data as Record<string, unknown>;
            return [
              documentId,
              {
                id: String(data.id || documentId),
                sourceType: String(data.sourceType || "upload") as LinkedDocumentSummary["sourceType"],
                name: String(data.name || documentId),
                mimeType: data.mimeType ? String(data.mimeType) : null,
                sourceUrl: data.sourceUrl ? String(data.sourceUrl) : null,
                sizeBytes: typeof data.sizeBytes === "number" ? data.sizeBytes : null,
                excerpt: String(data.extractedText || "").slice(0, 260),
                createdAt: String(data.createdAt || ""),
                updatedAt: data.updatedAt ? String(data.updatedAt) : undefined,
                metadata:
                  data.metadata && typeof data.metadata === "object" && !Array.isArray(data.metadata)
                    ? (data.metadata as Record<string, unknown>)
                    : undefined,
              } satisfies LinkedDocumentSummary,
            ] as const;
          } catch {
            return [documentId, null] as const;
          }
        }),
      );
      if (cancelled) return;
      setLinkedDocumentsById((current) => {
        const next = { ...current };
        for (const [documentId, document] of loadedEntries) {
          next[documentId] = document;
        }
        return next;
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [linkedDocumentsById, scopedGoalSourceRefs, selectedGoalDocumentIds]);

  const scopedGoalSourcePack = useMemo(() => {
    const sourcePack = new Map<string, GoalSourcePackItem>();
    const includeSource = (
      sourceType?: string | null,
      sourceRef?: string | null,
      sourceKind: "task" | "workflow" = "task",
    ) => {
      const label = formatLinkedSource(sourceType, sourceRef);
      if (!label) return;
      const normalizedType = String(sourceType || "").trim().toLowerCase() || null;
      const normalizedRef = String(sourceRef || "").trim() || null;
      const key = normalizedRef ? `${normalizedType ?? "source"}:${normalizedRef}` : label;
      const current = sourcePack.get(key) ?? {
        key,
        sourceType: normalizedType,
        sourceRef: normalizedRef,
        label,
        taskCount: 0,
        workflowCount: 0,
        document: null,
      };
      if (sourceKind === "task") {
        current.taskCount += 1;
      } else {
        current.workflowCount += 1;
      }
      if (normalizedRef) {
        current.document = linkedDocumentsById[normalizedRef] ?? null;
      }
      sourcePack.set(key, current);
    };

    scopedGoalTasks.forEach((task) => includeSource(task.sourceType, task.sourceRef, "task"));
    scopedGoalWorkflows.forEach((workflow) => includeSource(workflow.sourceType, workflow.sourceRef, "workflow"));

    return Array.from(sourcePack.values()).sort((left, right) => {
      const byDocument = Number(Boolean(right.document)) - Number(Boolean(left.document));
      if (byDocument !== 0) return byDocument;
      const byUsage = right.taskCount + right.workflowCount - (left.taskCount + left.workflowCount);
      if (byUsage !== 0) return byUsage;
      return (right.document?.createdAt || "").localeCompare(left.document?.createdAt || "");
    });
  }, [linkedDocumentsById, scopedGoalTasks, scopedGoalWorkflows]);

  const scopedGoalLinkedSources = useMemo(
    () => scopedGoalSourcePack.map((source) => source.document?.name || source.label),
    [scopedGoalSourcePack],
  );

  const selectedGoalLinkedDocuments = useMemo(
    () =>
      (selectedGoal?.linkedDocumentIds ?? [])
        .map((documentId) => linkedDocumentsById[documentId] ?? null)
        .filter((document): document is LinkedDocumentSummary => Boolean(document)),
    [linkedDocumentsById, selectedGoal],
  );

  const selectedGoalDeliverables = selectedGoal?.deliverables ?? [];
  const goalPanelPreview = useMemo(
    () =>
      selectedGoal ??
      goals.find((goal) => goal.deliverables.length > 0 || goal.linkedDocumentIds.length > 0) ??
      goals[0] ??
      null,
    [goals, selectedGoal],
  );
  const goalPanelPreviewLinkedDocuments = useMemo(
    () =>
      (goalPanelPreview?.linkedDocumentIds ?? [])
        .map((documentId) => linkedDocumentsById[documentId] ?? documentById.get(documentId) ?? null)
        .filter((document): document is LinkedDocumentSummary | DocumentOption => Boolean(document)),
    [documentById, goalPanelPreview, linkedDocumentsById],
  );
  const goalFocusLinkedDocuments = useMemo(
    () =>
      goalFocusAttachmentIdsState
        .map((documentId) => linkedDocumentsById[documentId] ?? documentById.get(documentId) ?? null)
        .filter((document): document is LinkedDocumentSummary | DocumentOption => Boolean(document)),
    [documentById, goalFocusAttachmentIdsState, linkedDocumentsById],
  );
  const goalFocusAttachmentIds = goalFocusAttachmentIdsState;
  const goalFocusDeliverables = goalFocusDeliverablesState;

  const scopedGoalOpenTasks = useMemo(
    () => scopedGoalTasks.filter((task) => task.status !== "done"),
    [scopedGoalTasks],
  );

  const scopedGoalFailedWorkflows = useMemo(
    () => scopedGoalWorkflows.filter((workflow) => workflow.lastExecution?.status === "failed"),
    [scopedGoalWorkflows],
  );

  const scopedActivityTasks = useMemo(() => {
    return [...runtimeSnapshot.tasks]
      .filter((task) => !activeOrganizationId || task.organizationId === activeOrganizationId)
      .filter((task) => !selectedGoal || Boolean(task.goalId && selectedGoalScopeIds.has(task.goalId)))
      .sort((left, right) => new Date(right.updatedAt || 0).getTime() - new Date(left.updatedAt || 0).getTime());
  }, [activeOrganizationId, runtimeSnapshot.tasks, selectedGoal, selectedGoalScopeIds]);

  const scopedActivityWorkflows = useMemo(() => {
    return [...runtimeSnapshot.workflows]
      .filter((workflow) => !activeOrganizationId || workflow.organizationId === activeOrganizationId)
      .filter((workflow) => !selectedGoal || Boolean(workflow.goalId && selectedGoalScopeIds.has(workflow.goalId)))
      .sort(
        (left, right) =>
          new Date(right.lastExecution?.startedAt || 0).getTime() -
          new Date(left.lastExecution?.startedAt || 0).getTime(),
      );
  }, [activeOrganizationId, runtimeSnapshot.workflows, selectedGoal, selectedGoalScopeIds]);

  const scopedActivityWorkflowIds = useMemo(
    () => new Set(scopedActivityWorkflows.map((workflow) => workflow.id)),
    [scopedActivityWorkflows],
  );

  const hierarchyActivityRollup = useMemo(() => {
    const workflowNameById = new Map(scopedActivityWorkflows.map((workflow) => [workflow.id, workflow.name]));
    const items = [
      ...scopedActivityTasks.slice(0, 8).map((task) => ({
        key: `task:${task.id}`,
        ts: task.updatedAt || new Date(0).toISOString(),
        label: "Task updated",
        detail: task.title,
        meta: [task.boardName, task.status.replace(/_/g, " ")].filter(Boolean).join(" · "),
      })),
      ...scopedActivityWorkflows
        .filter((workflow) => workflow.lastExecution?.startedAt)
        .slice(0, 8)
        .map((workflow) => ({
          key: `workflow:${workflow.id}`,
          ts: workflow.lastExecution?.startedAt || new Date(0).toISOString(),
          label: workflow.lastExecution?.status === "failed" ? "Workflow failed" : "Workflow executed",
          detail: workflow.name,
          meta: [workflow.lastExecution?.triggerType, workflow.lastExecution?.status].filter(Boolean).join(" · "),
        })),
      ...runtimeSnapshot.running
        .filter((execution) => scopedActivityWorkflowIds.has(execution.workflowId))
        .slice(0, 6)
        .map((execution) => ({
          key: `running:${execution.executionId}`,
          ts: execution.startedAt,
          label: "Workflow running",
          detail: workflowNameById.get(execution.workflowId) || execution.workflowId,
          meta: [execution.triggerType, `${execution.completedNodes}/${execution.totalNodes} nodes`].join(" · "),
        })),
      ...runtimeSnapshot.telemetry
        .filter((event) => {
          const workflowId = String(event.data.workflowId || "").trim();
          return workflowId ? scopedActivityWorkflowIds.has(workflowId) : false;
        })
        .slice(0, 12)
        .map((event) => ({
          key: `telemetry:${event.ts}:${event.type}`,
          ts: event.ts,
          label: event.type.replace(/\./g, " "),
          detail: workflowNameById.get(String(event.data.workflowId || "")) || String(event.data.workflowId || "Workflow"),
          meta: [String(event.data.nodeType || ""), String(event.data.status || "")].filter(Boolean).join(" · "),
        })),
      ...hierarchyLedgerEvents.map((event) => ({
        key: `ledger:${event.id}`,
        ts: event.createdAt,
        label: event.eventType.replace(/[._-]/g, " "),
        detail: event.title,
        meta: [
          event.summary || "",
          event.status ? `status ${event.status}` : "",
          event.costUsd ? `$${event.costUsd.toFixed(4)}` : "",
          event.tokenCount ? `${event.tokenCount} tokens` : "",
        ].filter(Boolean).join(" · "),
      })),
    ];

    return items
      .sort((left, right) => new Date(right.ts).getTime() - new Date(left.ts).getTime())
      .filter((item, index, rows) => rows.findIndex((candidate) => candidate.key === item.key) === index)
      .slice(0, 10);
  }, [
    runtimeSnapshot.running,
    runtimeSnapshot.telemetry,
    hierarchyLedgerEvents,
    scopedActivityTasks,
    scopedActivityWorkflowIds,
    scopedActivityWorkflows,
  ]);

  const orgHealth = useMemo(() => {
    const inactiveAgents = roles.filter((role) => !role.agentActive).length;
    const noCapabilities = roles.filter((role) => role.capabilities.length === 0).length;
    const managersWithoutReports = roles.filter((role) => {
      if (role.roleType !== "orchestrator" && role.roleType !== "operations") return false;
      return (directReportsCount.get(role.agentId) ?? 0) === 0;
    }).length;
    const largestSpan = Array.from(directReportsCount.values()).reduce((max, count) => Math.max(max, count), 0);
    const budgetBlockedAgents = roles.filter((role) => {
      const budget = agentSettings[role.agentId]?.budgetSummary;
      return Boolean(budget?.overCap && budget?.budgetAction === "block");
    }).length;
    return {
      activeAgents: roles.filter((role) => role.agentActive).length,
      inactiveAgents,
      unlinkedAgents: unlinked.length,
      managersWithoutReports,
      noCapabilities,
      largestSpan,
      budgetBlockedAgents,
      maxDepth: maxOrgDepth,
    };
  }, [agentSettings, directReportsCount, maxOrgDepth, roles, unlinked.length]);

  const roleSummary = useMemo(() => {
    const summary = new Map<AgentRoleType, number>();
    for (const role of roles) {
      summary.set(role.roleType, (summary.get(role.roleType) ?? 0) + 1);
    }
    return ROLE_TYPE_OPTIONS.map((option) => ({
      label: option.label,
      value: summary.get(option.value) ?? 0,
    }));
  }, [roles]);

  const capabilityCoverage = useMemo(() => {
    const activeCaps = Array.from(
      new Set(
        roles.flatMap((role) =>
          role.capabilities
            .map((capability) => capability.trim())
            .filter(Boolean),
        ),
      ),
    ).sort();
    const snapshotCaps = Array.from(
      new Set(
        organizations.flatMap((organization) =>
          ((organization as unknown as { snapshot?: Array<{ role?: { capabilities?: string[] } }> }).snapshot ?? []).flatMap((member) =>
            (member.role?.capabilities ?? []).map((capability) => String(capability || "").trim()).filter(Boolean),
          ),
        ),
      ),
    );
    const universeCaps = Array.from(new Set([...activeCaps, ...snapshotCaps])).sort();
    return {
      visibleCapabilities: activeCaps.slice(0, 12),
      missingCapabilities: universeCaps.filter((capability) => !activeCaps.includes(capability)),
    };
  }, [organizations, roles]);

  const integrityIssues = useMemo(() => {
    const issueList: Array<{ key: string; label: string; count: number }> = [];
    const scopedTasks = runtimeSnapshot.tasks.filter((task) => !activeOrganizationId || task.organizationId === activeOrganizationId);
    const scopedWorkflows = runtimeSnapshot.workflows.filter((workflow) => !activeOrganizationId || workflow.organizationId === activeOrganizationId);
    const scopedGoalIds = new Set(
      goals
        .filter((goal) => !activeOrganizationId || goal.organizationId === activeOrganizationId)
        .map((goal) => goal.id),
    );
    const taskIds = new Set(scopedTasks.map((task) => task.id));

    const noModel = roles.filter((role) => role.agentActive && !agentSettings[role.agentId]?.modelRef).length;
    if (noModel > 0 && activeGlobalModel === null) {
      issueList.push({
        key: "no-model",
        label: `${noModel} active agent(s) without an agent or global model configured`,
        count: noModel,
      });
    }

    const noManager = roles.filter((role) => role.roleType !== "orchestrator" && !role.reportsTo).length;
    if (noManager > 0) issueList.push({ key: "no-manager", label: `${noManager} non-orchestrator role(s) without a manager`, count: noManager });

    const goalsWithoutParticipants = goals.filter((goal) => {
      if (activeOrganizationId && goal.organizationId !== activeOrganizationId) return false;
      const hasTask = scopedTasks.some((task) => task.goalId === goal.id);
      const hasWorkflow = scopedWorkflows.some((workflow) => workflow.goalId === goal.id);
      return !hasTask && !hasWorkflow;
    }).length;
    if (goalsWithoutParticipants > 0) issueList.push({ key: "goal-no-participants", label: `${goalsWithoutParticipants} goal(s) without scoped tasks or workflows`, count: goalsWithoutParticipants });

    const missingBlockers = scopedTasks.filter((task) => (task.blockedBy ?? []).some((blockerId: string) => !taskIds.has(blockerId))).length;
    if (missingBlockers > 0) issueList.push({ key: "missing-blockers", label: `${missingBlockers} blocked task(s) reference deleted blockers`, count: missingBlockers });

    const floatingGoals = goals.filter((goal) => !goal.organizationId).length;
    if (floatingGoals > 0) issueList.push({ key: "floating-goals", label: `${floatingGoals} goal(s) with no org link`, count: floatingGoals });

    const brokenGoalRefs =
      scopedTasks.filter((task) => task.goalId && !scopedGoalIds.has(task.goalId)).length +
      scopedWorkflows.filter((workflow) => workflow.goalId && !scopedGoalIds.has(workflow.goalId)).length;
    if (brokenGoalRefs > 0) issueList.push({ key: "broken-goal-links", label: `${brokenGoalRefs} scoped task/workflow reference(s) point at missing goals`, count: brokenGoalRefs });

    return issueList;
  }, [activeGlobalModel, activeOrganizationId, agentSettings, goals, roles, runtimeSnapshot.tasks, runtimeSnapshot.workflows]);

  const activeScopedGoalCount = useMemo(
    () => goals.filter((goal) => !activeOrganizationId || goal.organizationId === activeOrganizationId).length,
    [activeOrganizationId, goals],
  );

  const activeGlobalModelLabel = activeGlobalModel ? `${activeGlobalModel.provider}:${activeGlobalModel.modelId}` : null;
  const showHierarchySetupGuide =
    organizations.length === 0 ||
    Boolean(
      activeOrganizationId &&
        !loading &&
        (roles.length === 0 || activeScopedGoalCount === 0 || integrityIssues.length > 0),
    );

  // Compact org health for the Map-mode health strip (4 metrics + chips).
  const mapHealth = useMemo(() => {
    const scopedTasks = runtimeSnapshot.tasks.filter(
      (task) => !activeOrganizationId || task.organizationId === activeOrganizationId,
    );
    const activeWork = scopedTasks.filter((task) => task.status === "in_progress").length;
    const blocked = scopedTasks.filter((task) => task.status === "blocked").length;
    const agents = roles.length;
    const budgetOk = !integrityIssues.some((issue) => issue.key === "budget-near-cap");
    return { agents, activeWork, blocked, budgetOk };
  }, [activeOrganizationId, integrityIssues, roles.length, runtimeSnapshot.tasks]);

  const workloadByAgent = useMemo(
    () =>
      buildWorkload(
        roles,
        runtimeSnapshot.tasks,
        runtimeSnapshot.workflows,
        runtimeSnapshot.cronJobs,
        runtimeSnapshot.running,
      ),
    [roles, runtimeSnapshot],
  );

  const workloadSummary = useMemo(() => {
    const items = Object.values(workloadByAgent);
    return items.reduce(
      (acc, item) => {
        acc.assignedTasks += item.assignedTasks;
        acc.activeTasks += item.activeTasks;
        acc.workflows += item.workflows;
        acc.liveSchedules += item.liveSchedules;
        return acc;
      },
      { assignedTasks: 0, activeTasks: 0, workflows: 0, liveSchedules: 0 },
    );
  }, [workloadByAgent]);

  const onDraftChange = (agentId: string, patch: Partial<AgentRoleDraft>) => {
    setDrafts((current) => {
      const existing = current[agentId];
      if (!existing) return current;
      return {
        ...current,
        [agentId]: { ...existing, ...patch },
      };
    });
  };

  const onSaveRole = async (agentId: string) => {
    const draft = drafts[agentId];
    if (!draft) return;
    setSavingRoleId(agentId);
    try {
      await fetch("/api/agents/roles", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId,
          roleType: draft.roleType,
          roleTitle: draft.roleTitle.trim(),
          roleDescription: draft.roleDescription.trim(),
          reportsTo: draft.roleType === "orchestrator" ? null : draft.reportsTo,
          capabilities: draft.capabilitiesText
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
          voteWeight: draft.voteWeight,
        }),
      });
      await Promise.all([loadRoles(), loadOrganizations()]);
    } finally {
      setSavingRoleId(null);
    }
  };

  const onSaveOrganization = async () => {
    const name = organizationName.trim();
    if (!name) return;
    setSavingOrganization(true);
    try {
      await fetch("/api/hierarchy/organizations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          description: organizationDescription.trim() || null,
          mission: organizationMission.trim() || null,
          activate: true,
        }),
      });
      await Promise.all([loadOrganizations(), loadRoles()]);
    } finally {
      setSavingOrganization(false);
    }
  };

  const applyOrganizationById = async (organizationId: string) => {
    if (!organizationId) return;
    setApplyingOrganization(true);
    try {
      await fetch("/api/hierarchy/organizations", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId }),
      });
      await Promise.all([loadOrganizations(), loadRoles()]);
    } finally {
      setApplyingOrganization(false);
    }
  };

  const onApplyOrganization = async () => {
    if (!selectedOrganizationId) return;
    await applyOrganizationById(selectedOrganizationId);
  };

  const exportOrganizationPackage = async () => {
    if (!activeOrganizationId) return;
    setOrgPackageBusy(true);
    try {
      const response = await fetch(`/api/hierarchy/export?orgId=${activeOrganizationId}`);
      const json = await response.json();
      if (!json.success) throw new Error(String(json.error || "Export failed"));
      const activeOrg = organizations.find((organization) => organization.id === activeOrganizationId);
      const blob = new Blob([JSON.stringify(json.data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `disp8ch-org-${(activeOrg?.name ?? "export").replace(/\s+/g, "-").toLowerCase()}-${Date.now()}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } finally {
      setOrgPackageBusy(false);
    }
  };

  const importOrganizationPackage = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setOrgPackageBusy(true);
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      const response = await fetch("/api/hierarchy/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(json),
      });
      const data = await response.json();
      if (!data.success) {
        alert("Import failed: " + (data.error || "unknown error"));
        return;
      }
      window.location.reload();
    } finally {
      setOrgPackageBusy(false);
    }
  };

  const onApplyCompanyTemplate = async () => {
    if (!selectedTemplateId) return;
    setApplyingCompanyTemplate(true);
    try {
      await fetch("/api/hierarchy/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          templateId: selectedTemplateId,
          organizationName: templateOrganizationName.trim() || null,
          activate: true,
        }),
      });
      setTemplateOrganizationName("");
      await Promise.all([loadCompanyTemplates(), loadOrganizations(), loadRoles()]);
    } finally {
      setApplyingCompanyTemplate(false);
    }
  };

  const onCreateGoal = async () => {
    const name = goalName.trim();
    if (!name) return;
    setSavingGoal(true);
    try {
      await fetch("/api/hierarchy/goals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          description: goalDescription.trim() || null,
          organizationId: activeOrganizationId || null,
          parentGoalId: goalParentId || null,
          linkedDocumentIds: goalLinkedDocumentIds,
          deliverables: parseListText(goalDeliverablesText),
        }),
      });
      setGoalName("");
      setGoalDescription("");
      setGoalParentId("");
      setGoalDeliverablesText("");
      setGoalDocumentCandidateId("");
      setGoalLinkedDocumentIds([]);
      await loadGoals(activeOrganizationId || undefined);
    } finally {
      setSavingGoal(false);
    }
  };

  const onToggleAgentActive = async (agentId: string, nextActive: boolean) => {
    setActingAgentId(agentId);
    try {
      await fetch("/api/agents", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: agentId, isActive: nextActive }),
      });
      await Promise.all([loadRoles(), loadOrganizations()]);
    } finally {
      setActingAgentId(null);
    }
  };

  const onRetryFailedWorkflow = async (workflowId: string) => {
    setActingAgentId(workflowId);
    try {
      await fetch("/api/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflowId,
          triggerType: "manual",
          triggerData: { message: "Retry from hierarchy governance panel" },
        }),
      });
      await loadRoles();
    } finally {
      setActingAgentId(null);
    }
  };

  const toggleSection = (key: string) => {
    setCollapsedSections((c) => ({ ...c, [key]: !c[key] }));
  };

  const adjustTreeScale = (delta: number) => {
    setTreeScale((current) => clampTreeScale(current + delta));
  };

  const resetTreeViewport = () => {
    setTreeScale(1);
    setTreeOffset({ x: 0, y: 0 });
  };

  const onTreePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("[data-tree-ignore-pan='true']")) return;
    treePanRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: treeOffset.x,
      originY: treeOffset.y,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setTreePanning(true);
  };

  const onTreePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (treePanRef.current.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - treePanRef.current.startX;
    const deltaY = event.clientY - treePanRef.current.startY;
    if (Math.abs(deltaX) > 4 || Math.abs(deltaY) > 4) {
      treePanRef.current.moved = true;
      ignoreNextTreeClickRef.current = true;
    }
    setTreeOffset({
      x: treePanRef.current.originX + deltaX,
      y: treePanRef.current.originY + deltaY,
    });
  };

  const finishTreePointer = (event: React.PointerEvent<HTMLDivElement>) => {
    if (treePanRef.current.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    treePanRef.current.pointerId = null;
    setTreePanning(false);
    if (treePanRef.current.moved) {
      window.setTimeout(() => {
        ignoreNextTreeClickRef.current = false;
      }, 0);
    }
  };

  const onTreeWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    adjustTreeScale(event.deltaY < 0 ? 0.08 : -0.08);
  };

  const getHeartbeatDot = (role: AgentRole) => {
    const budget = agentSettings[role.agentId]?.budgetSummary ?? null;
    const isBudgetBlocked = Boolean(budget?.overCap && budget?.budgetAction === "block");
    const workload = workloadByAgent[role.agentId];
    if (isBudgetBlocked) return "bg-terminal-red pulse-red";
    if (!workload) return "bg-muted-foreground/40";
    if (workload.heartbeatStatus === "running") return "bg-green-400 animate-pulse";
    if (workload.heartbeatStatus === "scheduled") return "bg-yellow-400";
    if (workload.heartbeatStatus === "recent") return "bg-green-400/60";
    if (workload.heartbeatStatus === "inactive") return "bg-terminal-red/60";
    return "bg-muted-foreground/40";
  };

  const renderTreeNode = (role: AgentRole, isRoot: boolean = false) => {
    const workload = workloadByAgent[role.agentId] ?? {
      assignedTasks: 0, activeTasks: 0, inProgressTasks: 0, reviewTasks: 0,
      workflows: 0, scheduledWorkflows: 0, liveSchedules: 0, runningNow: false,
      heartbeatStatus: role.agentActive ? "idle" as const : "inactive" as const,
      lastRunAt: null, lastRunStatus: null, failedWorkflowId: null, failedWorkflowName: null,
    };
    const budget = agentSettings[role.agentId]?.budgetSummary ?? null;
    const isBudgetBlocked = Boolean(budget?.overCap && budget?.budgetAction === "block");
    const directReports = directReportsCount.get(role.agentId) ?? 0;
    const isExpanded = expandedNodeId === role.agentId;
    const modelRef = agentSettings[role.agentId]?.modelRef ?? null;
    const modelLabel = modelRef
      ? modelRef.replace(/^claude-/, "").replace(/^gemini-/, "gemini:").replace(/^gpt-/, "gpt:").split("-")[0]
      : null;

    return (
      <div
        key={`tree-${role.agentId}`}
        data-tree-node="true"
        data-agent-id={role.agentId}
        className={`cursor-pointer border transition-all hover:border-terminal-red ${
          isRoot ? "border-terminal-red/50 bg-terminal-red/5" : "border-border bg-card"
        } ${isExpanded ? "ring-1 ring-terminal-red/30" : ""}`}
        style={{ minWidth: 160, maxWidth: 240 }}
        onClick={() => {
          if (ignoreNextTreeClickRef.current) {
            ignoreNextTreeClickRef.current = false;
            return;
          }
          setExpandedNodeId(isExpanded ? null : role.agentId);
        }}
      >
        {/* Corner accents */}
        <div className="absolute top-0 left-0 w-2 h-2 border-t-2 border-l-2 border-terminal-red" style={{ position: "relative", width: 0, height: 0, overflow: "visible" }} />
        <div className="p-3">
          <div className="flex items-center gap-2 mb-1">
            <ShapeAvatar seed={role.agentId} size={28} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-semibold" title={role.agentName}>
                <span className="mr-1">{getRoleEmoji(role.roleTitle || role.roleType)}</span>
                {role.agentName}
              </div>
              <div className="truncate text-[10px] text-muted-foreground" title={role.roleTitle || "No title"}>{role.roleTitle || "No title"}</div>
            </div>
            <span className={`inline-block h-2.5 w-2.5 rounded-full shrink-0 ${getHeartbeatDot(role)}`} />
          </div>
          <div className="flex flex-wrap gap-1 mt-2">
            <span className="inline-flex items-center px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider border border-terminal-red/30 text-terminal-red/80">
              {ROLE_TYPE_LABELS[role.roleType] || role.roleType}
            </span>
            {isAdvancedView && modelLabel && (
              <span className="inline-flex items-center px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider border border-blue-500/30 text-blue-400/80">
                {modelLabel}
              </span>
            )}
            {isAdvancedView && directReports > 0 && (
              <span className="inline-flex items-center px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider border border-border text-muted-foreground">
                {directReports} reports
              </span>
            )}
            {workload.activeTasks > 0 && (
              <span className="inline-flex items-center px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider border border-border text-muted-foreground">
                {workload.activeTasks} tasks
              </span>
            )}
            {isBudgetBlocked && (
              <span className="inline-flex items-center px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider border border-terminal-red text-terminal-red">
                BLOCKED
              </span>
            )}
          </div>
          {/* Task activity sparkline — last 7 days */}
          {isAdvancedView && (() => {
            const agentTasks = (runtimeSnapshot?.tasks ?? []).filter((t) => t.assignedAgentId === role.agentId);
            if (agentTasks.length === 0) return null;
            const days = 7;
            const now = Date.now();
            const buckets = Array.from({ length: days }, (_, i) => {
              const dayStart = now - (days - i) * 86_400_000;
              const dayEnd = dayStart + 86_400_000;
              return agentTasks.filter((t) => {
                const ts = new Date(t.updatedAt || now).getTime();
                return ts >= dayStart && ts < dayEnd;
              }).length;
            });
            const max = Math.max(1, ...buckets);
            const w = 40; const h = 14; const bw = w / days;
            return (
              <div className="mt-1.5 px-0.5">
                <svg width={w} height={h} className="opacity-50">
                  {buckets.map((count, i) => {
                    const barH = (count / max) * (h - 2);
                    return (
                      <rect
                        key={i}
                        x={i * bw + 0.5}
                        y={h - barH - 1}
                        width={bw - 1}
                        height={Math.max(1, barH)}
                        fill="hsl(var(--terminal-red))"
                        opacity={count > 0 ? 0.7 : 0.15}
                      />
                    );
                  })}
                </svg>
              </div>
            );
          })()}
        </div>
      </div>
    );
  };

  const renderOrgBranch = (
    role: AgentRole,
    isRoot: boolean = false,
    ancestry: Set<string> = new Set(),
  ) => {
    const nextAncestry = new Set(ancestry);
    nextAncestry.add(role.agentId);
    const children = (childrenByParent.get(role.agentId) ?? []).filter((child) => child.agentId !== role.agentId);
    return (
      <li key={`branch-${role.agentId}`} className={role.agentActive ? "active-connector" : ""}>
        {renderTreeNode(role, isRoot)}
        {children.length > 0 ? (
          <ul className="has-connector">
            {children.map((child) =>
              nextAncestry.has(child.agentId) ? (
                <li key={`cycle-${role.agentId}-${child.agentId}`}>
                  <div className="rounded border border-dashed border-terminal-red/40 bg-terminal-red/5 px-3 py-2 text-[11px] text-muted-foreground">
                    Cycle blocked: {child.agentName}
                  </div>
                </li>
              ) : (
                renderOrgBranch(child, false, nextAncestry)
              ),
            )}
          </ul>
        ) : null}
      </li>
    );
  };

  const renderRoleCard = (role: AgentRole, tone: "primary" | "secondary" | "tertiary" = "secondary") => {
    const borderTone =
      tone === "primary"
        ? "border-cyan-400/50 bg-cyan-500/10"
        : tone === "tertiary"
          ? "border-violet-400/40 bg-violet-500/10"
          : "border-muted bg-muted/20";

    const warningBadges = [
      !role.agentActive ? "Inactive" : null,
      role.roleType !== "orchestrator" && !role.reportsTo ? "No manager" : null,
      role.capabilities.length === 0 ? "No capabilities" : null,
    ].filter(Boolean) as string[];
    const budget = agentSettings[role.agentId]?.budgetSummary ?? null;
    const enabledExtensionCount = agentSettings[role.agentId]?.enabledExtensions?.length ?? 0;
    const enabledSkillCount = agentSettings[role.agentId]?.enabledSkills?.length ?? 0;
    const integrations = agentIntegrations[role.agentId];
    const visibleExtensions = [...(integrations?.extensions ?? [])].sort((a, b) => {
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    const visibleSkills = [...(integrations?.skills ?? [])].sort((a, b) => {
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      return a.label.localeCompare(b.label);
    });
    const visiblePresets = [...(integrations?.presets ?? [])].sort((a, b) => {
      const aRecommended = a.recommendedRoleTypes?.includes(role.roleType) ?? false;
      const bRecommended = b.recommendedRoleTypes?.includes(role.roleType) ?? false;
      if (aRecommended !== bRecommended) return aRecommended ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    const directReports = directReportsCount.get(role.agentId) ?? 0;
    const workload = workloadByAgent[role.agentId] ?? {
      assignedTasks: 0,
      activeTasks: 0,
      inProgressTasks: 0,
      reviewTasks: 0,
      workflows: 0,
      scheduledWorkflows: 0,
      liveSchedules: 0,
      runningNow: false,
      heartbeatStatus: role.agentActive ? "idle" : "inactive",
      lastRunAt: null,
      lastRunStatus: null,
      failedWorkflowId: null,
      failedWorkflowName: null,
    };
    const isBudgetBlocked = Boolean(budget?.overCap && budget?.budgetAction === "block");
    const heartbeatTone =
      isBudgetBlocked
        ? "destructive"
        : workload.heartbeatStatus === "running"
        ? "default"
        : workload.heartbeatStatus === "scheduled" || workload.heartbeatStatus === "recent"
          ? "secondary"
          : "outline";
    const heartbeatLabel =
      isBudgetBlocked
        ? "Budget blocked"
        : workload.heartbeatStatus === "running"
        ? "Running"
        : workload.heartbeatStatus === "scheduled"
          ? "Scheduled"
          : workload.heartbeatStatus === "recent"
            ? "Recent"
            : workload.heartbeatStatus === "inactive"
              ? "Inactive"
              : "Idle";

    return (
      <div key={`hier-${role.agentId}`} className={`rounded-xl border p-4 ${borderTone}`}>
        <div className="mb-2 flex items-start gap-3">
          <ShapeAvatar seed={role.agentId} size={38} />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <div className="truncate text-sm font-semibold">{role.agentName}</div>
              <Badge variant="outline">{ROLE_TYPE_LABELS[role.roleType] || role.roleType}</Badge>
              {role.isDefault ? <Badge variant="secondary">Default</Badge> : null}
            </div>
            <div className="text-xs text-muted-foreground">{role.roleTitle || "No title"}</div>
            {(chainOfCommandByAgent.get(role.agentId) ?? []).length > 1 ? (
              <div className="mt-1 flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
                <span className="font-mono uppercase tracking-wider">Chain</span>
                {(chainOfCommandByAgent.get(role.agentId) ?? []).map((entry, index, items) => (
                  <span key={`${role.agentId}-chain-${entry.agentId}`} className="inline-flex items-center gap-1">
                    <span className={entry.agentId === role.agentId ? "text-foreground" : ""}>{entry.agentName}</span>
                    {index < items.length - 1 ? <span aria-hidden="true">/</span> : null}
                  </span>
                ))}
              </div>
            ) : null}
            {role.reportsTo ? (
              <div className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground">
                <span className="font-mono uppercase tracking-wider">Reports to</span>
                <Badge variant="outline" className="text-[10px]">
                  {roleById.get(role.reportsTo)?.agentName || role.reportsTo}
                </Badge>
              </div>
            ) : role.roleType !== "orchestrator" ? (
              <div className="mt-1 text-[10px] text-muted-foreground">
                <span className="font-mono uppercase tracking-wider">Reports to</span>{" "}
                <span>No manager assigned</span>
              </div>
            ) : null}
          </div>
        </div>
        <div className="mb-2 flex flex-wrap gap-1">
          <Badge variant="secondary" className="text-[10px]">
            {directReports} direct reports
          </Badge>
          <Badge variant="secondary" className="text-[10px]">
            {workload.activeTasks} active tasks
          </Badge>
          <Badge variant="secondary" className="text-[10px]">
            {workload.workflows} workflows
          </Badge>
          {enabledExtensionCount > 0 ? (
            <Badge variant="secondary" className="text-[10px]">
              {enabledExtensionCount} extensions
            </Badge>
          ) : null}
          {enabledSkillCount > 0 ? (
            <Badge variant="secondary" className="text-[10px]">
              {enabledSkillCount} skill packs
            </Badge>
          ) : null}
          <Badge variant={heartbeatTone} className="text-[10px]">
            Heartbeat: {heartbeatLabel}
          </Badge>
          {workload.liveSchedules > 0 ? (
            <Badge variant="secondary" className="text-[10px]">
              {workload.liveSchedules} live schedules
            </Badge>
          ) : null}
          {warningBadges.map((warning) => (
            <Badge key={`${role.agentId}-${warning}`} variant="outline" className="text-[10px]">
              {warning}
            </Badge>
          ))}
          {budget?.spendCapUsd !== null ? (
            <Badge variant={isBudgetBlocked ? "destructive" : budget?.warningLevel === "near" ? "outline" : "secondary"} className="text-[10px]">
              Budget: ${budget?.spentUsd.toFixed(4)} / ${budget?.spendCapUsd?.toFixed(2)}
            </Badge>
          ) : null}
        </div>
        <div className="mb-2 grid grid-cols-2 gap-2 text-[11px] text-muted-foreground">
          <span>Assigned tasks: {workload.assignedTasks}</span>
          <span>In progress: {workload.inProgressTasks}</span>
          <span>Review queue: {workload.reviewTasks}</span>
          <span>Scheduled flows: {workload.scheduledWorkflows}</span>
          <span>Running now: {workload.runningNow ? "yes" : "no"}</span>
          <span>
            Last run: {workload.lastRunAt ? new Date(workload.lastRunAt).toLocaleString() : "never"}
            {workload.lastRunStatus ? ` (${workload.lastRunStatus})` : ""}
          </span>
          <span>Budget window: {budget?.spendWindowDays ?? 30} days</span>
          <span>Budget action: {budget?.budgetAction ?? "warn"}</span>
        </div>
        <p className="mb-2 line-clamp-2 text-xs text-muted-foreground">
          {role.roleDescription || "No role description yet."}
        </p>
        <div className="flex flex-wrap gap-1">
          {role.capabilities.slice(0, 3).map((capability) => (
            <Badge key={`${role.agentId}-${capability}`} variant="secondary" className="text-[10px]">
              {capability}
            </Badge>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            size="sm"
            variant={role.agentActive ? "outline" : "default"}
            onClick={() => void onToggleAgentActive(role.agentId, !role.agentActive)}
            disabled={actingAgentId === role.agentId}
          >
            {actingAgentId === role.agentId ? "Saving..." : role.agentActive ? "Pause Agent" : "Resume Agent"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => toggleAgentIntegrationsPanel(role.agentId)}
            disabled={integrations?.loading || integrations?.saving}
          >
            {integrations?.open ? "Hide Integrations" : "Manage Integrations"}
          </Button>
          {workload.failedWorkflowId ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void onRetryFailedWorkflow(workload.failedWorkflowId!)}
              disabled={actingAgentId === workload.failedWorkflowId}
            >
              {actingAgentId === workload.failedWorkflowId ? "Retrying..." : "Retry Failed Run"}
            </Button>
          ) : null}
        </div>
        {workload.failedWorkflowName ? (
          <p className="mt-2 text-[11px] text-muted-foreground">
            Last failed workflow: {workload.failedWorkflowName}
          </p>
        ) : null}
        {/* ── Heartbeat Execution Log ── */}
        <div className="mt-3 rounded-lg border border-border/60 p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Heartbeat Log</div>
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[10px]"
              disabled={heartbeatRunsLoading[role.agentId]}
              onClick={() => void loadHeartbeatRuns(role.agentId)}
            >
              {heartbeatRunsLoading[role.agentId] ? "Loading..." : "Refresh"}
            </Button>
          </div>
          {!heartbeatRunsMap[role.agentId] ? (
            <p className="mt-2 text-[11px] text-muted-foreground">Click Refresh to load heartbeat history.</p>
          ) : heartbeatRunsMap[role.agentId]!.length === 0 ? (
            <p className="mt-2 text-[11px] text-muted-foreground">No heartbeat runs recorded yet.</p>
          ) : (
            <div className="mt-2 space-y-1">
              {heartbeatRunsMap[role.agentId]!.slice(0, 10).map((run) => (
                <div key={run.id} className="flex flex-wrap items-center gap-2 rounded border border-border/50 px-2 py-1 text-[11px]">
                  <Badge
                    variant={run.status === "succeeded" ? "secondary" : run.status === "failed" ? "destructive" : "outline"}
                    className="text-[10px]"
                  >
                    {run.status}
                  </Badge>
                  <span className="font-mono text-muted-foreground">{new Date(run.startedAt).toLocaleString()}</span>
                  {run.finishedAt ? (
                    <span className="text-muted-foreground">
                      {Math.round((new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 1000)}s
                    </span>
                  ) : null}
                  {run.wakeupsProcessed > 0 ? (
                    <Badge variant="outline" className="text-[10px]">{run.wakeupsProcessed} wakeups</Badge>
                  ) : null}
                  {run.error ? (
                    <span className="text-terminal-red truncate max-w-[200px]" title={run.error}>{run.error}</span>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>
        {integrations?.open ? (
          <div className="mt-3 rounded-lg border border-dashed p-3">
            <div className="mb-2">
              <div className="text-xs font-medium">Agent Integrations</div>
              <p className="text-[11px] text-muted-foreground">
                Global lifecycle lives in Extensions. This panel attaches extension packs and skill packs directly to this agent, and the active organization snapshot keeps those choices.
              </p>
            </div>
            {integrations.loading ? (
              <p className="text-[11px] text-muted-foreground">Loading integrations...</p>
            ) : integrations.error ? (
              <p className="text-[11px] text-red-400">{integrations.error}</p>
            ) : (
              <div className="space-y-3">
                <div className="space-y-2">
                  <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Starter Presets</div>
                  {visiblePresets.length === 0 ? (
                    <p className="text-[11px] text-muted-foreground">No presets available.</p>
                  ) : (
                    <div className="space-y-2">
                      {visiblePresets.map((preset) => {
                        const recommended = preset.recommendedRoleTypes?.includes(role.roleType) ?? false;
                        return (
                          <div key={`${role.agentId}-${preset.id}`} className="flex items-start justify-between gap-3 rounded-md border px-3 py-2">
                            <div className="min-w-0 space-y-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="text-xs font-medium">{preset.name}</span>
                                <Badge variant="outline" className="text-[10px]">{preset.extensions.length} ext</Badge>
                                <Badge variant="outline" className="text-[10px]">{preset.skills.length} skills</Badge>
                                {recommended ? <Badge className="text-[10px]">recommended</Badge> : null}
                              </div>
                              <p className="text-[11px] text-muted-foreground">{preset.description}</p>
                            </div>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => void onApplyAgentPreset(role.agentId, preset.id)}
                              disabled={integrations.saving}
                            >
                              Apply
                            </Button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
                <div className="space-y-2">
                  <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Extension Packs</div>
                  {visibleExtensions.length === 0 ? (
                    <p className="text-[11px] text-muted-foreground">No extension packs available.</p>
                  ) : (
                    <div className="space-y-2">
                      {visibleExtensions.map((extension) => (
                        <div key={`${role.agentId}-${extension.id}`} className="flex items-start justify-between gap-3 rounded-md border px-3 py-2">
                          <div className="min-w-0 space-y-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-xs font-medium">{extension.name}</span>
                              <Badge variant="outline" className="text-[10px]">{extension.source}</Badge>
                              <Badge variant={extension.enabled ? "default" : "secondary"} className="text-[10px]">
                                {extension.enabled ? "enabled" : "disabled"}
                              </Badge>
                              {extension.globallyEnabled === false ? (
                                <Badge variant="outline" className="text-[10px]">global off</Badge>
                              ) : null}
                            </div>
                            <p className="text-[11px] text-muted-foreground">{extension.description}</p>
                          </div>
                          <Switch
                            checked={extension.enabled}
                            disabled={integrations.saving || extension.globallyEnabled === false}
                            onCheckedChange={(checked) => void onToggleAgentExtensionPack(role.agentId, extension.id, checked)}
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div className="space-y-2">
                  <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Skill Packs</div>
                  {visibleSkills.length === 0 ? (
                    <p className="text-[11px] text-muted-foreground">No skill packs available.</p>
                  ) : (
                    <div className="space-y-2">
                      {visibleSkills.map((skill) => (
                        <div key={`${role.agentId}-${skill.id}`} className="flex items-start justify-between gap-3 rounded-md border px-3 py-2">
                          <div className="min-w-0 space-y-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-xs font-medium">{skill.label}</span>
                              <Badge variant="outline" className="text-[10px]">{skill.source}</Badge>
                              <Badge variant={skill.enabled ? "default" : "secondary"} className="text-[10px]">
                                {skill.enabled ? "enabled" : "disabled"}
                              </Badge>
                              {skill.extensionId ? (
                                <Badge variant="secondary" className="text-[10px]">{skill.extensionId}</Badge>
                              ) : null}
                              {skill.globallyEnabled === false ? (
                                <Badge variant="outline" className="text-[10px]">global off</Badge>
                              ) : null}
                            </div>
                            <p className="text-[11px] text-muted-foreground">{skill.description}</p>
                          </div>
                          <Switch
                            checked={skill.enabled}
                            disabled={integrations.saving || skill.globallyEnabled === false}
                            onCheckedChange={(checked) => void onToggleAgentSkillPack(role.agentId, skill.id, checked)}
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        ) : null}
      </div>
    );
  };

  const renderGoalDrilldown = () => {
    if (goals.length === 0) {
      return (
        <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
          Create a goal to see linked board work, workflow activity, and data-source bindings here.
        </div>
      );
    }

    if (!selectedGoal) {
      return (
        <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
          Select a goal to inspect its hierarchy scope.
        </div>
      );
    }

    const goalScopeCount = selectedGoalScopeIds.size;
    const crewOps = crewOpsSummary;

    return (
      <div data-testid="hierarchy-goal-detail" className="rounded-xl border border-terminal-red/20 bg-background/70 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-base font-semibold">{selectedGoal.name}</div>
              <Badge variant="secondary" className="text-[10px] font-mono uppercase tracking-wide">
                {selectedGoal.organizationName || "Unscoped"}
              </Badge>
              {selectedGoal.parentGoalName ? (
                <Badge variant="outline" className="text-[10px]">
                  child goal
                </Badge>
              ) : null}
              {goalScopeCount > 1 ? (
                <Badge variant="outline" className="text-[10px]">
                  includes {goalScopeCount - 1} child goal{goalScopeCount - 1 === 1 ? "" : "s"}
                </Badge>
              ) : null}
            </div>
            {selectedGoal.description ? (
              <p className="max-w-3xl text-sm text-muted-foreground">{selectedGoal.description}</p>
            ) : (
              <p className="text-sm text-muted-foreground">No goal description yet.</p>
            )}
          </div>
          <div className="text-right text-[11px] text-muted-foreground">
            <div>Created {new Date(selectedGoal.createdAt).toLocaleString()}</div>
            <div>Updated {new Date(selectedGoal.updatedAt).toLocaleString()}</div>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {selectedGoalAncestry.map((goal, index) => (
            <Badge
              key={`goal-ancestry-${goal.id}`}
              variant={index === selectedGoalAncestry.length - 1 ? "secondary" : "outline"}
              className="text-[10px]"
            >
              {goal.name}
            </Badge>
          ))}
        </div>

        <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
          {[
            { label: "Scoped Goals", value: goalScopeCount },
            { label: "Board Tasks", value: scopedGoalTasks.length },
            { label: "Open Tasks", value: scopedGoalOpenTasks.length },
            { label: "Workflows", value: scopedGoalWorkflows.length },
            { label: "Running", value: scopedGoalRunning.length },
          ].map((item) => (
            <div key={`${selectedGoal.id}-${item.label}`} className="rounded-lg border border-border bg-card p-3">
              <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">{item.label}</div>
              <div className="mt-1 text-lg font-semibold tabular-nums">{item.value}</div>
            </div>
          ))}
        </div>

        {isAdvancedView ? (
          <CrewOpsDynamic
            crewOps={crewOps}
            crewOpsLoading={crewOpsLoading}
            goalId={selectedGoal.id}
            scopedGoalTasks={scopedGoalTasks}
          />
        ) : (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card/60 px-3 py-2">
            <span className="text-[11px] text-muted-foreground">
              Crew diagnostics, wakeups, runtime queues, and cost details are in Ops mode.
            </span>
            <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => setViewMode("advanced")}>
              Open Ops
            </Button>
          </div>
        )}

        <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="space-y-3 rounded-lg border border-border p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Linked Board Work
              </div>
              <Badge variant="outline" className="text-[10px]">
                {scopedGoalTasks.length} task{scopedGoalTasks.length === 1 ? "" : "s"}
              </Badge>
            </div>
            {scopedGoalTasks.length === 0 ? (
              <p className="text-xs text-muted-foreground">No board tasks are currently linked to this goal scope.</p>
            ) : (
              <div className="space-y-2">
                {scopedGoalTasks.slice(0, 6).map((task) => {
                  const linkedSource = formatLinkedSource(task.sourceType, task.sourceRef);
                  return (
                    <div key={task.id} className="rounded-md border border-border/70 px-3 py-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="text-sm font-medium">{task.title}</div>
                        <Badge variant="secondary" className="text-[10px]">
                          {TASK_STATUS_LABELS[task.status]}
                        </Badge>
                        {task.boardName ? (
                          <Badge variant="outline" className="text-[10px]">
                            {task.boardName}
                          </Badge>
                        ) : null}
                        {linkedSource ? (
                          <Badge variant="outline" className="text-[10px]">
                            {linkedSource}
                          </Badge>
                        ) : null}
                        {task.linkedDocumentIds.length > 0 ? (
                          <Badge variant="outline" className="text-[10px]">
                            {task.linkedDocumentIds.length} doc{task.linkedDocumentIds.length === 1 ? "" : "s"}
                          </Badge>
                        ) : null}
                        {task.deliverables.length > 0 ? (
                          <Badge variant="outline" className="text-[10px]">
                            {task.deliverables.length} deliverable{task.deliverables.length === 1 ? "" : "s"}
                          </Badge>
                        ) : null}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                        <span>Goal: {task.goalName || selectedGoal.name}</span>
                        {task.assignedAgentName ? <span>Assigned: {task.assignedAgentName}</span> : null}
                        {task.checkedOutByAgentName ? <span>Checked out: {task.checkedOutByAgentName}</span> : null}
                        {task.workflowTemplateKey ? <span>Template: {task.workflowTemplateKey}</span> : null}
                        {task.workflowId ? <span>Workflow: {task.workflowId}</span> : null}
                      </div>
                      {task.deliverables.length > 0 ? (
                        <div className="mt-2 flex flex-wrap gap-2">
                          {task.deliverables.slice(0, 3).map((deliverable) => (
                            <Badge key={`${task.id}-${deliverable}`} variant="secondary" className="text-[10px]">
                              {deliverable}
                            </Badge>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="space-y-3 rounded-lg border border-border p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Linked Automation
              </div>
              <Badge variant={scopedGoalFailedWorkflows.length > 0 ? "destructive" : "outline"} className="text-[10px]">
                {scopedGoalFailedWorkflows.length} failed
              </Badge>
            </div>
            {scopedGoalWorkflows.length === 0 ? (
              <p className="text-xs text-muted-foreground">No workflows are currently scoped to this goal.</p>
            ) : (
              <div className="space-y-2">
                {scopedGoalWorkflows.slice(0, 6).map((workflow) => {
                  const linkedSource = formatLinkedSource(workflow.sourceType, workflow.sourceRef);
                  return (
                    <div key={workflow.id} className="rounded-md border border-border/70 px-3 py-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="text-sm font-medium">{workflow.name}</div>
                        <Badge variant={workflow.isActive ? "secondary" : "outline"} className="text-[10px]">
                          {workflow.isActive ? "active" : "paused"}
                        </Badge>
                        {workflow.lastExecution?.status ? (
                          <Badge
                            variant={workflow.lastExecution.status === "failed" ? "destructive" : "outline"}
                            className="text-[10px]"
                          >
                            {workflow.lastExecution.status}
                          </Badge>
                        ) : null}
                        {linkedSource ? (
                          <Badge variant="outline" className="text-[10px]">
                            {linkedSource}
                          </Badge>
                        ) : null}
                      </div>
                      <div className="mt-1 text-[11px] text-muted-foreground">
                        {workflow.description ? <div>{workflow.description}</div> : null}
                        <div>
                          Last run:{" "}
                          {workflow.lastExecution?.startedAt
                            ? `${new Date(workflow.lastExecution.startedAt).toLocaleString()} (${workflow.lastExecution.triggerType})`
                            : "never"}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div className="mt-4 grid gap-4 xl:grid-cols-2 2xl:grid-cols-4">
          <div className="rounded-lg border border-border p-3">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Direct Child Goals</div>
            <div className="mt-2 flex flex-wrap gap-2">
              {selectedGoalChildGoals.length === 0 ? (
                <span className="text-xs text-muted-foreground">No direct child goals.</span>
              ) : (
                selectedGoalChildGoals.map((goal) => (
                  <button
                    key={`goal-child-${goal.id}`}
                    type="button"
                    className="rounded border border-border px-2 py-1 text-left text-[11px] hover:border-terminal-red"
                    onClick={() => { setSelectedGoalId(goal.id); setGoalSelectedByUserThisSession(true); setGoalDrawerOpen(true); }}
                  >
                    {goal.name}
                  </button>
                ))
              )}
            </div>
          </div>

          <div className="rounded-lg border border-border p-3">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Boards And Owners</div>
            <div className="mt-2 flex flex-wrap gap-2">
              {scopedGoalBoards.map((boardName) => (
                <Badge key={`${selectedGoal.id}-board-${boardName}`} variant="outline" className="text-[10px]">
                  {boardName}
                </Badge>
              ))}
              {scopedGoalBoards.length === 0 ? <span className="text-xs text-muted-foreground">No boards yet.</span> : null}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {scopedGoalOwners.map((owner) => (
                <Badge key={`${selectedGoal.id}-owner-${owner}`} variant="secondary" className="text-[10px]">
                  {owner}
                </Badge>
              ))}
              {scopedGoalOwners.length === 0 ? <span className="text-xs text-muted-foreground">No active assignees yet.</span> : null}
            </div>
          </div>

          <div className="rounded-lg border border-border p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Goal Deliverables</div>
              <Badge variant="outline" className="text-[10px]">
                {selectedGoalDeliverables.length}
              </Badge>
            </div>
            {selectedGoalDeliverables.length === 0 ? (
              <div className="mt-2 text-xs text-muted-foreground">No goal deliverables attached yet.</div>
            ) : (
              <div className="mt-2 flex flex-wrap gap-2">
                {selectedGoalDeliverables.map((deliverable) => (
                  <Badge key={`${selectedGoal.id}-deliverable-${deliverable}`} variant="secondary" className="text-[10px]">
                    {deliverable}
                  </Badge>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-lg border border-border p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Goal Attachments</div>
              <Badge variant="outline" className="text-[10px]">
                {selectedGoalLinkedDocuments.length}
              </Badge>
            </div>
            {selectedGoalLinkedDocuments.length === 0 ? (
              <div className="mt-2 text-xs text-muted-foreground">No goal-level documents attached yet.</div>
            ) : (
              <div className="mt-2 space-y-2">
                {selectedGoalLinkedDocuments.slice(0, 4).map((document) => (
                  <div key={`${selectedGoal.id}-attachment-${document.id}`} className="rounded-md border border-border/70 px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">{document.name}</div>
                        <div className="mt-1 text-[11px] text-muted-foreground">
                          {document.sourceUrl || document.id}
                        </div>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 text-[10px]"
                        onClick={() => router.push(`/documents?documentId=${encodeURIComponent(document.id)}`)}
                      >
                        Open
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <SourcePacksDynamic
            scopedGoalSourcePack={scopedGoalSourcePack}
            scopedGoalLinkedSources={scopedGoalLinkedSources}
            goalId={selectedGoal.id}
            goalName={selectedGoal.name}
            organizationId={selectedGoal.organizationId}
          />
        </div>

        {/* ── Goal Cost Attribution ── */}
        <div className="mt-4 rounded-lg border border-border p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Goal Spend Attribution</div>
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[10px]"
              onClick={() => void loadGoalSpend(selectedGoal.id)}
            >
              {goalSpendMap[selectedGoal.id] ? "Refresh" : "Load Spend"}
            </Button>
          </div>
          {!goalSpendMap[selectedGoal.id] ? (
            <p className="mt-2 text-[11px] text-muted-foreground">Click Load Spend to see cost attribution for this goal.</p>
          ) : (
            <div className="mt-2 space-y-2">
              <div className="grid grid-cols-3 gap-2">
                <div className="rounded border border-border/60 p-2 text-center">
                  <div className="text-base font-mono font-semibold">${goalSpendMap[selectedGoal.id]!.totalCostUsd.toFixed(4)}</div>
                  <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Total Cost</div>
                </div>
                <div className="rounded border border-border/60 p-2 text-center">
                  <div className="text-base font-mono font-semibold">{goalSpendMap[selectedGoal.id]!.totalTokens.toLocaleString()}</div>
                  <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Tokens</div>
                </div>
                <div className="rounded border border-border/60 p-2 text-center">
                  <div className="text-base font-mono font-semibold">{goalSpendMap[selectedGoal.id]!.eventCount}</div>
                  <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Events</div>
                </div>
              </div>
              {goalSpendMap[selectedGoal.id]!.agentBreakdown.length > 0 ? (
                <div className="space-y-1">
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">By Agent</div>
                  {goalSpendMap[selectedGoal.id]!.agentBreakdown.map((row) => {
                    const agentName = roles.find((r) => r.agentId === row.agentId)?.agentName ?? row.agentId;
                    return (
                      <div key={row.agentId} className="flex items-center justify-between gap-2 rounded border border-border/40 px-2 py-1 text-[11px]">
                        <span className="font-medium truncate">{agentName}</span>
                        <div className="flex items-center gap-2 shrink-0">
                          <Badge variant="outline" className="text-[10px]">{row.calls} calls</Badge>
                          <span className="font-mono">${row.costUsd.toFixed(4)}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-[11px] text-muted-foreground">No spend events linked to this goal yet. Workflows must be assigned to this goal for attribution.</p>
              )}
              {goalSpendMap[selectedGoal.id]!.lastSpendAt ? (
                <div className="text-[10px] text-muted-foreground">Last spend: {new Date(goalSpendMap[selectedGoal.id]!.lastSpendAt!).toLocaleString()}</div>
              ) : null}
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderActivityRollup = () => {
    const title = selectedGoal ? "Goal Activity Rollup" : "Organization Activity Rollup";
    const subtitle = selectedGoal
      ? `Recent task, workflow, and telemetry activity for ${selectedGoal.name}.`
      : "Recent task, workflow, and telemetry activity for the active organization.";

    return (
      <div data-testid="hierarchy-activity-rollup" className="rounded-xl border border-border bg-background/70 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-base font-semibold">{title}</div>
            <p className="text-xs text-muted-foreground">{subtitle}</p>
          </div>
          <Badge variant="outline" className="text-[10px]">
            {hierarchyActivityRollup.length} recent
          </Badge>
        </div>
        {hierarchyActivityRollup.length === 0 ? (
          <div className="mt-3 rounded-lg border border-dashed border-border p-3 text-sm text-muted-foreground">
            No scoped activity yet. Run a workflow, update a task, or wait for new telemetry.
          </div>
        ) : (
          <div className="mt-3 space-y-2">
            {hierarchyActivityRollup.map((item) => (
              <div key={item.key} className="rounded-lg border border-border/70 px-3 py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-sm font-medium">{item.label}</div>
                  <div className="text-[11px] text-muted-foreground">{new Date(item.ts).toLocaleString()}</div>
                </div>
                <div className="mt-1 text-sm">{item.detail}</div>
                {item.meta ? <div className="mt-1 text-[11px] text-muted-foreground">{item.meta}</div> : null}
              </div>
            ))}
              </div>
            )}
      </div>
    );
  };

  /* ── expanded detail panel for a selected tree node ── */
  const expandedRole = useMemo(
    () => (expandedNodeId ? roles.find((r) => r.agentId === expandedNodeId) ?? null : null),
    [expandedNodeId, roles],
  );

  return (
        <main className="flex-1 overflow-auto p-6 grid-bg">
          <SurfaceHeader
            className="mb-5"
            title="Hierarchy"
            subtitle="Agent topology, governance, workload, and goal ownership in one org map."
            statusItems={[
              { label: "Agents", value: roles.length, tone: roles.length > 0 ? "ok" : "warn" },
              { label: "Goals", value: goals.length },
              { label: "Orgs", value: organizations.length },
            ]}
            secondaryActions={(
              <>
                <div className="flex overflow-hidden rounded-md border border-border" role="group" aria-label="Hierarchy view mode">
                  <Button
                    variant={!isAdvancedView ? "secondary" : "ghost"}
                    size="sm"
                    className="h-8 rounded-none border-0"
                    aria-pressed={!isAdvancedView}
                    onClick={() => setViewMode("simple")}
                    title="Map view — calm org overview"
                  >
                    Map
                  </Button>
                  <Button
                    variant={isAdvancedView ? "secondary" : "ghost"}
                    size="sm"
                    className="h-8 rounded-none border-0"
                    aria-pressed={isAdvancedView}
                    onClick={() => setViewMode("advanced")}
                    title="Ops view — full power controls"
                  >
                    Ops
                  </Button>
                </div>
                {(showHierarchySetupGuide || isAdvancedView) && (
                  <Button variant="outline" size="sm" onClick={() => setHideGettingStarted((current) => !current)}>
                    {hideGettingStarted ? "Show Tips" : "Hide Tips"}
                  </Button>
                )}
                <Button variant="outline" size="sm" onClick={() => setResearchTeamsOpen(true)}>
                  Research Team
                </Button>
                {isAdvancedView && (
                  <Button variant="outline" size="sm" onClick={() => void openTeamPreset()} disabled={!activeOrganizationId}>
                    Team Preset
                  </Button>
                )}
                <Badge variant="secondary" className="font-mono text-[10px] uppercase tracking-wider">
                  {activeOrganization?.name || "No org"}
                </Badge>
              </>
            )}
          />

          <Sheet open={researchTeamsOpen} onOpenChange={handleResearchTeamsOpenChange}>
            <SheetContent widthClassName="w-full sm:max-w-3xl" onOpenAutoFocus={(event) => event.preventDefault()}>
              <SheetHeader>
                <SheetTitle>Research Team</SheetTitle>
                <SheetDescription>
                  A guided team template that creates ordinary agents, workflows, schedules, and a local markdown vault.
                </SheetDescription>
              </SheetHeader>
              <SheetBody>
                <ResearchTeamPanelDynamic
                  embedded
                  onDepartmentChange={() => {
                    invalidateCache(/^(agents|workflows|cron|execute)/);
                    void loadRoles();
                  }}
                />
              </SheetBody>
            </SheetContent>
          </Sheet>

          <Sheet open={teamPresetOpen} onOpenChange={setTeamPresetOpen}>
            <SheetContent widthClassName="w-full sm:max-w-xl" onOpenAutoFocus={(event) => event.preventDefault()}>
              <SheetHeader>
                <SheetTitle>Team Capability Preset</SheetTitle>
                <SheetDescription>
                  Merge an approved skills-and-extensions preset into every current member of {activeOrganization?.name || "this organization"}. Existing capabilities are kept.
                </SheetDescription>
              </SheetHeader>
              <SheetBody className="space-y-4">
                {teamPresetLoading ? (
                  <p className="text-sm text-muted-foreground">Loading approved presets...</p>
                ) : teamPresetOptions.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No capability presets are available.</p>
                ) : (
                  <>
                    <div className="space-y-2">
                      <Label htmlFor="team-capability-preset">Preset</Label>
                      <select
                        id="team-capability-preset"
                        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                        value={selectedTeamPresetId}
                        onChange={(event) => setSelectedTeamPresetId(event.target.value)}
                        disabled={teamPresetApplying}
                      >
                        {teamPresetOptions.map((preset) => (
                          <option key={preset.id} value={preset.id}>{preset.name}</option>
                        ))}
                      </select>
                      {teamPresetOptions.find((preset) => preset.id === selectedTeamPresetId) ? (
                        <p className="text-xs text-muted-foreground">
                          {teamPresetOptions.find((preset) => preset.id === selectedTeamPresetId)?.description}
                        </p>
                      ) : null}
                    </div>
                    <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-muted-foreground">
                      This adds the preset to current members only. Globally disabled extensions block the operation before any member is changed.
                    </div>
                    <Button onClick={() => void applyTeamPreset()} disabled={!selectedTeamPresetId || teamPresetApplying}>
                      {teamPresetApplying ? "Applying..." : "Apply to Current Team"}
                    </Button>
                  </>
                )}
                {teamPresetStatus ? <p className="text-sm text-muted-foreground" role="status">{teamPresetStatus}</p> : null}
              </SheetBody>
            </SheetContent>
          </Sheet>

          {/* ── Org health strip (compact, 4 metrics + actionable chips) ── */}
          {activeOrganizationId && (
            <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-border bg-background/70 px-4 py-2.5 text-xs">
              <span className="font-mono uppercase tracking-wider text-muted-foreground">Health</span>
              <span><span className="font-semibold">{mapHealth.agents}</span> agent{mapHealth.agents === 1 ? "" : "s"}</span>
              <span className="text-muted-foreground">·</span>
              <span><span className="font-semibold">{mapHealth.activeWork}</span> active work</span>
              <span className="text-muted-foreground">·</span>
              <span className={mapHealth.blocked > 0 ? "text-terminal-red" : ""}><span className="font-semibold">{mapHealth.blocked}</span> blocked</span>
              <span className="text-muted-foreground">·</span>
              <span>Budget <span className={mapHealth.budgetOk ? "text-green-400" : "text-yellow-400"}>{mapHealth.budgetOk ? "OK" : "near cap"}</span></span>
              {integrityIssues.slice(0, 3).map((issue) => (
                <button
                  key={issue.key}
                  type="button"
                  onClick={() => setViewMode("advanced")}
                  className="rounded-full border border-yellow-500/40 bg-yellow-500/10 px-2 py-0.5 text-[10px] text-yellow-300 hover:bg-yellow-500/20"
                  title="Open Ops mode to resolve"
                >
                  {issue.label}
                </button>
              ))}
            </div>
          )}

          {!isAdvancedView && activeOrganizationId && (
            <div className="mb-4 rounded-xl border border-border bg-background/70 px-4 py-3 text-xs">
              {nextActionLoading ? (
                <div className="flex flex-wrap items-center gap-3 text-muted-foreground">
                  <span className="font-mono uppercase tracking-wider">Next best move</span>
                  <span>Reading current org state...</span>
                </div>
              ) : nextAction ? (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <span className="font-mono uppercase tracking-wider text-terminal-red">Next best move</span>
                  <Badge variant={nextAction.recommendation.source === "model" ? "default" : "secondary"} className="text-[10px]">
                    {nextAction.recommendation.source === "model" ? "model" : "evidence"}
                  </Badge>
                  <span className="min-w-[180px] flex-1 font-medium">{nextAction.recommendation.title}</span>
                  <span className="max-w-xl text-muted-foreground">{nextAction.recommendation.reason}</span>
                  <div className="flex flex-wrap gap-1">
                    {nextAction.recommendation.evidence.slice(0, 3).map((item) => (
                      <Badge key={item} variant="outline" className="max-w-[220px] truncate text-[10px]">
                        {item}
                      </Badge>
                    ))}
                  </div>
                  <div className="ml-auto flex items-center gap-2">
                    <span className="text-[10px] text-muted-foreground">{Math.round(nextAction.recommendation.confidence * 100)}%</span>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-[11px]"
                      onClick={() => void loadNextAction(activeOrganizationId || undefined, selectedGoalId || undefined)}
                    >
                      Refresh
                    </Button>
                    <Button
                      size="sm"
                      className="h-7 px-2 text-[11px]"
                      onClick={() => openWebChatWithPrompt(nextAction.recommendation.prompt)}
                    >
                      Review plan
                    </Button>
                  </div>
                </div>
              ) : nextActionError ? (
                <div className="flex flex-wrap items-center gap-3 text-muted-foreground">
                  <span className="font-mono uppercase tracking-wider">Next best move</span>
                  <span>Unavailable right now.</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-[11px]"
                    onClick={() => void loadNextAction(activeOrganizationId || undefined, selectedGoalId || undefined)}
                  >
                    Retry
                  </Button>
                </div>
              ) : null}
            </div>
          )}

          {/* ── Map mode: compact Goal Runs strip (full panel lives in Ops) ── */}
          {!isAdvancedView && activeOrganizationId && (() => {
            const running = goalRunDashboard.filter((g) => g.status === "active").length;
            const blockedGoals = goalRunDashboard.reduce((sum, g) => sum + (g.taskSummary?.blocked ?? 0), 0);
            const latest = goalRunDashboard.flatMap((g) => g.runs).sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")))[0];
            return (
              <button
                type="button"
                onClick={() => { if (goalFocus) { setGoalDrawerOpen(true); } else { setViewMode("advanced"); } }}
                className="mb-4 flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-border bg-background/70 px-4 py-2.5 text-left text-xs hover:border-terminal-red/40"
                title="Open goal runs"
              >
                <span className="font-mono uppercase tracking-wider text-muted-foreground">Goal Runs</span>
                <span><span className="font-semibold">{goals.length}</span> goals</span>
                <span className="text-muted-foreground">·</span>
                <span><span className="font-semibold">{running}</span> running</span>
                <span className="text-muted-foreground">·</span>
                <span className={blockedGoals > 0 ? "text-terminal-red" : ""}><span className="font-semibold">{blockedGoals}</span> blocked</span>
                <span className="text-muted-foreground">·</span>
                <span className="text-muted-foreground">Last run {latest ? latest.status : "none"}</span>
                <span className="ml-auto text-[10px] text-muted-foreground">{goalFocus ? "Open goal →" : "Open Ops →"}</span>
              </button>
            );
          })()}

          {isAdvancedView && (
            <div className="mb-5 rounded-xl border border-border bg-background/70 p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-semibold">Goal Runs</div>
                  <p className="text-xs text-muted-foreground">Standing-goal ledgers, judge verdicts, continuations, and blockers.</p>
                </div>
                <Button variant="outline" size="sm" onClick={() => void loadGoalRuns()}>Refresh</Button>
              </div>
              {goalRunDashboard.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border p-3 text-sm text-muted-foreground">
                  No goal-run ledger entries yet.
                </div>
              ) : (
                <div className="grid gap-3 lg:grid-cols-2">
                  {goalRunDashboard.slice(0, 6).map((goal) => {
                    const latestRun = goal.runs[0];
                    const latestJudgment = goal.judgments[0];
                    return (
                      <div key={goal.id} className="rounded-lg border border-border/70 px-3 py-3 text-sm">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="truncate font-medium">{goal.name}</div>
                            <div className="mt-1 flex flex-wrap gap-1 text-xs">
                              <Badge variant="secondary">{goal.status}</Badge>
                              <Badge variant="outline">ready {goal.taskSummary.ready}</Badge>
                              <Badge variant="outline">review {goal.taskSummary.review}</Badge>
                              <Badge variant="outline">blocked {goal.taskSummary.blocked}</Badge>
                              <Badge variant="outline">done {goal.taskSummary.done}/{goal.taskSummary.total}</Badge>
                            </div>
                          </div>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 px-2 text-[11px]"
                            onClick={async () => {
                              await fetch("/api/goals", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ action: goal.status === "active" ? "pause" : "resume", id: goal.id }),
                              });
                              await loadGoalRuns();
                              await loadGoals(activeOrganizationId || undefined);
                            }}
                          >
                            {goal.status === "active" ? "Pause" : "Resume"}
                          </Button>
                        </div>
                        <div className="mt-2 text-xs text-muted-foreground">
                          latest run: {latestRun ? `${latestRun.status}${latestRun.lastVerdict ? ` / ${latestRun.lastVerdict}` : ""}` : "none"}
                        </div>
                        {latestJudgment ? (
                          <div className="mt-1 text-xs text-muted-foreground">
                            judge: {latestJudgment.verdict} - {latestJudgment.reason}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Inline restore tips chip when banner dismissed during setup */}
          {showHierarchySetupGuide && hideGettingStarted && (
            <div className="mb-3 flex items-center justify-between gap-2 border border-border/60 bg-card/40 px-3 py-2">
              <span className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
                {organizations.length === 0 ? "No organization yet. Tips hidden." : "Hierarchy setup tips hidden."}
              </span>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-[11px]"
                onClick={() => setHideGettingStarted(false)}
              >
                Restore Tips
              </Button>
            </div>
          )}

          {/* ── Getting Started banner for first-run or incomplete hierarchy setup ── */}
          {showHierarchySetupGuide && !hideGettingStarted && (
            <GettingStartedDynamic
              mode={organizations.length === 0 ? "new" : "continue"}
              globalModelLabel={activeGlobalModelLabel}
              onDismiss={() => setHideGettingStarted(true)}
            />
          )}

          {/* Recommended Next Step strip — shown when an active org is missing goals / tasks / workflows */}
          {activeOrganizationId && isAdvancedView && (() => {
            const scopedGoalCount = goals.filter((goal) => goal.organizationId === activeOrganizationId).length;
            const scopedTaskCount = runtimeSnapshot.tasks.filter((task) => task.organizationId === activeOrganizationId).length;
            const scopedWorkflowCount = runtimeSnapshot.workflows.filter((workflow) => workflow.organizationId === activeOrganizationId).length;
            const nextSteps: Array<{ key: string; label: string; action: () => void }> = [];
            if (scopedGoalCount === 0) {
              nextSteps.push({
                key: "create-goal",
                label: "Create first goal",
                action: () => goalsSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }),
              });
            }
            if (scopedTaskCount === 0) {
              nextSteps.push({
                key: "add-tasks",
                label: "Assign tasks",
                action: () => openHierarchyDraftInWebChat("execute"),
              });
            }
            if (scopedWorkflowCount === 0) {
              nextSteps.push({
                key: "create-workflow",
                label: "Create workflow",
                action: () => openHierarchyDraftInWebChat("workflow"),
              });
            }
            if (scopedGoalCount > 0) {
              nextSteps.push({
                key: "ask-org",
                label: "Ask org in WebChat",
                action: () => openHierarchyDraftInWebChat("execute"),
              });
            }
            if (nextSteps.length === 0) return null;
            const visibleSteps = isAdvancedView ? nextSteps.slice(0, 4) : nextSteps.slice(0, 1);
            const showWebChatCta = !isAdvancedView && !visibleSteps.some((step) => step.key === "ask-org");
            return (
              <div className="mb-3 flex flex-wrap items-center gap-2 border border-border bg-card/50 px-3 py-2">
                <span className="text-[10px] font-mono uppercase tracking-widest text-terminal-red">
                  NEXT STEP
                </span>
                {visibleSteps.map((step) => (
                  <Button
                    key={step.key}
                    size="sm"
                    variant="outline"
                    className="h-7 text-[11px]"
                    onClick={step.action}
                  >
                    {step.label}
                  </Button>
                ))}
                {showWebChatCta ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-[11px]"
                    onClick={() => openHierarchyDraftInWebChat(scopedGoalCount === 0 ? "setup" : "execute")}
                  >
                    Ask org in WebChat
                  </Button>
                ) : null}
              </div>
            );
          })()}

          {/* ── Compact org summary (stats + composition folded into one strip) ── */}
          <div data-perf-ready="hierarchy">
          <OrgStatsDynamic
            orgHealth={orgHealth}
            workloadSummary={workloadSummary}
            collapsed={collapsedSections.stats}
            onToggle={() => toggleSection("stats")}
            roleSummary={roleSummary}
          />
          </div>

          {/* H4: Skills / Capabilities Coverage Matrix */}
          {isAdvancedView && roles.length > 0 && (() => {
            const uniqueCaps = capabilityCoverage.visibleCapabilities;
            if (uniqueCaps.length === 0) return null;
            return (
              <div className="mb-4 border border-border bg-card p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">SKILLS COVERAGE</span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-[10px]">
                    <thead>
                      <tr>
                        <th className="text-left font-mono text-muted-foreground pr-3 pb-1">Agent</th>
                        {uniqueCaps.map((cap) => (
                          <th key={cap} className="text-center font-mono text-muted-foreground pb-1 px-1 max-w-[60px] truncate" title={cap}>{cap.slice(0, 8)}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {roles.slice(0, 8).map((role) => (
                        <tr key={role.agentId} className="border-t border-border/30">
                          <td className="font-mono pr-3 py-0.5 truncate max-w-[120px]" title={role.agentName}>{role.agentName.slice(0, 14)}</td>
                          {uniqueCaps.map((cap) => (
                            <td key={cap} className="text-center py-0.5">
                              {role.capabilities.includes(cap) ? <span className="text-green-400">✓</span> : <span className="text-muted-foreground/30">·</span>}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {capabilityCoverage.missingCapabilities.length > 0 && (
                  <p className="mt-2 text-[10px] text-yellow-400/80">
                    Gaps: {capabilityCoverage.missingCapabilities.slice(0, 4).join(", ")}
                    {capabilityCoverage.missingCapabilities.length > 4 ? ` +${capabilityCoverage.missingCapabilities.length - 4} more` : ""}
                  </p>
                )}
              </div>
            );
          })()}

          {goalFocus ? (
          <Sheet open={goalDrawerOpen} onOpenChange={setGoalDrawerOpen}>
            <SheetContent widthClassName="w-full sm:max-w-2xl" onOpenAutoFocus={(e) => e.preventDefault()}>
              <SheetHeader>
                <SheetTitle>Goal · {goalFocus.name}</SheetTitle>
                <SheetDescription>Status, work, sources, runs, and activity for this goal.</SheetDescription>
              </SheetHeader>
              <SheetBody>
            <RelatedWorkTrailStrip
              className="mb-3"
              surface="goals"
              objectType="goal"
              objectId={goalFocus.id}
              objectName={goalFocus.name}
            />
            <div className="border border-terminal-red/30 bg-card p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                    Goal Focus
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Keep the selected goal visible while you inspect the org.
                  </p>
                </div>
                {/* Primary actions first; secondary nav grouped after a subtle separator */}
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="border-terminal-red/40 text-terminal-red hover:bg-terminal-red/10"
                    onClick={() => {
                      if (discussionOpen) {
                        setDiscussionOpen(false);
                      } else {
                        openGoalDiscussion();
                      }
                    }}
                  >
                    {discussionOpen ? "Close Ask Agents" : "Ask Agents"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => openHierarchyDraftInWebChat("execute")}
                  >
                    Ask WebChat
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setAssignAllTitle(`Work on: ${goalFocus.name}`);
                      setAssignAllDesc("");
                      setAssignAllPriority("medium");
                      setAssignAllResult(null);
                      setAssignAllOpen((v) => !v);
                    }}
                  >
                    {assignAllOpen ? "Cancel" : "Assign to All Agents"}
                  </Button>
                  {isAdvancedView ? (
                    <>
                      <span className="h-5 w-px bg-border/60" aria-hidden />
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          const params = new URLSearchParams();
                          params.set("topic", `What should the team decide next for goal: ${goalFocus.name}?`);
                          if (goalFocus.organizationId ?? activeOrganizationId) params.set("org", goalFocus.organizationId ?? activeOrganizationId);
                          if (goalFocus.id) params.set("goal", goalFocus.id);
                          router.push(`/council?${params.toString()}`);
                        }}
                      >
                        Council
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          const params = new URLSearchParams();
                          if (goalFocus.organizationId ?? activeOrganizationId) params.set("org", goalFocus.organizationId ?? activeOrganizationId);
                          if (goalFocus.id) params.set("goal", goalFocus.id);
                          router.push(`/boards?${params.toString()}`);
                        }}
                      >
                        Boards
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          const params = new URLSearchParams();
                          if (goalFocus.organizationId ?? activeOrganizationId) params.set("org", goalFocus.organizationId ?? activeOrganizationId);
                          if (goalFocus.id) params.set("goal", goalFocus.id);
                          router.push(`/workflows?${params.toString()}`);
                        }}
                      >
                        Workflows
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => router.push(`/hierarchy/goal/${goalFocus.id}`)}
                      >
                        Detail
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => goalsSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}>
                        Goals Panel
                      </Button>
                    </>
                  ) : null}
                </div>
              </div>
              {discussionOpen && (
                <div className="mb-4 rounded-lg border border-terminal-red/30 bg-terminal-red/5 p-4 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="text-[10px] font-mono uppercase tracking-widest text-terminal-red">
                        Goal Discussion
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Starts a Council-backed two-agent debate and saves the transcript against this org/goal.
                      </p>
                    </div>
                    <Button size="sm" variant="ghost" onClick={() => setDiscussionOpen(false)}>
                      Close
                    </Button>
                  </div>
                  <Textarea
                    rows={3}
                    value={discussionTopic}
                    onChange={(event) => setDiscussionTopic(event.target.value)}
                    placeholder="What should the agents discuss?"
                  />
                  <div className="grid gap-2 md:grid-cols-[1fr_1fr_auto]">
                    <select
                      className="h-9 rounded border border-border bg-background px-2 text-sm"
                      value={discussionAgentA}
                      onChange={(event) => setDiscussionAgentA(event.target.value)}
                    >
                      <option value="">First agent</option>
                      {roles.filter((role) => role.agentActive).map((role) => (
                        <option key={`discussion-a-${role.agentId}`} value={role.agentId}>
                          {role.agentName} · {ROLE_TYPE_LABELS[role.roleType] || role.roleType}
                        </option>
                      ))}
                    </select>
                    <select
                      className="h-9 rounded border border-border bg-background px-2 text-sm"
                      value={discussionAgentB}
                      onChange={(event) => setDiscussionAgentB(event.target.value)}
                    >
                      <option value="">Second agent</option>
                      {roles.filter((role) => role.agentActive).map((role) => (
                        <option key={`discussion-b-${role.agentId}`} value={role.agentId}>
                          {role.agentName} · {ROLE_TYPE_LABELS[role.roleType] || role.roleType}
                        </option>
                      ))}
                    </select>
                    <Button
                      size="sm"
                      disabled={discussionRunning || !discussionTopic.trim() || !discussionAgentA || !discussionAgentB || discussionAgentA === discussionAgentB}
                      onClick={() => void startGoalDiscussion()}
                    >
                      {discussionRunning ? "Running..." : "Start Debate"}
                    </Button>
                  </div>
                  {discussionError ? (
                    <p className="text-xs text-terminal-red">{discussionError}</p>
                  ) : null}
                  {discussionResult ? (
                    <div className="space-y-2 rounded-md border border-border/70 bg-background/70 p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="secondary" className="text-[10px]">
                          {discussionResult.sessionId}
                        </Badge>
                        {typeof discussionResult.totalCostUsd === "number" ? (
                          <Badge variant="outline" className="text-[10px]">
                            ${discussionResult.totalCostUsd.toFixed(4)}
                          </Badge>
                        ) : null}
                      </div>
                      {discussionResult.conclusion ? (
                        <p className="text-xs text-muted-foreground line-clamp-4">{discussionResult.conclusion}</p>
                      ) : null}
                      {isAdvancedView ? (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-[11px]"
                          onClick={() => {
                            const params = new URLSearchParams();
                            if (goalFocus.organizationId ?? activeOrganizationId) params.set("org", goalFocus.organizationId ?? activeOrganizationId);
                            params.set("goal", goalFocus.id);
                            router.push(`/council?${params.toString()}`);
                          }}
                        >
                          Council
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              )}
              {assignAllOpen && (
                <div className="mb-4 rounded-lg border border-terminal-red/30 bg-terminal-red/5 p-4 space-y-3">
                  <div className="text-[10px] font-mono uppercase tracking-widest text-terminal-red">
                    Assign Goal to All Active Org Members
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Creates one task per active agent in this org, all linked to <span className="font-semibold text-foreground">{goalFocus.name}</span>.
                    {" "}{roles.filter((r) => r.agentActive).length} agent(s) will receive a task.
                  </p>
                  <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
                    <div className="space-y-2">
                      <Input
                        placeholder="Task title (default: Work on: [goal name])"
                        value={assignAllTitle}
                        onChange={(e) => setAssignAllTitle(e.target.value)}
                        className="h-8 text-sm"
                      />
                      <Input
                        placeholder="Description (optional)"
                        value={assignAllDesc}
                        onChange={(e) => setAssignAllDesc(e.target.value)}
                        className="h-8 text-sm"
                      />
                    </div>
                    <div className="flex flex-col gap-2">
                      <select
                        className="h-8 rounded border border-border bg-background px-2 text-sm"
                        value={assignAllPriority}
                        onChange={(e) => setAssignAllPriority(e.target.value as "low" | "medium" | "high")}
                      >
                        <option value="low">Low</option>
                        <option value="medium">Medium</option>
                        <option value="high">High</option>
                      </select>
                      <Button
                        size="sm"
                        disabled={assignAllSaving || roles.filter((r) => r.agentActive).length === 0}
                        onClick={() => void assignGoalToAllAgents()}
                        className="bg-terminal-red text-white hover:bg-terminal-red/80"
                      >
                        {assignAllSaving
                          ? `Creating ${assignAllProgress}/${roles.filter((r) => r.agentActive).length}…`
                          : `Create ${roles.filter((r) => r.agentActive).length} Tasks`}
                      </Button>
                    </div>
                  </div>
                  {assignAllSaving && (
                    <div className="w-full rounded-full bg-terminal-red/10 h-1.5 overflow-hidden">
                      <div
                        className="h-full bg-terminal-red/60 transition-all duration-200"
                        style={{ width: `${Math.round((assignAllProgress / Math.max(roles.filter((r) => r.agentActive).length, 1)) * 100)}%` }}
                      />
                    </div>
                  )}
                  {assignAllResult && (
                    <div className="space-y-1">
                      <p className="text-xs text-green-400">
                        ✓ Created {assignAllResult.created}/{assignAllResult.total} tasks successfully.
                      </p>
                      {assignAllResult.agentNames.length > 0 && (
                        <p className="text-[10px] text-muted-foreground font-mono">
                          {assignAllResult.agentNames.slice(0, 5).join(", ")}
                          {assignAllResult.agentNames.length > 5 && ` +${assignAllResult.agentNames.length - 5} more`}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )}
              <div className="space-y-3 rounded-xl border border-terminal-red/20 bg-background/70 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      {inlineEditGoal?.id === goalFocus.id && inlineEditGoal.field === "name" ? (
                        <input
                          autoFocus
                          className="text-base font-semibold bg-transparent border-b border-terminal-red/60 outline-none w-full max-w-sm"
                          value={inlineEditGoal.value}
                          disabled={inlineEditSaving}
                          onChange={(e) => setInlineEditGoal({ ...inlineEditGoal, value: e.target.value })}
                          onBlur={() => void saveInlineGoalEdit()}
                          onKeyDown={(e) => { if (e.key === "Enter") void saveInlineGoalEdit(); if (e.key === "Escape") setInlineEditGoal(null); }}
                        />
                      ) : (
                        <div
                          className="text-base font-semibold cursor-text hover:text-terminal-red/80 transition-colors"
                          title="Click to edit name"
                          onClick={() => setInlineEditGoal({ id: goalFocus.id, field: "name", value: goalFocus.name })}
                        >
                          {goalFocus.name}
                        </div>
                      )}
                      <Badge variant="secondary" className="text-[10px] font-mono uppercase tracking-wide">
                        {goalFocus.organizationName || "Unscoped"}
                      </Badge>
                      <select
                        className={`border px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wide bg-background cursor-pointer focus:outline-none ${
                          goalFocus.status === "active" ? "border-green-500/50 text-green-400" :
                          goalFocus.status === "blocked" ? "border-terminal-red text-terminal-red" :
                          goalFocus.status === "done" ? "border-muted text-muted-foreground" :
                          "border-yellow-500/50 text-yellow-400"
                        } disabled:opacity-40`}
                        value={goalFocus.status}
                        disabled={updatingGoalField === `${goalFocus.id}:status`}
                        onChange={(e) => void updateGoalField(goalFocus.id, "status", e.target.value)}
                      >
                        <option value="planned">PLANNED</option>
                        <option value="active">ACTIVE</option>
                        <option value="blocked">BLOCKED</option>
                        <option value="done">DONE</option>
                      </select>
                      <select
                        className="border border-blue-500/30 px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wide bg-background text-blue-400/80 cursor-pointer focus:outline-none disabled:opacity-40"
                        value={goalFocus.level ?? ""}
                        disabled={updatingGoalField === `${goalFocus.id}:level`}
                        onChange={(e) => void updateGoalField(goalFocus.id, "level", e.target.value)}
                      >
                        <option value="">— LEVEL —</option>
                        <option value="vision">VISION</option>
                        <option value="mission">MISSION</option>
                        <option value="objective">OBJECTIVE</option>
                        <option value="key_result">KEY RESULT</option>
                      </select>
                      {goalFocus.parentGoalName ? (
                        <Badge variant="outline" className="text-[10px]">
                          child goal
                        </Badge>
                      ) : null}
                    </div>
                    {inlineEditGoal?.id === goalFocus.id && inlineEditGoal.field === "description" ? (
                      <textarea
                        autoFocus
                        rows={3}
                        className="w-full max-w-3xl text-sm bg-transparent border border-terminal-red/40 rounded p-1 outline-none resize-none text-muted-foreground"
                        value={inlineEditGoal.value}
                        disabled={inlineEditSaving}
                        onChange={(e) => setInlineEditGoal({ ...inlineEditGoal, value: e.target.value })}
                        onBlur={() => void saveInlineGoalEdit()}
                        onKeyDown={(e) => { if (e.key === "Escape") setInlineEditGoal(null); }}
                      />
                    ) : (
                      <p
                        className="max-w-3xl text-sm text-muted-foreground cursor-text hover:text-foreground/70 transition-colors"
                        title="Click to edit description"
                        onClick={() => setInlineEditGoal({ id: goalFocus.id, field: "description", value: goalFocus.description ?? "" })}
                      >
                        {goalFocus.description || <span className="italic opacity-50">Click to add description…</span>}
                      </p>
                    )}
                    {(() => {
                      const subGoals = childGoalsByParent.get(goalFocus.id) ?? [];
                      if (subGoals.length === 0) return null;
                      return (
                        <div className="mt-2 space-y-1">
                          <div className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground">
                            Sub-Goals ({subGoals.length})
                          </div>
                          {subGoals.map((sub) => (
                            <button
                              key={sub.id}
                              type="button"
                              className="flex items-center gap-2 w-full text-left px-2 py-1 rounded border border-border/50 hover:border-terminal-red/40 transition-colors"
                              onClick={() => { setSelectedGoalId(sub.id); setGoalSelectedByUserThisSession(true); setGoalDrawerOpen(true); }}
                            >
                              <span className="text-xs font-medium flex-1 truncate">{sub.name}</span>
                              <Badge variant="outline" className={`shrink-0 text-[9px] font-mono uppercase ${
                                sub.status === "active" ? "border-green-500/50 text-green-400" :
                                sub.status === "blocked" ? "border-terminal-red text-terminal-red" :
                                sub.status === "done" ? "border-muted text-muted-foreground" :
                                "border-yellow-500/50 text-yellow-400"
                              }`}>{sub.status}</Badge>
                            </button>
                          ))}
                        </div>
                      );
                    })()}
                  </div>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 text-[11px] text-muted-foreground">
                    <div>Deliverables: {goalFocusDeliverables.length}</div>
                    <div>Attachments: {goalFocusAttachmentIds.length}</div>
                  </div>
                </div>
                {scopedGoalTasks.length > 0 && (
                  <div className="mt-3 rounded-lg border border-border p-3">
                    <div className="mb-2 flex items-center justify-between">
                      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                        Tasks ({scopedGoalTasks.length})
                      </div>
                      <div className="flex gap-2 text-[10px] text-muted-foreground">
                        <span className="text-yellow-400">{scopedGoalOpenTasks.length} open</span>
                        <span>·</span>
                        <span className="text-green-400">{scopedGoalTasks.filter(t => t.status === "done").length} done</span>
                        {scopedGoalTasks.filter(t => t.status === "blocked").length > 0 && (
                          <>
                            <span>·</span>
                            <span className="text-terminal-red">{scopedGoalTasks.filter(t => t.status === "blocked").length} blocked</span>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="space-y-1 max-h-48 overflow-y-auto">
                      {scopedGoalTasks.slice(0, 12).map((task) => (
                        <div key={task.id} className="flex items-center gap-2 rounded border border-border/40 px-2 py-1 text-xs">
                          <span className={`shrink-0 rounded px-1 py-0.5 font-mono text-[9px] uppercase ${
                            task.status === "done" ? "bg-green-500/10 text-green-400" :
                            task.status === "blocked" ? "bg-terminal-red/10 text-terminal-red" :
                            task.status === "in_progress" ? "bg-blue-500/10 text-blue-400" :
                            task.status === "review" ? "bg-yellow-500/10 text-yellow-400" :
                            "bg-muted text-muted-foreground"
                          }`}>{task.status.replace("_", " ")}</span>
                          <span className="flex-1 truncate">{task.title}</span>
                          {task.assignedAgentName && (
                            <span className="shrink-0 text-[10px] text-muted-foreground">{task.assignedAgentName}</span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                  <div className="rounded-lg border border-border p-3">
                    <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                      Goal Deliverables
                    </div>
                    {goalFocusDeliverables.length === 0 ? (
                      <div className="text-xs text-muted-foreground">No deliverables attached yet.</div>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {goalFocusDeliverables.map((deliverable) => (
                          <Badge key={`${goalFocus.id}-focus-deliverable-${deliverable}`} variant="secondary" className="text-[10px]">
                            {deliverable}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="rounded-lg border border-border p-3">
                    <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                      Goal Attachments
                    </div>
                    {goalFocusAttachmentIds.length === 0 ? (
                      <div className="text-xs text-muted-foreground">No goal attachments linked yet.</div>
                    ) : (
                      <div className="space-y-2">
                        {goalFocusAttachmentIds.slice(0, 3).map((documentId) => {
                          const document = linkedDocumentsById[documentId] ?? documentById.get(documentId) ?? null;
                          const documentName = document?.name || documentId;
                          const documentMeta =
                            "sourceUrl" in (document ?? {}) && document?.sourceUrl
                              ? document.sourceUrl
                              : documentId;
                          return (
                          <div key={`${goalFocus.id}-focus-document-${documentId}`} className="flex items-center justify-between gap-2 rounded-md border border-border/70 px-3 py-2">
                            <div className="min-w-0">
                              <div className="truncate text-sm font-medium">{documentName}</div>
                              <div className="mt-1 text-[11px] text-muted-foreground">{documentMeta}</div>
                            </div>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 px-2 text-[10px]"
                              onClick={() => router.push(`/documents?documentId=${encodeURIComponent(documentId)}`)}
                            >
                              Open
                            </Button>
                          </div>
                        )})}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
              </SheetBody>
            </SheetContent>
          </Sheet>
          ) : null}

          {/* ══════════════════════════════════════════════════════════════════════
              VISUAL ORG TREE — pure CSS connectors
              ══════════════════════════════════════════════════════════════════════ */}
          <div className="mb-5 border border-border bg-card/50 p-6">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                  TEAM TOPOLOGY
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Click an agent to inspect ownership, role, and workload.
                </p>
              </div>
              <div data-tree-ignore-pan="true" className="flex flex-wrap items-center gap-2">
                <span className="text-[10px] font-mono text-muted-foreground">
                  {roles.length > TREE_COLLAPSE_THRESHOLD ? `${roles.length} agents` : ""}
                </span>
                <Badge variant="outline" className="font-mono text-[10px] uppercase tracking-wide">
                  {Math.round(treeScale * 100)}%
                </Badge>
                <Button size="sm" variant="outline" onClick={() => adjustTreeScale(-0.08)}>
                  Zoom Out
                </Button>
                <Button size="sm" variant="outline" onClick={() => adjustTreeScale(0.08)}>
                  Zoom In
                </Button>
                <Button size="sm" variant="ghost" onClick={resetTreeViewport}>
                  Reset View
                </Button>
              </div>
            </div>

            {/* Search bar for topology tree */}
            <div data-tree-ignore-pan="true" className="mb-3">
              <input
                type="text"
                value={treeSearch}
                onChange={(e) => { setTreeSearch(e.target.value); setShowAllTreeAgents(false); }}
                placeholder="Search agents by name, role..."
                className="w-full rounded-md border bg-background px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>

            {loading ? (
              <p className="text-sm text-muted-foreground">Loading hierarchy...</p>
            ) : !orchestrator ? (
              <p className="text-sm text-muted-foreground">No agents available.</p>
            ) : treeSearch.trim() ? (
              /* Search results — flat filtered grid */
              <div className="flex flex-wrap justify-center gap-3 p-4">
                {filteredAgents.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No agents match &quot;{treeSearch}&quot;.</p>
                ) : (
                  filteredAgents.map((role) => renderTreeNode(role))
                )}
              </div>
            ) : (
              /* Adaptive collapse for large orgs */
              <div>
                {roles.length > TREE_COLLAPSE_THRESHOLD && !showAllTreeAgents ? (
                  <div className="space-y-3">
                    <div className="flex flex-wrap justify-center gap-3 p-4">
                      {roles.slice(0, 10).map((role) => renderTreeNode(role))}
                    </div>
                    <div className="flex justify-center">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setShowAllTreeAgents(true)}
                        className="text-xs"
                      >
                        +{roles.length - 10} more... Show All
                      </Button>
                    </div>
                  </div>
                ) : (
              <div
                className={`rounded-xl border border-border/70 bg-background/40 overflow-auto ${treePanning ? "cursor-grabbing" : "cursor-grab"}`}
                style={{ touchAction: "none" }}
                onPointerDown={onTreePointerDown}
                onPointerMove={onTreePointerMove}
                onPointerUp={finishTreePointer}
                onPointerCancel={finishTreePointer}
                onWheel={onTreeWheel}
              >
                <div
                  ref={treeStageRef}
                  data-testid="hierarchy-tree-stage"
                  className="relative flex min-h-[420px] min-w-max justify-center p-6"
                  style={{
                    transform: `translate(${treeOffset.x}px, ${treeOffset.y}px) scale(${treeScale})`,
                    transformOrigin: "top center",
                    transition: treePanning ? "none" : "transform 120ms ease-out",
                  }}
                >
                  <div className="org-tree min-w-max">
                    <style>{`
                      .org-tree { --connector-color: hsl(var(--border)); --connector-active: hsl(var(--terminal-red)); }
                      .org-tree ul { display: flex; justify-content: center; padding: 0; margin: 0; list-style: none; position: relative; }
                      .org-tree ul::before { content: ''; position: absolute; top: 0; left: 50%; border-left: 2px solid var(--connector-color); height: 20px; }
                      .org-tree > ul::before { display: none; }
                      .org-tree li { position: relative; padding: 20px 8px 0 8px; display: flex; flex-direction: column; align-items: center; }
                      .org-tree li::before, .org-tree li::after { content: ''; position: absolute; top: 0; width: 50%; height: 20px; border-top: 2px solid var(--connector-color); }
                      .org-tree li::before { right: 50%; border-right: 2px solid var(--connector-color); }
                      .org-tree li::after { left: 50%; border-left: 2px solid var(--connector-color); }
                      .org-tree li:first-child::before { border: 0 none; }
                      .org-tree li:last-child::after { border: 0 none; }
                      .org-tree li:only-child::before, .org-tree li:only-child::after { display: none; }
                      .org-tree li:only-child { padding-top: 20px; }
                      .org-tree > ul > li { padding-top: 0; }
                      .org-tree > ul > li::before, .org-tree > ul > li::after { display: none; }
                      .org-tree li.active-connector::before { border-color: var(--connector-active); }
                      .org-tree li.active-connector::after { border-color: var(--connector-active); }
                      .org-tree ul.has-connector::before { border-color: var(--connector-color); }
                    `}</style>

                    <ul>
                      {rootTreeRoles.map((role) => renderOrgBranch(role, role.agentId === orchestrator?.agentId))}
                    </ul>

                    {unlinked.length > 0 ? (
                      <div className="mt-6 border-t border-dashed border-border pt-4">
                        <div className="mb-3 text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                          UNLINKED AGENTS
                        </div>
                        <div className="flex flex-wrap justify-center gap-3">
                          {sortRolesForTree(unlinked).map((role) => renderTreeNode(role))}
                        </div>
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
        </div>

        {/* ── Expanded node detail panel ── */}
          {expandedRole && !isAdvancedView && (() => {
            const r = expandedRole;
            const settings = agentSettings[r.agentId];
            const modelRef =
              settings?.modelRef ||
              (activeGlobalModel ? `${activeGlobalModel.provider}:${activeGlobalModel.modelId} (global fallback)` : null);
            const budget = settings?.budgetSummary;
            const managerName = r.reportsTo ? roles.find((role) => role.agentId === r.reportsTo)?.agentName ?? r.reportsTo : null;
            const wl = workloadByAgent[r.agentId];
            const assignedTasks = runtimeSnapshot.tasks.filter((t) => t.assignedAgentId === r.agentId);
            const agentEvents = hierarchyLedgerEvents.filter((e) => e.agentId === r.agentId).slice(0, 12);
            return (
              <Sheet open onOpenChange={(open) => { if (!open) setExpandedNodeId(null); }}>
                <SheetContent widthClassName="w-full sm:max-w-md" onOpenAutoFocus={(e) => e.preventDefault()}>
                  <SheetHeader>
                    <SheetTitle>{r.agentName}</SheetTitle>
                    <SheetDescription>
                      <span className="inline-flex flex-wrap items-center gap-1.5">
                        <Badge variant="secondary" className="text-[10px]">{ROLE_TYPE_LABELS[r.roleType] || r.roleType}</Badge>
                        <Badge variant="outline" className={`text-[10px] ${r.agentActive ? "text-green-400" : "text-muted-foreground"}`}>{r.agentActive ? "active" : "inactive"}</Badge>
                        {managerName ? <span className="text-[10px] text-muted-foreground">reports to {managerName}</span> : <span className="text-[10px] text-muted-foreground">top-level</span>}
                      </span>
                    </SheetDescription>
                  </SheetHeader>
                  <SheetBody>
                    <RelatedWorkTrailStrip
                      className="mb-3"
                      surface="agents"
                      objectType="agent"
                      objectId={r.agentId}
                      objectName={r.agentName}
                    />
                    <Tabs value={agentDrawerTab} onValueChange={(v) => setAgentDrawerTab(v as typeof agentDrawerTab)}>
                      <TabsList className="grid w-full grid-cols-4">
                        <TabsTrigger value="profile" className="text-[11px]">Profile</TabsTrigger>
                        <TabsTrigger value="work" className="text-[11px]">Work</TabsTrigger>
                        <TabsTrigger value="governance" className="text-[11px]">Governance</TabsTrigger>
                        <TabsTrigger value="activity" className="text-[11px]">Activity</TabsTrigger>
                      </TabsList>

                      <TabsContent value="profile" className="mt-3 space-y-2 text-xs">
                        <div><span className="text-muted-foreground">Role type:</span> {ROLE_TYPE_LABELS[r.roleType] || r.roleType}</div>
                        <div><span className="text-muted-foreground">Role title:</span> {r.roleTitle || "—"}</div>
                        {r.roleDescription ? <div><span className="text-muted-foreground">Description:</span> {r.roleDescription}</div> : null}
                        <div><span className="text-muted-foreground">Reports to:</span> {managerName ?? "—"}</div>
                        <div><span className="text-muted-foreground">Model:</span> {modelRef || "not configured"}</div>
                        <div><span className="text-muted-foreground">Vote weight:</span> {r.voteWeight}</div>
                        <div><span className="text-muted-foreground">Skills:</span> {(settings?.enabledSkills ?? []).length > 0 ? (settings?.enabledSkills ?? []).join(", ") : "none"}</div>
                        <div><span className="text-muted-foreground">Extensions:</span> {(settings?.enabledExtensions ?? []).length > 0 ? (settings?.enabledExtensions ?? []).join(", ") : "none"}</div>
                        {r.capabilities.length > 0 ? <div><span className="text-muted-foreground">Capabilities:</span> {r.capabilities.join(", ")}</div> : null}
                        <div className="flex flex-wrap gap-2 pt-2">
                          <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => router.push(`/agents`)}>Open in Agents</Button>
                          <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => openWebChatWithPrompt(`Ask ${r.agentName} (agent ${r.agentId}) to `)}>Ask This Agent</Button>
                          <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => openWebChatWithPrompt(`Change agent ${r.agentName} (${r.agentId}) model/profile/skills to `)}>Edit Profile</Button>
                        </div>
                      </TabsContent>

                      <TabsContent value="work" className="mt-3 space-y-2 text-xs">
                        <div className="flex flex-wrap gap-1">
                          <Badge variant="outline" className="text-[10px]">active {wl?.activeTasks ?? 0}</Badge>
                          <Badge variant="outline" className="text-[10px]">assigned {assignedTasks.length}</Badge>
                          <Badge variant="outline" className="text-[10px]">workflows {wl?.workflows ?? 0}</Badge>
                        </div>
                        {assignedTasks.length > 0 ? (
                          <ul className="space-y-1">
                            {assignedTasks.slice(0, 8).map((t) => (
                              <li key={t.id} className="flex items-center justify-between gap-2 rounded border border-border/60 px-2 py-1">
                                <span className="truncate">{t.title}</span>
                                <Badge variant="secondary" className="text-[10px]">{t.status}</Badge>
                              </li>
                            ))}
                          </ul>
                        ) : <div className="text-muted-foreground">No tasks assigned to this agent.</div>}
                        <div className="flex flex-wrap gap-2 pt-1">
                          <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => openWebChatWithPrompt(`Assign a task to agent ${r.agentName} (${r.agentId}): `)}>Assign Task</Button>
                          <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => router.push(`/boards`)}>Open Boards</Button>
                        </div>
                      </TabsContent>

                      <TabsContent value="governance" className="mt-3 space-y-2 text-xs">
                        <div><span className="text-muted-foreground">Budget cap:</span> {budget?.spendCapUsd != null ? `$${budget.spendCapUsd.toFixed(2)}` : "none"}</div>
                        <div><span className="text-muted-foreground">Spent:</span> {budget ? `$${budget.spentUsd.toFixed(4)}` : "—"}{budget?.usagePercent != null ? ` (${Math.round(budget.usagePercent)}%)` : ""}</div>
                        <div><span className="text-muted-foreground">Window:</span> {budget?.spendWindowDays ?? "—"} days</div>
                        <div><span className="text-muted-foreground">Action:</span> {budget?.budgetAction ?? "warn"}</div>
                        {budget?.warningLevel && budget.warningLevel !== "ok" ? (
                          <div className={budget.warningLevel === "over" ? "text-terminal-red" : "text-yellow-400"}>Budget {budget.warningLevel === "over" ? "over cap" : "near cap"}</div>
                        ) : null}
                        <div className="flex flex-wrap gap-2 pt-1">
                          <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => openWebChatWithPrompt(`Set a budget policy for agent ${r.agentName} (${r.agentId}): `)}>Edit Budget</Button>
                          <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => openWebChatWithPrompt(`Create an approval rule for agent ${r.agentName} (${r.agentId}): `)}>Edit Approval Rule</Button>
                        </div>
                      </TabsContent>

                      <TabsContent value="activity" className="mt-3 space-y-2 text-xs">
                        {agentEvents.length > 0 ? (
                          <ul className="space-y-1">
                            {agentEvents.map((e) => (
                              <li key={e.id} className="rounded border border-border/60 px-2 py-1">
                                <div className="flex items-center justify-between gap-2">
                                  <span className="truncate font-medium">{e.title}</span>
                                  {e.status ? <Badge variant="outline" className="text-[10px]">{e.status}</Badge> : null}
                                </div>
                                {e.summary ? <div className="text-muted-foreground">{e.summary}</div> : null}
                              </li>
                            ))}
                          </ul>
                        ) : <div className="text-muted-foreground">No recent activity for this agent.</div>}
                        <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => setViewMode("advanced")}>Open Activity</Button>
                      </TabsContent>
                    </Tabs>
                  </SheetBody>
                </SheetContent>
              </Sheet>
            );
          })()}

          {expandedRole && isAdvancedView && (
            <div className="mb-5 border border-terminal-red/30 bg-card p-4 relative">
              <div className="absolute top-0 left-0 w-3 h-3 border-t-2 border-l-2 border-terminal-red" />
              <div className="absolute bottom-0 right-0 w-3 h-3 border-b-2 border-r-2 border-terminal-red/30" />
              <div className="flex items-center justify-between mb-3">
                <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                  AGENT DETAIL
                </div>
                <div className="flex gap-1">
                  {/* H7: Zoom-to-agent in topology */}
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-[10px] h-6 px-2"
                    onClick={() => {
                      const nodeEl = treeStageRef.current?.querySelector(`[data-agent-id="${expandedRole.agentId}"]`);
                      if (nodeEl) {
                        nodeEl.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
                        (nodeEl as HTMLElement).style.outline = "2px solid hsl(var(--terminal-red))";
                        setTimeout(() => { (nodeEl as HTMLElement).style.outline = ""; }, 2000);
                      }
                    }}
                  >
                    Focus in tree
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setExpandedNodeId(null)}>
                    Close
                  </Button>
                </div>
              </div>
              {renderRoleCard(expandedRole, expandedRole.roleType === "orchestrator" ? "primary" : "secondary")}
            </div>
          )}

          {/* ── Collapsible Organizations panel ── */}
          <div className="mb-4 border border-border bg-card">
            <button
              className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-muted/20 transition-colors"
              onClick={() => toggleSection("orgs")}
            >
              <div className="flex items-center gap-2">
                <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">ORGANIZATIONS</div>
                <Badge variant="secondary" className="text-[10px]">
                  {organizations.length} saved
                </Badge>
              </div>
              <span className="text-[10px] font-mono text-muted-foreground">{collapsedSections.orgs ? "EXPAND" : "COLLAPSE"}</span>
            </button>
            {!collapsedSections.orgs && (
              <div className="border-t border-border p-4">
                <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                  <div className="space-y-3">
                    <div className="space-y-1">
                      <Label>Active Organization</Label>
                      <div className="flex flex-wrap gap-2">
                        <Badge variant="secondary">
                          {organizations.find((item) => item.id === activeOrganizationId)?.name || "No active organization"}
                        </Badge>
                        {organizations.find((item) => item.id === activeOrganizationId)?.mission ? (
                          <Badge variant="outline" className="max-w-full truncate">
                            {organizations.find((item) => item.id === activeOrganizationId)?.mission}
                          </Badge>
                        ) : null}
                      </div>
                    </div>
                    <div className="space-y-1">
                      <Label>Switch Organization</Label>
                      <div className="flex gap-2">
                        <select
                          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                          value={selectedOrganizationId}
                          onChange={(event) => setSelectedOrganizationId(event.target.value)}
                        >
                          {organizations.map((organization) => (
                            <option key={organization.id} value={organization.id}>
                              {organization.name} ({organization.memberCount} members)
                            </option>
                          ))}
                        </select>
                        <Button
                          onClick={() => void onApplyOrganization()}
                          disabled={applyingOrganization || !selectedOrganizationId}
                        >
                          {applyingOrganization ? "Switching..." : "Switch"}
                        </Button>
                      </div>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label>Save Current Organization Snapshot</Label>
                    <Input
                      placeholder="CEO Demo Org"
                      value={organizationName}
                      onChange={(event) => setOrganizationName(event.target.value)}
                    />
                    <Input
                      placeholder="Short description"
                      value={organizationDescription}
                      onChange={(event) => setOrganizationDescription(event.target.value)}
                    />
                    <Textarea
                      rows={2}
                      placeholder="Mission / operating context"
                      value={organizationMission}
                      onChange={(event) => setOrganizationMission(event.target.value)}
                    />
                    <div className="flex justify-end">
                      <Button
                        onClick={() => void onSaveOrganization()}
                        disabled={savingOrganization || !organizationName.trim()}
                      >
                        {savingOrganization ? "Saving..." : "Save Snapshot"}
                      </Button>
                    </div>

                    <div className="border-t border-dashed border-border pt-3">
                      <div className="mb-2 flex items-center gap-2">
                        <Label className="mb-0">Apply Company Template</Label>
                        <Badge variant="outline" className="text-[10px]">
                          Company-pack bootstrap
                        </Badge>
                      </div>
                      <div className="space-y-2">
                        <select
                          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                          value={selectedTemplateId}
                          onChange={(event) => setSelectedTemplateId(event.target.value)}
                        >
                          {companyTemplates.map((template) => (
                            <option key={template.id} value={template.id}>
                              {template.name}
                            </option>
                          ))}
                        </select>
                        <Input
                          placeholder={selectedCompanyTemplate ? `${selectedCompanyTemplate.name} 2026-03-14` : "Template organization name"}
                          value={templateOrganizationName}
                          onChange={(event) => setTemplateOrganizationName(event.target.value)}
                        />
                        <TemplatesPanelDynamic template={selectedCompanyTemplate} />
                        <div className="flex justify-end">
                          <Button
                            variant="secondary"
                            onClick={() => void onApplyCompanyTemplate()}
                            disabled={applyingCompanyTemplate || !selectedTemplateId}
                          >
                            {applyingCompanyTemplate ? "Applying..." : "Apply Template"}
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* History item: Broken-link auditor */}
          {isAdvancedView && roles.length > 0 && (() => {
            if (integrityIssues.length === 0) return null;
            return (
              <div className="mb-4 border border-yellow-500/40 bg-yellow-500/5 p-3">
                <div className="mb-2 text-[10px] font-mono uppercase tracking-widest text-yellow-400/80">DATA INTEGRITY</div>
                <div className="space-y-1">
                  {integrityIssues.map((issue) => (
                    <div key={issue.key} className="flex items-center gap-2 text-xs text-yellow-300/80">
                      <span className="text-yellow-400">⚠</span> {issue.label}
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}

          {/* History item: Org export/import */}
          {activeOrganizationId && (
            <div className="mb-4 border border-border bg-card p-3 flex flex-wrap items-center gap-2">
              <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">ORG SNAPSHOT</span>
              <Button
                size="sm"
                variant="outline"
                className="text-[11px] h-6"
                disabled={orgPackageBusy}
                onClick={() => void exportOrganizationPackage()}
              >
                {orgPackageBusy ? "Working..." : "Export Org Package"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="text-[11px] h-6"
                disabled={orgPackageBusy}
                onClick={() => orgImportInputRef.current?.click()}
              >
                Import Org Package
              </Button>
              <input
                ref={orgImportInputRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={(event) => void importOrganizationPackage(event)}
              />
            </div>
          )}

          {/* ── Collapsible Goals panel ── */}
          <div ref={goalsSectionRef} className="mb-4 border border-border bg-card">
            <div className="flex items-center justify-between px-4 py-3">
              <button
                className="flex items-center gap-2 text-left hover:opacity-80 transition-opacity flex-1"
                onClick={() => toggleSection("goals")}
              >
                <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">GOALS</div>
                <Badge variant="secondary" className="text-[10px]">
                  {goals.length} active
                </Badge>
                <span className="text-[10px] font-mono text-muted-foreground ml-auto">{collapsedSections.goals ? "EXPAND" : "COLLAPSE"}</span>
              </button>
              <button
                type="button"
                className="ml-3 shrink-0 border border-terminal-red/40 px-2 py-1 text-[10px] font-mono uppercase tracking-wider text-terminal-red/80 hover:border-terminal-red hover:text-terminal-red transition-colors"
                onClick={(e) => { e.stopPropagation(); setQuickGoalOpen((v) => !v); }}
              >
                + GOAL
              </button>
            </div>
            {quickGoalOpen && (
              <div className="border-t border-border bg-muted/10 p-4">
                <div className="flex flex-wrap gap-2 items-end">
                  <div className="flex-1 min-w-[180px]">
                    <div className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground mb-1">Goal Name</div>
                    <input
                      type="text"
                      className="w-full border border-border bg-background px-2 py-1.5 text-sm font-mono focus:border-terminal-red focus:outline-none"
                      placeholder="e.g. Launch v2 product"
                      value={quickGoalName}
                      onChange={(e) => setQuickGoalName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") void createQuickGoal(); }}
                    />
                  </div>
                  <div>
                    <div className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground mb-1">Status</div>
                    <select
                      className="border border-border bg-background px-2 py-1.5 text-xs font-mono focus:border-terminal-red focus:outline-none"
                      value={quickGoalStatus}
                      onChange={(e) => setQuickGoalStatus(e.target.value as "planned" | "active" | "blocked" | "done")}
                    >
                      <option value="planned">Planned</option>
                      <option value="active">Active</option>
                      <option value="blocked">Blocked</option>
                      <option value="done">Done</option>
                    </select>
                  </div>
                  <div>
                    <div className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground mb-1">Level</div>
                    <select
                      className="border border-border bg-background px-2 py-1.5 text-xs font-mono focus:border-terminal-red focus:outline-none"
                      value={quickGoalLevel}
                      onChange={(e) => setQuickGoalLevel(e.target.value as "vision" | "mission" | "objective" | "key_result" | "")}
                    >
                      <option value="">— none —</option>
                      <option value="vision">Vision</option>
                      <option value="mission">Mission</option>
                      <option value="objective">Objective</option>
                      <option value="key_result">Key Result</option>
                    </select>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={quickGoalSaving || !quickGoalName.trim()}
                      className="border border-terminal-red px-3 py-1.5 text-xs font-mono uppercase tracking-wider text-terminal-red hover:bg-terminal-red hover:text-white transition-colors disabled:opacity-40"
                      onClick={() => void createQuickGoal()}
                    >
                      {quickGoalSaving ? "Saving..." : "Save"}
                    </button>
                    <button
                      type="button"
                      className="border border-border px-3 py-1.5 text-xs font-mono uppercase tracking-wider text-muted-foreground hover:border-terminal-red/50 transition-colors"
                      onClick={() => setQuickGoalOpen(false)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            )}
            {!collapsedSections.goals && (
              <div className="border-t border-border p-4">
                <div className="grid gap-4 xl:grid-cols-[280px_minmax(0,1fr)_340px]">
                  <div className="space-y-0.5">
                    {goals.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No goals for the active organization yet.</p>
                    ) : (() => {
                      const rootGoals = goals.filter((g) => !g.parentGoalId || !goalsById.has(g.parentGoalId));
                      const renderGoalRow = (goal: HierarchyGoal, depth: number): React.ReactNode => {
                        const children = childGoalsByParent.get(goal.id) ?? [];
                        const hasChildren = children.length > 0;
                        const isCollapsed = collapsedGoalIds.has(goal.id);
                        const isSelected = goal.id === selectedGoalId;
                        return (
                          <div key={goal.id}>
                            <div
                              style={{ paddingLeft: depth * 16 }}
                              className={`flex items-start gap-1 rounded border transition-colors ${
                                isSelected ? "border-terminal-red bg-terminal-red/5" : "border-transparent hover:border-terminal-red/30"
                              }`}
                            >
                              <button
                                type="button"
                                className="mt-2 shrink-0 w-4 h-4 flex items-center justify-center text-muted-foreground hover:text-foreground"
                                onClick={() => setCollapsedGoalIds((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(goal.id)) next.delete(goal.id); else next.add(goal.id);
                                  return next;
                                })}
                              >
                                {hasChildren ? (isCollapsed ? "▶" : "▼") : "·"}
                              </button>
                              <button
                                type="button"
                                className="flex-1 p-2 text-left"
                                onClick={() => { setSelectedGoalId(goal.id); setGoalSelectedByUserThisSession(true); setGoalDrawerOpen(true); }}
                              >
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <span className="text-sm font-medium">{goal.name}</span>
                                  <Badge variant="outline" className={`text-[10px] font-mono uppercase tracking-wide ${
                                    goal.status === "active" ? "border-green-500/50 text-green-400" :
                                    goal.status === "blocked" ? "border-terminal-red text-terminal-red" :
                                    goal.status === "done" ? "border-muted text-muted-foreground" :
                                    "border-yellow-500/50 text-yellow-400"
                                  }`}>
                                    {goal.status}
                                  </Badge>
                                  {goal.level && (
                                    <Badge variant="outline" className="text-[10px] font-mono uppercase border-blue-500/30 text-blue-400/80">
                                      {goal.level.replace("_", " ")}
                                    </Badge>
                                  )}
                                  {hasChildren && (
                                    <Badge variant="secondary" className="text-[10px]">{children.length} sub</Badge>
                                  )}
                                  {/* H2: Goal health score */}
                                  {(() => {
                                    const goalTasks = (runtimeSnapshot?.tasks ?? []).filter(
                                      (t) => t.goalId === goal.id,
                                    );
                                    if (goalTasks.length === 0) return null;
                                    const done = goalTasks.filter((t) => t.status === "done").length;
                                    const blocked = goalTasks.filter((t) => t.status === "blocked").length;
                                    const ratio = done / goalTasks.length;
                                    const daysSince = Math.floor((Date.now() - new Date(goal.updatedAt).getTime()) / 86_400_000);
                                    const isStale = daysSince > 7 && ratio < 0.5;
                                    const healthColor = blocked > 0 ? "border-terminal-red/60 text-terminal-red/80" :
                                      isStale ? "border-yellow-500/50 text-yellow-400/80" :
                                      ratio >= 0.8 ? "border-green-500/50 text-green-400" :
                                      "border-border text-muted-foreground";
                                    const healthLabel = blocked > 0 ? "blocked" : isStale ? "stale" : ratio >= 0.8 ? "near-done" : "active";
                                    return (
                                      <Badge variant="outline" className={`text-[9px] font-mono ${healthColor}`} title={`${done}/${goalTasks.length} done, ${blocked} blocked`}>
                                        {healthLabel}
                                      </Badge>
                                    );
                                  })()}
                                  {/* H3: Cost-per-goal */}
                                  {goalSpendMap[goal.id] && (
                                    <Badge variant="outline" className="text-[9px] font-mono border-purple-500/30 text-purple-400/80" title={`${goalSpendMap[goal.id]!.totalTokens.toLocaleString()} tokens`}>
                                      ${goalSpendMap[goal.id]!.totalCostUsd.toFixed(3)}
                                    </Badge>
                                  )}
                                </div>
                                {goal.description ? (
                                  <p className="mt-0.5 text-xs text-muted-foreground line-clamp-1">{goal.description}</p>
                                ) : null}
                              </button>
                            </div>
                            {hasChildren && !isCollapsed && children.map((child) => renderGoalRow(child, depth + 1))}
                          </div>
                        );
                      };
                      return rootGoals.map((g) => renderGoalRow(g, 0));
                    })()}
                  </div>
                  <div className="space-y-4">
                    <div className="rounded-lg border border-dashed border-border p-4">
                      {goalPanelPreview ? (
                        <div className="space-y-3">
                          <div>
                            <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                              Goal Preview
                            </div>
                            <div className="mt-1 text-sm font-medium">{goalPanelPreview.name}</div>
                            {goalPanelPreview.description ? (
                              <p className="mt-1 text-xs text-muted-foreground">{goalPanelPreview.description}</p>
                            ) : null}
                          </div>
                          <div className="space-y-2">
                            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                              Deliverables
                            </div>
                            {goalPanelPreview.deliverables.length === 0 ? (
                              <div className="text-xs text-muted-foreground">No deliverables attached yet.</div>
                            ) : (
                              <div className="flex flex-wrap gap-1.5">
                                {goalPanelPreview.deliverables.map((deliverable) => (
                                  <span
                                    key={`${goalPanelPreview.id}-panel-deliverable-${deliverable}`}
                                    className="rounded border border-border/70 px-2 py-1 text-[11px]"
                                  >
                                    {deliverable}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                          <div className="space-y-2">
                            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                              Attachments
                            </div>
                            {goalPanelPreviewLinkedDocuments.length === 0 ? (
                              <div className="text-xs text-muted-foreground">No attachments linked yet.</div>
                            ) : (
                              <div className="space-y-1.5">
                                {goalPanelPreviewLinkedDocuments.slice(0, 3).map((document) => (
                                  <div
                                    key={`${goalPanelPreview.id}-panel-document-${document.id}`}
                                    className="rounded border border-border/70 px-2 py-1 text-[11px] text-muted-foreground"
                                  >
                                    {document.name}
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      ) : (
                        <div className="text-sm text-muted-foreground">
                          Selected goal details are pinned above the topology section for faster navigation and cleaner deep-link behavior.
                        </div>
                      )}
                    </div>
                    <div>{renderActivityRollup()}</div>
                  </div>
                  <div className="space-y-2">
                    <Label>Create Goal</Label>
                    <Input
                      placeholder="Launch Local-First Assistant"
                      value={goalName}
                      onChange={(event) => setGoalName(event.target.value)}
                    />
                    <Textarea
                      rows={3}
                      placeholder="Optional description"
                      value={goalDescription}
                      onChange={(event) => setGoalDescription(event.target.value)}
                    />
                    <select
                      className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                      value={goalParentId}
                      onChange={(event) => setGoalParentId(event.target.value)}
                    >
                      <option value="">No parent goal</option>
                      {goals.map((goal) => (
                        <option key={goal.id} value={goal.id}>
                          {goal.name}
                        </option>
                      ))}
                    </select>
                    <div className="space-y-2 rounded-md border border-border/70 p-3">
                      <Label className="text-xs uppercase tracking-wide text-muted-foreground">Goal Attachments</Label>
                      <div className="flex gap-2">
                        <select
                          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                          value={goalDocumentCandidateId}
                          onChange={(event) => setGoalDocumentCandidateId(event.target.value)}
                        >
                          <option value="">Select data source</option>
                          {documents.map((document) => (
                            <option key={document.id} value={document.id}>
                              {document.name} ({document.sourceType})
                            </option>
                          ))}
                        </select>
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => {
                            if (!goalDocumentCandidateId || goalLinkedDocumentIds.includes(goalDocumentCandidateId)) return;
                            setGoalLinkedDocumentIds((current) => [...current, goalDocumentCandidateId]);
                            setGoalDocumentCandidateId("");
                          }}
                          disabled={!goalDocumentCandidateId}
                        >
                          Attach
                        </Button>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {goalLinkedDocumentIds.map((documentId) => (
                          <button
                            key={`goal-document-${documentId}`}
                            type="button"
                            className="rounded border border-border px-2 py-1 text-[11px] hover:border-terminal-red"
                            onClick={() =>
                              setGoalLinkedDocumentIds((current) => current.filter((value) => value !== documentId))
                            }
                          >
                            {documentById.get(documentId)?.name || documentId} x
                          </button>
                        ))}
                        {goalLinkedDocumentIds.length === 0 ? (
                          <span className="text-xs text-muted-foreground">Attach documents the goal should use or produce against.</span>
                        ) : null}
                      </div>
                    </div>
                    <Textarea
                      rows={3}
                      placeholder="Deliverables, one per line or comma separated"
                      value={goalDeliverablesText}
                      onChange={(event) => setGoalDeliverablesText(event.target.value)}
                    />
                    <div className="flex justify-end">
                      <Button onClick={() => void onCreateGoal()} disabled={savingGoal || !goalName.trim()}>
                        {savingGoal ? "Saving..." : "Create Goal"}
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* ── Collapsible Role Assignment editor ── */}
          {isAdvancedView && (
          <div className="mb-4 border border-border bg-card">
            <button
              className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-muted/20 transition-colors"
              onClick={() => toggleSection("editor")}
            >
              <div className="flex items-center gap-2">
                <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">ROLE ASSIGNMENT EDITOR</div>
                <Badge variant="secondary" className="text-[10px]">
                  {roles.length} roles
                </Badge>
              </div>
              <span className="text-[10px] font-mono text-muted-foreground">{collapsedSections.editor ? "EXPAND" : "COLLAPSE"}</span>
            </button>
            {!collapsedSections.editor && (
              <div className="border-t border-border p-4">
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {loading ? (
                    <p className="text-sm text-muted-foreground">Loading editor...</p>
                  ) : roles.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No agents available to edit.</p>
                  ) : (
                    roles.map((role) => {
                      const draft = drafts[role.agentId];
                      if (!draft) return null;
                      const targets = roles.filter((entry) => entry.agentId !== role.agentId);
                      return (
                        <div key={`edit-${role.agentId}`} className="border border-border p-3">
                          <div className="mb-2 flex items-center justify-between gap-2">
                            <div className="flex min-w-0 items-center gap-2">
                              <ShapeAvatar seed={role.agentId} size={28} />
                              <div className="truncate text-sm font-semibold">{role.agentName}</div>
                            </div>
                            <Button
                              size="sm"
                              onClick={() => void onSaveRole(role.agentId)}
                              disabled={savingRoleId === role.agentId}
                            >
                              {savingRoleId === role.agentId ? "Saving..." : "Save"}
                            </Button>
                          </div>

                          <div className="grid gap-2">
                            <div className="space-y-1">
                              <Label>Role Type</Label>
                              <select
                                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                                value={draft.roleType}
                                onChange={(event) =>
                                  onDraftChange(role.agentId, {
                                    roleType: event.target.value as AgentRoleType,
                                    reportsTo:
                                      event.target.value === "orchestrator"
                                        ? null
                                        : draft.reportsTo,
                                  })
                                }
                              >
                                {ROLE_TYPE_OPTIONS.map((option) => (
                                  <option key={`${role.agentId}-${option.value}`} value={option.value}>
                                    {option.label}
                                  </option>
                                ))}
                              </select>
                            </div>

                            <div className="space-y-1">
                              <Label>Reports To</Label>
                              <select
                                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                                value={draft.reportsTo ?? ""}
                                disabled={draft.roleType === "orchestrator"}
                                onChange={(event) =>
                                  onDraftChange(role.agentId, {
                                    reportsTo: event.target.value || null,
                                  })
                                }
                              >
                                <option value="">No manager</option>
                                {targets.map((target) => (
                                  <option key={`${role.agentId}-${target.agentId}`} value={target.agentId}>
                                    {target.agentName}
                                  </option>
                                ))}
                              </select>
                            </div>

                            <div className="space-y-1">
                              <Label>Role Title</Label>
                              <Input
                                value={draft.roleTitle}
                                onChange={(event) =>
                                  onDraftChange(role.agentId, { roleTitle: event.target.value })
                                }
                              />
                            </div>

                            <div className="space-y-1">
                              <Label>Vote Weight</Label>
                              <Input
                                type="number"
                                min={1}
                                max={9}
                                value={draft.voteWeight}
                                onChange={(event) =>
                                  onDraftChange(role.agentId, {
                                    voteWeight: Math.max(1, Math.min(9, Number(event.target.value || 1))),
                                  })
                                }
                              />
                            </div>

                            <div className="space-y-1">
                              <Label>Capabilities (comma separated)</Label>
                              <Input
                                value={draft.capabilitiesText}
                                onChange={(event) =>
                                  onDraftChange(role.agentId, { capabilitiesText: event.target.value })
                                }
                              />
                            </div>

                            <div className="space-y-1">
                              <Label>Role Description</Label>
                              <Textarea
                                rows={2}
                                value={draft.roleDescription}
                                onChange={(event) =>
                                  onDraftChange(role.agentId, { roleDescription: event.target.value })
                                }
                              />
                            </div>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            )}
          </div>
          )}
        </main>
  );
}

export default function HierarchyPage() {
  return (
    <Suspense>
      <HierarchyPageInner />
    </Suspense>
  );
}
