import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  createBoard,
  deleteBoard,
  listBoards,
  updateBoard,
} from "@/lib/boards/manager";
import { requireOperatorAccess } from "@/lib/security/admin";

export const dynamic = "force-dynamic";

const CreateBoardSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(600).optional().nullable(),
});

const UpdateBoardSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(600).optional().nullable(),
  isActive: z.boolean().optional(),
});

function mapErrorStatus(error: unknown): number {
  const message = String(error);
  if (message.includes("not found")) return 404;
  if (message.includes("required")) return 400;
  if (message.includes("UNIQUE")) return 409;
  return 500;
}

export async function GET(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const boards = listBoards();
    return NextResponse.json({ success: true, data: boards });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const body = await request.json();
    const parsed = CreateBoardSchema.parse(body);
    const board = createBoard(parsed);
    return NextResponse.json({ success: true, data: board }, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: String(error) }, { status: mapErrorStatus(error) });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const body = await request.json();
    const parsed = UpdateBoardSchema.parse(body);
    const { id, ...updates } = parsed;
    const board = updateBoard(id, updates);
    return NextResponse.json({ success: true, data: board });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: String(error) }, { status: mapErrorStatus(error) });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) {
      return NextResponse.json({ success: false, error: "Missing id" }, { status: 400 });
    }
    deleteBoard(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: mapErrorStatus(error) });
  }
}
