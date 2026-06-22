import fs from "node:fs";
import { getSqlite, initializeDatabase } from "@/lib/db";
import { listInstalledExtensions, type ExtensionCatalogEntry, type ExtensionManifest } from "@/lib/extensions/registry";

export type StoredExtensionState = {
  enabled?: boolean;
  config?: Record<string, unknown>;
};

export type GlobalExtensionEntry = ExtensionCatalogEntry & {
  installed: boolean;
  installSource: "bundled" | "git" | "local";
  globallyEnabled: boolean;
  config: Record<string, unknown>;
  agentEnabled?: boolean;
};

const APP_CONFIG_ID = "default";
const STATE_COLUMN = "extension_registry_state";

function normalizeRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function normalizeStateMap(value: unknown): Record<string, StoredExtensionState> {
  const record = normalizeRecord(value);
  const out: Record<string, StoredExtensionState> = {};
  for (const [key, raw] of Object.entries(record)) {
    const row = normalizeRecord(raw);
    out[key] = {
      enabled: typeof row.enabled === "boolean" ? row.enabled : undefined,
      config: normalizeRecord(row.config),
    };
  }
  return out;
}

function ensureExtensionRegistryColumn(): void {
  initializeDatabase();
  const db = getSqlite();
  const cols = db.prepare("PRAGMA table_info(app_config)").all() as Array<{ name: string }>;
  const hasColumn = cols.some((column) => column.name === STATE_COLUMN);
  if (!hasColumn) {
    db.exec(`ALTER TABLE app_config ADD COLUMN ${STATE_COLUMN} TEXT DEFAULT '{}'`);
  }
}

function readManifest(manifestPath: string): ExtensionManifest | null {
  try {
    const raw = fs.readFileSync(manifestPath, "utf8");
    return JSON.parse(raw) as ExtensionManifest;
  } catch {
    return null;
  }
}

function getStateMap(): Record<string, StoredExtensionState> {
  ensureExtensionRegistryColumn();
  const db = getSqlite();
  const row = db
    .prepare(`SELECT ${STATE_COLUMN} FROM app_config WHERE id = ?`)
    .get(APP_CONFIG_ID) as Record<string, unknown> | undefined;
  const raw = row?.[STATE_COLUMN];
  if (typeof raw === "string" && raw.trim()) {
    try {
      return normalizeStateMap(JSON.parse(raw));
    } catch {
      return {};
    }
  }
  return normalizeStateMap(raw);
}

function writeStateMap(next: Record<string, StoredExtensionState>): void {
  ensureExtensionRegistryColumn();
  const db = getSqlite();
  const now = new Date().toISOString();
  db.prepare(`UPDATE app_config SET ${STATE_COLUMN} = ?, updated_at = ? WHERE id = ?`).run(
    JSON.stringify(next),
    now,
    APP_CONFIG_ID,
  );
}

function validateConfigAgainstSchema(
  manifest: ExtensionManifest | null,
  config: Record<string, unknown>,
): Record<string, unknown> {
  const schema = manifest?.configSchema;
  if (!schema || typeof schema !== "object") return config;
  const record = schema as Record<string, unknown>;
  const properties = normalizeRecord(record.properties);
  const additionalProperties = record.additionalProperties;
  if (additionalProperties === false) {
    const allowed = new Set(Object.keys(properties));
    for (const key of Object.keys(config)) {
      if (!allowed.has(key)) {
        throw new Error(`Unknown extension config key: ${key}`);
      }
    }
  }
  for (const [key, rawSchema] of Object.entries(properties)) {
    if (!(key in config)) continue;
    const fieldSchema = normalizeRecord(rawSchema);
    const value = config[key];
    const type = String(fieldSchema.type || "").trim();
    if (type === "boolean" && typeof value !== "boolean") {
      throw new Error(`Extension config key "${key}" must be boolean`);
    }
    if (type === "number" && typeof value !== "number") {
      throw new Error(`Extension config key "${key}" must be number`);
    }
    if (type === "string" && typeof value !== "string") {
      throw new Error(`Extension config key "${key}" must be string`);
    }
    if (Array.isArray(fieldSchema.enum) && fieldSchema.enum.length > 0 && !fieldSchema.enum.includes(value)) {
      throw new Error(`Extension config key "${key}" must be one of: ${fieldSchema.enum.join(", ")}`);
    }
  }
  return config;
}

export function getGlobalExtensionState(extensionId: string): StoredExtensionState {
  const map = getStateMap();
  const row = map[extensionId] ?? {};
  return {
    enabled: typeof row.enabled === "boolean" ? row.enabled : true,
    config: normalizeRecord(row.config),
  };
}

export function isExtensionGloballyEnabled(extensionId: string): boolean {
  return getGlobalExtensionState(extensionId).enabled !== false;
}

export function getExtensionGlobalConfig(extensionId: string): Record<string, unknown> {
  return getGlobalExtensionState(extensionId).config ?? {};
}

export function setGlobalExtensionEnabled(extensionId: string, enabled: boolean): GlobalExtensionEntry {
  const catalog = listInstalledExtensions();
  const entry = catalog.find((item) => item.id === extensionId);
  if (!entry) throw new Error(`Extension not found: ${extensionId}`);
  const map = getStateMap();
  const current = map[extensionId] ?? {};
  map[extensionId] = {
    enabled,
    config: normalizeRecord(current.config),
  };
  writeStateMap(map);
  return buildGlobalExtensionEntries().find((item) => item.id === extensionId) as GlobalExtensionEntry;
}

export function setGlobalExtensionConfig(extensionId: string, config: Record<string, unknown>): GlobalExtensionEntry {
  const catalog = listInstalledExtensions();
  const entry = catalog.find((item) => item.id === extensionId);
  if (!entry) throw new Error(`Extension not found: ${extensionId}`);
  const manifest = readManifest(entry.manifestPath);
  const normalizedConfig = validateConfigAgainstSchema(manifest, normalizeRecord(config));
  const map = getStateMap();
  const current = map[extensionId] ?? {};
  map[extensionId] = {
    enabled: typeof current.enabled === "boolean" ? current.enabled : true,
    config: normalizedConfig,
  };
  writeStateMap(map);
  return buildGlobalExtensionEntries().find((item) => item.id === extensionId) as GlobalExtensionEntry;
}

export function clearGlobalExtensionState(extensionId: string): void {
  const map = getStateMap();
  if (!(extensionId in map)) return;
  delete map[extensionId];
  writeStateMap(map);
}

export function buildGlobalExtensionEntries(agentEnabledExtensions?: string[]): GlobalExtensionEntry[] {
  const map = getStateMap();
  const agentEnabled = new Set(agentEnabledExtensions ?? []);
  return listInstalledExtensions().map((entry) => {
    const row = map[entry.id] ?? {};
    return {
      ...entry,
      installed: true,
      installSource: entry.installSource,
      globallyEnabled: typeof row.enabled === "boolean" ? row.enabled : true,
      config: normalizeRecord(row.config),
      ...(agentEnabledExtensions ? { agentEnabled: agentEnabled.has(entry.id) } : {}),
    };
  });
}
