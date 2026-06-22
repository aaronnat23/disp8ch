import { NextRequest, NextResponse } from "next/server";
import { requireOperatorAccess } from "@/lib/security/admin";
import { listCommands, deleteCommand } from "@/lib/dynamic-workflows/commands";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;

  try {
    const commands = listCommands();
    return NextResponse.json({
      success: true,
      data: { total: commands.length, commands },
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function POST(_request: NextRequest) {
  const denied = await requireOperatorAccess(_request);
  if (denied) return denied;

  return NextResponse.json(
    { success: false, error: "Direct command creation not yet implemented" },
    { status: 501 },
  );
}

export async function DELETE(request: NextRequest) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;

  try {
    const body = await request.json() as { name?: string };
    const name = String(body.name ?? "").trim();

    if (!name) {
      return NextResponse.json({ success: false, error: "name is required" }, { status: 400 });
    }

    const deleted = deleteCommand(name);
    if (!deleted) {
      return NextResponse.json({ success: false, error: "Command not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true, data: { name, deleted: true } });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
