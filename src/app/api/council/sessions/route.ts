import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireOperatorAccess } from "@/lib/security/admin";
import {
  saveCouncilSession,
  listCouncilSessions,
  deleteCouncilSession,
} from "@/lib/council/persistence";

export const dynamic = "force-dynamic";

const PostSchema = z.object({
  action: z.string().min(1),
  id: z.string().optional(),
  orgId: z.string().nullable().optional(),
  topic: z.string().optional(),
  mode: z.string().optional(),
  votingMethod: z.string().optional(),
  participants: z.array(z.string()).optional(),
  options: z.array(z.string()).optional(),
  result: z.unknown().optional(),
  verdict: z.string().nullable().optional(),
  limit: z.number().min(1).max(200).optional(),
});

export async function GET(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const { searchParams } = new URL(request.url);
    const orgId = searchParams.get("orgId") || null;
    const limit = Math.max(1, Math.min(200, Number(searchParams.get("limit")) || 50));
    return NextResponse.json({ success: true, data: listCouncilSessions(orgId, limit) });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const body = PostSchema.parse(await request.json());
    const action = body.action.trim().toLowerCase();

    if (action === "save") {
      if (!body.id || !body.topic) {
        return NextResponse.json({ success: false, error: "id and topic are required" }, { status: 400 });
      }
      saveCouncilSession({
        id: body.id,
        orgId: body.orgId ?? null,
        topic: body.topic,
        mode: body.mode || "debate",
        votingMethod: body.votingMethod || "majority",
        participants: body.participants ?? [],
        options: body.options ?? [],
        result: body.result,
        verdict: body.verdict ?? null,
      });
      return NextResponse.json({ success: true });
    }

    if (action === "delete") {
      if (!body.id) {
        return NextResponse.json({ success: false, error: "id is required" }, { status: 400 });
      }
      return NextResponse.json({ success: true, data: deleteCouncilSession(body.id) });
    }

    return NextResponse.json({ success: false, error: "Unknown action" }, { status: 400 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
