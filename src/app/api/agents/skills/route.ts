import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSqlite, initializeDatabase } from "@/lib/db";
import { TOOL_LABELS } from "@/lib/engine/tools";
import {
  type AgentRecord,
  getAgentById,
  getDefaultAgent,
  setAgentDisabledTools,
  setAgentEnabledSkills,
  setAgentExecAllowlist,
  setAgentExtensions,
} from "@/lib/agents/registry";
import {
  buildAgentExtensionEntries,
  buildAgentSkillEntries,
  listBundledIntegrationPresets,
  listInstalledSkillCatalog,
} from "@/lib/extensions/registry";
import { buildGlobalExtensionEntries } from "@/lib/extensions/state";
import { resolveIntegrationPresetForAgent } from "@/lib/extensions/presets";
import { ensureCustomToolsTable } from "@/lib/tools/custom-tools";
import { listAgentTools } from "@/lib/workflows/agent-tools";
import { requireOperatorAccess } from "@/lib/security/admin";

export const dynamic = "force-dynamic";

type SkillCatalogEntry = {
  name: string;
  label: string;
  description: string;
  source: "built-in" | "custom";
};

const UpdateSkillsSchema = z
  .object({
    agentId: z.string().min(1).optional(),
    disabledTools: z.array(z.string().min(1)).optional(),
    enabledExtensions: z.array(z.string().min(1)).optional(),
    enabledSkills: z.array(z.string().min(1)).optional(),
    execAllowlist: z.array(z.string()).optional(),
    presetId: z.string().min(1).optional(),
    presetMode: z.enum(["merge", "replace"]).optional(),
    updates: z.array(z.object({ name: z.string().min(1), enabled: z.boolean() })).optional(),
    skillUpdates: z.array(z.object({ id: z.string().min(1), enabled: z.boolean() })).optional(),
    extensionUpdates: z.array(z.object({ id: z.string().min(1), enabled: z.boolean() })).optional(),
  })
  .refine((value) => (
    value.disabledTools !== undefined ||
    value.enabledExtensions !== undefined ||
    value.enabledSkills !== undefined ||
    value.execAllowlist !== undefined ||
    value.presetId !== undefined ||
    value.updates !== undefined ||
    value.skillUpdates !== undefined ||
    value.extensionUpdates !== undefined
  ), {
    message: "Provide disabledTools, enabledExtensions, enabledSkills, execAllowlist, presetId, updates, skillUpdates, or extensionUpdates",
  });

function normalizeNames(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const name = String(raw || "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

function loadSkillCatalog(): SkillCatalogEntry[] {
  const builtIn: SkillCatalogEntry[] = Object.entries(TOOL_LABELS).map(([name, meta]) => ({
    name,
    label: meta.label,
    description: meta.description,
    source: "built-in",
  }));

  let custom: SkillCatalogEntry[] = [];
  try {
    initializeDatabase();
    const db = ensureCustomToolsTable(getSqlite());
    const rows = db
      .prepare("SELECT name, description FROM custom_tools WHERE is_active = 1 ORDER BY name ASC")
      .all() as Array<{ name: string; description: string }>;
    custom = rows.map((row) => ({
      name: row.name,
      label: row.name,
      description: row.description,
      source: "custom",
    }));
  } catch {
    // Ignore DB failures and return built-in catalog only.
  }

  let workflowTools: SkillCatalogEntry[] = [];
  try {
    initializeDatabase();
    workflowTools = listAgentTools().map((tool) => ({
      name: tool.toolName,
      label: tool.toolName,
      description: tool.description,
      source: "custom",
    }));
  } catch {
    workflowTools = [];
  }

  const seen = new Set<string>();
  const merged: SkillCatalogEntry[] = [];
  for (const entry of [...builtIn, ...custom, ...workflowTools]) {
    if (seen.has(entry.name)) continue;
    seen.add(entry.name);
    merged.push(entry);
  }
  return merged.sort((a, b) => a.label.localeCompare(b.label));
}

const CHANNEL_DEP_MAP: Record<string, string[]> = {
  slack: ["slack_bot_token"],
  discord: ["discord_bot_token"],
  telegram: ["telegram_bot_token"],
  msteams: ["teams_app_id"],
  googlechat: ["google_client_id"],
  whatsapp: ["whatsapp_enabled"],
  matrix: ["matrix_homeserver"],
  mattermost: ["mattermost_url"],
};

function getChannelConfiguredSet(): Set<string> {
  try {
    initializeDatabase();
    const db = getSqlite();
    const rows = db
      .prepare("SELECT key, value FROM app_config WHERE key IN (" +
        Object.values(CHANNEL_DEP_MAP).flat().map(() => "?").join(",") +
        ")")
      .all(...Object.values(CHANNEL_DEP_MAP).flat()) as Array<{ key: string; value: string }>;
    const configuredKeys = new Set(
      rows
        .filter((row) => row.value && row.value !== "false" && row.value !== "0" && row.value !== "")
        .map((row) => row.key),
    );
    const configured = new Set<string>();
    for (const [channelId, keys] of Object.entries(CHANNEL_DEP_MAP)) {
      if (keys.some((key) => configuredKeys.has(key))) {
        configured.add(channelId);
      }
    }
    return configured;
  } catch {
    return new Set();
  }
}

function resolveAgent(agentIdRaw?: string | null) {
  const requested = (agentIdRaw || "").trim();
  if (requested) {
    const agent = getAgentById(requested);
    if (!agent) {
      throw new Error(`Agent not found: ${requested}`);
    }
    return agent;
  }
  return getDefaultAgent();
}

function mergeAgentSkillState(agent: AgentRecord) {
  const tools = loadSkillCatalog();
  const disabledTools = new Set(agent.disabledTools);
  const globalExtensions = buildGlobalExtensionEntries(agent.enabledExtensions);
  const globallyEnabled = new Set(
    globalExtensions.filter((entry) => entry.globallyEnabled).map((entry) => entry.id),
  );
  const channelConfigured = getChannelConfiguredSet();
  const extensions = buildAgentExtensionEntries(agent.enabledExtensions).map((entry) => {
    const globalEntry = globalExtensions.find((candidate) => candidate.id === entry.id);
    const channelDeps = CHANNEL_DEP_MAP[entry.id];
    // Extensions with channel dependencies are eligible only when that channel is configured.
    // Extensions without channel dependencies are always eligible.
    const eligible = channelDeps ? channelConfigured.has(entry.id) : true;
    return {
      ...entry,
      globallyEnabled: globalEntry?.globallyEnabled ?? true,
      eligible,
      config: globalEntry?.config ?? {},
    };
  });
  const skills = buildAgentSkillEntries({
    enabledExtensions: agent.enabledExtensions.filter((entry) => globallyEnabled.has(entry)),
    enabledSkills: agent.enabledSkills,
    agentWorkspacePath: agent.workspacePath,
  }).map((entry) => ({
    ...entry,
    globallyEnabled: entry.extensionId ? globallyEnabled.has(entry.extensionId) : true,
  }));
  return {
    agentId: agent.id,
    disabledTools: agent.disabledTools,
    enabledExtensions: agent.enabledExtensions,
    enabledSkills: agent.enabledSkills,
    execAllowlist: agent.execAllowlist,
    presets: listBundledIntegrationPresets(),
    tools: tools.map((entry) => ({
      ...entry,
      enabled: !disabledTools.has(entry.name),
    })),
    skills,
    extensions,
  };
}

function mapErrorStatus(error: unknown): number {
  const message = String(error);
  if (message.includes("Agent not found")) return 404;
  if (message.includes("disabled globally")) return 400;
  if (message.includes("Integration preset not found")) return 404;
  return 500;
}

export async function GET(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const { searchParams } = new URL(request.url);
    const agent = resolveAgent(searchParams.get("agentId"));
    const state = mergeAgentSkillState(agent);

    return NextResponse.json({
      success: true,
      data: state,
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: mapErrorStatus(error) });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const body = await request.json();
    const parsed = UpdateSkillsSchema.parse(body);
    const agent = resolveAgent(parsed.agentId ?? null);
    const disabled = new Set(normalizeNames(parsed.disabledTools ?? agent.disabledTools));
    const enabledExtensions = new Set(normalizeNames(parsed.enabledExtensions ?? agent.enabledExtensions));
    const enabledSkills = new Set(normalizeNames(parsed.enabledSkills ?? agent.enabledSkills));

    if (parsed.presetId) {
      const resolved = resolveIntegrationPresetForAgent(agent, parsed.presetId, parsed.presetMode ?? "merge");
      enabledExtensions.clear();
      enabledSkills.clear();
      for (const extensionId of resolved.enabledExtensions) enabledExtensions.add(extensionId);
      for (const skillId of resolved.enabledSkills) enabledSkills.add(skillId);
    }

    for (const update of parsed.updates ?? []) {
      if (update.enabled) {
        disabled.delete(update.name);
      } else {
        disabled.add(update.name);
      }
    }

    for (const update of parsed.extensionUpdates ?? []) {
      if (update.enabled) enabledExtensions.add(update.id);
      else enabledExtensions.delete(update.id);
    }

    for (const update of parsed.skillUpdates ?? []) {
      if (update.enabled) enabledSkills.add(update.id);
      else enabledSkills.delete(update.id);
    }

    const skillCatalog = listInstalledSkillCatalog({ agentWorkspacePath: agent.workspacePath });
    const skillCatalogById = new Map(skillCatalog.map((entry) => [entry.id, entry]));
    for (const skillId of [...enabledSkills]) {
      const matched = skillCatalogById.get(skillId);
      if (matched?.extensionId) {
        enabledExtensions.add(matched.extensionId);
      }
    }

    const globalExtensions = buildGlobalExtensionEntries();
    const globallyEnabled = new Set(
      globalExtensions.filter((entry) => entry.globallyEnabled).map((entry) => entry.id),
    );
    for (const extensionId of [...enabledExtensions]) {
      if (!globallyEnabled.has(extensionId)) {
        throw new Error(`Extension is disabled globally: ${extensionId}`);
      }
    }

    const execAllowlist = parsed.execAllowlist ?? agent.execAllowlist;

    let updated = agent;
    if (JSON.stringify(normalizeNames([...disabled])) !== JSON.stringify(agent.disabledTools)) {
      updated = setAgentDisabledTools(agent.id, normalizeNames([...disabled]));
    }
    if (JSON.stringify(normalizeNames([...enabledExtensions])) !== JSON.stringify(updated.enabledExtensions)) {
      updated = setAgentExtensions(agent.id, normalizeNames([...enabledExtensions]));
    }
    if (JSON.stringify(normalizeNames([...enabledSkills])) !== JSON.stringify(updated.enabledSkills)) {
      updated = setAgentEnabledSkills(agent.id, normalizeNames([...enabledSkills]));
    }
    if (JSON.stringify(execAllowlist) !== JSON.stringify(updated.execAllowlist)) {
      updated = setAgentExecAllowlist(agent.id, execAllowlist);
    }

    const state = mergeAgentSkillState(updated);
    return NextResponse.json({
      success: true,
      data: state,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: String(error) }, { status: mapErrorStatus(error) });
  }
}
