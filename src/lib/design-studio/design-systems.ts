/**
 * Built-in (file-based) design-system packs. These are curated, recommended
 * systems bundled with the app; they are read-only and merge with user-created
 * design systems stored in the database. Built-in ids are prefixed `builtin:`.
 */
import fs from "node:fs";
import path from "node:path";

export type BuiltinDesignSystemSummary = {
  id: string;
  name: string;
  category: string | null;
  description: string | null;
  status: string;
  recommended: boolean;
  createdAt: string;
  updatedAt: string;
};

export type BuiltinDesignSystemDetail = BuiltinDesignSystemSummary & {
  designMd: string;
  tokensCss: string | null;
  componentsHtml: string | null;
  source: { mode: "builtin"; packId: string };
};

const BUILTIN_PREFIX = "builtin:";

function systemsDir(): string {
  return path.resolve(process.cwd(), "src", "lib", "design-studio", "design-systems");
}

function readPack(packId: string): BuiltinDesignSystemDetail | null {
  const dir = path.join(systemsDir(), packId);
  const manifestPath = path.join(dir, "manifest.json");
  if (!fs.existsSync(manifestPath)) return null;
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    return null;
  }
  const read = (name: string): string | null => {
    const p = path.join(dir, name);
    return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
  };
  const now = "1970-01-01T00:00:00.000Z";
  return {
    id: `${BUILTIN_PREFIX}${String(manifest.id || packId)}`,
    name: String(manifest.name || packId),
    category: manifest.category ? String(manifest.category) : null,
    description: manifest.description ? String(manifest.description) : null,
    status: "active",
    recommended: manifest.recommended === true,
    createdAt: now,
    updatedAt: now,
    designMd: read("DESIGN.md") || "",
    tokensCss: read("tokens.css"),
    componentsHtml: read("components.html"),
    source: { mode: "builtin", packId: String(manifest.id || packId) },
  };
}

export function isBuiltinDesignSystemId(id: string): boolean {
  return String(id || "").startsWith(BUILTIN_PREFIX);
}

export function listBuiltinDesignSystems(): BuiltinDesignSystemSummary[] {
  const dir = systemsDir();
  if (!fs.existsSync(dir)) return [];
  const packs = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => readPack(e.name))
    .filter((p): p is BuiltinDesignSystemDetail => Boolean(p));
  // Recommended first, then by name.
  packs.sort((a, b) => (a.recommended === b.recommended ? a.name.localeCompare(b.name) : a.recommended ? -1 : 1));
  return packs.map(({ designMd, tokensCss, componentsHtml, source, ...summary }) => {
    void designMd;
    void tokensCss;
    void componentsHtml;
    void source;
    return summary;
  });
}

export function getBuiltinDesignSystem(id: string): BuiltinDesignSystemDetail | null {
  const bare = id.startsWith(BUILTIN_PREFIX) ? id.slice(BUILTIN_PREFIX.length) : id;
  return readPack(bare);
}
