import { NextResponse } from "next/server";
import { requireOperatorAccess } from "@/lib/security/admin";
import { cancelBenchmark } from "@/lib/model-fit/benchmark";

export async function POST(request: Request) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;
  try {
    const body = await request.json() as { id?: string };
    const job = cancelBenchmark(String(body.id || ""));
    return job
      ? NextResponse.json({ success: true, data: job })
      : NextResponse.json({ success: false, error: "Benchmark not found" }, { status: 404 });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 400 });
  }
}
