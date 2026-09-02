import { NextRequest, NextResponse } from "next/server";
import { requireOperatorAccess } from "@/lib/security/admin";
import { getPopulatedRun, deleteRun } from "@/lib/dynamic-workflows/store";
import {
  executeRun,
  pauseRun,
  resumeRun,
  cancelRun,
} from "@/lib/dynamic-workflows/runner";
import { saveRunAsCommand } from "@/lib/dynamic-workflows/commands";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;

  try {
    const { id } = await params;
    const run = getPopulatedRun(id);
    if (!run) {
      return NextResponse.json({ success: false, error: "Run not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true, data: run });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;

  try {
    const { id } = await params;
    const body = await request.json() as {
      action?: string;
      commandName?: string;
    };

    const action = String(body.action ?? "").trim();

    if (action === "start") {
      await executeRun(id);
      const run = getPopulatedRun(id);
      return NextResponse.json({ success: true, data: run });
    }

    if (action === "pause") {
      pauseRun(id);
      const run = getPopulatedRun(id);
      return NextResponse.json({ success: true, data: run });
    }

    if (action === "resume") {
      await resumeRun(id);
      const run = getPopulatedRun(id);
      return NextResponse.json({ success: true, data: run });
    }

    if (action === "cancel") {
      cancelRun(id);
      const run = getPopulatedRun(id);
      return NextResponse.json({ success: true, data: run });
    }

    if (action === "save_command") {
      if (!body.commandName?.trim()) {
        return NextResponse.json({ success: false, error: "commandName is required" }, { status: 400 });
      }

      const command = saveRunAsCommand(id, body.commandName);
      return NextResponse.json({ success: true, data: command });
    }

    return NextResponse.json({ success: false, error: `Unknown action: ${action || "(empty)"}` }, { status: 400 });
  } catch (error) {
    const message = String(error);
    if (message.includes("not found")) {
      return NextResponse.json({ success: false, error: message }, { status: 404 });
    }
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;

  try {
    const { id } = await params;
    const run = getPopulatedRun(id);
    if (!run) {
      return NextResponse.json({ success: false, error: "Run not found" }, { status: 404 });
    }

    deleteRun(id);

    return NextResponse.json({ success: true, data: { id, deleted: true } });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
