import {
  BUILTIN_DOMAIN_DEFAULTS,
  BUILTIN_INTENT_ALLOWED_COMMANDS,
  BUILTIN_INTENT_MODEL_EXAMPLES,
  BUILTIN_INTENT_ROUTER_CARDS,
  BUILTIN_INTENT_SURFACE_DESCRIPTIONS,
  BUILTIN_INTENTS,
  type AppControlDomain,
  type BuiltinIntentClass,
  type BuiltinIntentEntry,
} from "./routing-spec";

export {
  BUILTIN_DOMAIN_DEFAULTS,
  BUILTIN_INTENT_ALLOWED_COMMANDS,
  BUILTIN_INTENT_MODEL_EXAMPLES,
  BUILTIN_INTENT_ROUTER_CARDS,
  BUILTIN_INTENT_SURFACE_DESCRIPTIONS,
  BUILTIN_INTENTS,
  getCommandPaletteEntries,
  getCommandPaletteText,
} from "./routing-spec";
export type { AppControlDomain, BuiltinIntentClass, BuiltinIntentEntry, CommandPaletteEntry } from "./routing-spec";

export function resolveBuiltinDomainFromText(raw: string): AppControlDomain | null {
  const normalized = normalizeBuiltinIntentLookup(raw);
  if (!normalized) return null;

  const aliasIntent = findBuiltinIntentByAlias(raw);
  if (aliasIntent?.domains?.[0]) return aliasIntent.domains[0];

  const scores = new Map<AppControlDomain, number>();
  for (const entry of BUILTIN_INTENTS) {
    for (const domain of entry.domains) {
      let score = scores.get(domain) ?? 0;
      for (const keyword of entry.keywords) {
        const normalizedKeyword = normalizeBuiltinIntentLookup(keyword);
        if (!normalizedKeyword) continue;
        if (normalized === normalizedKeyword) score += 6;
        else if (containsNormalizedPhrase(normalized, normalizedKeyword)) score += 2;
      }
      const normalizedCommand = normalizeBuiltinIntentLookup(entry.command);
      if (normalized === normalizedCommand) score += 5;
      else if (containsNormalizedPhrase(normalized, normalizedCommand)) score += 2;
      scores.set(domain, score);
    }
  }

  let best: { domain: AppControlDomain; score: number } | null = null;
  for (const [domain, score] of scores.entries()) {
    if (score <= 0) continue;
    if (!best || score > best.score) best = { domain, score };
  }
  return best?.domain ?? null;
}

export function normalizeBuiltinIntentLookup(value: string): string {
  return String(value || "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokenizeBuiltinIntentLookup(value: string): string[] {
  return normalizeBuiltinIntentLookup(value)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function containsNormalizedPhrase(haystack: string, needle: string): boolean {
  const haystackTokens = tokenizeBuiltinIntentLookup(haystack);
  const needleTokens = tokenizeBuiltinIntentLookup(needle);
  if (needleTokens.length === 0 || haystackTokens.length < needleTokens.length) return false;
  for (let index = 0; index <= haystackTokens.length - needleTokens.length; index += 1) {
    const candidate = haystackTokens.slice(index, index + needleTokens.length);
    if (candidate.every((token, tokenIndex) => token === needleTokens[tokenIndex])) return true;
  }
  return false;
}

export function findBuiltinIntentByAlias(raw: string): BuiltinIntentEntry | null {
  const normalized = normalizeBuiltinIntentLookup(raw);
  if (!normalized) return null;
  const stripped = normalized.replace(/^(?:and|also|plus|then)\s+/, "");
  return BUILTIN_INTENTS.find((entry) =>
    entry.aliases.some((alias) => normalizeBuiltinIntentLookup(alias) === normalized),
  ) ?? BUILTIN_INTENTS.find((entry) =>
    stripped !== normalized && entry.aliases.some((alias) => normalizeBuiltinIntentLookup(alias) === stripped),
  ) ?? null;
}

export function findBuiltinIntentByCommand(command: string): BuiltinIntentEntry | null {
  const normalized = normalizeBuiltinIntentLookup(command);
  return BUILTIN_INTENTS.find((entry) => normalizeBuiltinIntentLookup(entry.command) === normalized) ?? null;
}

export function getDefaultBuiltinCommandForDomain(domain: AppControlDomain | null | undefined): string | null {
  if (!domain) return null;
  return BUILTIN_DOMAIN_DEFAULTS.get(domain) ?? null;
}

export function resolveBuiltinIntentByKeywords(raw: string, domain?: string | null): BuiltinIntentEntry | null {
  const normalized = normalizeBuiltinIntentLookup(raw);
  if (!normalized) return null;
  const scopedDomain = domain && BUILTIN_DOMAIN_DEFAULTS.has(domain as AppControlDomain)
    ? domain as AppControlDomain
    : null;

  const entries = BUILTIN_INTENTS.filter((entry) =>
    !scopedDomain || entry.domains.length === 0 || entry.domains.includes(scopedDomain),
  );

  let best: { entry: BuiltinIntentEntry; score: number } | null = null;
  for (const entry of entries) {
    let score = 0;
    if (scopedDomain && entry.domains.includes(scopedDomain)) score += 3;
    for (const keyword of entry.keywords) {
      const normalizedKeyword = normalizeBuiltinIntentLookup(keyword);
      if (!normalizedKeyword) continue;
      if (normalized === normalizedKeyword) score += 6;
      else if (containsNormalizedPhrase(normalized, normalizedKeyword)) score += 2;
    }
    if (score > 0 && (!best || score > best.score)) {
      best = { entry, score };
    }
  }
  return best?.entry ?? null;
}
