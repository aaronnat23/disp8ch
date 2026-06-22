/**
 * Background skill review — fires after every SKILL_NUDGE_INTERVAL turns in a
 * channel session.
 *
 * Sends the recent conversation to the unified evidence-rich self-learning
 * reviewer (`runSelfLearningReview`) and writes durable proposals to the
 * self-improvement queue. The reviewer prefers patching a loaded or umbrella
 * skill before proposing a new narrow skill, and refuses to persist transient
 * negative tool claims or one-off task status. Runs fire-and-forget and never
 * blocks the main response path.
 */

import { logger } from "@/lib/utils/logger";
import {
  persistSelfLearningProposals,
  runSelfLearningReview,
  shouldRunSelfLearningReview,
  type SelfLearningProposal,
} from "@/lib/learning/self-learning-reviewer";

const log = logger.child("agents:skill-review");

// ── Helpers ───────────────────────────────────────────────────────────────────

function serializeConversation(
  rows: Array<{ role: string; content: string }>,
  maxChars = 12000,
): string {
  const recent = rows.slice(-40);
  let out = "";
  for (const row of recent) {
    const line = `${row.role.toUpperCase()}: ${row.content.slice(0, 400)}\n`;
    if (out.length + line.length > maxChars) break;
    out += line;
  }
  return out.trim();
}

// ── Main export ───────────────────────────────────────────────────────────────

export interface SkillReviewOpts {
  sessionId: string;
  agentId?: string | null;
  provider: string;
  modelId: string;
  apiKey: string;
  baseUrl?: string;
  routeSource?: string | null;
  toolTrace?: Array<{ name: string; ok: boolean; argsSummary?: string; outputSummary?: string }>;
  filesChanged?: string[];
  criticReports?: Array<{ decision: string; confidence: string; findings?: string[]; missingEvidence?: string[] }>;
}

export async function runBackgroundSkillReview(opts: SkillReviewOpts): Promise<void> {
  try {
    const { getSqlite, initializeDatabase } = await import("@/lib/db");
    initializeDatabase();
    const db = getSqlite();

    // Keep agentId for metadata only — do NOT use it to filter the query.
    // The router persists messages with defaultChannelAgentId() but the
    // claude-agent node may use a different agent, so filtering by agent_id
    // would return 0 rows for any non-default agent workflow.
    const agentId = String(opts.agentId || "").trim() || "default";

    // Query all user+assistant messages for the session regardless of agent_id.
    // Pass the full conversation so the reviewer can detect repeated patterns.
    const rows = db
      .prepare(
        `SELECT role, content, created_at
           FROM messages
          WHERE session_id = ?
            AND role IN ('user', 'assistant')
          ORDER BY created_at ASC`,
      )
      .all(opts.sessionId) as Array<{ role: string; content: string; created_at?: string }>;

    // Need at least a few turns to have anything meaningful to review
    if (rows.length < 4) return;

    const conversation = rows.map((row) => ({
      role: row.role,
      content: row.content,
      createdAt: row.created_at,
    }));

    const triggerContext = {
      routeSource: opts.routeSource ?? null,
      message: rows[rows.length - 1]?.content ?? "",
      toolTrace: opts.toolTrace,
      filesChanged: opts.filesChanged,
      criticReports: opts.criticReports,
    };
    if (!shouldRunSelfLearningReview(triggerContext)) {
      // Fall back to the cheap pre-universal heuristic so we still capture
      // long conversations that did not hit an obvious agentic signal.
      const lastAssistant = rows.filter((row) => row.role === "assistant").pop()?.content || "";
      if (rows.length < 8 || lastAssistant.length < 240) return;
    }

    const proposals = await runSelfLearningReview(
      {
        sessionId: opts.sessionId,
        agentId,
        conversation,
        routeSource: opts.routeSource ?? null,
        toolTrace: opts.toolTrace,
        filesChanged: opts.filesChanged,
        criticReports: opts.criticReports,
        learningMode: "review",
      },
      {
        provider: opts.provider,
        modelId: opts.modelId,
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl,
      },
    );

    if (proposals.length === 0) {
      log.debug("Background skill review produced no proposals", {
        sessionId: opts.sessionId,
        conversationChars: serializeConversation(rows).length,
      });
      return;
    }

    const { written, rejected } = await persistSelfLearningProposals(proposals, opts.sessionId);
    log.info(`Background self-learning review persisted ${written} proposals (${rejected} rejected)`, {
      sessionId: opts.sessionId,
      kinds: proposals.map((p: SelfLearningProposal) => p.kind),
    });
  } catch (err) {
    log.debug("Background skill review failed (non-fatal)", { error: String(err) });
  }
}
