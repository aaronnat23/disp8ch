import { getSqlite, initializeDatabase } from "@/lib/db";
import { getAgentById, getDefaultAgent, listAgents, type AgentRecord } from "@/lib/agents/registry";
import { listAgentRoles, type AgentRoleRecord, type AgentRoleType } from "@/lib/agents/roles";
import { getModelPricing } from "@/lib/agents/cost-estimator";
import { checkModelToolSupport } from "@/lib/agents/model-capabilities";
import { getModelConfig, resolveModelRefConfig } from "@/lib/agents/model-router";
import { isProviderLocallyHosted, providerRequiresApiKey } from "@/lib/agents/provider-plugins";
import {
  getHierarchyOrganizationById,
  getActiveHierarchyOrganization,
  listHierarchyOrganizationMembers,
  type HierarchyOrganizationSnapshotMember,
} from "@/lib/hierarchy/organizations";
import type { DynamicWorkflowAgentKind, SupervisedRoleBinding, SupervisionConfig } from "./types";
import { getCodexOAuthStatus } from "./external-backends";
import { CODEX_OAUTH_DEFAULT_MODEL, CODEX_OAUTH_MODEL_REF, CODEX_OAUTH_PROVIDER, parseExternalModelRef } from "./external-models";
import { getWorkspaceDir } from "@/lib/workspace/files";

export type DeliveryPolicyMode = "agent_defaults" | "balanced" | "quality" | "fast" | "local" | "custom";
export type DeliveryRole = "planner" | "implementer" | "reviewer";

export type DeliveryPolicy = {
  mode: DeliveryPolicyMode;
  plannerModelRef: string | null;
  implementerModelRef: string | null;
  reviewerModelRef: string | null;
  updatedAt: string;
};

export type DeliveryModelOption = {
  id: string;
  provider: string;
  modelId: string;
  name: string;
  priority: number;
  fastMode: boolean;
  runtimeKind: "local" | "remote";
  priceClass: "economy" | "standard" | "premium" | "unknown";
  callable: boolean;
  agentKind: DynamicWorkflowAgentKind;
  presetEligible: boolean;
};

export type ResolvedDeliveryRole = {
  agentId: string;
  agentName: string;
  modelRef: string;
  provider: string;
  modelId: string;
  agentKind: DynamicWorkflowAgentKind;
  agentSource: "explicit" | "selected_agent" | "organization" | "default";
  modelSource: "explicit" | "single_model" | "policy" | "agent" | "app_default";
};

export type ResolvedDeliveryTeam = {
  policy: DeliveryPolicy;
  organizationId: string | null;
  organizationName: string | null;
  selectedAgentId: string | null;
  planner: ResolvedDeliveryRole;
  implementer: ResolvedDeliveryRole;
  reviewer: ResolvedDeliveryRole;
  supervision: SupervisionConfig;
  workspaceRoot: string;
  sharedModelMode: boolean;
  singleConfiguredModel: boolean;
  warnings: string[];
};

type DeliveryPolicyRow = {
  mode: string;
  planner_model_ref: string | null;
  implementer_model_ref: string | null;
  reviewer_model_ref: string | null;
  updated_at: string;
};

type ModelRow = {
  id: string;
  provider: string;
  model_id: string;
  name: string;
  priority: number | null;
  fast_mode: number | null;
  is_active: number;
};

type TeamMember = {
  agent: AgentRecord;
  role: Pick<AgentRoleRecord, "roleType" | "reportsTo">;
};

const MODES = new Set<DeliveryPolicyMode>(["agent_defaults", "balanced", "quality", "fast", "local", "custom"]);
const DEFAULT_MODE: DeliveryPolicyMode = "balanced";

function ensurePolicyTable() {
  initializeDatabase();
  const db = getSqlite();
  db.exec(`
    CREATE TABLE IF NOT EXISTS supervised_delivery_policy (
      id TEXT PRIMARY KEY,
      mode TEXT NOT NULL DEFAULT 'balanced',
      planner_model_ref TEXT,
      implementer_model_ref TEXT,
      reviewer_model_ref TEXT,
      updated_at TEXT NOT NULL
    )
  `);
  const existing = db.prepare("SELECT id FROM supervised_delivery_policy WHERE id = 'default'").get();
  if (!existing) {
    db.prepare("INSERT INTO supervised_delivery_policy (id, mode, updated_at) VALUES ('default', ?, ?)")
      .run(DEFAULT_MODE, new Date().toISOString());
  }
  return db;
}

function normalizeMode(value: unknown): DeliveryPolicyMode {
  const mode = String(value || "").trim() as DeliveryPolicyMode;
  return MODES.has(mode) ? mode : DEFAULT_MODE;
}

function mapPolicy(row: DeliveryPolicyRow): DeliveryPolicy {
  return {
    mode: normalizeMode(row.mode),
    plannerModelRef: row.planner_model_ref || null,
    implementerModelRef: row.implementer_model_ref || null,
    reviewerModelRef: row.reviewer_model_ref || null,
    updatedAt: row.updated_at,
  };
}

export function getDeliveryPolicy(): DeliveryPolicy {
  const db = ensurePolicyTable();
  const row = db.prepare("SELECT * FROM supervised_delivery_policy WHERE id = 'default'").get() as DeliveryPolicyRow;
  return mapPolicy(row);
}

function requireCallableModelRef(modelRef: string, label: string): void {
  const external = parseExternalModelRef(modelRef);
  if (external?.agentKind === "codex") {
    const status = getCodexOAuthStatus();
    if (!status.available || !status.authenticated) throw new Error(`${label} Codex OAuth backend is unavailable: ${status.detail}`);
    return;
  }
  const model = resolveModelRefConfig(modelRef);
  if (!model?.provider || !model.modelId) throw new Error(`${label} model is inactive or no longer configured.`);
  if (providerRequiresApiKey(model.provider) && !model.apiKey) {
    throw new Error(`${label} model has no usable credential.`);
  }
}

export function saveDeliveryPolicy(input: {
  mode: DeliveryPolicyMode;
  plannerModelRef?: string | null;
  implementerModelRef?: string | null;
  reviewerModelRef?: string | null;
}): DeliveryPolicy {
  const mode = normalizeMode(input.mode);
  const plannerModelRef = String(input.plannerModelRef || "").trim() || null;
  const implementerModelRef = String(input.implementerModelRef || "").trim() || null;
  const reviewerModelRef = String(input.reviewerModelRef || "").trim() || null;
  if (mode === "custom") {
    if (!plannerModelRef || !implementerModelRef || !reviewerModelRef) {
      throw new Error("Custom delivery policy requires a model for planner, implementer, and reviewer.");
    }
    requireCallableModelRef(plannerModelRef, "Planner");
    requireCallableModelRef(implementerModelRef, "Implementer");
    requireCallableModelRef(reviewerModelRef, "Reviewer");
  }
  const now = new Date().toISOString();
  const db = ensurePolicyTable();
  db.prepare(`
    UPDATE supervised_delivery_policy
    SET mode = ?, planner_model_ref = ?, implementer_model_ref = ?, reviewer_model_ref = ?, updated_at = ?
    WHERE id = 'default'
  `).run(
    mode,
    mode === "custom" ? plannerModelRef : null,
    mode === "custom" ? implementerModelRef : null,
    mode === "custom" ? reviewerModelRef : null,
    now,
  );
  return getDeliveryPolicy();
}

function priceClass(modelId: string): DeliveryModelOption["priceClass"] {
  const pricing = getModelPricing(modelId);
  if (!pricing) return "unknown";
  const blended = (pricing.inputPerMillion + pricing.outputPerMillion) / 2;
  if (blended <= 1) return "economy";
  if (blended >= 12) return "premium";
  return "standard";
}

function modelIsCallable(modelRef: string): boolean {
  const resolved = resolveModelRefConfig(modelRef);
  if (!resolved?.provider || !resolved.modelId) return false;
  if (providerRequiresApiKey(resolved.provider) && !resolved.apiKey) return false;
  return checkModelToolSupport(resolved.provider, resolved.modelId).status !== "unsupported";
}

export function listDeliveryModelOptions(): DeliveryModelOption[] {
  initializeDatabase();
  const rows = getSqlite().prepare(`
    SELECT id, provider, model_id, name, priority, fast_mode, is_active
    FROM models
    WHERE is_active = 1
    ORDER BY priority DESC, created_at DESC
  `).all() as ModelRow[];
  const options: DeliveryModelOption[] = rows.map((row) => ({
    id: row.id,
    provider: row.provider,
    modelId: row.model_id,
    name: row.name,
    priority: Number(row.priority || 0),
    fastMode: row.fast_mode === 1,
    runtimeKind: isProviderLocallyHosted(row.provider) ? "local" as const : "remote" as const,
    priceClass: priceClass(row.model_id),
    callable: modelIsCallable(row.id),
    agentKind: "internal" as const,
    presetEligible: true,
  }));
  if (options.length === 0) {
    const fallback = getModelConfig();
    const fallbackRef = `${fallback.provider}:${fallback.modelId}`;
    options.push({
      id: fallbackRef,
      provider: fallback.provider,
      modelId: fallback.modelId,
      name: `${fallback.provider}/${fallback.modelId}`,
      priority: 0,
      fastMode: Boolean(fallback.fastMode),
      runtimeKind: isProviderLocallyHosted(fallback.provider) ? "local" : "remote",
      priceClass: priceClass(fallback.modelId),
      callable: Boolean(fallback.modelId && (!providerRequiresApiKey(fallback.provider) || fallback.apiKey)),
      agentKind: "internal",
      presetEligible: true,
    });
  }
  const codex = getCodexOAuthStatus();
  options.push({
    id: CODEX_OAUTH_MODEL_REF,
    provider: CODEX_OAUTH_PROVIDER,
    modelId: CODEX_OAUTH_DEFAULT_MODEL,
    name: "Codex OAuth · GPT-5.6 Terra",
    priority: 0,
    fastMode: false,
    runtimeKind: "remote",
    priceClass: "standard",
    callable: codex.available && codex.authenticated,
    agentKind: "codex",
    presetEligible: false,
  });
  return options;
}

function qualityScore(model: DeliveryModelOption): number {
  const id = model.modelId.toLowerCase();
  const qualityHint = /(?:opus|gpt-5(?:\.|-|$)|reasoner|pro|large|max)/.test(id) ? 30 : 0;
  const economyHint = /(?:flash|mini|haiku|small|instant|lite)/.test(id) ? -12 : 0;
  const priceHint = ({ economy: 0, unknown: 8, standard: 16, premium: 24 } as const)[model.priceClass];
  return qualityHint + economyHint + priceHint + Math.min(10, model.priority);
}

function speedScore(model: DeliveryModelOption): number {
  const id = model.modelId.toLowerCase();
  const speedHint = /(?:flash|mini|haiku|small|instant|lite)/.test(id) ? 30 : 0;
  const fastHint = model.fastMode ? 40 : 0;
  const priceHint = ({ economy: 18, unknown: 8, standard: 4, premium: 0 } as const)[model.priceClass];
  return fastHint + speedHint + priceHint + Math.min(10, model.priority);
}

function choosePresetModels(
  policy: DeliveryPolicy,
  callableModels: DeliveryModelOption[],
  warnings: string[],
): Record<DeliveryRole, DeliveryModelOption | null> {
  if (policy.mode === "agent_defaults") return { planner: null, implementer: null, reviewer: null };
  if (policy.mode === "custom") {
    const byRef = (ref: string | null) => callableModels.find((model) => model.id === ref) || null;
    return {
      planner: byRef(policy.plannerModelRef),
      implementer: byRef(policy.implementerModelRef),
      reviewer: byRef(policy.reviewerModelRef),
    };
  }
  let candidates = callableModels.filter((model) => model.presetEligible);
  if (candidates.length === 0) candidates = callableModels;
  if (policy.mode === "local") {
    const local = candidates.filter((model) => model.runtimeKind === "local");
    if (local.length > 0) candidates = local;
    else warnings.push("No callable local model is configured; the saved local/private policy fell back to callable configured models.");
  }
  const quality = [...candidates].sort((left, right) => qualityScore(right) - qualityScore(left))[0] || null;
  const fast = [...candidates].sort((left, right) => speedScore(right) - speedScore(left))[0] || quality;
  if (policy.mode === "fast") return { planner: fast, implementer: fast, reviewer: fast };
  if (policy.mode === "quality") return { planner: quality, implementer: quality, reviewer: quality };
  return { planner: quality, implementer: fast, reviewer: quality };
}

function toCurrentMember(
  member: HierarchyOrganizationSnapshotMember,
  currentById: Map<string, AgentRecord>,
): TeamMember | null {
  const agent = currentById.get(member.agent.id);
  if (!agent?.isActive) return null;
  return { agent, role: { roleType: member.role.roleType, reportsTo: member.role.reportsTo } };
}

function roleMapForAgents(agents: AgentRecord[]): TeamMember[] {
  const roles = new Map(listAgentRoles().map((role) => [role.agentId, role]));
  return agents.filter((agent) => agent.isActive).map((agent) => ({
    agent,
    role: {
      roleType: roles.get(agent.id)?.roleType ?? (agent.isDefault ? "orchestrator" : "worker"),
      reportsTo: roles.get(agent.id)?.reportsTo ?? null,
    },
  }));
}

function firstByRole(members: TeamMember[], order: AgentRoleType[], excludeId?: string): TeamMember | null {
  for (const roleType of order) {
    const match = members.find((member) => member.role.roleType === roleType && member.agent.id !== excludeId);
    if (match) return match;
  }
  return members.find((member) => member.agent.id !== excludeId) ?? members[0] ?? null;
}

function nearestPlanner(selected: TeamMember, members: TeamMember[]): TeamMember | null {
  const byId = new Map(members.map((member) => [member.agent.id, member]));
  let cursor: TeamMember | undefined = selected;
  const visited = new Set<string>();
  while (cursor?.role.reportsTo && !visited.has(cursor.agent.id)) {
    visited.add(cursor.agent.id);
    cursor = byId.get(cursor.role.reportsTo);
    if (cursor && (cursor.role.roleType === "orchestrator" || cursor.role.roleType === "operations")) return cursor;
  }
  return firstByRole(members, ["orchestrator", "operations"]);
}

function selectRoleAgents(input: {
  organizationId?: string | null;
  selectedAgentId?: string | null;
  overrides?: Partial<Record<DeliveryRole, SupervisedRoleBinding>>;
  warnings: string[];
}): {
  organizationId: string | null;
  organizationName: string | null;
  selectedAgentId: string | null;
  roles: Record<DeliveryRole, { member: TeamMember; source: ResolvedDeliveryRole["agentSource"] }>;
} {
  const activeAgents = listAgents().filter((agent) => agent.isActive);
  const currentById = new Map(activeAgents.map((agent) => [agent.id, agent]));
  const defaultAgent = currentById.get(getDefaultAgent().id) ?? activeAgents[0];
  if (!defaultAgent) throw new Error("At least one active agent is required for a supervised run.");

  const organization = input.organizationId
    ? getHierarchyOrganizationById(input.organizationId)
    : getActiveHierarchyOrganization();
  if (input.organizationId && !organization) input.warnings.push(`Organization ${input.organizationId} was not found; the default agent was used.`);
  let members = organization
    ? listHierarchyOrganizationMembers(organization.id)
      .map((member) => toCurrentMember(member, currentById))
      .filter((member): member is TeamMember => Boolean(member))
    : roleMapForAgents(activeAgents);
  if (organization && members.length === 0) {
    input.warnings.push(`Organization ${organization.name} has no active current members; the default agent was used.`);
    members = roleMapForAgents([defaultAgent]);
  }

  const selectedAgent = input.selectedAgentId ? currentById.get(input.selectedAgentId) : null;
  if (input.selectedAgentId && !selectedAgent) input.warnings.push(`Agent ${input.selectedAgentId} is missing or inactive; an automatic implementer was selected.`);
  const selectedMember = selectedAgent
    ? members.find((member) => member.agent.id === selectedAgent.id) ?? roleMapForAgents([selectedAgent])[0]
    : null;
  if (selectedMember && organization && !members.some((member) => member.agent.id === selectedMember.agent.id)) {
    input.warnings.push(`${selectedMember.agent.name} is outside ${organization.name}; nearby planner and reviewer roles were resolved from the selected organization.`);
  }

  const implementer = selectedMember ?? firstByRole(members, ["specialist", "worker", "operations", "orchestrator", "support"])!;
  const planner = (selectedMember ? nearestPlanner(selectedMember, members) : null)
    ?? firstByRole(members, ["orchestrator", "operations", "specialist", "worker", "support"])!;
  const directSupport = members.find((member) => member.role.roleType === "support" && member.role.reportsTo === implementer.agent.id);
  const reviewer = directSupport
    ?? firstByRole(members, ["support", "operations", "orchestrator", "specialist", "worker"], implementer.agent.id)
    ?? planner;
  const automatic = { planner, implementer, reviewer };

  const resolvedRoles = {} as Record<DeliveryRole, { member: TeamMember; source: ResolvedDeliveryRole["agentSource"] }>;
  for (const role of ["planner", "implementer", "reviewer"] as const) {
    const explicitId = String(input.overrides?.[role]?.agentId || "").trim();
    if (explicitId) {
      const explicitAgent = getAgentById(explicitId);
      if (!explicitAgent?.isActive) throw new Error(`Explicit ${role} agent is missing or inactive: ${explicitId}`);
      const member = roleMapForAgents([explicitAgent])[0];
      resolvedRoles[role] = { member, source: "explicit" };
      continue;
    }
    resolvedRoles[role] = {
      member: automatic[role],
      source: role === "implementer" && selectedMember
        ? "selected_agent"
        : organization
          ? "organization"
          : "default",
    };
  }
  return {
    organizationId: organization?.id ?? null,
    organizationName: organization?.name ?? null,
    selectedAgentId: selectedAgent?.id ?? null,
    roles: resolvedRoles,
  };
}

function canonicalModelRef(provider: string, modelId: string, options: DeliveryModelOption[]): string {
  return options.find((option) => option.provider === provider && option.modelId === modelId)?.id ?? `${provider}:${modelId}`;
}

function resolveRoleModel(input: {
  role: DeliveryRole;
  agent: AgentRecord;
  explicitRef?: string;
  singleModel: DeliveryModelOption | null;
  policyModel: DeliveryModelOption | null;
  options: DeliveryModelOption[];
  warnings: string[];
}): Omit<ResolvedDeliveryRole, "agentId" | "agentName" | "agentSource"> {
  const candidates: Array<{ ref: string | null | undefined; source: ResolvedDeliveryRole["modelSource"] }> = [];
  if (input.explicitRef) candidates.push({ ref: input.explicitRef, source: "explicit" });
  if (input.singleModel) candidates.push({ ref: input.singleModel.id, source: "single_model" });
  if (input.policyModel) candidates.push({ ref: input.policyModel.id, source: "policy" });
  if (input.agent.modelRef) candidates.push({ ref: input.agent.modelRef, source: "agent" });

  for (const candidate of candidates) {
    if (!candidate.ref) continue;
    const option = input.options.find((item) => item.id === candidate.ref);
    if (option?.callable) {
      return {
        modelRef: option.id,
        provider: option.provider,
        modelId: option.modelId,
        agentKind: option.agentKind,
        modelSource: candidate.source,
      };
    }
    const model = resolveModelRefConfig(candidate.ref);
    if (!model?.provider || !model.modelId || (providerRequiresApiKey(model.provider) && !model.apiKey)) {
      if (candidate.source === "explicit") throw new Error(`Explicit ${input.role} model is unavailable: ${candidate.ref}`);
      input.warnings.push(`${input.role} model ${candidate.ref} is unavailable; the next configured fallback was used.`);
      continue;
    }
    return {
      modelRef: canonicalModelRef(model.provider, model.modelId, input.options),
      provider: model.provider,
      modelId: model.modelId,
      agentKind: "internal",
      modelSource: candidate.source,
    };
  }

  const model = getModelConfig({ agentId: input.agent.id });
  if (!model.provider || !model.modelId || (providerRequiresApiKey(model.provider) && !model.apiKey)) {
    throw new Error(`No callable model is available for the ${input.role} role.`);
  }
  return {
    modelRef: canonicalModelRef(model.provider, model.modelId, input.options),
    provider: model.provider,
    modelId: model.modelId,
    agentKind: "internal",
    modelSource: "app_default",
  };
}

export function resolveSupervisedDelivery(input: {
  organizationId?: string | null;
  selectedAgentId?: string | null;
  overrides?: Partial<Record<DeliveryRole, SupervisedRoleBinding>>;
  maxRepairPasses?: number;
} = {}): ResolvedDeliveryTeam {
  const warnings: string[] = [];
  const policy = getDeliveryPolicy();
  const team = selectRoleAgents({ ...input, warnings });
  const options = listDeliveryModelOptions();
  const callableModels = options.filter((model) => model.callable);
  if (callableModels.length === 0) throw new Error("No callable model is configured for supervised delivery.");
  const configuredCallableModels = callableModels.filter((model) => model.presetEligible);
  const singleModel = policy.mode === "custom"
    ? null
    : configuredCallableModels.length === 1
      ? configuredCallableModels[0]
      : configuredCallableModels.length === 0 && callableModels.length === 1
        ? callableModels[0]
        : null;
  const policyModels = choosePresetModels(policy, callableModels, warnings);

  const resolved = {} as Record<DeliveryRole, ResolvedDeliveryRole>;
  for (const role of ["planner", "implementer", "reviewer"] as const) {
    const agentResolution = team.roles[role];
    const modelResolution = resolveRoleModel({
      role,
      agent: agentResolution.member.agent,
      explicitRef: String(input.overrides?.[role]?.modelRef || "").trim() || undefined,
      singleModel,
      policyModel: policyModels[role],
      options,
      warnings,
    });
    resolved[role] = {
      agentId: agentResolution.member.agent.id,
      agentName: agentResolution.member.agent.name,
      agentSource: agentResolution.source,
      ...modelResolution,
    };
  }

  const sharedModelMode = new Set([resolved.planner.modelRef, resolved.implementer.modelRef, resolved.reviewer.modelRef]).size === 1;
  const maxRepairPasses = Math.max(0, Math.min(2, Math.round(input.maxRepairPasses ?? 1)));
  return {
    policy,
    organizationId: team.organizationId,
    organizationName: team.organizationName,
    selectedAgentId: team.selectedAgentId,
    planner: resolved.planner,
    implementer: resolved.implementer,
    reviewer: resolved.reviewer,
    supervision: {
      version: 1,
      mode: "supervised",
      planner: { agentId: resolved.planner.agentId, agentKind: resolved.planner.agentKind, modelRef: resolved.planner.modelRef, toolsets: input.overrides?.planner?.toolsets },
      implementer: { agentId: resolved.implementer.agentId, agentKind: resolved.implementer.agentKind, modelRef: resolved.implementer.modelRef, toolsets: input.overrides?.implementer?.toolsets },
      reviewer: { agentId: resolved.reviewer.agentId, agentKind: resolved.reviewer.agentKind, modelRef: resolved.reviewer.modelRef, toolsets: input.overrides?.reviewer?.toolsets },
      maxRepairPasses,
      requireHumanApprovalBeforePublish: true,
    },
    workspaceRoot: getWorkspaceDir({ workspacePath: team.roles.implementer.member.agent.workspacePath }),
    sharedModelMode,
    singleConfiguredModel: Boolean(singleModel),
    warnings: [...new Set(warnings)],
  };
}
