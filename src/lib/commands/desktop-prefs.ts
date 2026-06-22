/**
 * Desktop-only shell preferences (Phase 5). These are stored in localStorage and
 * keyed by the EXISTING agent / model references. They never change agent runtime
 * configuration or execution policy — an agent already owns its model, tools,
 * skills, prompt, and budget, and `channel_session_settings` owns per-session
 * overrides. This module only records UI/notification/reasoning preferences.
 */

export type ModelPreference = {
  /** Preferred effort hint for this model reference, UI-only. */
  reasoning?: "fast" | "balanced" | "thorough";
};

export type AgentDesktopPreference = {
  /** Desktop layout preset to restore when this agent is active. */
  layout?: "chat" | "operations" | "developer" | "focus";
  /** Whether completion notifications are enabled while this agent runs. */
  notify?: boolean;
};

const MODEL_KEY = "disp8ch:model-prefs";
const AGENT_KEY = "disp8ch:agent-desktop-prefs";

function readMap<T>(key: string): Record<string, T> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Record<string, T>) : {};
  } catch {
    return {};
  }
}

function writeMap<T>(key: string, map: Record<string, T>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(map));
  } catch {
    /* localStorage optional */
  }
}

export function getModelPreference(modelRef: string): ModelPreference {
  return readMap<ModelPreference>(MODEL_KEY)[modelRef] ?? {};
}

export function setModelPreference(modelRef: string, pref: ModelPreference): void {
  const map = readMap<ModelPreference>(MODEL_KEY);
  map[modelRef] = { ...map[modelRef], ...pref };
  writeMap(MODEL_KEY, map);
}

export function getAgentDesktopPreference(agentId: string): AgentDesktopPreference {
  return readMap<AgentDesktopPreference>(AGENT_KEY)[agentId] ?? {};
}

export function setAgentDesktopPreference(agentId: string, pref: AgentDesktopPreference): void {
  const map = readMap<AgentDesktopPreference>(AGENT_KEY);
  map[agentId] = { ...map[agentId], ...pref };
  writeMap(AGENT_KEY, map);
}

/**
 * Pure merge used by tests and the UI: desktop prefs are layered on top of the
 * runtime agent record WITHOUT mutating it. The returned object is display-only.
 */
export function mergeAgentView<T extends { id: string }>(
  agent: T,
  prefs: Record<string, AgentDesktopPreference>,
): T & { desktop: AgentDesktopPreference } {
  return { ...agent, desktop: prefs[agent.id] ?? {} };
}
