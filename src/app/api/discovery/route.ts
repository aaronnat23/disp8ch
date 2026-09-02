import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getCapabilityState } from "@/lib/capabilities/capability-state";
import { rankCapabilitySuggestions } from "@/lib/discovery/capability-discovery";
import { listAgents } from "@/lib/agents/registry";
import { requireOperatorAccess } from "@/lib/security/admin";

export const dynamic = "force-dynamic";

const QuerySchema = z.object({
  pathname: z.string().max(300).default("/"),
  intent: z.string().max(2000).optional(),
  limit: z.coerce.number().int().min(1).max(10).default(5),
});

export async function GET(request: NextRequest) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;
  try {
    const parsed = QuerySchema.parse(Object.fromEntries(new URL(request.url).searchParams.entries()));
    const [capabilities, agents] = await Promise.all([
      getCapabilityState(),
      Promise.resolve(listAgents()),
    ]);
    return NextResponse.json({
      success: true,
      data: {
        suggestions: rankCapabilitySuggestions({
          pathname: parsed.pathname,
          intent: parsed.intent,
          capabilities,
          agentCount: agents.filter((agent) => agent.isActive !== false).length,
        }, parsed.limit),
        checkedAt: capabilities.checkedAt,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
