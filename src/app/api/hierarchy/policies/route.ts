import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  evaluateHierarchyBudget,
  listHierarchyApprovalPolicies,
  listHierarchyBudgetPolicies,
  upsertHierarchyApprovalPolicy,
  upsertHierarchyBudgetPolicy,
} from "@/lib/hierarchy/policies";
import { requireOperatorAccess } from "@/lib/security/admin";

export const dynamic = "force-dynamic";

const ScopeSchema = z.enum(["organization", "goal", "agent"]);

const BudgetPolicySchema = z.object({
  action: z.literal("upsert-budget"),
  id: z.string().min(1).max(120).optional(),
  organizationId: z.string().min(1).max(120).optional().nullable(),
  goalId: z.string().min(1).max(120).optional().nullable(),
  agentId: z.string().min(1).max(120).optional().nullable(),
  scope: ScopeSchema,
  softLimitUsd: z.number().min(0).optional().nullable(),
  hardLimitUsd: z.number().min(0).optional().nullable(),
  requireApprovalAboveUsd: z.number().min(0).optional().nullable(),
  period: z.enum(["daily", "weekly", "monthly", "total"]).optional(),
  isActive: z.boolean().optional(),
});

const ApprovalPolicySchema = z.object({
  action: z.literal("upsert-approval"),
  id: z.string().min(1).max(120).optional(),
  organizationId: z.string().min(1).max(120).optional().nullable(),
  scope: ScopeSchema,
  actionPattern: z.string().min(1).max(240),
  approverAgentId: z.string().min(1).max(120).optional().nullable(),
  requireHuman: z.boolean().optional(),
  minRisk: z.enum(["low", "medium", "high"]).optional(),
  isActive: z.boolean().optional(),
});

const EvaluateBudgetSchema = z.object({
  action: z.literal("evaluate-budget"),
  organizationId: z.string().min(1).max(120).optional().nullable(),
  goalId: z.string().min(1).max(120).optional().nullable(),
  agentId: z.string().min(1).max(120).optional().nullable(),
  estimatedCostUsd: z.number().min(0).optional(),
  currentSpendUsd: z.number().min(0).optional(),
});

const PolicyMutationSchema = z.discriminatedUnion("action", [
  BudgetPolicySchema,
  ApprovalPolicySchema,
  EvaluateBudgetSchema,
]);

export async function GET(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const { searchParams } = new URL(request.url);
    const organizationId = searchParams.get("organizationId");
    const goalId = searchParams.get("goalId");
    const agentId = searchParams.get("agentId");
    const scope = searchParams.get("scope") as "organization" | "goal" | "agent" | null;
    return NextResponse.json({
      success: true,
      data: {
        budgets: listHierarchyBudgetPolicies({ organizationId, goalId, agentId, scope: scope ?? undefined }),
        approvals: listHierarchyApprovalPolicies({ organizationId, scope: scope ?? undefined }),
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
    const parsed = PolicyMutationSchema.parse(await request.json());
    if (parsed.action === "upsert-budget") {
      const policy = upsertHierarchyBudgetPolicy(parsed);
      return NextResponse.json({ success: true, data: policy });
    }
    if (parsed.action === "upsert-approval") {
      const policy = upsertHierarchyApprovalPolicy(parsed);
      return NextResponse.json({ success: true, data: policy });
    }
    const evaluation = evaluateHierarchyBudget(parsed);
    return NextResponse.json({ success: true, data: evaluation });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
