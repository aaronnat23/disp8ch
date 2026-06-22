import { NextRequest, NextResponse } from "next/server";
import { requireOperatorAccess } from "@/lib/security/admin";
import { listHierarchyGoals, updateHierarchyGoal } from "@/lib/hierarchy/goals";
import { listBoardTasks } from "@/lib/boards/manager";
import { listGoalJudgments, listGoalRuns } from "@/lib/goals/goal-run-ledger";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;

  try {
    const url = new URL(request.url);
    const includeInactive = url.searchParams.get("includeInactive") === "1";
    const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") || 50)));
    const goals = listHierarchyGoals({ includeInactive }).slice(0, limit).map((goal) => {
      const tasks = listBoardTasks(undefined, { goalId: goal.id });
      const runs = listGoalRuns(goal.id, 10);
      const judgments = listGoalJudgments(goal.id, 10);
      return {
        ...goal,
        taskSummary: {
          total: tasks.length,
          ready: tasks.filter((task) => task.status === "inbox" || task.status === "in_progress").length,
          review: tasks.filter((task) => task.status === "review").length,
          blocked: tasks.filter((task) => task.status === "blocked").length,
          done: tasks.filter((task) => task.status === "done").length,
        },
        tasks: tasks.slice(0, 20),
        runs,
        judgments,
      };
    });

    return NextResponse.json({
      success: true,
      data: {
        summary: {
          total: goals.length,
          active: goals.filter((goal) => goal.status === "active").length,
          blocked: goals.filter((goal) => goal.status === "blocked").length,
          done: goals.filter((goal) => goal.status === "done").length,
        },
        goals,
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
    const body = await request.json() as { action?: string; id?: string };
    if (!body.id) return NextResponse.json({ error: "id is required" }, { status: 400 });

    if (body.action === "pause") {
      const goal = updateHierarchyGoal(body.id, { status: "blocked" });
      return NextResponse.json({ success: true, data: goal });
    }
    if (body.action === "resume") {
      const goal = updateHierarchyGoal(body.id, { status: "active" });
      return NextResponse.json({ success: true, data: goal });
    }
    if (body.action === "clear" || body.action === "done") {
      const goal = updateHierarchyGoal(body.id, { status: "done" });
      return NextResponse.json({ success: true, data: goal });
    }

    return NextResponse.json({ error: `Unknown action: ${String(body.action)}` }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
