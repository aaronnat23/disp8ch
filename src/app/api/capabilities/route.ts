import { NextResponse } from "next/server";
import { getCapabilityState } from "@/lib/capabilities/capability-state";

export const dynamic = "force-dynamic";

export async function GET() {
  const state = await getCapabilityState();
  return NextResponse.json(state);
}
