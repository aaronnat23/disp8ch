import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { runCouncilSession } from "@/lib/council/service";
import { requireOperatorAccess } from "@/lib/security/admin";

export const dynamic = "force-dynamic";

const CouncilRequestSchema = z.object({
  topic: z.string().min(3).max(4000),
  agentIds: z.array(z.string().min(1)).min(2).max(12),
  documentIds: z.array(z.string().min(1)).max(6).optional(),
  options: z.array(z.string().min(1).max(280)).min(2).max(8).optional(),
  decisionMode: z.enum(["majority", "consensus", "weighted", "ranked"]).optional(),
  mode: z.enum(["poll", "debate"]).optional(),
  rounds: z.number().int().min(2).max(5).optional(),
  synthesizerAgentId: z.string().min(1).optional(),
  discoverOptions: z.boolean().optional(),
  costCapUsd: z.number().positive().max(100).optional(),
});

export async function POST(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const body = await request.json();
    const parsed = CouncilRequestSchema.parse(body);
    const result = await runCouncilSession(parsed);
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
