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
  onDispose?: (reason: "reload" | "disable" | "uninstall" | "shutdown") => Promise<void> | void;
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
  startedExtensionIds: Set<string>;
  loaded: boolean;
  loadPromise: Promise<LoadedExtension[]> | null;
  lifecycleQueue: Promise<void>;
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
      startedExtensionIds: new Set<string>(),
      loaded: false,
      loadPromise: null,
      lifecycleQueue: Promise.resolve(),
    };
  }
  const state = globalState[RUNTIME_SYMBOL]!;
  if (!(state.startedExtensionIds instanceof Set)) state.startedExtensionIds = new Set<string>();
  if (typeof state.loaded !== "boolean") state.loaded = state.entries.length > 0;
  if (!(state.lifecycleQueue instanceof Promise)) state.lifecycleQueue = Promise.resolve();
  if (!(state.loadPromise instanceof Promise)) state.loadPromise = null;
  return state;
}

function withRejectingTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function withTimeoutFallback<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => resolve(fallback), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
  const state = getState();
  const result = state.lifecycleQueue.catch(() => {}).then(operation);
  state.lifecycleQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function loadRuntimeModule(extensionId: string): Promise<ExtensionRuntimeModule | null> {
  const loader = RUNTIME_MODULE_LOADERS[extensionId];
  if (!loader) return null;
  return (await withRejectingTimeout(
    loader(),
    EXTENSION_RUNTIME_LOAD_TIMEOUT_MS,
    `Timed out loading runtime module for ${extensionId}`,
  )).default;
}

async function loadExternalRuntimeModule(
  extensionId: string,
  runtimePath: string,
): Promise<ExtensionRuntimeModule | null> {
  const fileUrl = pathToFileURL(runtimePath).href;
  const nativeImport = async (url: string): Promise<{ default?: ExtensionRuntimeModule }> =>
    import(/* webpackIgnore: true */ url);
  try {
    const mod = await withRejectingTimeout(
      nativeImport(`${fileUrl}?v=${Date.now()}`),
      EXTENSION_RUNTIME_LOAD_TIMEOUT_MS,
      `Timed out loading runtime module for ${extensionId}`,
    );
    return mod.default ?? null;
  } catch {
    const mod = await withRejectingTimeout(
      nativeImport(fileUrl),
      EXTENSION_RUNTIME_LOAD_TIMEOUT_MS,
      `Timed out loading runtime module for ${extensionId}`,
    );
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

async function loadCatalogEntry(entry: ExtensionCatalogEntry): Promise<LoadedExtension> {
  const manifest: ExtensionManifest = { id: entry.id, name: entry.name, description: entry.description };
  if (!isExtensionGloballyEnabled(entry.id)) return { manifest, runtime: null };
  try {
    return { manifest, runtime: await loadRuntimeForEntry(entry) };
  } catch (error) {
    log.warn("Failed to load extension runtime", { extensionId: entry.id, error: String(error) });
    return { manifest, runtime: null };
  }
}

async function disposeExtensionRuntimeRegistryNow(
  reason: "reload" | "disable" | "uninstall" | "shutdown" = "reload",
  extensionId?: string,
): Promise<void> {
  const state = getState();
  const entries = state.entries.filter((entry) => !extensionId || entry.manifest.id === extensionId).reverse();
  for (const entry of entries) {
    if (!entry.runtime?.onDispose) continue;
    try {
      await withTimeoutFallback(
        Promise.resolve(entry.runtime.onDispose(reason)),
        EXTENSION_RUNTIME_LOAD_TIMEOUT_MS,
        undefined,
      );
    } catch (error) {
      log.warn("Extension dispose hook failed", { extensionId: entry.manifest.id, reason, error: String(error) });
    }
  }
  state.entries = extensionId ? state.entries.filter((entry) => entry.manifest.id !== extensionId) : [];
  if (!extensionId) state.loaded = false;
  for (const entry of entries) state.startedExtensionIds.delete(entry.manifest.id);
  state.version += 1;
}

export async function disposeExtensionRuntimeRegistry(
  reason: "reload" | "disable" | "uninstall" | "shutdown" = "reload",
  extensionId?: string,
): Promise<void> {
  return enqueueLifecycle(() => disposeExtensionRuntimeRegistryNow(reason, extensionId));
}

export async function invalidateExtensionRuntimeRegistry(): Promise<void> {
  await disposeExtensionRuntimeRegistry("reload");
}

export async function reloadExtensionRuntimeRegistry(
  reason: "reload" | "disable" | "uninstall" = "reload",
  extensionId?: string,
): Promise<LoadedExtension[]> {
  return enqueueLifecycle(async () => {
    await disposeExtensionRuntimeRegistryNow(reason, extensionId);
    const loaded = extensionId
      ? await (async () => {
        const state = getState();
        const catalog = listInstalledExtensions();
        const existing = new Map(state.entries.map((entry) => [entry.manifest.id, entry]));
        const next: LoadedExtension[] = [];
        for (const entry of catalog) {
          const retained = existing.get(entry.id);
          next.push(retained ?? await loadCatalogEntry(entry));
        }
        state.entries = next;
        state.loaded = true;
        state.version += 1;
        return next;
      })()
      : await loadExtensionRuntimeRegistryNow();
    await runExtensionStartupHooksForEntries(loaded);
    return loaded;
  });
}

async function loadExtensionRuntimeRegistryNow(): Promise<LoadedExtension[]> {
  const state = getState();
  const manifests = listInstalledExtensions();
  const loaded: LoadedExtension[] = [];
  for (const entry of manifests) {
    loaded.push(await loadCatalogEntry(entry));
  }
  state.entries = loaded;
  state.loaded = true;
  state.version += 1;
  return loaded;
}

export async function loadExtensionRuntimeRegistry(): Promise<LoadedExtension[]> {
  return reloadExtensionRuntimeRegistry("reload");
}

export async function ensureExtensionRuntimeLoaded(): Promise<LoadedExtension[]> {
  const state = getState();
  if (state.loaded) return state.entries;
  if (state.loadPromise) return state.loadPromise;
  const pending = enqueueLifecycle(async () => {
    const current = getState();
    return current.loaded ? current.entries : loadExtensionRuntimeRegistryNow();
  });
  state.loadPromise = pending;
  void pending.finally(() => {
    if (state.loadPromise === pending) state.loadPromise = null;
  }).catch(() => {});
  return pending;
}

async function runExtensionStartupHooksForEntries(entries: LoadedExtension[]): Promise<void> {
  const state = getState();
  for (const entry of entries) {
    if (!isExtensionGloballyEnabled(entry.manifest.id)) continue;
    if (state.startedExtensionIds.has(entry.manifest.id)) continue;
    if (!entry.runtime?.onStartup) {
      state.startedExtensionIds.add(entry.manifest.id);
      continue;
    }
    try {
      await withRejectingTimeout(
        Promise.resolve(entry.runtime.onStartup()),
        EXTENSION_RUNTIME_LOAD_TIMEOUT_MS,
        `Timed out starting extension ${entry.manifest.id}`,
      );
      state.startedExtensionIds.add(entry.manifest.id);
    } catch (error) {
      state.startedExtensionIds.delete(entry.manifest.id);
      log.warn("Extension startup hook failed", { extensionId: entry.manifest.id, error: String(error) });
    }
  }
}

export async function runExtensionStartupHooks(): Promise<void> {
  await runExtensionStartupHooksForEntries(await ensureExtensionRuntimeLoaded());
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
      const section = await withRejectingTimeout(Promise.resolve(entry.runtime.getPromptContext({
        agentId: params.agentId,
        agent,
        enabledExtensions: params.enabledExtensions,
        enabledSkills: params.enabledSkills,
        globallyEnabled,
        config: getExtensionGlobalConfig(entry.manifest.id),
      })), EXTENSION_RUNTIME_LOAD_TIMEOUT_MS, `Timed out reading prompt context from extension ${entry.manifest.id}`);
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
    if (!isExtensionGloballyEnabled(entry.manifest.id)) continue;
    if (!entry.runtime?.handleCommand) continue;
    try {
      const result = await withRejectingTimeout(Promise.resolve(entry.runtime.handleCommand(message, {
        ...context,
        globallyEnabled: true,
        config: getExtensionGlobalConfig(entry.manifest.id),
      })), EXTENSION_RUNTIME_LOAD_TIMEOUT_MS, `Timed out running command hook for extension ${entry.manifest.id}`);
      if (result?.trim()) return result.trim();
    } catch (error) {
      log.warn("Extension command hook failed", { extensionId: entry.manifest.id, error: String(error) });
    }
  }
  return null;
}

const EXTENSION_SHUTDOWN_SYMBOL = Symbol.for("disp8ch.extensionRuntimeShutdownHooks");

export function installExtensionRuntimeShutdownHooks(): void {
  const shutdownGlobal = globalThis as typeof globalThis & { [EXTENSION_SHUTDOWN_SYMBOL]?: boolean };
  if (shutdownGlobal[EXTENSION_SHUTDOWN_SYMBOL]) return;
  shutdownGlobal[EXTENSION_SHUTDOWN_SYMBOL] = true;
  process.once("beforeExit", () => { void disposeExtensionRuntimeRegistry("shutdown"); });
  const disposeAndExit = (code: number) => {
    void disposeExtensionRuntimeRegistry("shutdown").finally(() => process.exit(code));
  };
  process.once("SIGINT", () => disposeAndExit(130));
  process.once("SIGTERM", () => disposeAndExit(143));
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
      entry.runtime?.onDispose ? "dispose" : null,
      entry.runtime?.getPromptContext ? "prompt" : null,
      entry.runtime?.handleCommand ? "command" : null,
      entry.runtime?.getStatus ? "status" : null,
    ].filter(Boolean) as string[];
    let status: Record<string, unknown> | null = null;
    if (entry.runtime?.getStatus) {
      try {
        status = await withTimeoutFallback(
          Promise.resolve(entry.runtime.getStatus()),
          EXTENSION_RUNTIME_STATUS_TIMEOUT_MS,
          { error: `Timed out after ${EXTENSION_RUNTIME_STATUS_TIMEOUT_MS}ms` },
        );
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
