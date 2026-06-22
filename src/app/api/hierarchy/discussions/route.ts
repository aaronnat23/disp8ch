import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { runCouncilSession } from "@/lib/council/service";
import { listCouncilSessions, saveCouncilSession } from "@/lib/council/persistence";
import { checkPairReadiness } from "@/lib/agents/agent-pairing";
import { requireOperatorAccess } from "@/lib/security/admin";
import { logger } from "@/lib/utils/logger";

const log = logger.child("api:hierarchy:discussions");

function jsonResponse(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

const DiscussionRequestSchema = z.object({
  topic: z.string().min(3).max(4000),
  agentIds: z.array(z.string().min(1)).length(2),
  organizationId: z.string().min(1).optional(),
  goalId: z.string().min(1).optional(),
  documentIds: z.array(z.string().min(1)).max(6).optional(),
  rounds: z.number().int().min(2).max(5).optional(),
  synthesizerAgentId: z.string().min(1).optional(),
  costCapUsd: z.number().positive().max(100).optional(),
});

export async function POST(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const body = DiscussionRequestSchema.parse(await request.json());

    const [agent1, agent2] = body.agentIds;
    const readiness = checkPairReadiness([agent1, agent2]);
    const notReady = readiness.filter((r) => !r.ready);
    if (notReady.length > 0) {
      return jsonResponse({
        success: false,
        error: "One or both agents are not ready for discussion",
        readiness,
      }, 400);
    }

    const options = ["Agree with analysis", "Disagree — different approach needed", "Partially agree with caveats"];
    const rounds = body.rounds ?? 3;

    const result = await runCouncilSession({
      topic: body.topic,
      agentIds: [agent1, agent2],
      documentIds: body.documentIds ?? [],
      options,
      mode: "debate",
      rounds,
      decisionMode: "majority",
      synthesizerAgentId: body.synthesizerAgentId ?? undefined,
      costCapUsd: body.costCapUsd ?? 1.0,
    });

    const sessionId = `disc_${Date.now()}`;
    saveCouncilSession({
      id: sessionId,
      orgId: body.organizationId ?? null,
      topic: body.topic,
      mode: "debate",
      votingMethod: "majority",
      participants: [agent1, agent2],
      options,
      result: {
        ...result,
        hierarchyDiscussion: true,
        organizationId: body.organizationId ?? null,
        goalId: body.goalId ?? null,
        documentIds: body.documentIds ?? [],
      },
      verdict: result.conclusion,
    });

    return jsonResponse({
      success: true,
      data: {
        sessionId,
        topic: body.topic,
        organizationId: body.organizationId ?? null,
        goalId: body.goalId ?? null,
        agents: readiness.map((r) => ({
          agentId: r.agentId,
          family: r.family,
          ready: r.ready,
          issue: r.issue ?? null,
        })),
        opinions: result.opinions,
        tally: result.tally,
        winner: result.winner,
        synthesis: result.synthesis,
        conclusion: result.conclusion,
        debateTranscript: result.debateTranscript,
        totalCostUsd: result.totalCostUsd,
        blockedAgents: result.blockedAgents,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return jsonResponse({ success: false, error: error.message }, 400);
    }
    log.error("Discussion failed", { error: String(error) });
    return jsonResponse({ success: false, error: String(error) }, 500);
  }
}

export async function GET(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const { searchParams } = new URL(request.url);
    const organizationId = searchParams.get("organizationId") || null;
    const rows = listCouncilSessions(organizationId, 50).filter((row) => row.mode === "debate").slice(0, 20);
    return jsonResponse({ success: true, data: rows });
  } catch (error) {
    return jsonResponse({ success: false, error: String(error) }, 500);
  }
}
