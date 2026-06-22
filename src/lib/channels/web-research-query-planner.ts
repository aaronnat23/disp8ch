import type { ResearchSourcePurpose } from "@/lib/channels/web-research-task-spec";

export interface PlannedQuery {
  query: string;
  sourcePurpose: ResearchSourcePurpose;
}

export function buildResearchQueries(
  message: string,
  purposes: ResearchSourcePurpose[],
): PlannedQuery[] {
  const topic = cleanTopic(message);
  const compact = topic
    .replace(/^(?:the|a|an)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();

  const queries: PlannedQuery[] = [];

  const purposeSet = new Set(purposes);
  const productEntities = extractPromptEntities(message);
  if (purposeSet.has("official_primary_product")) {
    const entity = productEntities[0] ?? "the named product";
    queries.push(
      { query: `${entity} official documentation`, sourcePurpose: "official_primary_product" },
      { query: `${entity} setup guide official docs`, sourcePurpose: "official_primary_product" },
    );
  }
  if (purposeSet.has("official_integration_product")) {
    const entity = productEntities[1] ?? productEntities[0] ?? "the named integration product";
    queries.push(
      { query: `${entity} official documentation`, sourcePurpose: "official_integration_product" },
      { query: `${entity} setup guide official docs`, sourcePurpose: "official_integration_product" },
    );
  }
  if (purposeSet.has("model_runtime")) {
    // Derive the hardware qualifier from the prompt — do not hardcode a platform/VRAM.
    const hwPlatform = /\bwindows\b/i.test(message) ? "Windows"
      : /\b(?:linux|ubuntu|debian|fedora|arch)\b/i.test(message) ? "Linux"
      : /\b(?:mac|macos|osx|apple\s+silicon)\b/i.test(message) ? "macOS" : "";
    const hwMem = message.match(/\d+\s*gb/i)?.[0] ?? "";
    const hwQualifier = [hwPlatform, hwMem].filter(Boolean).join(" ");
    queries.push(
      { query: `${compact} model runtime documentation`, sourcePurpose: "model_runtime" },
      { query: `${compact}${hwQualifier ? " " + hwQualifier : ""} model requirements`.replace(/\s+/g, " ").trim(), sourcePurpose: "model_runtime" },
    );
  }
  if (purposeSet.has("community_report")) {
    queries.push(
      { query: `${compact} GitHub issues`, sourcePurpose: "community_report" },
      { query: `${compact} GitHub discussions`, sourcePurpose: "community_report" },
      { query: `"${compact}" discussion Reddit`, sourcePurpose: "community_report" },
      { query: `site:reddit.com ${compact}`, sourcePurpose: "community_report" },
      { query: `${compact} Hacker News`, sourcePurpose: "community_report" },
    );
  }

  if (purposeSet.has("generic") || queries.length === 0) {
    queries.push(
      { query: `"${compact}"`, sourcePurpose: "generic" },
      { query: `${compact} official docs`, sourcePurpose: "generic" },
      { query: `${compact} setup guide`, sourcePurpose: "generic" },
    );
  }

  return deduplicateQueries(queries);
}

function cleanTopic(message: string): string {
  return message
    .replace(/\b(?:summari[sz]e|include|with|give me|show me|top\s+\d+\s+themes?)\b[\s\S]*$/i, "")
    .replace(/\b(?:source\s+links?|links?|urls?)\b[\s\S]*$/i, "")
    .replace(/\b(?:latest|current|recent)\s+(?:public\s+)?(?:discussion|reaction|conversation)\s+(?:about|around|on)\b/i, "")
    .replace(/\b(?:search|research|look\s+up|find)\s+(?:the\s+web\s+)?(?:for|about|on)?/i, "")
    .replace(/[.?!]\s*$/g, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160) || message.slice(0, 160).trim();
}

function extractPromptEntities(message: string): string[] {
  const entities = new Set<string>();
  for (const quoted of message.matchAll(/["'`]([^"'`]{2,80})["'`]/g)) {
    const value = quoted[1]?.replace(/\s+/g, " ").trim();
    if (value) entities.add(value);
  }
  for (const match of message.matchAll(/\b([A-Z][A-Za-z0-9.+_-]*(?:\s+[A-Z][A-Za-z0-9.+_-]*){0,3})\b/g)) {
    const value = match[1]?.replace(/\s+/g, " ").trim();
    if (!value || /^(?:I|The|This|That|What|How|When|Where|Which|Can|Does|Do|Please|Windows|Linux|Mac|GPU|VRAM)$/i.test(value)) continue;
    entities.add(value);
  }
  return Array.from(entities).slice(0, 4);
}

function deduplicateQueries(queries: PlannedQuery[]): PlannedQuery[] {
  const seen = new Set<string>();
  const deduped: PlannedQuery[] = [];
  for (const q of queries) {
    const normalized = q.query.toLowerCase().replace(/\s+/g, " ").replace(/["*()]/g, "").trim();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      deduped.push(q);
    }
  }
  return deduped;
}
