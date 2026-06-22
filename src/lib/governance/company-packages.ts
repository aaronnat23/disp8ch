import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { getSqlite, initializeDatabase } from "@/lib/db";
import { logger } from "@/lib/utils/logger";
import { logActivity } from "@/lib/governance/activity-log";
import { createTaskLabel, listTaskLabels } from "@/lib/governance/task-labels";
import { createAgent, ensureAgentsTable } from "@/lib/agents/registry";
import {
  getHierarchyOrganizationById,
  saveHierarchyOrganizationSnapshot,
  type HierarchyOrganizationSnapshotMember,
} from "@/lib/hierarchy/organizations";
import { createHierarchyGoal, listHierarchyGoals, type GoalLevel, type GoalStatus } from "@/lib/hierarchy/goals";

const log = logger.child("governance:company-packages");

/* ─── Types ─── */

export interface CompanyPackage {
  version: 1;
  exportedAt: string;
  organization: {
    name: string;
    description: string | null;
    mission: string | null;
  };
  agents: Array<{
    name: string;
    modelRef: string | null;
    role?: string;
    roleType?: string | null;
    roleDescription?: string | null;
    reportsToName?: string | null;
    capabilities?: string[];
    voteWeight?: number | null;
    disabledTools: string[];
    enabledExtensions: string[];
    enabledSkills: string[];
    execAllowlist: string[];
    spendCapUsd: number | null;
    spendWindowDays: number;
    budgetAction: "warn" | "block";
    heartbeatCron: string | null;
    isDefault: boolean;
  }>;
  goals: Array<{
    name: string;
    description: string | null;
    parentGoalName: string | null;
    linkedDocumentIds?: string[];
    deliverables?: string[];
    status?: string | null;
    level?: string | null;
  }>;
  labels: Array<{
    name: string;
    color: string;
    scope: string;
  }>;
}

function normalizeImportedAgentId(raw: string): string {
  const normalized = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || `agent-${nanoid(6).toLowerCase()}`;
}

function makeUniqueImportedAgentName(baseName: string): string {
  initializeDatabase();
  const db = getSqlite();
  const trimmed = String(baseName || "").trim() || "Imported Agent";
  let candidate = trimmed;
  let counter = 2;
  while (db.prepare("SELECT 1 FROM agents WHERE id = ? LIMIT 1").get(normalizeImportedAgentId(candidate))) {
    candidate = `${trimmed} Imported ${counter}`;
    counter += 1;
  }
  return candidate;
}

/* ─── Export ─── */

export function exportCompanyPackage(organizationId: string): CompanyPackage {
  initializeDatabase();
  const db = getSqlite();

  const org = getHierarchyOrganizationById(organizationId);
  if (!org) throw new Error(`Organization not found: ${organizationId}`);

  // Collect member agent IDs from the snapshot
  const memberAgentIds = new Set(org.snapshot.map((m) => m.agent.id));

  // Fetch full agent rows for members
  type AgentRow = {
    id: string;
    name: string;
    model_ref: string | null;
    disabled_tools: string | null;
    enabled_extensions: string | null;
    enabled_skills: string | null;
    exec_allowlist: string | null;
    spend_cap_usd: number | null;
    spend_window_days: number | null;
    budget_action: string | null;
    heartbeat_cron: string | null;
    is_default: number;
  };

  const agentRows = db
    .prepare("SELECT * FROM agents WHERE id IN (" + [...memberAgentIds].map(() => "?").join(",") + ")")
    .all(...[...memberAgentIds]) as AgentRow[];

  function parseArr(raw: string | null): string[] {
    if (!raw) return [];
    try {
      const p = JSON.parse(raw) as unknown;
      return Array.isArray(p) ? (p as string[]) : [];
    } catch {
      return [];
    }
  }

  // Build role map from snapshot
  const roleByAgentId = new Map(
    org.snapshot.map((m) => [m.agent.id, m.role]),
  );
  const nameByAgentId = new Map(
    org.snapshot.map((m) => [m.agent.id, m.agent.name]),
  );
  const reportsToNameByAgentId = new Map(
    org.snapshot.map((m) => [m.agent.id, m.role.reportsTo ? nameByAgentId.get(m.role.reportsTo) ?? null : null]),
  );

  const agents: CompanyPackage["agents"] = agentRows.map((row) => ({
    name: row.name,
    modelRef: row.model_ref,
    role: roleByAgentId.get(row.id)?.roleTitle,
    roleType: roleByAgentId.get(row.id)?.roleType ?? null,
    roleDescription: roleByAgentId.get(row.id)?.roleDescription ?? null,
    reportsToName: reportsToNameByAgentId.get(row.id) ?? null,
    capabilities: roleByAgentId.get(row.id)?.capabilities ?? [],
    voteWeight: roleByAgentId.get(row.id)?.voteWeight ?? 1,
    disabledTools: parseArr(row.disabled_tools),
    enabledExtensions: parseArr(row.enabled_extensions),
    enabledSkills: parseArr(row.enabled_skills),
    execAllowlist: parseArr(row.exec_allowlist),
    spendCapUsd: row.spend_cap_usd ?? null,
    spendWindowDays: row.spend_window_days ?? 30,
    budgetAction: (row.budget_action ?? "warn") as "warn" | "block",
    heartbeatCron: row.heartbeat_cron,
    isDefault: row.is_default === 1,
  }));

  // Read goals for the org
  const goalRecords = listHierarchyGoals({ organizationId });
  const goals: CompanyPackage["goals"] = goalRecords.map((g) => ({
    name: g.name,
    description: g.description,
    parentGoalName: g.parentGoalName,
    linkedDocumentIds: [...g.linkedDocumentIds],
    deliverables: [...g.deliverables],
    status: g.status,
    level: g.level,
  }));

  // Read all task labels
  const labelRecords = listTaskLabels();
  const labels: CompanyPackage["labels"] = labelRecords.map((l) => ({
    name: l.name,
    color: l.color,
    scope: l.scope,
  }));

  log.info("Company package exported", { organizationId, agentCount: agents.length });

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    organization: {
      name: org.name,
      description: org.description,
      mission: org.mission,
    },
    agents,
    goals,
    labels,
  };
}

/* ─── Import ─── */

export function importCompanyPackage(
  pkg: CompanyPackage,
  options?: { activate?: boolean },
): { organizationId: string; agentIds: string[]; goalIds: string[] } {
  if (pkg.version !== 1) throw new Error("Unsupported package version");

  // Ensure the agents table exists even when an import is the very first action
  // on a fresh database before any agent op.
  ensureAgentsTable();

  const agentIds: string[] = [];
  const createdAgentNames: string[] = [];

  // Create agents
  for (const agentDef of pkg.agents) {
    const uniqueName = makeUniqueImportedAgentName(agentDef.name);
    const created = createAgent({
      name: uniqueName,
      modelRef: agentDef.modelRef ?? undefined,
      disabledTools: agentDef.disabledTools,
      enabledExtensions: agentDef.enabledExtensions,
      enabledSkills: agentDef.enabledSkills,
      execAllowlist: agentDef.execAllowlist,
      spendCapUsd: agentDef.spendCapUsd ?? undefined,
      spendWindowDays: agentDef.spendWindowDays,
      budgetAction: agentDef.budgetAction,
      heartbeatCron: agentDef.heartbeatCron ?? undefined,
      isDefault: agentDef.isDefault,
    });
    agentIds.push(created.id);
    createdAgentNames.push(created.name);
    logActivity({
      actorType: "system",
      action: "import",
      entityType: "agent",
      entityId: created.id,
      details: { packageOrg: pkg.organization.name },
    });
  }

  // Build snapshot members from newly created agents for the org
  const snapshotMembers: HierarchyOrganizationSnapshotMember[] = pkg.agents.map((agentDef, idx) => ({
    agent: {
      id: agentIds[idx],
      name: createdAgentNames[idx] || agentDef.name,
      workspacePath: "",
      modelRef: agentDef.modelRef,
      disabledTools: agentDef.disabledTools,
      enabledExtensions: agentDef.enabledExtensions,
      enabledSkills: agentDef.enabledSkills,
      isDefault: agentDef.isDefault,
      isActive: true,
    },
    role: {
      roleType: (agentDef.roleType as HierarchyOrganizationSnapshotMember["role"]["roleType"] | undefined) ?? (agentDef.isDefault ? "orchestrator" : "worker"),
      roleTitle: agentDef.role ?? (agentDef.isDefault ? "Orchestrator" : "Worker Agent"),
      roleDescription: agentDef.roleDescription ?? "",
      reportsTo: null,
      capabilities: Array.isArray(agentDef.capabilities) ? agentDef.capabilities.map((entry) => String(entry || "").trim()).filter(Boolean) : [],
      voteWeight: Math.max(1, Math.min(9, Number(agentDef.voteWeight ?? 1) || 1)),
    },
  }));

  const agentIdByImportedName = new Map<string, string>();
  pkg.agents.forEach((agentDef, idx) => {
    agentIdByImportedName.set(collapseWhitespace(agentDef.name).toLowerCase(), agentIds[idx] || "");
  });
  snapshotMembers.forEach((member, idx) => {
    const reportsToName = collapseWhitespace(pkg.agents[idx]?.reportsToName || "").toLowerCase();
    if (!reportsToName) return;
    const reportsToId = agentIdByImportedName.get(reportsToName) || null;
    if (reportsToId && reportsToId !== member.agent.id) {
      member.role.reportsTo = reportsToId;
    }
  });

  const org = saveHierarchyOrganizationSnapshot({
    name: pkg.organization.name,
    description: pkg.organization.description,
    mission: pkg.organization.mission,
    activate: options?.activate ?? false,
    snapshot: snapshotMembers,
  });

  logActivity({
    actorType: "system",
    action: "import",
    entityType: "organization",
    entityId: org.id,
    details: { packageVersion: pkg.version, agentCount: agentIds.length },
  });

  // Create goals — first pass: top-level (no parent)
  const goalIds: string[] = [];
  const goalIdByName = new Map<string, string>();

  const topLevel = pkg.goals.filter((g) => !g.parentGoalName);
  const withParent = pkg.goals.filter((g) => !!g.parentGoalName);

  for (const goalDef of topLevel) {
    const created = createHierarchyGoal({
      name: goalDef.name,
      description: goalDef.description,
      organizationId: org.id,
      linkedDocumentIds: goalDef.linkedDocumentIds,
      deliverables: goalDef.deliverables,
      status: goalDef.status as GoalStatus | null,
      level: goalDef.level as GoalLevel | null,
    });
    goalIds.push(created.id);
    goalIdByName.set(goalDef.name, created.id);
    logActivity({
      actorType: "system",
      action: "import",
      entityType: "goal",
      entityId: created.id,
      details: { packageOrg: pkg.organization.name },
    });
  }

  // Second pass: goals with parents
  for (const goalDef of withParent) {
    const parentId = goalDef.parentGoalName ? goalIdByName.get(goalDef.parentGoalName) ?? null : null;
    const created = createHierarchyGoal({
      name: goalDef.name,
      description: goalDef.description,
      organizationId: org.id,
      parentGoalId: parentId,
      linkedDocumentIds: goalDef.linkedDocumentIds,
      deliverables: goalDef.deliverables,
      status: goalDef.status as GoalStatus | null,
      level: goalDef.level as GoalLevel | null,
    });
    goalIds.push(created.id);
    goalIdByName.set(goalDef.name, created.id);
    logActivity({
      actorType: "system",
      action: "import",
      entityType: "goal",
      entityId: created.id,
      details: { packageOrg: pkg.organization.name },
    });
  }

  // Create labels (skip if name already exists)
  const existingLabels = new Set(listTaskLabels().map((l) => l.name.toLowerCase()));
  for (const labelDef of pkg.labels) {
    if (existingLabels.has(labelDef.name.toLowerCase())) continue;
    createTaskLabel({ name: labelDef.name, color: labelDef.color, scope: labelDef.scope });
  }

  log.info("Company package imported", {
    organizationId: org.id,
    agentCount: agentIds.length,
    goalCount: goalIds.length,
  });

  return { organizationId: org.id, agentIds, goalIds };
}

function collapseWhitespace(value: string): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function clip(value: string, maxChars = 240): string {
  const collapsed = collapseWhitespace(value);
  if (!collapsed) return "";
  if (collapsed.length <= maxChars) return collapsed;
  return `${collapsed.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function toUsdBudget(raw: unknown): number | null {
  const numeric = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return numeric > 10000 ? Math.round((numeric / 100) * 100) / 100 : numeric;
}

function mapExternalAdapterToModelRef(raw: unknown): string | null {
  const adapter = collapseWhitespace(typeof raw === "string" ? raw : "").toLowerCase();
  if (!adapter) return null;
  if (adapter.includes("gemini")) return "google:gemini-3-flash-preview";
  if (adapter.includes("claude")) return "anthropic:claude-sonnet-4";
  if (adapter.includes("openai")) return "openai:gpt-5-mini";
  if (adapter.includes("ollama")) return "ollama:llama3.1";
  return null;
}

function readJsonIfExists(filePath: string): Record<string, unknown> | null {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function buildExternalCompanyPackage(raw: Record<string, unknown>, sourcePath: string): CompanyPackage {
  const company = (raw.company || raw.organization || raw.template || raw) as Record<string, unknown>;
  const agentsRaw = Array.isArray(raw.agents)
    ? raw.agents
    : Array.isArray(company.agents)
      ? company.agents
      : [];
  const goalsRaw = Array.isArray(raw.goals)
    ? raw.goals
    : Array.isArray(raw.initiatives)
      ? raw.initiatives
      : Array.isArray(company.goals)
        ? company.goals
        : Array.isArray(company.initiatives)
          ? company.initiatives
          : [];

  const agents: CompanyPackage["agents"] = agentsRaw.map((entry, index) => {
    const agent = (entry || {}) as Record<string, unknown>;
    const adapter = (agent.adapter || agent.adapterConfig || agent.config || {}) as Record<string, unknown>;
    const budget =
      toUsdBudget(agent.spendCapUsd) ??
      toUsdBudget(agent.budgetUsd) ??
      toUsdBudget(agent.monthlyBudgetUsd) ??
      toUsdBudget(agent.monthlyBudgetCents);
    const role = collapseWhitespace(
      String(agent.title || agent.roleTitle || agent.role || agent.jobTitle || `Imported Agent ${index + 1}`),
    );
    const description = clip(String(agent.description || agent.capabilitiesDescription || agent.summary || ""));
    const reportsToName = collapseWhitespace(String(agent.reportsToName || agent.reportsTo || agent.manager || ""));
    const enabledSkills = description ? [`Imported focus: ${description}`] : [];
    return {
      name: collapseWhitespace(String(agent.name || `Imported Agent ${index + 1}`)),
      modelRef:
        collapseWhitespace(String(agent.modelRef || agent.model || "")) ||
        mapExternalAdapterToModelRef(agent.adapterType || adapter.type || adapter.adapterType),
      role,
      reportsToName: reportsToName || null,
      disabledTools: [],
      enabledExtensions: [],
      enabledSkills,
      execAllowlist: [],
      spendCapUsd: budget,
      spendWindowDays: 30,
      budgetAction: "warn",
      heartbeatCron: collapseWhitespace(String(agent.heartbeatCron || agent.schedule || "")) || null,
      isDefault: index === 0,
    };
  });

  const goals: CompanyPackage["goals"] = goalsRaw.map((entry, index) => {
    const goal = (entry || {}) as Record<string, unknown>;
    return {
      name: collapseWhitespace(String(goal.name || goal.title || `Imported Goal ${index + 1}`)),
      description: clip(String(goal.description || goal.summary || goal.mission || "")) || null,
      parentGoalName: collapseWhitespace(String(goal.parentGoalName || goal.parent || goal.parentTitle || "")) || null,
      linkedDocumentIds: [],
      deliverables: Array.isArray(goal.deliverables)
        ? goal.deliverables.map((value) => collapseWhitespace(String(value))).filter(Boolean)
        : [],
      status: collapseWhitespace(String(goal.status || "")) || null,
      level: collapseWhitespace(String(goal.level || "")) || null,
    };
  });

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    organization: {
      name: collapseWhitespace(String(company.name || company.companyName || path.basename(sourcePath, path.extname(sourcePath)) || "Imported Company")),
      description: clip(String(company.description || company.summary || company.useCase || "")) || null,
      mission: clip(String(company.mission || company.direction || "")) || null,
    },
    agents,
    goals,
    labels: [],
  };
}

function buildExternalCompanyPackageFromDirectory(rootDir: string): CompanyPackage {
  const manifest =
    readJsonIfExists(path.join(rootDir, "company.json")) ??
    readJsonIfExists(path.join(rootDir, "template.json"));
  if (manifest) return buildExternalCompanyPackage(manifest, rootDir);

  const agentsDir = path.join(rootDir, "agents");
  if (!fs.existsSync(agentsDir) || !fs.statSync(agentsDir).isDirectory()) {
    throw new Error(`No company manifest found in ${rootDir}`);
  }
  const agentEntries = fs.readdirSync(agentsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  const agents = agentEntries.map((entry, index) => {
    const agentRoot = path.join(agentsDir, entry.name);
    const soul = fs.existsSync(path.join(agentRoot, "SOUL.md")) ? fs.readFileSync(path.join(agentRoot, "SOUL.md"), "utf8") : "";
    const heartbeat = fs.existsSync(path.join(agentRoot, "HEARTBEAT.md")) ? fs.readFileSync(path.join(agentRoot, "HEARTBEAT.md"), "utf8") : "";
    return {
      name: humanizePathSegment(entry.name),
      modelRef: null,
      role: clip(firstHeadingOrLine(soul) || `Imported Agent ${index + 1}`),
      reportsToName: null,
      disabledTools: [],
      enabledExtensions: [],
      enabledSkills: [
        clip(firstNonEmptyParagraph(soul) || "Imported from agent workspace."),
        clip(firstNonEmptyParagraph(heartbeat) || ""),
      ].filter(Boolean),
      execAllowlist: [],
      spendCapUsd: null,
      spendWindowDays: 30,
      budgetAction: "warn" as const,
      heartbeatCron: null,
      isDefault: index === 0,
    };
  });
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    organization: {
      name: humanizePathSegment(path.basename(rootDir)),
      description: "Imported from a company directory.",
      mission: null,
    },
    agents,
    goals: [],
    labels: [],
  };
}

function humanizePathSegment(value: string): string {
  return collapseWhitespace(String(value || "").replace(/[-_]+/g, " ")).replace(/\b\w/g, (char) => char.toUpperCase());
}

function firstHeadingOrLine(markdown: string): string {
  for (const rawLine of String(markdown || "").split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^#+\s*/, "");
    if (line) return line;
  }
  return "";
}

function firstNonEmptyParagraph(markdown: string): string {
  const blocks = String(markdown || "").split(/\r?\n\r?\n/).map((block) => clip(block));
  return blocks.find(Boolean) || "";
}

export function importExternalCompanyTemplate(
  sourcePathRaw: string,
  options?: { activate?: boolean },
): { organizationId: string; agentIds: string[]; goalIds: string[]; package: CompanyPackage } {
  const sourcePath = path.resolve(String(sourcePathRaw || ""));
  if (!sourcePath) throw new Error("Company-template source path is required");
  if (!fs.existsSync(sourcePath)) throw new Error(`Company-template source not found: ${sourcePath}`);
  const stats = fs.statSync(sourcePath);
  const pkg = stats.isDirectory()
    ? buildExternalCompanyPackageFromDirectory(sourcePath)
    : buildExternalCompanyPackage(JSON.parse(fs.readFileSync(sourcePath, "utf8")) as Record<string, unknown>, sourcePath);
  const imported = importCompanyPackage(pkg, options);
  return { ...imported, package: pkg };
}

/* ─── Built-in Packages ─── */

const BUILTIN_PACKAGES: Array<{ key: string; name: string; description: string; pkg: CompanyPackage }> = [
  {
    key: "ai-dev-team",
    name: "AI Development Team",
    description: "CEO orchestrator with coding agents and a code reviewer — ready to ship software.",
    pkg: {
      version: 1,
      exportedAt: "2026-01-01T00:00:00.000Z",
      organization: {
        name: "AI Development Team",
        description: "A focused software engineering team powered by AI agents.",
        mission: "Build and ship high-quality software products rapidly.",
      },
      agents: [
        {
          name: "CEO Agent",
          modelRef: "sonnet",
          role: "Orchestrator",
          disabledTools: [],
          enabledExtensions: ["coding", "github"],
          enabledSkills: ["autonomous-researcher", "code-reviewer"],
          execAllowlist: [],
          spendCapUsd: 20,
          spendWindowDays: 7,
          budgetAction: "warn",
          heartbeatCron: "0 9 * * 1",
          isDefault: true,
        },
        {
          name: "Backend Engineer",
          modelRef: "sonnet",
          role: "Backend Developer",
          disabledTools: [],
          enabledExtensions: ["coding", "github"],
          enabledSkills: ["code-reviewer"],
          execAllowlist: [],
          spendCapUsd: 10,
          spendWindowDays: 7,
          budgetAction: "warn",
          heartbeatCron: null,
          isDefault: false,
        },
        {
          name: "Frontend Engineer",
          modelRef: "sonnet",
          role: "Frontend Developer",
          disabledTools: [],
          enabledExtensions: ["coding"],
          enabledSkills: ["code-reviewer"],
          execAllowlist: [],
          spendCapUsd: 10,
          spendWindowDays: 7,
          budgetAction: "warn",
          heartbeatCron: null,
          isDefault: false,
        },
        {
          name: "Code Reviewer",
          modelRef: "sonnet",
          role: "Reviewer",
          disabledTools: [],
          enabledExtensions: ["coding", "github"],
          enabledSkills: ["code-reviewer", "diffs"],
          execAllowlist: [],
          spendCapUsd: 5,
          spendWindowDays: 7,
          budgetAction: "block",
          heartbeatCron: null,
          isDefault: false,
        },
      ],
      goals: [
        { name: "Ship v1.0", description: "Deliver the first stable release.", parentGoalName: null },
        { name: "Core Features", description: "Implement all core product features.", parentGoalName: "Ship v1.0" },
        { name: "Testing", description: "Achieve 80%+ test coverage and zero critical bugs.", parentGoalName: "Ship v1.0" },
      ],
      labels: [
        { name: "backend", color: "#ff0000", scope: "global" },
        { name: "frontend", color: "#cc0000", scope: "global" },
        { name: "review-needed", color: "#990000", scope: "global" },
      ],
    },
  },
  {
    key: "content-studio",
    name: "Content Studio",
    description: "Content Director, Writer, Editor, and SEO Analyst — a full content production pipeline.",
    pkg: {
      version: 1,
      exportedAt: "2026-01-01T00:00:00.000Z",
      organization: {
        name: "Content Studio",
        description: "An AI-powered content creation and publishing team.",
        mission: "Produce high-quality content that drives organic growth.",
      },
      agents: [
        {
          name: "Content Director",
          modelRef: "sonnet",
          role: "Orchestrator",
          disabledTools: [],
          enabledExtensions: ["web-research"],
          enabledSkills: ["autonomous-researcher", "summarize"],
          execAllowlist: [],
          spendCapUsd: 15,
          spendWindowDays: 7,
          budgetAction: "warn",
          heartbeatCron: "0 8 * * 1",
          isDefault: true,
        },
        {
          name: "Content Writer",
          modelRef: "sonnet",
          role: "Writer",
          disabledTools: [],
          enabledExtensions: ["web-research"],
          enabledSkills: ["summarize", "blogwatcher"],
          execAllowlist: [],
          spendCapUsd: 10,
          spendWindowDays: 7,
          budgetAction: "warn",
          heartbeatCron: null,
          isDefault: false,
        },
        {
          name: "Editor",
          modelRef: "sonnet",
          role: "Editor",
          disabledTools: [],
          enabledExtensions: [],
          enabledSkills: ["summarize"],
          execAllowlist: [],
          spendCapUsd: 5,
          spendWindowDays: 7,
          budgetAction: "warn",
          heartbeatCron: null,
          isDefault: false,
        },
        {
          name: "SEO Analyst",
          modelRef: "sonnet",
          role: "SEO Analyst",
          disabledTools: [],
          enabledExtensions: ["web-research"],
          enabledSkills: ["autonomous-researcher", "blogwatcher"],
          execAllowlist: [],
          spendCapUsd: 8,
          spendWindowDays: 7,
          budgetAction: "warn",
          heartbeatCron: null,
          isDefault: false,
        },
      ],
      goals: [
        { name: "Content Pipeline", description: "Build a reliable, repeatable content production process.", parentGoalName: null },
        { name: "Weekly Articles", description: "Publish at least 4 high-quality articles per week.", parentGoalName: "Content Pipeline" },
        { name: "SEO Optimization", description: "Rank top-5 for 10 target keywords within 90 days.", parentGoalName: "Content Pipeline" },
      ],
      labels: [
        { name: "draft", color: "#ff0000", scope: "global" },
        { name: "in-review", color: "#cc0000", scope: "global" },
        { name: "published", color: "#990000", scope: "global" },
        { name: "seo", color: "#660000", scope: "global" },
      ],
    },
  },
  {
    key: "research-lab",
    name: "AI Research Lab",
    description: "Research Lead with Research Assistants and a Data Analyst — designed for deep investigation.",
    pkg: {
      version: 1,
      exportedAt: "2026-01-01T00:00:00.000Z",
      organization: {
        name: "AI Research Lab",
        description: "A systematic AI research team built for literature review and data-driven insights.",
        mission: "Generate novel research output and actionable data insights.",
      },
      agents: [
        {
          name: "Research Lead",
          modelRef: "sonnet",
          role: "Orchestrator",
          disabledTools: [],
          enabledExtensions: ["web-research"],
          enabledSkills: ["autonomous-researcher", "summarize"],
          execAllowlist: [],
          spendCapUsd: 20,
          spendWindowDays: 7,
          budgetAction: "warn",
          heartbeatCron: "0 9 * * 1",
          isDefault: true,
        },
        {
          name: "Research Assistant A",
          modelRef: "sonnet",
          role: "Research Assistant",
          disabledTools: [],
          enabledExtensions: ["web-research"],
          enabledSkills: ["autonomous-researcher", "blogwatcher"],
          execAllowlist: [],
          spendCapUsd: 10,
          spendWindowDays: 7,
          budgetAction: "warn",
          heartbeatCron: null,
          isDefault: false,
        },
        {
          name: "Research Assistant B",
          modelRef: "sonnet",
          role: "Research Assistant",
          disabledTools: [],
          enabledExtensions: ["web-research"],
          enabledSkills: ["autonomous-researcher", "summarize"],
          execAllowlist: [],
          spendCapUsd: 10,
          spendWindowDays: 7,
          budgetAction: "warn",
          heartbeatCron: null,
          isDefault: false,
        },
        {
          name: "Data Analyst",
          modelRef: "sonnet",
          role: "Data Analyst",
          disabledTools: [],
          enabledExtensions: ["coding"],
          enabledSkills: ["autonomous-researcher"],
          execAllowlist: [],
          spendCapUsd: 8,
          spendWindowDays: 7,
          budgetAction: "warn",
          heartbeatCron: null,
          isDefault: false,
        },
      ],
      goals: [
        { name: "Research Output", description: "Produce rigorous, documented research findings.", parentGoalName: null },
        { name: "Literature Review", description: "Survey and synthesize relevant prior work.", parentGoalName: "Research Output" },
        { name: "Data Analysis", description: "Run quantitative analysis on collected datasets.", parentGoalName: "Research Output" },
      ],
      labels: [
        { name: "hypothesis", color: "#ff0000", scope: "global" },
        { name: "literature", color: "#cc0000", scope: "global" },
        { name: "data", color: "#990000", scope: "global" },
        { name: "finding", color: "#660000", scope: "global" },
      ],
    },
  },
];

export function listBuiltinPackages(): Array<{ key: string; name: string; description: string }> {
  return BUILTIN_PACKAGES.map(({ key, name, description }) => ({ key, name, description }));
}

export function getBuiltinPackage(key: string): CompanyPackage | null {
  return BUILTIN_PACKAGES.find((p) => p.key === key)?.pkg ?? null;
}
