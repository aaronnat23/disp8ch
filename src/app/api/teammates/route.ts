import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ensureTeammateSession, listTeammates, markOperatorThreadRead } from "@/lib/agents/teammates";
import { requireOperatorAccess } from "@/lib/security/admin";

export const dynamic = "force-dynamic";

const ActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("open"), agentId: z.string().min(1).max(128) }),
  z.object({ action: z.literal("mark-read"), agentId: z.string().min(1).max(128) }),
]);

export async function GET(request: NextRequest) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;
  return NextResponse.json({ success: true, data: { teammates: listTeammates() } });
}

export async function POST(request: NextRequest) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;
  try {
    const parsed = ActionSchema.parse(await request.json());
    if (parsed.action === "mark-read") {
      return NextResponse.json({ success: true, data: { markedRead: markOperatorThreadRead(parsed.agentId) } });
    }
    return NextResponse.json({ success: true, data: { sessionId: ensureTeammateSession(parsed.agentId) } });
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    const status = String(error).includes("not found") ? 404 : 500;
    return NextResponse.json({ success: false, error: String(error) }, { status });
  }
}
