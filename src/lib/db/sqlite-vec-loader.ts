import { createRequire } from "node:module";
import { logger } from "@/lib/utils/logger";

type SqliteVecModule = {
  load: (db: object) => void;
};

const log = logger.child("db:sqlite-vec-loader");
const requireModule = createRequire(import.meta.url);
const loadedDatabases = new WeakSet<object>();

let lastLoadError: string | null = null;

export function loadSqliteVecForDatabase(database: object): { available: boolean; error: string | null } {
  if (loadedDatabases.has(database)) {
    return { available: true, error: null };
  }

  try {
    const mod = requireModule("sqlite-vec") as SqliteVecModule;
    mod.load(database);
    loadedDatabases.add(database);
    lastLoadError = null;
    return { available: true, error: null };
  } catch (error) {
    lastLoadError = String(error);
    log.warn("sqlite-vec unavailable during database bootstrap", {
      error: lastLoadError,
    });
    return { available: false, error: lastLoadError };
  }
}

export function getSqliteVecBootstrapError(): string | null {
  return lastLoadError;
}
