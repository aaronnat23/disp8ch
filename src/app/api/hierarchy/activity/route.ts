import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  listHierarchyActivityEvents,
  recordHierarchyActivityEvent,
  summarizeHierarchyActivity,
} from "@/lib/hierarchy/activity";
import { requireOperatorAccess } from "@/lib/security/admin";

export const dynamic = "force-dynamic";

const CreateActivitySchema = z.object({
  organizationId: z.string().min(1).max(120).optional().nullable(),
  goalId: z.string().min(1).max(120).optional().nullable(),
  agentId: z.string().min(1).max(120).optional().nullable(),
  actorType: z.enum(["user", "agent", "system"]).optional(),
  eventType: z.string().min(1).max(120),
  title: z.string().min(1).max(240),
  summary: z.string().max(1200).optional().nullable(),
  status: z.string().max(80).optional().nullable(),
  costUsd: z.number().min(0).optional(),
  tokenCount: z.number().int().min(0).optional(),
  modelProvider: z.string().max(80).optional().nullable(),
  modelId: z.string().max(160).optional().nullable(),
  artifactRefs: z.array(z.string().min(1).max(240)).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export async function GET(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const { searchParams } = new URL(request.url);
    const organizationId = searchParams.get("organizationId");
    const goalId = searchParams.get("goalId");
    const agentId = searchParams.get("agentId");
    const limit = Math.max(1, Math.min(100, Number(searchParams.get("limit") || 25)));
    const summary = summarizeHierarchyActivity({ organizationId, goalId, agentId, limit });
    return NextResponse.json({
      success: true,
      data: {
        ...summary,
        events: listHierarchyActivityEvents({ organizationId, goalId, agentId, limit }),
      },
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const parsed = CreateActivitySchema.parse(await request.json());
    const event = recordHierarchyActivityEvent(parsed);
    return NextResponse.json({ success: true, data: event }, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
