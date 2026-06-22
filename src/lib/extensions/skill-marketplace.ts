import { listInstalledSkillCatalog } from "@/lib/extensions/registry";
import { listExternalSkillPacks } from "@/lib/skills/installer";
import { MCP_CATALOG } from "@/lib/mcp/catalog";

export type SkillMarketplaceSource = "installed" | "external-pack" | "mcp";

export type SkillMarketplaceResult = {
  id: string;
  name: string;
  description: string;
  source: SkillMarketplaceSource;
  trust: number;
  installRef: string | null;
  verified: boolean;
  metadata: Record<string, unknown>;
};

function tokenize(value: string): Set<string> {
  return new Set(
    String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 1),
  );
}

function scoreText(queryTokens: Set<string>, haystack: string): number {
  if (queryTokens.size === 0) return 0.2;
  const haystackTokens = tokenize(haystack);
  let matches = 0;
  for (const token of queryTokens) {
    if (haystackTokens.has(token) || haystack.toLowerCase().includes(token)) matches += 1;
  }
  return matches / queryTokens.size;
}

function trustForInstalledSource(source: string): number {
  if (source === "core") return 100;
  if (source === "optional") return 92;
  if (source === "extension") return 88;
  if (source === "workspace") return 78;
  if (source === "agent") return 74;
  if (source === "external") return 62;
  return 50;
}

function trustForExternalScan(scanStatus: string | null | undefined): number {
  if (scanStatus === "pass") return 75;
  if (scanStatus === "warn") return 45;
  if (scanStatus === "blocked") return 5;
  return 35;
}

function trustForMcpTier(trustTier: string): number {
  if (trustTier === "high") return 82;
  if (trustTier === "medium") return 58;
  return 35;
}

export function searchSkillMarketplaces(query: string, limit = 25): SkillMarketplaceResult[] {
  const normalizedQuery = String(query || "").trim();
  const queryTokens = tokenize(normalizedQuery);
  const results: Array<SkillMarketplaceResult & { score: number }> = [];

  for (const skill of listInstalledSkillCatalog()) {
    const text = `${skill.label} ${skill.name} ${skill.description} ${skill.source} ${skill.extensionId || ""}`;
    const relevance = scoreText(queryTokens, text);
    if (normalizedQuery && relevance <= 0) continue;
    results.push({
      id: skill.id,
      name: skill.label,
      description: skill.description,
      source: "installed",
      trust: trustForInstalledSource(skill.source),
      installRef: skill.skillPath,
      verified: skill.source === "core" || skill.source === "optional" || skill.source === "extension",
      metadata: {
        skillSource: skill.source,
        extensionId: skill.extensionId,
        requiredEnv: skill.requiredEnv ?? [],
        platforms: skill.platforms ?? [],
      },
      score: relevance,
    });
  }

  for (const pack of listExternalSkillPacks()) {
    const text = `${pack.name} ${pack.description} ${pack.id} ${pack.sourceRef}`;
    const relevance = scoreText(queryTokens, text);
    if (normalizedQuery && relevance <= 0) continue;
    results.push({
      id: `external-pack:${pack.id}`,
      name: pack.name,
      description: pack.description,
      source: "external-pack",
      trust: trustForExternalScan(pack.scanStatus),
      installRef: pack.sourceRef,
      verified: pack.scanStatus === "pass",
      metadata: {
        packId: pack.id,
        installSource: pack.installSource,
        sourceRevision: pack.sourceRevision,
        skillCount: pack.skillCount,
        scanStatus: pack.scanStatus,
      },
      score: relevance,
    });
  }

  for (const entry of MCP_CATALOG) {
    const text = `${entry.name} ${entry.description} ${entry.id}`;
    const relevance = scoreText(queryTokens, text);
    if (normalizedQuery && relevance <= 0) continue;
    results.push({
      id: `mcp:${entry.id}`,
      name: `${entry.name} MCP`,
      description: entry.description,
      source: "mcp",
      trust: trustForMcpTier(entry.trustTier),
      installRef: entry.id,
      verified: entry.trustTier === "high",
      metadata: {
        transport: entry.transport,
        trustTier: entry.trustTier,
        defaultApprovalMode: entry.defaultApprovalMode,
        env: entry.env.map((env) => env.key),
      },
      score: relevance,
    });
  }

  return results
    .sort((a, b) => (b.score - a.score) || (b.trust - a.trust) || a.name.localeCompare(b.name))
    .slice(0, Math.max(1, Math.min(100, Math.floor(limit))))
    .map(({ score: _score, ...result }) => result);
}
