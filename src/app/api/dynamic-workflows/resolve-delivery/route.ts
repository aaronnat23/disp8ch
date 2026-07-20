import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireOperatorAccess } from "@/lib/security/admin";
import { resolveSupervisedDelivery } from "@/lib/dynamic-workflows/delivery-policy";

export const dynamic = "force-dynamic";

const RoleBindingSchema = z.object({
  agentId: z.string().min(1).optional(),
  modelRef: z.string().min(1).optional(),
  toolsets: z.array(z.string().min(1)).optional(),
});

const ResolveSchema = z.object({
  organizationId: z.string().min(1).nullable().optional(),
  selectedAgentId: z.string().min(1).nullable().optional(),
  overrides: z.object({
    planner: RoleBindingSchema.optional(),
    implementer: RoleBindingSchema.optional(),
    reviewer: RoleBindingSchema.optional(),
  }).optional(),
  maxRepairPasses: z.number().int().min(0).max(2).optional(),
});

export async function POST(request: NextRequest) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;
  try {
    const input = ResolveSchema.parse(await request.json());
    return NextResponse.json({ success: true, data: resolveSupervisedDelivery(input) });
  } catch (error) {
    const detail = error instanceof z.ZodError ? error.flatten() : String(error);
    return NextResponse.json({ success: false, error: detail }, { status: 400 });
  }
}
