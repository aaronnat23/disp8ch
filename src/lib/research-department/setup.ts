import { getSqlite, initializeDatabase } from "@/lib/db";
import { createAgent, deleteAgent, getAgentById } from "@/lib/agents/registry";
import { restartWorkflowCrons, unscheduleCronWorkflow } from "@/lib/cron/manager";
import { initializeVault, sanitizeSlug, defaultVaultRoot, removeVault } from "./vault";
import { getRoleTemplate, resolveRoleModel, rolesForTier } from "./templates";
import { buildDepartmentWorkflows } from "./workflows";
import {
  addMember,
  addWorkflowLink,
  deleteDepartmentRecord,
  ensureResearchDepartmentTables,
  insertDepartment,
  slugExists,
} from "./store";
import {
  DEFAULT_RESEARCH_SAFETY,
  RESEARCH_DEPARTMENT_SOURCE_TYPE,
  type CreateResearchDepartmentInput,
  type ResearchDeliveryConfig,
  type ResearchDepartmentRole,
  type ResearchSafetyConfig,
  type ResearchSourceConfig,
} from "./types";

export interface SetupResult {
  departmentId: string;
  slug: string;
  vaultRoot: string;
  agents: Array<{ role: ResearchDepartmentRole; agentId: string }>;
  workflows: Array<{ kind: string; workflowId: string; name: string }>;
}

const CHANNEL_NODE_BY_DELIVERY: Record<ResearchDeliveryConfig["channel"], string> = {
  webchat: "send-webchat",
  telegram: "send-telegram",
  slack: "send-slack",
  discord: "send-discord",
};

function discoverFallbackModels(): { fast: string | null; strong: string | null } {
  try {
    const db = getSqlite();
    const rows = db
      .prepare("SELECT id FROM models WHERE is_active = 1 ORDER BY priority DESC")
      .all() as Array<{ id: string }>;
    if (rows.length === 0) return { fast: null, strong: null };
    // Default every role to the highest-priority (primary) configured model. Only
    // diverge when the user explicitly assigns a cheaper model per role — picking
    // the lowest-priority model automatically can land on a misconfigured/secondary
    // provider. "strong" stays the primary; "fast" also defaults to it.
    return { strong: rows[0].id, fast: rows[0].id };
  } catch {
    return { fast: null, strong: null };
  }
}

function normalizeSources(raw: ResearchSourceConfig | undefined): ResearchSourceConfig {
  return {
    keywords: (raw?.keywords ?? []).map((s) => s.trim()).filter(Boolean),
    rssFeeds: (raw?.rssFeeds ?? []).map((s) => s.trim()).filter(Boolean),
    arxivCategories: (raw?.arxivCategories ?? []).map((s) => s.trim()).filter(Boolean),
    competitorUrls: (raw?.competitorUrls ?? []).map((s) => s.trim()).filter(Boolean),
  };
}

function uniqueSlug(base: string): string {
  const root = sanitizeSlug(base);
  if (!slugExists(root)) return root;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${root}-${i}`;
    if (!slugExists(candidate)) return candidate;
  }
  return `${root}-${Date.now()}`;
}

/**
 * Create a full research department: vault + agents + workflows + schedules,
 * grouped by a department record. Rolls back created agents/workflows/record/vault
 * if any step fails before completion.
 */
export function createResearchDepartment(input: CreateResearchDepartmentInput): SetupResult {
  initializeDatabase();
  ensureResearchDepartmentTables();

  if (!input.name?.trim()) throw new Error("Department name is required.");
  if (!input.focusArea?.trim()) throw new Error("Focus area is required.");

  const tier = input.tier;
  const slug = uniqueSlug(input.name);
  const sources = normalizeSources(input.sources);
  const delivery: ResearchDeliveryConfig = input.delivery ?? { channel: "webchat" };
  const safety: ResearchSafetyConfig = { ...DEFAULT_RESEARCH_SAFETY, ...(input.safety ?? {}) };
  const vaultRoot = input.vaultRoot?.trim() || defaultVaultRoot(slug);

  const createdAgentIds: string[] = [];
  const createdWorkflowIds: string[] = [];
  let createdDepartmentId: string | null = null;
  let vaultCreated = false;

  try {
    // 1. Vault.
    const { paths } = initializeVault(vaultRoot, {
      focusArea: input.focusArea,
      allowCustomPath: input.allowCustomVaultPath,
    });
    vaultCreated = true;

    // 2. Agents (real, editable records — one per role for the tier).
    const fallbackModels = discoverFallbackModels();
    const roles = rolesForTier(tier);
    const agentByRole: Partial<Record<ResearchDepartmentRole, string>> = {};
    const tempByRole: Record<ResearchDepartmentRole, number> = { scout: 0.2, analyst: 0.3, briefer: 0.4 };

    for (const role of roles) {
      const tmpl = getRoleTemplate(role);
      const agentId = `${slug}-${role}`;
      const modelRef = resolveRoleModel(role, input.models, fallbackModels);
      // MCP server is scoped to the Analyst only, and only on the advanced tier.
      const enabledExtensions =
        role === "analyst" && tier === "advanced" && safety.analystMcpServer
          ? [safety.analystMcpServer]
          : [];
      createAgent({
        id: agentId,
        name: `${input.name} ${tmpl.displayName}`,
        modelRef,
        systemPrompt: tmpl.systemPrompt,
        temperature: tempByRole[role],
        enabledExtensions,
        spendCapUsd: safety.perRunTokenCap > 0 ? Number((safety.perRunTokenCap / 1_000_000 * 5).toFixed(4)) : null,
        budgetAction: tier === "advanced" ? "block" : "warn",
      });
      createdAgentIds.push(agentId);
      agentByRole[role] = agentId;
    }

    // 3. Department record.
    const record = insertDepartment({
      name: input.name.trim(),
      slug,
      tier,
      focusArea: input.focusArea.trim(),
      keywords: sources.keywords,
      sourceConfig: sources,
      vaultRoot,
      deliveryConfig: delivery,
      safetyConfig: safety,
    });
    createdDepartmentId = record.id;

    for (const role of roles) {
      addMember(record.id, role, agentByRole[role]!);
    }

    // 4. Workflows (generic-node graphs) + schedules.
    const graphs = buildDepartmentWorkflows({
      departmentId: record.id,
      departmentName: input.name.trim(),
      focusArea: input.focusArea.trim(),
      tier,
      sources,
      paths,
      agentIds: { scout: agentByRole.scout, analyst: agentByRole.analyst, briefer: agentByRole.briefer },
      deliveryChannelNode: CHANNEL_NODE_BY_DELIVERY[delivery.channel] || "send-webchat",
      maxSourcesPerRun: safety.maxSourcesPerRun,
    });

    const db = getSqlite();
    const now = new Date().toISOString();
    const workflows: SetupResult["workflows"] = [];
    const isActive = input.inactive ? 0 : 1;

    for (const graph of graphs) {
      const workflowId = `wf-${slug}-${graph.kind}`.slice(0, 80);
      db.prepare(
        "INSERT INTO workflows (id, name, description, nodes, edges, organization_id, goal_id, source_type, source_ref, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        workflowId,
        graph.name,
        graph.description,
        JSON.stringify(graph.nodes),
        JSON.stringify(graph.edges),
        null,
        null,
        RESEARCH_DEPARTMENT_SOURCE_TYPE,
        record.id,
        isActive,
        now,
        now,
      );
      createdWorkflowIds.push(workflowId);
      addWorkflowLink(record.id, workflowId, graph.kind);
      if (isActive) {
        try {
          restartWorkflowCrons(workflowId);
        } catch {
          // Scheduling failure should not abort setup; the workflow is still editable.
        }
      }
      workflows.push({ kind: graph.kind, workflowId, name: graph.name });
    }

    return {
      departmentId: record.id,
      slug,
      vaultRoot,
      agents: roles.map((role) => ({ role, agentId: agentByRole[role]! })),
      workflows,
    };
  } catch (error) {
    // Rollback in reverse order. Vault files are removed only if we created them.
    for (const workflowId of createdWorkflowIds) {
      try {
        getSqlite().prepare("DELETE FROM workflows WHERE id = ?").run(workflowId);
        unscheduleCronWorkflow(workflowId);
      } catch {
        // ignore
      }
    }
    if (createdDepartmentId) {
      try {
        deleteDepartmentRecord(createdDepartmentId);
      } catch {
        // ignore
      }
    }
    for (const agentId of createdAgentIds) {
      try {
        if (getAgentById(agentId)) deleteAgent(agentId);
      } catch {
        // ignore
      }
    }
    if (vaultCreated && !input.vaultRoot) {
      // Only auto-created default vaults are removed; never delete a user path.
      removeVault(vaultRoot);
    }
    throw error instanceof Error ? error : new Error(String(error));
  }
}

export interface DeleteOptions {
  /** When true, also remove generated vault files. Default false (keep files). */
  deleteVault?: boolean;
}

/**
 * Delete a research department. By default this disables/pauses + removes the
 * generated workflows and agents but preserves the vault files on disk.
 */
export function deleteResearchDepartment(departmentId: string, options: DeleteOptions = {}): void {
  initializeDatabase();
  ensureResearchDepartmentTables();
  const db = getSqlite();

  const record = db.prepare("SELECT vault_root FROM research_departments WHERE id = ?").get(departmentId) as
    | { vault_root: string }
    | undefined;

  const workflowRows = db
    .prepare("SELECT workflow_id FROM research_department_workflows WHERE department_id = ?")
    .all(departmentId) as Array<{ workflow_id: string }>;
  for (const row of workflowRows) {
    try {
      db.prepare("DELETE FROM workflows WHERE id = ?").run(row.workflow_id);
      unscheduleCronWorkflow(row.workflow_id);
    } catch {
      // ignore
    }
  }

  const memberRows = db
    .prepare("SELECT agent_id FROM research_department_members WHERE department_id = ?")
    .all(departmentId) as Array<{ agent_id: string }>;
  for (const row of memberRows) {
    try {
      if (getAgentById(row.agent_id)) deleteAgent(row.agent_id);
    } catch {
      // ignore
    }
  }

  deleteDepartmentRecord(departmentId);

  if (options.deleteVault && record?.vault_root) {
    removeVault(record.vault_root);
  }
}

/** Pause (deactivate workflows) or resume (reactivate) a department. */
export function setDepartmentPaused(departmentId: string, paused: boolean): void {
  initializeDatabase();
  ensureResearchDepartmentTables();
  const db = getSqlite();
  const rows = db
    .prepare("SELECT workflow_id FROM research_department_workflows WHERE department_id = ?")
    .all(departmentId) as Array<{ workflow_id: string }>;
  for (const row of rows) {
    db.prepare("UPDATE workflows SET is_active = ? WHERE id = ?").run(paused ? 0 : 1, row.workflow_id);
    if (paused) {
      unscheduleCronWorkflow(row.workflow_id);
    } else {
      try {
        restartWorkflowCrons(row.workflow_id);
      } catch {
        // ignore
      }
    }
  }
  db.prepare("UPDATE research_departments SET status = ?, updated_at = ? WHERE id = ?").run(
    paused ? "paused" : "active",
    new Date().toISOString(),
    departmentId,
  );
}
