import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireOperatorAccess } from "@/lib/security/admin";
import { getComputerUseAdapter } from "@/lib/computer-use/adapter";
import { getSessionRecord, listSessionActions, setSessionStatus } from "@/lib/computer-use/session-store";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const { id } = await params;
    const session = getSessionRecord(id);
    if (!session) return NextResponse.json({ success: false, error: "session not found" }, { status: 404 });
    return NextResponse.json({ success: true, data: { session, actions: listSessionActions(id) } });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

const PatchSchema = z.object({ action: z.enum(["pause", "resume", "stop"]) });

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const { id } = await params;
    const parsed = PatchSchema.parse(await request.json());
    if (parsed.action === "stop") {
      await getComputerUseAdapter().stopSession(id);
      return NextResponse.json({ success: true, data: getSessionRecord(id) });
    }
    const status = parsed.action === "pause" ? "paused" : "active";
    return NextResponse.json({ success: true, data: setSessionStatus(id, status) });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
