import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireOperatorAccess } from "@/lib/security/admin";
import { analyzeLiveSession } from "@/lib/live-sessions/intelligence";

const Schema = z.object({ question: z.string().max(2000).nullable().optional() });

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;
  try {
    const { id } = await params;
    const input = Schema.parse(await request.json());
    return NextResponse.json({ success: true, data: await analyzeLiveSession(id, input.question) });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof z.ZodError ? error.flatten() : String(error) }, { status: 400 });
  }
}
