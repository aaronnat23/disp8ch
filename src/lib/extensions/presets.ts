import type { AgentRecord } from "@/lib/agents/registry";
import {
  getBundledIntegrationPreset,
  listInstalledSkillCatalog,
  type IntegrationPresetEntry,
} from "@/lib/extensions/registry";
import { buildGlobalExtensionEntries } from "@/lib/extensions/state";

export type IntegrationPresetMode = "merge" | "replace";

function normalizeIds(values: Iterable<string>): string[] {
  return [...new Set(Array.from(values, (value) => String(value || "").trim()).filter(Boolean))].sort();
}

/**
 * Resolves a preset against one agent before persisting it. Keeping this pure
 * lets single-agent and organization-wide actions share the same global
 * extension safety check.
 */
export function resolveIntegrationPresetForAgent(
  agent: Pick<AgentRecord, "workspacePath" | "enabledExtensions" | "enabledSkills">,
  presetId: string,
  mode: IntegrationPresetMode = "merge",
): {
  preset: IntegrationPresetEntry;
  enabledExtensions: string[];
  enabledSkills: string[];
} {
  const preset = getBundledIntegrationPreset(presetId);
  if (!preset) throw new Error(`Integration preset not found: ${presetId}`);

  const enabledExtensions = new Set(mode === "replace" ? [] : normalizeIds(agent.enabledExtensions));
  const enabledSkills = new Set(mode === "replace" ? [] : normalizeIds(agent.enabledSkills));
  for (const extensionId of preset.extensions) enabledExtensions.add(extensionId);
  for (const skillId of preset.skills) enabledSkills.add(skillId);

  const skillCatalog = listInstalledSkillCatalog({ agentWorkspacePath: agent.workspacePath });
  const skillsById = new Map(skillCatalog.map((entry) => [entry.id, entry]));
  for (const skillId of enabledSkills) {
    const skill = skillsById.get(skillId);
    if (skill?.extensionId) enabledExtensions.add(skill.extensionId);
  }

  const globallyEnabled = new Set(
    buildGlobalExtensionEntries().filter((entry) => entry.globallyEnabled).map((entry) => entry.id),
  );
  const unavailable = [...enabledExtensions].filter((extensionId) => !globallyEnabled.has(extensionId));
  if (unavailable.length > 0) {
    throw new Error(`Preset cannot be applied because extension(s) are disabled globally: ${unavailable.join(", ")}`);
  }

  return {
    preset,
    enabledExtensions: normalizeIds(enabledExtensions),
    enabledSkills: normalizeIds(enabledSkills),
  };
}
