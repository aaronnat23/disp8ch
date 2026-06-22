import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getCostAnalytics, getSpendByGoal, listAgentSpendEvents } from "@/lib/agents/budgets";
import { requireOperatorAccess } from "@/lib/security/admin";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const { searchParams } = new URL(request.url);
    const action = searchParams.get("action") ?? "analytics";

    switch (action) {
      case "analytics": {
        const windowDays = z.coerce
          .number()
          .int()
          .min(1)
          .max(365)
          .parse(searchParams.get("windowDays") ?? "30");
        return NextResponse.json({ success: true, data: getCostAnalytics(windowDays) });
      }

      case "by-goal": {
        const goalId = searchParams.get("goalId");
        if (!goalId) {
          return NextResponse.json({ success: false, error: "Missing goalId" }, { status: 400 });
        }
        const windowDays = searchParams.get("windowDays") ? Number(searchParams.get("windowDays")) : 30;
        return NextResponse.json({ success: true, data: getSpendByGoal(goalId, windowDays) });
      }

      case "agent-events": {
        const agentId = searchParams.get("agentId");
        if (!agentId) {
          return NextResponse.json({ success: false, error: "Missing agentId" }, { status: 400 });
        }
        const limit = searchParams.get("limit") ? Number(searchParams.get("limit")) : 20;
        return NextResponse.json({ success: true, data: listAgentSpendEvents(agentId, limit) });
      }

      default:
        return NextResponse.json({ success: false, error: "Unknown action" }, { status: 400 });
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
