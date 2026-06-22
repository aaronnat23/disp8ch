import { nanoid } from "nanoid";
import { getSqlite, initializeDatabase } from "@/lib/db";
import { getActiveHierarchyOrganization, resolveHierarchyOrganization } from "@/lib/hierarchy/organizations";
import { createWorkObject, getRootWorkObjectForGoal, linkWorkObject } from "@/lib/hierarchy/work-objects";

export type HierarchyProjectStatus = "planned" | "in_progress" | "blocked" | "done" | "cancelled";

export type HierarchyProject = {
  id: string;
  organizationId: string | null;
  name: string;
  description: string | null;
  goalIds: string[];
  status: HierarchyProjectStatus;
  primaryWorkspaceId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ProjectWorkspace = {
  id: string;
  projectId: string;
  name: string;
  cwd: string | null;
  repoUrl: string | null;
  repoRef: string | null;
  isPrimary: boolean;
  createdAt: string;
  updatedAt: string;
};

type ProjectRow = {
  id: string;
  organization_id: string | null;
  name: string;
  description: string | null;
  goal_ids: string | null;
  status: string;
  primary_workspace_id: string | null;
  created_at: string;
  updated_at: string;
};

type WorkspaceRow = {
  id: string;
  project_id: string;
  name: string;
  cwd: string | null;
  repo_url: string | null;
  repo_ref: string | null;
  is_primary: number;
  created_at: string;
  updated_at: string;
};

const STATUSES: HierarchyProjectStatus[] = ["planned", "in_progress", "blocked", "done", "cancelled"];

function ensureProjectTables() {
  initializeDatabase();
  const db = getSqlite();
  db.exec(`
    CREATE TABLE IF NOT EXISTS hierarchy_projects (
      id TEXT PRIMARY KEY,
      organization_id TEXT,
      name TEXT NOT NULL,
      description TEXT,
      goal_ids TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'planned',
      primary_workspace_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_hierarchy_projects_org ON hierarchy_projects(organization_id);

    CREATE TABLE IF NOT EXISTS hierarchy_project_workspaces (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      cwd TEXT,
      repo_url TEXT,
      repo_ref TEXT,
      is_primary INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_hierarchy_project_workspaces_project ON hierarchy_project_workspaces(project_id);
  `);
  return db;
}

function normalizeList(value: unknown, maxItems = 100): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/\r?\n|,/g)
      : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const item = String(entry ?? "").trim();
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
    if (out.length >= maxItems) break;
  }
  return out;
}

function parseList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    return normalizeList(JSON.parse(raw));
  } catch {
    return normalizeList(raw);
  }
}

function normalizeStatus(value: unknown): HierarchyProjectStatus {
  const candidate = String(value ?? "").trim();
  return STATUSES.includes(candidate as HierarchyProjectStatus) ? (candidate as HierarchyProjectStatus) : "planned";
}

function resolveOrganizationId(input?: string | null): string | null {
  if (input !== undefined) {
    return input ? resolveHierarchyOrganization(input)?.id ?? input : null;
  }
  return getActiveHierarchyOrganization()?.id ?? null;
}

function mapProject(row: ProjectRow): HierarchyProject {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    description: row.description,
    goalIds: parseList(row.goal_ids),
    status: normalizeStatus(row.status),
    primaryWorkspaceId: row.primary_workspace_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapWorkspace(row: WorkspaceRow): ProjectWorkspace {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    cwd: row.cwd,
    repoUrl: row.repo_url,
    repoRef: row.repo_ref,
    isPrimary: row.is_primary === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listHierarchyProjects(input?: {
  organizationId?: string | null;
  goalId?: string | null;
  includeDone?: boolean;
}): HierarchyProject[] {
  const db = ensureProjectTables();
  const rows = db
    .prepare("SELECT * FROM hierarchy_projects ORDER BY updated_at DESC, created_at DESC")
    .all() as ProjectRow[];
  return rows
    .map(mapProject)
    .filter((project) => (input?.organizationId ? project.organizationId === input.organizationId : true))
    .filter((project) => (input?.goalId ? project.goalIds.includes(input.goalId) : true))
    .filter((project) => (input?.includeDone ? true : !["done", "cancelled"].includes(project.status)));
}

export function getHierarchyProjectById(projectId: string): HierarchyProject | null {
  const db = ensureProjectTables();
  const row = db.prepare("SELECT * FROM hierarchy_projects WHERE id = ?").get(projectId) as ProjectRow | undefined;
  return row ? mapProject(row) : null;
}

export function createHierarchyProject(input: {
  organizationId?: string | null;
  name: string;
  description?: string | null;
  goalIds?: string[];
  status?: HierarchyProjectStatus | null;
}): HierarchyProject {
  const db = ensureProjectTables();
  const name = String(input.name || "").trim();
  if (!name) throw new Error("Project name is required");
  const id = nanoid(12);
  const now = new Date().toISOString();
  const goalIds = normalizeList(input.goalIds);
  db.prepare(`
    INSERT INTO hierarchy_projects (id, organization_id, name, description, goal_ids, status, primary_workspace_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
  `).run(
    id,
    resolveOrganizationId(input.organizationId),
    name,
    input.description ?? null,
    JSON.stringify(goalIds),
    normalizeStatus(input.status),
    now,
    now,
  );

  for (const goalId of goalIds) {
    const root = getRootWorkObjectForGoal(goalId);
    const projectWorkObject = createWorkObject({
      organizationId: input.organizationId,
      goalId,
      parentWorkObjectId: root?.id ?? null,
      type: "project",
      title: name,
      description: input.description,
      status: input.status === "in_progress" ? "in_progress" : "planned",
    });
    if (root) {
      linkWorkObject(root.id, { decisionId: projectWorkObject.id });
    }
  }

  return getHierarchyProjectById(id)!;
}

export function updateHierarchyProject(projectId: string, input: Partial<Pick<HierarchyProject, "name" | "description" | "goalIds" | "status" | "primaryWorkspaceId">>): HierarchyProject {
  const existing = getHierarchyProjectById(projectId);
  if (!existing) throw new Error(`Project not found: ${projectId}`);
  const db = ensureProjectTables();
  db.prepare(`
    UPDATE hierarchy_projects SET name = ?, description = ?, goal_ids = ?, status = ?, primary_workspace_id = ?, updated_at = ?
    WHERE id = ?
  `).run(
    input.name !== undefined ? String(input.name).trim() || existing.name : existing.name,
    input.description !== undefined ? input.description : existing.description,
    JSON.stringify(input.goalIds !== undefined ? normalizeList(input.goalIds) : existing.goalIds),
    input.status !== undefined ? normalizeStatus(input.status) : existing.status,
    input.primaryWorkspaceId !== undefined ? input.primaryWorkspaceId : existing.primaryWorkspaceId,
    new Date().toISOString(),
    projectId,
  );
  return getHierarchyProjectById(projectId)!;
}

export function listProjectWorkspaces(projectId: string): ProjectWorkspace[] {
  const db = ensureProjectTables();
  return (db
    .prepare("SELECT * FROM hierarchy_project_workspaces WHERE project_id = ? ORDER BY is_primary DESC, updated_at DESC")
    .all(projectId) as WorkspaceRow[]).map(mapWorkspace);
}

export function createProjectWorkspace(input: {
  projectId: string;
  name: string;
  cwd?: string | null;
  repoUrl?: string | null;
  repoRef?: string | null;
  isPrimary?: boolean;
}): ProjectWorkspace {
  const project = getHierarchyProjectById(input.projectId);
  if (!project) throw new Error(`Project not found: ${input.projectId}`);
  const db = ensureProjectTables();
  const id = nanoid(12);
  const now = new Date().toISOString();
  const isPrimary = input.isPrimary || !project.primaryWorkspaceId;
  if (isPrimary) {
    db.prepare("UPDATE hierarchy_project_workspaces SET is_primary = 0 WHERE project_id = ?").run(input.projectId);
  }
  db.prepare(`
    INSERT INTO hierarchy_project_workspaces (id, project_id, name, cwd, repo_url, repo_ref, is_primary, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.projectId,
    String(input.name || "Workspace").trim().slice(0, 120),
    input.cwd ?? null,
    input.repoUrl ?? null,
    input.repoRef ?? null,
    isPrimary ? 1 : 0,
    now,
    now,
  );
  if (isPrimary) {
    updateHierarchyProject(input.projectId, { primaryWorkspaceId: id });
  }
  return listProjectWorkspaces(input.projectId).find((workspace) => workspace.id === id)!;
}

export function setPrimaryProjectWorkspace(projectId: string, workspaceId: string): ProjectWorkspace {
  const db = ensureProjectTables();
  const existing = db
    .prepare("SELECT * FROM hierarchy_project_workspaces WHERE id = ? AND project_id = ?")
    .get(workspaceId, projectId) as WorkspaceRow | undefined;
  if (!existing) throw new Error(`Workspace not found: ${workspaceId}`);
  db.prepare("UPDATE hierarchy_project_workspaces SET is_primary = 0, updated_at = ? WHERE project_id = ?")
    .run(new Date().toISOString(), projectId);
  db.prepare("UPDATE hierarchy_project_workspaces SET is_primary = 1, updated_at = ? WHERE id = ?")
    .run(new Date().toISOString(), workspaceId);
  updateHierarchyProject(projectId, { primaryWorkspaceId: workspaceId });
  return listProjectWorkspaces(projectId).find((workspace) => workspace.id === workspaceId)!;
}
