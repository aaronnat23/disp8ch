/**
 * Server-side bootstrap preload helpers.
 *
 * Each loader runs the same SQLite reads as the `/api/<tab>/bootstrap` route
 * but bypasses the HTTP roundtrip when called from an async server component
 * (`page.tsx`). The result is injected into the HTML as a JSON script tag and
 * picked up by the client page on first paint, eliminating the bootstrap fetch
 * from the client's pre-ready API count.
 *
 * Loaders MUST be wrapped in try/catch by the caller. They never throw.
 */
import "server-only";

type DashboardBootstrap = {
  workflows: { count: number; active: number };
  agents: { count: number; active: number };
  boards: { count: number };
  tasks: { total: number; open: number; byStatus: Record<string, number> };
  orgs: { count: number; activeName: string | null };
  models: { count: number; active: number };
};

type WorkflowsBootstrap = {
  workflows: {
    count: number;
    active: number;
    recent: Array<{ id: string; name: string; isActive: boolean; updatedAt: string }>;
  };
  templates: { count: number };
  organizations: { count: number; activeName: string | null };
};

type HierarchyBootstrap = {
  organizations: { count: number; active: { id: string; name: string } | null };
  goals: { count: number };
  agents: { count: number; activeCount: number };
};

type BoardsBootstrap = {
  boards: Array<{ id: string; name: string; description: string | null; taskCount: number; isActive: boolean }>;
  tasks: { total: number; inbox: number; inProgress: number; review: number; done: number; blocked: number };
};

type AgentsBootstrap = {
  count: number;
  active: number;
  hasDefault: boolean;
  recent: Array<{ id: string; name: string; isActive: boolean; isDefault: boolean }>;
};

/** Safely load dashboard bootstrap data server-side. Returns null on any error. */
export async function preloadDashboardBootstrap(): Promise<DashboardBootstrap | null> {
  try {
    const { getSqlite } = await import("@/lib/db");
    const db = getSqlite();
    const safeCount = (sql: string): number => {
      try {
        const row = db.prepare(sql).get() as { c?: number } | undefined;
        return row?.c ?? 0;
      } catch {
        return 0;
      }
    };
    const workflows = {
      count: safeCount("SELECT COUNT(*) AS c FROM workflows"),
      active: safeCount("SELECT COUNT(*) AS c FROM workflows WHERE is_active = 1"),
    };
    const agents = {
      count: safeCount("SELECT COUNT(*) AS c FROM agents"),
      active: safeCount("SELECT COUNT(*) AS c FROM agents WHERE is_active = 1"),
    };
    const boards = { count: safeCount("SELECT COUNT(*) AS c FROM boards") };
    const taskTotal = safeCount("SELECT COUNT(*) AS c FROM board_tasks");
    const taskByStatus: Record<string, number> = {};
    let taskOpen = 0;
    try {
      const rows = db
        .prepare("SELECT status, COUNT(*) AS c FROM board_tasks GROUP BY status")
        .all() as Array<{ status: string; c: number }>;
      for (const row of rows) {
        taskByStatus[row.status] = row.c ?? 0;
        if (row.status !== "done") taskOpen += row.c ?? 0;
      }
    } catch { /* no-op */ }
    const tasks = { total: taskTotal, open: taskOpen, byStatus: taskByStatus };
    const orgs = {
      count: safeCount("SELECT COUNT(*) AS c FROM hierarchy_organizations"),
      activeName: null as string | null,
    };
    try {
      const active = db
        .prepare("SELECT name FROM hierarchy_organizations WHERE is_active = 1 LIMIT 1")
        .get() as { name: string } | undefined;
      orgs.activeName = active?.name ?? null;
    } catch { /* no-op */ }
    const models = {
      count: safeCount("SELECT COUNT(*) AS c FROM models"),
      active: safeCount("SELECT COUNT(*) AS c FROM models WHERE is_active = 1"),
    };
    return { workflows, agents, boards, tasks, orgs, models };
  } catch {
    return null;
  }
}

export async function preloadWorkflowsBootstrap(): Promise<WorkflowsBootstrap | null> {
  try {
    const { getSqlite } = await import("@/lib/db");
    const db = getSqlite();
    const safeCount = (sql: string): number => {
      try {
        const row = db.prepare(sql).get() as { c?: number } | undefined;
        return row?.c ?? 0;
      } catch {
        return 0;
      }
    };
    let recent: WorkflowsBootstrap["workflows"]["recent"] = [];
    try {
      const rows = db
        .prepare("SELECT id, name, is_active, updated_at FROM workflows ORDER BY updated_at DESC LIMIT 6")
        .all() as Array<{ id: string; name: string; is_active: number; updated_at: string }>;
      recent = rows.map((r) => ({ id: r.id, name: r.name, isActive: r.is_active !== 0, updatedAt: r.updated_at }));
    } catch { /* no-op */ }
    let templateCount = 0;
    try {
      const { listWorkflowTemplateCatalog } = await import("@/lib/workflows/template-catalog");
      templateCount = listWorkflowTemplateCatalog().length;
    } catch { /* no-op */ }
    let activeName: string | null = null;
    try {
      const active = db
        .prepare("SELECT name FROM hierarchy_organizations WHERE is_active = 1 LIMIT 1")
        .get() as { name: string } | undefined;
      activeName = active?.name ?? null;
    } catch { /* no-op */ }
    return {
      workflows: {
        count: safeCount("SELECT COUNT(*) AS c FROM workflows"),
        active: safeCount("SELECT COUNT(*) AS c FROM workflows WHERE is_active = 1"),
        recent,
      },
      templates: { count: templateCount },
      organizations: {
        count: safeCount("SELECT COUNT(*) AS c FROM hierarchy_organizations"),
        activeName,
      },
    };
  } catch {
    return null;
  }
}

export async function preloadHierarchyBootstrap(): Promise<HierarchyBootstrap | null> {
  try {
    const { getSqlite } = await import("@/lib/db");
    const db = getSqlite();
    const safeCount = (sql: string): number => {
      try {
        const row = db.prepare(sql).get() as { c?: number } | undefined;
        return row?.c ?? 0;
      } catch {
        return 0;
      }
    };
    let active: { id: string; name: string } | null = null;
    try {
      const a = db
        .prepare("SELECT id, name FROM hierarchy_organizations WHERE is_active = 1 LIMIT 1")
        .get() as { id: string; name: string } | undefined;
      if (a) active = { id: a.id, name: a.name };
      else {
        const first = db
          .prepare("SELECT id, name FROM hierarchy_organizations LIMIT 1")
          .get() as { id: string; name: string } | undefined;
        if (first) active = { id: first.id, name: first.name };
      }
    } catch { /* no-op */ }
    return {
      organizations: { count: safeCount("SELECT COUNT(*) AS c FROM hierarchy_organizations"), active },
      goals: { count: safeCount("SELECT COUNT(*) AS c FROM hierarchy_goals") },
      agents: {
        count: safeCount("SELECT COUNT(*) AS c FROM agents"),
        activeCount: safeCount("SELECT COUNT(*) AS c FROM agents WHERE is_active = 1"),
      },
    };
  } catch {
    return null;
  }
}

export async function preloadBoardsBootstrap(): Promise<BoardsBootstrap | null> {
  try {
    const { getSqlite } = await import("@/lib/db");
    const db = getSqlite();
    let boards: BoardsBootstrap["boards"] = [];
    try {
      const rows = db
        .prepare(
          `SELECT b.id, b.name, b.description, b.is_active, COUNT(t.id) AS task_count
           FROM boards b LEFT JOIN board_tasks t ON t.board_id = b.id
           GROUP BY b.id ORDER BY b.updated_at DESC`,
        )
        .all() as Array<{ id: string; name: string; description: string | null; is_active: number; task_count: number }>;
      boards = rows.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        taskCount: Number(r.task_count ?? 0),
        isActive: r.is_active !== 0,
      }));
    } catch { /* no-op */ }
    const tasks = { total: 0, inbox: 0, inProgress: 0, review: 0, done: 0, blocked: 0 };
    try {
      const total = db.prepare("SELECT COUNT(*) AS c FROM board_tasks").get() as { c: number };
      tasks.total = total?.c ?? 0;
      const byStatus = db
        .prepare("SELECT status, COUNT(*) AS c FROM board_tasks GROUP BY status")
        .all() as Array<{ status: string; c: number }>;
      for (const row of byStatus) {
        const count = row.c ?? 0;
        if (row.status === "inbox") tasks.inbox = count;
        else if (row.status === "in_progress") tasks.inProgress = count;
        else if (row.status === "review") tasks.review = count;
        else if (row.status === "done") tasks.done = count;
        else if (row.status === "blocked") tasks.blocked = count;
      }
    } catch { /* no-op */ }
    return { boards, tasks };
  } catch {
    return null;
  }
}

export async function preloadAgentsBootstrap(): Promise<AgentsBootstrap | null> {
  try {
    const { getSqlite } = await import("@/lib/db");
    const db = getSqlite();
    const safeCount = (sql: string): number => {
      try {
        const row = db.prepare(sql).get() as { c?: number } | undefined;
        return row?.c ?? 0;
      } catch {
        return 0;
      }
    };
    let recent: AgentsBootstrap["recent"] = [];
    let hasDefault = false;
    try {
      const rows = db
        .prepare("SELECT id, name, is_active, is_default FROM agents ORDER BY is_default DESC, name LIMIT 8")
        .all() as Array<{ id: string; name: string; is_active: number; is_default: number }>;
      recent = rows.map((r) => ({
        id: r.id,
        name: r.name,
        isActive: r.is_active !== 0,
        isDefault: r.is_default !== 0,
      }));
      hasDefault = rows.some((r) => r.is_default !== 0);
    } catch { /* no-op */ }
    return {
      count: safeCount("SELECT COUNT(*) AS c FROM agents"),
      active: safeCount("SELECT COUNT(*) AS c FROM agents WHERE is_active = 1"),
      hasDefault,
      recent,
    };
  } catch {
    return null;
  }
}

/**
 * Stable global key for embedding bootstrap data in HTML. The client-side
 * helper `readPreloadedBootstrap` reads from this key.
 */
export function bootstrapDomId(marker: string): string {
  return `__disp8ch_bootstrap_${marker}__`;
}
