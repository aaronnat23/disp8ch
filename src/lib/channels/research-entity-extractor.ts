export type ResearchEntity = {
  name: string;
  searchHints: string[];
};

/**
 * Extracts named entities from a research prompt without a hardcoded domain table.
 * Uses structural signals: quoted names, capitalized products, GitHub refs, domains.
 */
export function extractResearchEntities(message: string): ResearchEntity[] {
  const entities: ResearchEntity[] = [];
  const seen = new Set<string>();

  function add(name: string, hints: string[]) {
    const normalized = name.toLowerCase().trim();
    if (normalized.length < 2 || seen.has(normalized)) return;
    seen.add(normalized);
    entities.push({ name: name.trim(), searchHints: hints });
  }

  // Quoted names: "Aider", 'Ollama', `LM Studio`
  for (const m of message.matchAll(/["'`]([^"'`\n]{2,60})["'`]/g)) {
    const name = m[1].trim();
    if (/^[A-Z]/.test(name) || /[.-]/.test(name)) {
      add(name, ["official docs", "GitHub issues"]);
    }
  }

  // Capitalized product/project names near compatibility verbs
  const compatVerbs = /\b(?:support|connect|work\s+with|compatible|integration|interoperab|run\s+(?:with|on|through)|use\s+(?:with|via))\b/i;
  const capNames = message.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/g) || [];
  for (const name of capNames) {
    if (/^(?:The|This|That|What|How|When|Where|Which|Can|Does|Is|Are|Do|Please|I|You|We|They|My|Your|Our|Their|A|An|For|And|But|Not|With|From|Into|About|After|Before|Between|During|Without|Under|Over|Through)$/i.test(name)) continue;
    if (name.length < 3) continue;
    // Check if near a compatibility verb
    const nameIdx = message.indexOf(name);
    const context = message.slice(Math.max(0, nameIdx - 80), nameIdx + name.length + 80);
    if (compatVerbs.test(context)) {
      add(name, ["official docs", "GitHub issues"]);
    }
  }

  // GitHub owner/repo mentions
  for (const m of message.matchAll(/\bgithub\.com\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)/g)) {
    add(`${m[1]}/${m[2]}`, ["GitHub repo", "GitHub issues"]);
  }

  // Domain-based product names: aider.chat, lmstudio.ai, continue.dev
  for (const m of message.matchAll(/\b([a-zA-Z0-9_-]+\.(?:dev|ai|io|chat|studio|com|org))\b/g)) {
    const domain = m[1].toLowerCase();
    if (/(?:github|google|youtube|reddit|stackoverflow|docs)\./.test(domain)) continue;
    const productName = domain.split(".")[0];
    add(productName, [`official site ${domain}`, "GitHub issues"]);
  }

  // Code-formatted names: `tool_name`, `package_name`
  for (const m of message.matchAll(/`([a-zA-Z][a-zA-Z0-9_-]{2,40})`/g)) {
    add(m[1], ["official docs", "GitHub issues"]);
  }

  return entities;
}

/**
 * Build search queries from extracted entities for use in agentic context.
 */
export function buildEntitySearchQueries(entities: ResearchEntity[]): string[] {
  const queries: string[] = [];
  for (const entity of entities) {
    for (const hint of entity.searchHints) {
      queries.push(`${entity.name} ${hint}`);
    }
  }
  return queries;
}
