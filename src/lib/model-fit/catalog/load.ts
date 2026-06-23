import bundled from "./bundled-current.json";
import { freshnessState, validateCatalogModel, type CatalogModel, type ModelCatalog, type FreshnessState } from "./schema";

/**
 * Static release catalog. Local inventory still outranks catalog suggestions;
 * this file deliberately performs no background network access or update.
 * Refresh verified entries as part of an app release.
 */

const bundledInput = bundled as unknown as ModelCatalog;
export const BUNDLED_CATALOG: ModelCatalog = {
  ...bundledInput,
  source: "bundled",
  models: Array.isArray(bundledInput.models) ? bundledInput.models.filter(validateCatalogModel) : [],
};

export async function loadCatalog(options?: {
  // Kept for API compatibility with V2 callers and tests. Static catalog
  // loading intentionally ignores these options.
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  force?: boolean;
}): Promise<ModelCatalog & { state: FreshnessState }> {
  return { ...BUNDLED_CATALOG, state: freshnessState(BUNDLED_CATALOG.freshness.generatedAt) };
}

/** Models eligible to be SUGGESTED to a user (exclude deprecated/discovered). */
export function recommendableCatalogModels(catalog: ModelCatalog): CatalogModel[] {
  return catalog.models.filter((m) => m.status === "recommended" || m.status === "compatible" || m.status === "legacy");
}
