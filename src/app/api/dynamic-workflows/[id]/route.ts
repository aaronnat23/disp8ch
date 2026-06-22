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
  { params }: { params: { id: string } },
) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;

  try {
    const run = getPopulatedRun(params.id);
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
  { params }: { params: { id: string } },
) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;

  try {
    const body = await request.json() as {
      action?: string;
      commandName?: string;
    };

    const action = String(body.action ?? "").trim();

    if (action === "start") {
      await executeRun(params.id);
      const run = getPopulatedRun(params.id);
      return NextResponse.json({ success: true, data: run });
    }

    if (action === "pause") {
      pauseRun(params.id);
      const run = getPopulatedRun(params.id);
      return NextResponse.json({ success: true, data: run });
    }

    if (action === "resume") {
      await resumeRun(params.id);
      const run = getPopulatedRun(params.id);
      return NextResponse.json({ success: true, data: run });
    }

    if (action === "cancel") {
      cancelRun(params.id);
      const run = getPopulatedRun(params.id);
      return NextResponse.json({ success: true, data: run });
    }

    if (action === "save_command") {
      if (!body.commandName?.trim()) {
        return NextResponse.json({ success: false, error: "commandName is required" }, { status: 400 });
      }

      const command = saveRunAsCommand(params.id, body.commandName);
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
  { params }: { params: { id: string } },
) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;

  try {
    const run = getPopulatedRun(params.id);
    if (!run) {
      return NextResponse.json({ success: false, error: "Run not found" }, { status: 404 });
    }

    deleteRun(params.id);

    return NextResponse.json({ success: true, data: { id: params.id, deleted: true } });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
