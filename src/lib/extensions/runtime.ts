import { getDefaultAgent, getAgentById, type AgentRecord } from "@/lib/agents/registry";
import { listInstalledExtensions, type ExtensionCatalogEntry, type ExtensionManifest } from "@/lib/extensions/registry";
import { getExtensionGlobalConfig, isExtensionGloballyEnabled } from "@/lib/extensions/state";
import { logger } from "@/lib/utils/logger";
import { pathToFileURL } from "node:url";

export type ExtensionRuntimeContext = {
  agentId: string;
  agent: AgentRecord | null;
  enabledExtensions: string[];
  enabledSkills: string[];
  globallyEnabled: boolean;
  config: Record<string, unknown>;
};

export type ExtensionCommandContext = {
  channel: string;
  sender: string;
  sessionId?: string | null;
  globallyEnabled: boolean;
  config: Record<string, unknown>;
};

export type LoadedExtensionStatus = {
  id: string;
  name: string;
  description: string;
  enabledForDefaultAgent: boolean;
  globallyEnabled: boolean;
  hasRuntime: boolean;
  hooks: string[];
};

export type ExtensionRuntimeModule = {
  onStartup?: () => Promise<void> | void;
  getPromptContext?: (context: ExtensionRuntimeContext) => Promise<string | null> | string | null;
  handleCommand?: (message: string, context: ExtensionCommandContext) => Promise<string | null> | string | null;
  getStatus?: () => Promise<Record<string, unknown> | null> | Record<string, unknown> | null;
};

type LoadedExtension = {
  manifest: ExtensionManifest;
  runtime: ExtensionRuntimeModule | null;
};

type ExtensionRuntimeState = {
  entries: LoadedExtension[];
  version: number;
  startupRan: boolean;
};

const EXTENSION_RUNTIME_LOAD_TIMEOUT_MS = 5000;
const EXTENSION_RUNTIME_STATUS_TIMEOUT_MS = 2500;

const RUNTIME_SYMBOL = Symbol.for("disp8ch.extensionRuntime");
const log = logger.child("extensions:runtime");
const RUNTIME_MODULE_LOADERS: Record<string, () => Promise<{ default: ExtensionRuntimeModule }>> = {
  "acp": () => import("@/lib/extensions/runtime-modules/acp"),
  "backup": () => import("@/lib/extensions/runtime-modules/backup"),
  "coding": () => import("@/lib/extensions/runtime-modules/coding"),
  "data-sources": () => import("@/lib/extensions/runtime-modules/data-sources"),
  "feishu": () => import("@/lib/extensions/runtime-modules/feishu"),
  "diagnostics-otel": () => import("@/lib/extensions/runtime-modules/diagnostics-otel"),
  "diffs": () => import("@/lib/extensions/runtime-modules/diffs"),
  "discord": () => import("@/lib/extensions/runtime-modules/discord"),
  "github": () => import("@/lib/extensions/runtime-modules/github"),
  "googlechat": () => import("@/lib/extensions/runtime-modules/googlechat"),
  "hierarchy": () => import("@/lib/extensions/runtime-modules/hierarchy"),
  "incidents": () => import("@/lib/extensions/runtime-modules/incidents"),
  "mattermost": () => import("@/lib/extensions/runtime-modules/mattermost"),
  "matrix": () => import("@/lib/extensions/runtime-modules/matrix"),
  "lobster": () => import("@/lib/extensions/runtime-modules/lobster"),
  "memory-core": () => import("@/lib/extensions/runtime-modules/memory-core"),
  "memory-lancedb": () => import("@/lib/extensions/runtime-modules/memory-lancedb"),
  "msteams": () => import("@/lib/extensions/runtime-modules/msteams"),
  "release-ops": () => import("@/lib/extensions/runtime-modules/release-ops"),
  "slack": () => import("@/lib/extensions/runtime-modules/slack"),
  "web-research": () => import("@/lib/extensions/runtime-modules/web-research"),
};

export function listRuntimeBackedExtensionIds(): string[] {
  return Object.keys(RUNTIME_MODULE_LOADERS).sort();
}

function getState(): ExtensionRuntimeState {
  const globalState = globalThis as typeof globalThis & {
    [RUNTIME_SYMBOL]?: ExtensionRuntimeState;
  };
  if (!globalState[RUNTIME_SYMBOL]) {
    globalState[RUNTIME_SYMBOL] = {
      entries: [],
      version: 0,
      startupRan: false,
    };
  }
  return globalState[RUNTIME_SYMBOL]!;
}

async function loadRuntimeModule(extensionId: string): Promise<ExtensionRuntimeModule | null> {
  const loader = RUNTIME_MODULE_LOADERS[extensionId];
  if (!loader) return null;
  const timeoutError = new Error(`Timed out loading runtime module for ${extensionId}`);
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(timeoutError), EXTENSION_RUNTIME_LOAD_TIMEOUT_MS);
  });
  return (await Promise.race([loader(), timeout])).default;
}

async function loadExternalRuntimeModule(
  extensionId: string,
  runtimePath: string,
): Promise<ExtensionRuntimeModule | null> {
  const fileUrl = pathToFileURL(runtimePath).href;
  const timeoutError = new Error(`Timed out loading runtime module for ${extensionId}`);
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(timeoutError), EXTENSION_RUNTIME_LOAD_TIMEOUT_MS);
  });
  const nativeImport = async (url: string): Promise<{ default?: ExtensionRuntimeModule }> =>
    import(/* webpackIgnore: true */ url);
  try {
    const mod = await Promise.race([nativeImport(`${fileUrl}?v=${Date.now()}`), timeout]);
    return mod.default ?? null;
  } catch {
    const mod = await Promise.race([nativeImport(fileUrl), timeout]);
    return mod.default ?? null;
  }
}

async function loadRuntimeForEntry(entry: ExtensionCatalogEntry): Promise<ExtensionRuntimeModule | null> {
  if (entry.source === "bundled") {
    return loadRuntimeModule(entry.id);
  }
  if (!entry.runtimePath) return null;
  return loadExternalRuntimeModule(entry.id, entry.runtimePath);
}

export function invalidateExtensionRuntimeRegistry(): void {
  const state = getState();
  state.entries = [];
  state.version += 1;
  state.startupRan = false;
}

export async function loadExtensionRuntimeRegistry(): Promise<LoadedExtension[]> {
  const state = getState();
  const manifests = listInstalledExtensions();
  const loaded: LoadedExtension[] = [];
  for (const entry of manifests) {
    try {
      const normalizedManifest: ExtensionManifest = {
        id: entry.id,
        name: entry.name,
        description: entry.description,
      };
      const runtime = await loadRuntimeForEntry(entry);
      loaded.push({
        manifest: normalizedManifest,
        runtime,
      });
    } catch (error) {
      log.warn("Failed to load extension runtime", { extensionId: entry.id, error: String(error) });
      loaded.push({
        manifest: {
          id: entry.id,
          name: entry.name,
          description: entry.description,
        },
        runtime: null,
      });
    }
  }
  state.entries = loaded;
  state.version += 1;
  return loaded;
}

export async function ensureExtensionRuntimeLoaded(): Promise<LoadedExtension[]> {
  const state = getState();
  if (state.entries.length > 0) return state.entries;
  return loadExtensionRuntimeRegistry();
}

export async function runExtensionStartupHooks(): Promise<void> {
  const state = getState();
  const entries = await ensureExtensionRuntimeLoaded();
  if (state.startupRan) return;
  state.startupRan = true;
  for (const entry of entries) {
    if (!entry.runtime?.onStartup) continue;
    try {
      await entry.runtime.onStartup();
    } catch (error) {
      log.warn("Extension startup hook failed", { extensionId: entry.manifest.id, error: String(error) });
    }
  }
}

export async function getExtensionPromptContext(params: {
  agentId: string;
  enabledExtensions: string[];
  enabledSkills: string[];
}): Promise<string> {
  const entries = await ensureExtensionRuntimeLoaded();
  const enabled = new Set(params.enabledExtensions);
  const agent = getAgentById(params.agentId) ?? getDefaultAgent();
  const sections: string[] = [];
  for (const entry of entries) {
    if (!enabled.has(entry.manifest.id)) continue;
    const globallyEnabled = isExtensionGloballyEnabled(entry.manifest.id);
    if (!globallyEnabled) continue;
    if (!entry.runtime?.getPromptContext) continue;
    try {
      const section = await entry.runtime.getPromptContext({
        agentId: params.agentId,
        agent,
        enabledExtensions: params.enabledExtensions,
        enabledSkills: params.enabledSkills,
        globallyEnabled,
        config: getExtensionGlobalConfig(entry.manifest.id),
      });
      const normalized = section?.trim();
      if (normalized && !sections.includes(normalized)) sections.push(normalized);
    } catch (error) {
      log.warn("Extension prompt hook failed", { extensionId: entry.manifest.id, error: String(error) });
    }
  }
  return sections.join("\n\n").trim().slice(0, 3500);
}

export async function runExtensionCommandHooks(
  message: string,
  context: Omit<ExtensionCommandContext, "globallyEnabled" | "config">,
): Promise<string | null> {
  const entries = await ensureExtensionRuntimeLoaded();
  for (const entry of entries) {
    if (!entry.runtime?.handleCommand) continue;
    try {
      const result = await entry.runtime.handleCommand(message, {
        ...context,
        globallyEnabled: isExtensionGloballyEnabled(entry.manifest.id),
        config: getExtensionGlobalConfig(entry.manifest.id),
      });
      if (result?.trim()) return result.trim();
    } catch (error) {
      log.warn("Extension command hook failed", { extensionId: entry.manifest.id, error: String(error) });
    }
  }
  return null;
}

export async function getExtensionRuntimeStatus(): Promise<{
  version: number;
  extensions: Array<LoadedExtensionStatus & { status: Record<string, unknown> | null }>;
}> {
  const state = getState();
  const entries = await ensureExtensionRuntimeLoaded();
  const defaultAgent = getDefaultAgent();
  const enabled = new Set(defaultAgent.enabledExtensions);
  const extensions = await Promise.all(entries.map(async (entry) => {
    const hooks = [
      entry.runtime?.onStartup ? "startup" : null,
      entry.runtime?.getPromptContext ? "prompt" : null,
      entry.runtime?.handleCommand ? "command" : null,
      entry.runtime?.getStatus ? "status" : null,
    ].filter(Boolean) as string[];
    let status: Record<string, unknown> | null = null;
    if (entry.runtime?.getStatus) {
      try {
        status = await Promise.race([
          Promise.resolve(entry.runtime.getStatus()),
          new Promise<Record<string, unknown>>((resolve) => {
            setTimeout(() => resolve({ error: `Timed out after ${EXTENSION_RUNTIME_STATUS_TIMEOUT_MS}ms` }), EXTENSION_RUNTIME_STATUS_TIMEOUT_MS);
          }),
        ]);
      } catch (error) {
        status = { error: String(error) };
      }
    }
    return {
      id: entry.manifest.id,
      name: entry.manifest.name,
      description: entry.manifest.description,
      enabledForDefaultAgent: enabled.has(entry.manifest.id),
      globallyEnabled: isExtensionGloballyEnabled(entry.manifest.id),
      hasRuntime: Boolean(entry.runtime),
      hooks,
      status,
    };
  }));
  return {
    version: state.version,
    extensions,
  };
}
