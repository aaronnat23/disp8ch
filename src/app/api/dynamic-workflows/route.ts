import { NextRequest, NextResponse } from "next/server";
import { requireOperatorAccess } from "@/lib/security/admin";
import { listRuns } from "@/lib/dynamic-workflows/store";
import { generatePlanOutline, validatePlan } from "@/lib/dynamic-workflows/planner";
import { createAndStartRun } from "@/lib/dynamic-workflows/runner";
import type { DynamicWorkflowRunStatus, DynamicWorkflowSourceType } from "@/lib/dynamic-workflows/types";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;

  try {
    const url = new URL(request.url);
    const statusParam = url.searchParams.get("status")?.trim();
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit") || 20)));
    const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));

    const validStatuses = new Set<DynamicWorkflowRunStatus>([
      "draft", "awaiting_approval", "queued", "running", "paused", "completed", "failed", "cancelled",
    ]);

    const runs = listRuns({
      status: statusParam && validStatuses.has(statusParam as DynamicWorkflowRunStatus)
        ? (statusParam as DynamicWorkflowRunStatus)
        : undefined,
      limit,
      offset,
    });

    return NextResponse.json({
      success: true,
      data: { total: runs.length, limit, offset, runs },
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
      prompt?: string;
      context?: Record<string, unknown>;
      plan?: unknown;
      name?: string;
      description?: string;
      approve?: boolean;
      modelRef?: string;
    };

    const action = String(body.action ?? "").trim();

    if (action === "plan") {
      if (!body.prompt?.trim()) {
        return NextResponse.json({ success: false, error: "prompt is required" }, { status: 400 });
      }

      const result = generatePlanOutline(body.prompt, body.context);
      const validated = validatePlan(result.plan);
      if (!validated.success) {
        return NextResponse.json({ success: false, error: validated.error }, { status: 400 });
      }

      return NextResponse.json({
        success: true,
        data: {
          plan: validated.plan,
          outlineGenerated: result.outlineGenerated,
          warnings: result.warnings,
        },
      });
    }

    if (action === "create_run") {
      if (!body.plan) {
        return NextResponse.json({ success: false, error: "plan is required" }, { status: 400 });
      }

      const validated = validatePlan(body.plan);
      if (!validated.success) {
        return NextResponse.json({ success: false, error: validated.error }, { status: 400 });
      }

      const sourceType: DynamicWorkflowSourceType = "webchat";

      if (body.approve === false) {
        return NextResponse.json({
          success: true,
          data: {
            status: "awaiting_approval",
            message: "Run created as draft. Set approve=true to execute.",
            plan: validated.plan,
          },
        });
      }

      const run = await createAndStartRun(validated.plan, {
        name: body.name || validated.plan.objective.slice(0, 120),
        description: body.description,
        sourceType,
        sourceRef: "webchat",
        modelRef: body.modelRef,
        sessionId: body.context?.sessionId as string | undefined,
      });

      return NextResponse.json({ success: true, data: run }, { status: 201 });
    }

    return NextResponse.json({ success: false, error: `Unknown action: ${action || "(empty)"}` }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
