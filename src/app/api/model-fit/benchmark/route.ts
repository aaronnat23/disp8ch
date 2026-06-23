import { NextResponse } from "next/server";
import { requireOperatorAccess } from "@/lib/security/admin";
import { getBenchmarkJob, startBenchmark } from "@/lib/model-fit/benchmark";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ success: false, error: "Benchmark id is required" }, { status: 400 });
  const job = getBenchmarkJob(id);
  return job
    ? NextResponse.json({ success: true, data: job })
    : NextResponse.json({ success: false, error: "Benchmark not found" }, { status: 404 });
}

export async function POST(request: Request) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;
  try {
    const body = await request.json() as { candidateId?: string; contextTokens?: number; confirmed?: boolean };
    const job = startBenchmark({
      candidateId: String(body.candidateId || ""),
      contextTokens: Number(body.contextTokens) || 8192,
      confirmed: body.confirmed === true,
    });
    return NextResponse.json({ success: true, data: job }, { status: 202 });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 400 });
  }
}
