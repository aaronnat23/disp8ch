import type { MemoryEntry, MemoryType } from "@/types/memory";

type MemoryRollupCategoryId =
  | "identity"
  | "preferences"
  | "behavior"
  | "tools"
  | "knowledge"
  | "decisions"
  | "events";

export type MemoryRollupItem = {
  id: string;
  content: string;
  type: MemoryType;
  confidence: number;
  tags: string[];
  refs: string[];
  whenToUse?: string;
  happenedAt?: string;
};

export type MemoryRollup = {
  id: MemoryRollupCategoryId;
  title: string;
  summary: string;
  itemCount: number;
  items: MemoryRollupItem[];
};

const CATEGORY_ORDER: MemoryRollupCategoryId[] = [
  "identity",
  "preferences",
  "behavior",
  "tools",
  "knowledge",
  "decisions",
  "events",
];

const CATEGORY_TITLES: Record<MemoryRollupCategoryId, string> = {
  identity: "Identity",
  preferences: "Preferences",
  behavior: "Behavior",
  tools: "Tools",
  knowledge: "Knowledge",
  decisions: "Decisions",
  events: "Events",
};

function categoryForType(type: MemoryType): MemoryRollupCategoryId {
  switch (type) {
    case "profile":
    case "entity":
    case "relationship":
      return "identity";
    case "preference":
      return "preferences";
    case "behavior":
      return "behavior";
    case "tool":
    case "skill":
      return "tools";
    case "decision":
      return "decisions";
    case "event":
      return "events";
    case "knowledge":
    case "observation":
    case "correction":
    case "fact":
    default:
      return "knowledge";
  }
}

function itemSummary(entry: MemoryEntry): string {
  const bits = [entry.content.trim()];
  if (entry.whenToUse) {
    bits.push(`Use: ${entry.whenToUse.trim()}`);
  }
  if (entry.happenedAt) {
    bits.push(`At: ${entry.happenedAt}`);
  }
  bits.push(`[ref:${entry.id}]`);
  return bits.join(" ");
}

function recencyScore(entry: MemoryEntry): number {
  const anchor = entry.happenedAt || entry.lastReinforcedAt || entry.updated || entry.created;
  const parsed = Date.parse(anchor || "");
  if (!Number.isFinite(parsed)) return 0;
  const ageDays = Math.max(0, (Date.now() - parsed) / (1000 * 60 * 60 * 24));
  return Math.exp(-ageDays / 14);
}

function rollupPriority(entry: MemoryEntry): number {
  const reinforcement = Math.max(1, Number(entry.reinforcementCount ?? 1));
  const confidence = Math.max(0, Math.min(1, Number(entry.confidence ?? 0.7)));
  return confidence * 0.6 + Math.log1p(reinforcement) * 0.15 + recencyScore(entry) * 0.25;
}

export function buildMemoryRollups(entries: MemoryEntry[], limitPerCategory = 6): MemoryRollup[] {
  const buckets = new Map<MemoryRollupCategoryId, MemoryEntry[]>();
  for (const entry of entries) {
    const category = categoryForType(entry.type);
    const bucket = buckets.get(category) ?? [];
    bucket.push(entry);
    buckets.set(category, bucket);
  }

  const rollups: Array<MemoryRollup | null> = CATEGORY_ORDER.map((category) => {
    const items = (buckets.get(category) ?? [])
      .sort((left, right) => {
        const leftScore = rollupPriority(left);
        const rightScore = rollupPriority(right);
        return rightScore - leftScore;
      })
      .slice(0, limitPerCategory);

    if (items.length === 0) return null;

    return {
      id: category,
      title: CATEGORY_TITLES[category],
      summary: items.map(itemSummary).join("\n"),
      itemCount: items.length,
      items: items.map((entry) => ({
        id: entry.id,
        content: entry.content,
        type: entry.type,
        confidence: entry.confidence,
        tags: entry.tags,
        refs: [entry.id],
        whenToUse: entry.whenToUse,
        happenedAt: entry.happenedAt,
      })),
    };
  });

  return rollups.filter((item): item is MemoryRollup => item !== null);
}
