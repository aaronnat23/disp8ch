import { NextRequest, NextResponse } from "next/server";
import { requireOperatorAccess } from "@/lib/security/admin";
import { evaluateSkillCompounding } from "@/lib/skills/skill-compounding-evaluator";
import { listSkillUsageEvents, listSkillUsageSummaries, recordSkillUsageEvent } from "@/lib/skills/usage-ledger";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;

  try {
    const url = new URL(request.url);
    const skillId = url.searchParams.get("skillId");
    const includeEvents = url.searchParams.get("events") === "1";
    const evaluate = url.searchParams.get("evaluate") === "1";
    const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit") || 200)));

    const summaries = listSkillUsageSummaries(limit).filter((summary) => skillId ? summary.skillId === skillId : true);
    const events = includeEvents ? listSkillUsageEvents({ skillId, limit }) : [];
    const evaluations = evaluate ? evaluateSkillCompounding({ skillId, limit }) : [];

    return NextResponse.json({
      success: true,
      data: {
        summary: {
          totalSkills: summaries.length,
          loaded: summaries.reduce((sum, item) => sum + item.loadedCount, 0),
          used: summaries.reduce((sum, item) => sum + item.usedCount, 0),
          appliedPatches: summaries.reduce((sum, item) => sum + item.appliedPatchCount, 0),
        },
        skills: summaries,
        events,
        evaluations,
      },
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;

  try {
    const body = await request.json() as {
      action?: string;
      skillId?: string;
      skillName?: string;
      skillSource?: string;
      sessionId?: string | null;
      agentId?: string | null;
      outcome?: string | null;
      evidence?: string[];
      metadata?: Record<string, unknown>;
    };

    if (body.action === "record-used") {
      if (!body.skillName || !body.skillSource) {
        return NextResponse.json({ error: "skillName and skillSource are required" }, { status: 400 });
      }
      const event = recordSkillUsageEvent({
        skillId: body.skillId,
        skillName: body.skillName,
        skillSource: body.skillSource,
        eventKind: "used",
        sessionId: body.sessionId ?? null,
        agentId: body.agentId ?? null,
        outcome: body.outcome ?? null,
        evidence: body.evidence ?? [],
        metadata: body.metadata ?? {},
      });
      return NextResponse.json({ success: true, data: event });
    }

    if (body.action === "evaluate") {
      return NextResponse.json({
        success: true,
        data: evaluateSkillCompounding({ skillId: body.skillId ?? null }),
      });
    }

    return NextResponse.json({ error: `Unknown action: ${String(body.action)}` }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
