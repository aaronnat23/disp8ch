import { NextRequest, NextResponse } from "next/server";
import { requireOperatorAccess } from "@/lib/security/admin";
import { computerUseEnabled, getComputerUseAdapter, getComputerUseCapability } from "@/lib/computer-use/adapter";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const adapter = getComputerUseAdapter();
    const install = await adapter.isInstalled();
    const capability = await getComputerUseCapability({ force: true });
    return NextResponse.json({
      success: true,
      data: {
        adapter: adapter.id,
        enabled: computerUseEnabled(),
        install,
        capability,
      },
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
