import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  createTag,
  deleteTag,
  listTags,
  updateTag,
  type TagScope,
} from "@/lib/tags/manager";
import { requireOperatorAccess } from "@/lib/security/admin";

export const dynamic = "force-dynamic";

const ScopeSchema = z.enum(["general", "workflow", "agent", "task", "template"]);

const CreateTagSchema = z.object({
  name: z.string().min(1).max(80),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  scope: ScopeSchema.optional(),
  sortOrder: z.number().int().optional(),
});

const UpdateTagSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(80).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  scope: ScopeSchema.optional(),
  sortOrder: z.number().int().optional(),
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
    const tags = listTags();
    return NextResponse.json({ success: true, data: tags });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const body = await request.json();
    const parsed = CreateTagSchema.parse(body);
    const tag = createTag({
      name: parsed.name,
      color: parsed.color,
      scope: parsed.scope as TagScope | undefined,
      sortOrder: parsed.sortOrder,
    });
    return NextResponse.json({ success: true, data: tag }, { status: 201 });
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
    const parsed = UpdateTagSchema.parse(body);
    const { id, ...updates } = parsed;
    const tag = updateTag(id, updates);
    return NextResponse.json({ success: true, data: tag });
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
    deleteTag(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: mapErrorStatus(error) });
  }
}
