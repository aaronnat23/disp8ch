import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireOperatorAccess } from "@/lib/security/admin";
import {
  getDeliveryPolicy,
  listDeliveryModelOptions,
  resolveSupervisedDelivery,
  saveDeliveryPolicy,
} from "@/lib/dynamic-workflows/delivery-policy";

export const dynamic = "force-dynamic";

const PolicySchema = z.object({
  mode: z.enum(["agent_defaults", "balanced", "quality", "fast", "local", "custom"]),
  plannerModelRef: z.string().min(1).nullable().optional(),
  implementerModelRef: z.string().min(1).nullable().optional(),
  reviewerModelRef: z.string().min(1).nullable().optional(),
});

export async function GET(request: NextRequest) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;
  try {
    let resolution = null;
    let resolutionError: string | null = null;
    try {
      resolution = resolveSupervisedDelivery();
    } catch (error) {
      resolutionError = String(error);
    }
    return NextResponse.json({
      success: true,
      data: {
        policy: getDeliveryPolicy(),
        models: listDeliveryModelOptions(),
        resolution,
        resolutionError,
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
    const input = PolicySchema.parse(await request.json());
    const policy = saveDeliveryPolicy(input);
    let resolution = null;
    let resolutionError: string | null = null;
    try {
      resolution = resolveSupervisedDelivery();
    } catch (error) {
      resolutionError = String(error);
    }
    return NextResponse.json({
      success: true,
      data: {
        policy,
        models: listDeliveryModelOptions(),
        resolution,
        resolutionError,
      },
    });
  } catch (error) {
    const detail = error instanceof z.ZodError ? error.flatten() : String(error);
    return NextResponse.json({ success: false, error: detail }, { status: 400 });
  }
}
