import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireOperatorAccess } from "@/lib/security/admin";
import { computerUseEnabled, getComputerUseAdapter } from "@/lib/computer-use/adapter";
import { listSessionRecords } from "@/lib/computer-use/session-store";

export const dynamic = "force-dynamic";

const StartSchema = z.object({
  label: z.string().max(160).optional(),
  agentId: z.string().max(120).optional().nullable(),
});

export async function GET(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    return NextResponse.json({ success: true, data: listSessionRecords(50) });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    if (!computerUseEnabled()) {
      return NextResponse.json(
        { success: false, error: "Computer use is disabled. Enable it in Settings → Computer Use (beta)." },
        { status: 403 },
      );
    }
    const adapter = getComputerUseAdapter();
    const install = await adapter.isInstalled();
    if (!install.installed) {
      return NextResponse.json(
        { success: false, error: install.reason },
        { status: 400 },
      );
    }
    const parsed = StartSchema.parse(await request.json().catch(() => ({})));
    const session = await adapter.startSession({ label: parsed.label, agentId: parsed.agentId ?? null });
    return NextResponse.json({ success: true, data: session }, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
