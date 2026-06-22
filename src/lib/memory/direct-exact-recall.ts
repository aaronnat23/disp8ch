import { getSqlite } from "@/lib/db";
import { resolveMemoryAgentId } from "./agent-scope";
import {
  classifyExactRecallQuery,
  extractIdentifierValues,
  type QueryRecallClass,
} from "./exact-recall";
import {
  resolveIdentifierQuery,
  type ResolvedIdentifierQuery,
} from "./identifier-index";

export type DirectExactRecallResolution = {
  kind: ResolvedIdentifierQuery["kind"];
  queryClass: QueryRecallClass;
  identifier: string;
  response: string;
  snippet: string;
  sourcePath: string;
  wantsOnlyIdentifier: boolean;
};

export function loadRecentIdentifierQueryContext(sessionId: string): string {
  try {
    const db = getSqlite();
    const rows = db
      .prepare(
        `SELECT role, content
           FROM messages
          WHERE session_id = ?
          ORDER BY created_at DESC
          LIMIT 8`,
      )
      .all(sessionId) as Array<{ role: string; content: string }>;
    return rows
      .filter((row) => {
        const role = String(row.role || "");
        const content = String(row.content || "");
        return role === "user" || extractIdentifierValues(content).length > 0;
      })
      .map((row) => String(row.content || "").trim())
      .filter(Boolean)
      .reverse()
      .join(" ");
  } catch {
    return "";
  }
}

function formatResolvedIdentifierResponse(resolved: ResolvedIdentifierQuery): string {
  if (resolved.kind === "exact_history") {
    const lines = resolved.history.slice(0, 6).map((row, index) => {
      const status = index === 0 || row.isCurrent ? "current" : "superseded";
      return `- ${row.identifier} (${status})`;
    });
    return resolved.wantsOnlyIdentifier
      ? resolved.identifier
      : [`Current identifier: ${resolved.identifier}`, "Known versions:", ...lines].join("\n");
  }

  return resolved.wantsOnlyIdentifier
    ? resolved.identifier
    : [
      `The current exact identifier is ${resolved.identifier}.`,
      `Source memory: ${resolved.row.content.replace(/\s+/g, " ").trim()}`,
    ].join("\n");
}

export function resolveDirectExactRecall(opts: {
  agentId?: string | null;
  query: string;
  sessionId?: string | null;
}): DirectExactRecallResolution | null {
  const query = String(opts.query || "").trim();
  if (!query) return null;
  const queryClass = classifyExactRecallQuery(query);
  if (queryClass === "semantic_memory") return null;
  const sessionId = String(opts.sessionId || "").trim();
  const sessionContext = sessionId ? loadRecentIdentifierQueryContext(sessionId) : "";
  const memoryAgentId = resolveMemoryAgentId(opts.agentId);
  const resolved = resolveIdentifierQuery({
    agentId: memoryAgentId,
    query,
    sessionId: sessionId || null,
    sessionContext,
  });
  if (!resolved) return null;
  return {
    kind: resolved.kind,
    queryClass: resolved.queryClass,
    identifier: resolved.identifier,
    response: formatResolvedIdentifierResponse(resolved),
    snippet: resolved.row.content.replace(/\s+/g, " ").trim(),
    sourcePath: resolved.row.sourcePath || resolved.row.memoryEntryId || "identifier-index",
    wantsOnlyIdentifier: resolved.wantsOnlyIdentifier,
  };
}
