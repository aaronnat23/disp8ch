/**
 * Fast memory-recall lane.
 *
 * General key=value recall used to fall through to the heavy universal agentic
 * runtime (plan → memory/file tools → critique), which is correct but slow
 * for a trivial lookup.
 *
 * Scope: this lane ONLY handles the GENERAL key=value recall that the existing
 * exact-identifier lane (router `exact_memory_recall`, collision-safe,
 * newest-wins, no-leak) does not catch. Exact-identifier queries are deferred to
 * that lane so its routeSource and collision semantics are preserved.
 *
 * It is structural (no hardcoded keys/answers) and returns null whenever the
 * message is not a clear general recall or memory has nothing relevant, so
 * normal routing is unaffected.
 */

import { logger } from "@/lib/utils/logger";

const log = logger.child("channels:fast-recall");

export type FastRecallResult = { response: string; source: string } | null;

export type ParsedMemorySave = { key: string; value: string };

const SECRET_KEY_RE = /\b(?:api[_-]?key|api|token|password|passwd|secret|credential|bearer|private[_-]?key|access[_-]?key|auth[_-]?token|client[_-]?secret)\b/i;
const SECRET_VALUE_RE = /\b(?:sk-[a-z0-9]{12,}|ghp_[a-z0-9]{20,}|xox[baprs]-[a-z0-9-]{10,}|eyJ[a-zA-Z0-9_-]{20,})\b/i;

/**
 * Parse a simple "remember key = value" save. Accepts only short structured
 * facts — not secrets, multiline notes, or app-action requests. Returns null
 * (fall through to normal routing) for anything it does not confidently accept.
 */
export function parseSimpleMemorySave(raw: string): ParsedMemorySave | null {
  let m = String(raw || "").trim();
  if (!m || m.length > 400) return null;

  // Strip a trailing "Reply with only the word saved" style instruction.
  m = m.replace(/[.;,]?\s*(?:and\s+)?(?:please\s+)?reply\s+(?:with\s+)?(?:only\s+)?(?:the\s+word\s+)?["'`]?saved["'`]?\.?\s*$/i, "").trim();

  // A question is a recall, never a save ("What is X?", "which token…?").
  if (/\?\s*$/.test(m) || /^\s*(?:what|which|who|where|when|why|how|is|are|do|does|did|can|could|would|should|tell\s+me|show\s+me|recall|remind)\b/i.test(m)) return null;

  // Reject multiline / large note payloads and "remember everything" requests.
  if (/\n/.test(m)) return null;
  if (/\b(?:everything|transcript|whole\s+paragraph|entire|paragraph|summari[sz]e\s+it|this\s+note\s+and)\b/i.test(m)) return null;
  // Reject app-action saves ("create memory workflow", etc.).
  if (/\b(?:workflow|board|council|org(?:anization)?|agents?|schedule|channel|hierarchy|template)\b/i.test(m)) return null;

  // Must look like a save.
  const hasSaveVerb = /\b(?:remember|save|store|note|keep)\b/i.test(m);
  const hasAssignment = /[A-Za-z][\w-]*\s*[:=]\s*\S/.test(m) || /\b[A-Za-z][\w-]*\s+(?:is|was)\s+\S/.test(m);
  if (!hasSaveVerb && !hasAssignment) return null;

  // Drop the leading save lead-in ("remember this for later:", "save this:",
  // "store", "note", "keep", "remember my", "remember that"). Note: "this"/"that"
  // may be glued to a colon ("Remember this:"), so do not require trailing space.
  let body = m
    .replace(/^\s*(?:please\s+)?(?:remember|save|store|note|keep)\b\s*(?:this|that|the\s+following)?\b\s*(?:for\s+later)?\s*[:,-]?\s*/i, "")
    .replace(/^\s*(?:my|our|your)\s+/i, "")
    .trim();

  // key (= | : | is | was) value
  const match = body.match(/^([A-Za-z][A-Za-z0-9 _-]{0,48}?[A-Za-z0-9])\s*(?:=|:|\bis\b|\bwas\b)\s*(.+)$/i);
  if (!match) return null;
  const key = match[1].trim();
  const value = match[2].trim().replace(/^["'`]|["'`.]+$/g, "").trim();
  if (!key || !value) return null;
  // Assignment-only saves such as "release_codename = Nimbus" are useful, but
  // natural-language commands with colons ("Write an answer with: one H2...")
  // are formatting requests, not memory facts. Multi-word keys need an explicit
  // save verb before they can enter the fast memory lane.
  if (!hasSaveVerb && /\s/.test(key)) return null;
  if (key.split(/\s+/).length > 5) return null; // a note, not a key
  if (value.length > 200) return null;
  // Reject secrets.
  if (SECRET_KEY_RE.test(key) || SECRET_VALUE_RE.test(value)) return null;
  return { key, value };
}

/** Persist a simple fact durably (synchronously), bypassing the agentic runtime. */
export async function saveSimpleMemoryFact(args: {
  sessionId?: string | null;
  agentId?: string | null;
  key: string;
  value: string;
  originalMessage?: string;
}): Promise<{ id: string }> {
  const { createMemoryProvider } = await import("@/lib/memory/provider");
  const provider = createMemoryProvider(undefined, args.agentId ?? "default");
  const now = new Date().toISOString();
  const id = `mem_fast_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const stored = await provider.store({
    id,
    type: "fact",
    content: `${args.key} = ${args.value}`,
    confidence: 0.98,
    source: "webchat-fast-save",
    tags: ["fast-memory", "webchat"],
    created: now,
    updated: now,
    metadata: { source: "webchat-fast-save", sessionId: args.sessionId ?? null, key: args.key, fastMemory: true },
  });
  return { id: stored.id };
}

/** Structural recall-intent detector: a short question for a stored value. */
export function isFastRecallCandidate(message: string): boolean {
  const m = String(message || "").trim();
  if (!m || m.length > 200) return false;
  if (m.split(/\s+/).length > 16) return false;

  // A SAVE provides a value ("remember this: X = Y", "for later", "reply saved");
  // a RECALL only asks for one. Never treat a save as a recall.
  if (
    /\b(?:remember|save|store|note|keep)\s+(?:this|that|the\s+following)\b/i.test(m) ||
    /\bfor\s+later\b/i.test(m) ||
    /\breply\s+(?:with\s+)?(?:only\s+)?(?:the\s+word\s+)?saved\b/i.test(m) ||
    /[A-Za-z_][\w-]*\s*=\s*\S/.test(m) // contains a key=value assignment
  ) {
    return false;
  }

  const recallVerb =
    /\b(?:what(?:'s| is| was| were)|recall|remind\s+me|do\s+you\s+remember|did\s+(?:i|we)\s+(?:save|store|tell|mention|set)|what\s+did\s+(?:i|we)\s+(?:save|store|set|call|name))\b/i.test(m);
  if (!recallVerb) return false;

  // Only fire when there is a plausible *stored* target: an explicit memory word
  // or a snake/kebab-case key token. This keeps general-knowledge questions
  // ("what is the capital of France?") out of the memory lane.
  const hasMemoryWord = /\b(?:remember(?:ed)?|recall|saved|stored|remembered|codename|test\s+fact|previously|earlier|did\s+(?:i|we)\s+(?:tell|say|mention|save|store))\b/i.test(m);
  const hasKeyToken = /\b[A-Za-z][A-Za-z0-9]*(?:[_-][A-Za-z0-9]+)+\b/.test(m);
  if (!hasMemoryWord && !hasKeyToken) return false;

  // Exclude genuine investigations — those keep their normal (tool/agentic) route.
  if (
    /\b(?:search|find|look\s+up|browse|fetch|scrape|web|online|internet|inspect|audit|review|repo|repositor|codebase|node_modules|src\/|workflow|board|council|org(?:anization)?|agent|schedule|channel|goal|hierarchy|workspace|file\b|files\b)\b/i.test(m)
  ) {
    return false;
  }
  return true;
}

/**
 * True when the message asks to create/modify app objects (agents, orgs, boards,
 * workflows, councils, channels, goals) — i.e. an app mutation, not a memory
 * recall. Used to keep the fast recall lane (which classifies "compare/history/
 * versions" phrasing as exact recall) from swallowing app mutations such as
 * "...give them a board task to compare OCR models". Requires BOTH a mutation
 * verb and an app-surface noun, so recall comparisons ("compare the old and
 * current test tokens") are not excluded.
 */
export function looksLikeAppMutation(raw: string): boolean {
  const m = String(raw || "");
  const hasMutationVerb = /\b(?:create|build|make|set\s+up|spin\s+up|stand\s+up|put\s+them|give\s+them|assign|connect|schedule|rename|delete|remove|disable|enable|launch|deploy|generate)\b/i.test(m);
  if (!hasMutationVerb) return false;
  return /\b(?:team|agent|agents|org|organi[sz]ation|board|task|tasks|workflow|council|channel|goal|hierarchy|automation)\b/i.test(m);
}

/** Pull the most identifier-like key the question is asking about. */
function extractRecallKey(message: string): string | null {
  const m = String(message || "");
  const idMatch = m.match(/\b([A-Za-z][A-Za-z0-9]*(?:[_-][A-Za-z0-9]+)+)\b/);
  if (idMatch?.[1]) return idMatch[1];
  const phrase = m.match(/\b(?:what(?:'s| is| was| were)?|recall|remind\s+me\s+(?:of|what)|remember)\s+(?:the\s+|my\s+|our\s+|your\s+)?([a-z][a-z0-9 ]{2,40}?)\s*\??$/i);
  if (phrase?.[1]) return phrase[1].trim();
  return null;
}

/**
 * Instant session-recent scan: the just-saved fact is always in the conversation
 * ("Remember this: X = Y" is a user message), so we can answer an immediate
 * post-save recall without waiting on the async memory index. This is the
 * efficiency win: no per-turn MEMORY.md context injection, just a targeted
 * read of recent messages on recall.
 */
async function scanSessionForKey(sessionId: string, key: string): Promise<string | null> {
  if (!sessionId || !key) return null;
  try {
    const { getSqlite } = await import("@/lib/db");
    const db = getSqlite();
    const rows = db
      .prepare(`SELECT content FROM messages WHERE session_id = ? ORDER BY created_at DESC LIMIT 24`)
      .all(sessionId) as Array<{ content: string }>;
    for (const row of rows) {
      const value = extractValueForKey(String(row.content || ""), key);
      if (value) return value;
    }
  } catch {
    /* table/shape mismatch — fall through */
  }
  return null;
}

/** Find `key = value` / `key: value` / `key is value` inside a memory chunk. */
function extractValueForKey(content: string, key: string): string | null {
  if (!content || !key) return null;
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`${escaped}\\s*[:=]\\s*([^\\n.;,]+)`, "i"),
    new RegExp(`${escaped}\\s+(?:is|was|=)\\s+([^\\n.;,]+)`, "i"),
  ];
  for (const re of patterns) {
    const match = content.match(re);
    if (match?.[1]) {
      const value = match[1].trim().replace(/^["'`]|["'`.]+$/g, "").trim();
      if (value && value.length <= 200) return value;
    }
  }
  return null;
}

export async function tryFastMemoryRecall(opts: {
  message: string;
  sessionId?: string | null;
  agentId?: string | null;
}): Promise<FastRecallResult> {
  if (!isFastRecallCandidate(opts.message)) return null;
  const query = opts.message.trim();
  const sessionId = opts.sessionId ? String(opts.sessionId) : "";
  const agentId = opts.agentId ?? "default";

  // Exact-identifier recalls are routed to the deterministic exact_memory_recall
  // lane upstream (full collision/lineage/newest-wins handling). This lane only
  // handles GENERAL key=value recall the identifier lane does not classify.
  try {
    const { classifyExactRecallQuery } = await import("@/lib/memory/exact-recall");
    if (classifyExactRecallQuery(query) !== "semantic_memory") return null;
  } catch {
    return null;
  }

  const key = extractRecallKey(query);

  // Step 1 — instant session-recent scan (immediate-post-save consistency,
  // no index wait, no per-turn context cost.
  if (key) {
    const sessionValue = await scanSessionForKey(sessionId, key);
    if (sessionValue) {
      log.info("fast-recall: session-recent key=value hit", { key });
      return { response: sessionValue, source: "session" };
    }
  }

  // Step 2 — general key=value recall via a fast FTS-only memory search. We use
  // SimpleMemoryProvider directly (BM25 + file-scan, no vector/embedding step) so
  // a trivial lookup never pays the hybrid search-manager's live query-embedding
  // cost. Vector similarity is unnecessary for an exact key match. Search by the
  // extracted key when we have one (cleaner FTS match), else the whole question.
  let hits: Array<{ content: string; path: string; score: number; recency: number }> = [];
  try {
    const { SimpleMemoryProvider } = await import("@/lib/memory/simple");
    const provider = new SimpleMemoryProvider(agentId);
    const entries = await provider.search(key || query, 8);
    hits = entries.map((e) => ({
      content: String(e.content || ""),
      path: String(e.id || "memory"),
      score: Number((e as { score?: number }).score || 0),
      recency: Date.parse(String(e.updated || e.created || e.lastReinforcedAt || "")) || 0,
    }));
  } catch (err) {
    log.debug("fast-recall: memory search failed", { error: String(err) });
    return null;
  }
  if (hits.length === 0) return null;

  // Newest-first so an overwritten key returns its latest value.
  const byRecency = [...hits].sort((a, b) => b.recency - a.recency);

  // Deterministic key=value extraction from durable hits.
  if (key) {
    for (const hit of byRecency) {
      const value = extractValueForKey(hit.content, key);
      if (value) {
        log.info("fast-recall: deterministic key=value hit", { key });
        return { response: value, source: hit.path };
      }
    }
  }

  // One small model synthesis over the top hits (still far cheaper than the full
  // agentic runtime). Skipped when no model key is available.
  try {
    const [{ getModelConfig }, { callModel }, { providerRequiresApiKey }] = await Promise.all([
      import("@/lib/agents/model-router"),
      import("@/lib/agents/multi-provider"),
      import("@/lib/agents/provider-plugins"),
    ]);
    const modelConfig = getModelConfig({ sessionId });
    if (!modelConfig.apiKey && providerRequiresApiKey(modelConfig.provider)) return null;
    const facts = byRecency.slice(0, 6).map((h, i) => `(${i + 1}) ${h.content.replace(/\s+/g, " ").trim()}`).join("\n");
    const result = await Promise.race([
      callModel({
        provider: modelConfig.provider,
        modelId: modelConfig.modelId,
        apiKey: modelConfig.apiKey,
        baseUrl: modelConfig.baseUrl,
        systemPrompt:
          "You answer a user's recall question using ONLY the remembered facts provided. " +
          "Reply with just the value, as concisely as possible (one short line). " +
          "If the answer is not present in the facts, reply exactly: I don't have that saved.",
        userMessage: `Remembered facts:\n${facts}\n\nQuestion: ${query}`,
        maxTokens: 120,
        temperature: 0,
        fastMode: modelConfig.fastMode,
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("fast-recall synthesis timed out")), 20000)),
    ]);
    const answer = String(result.response || "").trim();
    if (!answer || /^i don'?t have that saved/i.test(answer)) return null;
    return { response: answer, source: byRecency[0]?.path || "memory" };
  } catch (err) {
    log.debug("fast-recall: synthesis failed", { error: String(err) });
    return null;
  }
}
