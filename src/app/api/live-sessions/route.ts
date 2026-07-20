import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireOperatorAccess } from "@/lib/security/admin";
import { addFixtureSegments, createLiveSession, listLiveSessions } from "@/lib/live-sessions/store";
import { ORIGINAL_PRODUCT_DISCUSSION_FIXTURE } from "@/lib/live-sessions/intelligence";

const CreateSchema = z.object({
  title: z.string().max(200).optional(),
  language: z.string().max(20).nullable().optional(),
  source: z.enum(["microphone", "fixture", "text"]).optional(),
  consentConfirmed: z.literal(true),
  workTrailId: z.string().max(200).nullable().optional(),
  useDemoFixture: z.boolean().optional(),
});

export async function GET(request: NextRequest) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;
  const rawLimit = Number(request.nextUrl.searchParams.get("limit") || 30);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 100) : 30;
  return NextResponse.json({ success: true, data: listLiveSessions(limit) });
}

export async function POST(request: NextRequest) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;
  try {
    const input = CreateSchema.parse(await request.json());
    const session = createLiveSession({ ...input, source: input.useDemoFixture ? "fixture" : input.source });
    const data = input.useDemoFixture ? addFixtureSegments(session.id, ORIGINAL_PRODUCT_DISCUSSION_FIXTURE) : session;
    return NextResponse.json({ success: true, data }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof z.ZodError ? error.flatten() : String(error) }, { status: 400 });
  }
}
