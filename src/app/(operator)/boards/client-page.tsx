"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { ShapeAvatar } from "@/components/agents/shape-avatar";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useRouter, useSearchParams } from "next/navigation";
import { ClipboardList, FileText, Lock, LockOpen, Play, Plus, Trash2, X } from "lucide-react";
import { APP_TTL, cachedJson, invalidateCache } from "@/lib/client/app-data-cache";
import { usePolling } from "@/lib/client/use-polling";
import { useAfterUseful } from "@/lib/client/use-after-useful";
import { RelatedWorkTrailStrip } from "@/components/work-trails/related-work-trail-strip";
import { EmptyState } from "@/components/app/empty-state";

type Board = {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  taskCount: number;
};

type Agent = {
  id: string;
  name: string;
  isActive: boolean;
  isDefault: boolean;
  roleType?: string | null;
  roleTitle?: string | null;
};

type TaskStatus = "inbox" | "in_progress" | "review" | "done" | "blocked";

type Task = {
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
  linkedDocumentIds: string[];
  deliverables: string[];
  status: TaskStatus;
  priority: "low" | "medium" | "high";
  assignedAgentId: string | null;
  assignedAgentName: string | null;
  checkedOutByAgentId: string | null;
  checkedOutByAgentName: string | null;
  tags: Array<{ id: string; name: string; color: string }>;
  updatedAt: string;
};

type NewTaskForm = {
  title: string;
  description: string;
  organizationId: string;
  goalId: string;
  linkedDocumentIdsText: string;
  deliverablesText: string;
  status: TaskStatus;
  priority: "low" | "medium" | "high";
  assignedAgentId: string;
};

type DocumentItem = {
  id: string;
  name: string;
  sourceType: "upload" | "scrape" | "integration";
  sourceUrl: string | null;
  excerpt: string;
};

type WorkflowTemplateOption = {
  key: string;
  name: string;
  description: string;
};

type OrganizationOption = {
  id: string;
  name: string;
  mission: string | null;
  memberCount: number;
  isActive: boolean;
};

type GoalOption = {
  id: string;
  name: string;
  organizationId: string | null;
  parentGoalName: string | null;
};

type AgentRoleRecord = {
  agentId: string;
  roleType: string;
  roleTitle: string;
};

const COLUMNS: Array<{ status: TaskStatus; label: string }> = [
  { status: "inbox", label: "Inbox" },
  { status: "in_progress", label: "In Progress" },
  { status: "review", label: "Review" },
  { status: "blocked", label: "Blocked" },
  { status: "done", label: "Done" },
];

const BOARDS_UI_STATE_KEY = "disp8ch:boards-ui";

type QuickFilter = "all" | "mine" | "blocked" | "runnable" | "review";

type SavedView = {
  name: string;
  boardId: string;
  organizationId: string;
  goalId: string;
  quickFilter: QuickFilter;
};

type BoardNotice = {
  tone: "success" | "error" | "info";
  message: string;
};

type BoardsUiState = {
  hideGettingStarted?: boolean;
  quickFilter?: QuickFilter;
  savedViews?: SavedView[];
};

function readBoardsUiState(): BoardsUiState {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(BOARDS_UI_STATE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as BoardsUiState;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeBoardsUiState(patch: BoardsUiState) {
  if (typeof window === "undefined") return;
  const current = readBoardsUiState();
  window.localStorage.setItem(
    BOARDS_UI_STATE_KEY,
    JSON.stringify({
      ...current,
      ...patch,
    }),
  );
}

const BOARD_WORKFLOW_TEMPLATES: WorkflowTemplateOption[] = [
  {
    key: "general-task-executor",
    name: "General Task Executor",
    description: "Turns a plain-English board task into an executable, tool-using workflow.",
  },
  {
    key: "document-intelligence",
    name: "Document Intelligence",
    description: "Analyzes uploaded PDFs and scraped sources using the Data Sources tools, then stores findings in memory.",
  },
  {
    key: "docs-site-crawler-summary",
    name: "Docs Site Crawler + Summary",
    description: "Crawls a docs website into Data Sources, summarizes it, and stores the result in memory.",
  },
  {
    key: "research-assistant",
    name: "Research Assistant",
    description: "Memory-aware research flow that searches, synthesizes, and stores findings.",
  },
  {
    key: "local-api-tester",
    name: "Local API Tester",
    description: "Checks local endpoints and returns a compact report.",
  },
  {
    key: "scheduled-health-check",
    name: "Scheduled Health Check",
    description: "Creates a cron-backed health monitor that can also be run manually from the board.",
  },
  {
    key: "cron-board-task-creator",
    name: "Cron Board Task Creator",
    description: "Creates a cron workflow that keeps adding timestamped tasks to the board every 2 minutes.",
  },
  {
    key: "db-query-dashboard",
    name: "Database Query Dashboard",
    description: "Queries disp8ch stats and formats a dashboard-style summary.",
  },
  {
    key: "ops-control-tower",
    name: "Ops Control Tower",
    description: "Builds a multi-tab operations brief across channels, schedules, boards, council, templates, and memory.",
  },
  {
    key: "hierarchy-board-briefing",
    name: "Hierarchy Board Briefing",
    description: "Creates a hierarchy-scoped operations brief and a follow-up board task for the current org/goal.",
  },
  {
    key: "simple-chat",
    name: "Simple Chat Assistant",
    description: "Minimal workflow for quick execution checks from the board.",
  },
  {
    key: "channel-workspace-assistant",
    name: "Channel Workspace Assistant",
    description: "Cross-channel general assistant for chat and workspace operations.",
  },
];

const EMPTY_FORM: NewTaskForm = {
  title: "",
  description: "",
  organizationId: "",
  goalId: "",
  linkedDocumentIdsText: "",
  deliverablesText: "",
  status: "inbox",
  priority: "medium",
  assignedAgentId: "",
};

function parseListText(raw: string): string[] {
  return raw
    .split(/\r?\n|,/g)
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value, index, list) => list.indexOf(value) === index)
    .slice(0, 24);
}

function BoardsPageInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [boards, setBoards] = useState<Board[]>([]);
  const [selectedBoardId, setSelectedBoardId] = useState<string>("");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [organizations, setOrganizations] = useState<OrganizationOption[]>([]);
  const [goals, setGoals] = useState<GoalOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  const [dragOverColumn, setDragOverColumn] = useState<TaskStatus | null>(null);
  const [newBoardName, setNewBoardName] = useState("");
  const [newBoardDescription, setNewBoardDescription] = useState("");
  const [creatingBoard, setCreatingBoard] = useState(false);
  const [creatingTask, setCreatingTask] = useState(false);
  const [updatingTaskId, setUpdatingTaskId] = useState<string | null>(null);
  const [newTask, setNewTask] = useState<NewTaskForm>(EMPTY_FORM);
  const [selectedDocumentId, setSelectedDocumentId] = useState<string>("");
  const [docTaskTitle, setDocTaskTitle] = useState<string>("");
  const [docTaskDeliverablesText, setDocTaskDeliverablesText] = useState<string>("");
  const [creatingFromDocument, setCreatingFromDocument] = useState(false);
  const [selectedWorkflowTemplateKey, setSelectedWorkflowTemplateKey] = useState<string>(
    BOARD_WORKFLOW_TEMPLATES[0]?.key ?? "",
  );
  const [templateTaskTitle, setTemplateTaskTitle] = useState<string>("");
  const [templateTaskDescription, setTemplateTaskDescription] = useState<string>("");
  const [templateTaskLinkedDocumentIdsText, setTemplateTaskLinkedDocumentIdsText] = useState<string>("");
  const [templateTaskDeliverablesText, setTemplateTaskDeliverablesText] = useState<string>("");
  const [selectedTemplateOrganizationId, setSelectedTemplateOrganizationId] = useState<string>("");
  const [selectedTemplateGoalId, setSelectedTemplateGoalId] = useState<string>("");
  const [taskFilterOrganizationId, setTaskFilterOrganizationId] = useState<string>(() => String(searchParams.get("org") || ""));
  const [taskFilterGoalId, setTaskFilterGoalId] = useState<string>(() => String(searchParams.get("goal") || ""));
  const [creatingTemplateTaskMode, setCreatingTemplateTaskMode] = useState<"create" | "run" | null>(null);
  const [runningTaskId, setRunningTaskId] = useState<string | null>(null);
  const [creatingWorkflowForTaskId, setCreatingWorkflowForTaskId] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [showNewTask, setShowNewTask] = useState(false);
  const [newTaskTab, setNewTaskTab] = useState<"quick" | "template" | "document">("quick");
  const [showAgentRow, setShowAgentRow] = useState(false);
  const [showBoardCreate, setShowBoardCreate] = useState(false);
  const [hideGettingStarted, setHideGettingStarted] = useState(false);
  const [quickFilter, setQuickFilter] = useState<QuickFilter>("all");
  const [savedViews, setSavedViews] = useState<SavedView[]>([]);
  const [boardNotice, setBoardNotice] = useState<BoardNotice | null>(null);
  const [saveViewOpen, setSaveViewOpen] = useState(false);
  const [saveViewName, setSaveViewName] = useState("");
  const [clearViewsOpen, setClearViewsOpen] = useState(false);
  const [deleteBoardOpen, setDeleteBoardOpen] = useState(false);
  const [deletingBoard, setDeletingBoard] = useState(false);
  const [deleteTaskId, setDeleteTaskId] = useState<string | null>(null);
  const [deletingTaskId, setDeletingTaskId] = useState<string | null>(null);
  const requestedDocumentId = useMemo(
    () => String(searchParams.get("documentId") || "").trim(),
    [searchParams],
  );

  const loadBoards = async () => {
    const json = await cachedJson<any>("boards", "/api/boards", APP_TTL.boards);
    if (!json.success) return;
    const next = (json.data ?? []) as Board[];
    setBoards(next);
    setLastSyncedAt(new Date().toISOString());
    setSelectedBoardId((current) =>
      current && next.some((board) => board.id === current)
        ? current
        : (next[0]?.id ?? ""),
    );
  };

  const loadTasks = async (boardId: string, filters?: { organizationId?: string; goalId?: string }) => {
    if (!boardId) {
      setTasks([]);
      return;
    }
    const params = new URLSearchParams({ boardId });
    if (filters?.organizationId) params.set("organizationId", filters.organizationId);
    if (filters?.goalId) params.set("goalId", filters.goalId);
    const cacheKey = `boards/tasks:${params.toString()}`;
    const json = await cachedJson<any>(cacheKey, `/api/boards/tasks?${params.toString()}`, 5_000);
    if (!json.success) return;
    setTasks((json.data ?? []) as Task[]);
    setLastSyncedAt(new Date().toISOString());
  };

  const loadAgents = async () => {
    const [agentsJson, rolesJson] = await Promise.all([
      cachedJson<any>("agents", "/api/agents", APP_TTL.agents),
      cachedJson<any>("agents/roles", "/api/agents/roles", 15_000),
    ]);
    if (!agentsJson.success) return;
    const roles = ((rolesJson?.data ?? []) as AgentRoleRecord[]).reduce<Record<string, AgentRoleRecord>>((acc, role) => {
      acc[role.agentId] = role;
      return acc;
    }, {});
    setAgents(
      (((agentsJson.data?.agents ?? []) as Agent[]) || []).map((agent) => ({
        ...agent,
        roleType: roles[agent.id]?.roleType ?? null,
        roleTitle: roles[agent.id]?.roleTitle ?? null,
      })),
    );
  };

  const loadDocuments = async () => {
    const json = await cachedJson<any>("documents:100", "/api/documents?limit=100", APP_TTL.documents);
    if (!json.success) return;
    setDocuments((json.data ?? []) as DocumentItem[]);
  };

  const loadOrganizations = async () => {
    const json = await cachedJson<any>("hierarchy/organizations", "/api/hierarchy/organizations", APP_TTL["hierarchy/organizations"]);
    if (!json.success) return;
    const next = (json.data?.organizations ?? []) as OrganizationOption[];
    const activeId = String(json.data?.activeOrganizationId ?? next.find((item) => item.isActive)?.id ?? "");
    setOrganizations(next);
    setSelectedTemplateOrganizationId((current) =>
      current && next.some((item) => item.id === current) ? current : activeId,
    );
    setNewTask((current) => ({
      ...current,
      organizationId: current.organizationId || activeId,
    }));
  };

  const loadGoals = async () => {
    const json = await cachedJson<any>("hierarchy/goals", "/api/hierarchy/goals", APP_TTL["hierarchy/goals"]);
    if (!json.success) return;
    setGoals((json.data ?? []) as GoalOption[]);
  };

  // Shell-first: critical boards render immediately, enrichment in background
  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        await loadBoards();
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Defer agents/documents/orgs/goals until after Boards has painted the Kanban
  // columns. These power the New Task form pickers, not the columns themselves.
  useAfterUseful(() => {
    void (async () => {
      await Promise.allSettled([
        (async () => { try { await loadAgents(); } catch {} })(),
        (async () => { try { await loadDocuments(); } catch {} })(),
        (async () => { try { await loadOrganizations(); } catch {} })(),
        (async () => { try { await loadGoals(); } catch {} })(),
      ]);
    })();
  }, []);

  useEffect(() => {
    const saved = readBoardsUiState();
    setHideGettingStarted(Boolean(saved.hideGettingStarted));
    if (saved.quickFilter) setQuickFilter(saved.quickFilter);
    if (Array.isArray(saved.savedViews)) setSavedViews(saved.savedViews);
  }, []);

  useEffect(() => {
    writeBoardsUiState({ hideGettingStarted, quickFilter, savedViews });
  }, [hideGettingStarted, quickFilter, savedViews]);

  // Apply ?org= and ?goal= URL params to filter state (from "View in Boards" deep-links)
  useEffect(() => {
    const orgParam = String(searchParams.get("org") || "").trim();
    const goalParam = String(searchParams.get("goal") || "").trim();
    if (orgParam) setTaskFilterOrganizationId(orgParam);
    if (goalParam) setTaskFilterGoalId(goalParam);
  }, [searchParams]);

  useEffect(() => {
    if (!requestedDocumentId) return;
    setShowNewTask(true);
    setNewTaskTab("document");
  }, [requestedDocumentId]);

  useEffect(() => {
    if (!requestedDocumentId || documents.length === 0) return;
    const matched = documents.find((document) => document.id === requestedDocumentId);
    if (!matched) return;
    setSelectedDocumentId((current) => current || matched.id);
    setDocTaskTitle((current) => current || `Review document: ${matched.name}`);
  }, [documents, requestedDocumentId]);

  // Initial task load is gated behind useful-ready so the Kanban columns
  // can paint before /api/boards/tasks fires. Filter/board changes after the
  // first mount continue to fire immediately for snappy filtering.
  const tasksLoadedOnceRef = useRef(false);
  useEffect(() => {
    if (!tasksLoadedOnceRef.current) return;
    void loadTasks(selectedBoardId, {
      organizationId: taskFilterOrganizationId || undefined,
      goalId: taskFilterGoalId || undefined,
    });
  }, [selectedBoardId, taskFilterOrganizationId, taskFilterGoalId]);
  useAfterUseful(() => {
    tasksLoadedOnceRef.current = true;
    void loadTasks(selectedBoardId, {
      organizationId: taskFilterOrganizationId || undefined,
      goalId: taskFilterGoalId || undefined,
    });
  }, []);

  usePolling(
    async () => {
      if (!selectedBoardId) return;
      await loadTasks(selectedBoardId, {
        organizationId: taskFilterOrganizationId || undefined,
        goalId: taskFilterGoalId || undefined,
      });
      await loadBoards();
    },
    [selectedBoardId, taskFilterOrganizationId, taskFilterGoalId],
    { intervalMs: 5000, enabled: Boolean(selectedBoardId), pauseWhenHidden: true, backoffOnError: true, immediate: false },
  );

  const selectedBoard = useMemo(
    () => boards.find((board) => board.id === selectedBoardId) ?? null,
    [boards, selectedBoardId],
  );
  const workflowTemplateByKey = useMemo(
    () => new Map(BOARD_WORKFLOW_TEMPLATES.map((template) => [template.key, template])),
    [],
  );
  const organizationById = useMemo(
    () => new Map(organizations.map((organization) => [organization.id, organization])),
    [organizations],
  );
  const goalById = useMemo(() => new Map(goals.map((goal) => [goal.id, goal])), [goals]);
  const documentById = useMemo(() => new Map(documents.map((document) => [document.id, document])), [documents]);
  const filteredGoalsForTaskForm = useMemo(
    () => goals.filter((goal) => !newTask.organizationId || goal.organizationId === newTask.organizationId),
    [goals, newTask.organizationId],
  );
  const filteredGoalsForTemplate = useMemo(
    () => goals.filter((goal) => !selectedTemplateOrganizationId || goal.organizationId === selectedTemplateOrganizationId),
    [goals, selectedTemplateOrganizationId],
  );
  const filteredGoalsForTaskFilter = useMemo(
    () => goals.filter((goal) => !taskFilterOrganizationId || goal.organizationId === taskFilterOrganizationId),
    [goals, taskFilterOrganizationId],
  );
  const selectedWorkflowTemplate = workflowTemplateByKey.get(selectedWorkflowTemplateKey) ?? null;
  const forcedDocumentFlow = Boolean(requestedDocumentId);
  const visibleNewTaskTab: "quick" | "template" | "document" = forcedDocumentFlow ? "document" : newTaskTab;
  const newTaskPanelOpen = showNewTask || forcedDocumentFlow;

  const defaultAgentId = useMemo(
    () => agents.find((a) => a.isDefault && a.isActive)?.id ?? agents.find((a) => a.isActive)?.id ?? null,
    [agents],
  );

  const filteredTasks = useMemo(() => {
    if (quickFilter === "all") return tasks;
    return tasks.filter((task) => {
      switch (quickFilter) {
        case "mine":
          return defaultAgentId ? task.assignedAgentId === defaultAgentId : false;
        case "blocked":
          return task.status === "blocked";
        case "runnable":
          return Boolean(task.workflowTemplateKey || task.workflowId);
        case "review":
          return task.status === "review";
        default:
          return true;
      }
    });
  }, [tasks, quickFilter, defaultAgentId]);

  const tasksByStatus = useMemo(() => {
    const out: Record<TaskStatus, Task[]> = {
      inbox: [],
      in_progress: [],
      review: [],
      blocked: [],
      done: [],
    };
    for (const task of filteredTasks) {
      const col = out[task.status];
      if (col) col.push(task);
    }
    return out;
  }, [filteredTasks]);

  const filtersActive = Boolean(taskFilterOrganizationId || taskFilterGoalId || quickFilter !== "all");
  const filtersHideAllTasks = filtersActive && tasks.length > 0 && filteredTasks.length === 0;
  const selectedBoardTaskCount = selectedBoard?.taskCount ?? tasks.length;
  const boardHasNoTasks = selectedBoardTaskCount === 0 && tasks.length === 0 && filteredTasks.length === 0;

  const onCreateBoard = async () => {
    const name = newBoardName.trim();
    if (!name) return;
    setCreatingBoard(true);
    try {
      const res = await fetch("/api/boards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          description: newBoardDescription.trim() || null,
        }),
      });
      const json = await res.json();
      if (!json.success) return;
      setNewBoardName("");
      setNewBoardDescription("");
      invalidateCache(/^boards/);
      await loadBoards();
      setSelectedBoardId(json.data.id as string);
    } finally {
      setCreatingBoard(false);
    }
  };

  const onDeleteBoard = async () => {
    if (!selectedBoardId) return;
    setDeletingBoard(true);
    setBoardNotice(null);
    try {
      await fetch(`/api/boards?id=${encodeURIComponent(selectedBoardId)}`, { method: "DELETE" });
      invalidateCache(/^boards/);
      await loadBoards();
      setDeleteBoardOpen(false);
      setBoardNotice({ tone: "success", message: "Board deleted." });
    } catch (error) {
      setBoardNotice({ tone: "error", message: `Delete failed: ${String(error)}` });
    } finally {
      setDeletingBoard(false);
    }
  };

  const onCreateTask = async () => {
    if (!selectedBoardId || !newTask.title.trim()) return;
    setCreatingTask(true);
    try {
      await fetch("/api/boards/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          boardId: selectedBoardId,
          title: newTask.title.trim(),
          description: newTask.description.trim() || null,
          organizationId: newTask.organizationId || null,
          goalId: newTask.goalId || null,
          linkedDocumentIds: parseListText(newTask.linkedDocumentIdsText),
          deliverables: parseListText(newTask.deliverablesText),
          status: newTask.status,
          priority: newTask.priority,
          assignedAgentId: newTask.assignedAgentId || null,
        }),
      });
      setNewTask(EMPTY_FORM);
      invalidateCache(/^boards/);
      await loadTasks(selectedBoardId, {
        organizationId: taskFilterOrganizationId || undefined,
        goalId: taskFilterGoalId || undefined,
      });
      await loadBoards();
    } finally {
      setCreatingTask(false);
    }
  };

  const updateTask = async (taskId: string, patch: Partial<Task>) => {
    setUpdatingTaskId(taskId);
    try {
      await fetch("/api/boards/tasks", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: taskId,
          status: patch.status,
          priority: patch.priority,
          assignedAgentId:
            patch.assignedAgentId !== undefined ? patch.assignedAgentId : undefined,
        }),
      });
      invalidateCache(/^boards/);
      await loadTasks(selectedBoardId, {
        organizationId: taskFilterOrganizationId || undefined,
        goalId: taskFilterGoalId || undefined,
      });
      await loadBoards();
    } finally {
      setUpdatingTaskId(null);
    }
  };

  const deleteTask = async (taskId: string) => {
    setDeletingTaskId(taskId);
    setBoardNotice(null);
    try {
      await fetch(`/api/boards/tasks?id=${encodeURIComponent(taskId)}`, { method: "DELETE" });
      invalidateCache(/^boards/);
      await loadTasks(selectedBoardId);
      await loadBoards();
      setDeleteTaskId(null);
      setBoardNotice({ tone: "success", message: "Task deleted." });
    } catch (error) {
      setBoardNotice({ tone: "error", message: `Task delete failed: ${String(error)}` });
    } finally {
      setDeletingTaskId(null);
    }
  };

  const onCreateTaskFromDocument = async () => {
    if (!selectedBoardId || !selectedDocumentId) return;
    const selectedDocument = documents.find((doc) => doc.id === selectedDocumentId);
    if (!selectedDocument) return;

    setCreatingFromDocument(true);
    try {
      const title = docTaskTitle.trim() || `Review document: ${selectedDocument.name}`;
      const sourceLine = selectedDocument.sourceUrl
        ? `Source URL: ${selectedDocument.sourceUrl}\n`
        : "";
      const description =
        `Document source: ${selectedDocument.id}\n` +
        `${sourceLine}` +
        `\nExtract:\n${selectedDocument.excerpt || "(no excerpt)"}`;

      await fetch("/api/boards/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          boardId: selectedBoardId,
          title: title.slice(0, 160),
          description,
          sourceType: "data-source",
          sourceRef: selectedDocument.id,
          linkedDocumentIds: [selectedDocument.id],
          deliverables: parseListText(docTaskDeliverablesText),
          status: "inbox",
          priority: "medium",
          assignedAgentId: null,
        }),
      });

      setDocTaskTitle("");
      setDocTaskDeliverablesText("");
      invalidateCache(/^boards/);
      await loadTasks(selectedBoardId, {
        organizationId: taskFilterOrganizationId || undefined,
        goalId: taskFilterGoalId || undefined,
      });
      await loadBoards();
    } finally {
      setCreatingFromDocument(false);
    }
  };

  const runWorkflowTask = async (taskId: string) => {
    setRunningTaskId(taskId);
    try {
      const res = await fetch("/api/boards/tasks/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: taskId }),
      });
      const json = await res.json();
      if (!json.success) {
        throw new Error(json.error || "Failed to run workflow task.");
      }
      invalidateCache(/^boards/);
      await loadTasks(selectedBoardId, {
        organizationId: taskFilterOrganizationId || undefined,
        goalId: taskFilterGoalId || undefined,
      });
      await loadBoards();
      const workflowName = String(json.data?.workflowName || "workflow");
      const executionId = String(json.data?.executionId || "");
      const response = String(json.data?.response || "").trim();
      const message = [
        `Started ${workflowName}${executionId ? ` (${executionId})` : ""}.`,
        response ? `\n${response}` : "",
      ].join("");
      setBoardNotice({ tone: "success", message });
    } catch (error) {
      setBoardNotice({ tone: "error", message: String(error) });
    } finally {
      setRunningTaskId(null);
    }
  };

  const createLinkedWorkflow = async (task: Task) => {
    setCreatingWorkflowForTaskId(task.id);
    try {
      const workflowName = `Task: ${task.title}`.slice(0, 120);
      const createRes = await fetch("/api/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: workflowName,
          template: "general-task-executor",
          organizationId: task.organizationId ?? null,
          goalId: task.goalId ?? null,
          description: task.description ?? `Workflow linked from board task ${task.id}`,
        }),
      });
      const createJson = await createRes.json();
      if (!createJson.success) {
        throw new Error(createJson.error || "Failed to create workflow.");
      }
      const newWorkflowId = String(createJson.data?.id || "");
      if (!newWorkflowId) {
        throw new Error("Workflow created but no id returned.");
      }
      const patchRes = await fetch("/api/boards/tasks", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: task.id,
          workflowId: newWorkflowId,
        }),
      });
      const patchJson = await patchRes.json();
      if (!patchJson.success) {
        // Workflow was created but link failed — surface but do not rollback
        setBoardNotice({
          tone: "error",
          message: `Workflow created (${newWorkflowId}) but failed to link: ${patchJson.error || "unknown error"}`,
        });
      } else {
        setBoardNotice({ tone: "success", message: `Workflow created and linked to "${task.title}".` });
      }
      invalidateCache(/^boards/);
      invalidateCache(/^workflows/);
      await loadTasks(selectedBoardId, {
        organizationId: taskFilterOrganizationId || undefined,
        goalId: taskFilterGoalId || undefined,
      });
    } catch (error) {
      setBoardNotice({ tone: "error", message: String(error) });
    } finally {
      setCreatingWorkflowForTaskId(null);
    }
  };

  const onCreateWorkflowTemplateTask = async (runImmediately: boolean) => {
    if (!selectedBoardId || !selectedWorkflowTemplateKey) return;
    const template = workflowTemplateByKey.get(selectedWorkflowTemplateKey);
    if (!template) return;

    setCreatingTemplateTaskMode(runImmediately ? "run" : "create");
    try {
      const title = templateTaskTitle.trim() || `Run ${template.name}`;
      const descriptionParts = [templateTaskDescription.trim(), `Workflow template: ${template.key}`]
        .filter(Boolean);

      const res = await fetch("/api/boards/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          boardId: selectedBoardId,
          organizationId: selectedTemplateOrganizationId || null,
          goalId: selectedTemplateGoalId || null,
          title: title.slice(0, 160),
          description: descriptionParts.join("\n\n") || null,
          workflowTemplateKey: template.key,
          linkedDocumentIds: parseListText(templateTaskLinkedDocumentIdsText),
          deliverables: parseListText(templateTaskDeliverablesText),
          status: "inbox",
          priority: "medium",
        }),
      });
      const json = await res.json();
      if (!json.success) {
        throw new Error(json.error || "Failed to create workflow template task.");
      }

      setTemplateTaskTitle("");
      setTemplateTaskDescription("");
      setTemplateTaskLinkedDocumentIdsText("");
      setTemplateTaskDeliverablesText("");
      invalidateCache(/^boards/);
      await loadTasks(selectedBoardId, {
        organizationId: taskFilterOrganizationId || undefined,
        goalId: taskFilterGoalId || undefined,
      });
      await loadBoards();

      if (runImmediately && json.data?.id) {
        await runWorkflowTask(String(json.data.id));
      }
    } catch (error) {
      setBoardNotice({ tone: "error", message: String(error) });
    } finally {
      setCreatingTemplateTaskMode(null);
    }
  };

  const saveCurrentView = () => {
    const trimmed = saveViewName.trim().slice(0, 60);
    if (!trimmed) return;
    setSavedViews((current) => {
      const next = current.filter((view) => view.name !== trimmed);
      next.unshift({
        name: trimmed,
        boardId: selectedBoardId,
        organizationId: taskFilterOrganizationId,
        goalId: taskFilterGoalId,
        quickFilter,
      });
      return next.slice(0, 12);
    });
    setSaveViewName("");
    setSaveViewOpen(false);
    setBoardNotice({ tone: "success", message: `Saved view "${trimmed}".` });
  };

  const clearSavedViews = () => {
    setSavedViews([]);
    setClearViewsOpen(false);
    setBoardNotice({ tone: "info", message: "Saved views cleared." });
  };

  const recentAgentScore = useMemo(() => {
    const scores = new Map<string, number>();
    const now = Date.now();
    for (const task of tasks) {
      const targetAgentId = task.checkedOutByAgentId || task.assignedAgentId;
      if (!targetAgentId) continue;
      const ageHours = Math.max(0, (now - new Date(task.updatedAt).getTime()) / (60 * 60 * 1000));
      const recencyWeight = Math.max(0.2, 24 - Math.min(ageHours, 24)) / 24;
      const statusWeight =
        task.status === "in_progress" ? 1.4 : task.status === "review" ? 1.2 : task.status === "inbox" ? 1 : 0.5;
      scores.set(targetAgentId, (scores.get(targetAgentId) ?? 0) + recencyWeight * statusWeight);
    }
    return scores;
  }, [tasks]);

  const activeAgents = useMemo(() => {
    return [...agents]
      .filter((agent) => agent.isActive)
      .sort((a, b) => {
        const scoreDiff = (recentAgentScore.get(b.id) ?? 0) - (recentAgentScore.get(a.id) ?? 0);
        if (Math.abs(scoreDiff) > 0.001) return scoreDiff;
        if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  }, [agents, recentAgentScore]);

  const recentAssignees = useMemo(
    () => activeAgents.filter((agent) => (recentAgentScore.get(agent.id) ?? 0) > 0).slice(0, 4),
    [activeAgents, recentAgentScore],
  );

  const statusCountForAgent = (agentId: string, status: TaskStatus) =>
    tasks.filter((task) => task.assignedAgentId === agentId && task.status === status).length;

  const columnAccent: Record<TaskStatus, string> = {
    inbox: "bg-terminal-red",
    in_progress: "bg-amber-500",
    review: "bg-blue-500",
    blocked: "bg-violet-500",
    done: "bg-foreground/60",
  };

  const priorityStrip: Record<string, string> = {
    high: "bg-terminal-red",
    medium: "bg-amber-500",
    low: "bg-muted-foreground/30",
  };

  return (
        <main className="flex-1 overflow-auto bg-background grid-bg" data-perf-ready="boards">

          <div className="px-6 pt-3">
</div>

          {boardNotice ? (
            <div
              className={`mx-6 mt-3 flex items-start justify-between gap-3 border px-3 py-2 text-sm ${
                boardNotice.tone === "error"
                  ? "border-destructive/40 bg-destructive/10 text-destructive"
                  : boardNotice.tone === "success"
                    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                    : "border-blue-500/40 bg-blue-500/10 text-blue-300"
              }`}
            >
              <span className="whitespace-pre-wrap">{boardNotice.message}</span>
              <button
                type="button"
                className="shrink-0 opacity-70 transition-opacity hover:opacity-100"
                onClick={() => setBoardNotice(null)}
                aria-label="Dismiss board notice"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ) : null}

          {/* ── Compact Top Toolbar ── */}
          <div className="border-b border-border px-6 py-3">
            <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
              <div className="flex items-center gap-3">
                <div className="h-8 w-1 bg-terminal-red" />
                <div>
                  <h1 className="font-display text-xl font-bold tracking-tight uppercase">Board</h1>
                  <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-widest">
                    Kanban // {lastSyncedAt ? `synced ${new Date(lastSyncedAt).toLocaleTimeString()}` : "live"}
                  </p>
                </div>
              </div>

              <div className="flex w-full flex-wrap items-center gap-2 xl:w-auto xl:justify-end">
                {/* Board selector */}
                <select
                  className="h-8 border border-border bg-card px-3 text-xs font-mono uppercase tracking-wider focus:border-terminal-red focus:outline-none"
                  value={selectedBoardId}
                  onChange={(event) => setSelectedBoardId(event.target.value)}
                >
                  {boards.map((board) => (
                    <option key={board.id} value={board.id}>
                      {board.name} ({board.taskCount})
                    </option>
                  ))}
                </select>

                {/* Org filter */}
                <select
                  className="h-8 border border-border bg-card px-2 text-[10px] font-mono uppercase tracking-wider focus:border-terminal-red focus:outline-none"
                  value={taskFilterOrganizationId}
                  onChange={(event) => {
                    setTaskFilterOrganizationId(event.target.value);
                    setTaskFilterGoalId("");
                  }}
                >
                  <option value="">All orgs</option>
                  {organizations.map((organization) => (
                    <option key={organization.id} value={organization.id}>
                      {organization.name}
                    </option>
                  ))}
                </select>

                {/* Goal filter */}
                <select
                  className="h-8 border border-border bg-card px-2 text-[10px] font-mono uppercase tracking-wider focus:border-terminal-red focus:outline-none"
                  value={taskFilterGoalId}
                  onChange={(event) => setTaskFilterGoalId(event.target.value)}
                >
                  <option value="">All goals</option>
                  {filteredGoalsForTaskFilter.map((goal) => (
                    <option key={goal.id} value={goal.id}>
                      {goal.name}
                    </option>
                  ))}
                </select>

                {/* Task count badge */}
                <Badge variant="outline" className="text-[10px] uppercase tracking-widest border-terminal-red/40 text-terminal-red font-mono tabular-nums">
                  {tasks.length} TASKS
                </Badge>

                <button
                  className={`h-8 border px-3 text-[10px] font-mono uppercase tracking-wider transition-colors ${
                    hideGettingStarted
                      ? "border-border text-muted-foreground hover:border-terminal-red hover:text-terminal-red"
                      : "border-terminal-red/50 text-terminal-red hover:bg-terminal-red/10"
                  }`}
                  onClick={() => setHideGettingStarted((current) => !current)}
                  title={hideGettingStarted ? "Show first-time guidance" : "Hide first-time guidance"}
                >
                  {hideGettingStarted ? "Show Tips" : "Hide Tips"}
                </button>

                {/* View in Hierarchy shortcut — only when goal is filtered */}
                {taskFilterGoalId && (
                  <>
                    <button
                      className="h-8 border border-blue-500/40 px-3 text-[10px] font-mono uppercase tracking-wider text-blue-400 hover:bg-blue-500/10 transition-colors"
                      onClick={() => {
                        const params = new URLSearchParams();
                        if (taskFilterOrganizationId) params.set("org", taskFilterOrganizationId);
                        if (taskFilterGoalId) params.set("goal", taskFilterGoalId);
                        router.push(`/hierarchy?${params.toString()}`);
                      }}
                      title="Open this goal in Hierarchy tab"
                    >
                      ↗ Hierarchy
                    </button>
                    <button
                      className="h-8 border border-emerald-500/40 px-3 text-[10px] font-mono uppercase tracking-wider text-emerald-400 hover:bg-emerald-500/10 transition-colors"
                      onClick={() => {
                        const params = new URLSearchParams();
                        if (taskFilterOrganizationId) params.set("org", taskFilterOrganizationId);
                        if (taskFilterGoalId) params.set("goal", taskFilterGoalId);
                        router.push(`/workflows?${params.toString()}`);
                      }}
                      title="Open related workflows for this goal"
                    >
                      ↗ Workflows
                    </button>
                    <button
                      className="h-8 border border-amber-500/40 px-3 text-[10px] font-mono uppercase tracking-wider text-amber-300 hover:bg-amber-500/10 transition-colors"
                      onClick={() => {
                        const params = new URLSearchParams();
                        if (taskFilterOrganizationId) params.set("org", taskFilterOrganizationId);
                        if (taskFilterGoalId) params.set("goal", taskFilterGoalId);
                        router.push(`/council?${params.toString()}`);
                      }}
                      title="Open council scoped to this goal"
                    >
                      ↗ Council
                    </button>
                  </>
                )}

                {/* Agent summary toggle */}
                <button
                  className={`h-8 border px-3 text-[10px] font-mono uppercase tracking-wider transition-colors ${
                    showAgentRow ? "border-terminal-red text-terminal-red bg-terminal-red/5" : "border-border text-muted-foreground hover:border-terminal-red hover:text-terminal-red"
                  }`}
                  onClick={() => setShowAgentRow(!showAgentRow)}
                >
                  Agents ({activeAgents.length})
                </button>

                {/* New Task toggle */}
                <button
                  className={`flex h-11 items-center gap-2 border px-5 text-sm font-mono font-bold uppercase tracking-wider shadow-sm transition-colors ${
                    newTaskPanelOpen
                      ? "border-terminal-red bg-terminal-red/15 text-terminal-red shadow-terminal-red/10"
                      : "border-terminal-red bg-terminal-red text-white hover:bg-terminal-red/90"
                  }`}
                  onClick={() => setShowNewTask(!showNewTask)}
                  aria-pressed={newTaskPanelOpen}
                >
                  <Plus className="h-4 w-4" />
                  New Task
                </button>

                {/* Board management */}
                <button
                  className="h-8 border border-border px-2 text-[10px] font-mono uppercase tracking-wider text-muted-foreground hover:border-terminal-red hover:text-terminal-red transition-colors"
                  onClick={() => setShowBoardCreate(!showBoardCreate)}
                >
                  Boards
                </button>

                {/* Refresh */}
                <button
                  className="h-8 border border-border px-3 text-[10px] font-mono uppercase tracking-wider text-muted-foreground hover:border-terminal-red hover:text-terminal-red transition-colors"
                  onClick={() =>
                    void loadTasks(selectedBoardId, {
                      organizationId: taskFilterOrganizationId || undefined,
                      goalId: taskFilterGoalId || undefined,
                    })
                  }
                >
                  Refresh
                </button>
              </div>
            </div>
          </div>

          {/* ── Agent Summary Row (collapsible) ── */}
          {showAgentRow ? (
            <div className="border-b border-border px-6 py-3">
              <div className="flex items-center gap-4 overflow-x-auto">
                {activeAgents.map((agent) => {
                  const agentTaskCount = tasks.filter((t) => t.assignedAgentId === agent.id).length;
                  const isRecent = (recentAgentScore.get(agent.id) ?? 0) > 0;
                  return (
                    <div
                      key={agent.id}
                      className={`flex items-center gap-2 border px-3 py-1.5 shrink-0 ${
                        isRecent ? "border-terminal-red/40" : "border-border"
                      }`}
                    >
                      <ShapeAvatar seed={agent.id} size={22} />
                      <div className="min-w-0">
                        <div className="text-[10px] font-mono font-medium uppercase tracking-wider truncate max-w-[100px]">
                          {agent.name}
                        </div>
                        {agent.roleTitle ? (
                          <div className="text-[9px] text-muted-foreground truncate max-w-[100px]">{agent.roleTitle}</div>
                        ) : null}
                      </div>
                      <div className="flex items-center gap-1.5 text-[9px] font-mono text-muted-foreground">
                        <span className="tabular-nums">{statusCountForAgent(agent.id, "inbox")}i</span>
                        <span className="tabular-nums">{statusCountForAgent(agent.id, "in_progress")}p</span>
                        <span className="tabular-nums">{statusCountForAgent(agent.id, "review")}r</span>
                      </div>
                      {agentTaskCount > 0 ? (
                        <span className="text-[9px] font-mono font-bold text-terminal-red tabular-nums">{agentTaskCount}</span>
                      ) : null}
                      {agent.roleType ? (
                        <Badge variant="outline" className="text-[8px] px-1 py-0 border-border/50">{agent.roleType}</Badge>
                      ) : null}
                    </div>
                  );
                })}
              </div>
              {recentAssignees.length > 0 ? (
                <div className="mt-2 flex items-center gap-2">
                  <span className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground">RECENT:</span>
                  {recentAssignees.map((agent) => (
                    <span key={`recent-${agent.id}`} className="text-[10px] font-mono text-terminal-red">
                      {agent.name}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          {/* ── Board Create Panel (collapsible) ── */}
          {showBoardCreate ? (
            <div className="border-b border-border px-6 py-3">
              <div className="flex flex-wrap items-center gap-3">
                <span className="data-label text-muted-foreground">NEW BOARD</span>
                <Input
                  placeholder="Board name"
                  className="h-8 max-w-[200px] border-border bg-card text-xs font-mono"
                  value={newBoardName}
                  onChange={(event) => setNewBoardName(event.target.value)}
                />
                <Input
                  placeholder="Description (optional)"
                  className="h-8 max-w-[300px] border-border bg-card text-xs font-mono"
                  value={newBoardDescription}
                  onChange={(event) => setNewBoardDescription(event.target.value)}
                />
                <button
                  className="h-8 border border-terminal-red/60 px-3 text-[10px] font-mono font-bold uppercase tracking-wider text-terminal-red hover:bg-terminal-red/10 transition-colors disabled:opacity-40"
                  onClick={onCreateBoard}
                  disabled={creatingBoard || !newBoardName.trim()}
                >
                  {creatingBoard ? "CREATING..." : "CREATE"}
                </button>
                <button
                  className="h-8 border border-terminal-red px-3 text-[10px] font-mono font-bold uppercase tracking-wider text-terminal-red hover:bg-terminal-red/10 transition-colors disabled:opacity-40"
                  onClick={() => setDeleteBoardOpen(true)}
                  disabled={!selectedBoard}
                >
                  DELETE BOARD
                </button>
              </div>
            </div>
          ) : null}

          {/* ── Collapsible New Task Panel ── */}
          {newTaskPanelOpen ? (
            <div className="border-b border-border px-6 py-4">
              {/* Tab selector */}
              <div className="mb-4 flex flex-wrap items-center gap-0">
                {([
                  { key: "quick" as const, label: "QUICK TASK" },
                  { key: "template" as const, label: "FROM TEMPLATE" },
                  { key: "document" as const, label: "FROM DOCUMENT" },
                ] as const).map((tab) => (
                  <button
                    key={tab.key}
                    className={`h-8 border px-4 text-[10px] font-mono font-bold uppercase tracking-widest transition-colors ${
                      visibleNewTaskTab === tab.key
                        ? "border-terminal-red bg-terminal-red/10 text-terminal-red"
                        : "border-border text-muted-foreground hover:text-terminal-red hover:border-terminal-red/40"
                    } ${tab.key === "quick" ? "" : "-ml-px"}`}
                    onClick={() => setNewTaskTab(tab.key)}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              {/* Quick Task tab */}
              {visibleNewTaskTab === "quick" ? (
                <div className="space-y-3">
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
                    <div className="space-y-1 lg:col-span-2">
                      <span className="data-label text-muted-foreground">TITLE</span>
                      <Input
                        value={newTask.title}
                        placeholder="Implement feature"
                        className="h-8 border-border bg-card text-xs font-mono"
                        onChange={(event) =>
                          setNewTask((current) => ({ ...current, title: event.target.value }))
                        }
                      />
                    </div>
                    <div className="space-y-1">
                      <span className="data-label text-muted-foreground">AGENT</span>
                      <select
                        className="h-8 w-full border border-border bg-card px-2 text-[10px] font-mono uppercase tracking-wider focus:border-terminal-red focus:outline-none"
                        value={newTask.assignedAgentId}
                        onChange={(event) =>
                          setNewTask((current) => ({ ...current, assignedAgentId: event.target.value }))
                        }
                      >
                        <option value="">Unassigned</option>
                        {activeAgents.map((agent) => (
                          <option key={agent.id} value={agent.id}>
                            {agent.name}
                            {agent.roleTitle ? ` - ${agent.roleTitle}` : ""}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-1">
                      <span className="data-label text-muted-foreground">STATUS</span>
                      <select
                        className="h-8 w-full border border-border bg-card px-2 text-[10px] font-mono uppercase tracking-wider focus:border-terminal-red focus:outline-none"
                        value={newTask.status}
                        onChange={(event) =>
                          setNewTask((current) => ({ ...current, status: event.target.value as TaskStatus }))
                        }
                      >
                        {COLUMNS.map((column) => (
                          <option key={column.status} value={column.status}>{column.label}</option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-1">
                      <span className="data-label text-muted-foreground">PRIORITY</span>
                      <select
                        className="h-8 w-full border border-border bg-card px-2 text-[10px] font-mono uppercase tracking-wider focus:border-terminal-red focus:outline-none"
                        value={newTask.priority}
                        onChange={(event) =>
                          setNewTask((current) => ({
                            ...current,
                            priority: event.target.value as "low" | "medium" | "high",
                          }))
                        }
                      >
                        <option value="low">Low</option>
                        <option value="medium">Medium</option>
                        <option value="high">High</option>
                      </select>
                    </div>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <div className="space-y-1">
                      <span className="data-label text-muted-foreground">ORGANIZATION</span>
                      <select
                        className="h-8 w-full border border-border bg-card px-2 text-[10px] font-mono uppercase tracking-wider focus:border-terminal-red focus:outline-none"
                        value={newTask.organizationId}
                        onChange={(event) =>
                          setNewTask((current) => ({
                            ...current,
                            organizationId: event.target.value,
                            goalId:
                              event.target.value && current.goalId && goalById.get(current.goalId)?.organizationId !== event.target.value
                                ? ""
                                : current.goalId,
                          }))
                        }
                      >
                        <option value="">No organization</option>
                        {organizations.map((organization) => (
                          <option key={organization.id} value={organization.id}>
                            {organization.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-1">
                      <span className="data-label text-muted-foreground">GOAL</span>
                      <select
                        className="h-8 w-full border border-border bg-card px-2 text-[10px] font-mono uppercase tracking-wider focus:border-terminal-red focus:outline-none"
                        value={newTask.goalId}
                        onChange={(event) =>
                          setNewTask((current) => ({ ...current, goalId: event.target.value }))
                        }
                      >
                        <option value="">No goal</option>
                        {filteredGoalsForTaskForm.map((goal) => (
                          <option key={goal.id} value={goal.id}>
                            {goal.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-1 lg:col-span-2">
                      <span className="data-label text-muted-foreground">DESCRIPTION</span>
                      <Textarea
                        rows={1}
                        value={newTask.description}
                        placeholder="Task details"
                        className="border-border bg-card text-xs font-mono min-h-[32px]"
                        onChange={(event) =>
                          setNewTask((current) => ({ ...current, description: event.target.value }))
                        }
                      />
                    </div>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1">
                      <span className="data-label text-muted-foreground">DOCUMENT IDS</span>
                      <Textarea
                        rows={2}
                        value={newTask.linkedDocumentIdsText}
                        placeholder="doc_123, doc_456 or one per line"
                        className="border-border bg-card text-xs font-mono"
                        onChange={(event) =>
                          setNewTask((current) => ({ ...current, linkedDocumentIdsText: event.target.value }))
                        }
                      />
                    </div>
                    <div className="space-y-1">
                      <span className="data-label text-muted-foreground">DELIVERABLES</span>
                      <Textarea
                        rows={2}
                        value={newTask.deliverablesText}
                        placeholder="Summary memo, rollout checklist"
                        className="border-border bg-card text-xs font-mono"
                        onChange={(event) =>
                          setNewTask((current) => ({ ...current, deliverablesText: event.target.value }))
                        }
                      />
                    </div>
                  </div>

                  <div className="flex justify-end">
                    <button
                      className="h-8 border border-terminal-red px-4 text-[10px] font-mono font-bold uppercase tracking-widest text-terminal-red hover:bg-terminal-red/10 transition-colors disabled:opacity-40"
                      onClick={onCreateTask}
                      disabled={!selectedBoardId || !newTask.title.trim() || creatingTask}
                    >
                      {creatingTask ? "ADDING..." : "ADD TASK"}
                    </button>
                  </div>
                </div>
              ) : null}

              {/* From Template tab */}
              {visibleNewTaskTab === "template" ? (
                <div className="space-y-3">
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <div className="space-y-1">
                      <span className="data-label text-muted-foreground">TEMPLATE</span>
                      <select
                        className="h-8 w-full border border-border bg-card px-2 text-[10px] font-mono uppercase tracking-wider focus:border-terminal-red focus:outline-none"
                        value={selectedWorkflowTemplateKey}
                        onChange={(event) => setSelectedWorkflowTemplateKey(event.target.value)}
                      >
                        {BOARD_WORKFLOW_TEMPLATES.map((template) => (
                          <option key={template.key} value={template.key}>
                            {template.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-1">
                      <span className="data-label text-muted-foreground">ORGANIZATION</span>
                      <select
                        className="h-8 w-full border border-border bg-card px-2 text-[10px] font-mono uppercase tracking-wider focus:border-terminal-red focus:outline-none"
                        value={selectedTemplateOrganizationId}
                        onChange={(event) => setSelectedTemplateOrganizationId(event.target.value)}
                      >
                        <option value="">Use active organization</option>
                        {organizations.map((organization) => (
                          <option key={organization.id} value={organization.id}>
                            {organization.name} ({organization.memberCount} members)
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-1">
                      <span className="data-label text-muted-foreground">GOAL</span>
                      <select
                        className="h-8 w-full border border-border bg-card px-2 text-[10px] font-mono uppercase tracking-wider focus:border-terminal-red focus:outline-none"
                        value={selectedTemplateGoalId}
                        onChange={(event) => setSelectedTemplateGoalId(event.target.value)}
                      >
                        <option value="">No goal</option>
                        {filteredGoalsForTemplate.map((goal) => (
                          <option key={goal.id} value={goal.id}>
                            {goal.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-1">
                      <span className="data-label text-muted-foreground">TITLE (OPTIONAL)</span>
                      <Input
                        value={templateTaskTitle}
                        placeholder={selectedWorkflowTemplate ? `Run ${selectedWorkflowTemplate.name}` : "Run workflow template"}
                        className="h-8 border-border bg-card text-xs font-mono"
                        onChange={(event) => setTemplateTaskTitle(event.target.value)}
                      />
                    </div>
                  </div>

                  <div className="space-y-1">
                    <span className="data-label text-muted-foreground">TASK PROMPT / NOTES</span>
                    <Textarea
                      rows={2}
                      value={templateTaskDescription}
                      placeholder={selectedWorkflowTemplate?.description || "What should this workflow do when the task runs?"}
                      className="border-border bg-card text-xs font-mono"
                      onChange={(event) => setTemplateTaskDescription(event.target.value)}
                    />
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1">
                      <span className="data-label text-muted-foreground">DOCUMENT IDS</span>
                      <Textarea
                        rows={2}
                        value={templateTaskLinkedDocumentIdsText}
                        placeholder="Attach reference docs for this workflow task"
                        className="border-border bg-card text-xs font-mono"
                        onChange={(event) => setTemplateTaskLinkedDocumentIdsText(event.target.value)}
                      />
                    </div>
                    <div className="space-y-1">
                      <span className="data-label text-muted-foreground">DELIVERABLES</span>
                      <Textarea
                        rows={2}
                        value={templateTaskDeliverablesText}
                        placeholder="Decision brief, final report, checklist"
                        className="border-border bg-card text-xs font-mono"
                        onChange={(event) => setTemplateTaskDeliverablesText(event.target.value)}
                      />
                    </div>
                  </div>

                  {selectedWorkflowTemplate ? (
                    <p className="text-[10px] text-muted-foreground font-mono">{selectedWorkflowTemplate.description}</p>
                  ) : null}

                  <div className="flex justify-end gap-2">
                    <button
                      className="h-8 border border-border px-4 text-[10px] font-mono font-bold uppercase tracking-widest text-muted-foreground hover:border-terminal-red hover:text-terminal-red transition-colors disabled:opacity-40"
                      onClick={() => void onCreateWorkflowTemplateTask(false)}
                      disabled={!selectedBoardId || !selectedWorkflowTemplateKey || creatingTemplateTaskMode !== null}
                    >
                      {creatingTemplateTaskMode === "create" ? "CREATING..." : "CREATE"}
                    </button>
                    <button
                      className="h-8 border border-terminal-red px-4 text-[10px] font-mono font-bold uppercase tracking-widest text-terminal-red hover:bg-terminal-red/10 transition-colors disabled:opacity-40"
                      onClick={() => void onCreateWorkflowTemplateTask(true)}
                      disabled={!selectedBoardId || !selectedWorkflowTemplateKey || creatingTemplateTaskMode !== null}
                    >
                      {creatingTemplateTaskMode === "run" ? "RUNNING..." : "CREATE & RUN"}
                    </button>
                  </div>
                </div>
              ) : null}

              {/* From Document tab */}
              {visibleNewTaskTab === "document" ? (
                <div className="space-y-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1">
                      <span className="data-label text-muted-foreground">DOCUMENT</span>
                      <select
                        className="h-8 w-full border border-border bg-card px-2 text-[10px] font-mono uppercase tracking-wider focus:border-terminal-red focus:outline-none"
                        value={selectedDocumentId}
                        onChange={(event) => setSelectedDocumentId(event.target.value)}
                      >
                        <option value="">Select document</option>
                        {documents.map((doc) => (
                          <option key={doc.id} value={doc.id}>
                            {doc.name} ({doc.sourceType})
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-1">
                      <span className="data-label text-muted-foreground">TITLE OVERRIDE (OPTIONAL)</span>
                      <Input
                        value={docTaskTitle}
                        placeholder="Prepare summary from this document"
                        className="h-8 border-border bg-card text-xs font-mono"
                        onChange={(event) => setDocTaskTitle(event.target.value)}
                      />
                    </div>
                  </div>

                  <div className="space-y-1">
                    <span className="data-label text-muted-foreground">DELIVERABLES</span>
                    <Textarea
                      rows={2}
                      value={docTaskDeliverablesText}
                      placeholder="What should the agent produce from this document?"
                      className="border-border bg-card text-xs font-mono"
                      onChange={(event) => setDocTaskDeliverablesText(event.target.value)}
                    />
                  </div>

                  <div className="flex justify-end">
                    <button
                      className="h-8 border border-terminal-red px-4 text-[10px] font-mono font-bold uppercase tracking-widest text-terminal-red hover:bg-terminal-red/10 transition-colors disabled:opacity-40"
                      onClick={onCreateTaskFromDocument}
                      disabled={!selectedBoardId || !selectedDocumentId || creatingFromDocument}
                    >
                      {creatingFromDocument ? "ADDING..." : "ADD FROM DOCUMENT"}
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          {/* ── Getting Started panel (empty state) ── */}
          {!loading && tasks.length === 0 && !hideGettingStarted && (
            <div className="mx-4 mt-4 mb-2 border border-slate-600/60 bg-slate-800/40 p-5 space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div className="text-[10px] font-mono uppercase tracking-widest text-slate-400">GETTING STARTED — BOARDS</div>
                <button
                  type="button"
                  className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground transition-colors hover:text-terminal-red"
                  onClick={() => setHideGettingStarted(true)}
                >
                  Dismiss
                </button>
              </div>
              <p className="text-sm text-slate-300 max-w-2xl">
                Boards are your Kanban-style task tracker. Tasks flow through <strong>Inbox → In Progress → Review → Done</strong>. Assign tasks to agents, link them to goals and organizations, and let workflows execute them automatically.
              </p>
              <div className="grid gap-2 sm:grid-cols-3 text-[11px]">
                <div className="border border-slate-700/60 p-3 space-y-1">
                  <div className="font-mono uppercase tracking-wide text-slate-400">Create a Task</div>
                  <div className="text-slate-400">Click <strong className="text-slate-300">+ NEW TASK</strong> in the toolbar above. Give it a title, set priority, and optionally assign it to an agent or link it to a goal.</div>
                </div>
                <div className="border border-slate-700/60 p-3 space-y-1">
                  <div className="font-mono uppercase tracking-wide text-slate-400">From Templates</div>
                  <div className="text-slate-400">Use the <strong className="text-slate-300">From Template</strong> tab in the new-task form to create tasks tied to workflow templates. The agent runs the template when the task is started.</div>
                </div>
                <div className="border border-slate-700/60 p-3 space-y-1">
                  <div className="font-mono uppercase tracking-wide text-slate-400">Chat Commands</div>
                  <div className="text-slate-400">In any connected channel, type <strong className="text-slate-300">Task: deploy docs</strong> to create a task, <strong className="text-slate-300">list tasks</strong> to see your board, or <strong className="text-slate-300">run task 3</strong> to execute one.</div>
                </div>
              </div>
            </div>
          )}

          {/* ── Quick filter pills + saved views row ── */}
          {tasks.length === 0 ? null : (
          <div className="border-b border-border px-6 py-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                QUICK FILTER
              </span>
              {([
                { key: "all", label: "All" },
                { key: "mine", label: defaultAgentId ? "Mine" : "Mine (no default)" },
                { key: "blocked", label: "Blocked" },
                { key: "runnable", label: "Runnable" },
                { key: "review", label: "Needs review" },
              ] as Array<{ key: QuickFilter; label: string }>).map((pill) => {
                const isActive = quickFilter === pill.key;
                const count =
                  pill.key === "all"
                    ? tasks.length
                    : pill.key === "mine"
                      ? defaultAgentId ? tasks.filter((t) => t.assignedAgentId === defaultAgentId).length : 0
                      : pill.key === "blocked"
                        ? tasks.filter((t) => t.status === "blocked").length
                        : pill.key === "runnable"
                          ? tasks.filter((t) => t.workflowTemplateKey || t.workflowId).length
                          : tasks.filter((t) => t.status === "review").length;
                return (
                  <button
                    key={pill.key}
                    type="button"
                    disabled={pill.key === "mine" && !defaultAgentId}
                    onClick={() => setQuickFilter(pill.key)}
                    className={`h-7 border px-2.5 text-[10px] font-mono uppercase tracking-wider transition-colors ${
                      isActive
                        ? "border-terminal-red text-terminal-red bg-terminal-red/10"
                        : "border-border text-muted-foreground hover:border-terminal-red hover:text-terminal-red"
                    } disabled:opacity-40 disabled:cursor-not-allowed`}
                    title={pill.key === "mine" && !defaultAgentId ? "No default agent — set one in /agents" : `Filter by ${pill.label}`}
                  >
                    {pill.label} <span className="ml-1 tabular-nums">{count}</span>
                  </button>
                );
              })}

              <span className="mx-1 h-5 w-px bg-border/60" aria-hidden />

              {/* Saved Views */}
              <select
                className="h-7 border border-border bg-card px-2 text-[10px] font-mono uppercase tracking-wider focus:border-terminal-red focus:outline-none"
                value=""
                onChange={(event) => {
                  const view = savedViews.find((v) => v.name === event.target.value);
                  if (!view) return;
                  setSelectedBoardId(view.boardId || selectedBoardId);
                  setTaskFilterOrganizationId(view.organizationId || "");
                  setTaskFilterGoalId(view.goalId || "");
                  setQuickFilter(view.quickFilter);
                }}
              >
                <option value="">Saved views…</option>
                {savedViews.map((view) => (
                  <option key={view.name} value={view.name}>
                    {view.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="h-7 border border-border px-2.5 text-[10px] font-mono uppercase tracking-wider text-muted-foreground hover:border-terminal-red hover:text-terminal-red transition-colors"
                onClick={() => setSaveViewOpen(true)}
                title="Save current board+filters as a named view"
              >
                + Save View
              </button>
              {savedViews.length > 0 ? (
                <button
                  type="button"
                  className="h-7 border border-border px-2 text-[10px] font-mono uppercase tracking-wider text-muted-foreground hover:border-terminal-red hover:text-terminal-red transition-colors"
                  onClick={() => setClearViewsOpen(true)}
                  title="Delete all saved views"
                >
                  Clear Views
                </button>
              ) : null}

              {filtersActive ? (
                <button
                  type="button"
                  className="ml-auto h-7 border border-terminal-red/50 px-2.5 text-[10px] font-mono uppercase tracking-wider text-terminal-red hover:bg-terminal-red/10 transition-colors"
                  onClick={() => {
                    setQuickFilter("all");
                    setTaskFilterOrganizationId("");
                    setTaskFilterGoalId("");
                  }}
                >
                  Clear Filters
                </button>
              ) : null}
            </div>
          </div>
          )}

          {/* ── Hero Kanban Board ── */}
          <div className="flex-1 p-4">
	          {boardHasNoTasks ? (
            <EmptyState
              className="my-8 min-h-[260px]"
              title="No tasks yet"
              description="Create the first board task, or draft a WebChat request that links the task to agents, workflows, goals, or Council."
              action={(
                <button
                  className="inline-flex h-9 items-center gap-1 rounded-md border border-terminal-red bg-terminal-red px-3 text-sm font-medium text-white transition-colors hover:bg-terminal-red/90"
                  onClick={() => setShowNewTask(true)}
                >
                  <Plus className="mr-1 h-3.5 w-3.5" />
                  Create first task
                </button>
              )}
              secondaryAction={(
                <a href="/chat?draft=Create%20a%20board%20task%20for%20my%20current%20project%20and%20suggest%20which%20agent%20or%20workflow%20should%20own%20it." className="inline-flex h-9 items-center rounded-md border border-input bg-transparent px-3 text-xs font-medium hover:bg-primary hover:text-primary-foreground">
                  Draft in WebChat
                </a>
              )}
            />
          ) : (
            <>
            {filtersHideAllTasks ? (
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
                <span>No tasks match the current board filters.</span>
                <button
                  type="button"
                  className="font-mono text-[10px] uppercase tracking-widest underline-offset-2 hover:underline"
                  onClick={() => {
                    setQuickFilter("all");
                    setTaskFilterOrganizationId("");
                    setTaskFilterGoalId("");
                  }}
                >
                  Clear filters
                </button>
              </div>
            ) : null}
            {loading ? (
              <div className="grid gap-3 grid-cols-4">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="h-64 border border-border bg-card animate-pulse" />
                ))}
              </div>
            ) : (
              <div className="grid gap-3 grid-cols-1 md:grid-cols-2 xl:grid-cols-5" style={{ minHeight: "calc(100vh - 200px)" }}>
                {COLUMNS.map((column) => {
                  const colTasks = tasksByStatus[column.status];
                  const hasHighPriority = colTasks.some((t) => t.priority === "high");
                  return (
                    <div
                      key={column.status}
                      className={`relative border flex flex-col transition-colors ${
                        dragOverColumn === column.status
                          ? "border-terminal-red/60 bg-terminal-red/5 ring-2 ring-terminal-red/30"
                          : "border-border bg-card/50"
                      }`}
                      onDragOver={(event) => {
                        event.preventDefault();
                        setDragOverColumn(column.status);
                      }}
                      onDragLeave={() => setDragOverColumn(null)}
                      onDrop={(event) => {
                        event.preventDefault();
                        setDragOverColumn(null);
                        if (!draggingTaskId) return;
                        void updateTask(draggingTaskId, { status: column.status });
                        setDraggingTaskId(null);
                      }}
                    >
                      {/* Column top accent bar */}
                      <div className={`h-1 w-full ${hasHighPriority && column.status !== "done" ? "bg-terminal-red" : columnAccent[column.status]}`} />

                      {/* Column header */}
                      <div className="flex items-center justify-between px-3 py-2.5 border-b border-border">
                        <span className="text-[10px] font-mono font-bold uppercase tracking-widest text-foreground">
                          {column.label}
                        </span>
                        <span className={`inline-flex items-center justify-center h-5 min-w-[20px] px-1.5 text-[10px] font-mono font-bold tabular-nums ${
                          colTasks.length > 0 ? "bg-terminal-red/15 text-terminal-red border border-terminal-red/30" : "text-muted-foreground border border-border"
                        }`}>
                          {colTasks.length}
                        </span>
                      </div>

                      {/* Task list */}
                      <div className="flex-1 overflow-y-auto p-2 space-y-2">
                        {colTasks.length === 0 ? (
                          <div className="flex flex-col items-center justify-center h-24 gap-1 px-2 text-center">
                            {filtersActive && tasks.filter((t) => t.status === column.status).length > 0 ? (
                              <>
                                <span className="text-[10px] font-mono text-muted-foreground/70 uppercase tracking-widest">
                                  Hidden by filters
                                </span>
                                <button
                                  type="button"
                                  className="text-[10px] font-mono uppercase tracking-wider text-terminal-red hover:underline"
                                  onClick={() => {
                                    setQuickFilter("all");
                                    setTaskFilterOrganizationId("");
                                    setTaskFilterGoalId("");
                                  }}
                                >
                                  Clear filters
                                </button>
                              </>
                            ) : (
                              <span className="text-[10px] font-mono text-muted-foreground/50 uppercase tracking-widest">EMPTY</span>
                            )}
                          </div>
                        ) : (
                          colTasks.map((task) => (
                            <div
                              key={task.id}
                              className="group relative cursor-grab border border-border bg-card hover:border-terminal-red/50 transition-colors"
                              draggable
                              onDragStart={() => setDraggingTaskId(task.id)}
                              onDragEnd={() => setDraggingTaskId(null)}
                            >
                              {(() => {
                                const primaryLinkedDocument = task.linkedDocumentIds[0]
                                  ? documentById.get(task.linkedDocumentIds[0]) ?? null
                                  : null;
                                const deliverablePreview = task.deliverables[0] ?? null;
                                return (
                                  <>
                              {/* Priority left edge strip */}
                              <div className={`absolute top-0 left-0 w-[3px] h-full ${priorityStrip[task.priority]}`} />

                              <div className="pl-3 pr-2 py-2">
                                {/* Title row */}
                                <div className="flex items-start justify-between gap-1 mb-1.5">
                                  <span className="text-xs font-medium leading-tight">{task.title}</span>
                                  <span className={`shrink-0 text-[8px] font-mono font-bold uppercase tracking-widest px-1.5 py-0.5 ${
                                    task.priority === "high"
                                      ? "bg-terminal-red/15 text-terminal-red"
                                      : task.priority === "medium"
                                        ? "bg-amber-500/15 text-amber-500"
                                        : "bg-muted text-muted-foreground"
                                  }`}>
                                    {task.priority}
                                  </span>
                                </div>

                                {/* Agent line */}
                                <div className="flex items-center gap-1.5 mb-1.5">
                                  {task.assignedAgentId ? (
                                    <>
                                      <ShapeAvatar seed={task.assignedAgentId} size={16} />
                                      <span className="text-[10px] text-muted-foreground font-mono truncate">
                                        {task.assignedAgentName || task.assignedAgentId}
                                      </span>
                                    </>
                                  ) : (
                                    <span className="text-[10px] text-muted-foreground/50 font-mono uppercase">Unassigned</span>
                                  )}
                                </div>

                                {/* Compact badges row */}
                                <div className="flex flex-wrap gap-1 mb-1.5">
                                  {task.tags.map((tag) => (
                                    <span
                                      key={`${task.id}-${tag.id}`}
                                      className="px-1 py-0 text-[8px] font-mono"
                                      style={{ backgroundColor: `${tag.color}22`, color: tag.color }}
                                    >
                                      {tag.name}
                                    </span>
                                  ))}
                                  <RelatedWorkTrailStrip
                                    className="mt-1 w-full"
                                    surface="boards"
                                    objectType="board-task"
                                    objectId={task.id}
                                    objectName={task.title}
                                  />
                                  {task.organizationId ? (
                                    <span className="text-[8px] font-mono uppercase tracking-wider text-muted-foreground border border-border px-1 py-0">
                                      {organizationById.get(task.organizationId)?.name || "org"}
                                    </span>
                                  ) : null}
                                  {task.goalId ? (
                                    <span
                                      className="text-[8px] font-mono uppercase tracking-wider text-blue-400/80 border border-blue-500/30 px-1 py-0 cursor-pointer hover:bg-blue-500/10 transition-colors"
                                      title="View goal in Hierarchy"
                                      onClick={(e) => { e.stopPropagation(); router.push(`/hierarchy/goal/${task.goalId}`); }}
                                    >
                                      ↗ {task.goalName || goalById.get(task.goalId)?.name || "goal"}
                                    </span>
                                  ) : null}
                                  {task.workflowTemplateKey ? (
                                    <span className="text-[8px] font-mono uppercase tracking-wider text-terminal-red/70 border border-terminal-red/20 px-1 py-0">
                                      {workflowTemplateByKey.get(task.workflowTemplateKey)?.name || task.workflowTemplateKey}
                                    </span>
                                  ) : null}
                                  {task.workflowId ? (
                                    <span className="text-[8px] font-mono uppercase tracking-wider text-muted-foreground border border-border px-1 py-0">
                                      linked
                                    </span>
                                  ) : null}
                                  {task.checkedOutByAgentId ? (
                                    <span className="text-[8px] font-mono uppercase tracking-wider text-amber-500 border border-amber-500/30 px-1 py-0">
                                      claimed: {task.checkedOutByAgentName || task.checkedOutByAgentId}
                                    </span>
                                  ) : null}
                                  {task.linkedDocumentIds.length > 0 ? (
                                    <span className="text-[8px] font-mono uppercase tracking-wider text-muted-foreground border border-border px-1 py-0">
                                      docs:{task.linkedDocumentIds.length}
                                    </span>
                                  ) : null}
                                  {task.deliverables.length > 0 ? (
                                    <span className="text-[8px] font-mono uppercase tracking-wider text-muted-foreground border border-border px-1 py-0">
                                      deliverables:{task.deliverables.length}
                                    </span>
                                  ) : null}
                                </div>

                                {primaryLinkedDocument || deliverablePreview ? (
                                  <div className="mb-1.5 space-y-1 border-t border-border/60 pt-1.5 text-[10px] text-muted-foreground">
                                    {primaryLinkedDocument ? (
                                      <div className="truncate font-mono">
                                        DOC: {primaryLinkedDocument.name}
                                      </div>
                                    ) : null}
                                    {deliverablePreview ? (
                                      <div className="line-clamp-2">
                                        DELIVER: {deliverablePreview}
                                      </div>
                                    ) : null}
                                  </div>
                                ) : null}

                                {/* Compact actions row — always visible on touch, slightly dimmed until hover on desktop */}
                                <div className="flex flex-wrap gap-1 opacity-90 sm:opacity-70 sm:group-hover:opacity-100 transition-opacity">
                                  <select
                                    className="h-6 flex-1 min-w-[90px] border border-border bg-background px-1 text-[9px] font-mono focus:border-terminal-red focus:outline-none"
                                    value={task.assignedAgentId ?? ""}
                                    onChange={(event) =>
                                      void updateTask(task.id, {
                                        assignedAgentId: event.target.value || null,
                                      })
                                    }
                                    disabled={updatingTaskId === task.id}
                                    aria-label="Assign agent"
                                  >
                                    <option value="">Unassigned</option>
                                    {activeAgents.map((agent) => (
                                      <option key={`${task.id}-${agent.id}`} value={agent.id}>
                                        {agent.name}
                                        {agent.roleTitle ? ` - ${agent.roleTitle}` : ""}
                                      </option>
                                    ))}
                                  </select>
                                  <select
                                    className="h-6 border border-border bg-background px-1 text-[9px] font-mono focus:border-terminal-red focus:outline-none"
                                    value={task.status}
                                    onChange={(event) =>
                                      void updateTask(task.id, {
                                        status: event.target.value as TaskStatus,
                                      })
                                    }
                                    disabled={updatingTaskId === task.id}
                                    aria-label="Change status"
                                  >
                                    {COLUMNS.map((status) => (
                                      <option key={`${task.id}-${status.status}`} value={status.status}>
                                        {status.label}
                                      </option>
                                    ))}
                                  </select>
                                  <button
                                    className="inline-flex h-6 items-center gap-1 border border-border px-1.5 text-[9px] font-mono uppercase hover:border-terminal-red hover:text-terminal-red transition-colors"
                                    title={task.checkedOutByAgentId ? "Release this task (release claim)" : "Claim this task for the default agent"}
                                    aria-label={task.checkedOutByAgentId ? "Release" : "Claim"}
                                    onClick={async () => {
                                      const actingAgentId = defaultAgentId || activeAgents[0]?.id;
                                      if (!actingAgentId) return;
                                      await fetch("/api/boards/tasks", {
                                        method: "PATCH",
                                        headers: { "Content-Type": "application/json" },
                                        body: JSON.stringify({
                                          action: task.checkedOutByAgentId ? "release" : "claim",
                                          id: task.id,
                                          agentId: actingAgentId,
                                        }),
                                      });
                                      await loadTasks(selectedBoardId, {
                                        organizationId: taskFilterOrganizationId || undefined,
                                        goalId: taskFilterGoalId || undefined,
                                      });
                                    }}
                                  >
                                    {task.checkedOutByAgentId ? <LockOpen className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
                                    <span className="hidden lg:inline">{task.checkedOutByAgentId ? "Release" : "Claim"}</span>
                                  </button>
                                  <button
                                    className="inline-flex h-6 items-center gap-1 border border-border px-1.5 text-[9px] font-mono uppercase text-muted-foreground hover:border-terminal-red hover:text-terminal-red transition-colors disabled:opacity-30"
                                    title={task.linkedDocumentIds.length > 0 ? "Open linked document" : "No linked document"}
                                    aria-label="Open document"
                                    onClick={() => {
                                      const documentId = task.linkedDocumentIds[0];
                                      if (!documentId) return;
                                      window.location.href = `/documents?documentId=${encodeURIComponent(documentId)}`;
                                    }}
                                    disabled={task.linkedDocumentIds.length === 0}
                                  >
                                    <FileText className="h-3 w-3" />
                                    <span className="hidden lg:inline">Doc</span>
                                  </button>
                                  {task.workflowTemplateKey || task.workflowId ? (
                                    <button
                                      className="inline-flex h-6 items-center gap-1 border border-terminal-red/40 px-1.5 text-[9px] font-mono uppercase text-terminal-red hover:bg-terminal-red/10 transition-colors disabled:opacity-30"
                                      title="Run linked workflow"
                                      aria-label="Run workflow"
                                      onClick={() => void runWorkflowTask(task.id)}
                                      disabled={runningTaskId === task.id}
                                    >
                                      <Play className="h-3 w-3" />
                                      <span className="hidden lg:inline">{runningTaskId === task.id ? "Running" : "Run"}</span>
                                    </button>
                                  ) : (
                                    <button
                                      className="inline-flex h-6 items-center gap-1 border border-amber-500/40 px-1.5 text-[9px] font-mono uppercase text-amber-500 hover:bg-amber-500/10 transition-colors"
                                      title="Create a workflow scoped to this task and link it"
                                      aria-label="Create linked workflow"
                                      onClick={() => void createLinkedWorkflow(task)}
                                      disabled={creatingWorkflowForTaskId === task.id}
                                    >
                                      <Plus className="h-3 w-3" />
                                      <span className="hidden lg:inline">{creatingWorkflowForTaskId === task.id ? "Creating" : "Workflow"}</span>
                                    </button>
                                  )}
                                  <button
                                    className="inline-flex h-6 items-center gap-1 border border-border px-1.5 text-[9px] font-mono uppercase text-muted-foreground hover:border-terminal-red hover:text-terminal-red transition-colors"
                                    title="Delete this task"
                                    aria-label="Delete"
                                    onClick={() => setDeleteTaskId(task.id)}
                                    disabled={deletingTaskId === task.id}
                                  >
                                    <Trash2 className="h-3 w-3" />
                                  </button>
                                </div>
                              </div>
                                  </>
                                );
                              })()}
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
          )}
          </div>
          <Dialog open={saveViewOpen} onOpenChange={setSaveViewOpen}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Save Board View</DialogTitle>
                <DialogDescription>
                  Save the current board, org, goal, and quick filter as a named view.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-2">
                <span className="data-label text-muted-foreground">VIEW NAME</span>
                <Input
                  value={saveViewName}
                  onChange={(event) => setSaveViewName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") saveCurrentView();
                  }}
                  placeholder="My review queue"
                />
              </div>
              <DialogFooter>
                <button
                  type="button"
                  className="h-8 border border-border px-3 text-[10px] font-mono uppercase tracking-wider text-muted-foreground hover:border-terminal-red hover:text-terminal-red"
                  onClick={() => setSaveViewOpen(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="h-8 border border-terminal-red px-3 text-[10px] font-mono uppercase tracking-wider text-terminal-red hover:bg-terminal-red/10 disabled:opacity-40"
                  onClick={saveCurrentView}
                  disabled={!saveViewName.trim()}
                >
                  Save View
                </button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <Dialog open={clearViewsOpen} onOpenChange={setClearViewsOpen}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Clear Saved Views</DialogTitle>
                <DialogDescription>
                  This removes all saved board filter presets from this browser.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <button
                  type="button"
                  className="h-8 border border-border px-3 text-[10px] font-mono uppercase tracking-wider text-muted-foreground hover:border-terminal-red hover:text-terminal-red"
                  onClick={() => setClearViewsOpen(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="h-8 border border-terminal-red px-3 text-[10px] font-mono uppercase tracking-wider text-terminal-red hover:bg-terminal-red/10"
                  onClick={clearSavedViews}
                >
                  Clear Views
                </button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <Dialog open={deleteBoardOpen} onOpenChange={setDeleteBoardOpen}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Delete Board</DialogTitle>
                <DialogDescription>
                  Delete "{selectedBoard?.name ?? "this board"}" and all tasks on it. This cannot be undone.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <button
                  type="button"
                  className="h-8 border border-border px-3 text-[10px] font-mono uppercase tracking-wider text-muted-foreground hover:border-terminal-red hover:text-terminal-red"
                  onClick={() => setDeleteBoardOpen(false)}
                  disabled={deletingBoard}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="h-8 border border-terminal-red px-3 text-[10px] font-mono uppercase tracking-wider text-terminal-red hover:bg-terminal-red/10 disabled:opacity-40"
                  onClick={() => void onDeleteBoard()}
                  disabled={deletingBoard}
                >
                  {deletingBoard ? "Deleting..." : "Delete Board"}
                </button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <Dialog open={Boolean(deleteTaskId)} onOpenChange={(open) => { if (!open) setDeleteTaskId(null); }}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Delete Task</DialogTitle>
                <DialogDescription>
                  Delete "{tasks.find((task) => task.id === deleteTaskId)?.title ?? "this task"}" from the board. This cannot be undone.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <button
                  type="button"
                  className="h-8 border border-border px-3 text-[10px] font-mono uppercase tracking-wider text-muted-foreground hover:border-terminal-red hover:text-terminal-red"
                  onClick={() => setDeleteTaskId(null)}
                  disabled={Boolean(deletingTaskId)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="h-8 border border-terminal-red px-3 text-[10px] font-mono uppercase tracking-wider text-terminal-red hover:bg-terminal-red/10 disabled:opacity-40"
                  onClick={() => { if (deleteTaskId) void deleteTask(deleteTaskId); }}
                  disabled={Boolean(deletingTaskId)}
                >
                  {deletingTaskId ? "Deleting..." : "Delete Task"}
                </button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </main>
  );
}

export default function BoardsPage() {
  return (
    <Suspense>
      <BoardsPageInner />
    </Suspense>
  );
}
