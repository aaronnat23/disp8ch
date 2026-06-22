import { nanoid } from "nanoid";
import { getSqlite, initializeDatabase } from "@/lib/db";
import {
  createAgent,
  getDefaultAgent,
  listAgents,
  type AgentRecord,
  updateAgent,
} from "@/lib/agents/registry";
import {
  listAgentRoles,
  type AgentRoleRecord,
  updateAgentRole,
} from "@/lib/agents/roles";
import { resolveIntegrationPresetForAgent } from "@/lib/extensions/presets";
import { recordHierarchyActivityEvent } from "@/lib/hierarchy/activity";

export type HierarchyOrganizationSnapshotMember = {
  agent: {
    id: string;
    name: string;
    workspacePath: string;
    modelRef: string | null;
    disabledTools: string[];
    enabledExtensions: string[];
    enabledSkills: string[];
    isDefault: boolean;
    isActive: boolean;
  };
  role: {
    roleType: AgentRoleRecord["roleType"];
    roleTitle: string;
    roleDescription: string;
    reportsTo: string | null;
    capabilities: string[];
    voteWeight: number;
  };
};

export type HierarchyOrganizationRecord = {
  id: string;
  name: string;
  description: string | null;
  mission: string | null;
  memberCount: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

type OrgRow = {
  id: string;
  name: string;
  description: string | null;
  mission: string | null;
  snapshot_json: string;
  is_active: number;
  created_at: string;
  updated_at: string;
};

function ensureTables() {
  initializeDatabase();
  const db = getSqlite();
  db.exec(`
    CREATE TABLE IF NOT EXISTS hierarchy_organizations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      mission TEXT,
      snapshot_json TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  const appCols = db.prepare("PRAGMA table_info(app_config)").all() as Array<{ name: string }>;
  const appColNames = new Set(appCols.map((column) => column.name));
  if (!appColNames.has("active_organization_id")) {
    db.exec("ALTER TABLE app_config ADD COLUMN active_organization_id TEXT");
  }
  return db;
}

function parseSnapshot(raw: string): HierarchyOrganizationSnapshotMember[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as HierarchyOrganizationSnapshotMember[]) : [];
  } catch {
    return [];
  }
}

function mapOrg(row: OrgRow, activeOrganizationId: string | null): HierarchyOrganizationRecord {
  const snapshot = parseSnapshot(row.snapshot_json);
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    mission: row.mission ?? null,
    memberCount: snapshot.length,
    isActive: activeOrganizationId === row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getStoredActiveOrganizationId(): string | null {
  const db = ensureTables();
  const row = db.prepare("SELECT active_organization_id FROM app_config WHERE id = 'default'").get() as
    | { active_organization_id?: string | null }
    | undefined;
  return row?.active_organization_id ? String(row.active_organization_id) : null;
}

function setStoredActiveOrganizationId(organizationId: string | null): void {
  const db = ensureTables();
  db.prepare("UPDATE app_config SET active_organization_id = ?, updated_at = ? WHERE id = 'default'")
    .run(organizationId, new Date().toISOString());
}

function captureCurrentSnapshot(memberIds?: Set<string> | null): HierarchyOrganizationSnapshotMember[] {
  const agents = listAgents().filter((agent) => {
    if (memberIds) return memberIds.has(agent.id);
    return agent.isActive || agent.isDefault;
  });
  const rolesByAgentId = new Map(listAgentRoles().map((role) => [role.agentId, role]));
  return agents.map((agent) => {
    const role = rolesByAgentId.get(agent.id);
    return {
      agent: {
        id: agent.id,
        name: agent.name,
        workspacePath: agent.workspacePath,
        modelRef: agent.modelRef,
        disabledTools: agent.disabledTools,
        enabledExtensions: agent.enabledExtensions,
        enabledSkills: agent.enabledSkills,
        isDefault: agent.isDefault,
        isActive: agent.isActive,
      },
      role: {
        roleType: role?.roleType ?? (agent.isDefault ? "orchestrator" : "worker"),
        roleTitle: role?.roleTitle ?? (agent.isDefault ? "Orchestrator" : "Worker Agent"),
        roleDescription: role?.roleDescription ?? "",
        reportsTo: role?.reportsTo ?? (agent.isDefault ? null : getDefaultAgent().id),
        capabilities: role?.capabilities ?? [],
        voteWeight: role?.voteWeight ?? 1,
      },
    };
  });
}

export function buildHierarchyOrganizationSnapshot(memberIds?: Iterable<string> | null): HierarchyOrganizationSnapshotMember[] {
  const scopedIds = memberIds ? new Set(Array.from(memberIds, (value) => String(value || "").trim()).filter(Boolean)) : null;
  return captureCurrentSnapshot(scopedIds);
}

function seedDefaultOrganization(): void {
  const db = ensureTables();
  const count = db.prepare("SELECT COUNT(*) AS count FROM hierarchy_organizations").get() as
    | { count?: number }
    | undefined;
  if (Number(count?.count || 0) > 0) return;
  const now = new Date().toISOString();
  const id = "default-org";
  db.prepare(
    "INSERT INTO hierarchy_organizations (id, name, description, mission, snapshot_json, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
  ).run(
    id,
    "Default Organization",
    "Initial hierarchy snapshot",
    null,
    JSON.stringify(captureCurrentSnapshot()),
    now,
    now,
  );
  setStoredActiveOrganizationId(id);
}

export function listHierarchyOrganizations(): HierarchyOrganizationRecord[] {
  seedDefaultOrganization();
  const db = ensureTables();
  const activeOrganizationId = getStoredActiveOrganizationId();
  const rows = db
    .prepare("SELECT * FROM hierarchy_organizations WHERE is_active = 1 ORDER BY updated_at DESC, created_at DESC")
    .all() as OrgRow[];
  return rows.map((row) => mapOrg(row, activeOrganizationId));
}

export function getHierarchyOrganizationById(organizationId: string): (HierarchyOrganizationRecord & {
  snapshot: HierarchyOrganizationSnapshotMember[];
}) | null {
  seedDefaultOrganization();
  const db = ensureTables();
  const row = db.prepare("SELECT * FROM hierarchy_organizations WHERE id = ? LIMIT 1").get(organizationId) as OrgRow | undefined;
  if (!row) return null;
  return {
    ...mapOrg(row, getStoredActiveOrganizationId()),
    snapshot: parseSnapshot(row.snapshot_json),
  };
}

export function resolveHierarchyOrganization(reference: string): (HierarchyOrganizationRecord & {
  snapshot: HierarchyOrganizationSnapshotMember[];
}) | null {
  const trimmed = String(reference || "").trim();
  if (!trimmed) return null;
  const organizations = listHierarchyOrganizations();
  const lower = trimmed.toLowerCase();
  const direct = organizations.find((organization) => organization.id === trimmed)
    ?? organizations.find((organization) => organization.name.toLowerCase() === lower)
    ?? organizations.find((organization) => organization.name.toLowerCase().includes(lower));
  return direct ? getHierarchyOrganizationById(direct.id) : null;
}

export function getActiveHierarchyOrganization(): (HierarchyOrganizationRecord & {
  snapshot: HierarchyOrganizationSnapshotMember[];
}) | null {
  seedDefaultOrganization();
  const activeId = getStoredActiveOrganizationId();
  if (!activeId) return null;
  return getHierarchyOrganizationById(activeId);
}

export function saveCurrentHierarchyOrganization(input: {
  name: string;
  description?: string | null;
  mission?: string | null;
  activate?: boolean;
}): HierarchyOrganizationRecord {
  return saveHierarchyOrganizationSnapshot({
    ...input,
    snapshot: buildHierarchyOrganizationSnapshot(),
  });
}

export function saveSelectedHierarchyOrganization(input: {
  name: string;
  description?: string | null;
  mission?: string | null;
  activate?: boolean;
  memberIds: Iterable<string>;
}): HierarchyOrganizationRecord {
  return saveHierarchyOrganizationSnapshot({
    ...input,
    snapshot: buildHierarchyOrganizationSnapshot(input.memberIds),
  });
}

export function saveHierarchyOrganizationSnapshot(input: {
  name: string;
  description?: string | null;
  mission?: string | null;
  activate?: boolean;
  snapshot: HierarchyOrganizationSnapshotMember[];
}): HierarchyOrganizationRecord {
  seedDefaultOrganization();
  const db = ensureTables();
  const now = new Date().toISOString();
  const name = String(input.name || "").trim();
  if (!name) {
    throw new Error("Organization name is required");
  }

  const existing = db.prepare("SELECT * FROM hierarchy_organizations WHERE LOWER(name) = LOWER(?) LIMIT 1").get(name) as OrgRow | undefined;
  const id = existing?.id ?? nanoid(12);
  db.prepare(`
    INSERT INTO hierarchy_organizations (id, name, description, mission, snapshot_json, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      mission = excluded.mission,
      snapshot_json = excluded.snapshot_json,
      updated_at = excluded.updated_at
  `).run(
    id,
    name,
    input.description ?? existing?.description ?? null,
    input.mission ?? existing?.mission ?? null,
    JSON.stringify(input.snapshot),
    existing?.created_at ?? now,
    now,
  );
  if (input.activate !== false) {
    setStoredActiveOrganizationId(id);
  }
  const saved = listHierarchyOrganizations().find((organization) => organization.id === id)!;
  recordHierarchyActivityEvent({
    organizationId: saved.id,
    eventType: existing ? "organization.updated" : "organization.created",
    title: existing ? "Organization snapshot updated" : "Organization created",
    summary: `${saved.name} saved with ${saved.memberCount} member(s).`,
    status: input.activate !== false ? "active" : "saved",
    metadata: { memberCount: saved.memberCount, activated: input.activate !== false },
  });
  return saved;
}

/**
 * Patch organization metadata (name/description/mission) without rebuilding the
 * member snapshot. Only supplied fields change. Set `activate=true` to also make
 * it the active organization.
 */
export function updateHierarchyOrganization(
  reference: string,
  patch: {
    name?: string;
    description?: string | null;
    mission?: string | null;
    activate?: boolean;
  },
): HierarchyOrganizationRecord {
  const organization = resolveHierarchyOrganization(reference);
  if (!organization) {
    throw new Error(`Organization not found: ${reference}`);
  }
  const db = ensureTables();
  const now = new Date().toISOString();

  const nextName =
    patch.name !== undefined ? String(patch.name).trim() || organization.name : organization.name;
  if (patch.name !== undefined && nextName.toLowerCase() !== organization.name.toLowerCase()) {
    const collision = db
      .prepare("SELECT id FROM hierarchy_organizations WHERE LOWER(name) = LOWER(?) AND id != ? LIMIT 1")
      .get(nextName, organization.id) as { id: string } | undefined;
    if (collision) {
      throw new Error(`Another organization is already named "${nextName}".`);
    }
  }

  db.prepare(
    "UPDATE hierarchy_organizations SET name = ?, description = ?, mission = ?, updated_at = ? WHERE id = ?",
  ).run(
    nextName,
    patch.description !== undefined ? patch.description : organization.description,
    patch.mission !== undefined ? patch.mission : organization.mission,
    now,
    organization.id,
  );

  if (patch.activate === true) {
    setStoredActiveOrganizationId(organization.id);
  }

  const updated = getHierarchyOrganizationById(organization.id)!;
  recordHierarchyActivityEvent({
    organizationId: updated.id,
    eventType: "organization.updated",
    title: "Organization metadata updated",
    summary: `${updated.name} metadata changed.`,
    status: updated.isActive ? "active" : "saved",
    metadata: { patch: Object.keys(patch) },
  });
  return updated;
}

/**
 * Add agents to an organization's member snapshot, preserving existing members
 * and organization metadata. Returns the updated organization.
 */
export function addAgentsToHierarchyOrganization(
  organizationRef: string,
  agentIds: string[],
): HierarchyOrganizationRecord {
  const organization = resolveHierarchyOrganization(organizationRef);
  if (!organization) {
    throw new Error(`Organization not found: ${organizationRef}`);
  }
  const validAgentIds = new Set(listAgents().map((agent) => agent.id));
  const requested = Array.from(
    new Set(agentIds.map((id) => String(id || "").trim()).filter((id) => id && validAgentIds.has(id))),
  );
  if (requested.length === 0) {
    throw new Error("No valid agent ids supplied to add to the organization.");
  }

  const existingById = new Map(organization.snapshot.map((member) => [member.agent.id, member]));
  const newSnapshots = buildHierarchyOrganizationSnapshot(requested);
  for (const member of newSnapshots) {
    existingById.set(member.agent.id, member);
  }

  const updated = saveHierarchyOrganizationSnapshot({
    name: organization.name,
    description: organization.description,
    mission: organization.mission,
    activate: false,
    snapshot: Array.from(existingById.values()),
  });
  recordHierarchyActivityEvent({
    organizationId: updated.id,
    eventType: "organization.members_added",
    title: "Agents added to organization",
    summary: `${requested.length} agent(s) added to ${updated.name}.`,
    status: "updated",
    metadata: { agentIds: requested },
  });
  return updated;
}

export type OrganizationIntegrationPresetResult = {
  organization: HierarchyOrganizationRecord;
  presetId: string;
  presetName: string;
  updatedAgentIds: string[];
  skippedAgentIds: string[];
};

/**
 * Merge one approved capability preset into every current member of a saved
 * organization. The preset is fully validated before any member is changed.
 */
export function applyIntegrationPresetToHierarchyOrganization(
  organizationReference: string,
  presetId: string,
): OrganizationIntegrationPresetResult {
  const organization = resolveHierarchyOrganization(organizationReference);
  if (!organization) throw new Error(`Organization not found: ${organizationReference}`);

  const agentsById = new Map(listAgents().map((agent) => [agent.id, agent]));
  const skippedAgentIds: string[] = [];
  const plans: Array<{ agent: AgentRecord; enabledExtensions: string[]; enabledSkills: string[] }> = [];
  let presetName = "";

  for (const member of organization.snapshot) {
    const agent = agentsById.get(member.agent.id);
    if (!agent) {
      skippedAgentIds.push(member.agent.id);
      continue;
    }
    const resolved = resolveIntegrationPresetForAgent(agent, presetId, "merge");
    presetName = resolved.preset.name;
    plans.push({
      agent,
      enabledExtensions: resolved.enabledExtensions,
      enabledSkills: resolved.enabledSkills,
    });
  }

  if (plans.length === 0) throw new Error("Organization has no current member agents to update.");

  const updatedAgentIds = plans.map(({ agent, enabledExtensions, enabledSkills }) => {
    updateAgent(agent.id, { enabledExtensions, enabledSkills });
    return agent.id;
  });

  const db = ensureTables();
  const memberIds = new Set(organization.snapshot.map((member) => member.agent.id));
  db.prepare("UPDATE hierarchy_organizations SET snapshot_json = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(buildHierarchyOrganizationSnapshot(memberIds)), new Date().toISOString(), organization.id);
  const updated = getHierarchyOrganizationById(organization.id)!;
  recordHierarchyActivityEvent({
    organizationId: updated.id,
    eventType: "organization.integration_preset_applied",
    title: "Team capability preset applied",
    summary: `${presetName || presetId} merged into ${updatedAgentIds.length} member(s).`,
    status: "updated",
    metadata: { presetId, updatedAgentIds, skippedAgentIds },
  });

  return { organization: updated, presetId, presetName: presetName || presetId, updatedAgentIds, skippedAgentIds };
}

export function syncActiveHierarchyOrganizationSnapshot(): void {
  const active = getActiveHierarchyOrganization();
  if (!active) return;
  const db = ensureTables();
  const memberIds = new Set(active.snapshot.map((member) => member.agent.id));
  db.prepare(
    "UPDATE hierarchy_organizations SET snapshot_json = ?, updated_at = ? WHERE id = ?",
  ).run(JSON.stringify(buildHierarchyOrganizationSnapshot(memberIds)), new Date().toISOString(), active.id);
}

export function applyHierarchyOrganization(organizationReference: string): HierarchyOrganizationRecord {
  const organization = resolveHierarchyOrganization(organizationReference);
  if (!organization) {
    throw new Error(`Organization not found: ${organizationReference}`);
  }

  const currentAgentsById = new Map(listAgents().map((agent) => [agent.id, agent]));
  const memberIds = new Set<string>();

  for (const member of organization.snapshot) {
    memberIds.add(member.agent.id);
    const existing = currentAgentsById.get(member.agent.id);
    if (existing) {
      updateAgent(member.agent.id, {
        name: member.agent.name,
        workspacePath: member.agent.workspacePath,
        modelRef: member.agent.modelRef,
        disabledTools: member.agent.disabledTools,
        enabledExtensions: member.agent.enabledExtensions,
        enabledSkills: member.agent.enabledSkills,
        isDefault: member.agent.isDefault,
        isActive: member.agent.isActive,
      });
    } else {
      createAgent({
        id: member.agent.id,
        name: member.agent.name,
        workspacePath: member.agent.workspacePath,
        modelRef: member.agent.modelRef,
        disabledTools: member.agent.disabledTools,
        enabledExtensions: member.agent.enabledExtensions,
        enabledSkills: member.agent.enabledSkills,
        isDefault: member.agent.isDefault,
      });
      if (!member.agent.isActive) {
        updateAgent(member.agent.id, { isActive: false });
      }
    }
  }

  for (const member of organization.snapshot) {
    updateAgentRole(member.agent.id, {
      roleType: member.role.roleType,
      roleTitle: member.role.roleTitle,
      roleDescription: member.role.roleDescription,
      reportsTo: member.role.reportsTo,
      capabilities: member.role.capabilities,
      voteWeight: member.role.voteWeight ?? 1,
    });
  }

  for (const agent of listAgents()) {
    if (memberIds.has(agent.id)) continue;
    if (agent.isActive) {
      updateAgent(agent.id, { isActive: false, isDefault: false });
    }
  }

  setStoredActiveOrganizationId(organization.id);
  syncActiveHierarchyOrganizationSnapshot();
  const applied = listHierarchyOrganizations().find((item) => item.id === organization.id)!;
  recordHierarchyActivityEvent({
    organizationId: applied.id,
    eventType: "organization.applied",
    title: "Organization activated",
    summary: `${applied.name} activated with ${applied.memberCount} member(s).`,
    status: "active",
    metadata: { memberCount: applied.memberCount },
  });
  return applied;
}

export function deleteHierarchyOrganization(organizationReference: string): void {
  const organization = resolveHierarchyOrganization(organizationReference);
  if (!organization) {
    throw new Error(`Organization not found: ${organizationReference}`);
  }
  if (organization.id === "default-org") {
    throw new Error("Default Organization cannot be deleted");
  }
  const db = ensureTables();
  db.prepare("DELETE FROM hierarchy_organizations WHERE id = ?").run(organization.id);
  recordHierarchyActivityEvent({
    organizationId: organization.id,
    eventType: "organization.deleted",
    title: "Organization deleted",
    summary: `${organization.name} was deleted.`,
    status: "deleted",
  });
  if (getStoredActiveOrganizationId() === organization.id) {
    const next = listHierarchyOrganizations().find((item) => item.id !== organization.id) ?? getHierarchyOrganizationById("default-org");
    setStoredActiveOrganizationId(next?.id ?? "default-org");
  }
}

export function listHierarchyOrganizationMembers(
  organizationId?: string | null,
): Array<HierarchyOrganizationSnapshotMember & { agentActive: boolean }> {
  const organization = organizationId ? getHierarchyOrganizationById(organizationId) : getActiveHierarchyOrganization();
  if (organization) {
    return organization.snapshot.map((member) => ({
      ...member,
      agentActive: member.agent.isActive,
    }));
  }

  const agentsById = new Map(listAgents().map((agent) => [agent.id, agent]));
  return listAgentRoles().map((role) => {
    const agent = agentsById.get(role.agentId);
    return {
      agent: {
        id: role.agentId,
        name: agent?.name ?? role.agentId,
        workspacePath: agent?.workspacePath ?? "",
        modelRef: agent?.modelRef ?? null,
        disabledTools: agent?.disabledTools ?? [],
        enabledExtensions: agent?.enabledExtensions ?? [],
        enabledSkills: agent?.enabledSkills ?? [],
        isDefault: agent?.isDefault ?? false,
        isActive: agent?.isActive ?? true,
      },
      role: {
        roleType: role.roleType,
        roleTitle: role.roleTitle,
        roleDescription: role.roleDescription,
        reportsTo: role.reportsTo,
        capabilities: role.capabilities,
        voteWeight: role.voteWeight ?? 1,
      },
      agentActive: agent?.isActive ?? true,
    };
  });
}
