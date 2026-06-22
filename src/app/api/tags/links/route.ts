import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  listTagMapForTargets,
  listTagsForTarget,
  setTagsForTarget,
  type TagTargetType,
} from "@/lib/tags/manager";
import { requireOperatorAccess } from "@/lib/security/admin";

export const dynamic = "force-dynamic";

const TargetTypeSchema = z.enum(["workflow", "agent", "task"]);

const SetLinksSchema = z.object({
  targetType: TargetTypeSchema,
  targetId: z.string().min(1),
  tagIds: z.array(z.string().min(1)).max(50),
});

export async function GET(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const { searchParams } = new URL(request.url);
    const targetType = searchParams.get("targetType");
    if (!targetType) {
      return NextResponse.json({ success: false, error: "Missing targetType" }, { status: 400 });
    }

    const parsedType = TargetTypeSchema.parse(targetType) as TagTargetType;
    const targetId = searchParams.get("targetId");
    const targetIdsCsv = searchParams.get("targetIds");

    if (targetId) {
      const tags = listTagsForTarget(parsedType, targetId);
      return NextResponse.json({ success: true, data: { targetId, tags } });
    }

    if (targetIdsCsv) {
      const targetIds = targetIdsCsv
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      const map = listTagMapForTargets(parsedType, targetIds);
      return NextResponse.json({ success: true, data: map });
    }

    return NextResponse.json({ success: false, error: "Missing targetId or targetIds" }, { status: 400 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const body = await request.json();
    const parsed = SetLinksSchema.parse(body);
    const tags = setTagsForTarget(parsed.targetType as TagTargetType, parsed.targetId, parsed.tagIds);
    return NextResponse.json({ success: true, data: tags });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
