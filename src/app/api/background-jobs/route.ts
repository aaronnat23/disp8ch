import { NextRequest, NextResponse } from "next/server";
import { requireOperatorAccess } from "@/lib/security/admin";
import {
  getAsyncDelegationCapacitySnapshot,
  getBackgroundJob,
  listBackgroundJobs,
  terminateBackgroundJob,
} from "@/lib/runtime/background-jobs";

export const dynamic = "force-dynamic";

function publicJob(job: ReturnType<typeof getBackgroundJob>) {
  if (!job) return null;
  const isCoding = job.toolName === "sessions_spawn" || job.metadata?.kind === "coding-agent-delegation";
  return {
    id: job.id,
    toolName: job.toolName,
    category: isCoding ? "coding-agent" : "shell",
    label: job.commandPreview,
    backend: (job.metadata?.backend as string) || (job.metadata?.model as string) || job.toolName,
    status: job.status,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    sessionId: job.sessionId,
    agentId: job.agentId,
    exitCode: job.exitCode,
    timeoutMs: (job.metadata?.timeoutMs as number) ?? null,
    // Result preview only; full output stays out of the overview surface.
    resultPreview: (job.status !== "running" ? job.stdout || job.stderr : "").slice(0, 400),
  };
}

export async function GET(request: NextRequest) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (id) {
      const job = getBackgroundJob(id);
      if (!job) return NextResponse.json({ success: false, error: "Not found" }, { status: 404 });
      return NextResponse.json({ success: true, data: publicJob(job) });
    }
    const limit = Number(searchParams.get("limit")) || 30;
    const jobs = listBackgroundJobs({ limit }).map(publicJob);
    return NextResponse.json({
      success: true,
      data: { jobs, capacity: getAsyncDelegationCapacitySnapshot() },
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) return NextResponse.json({ success: false, error: "Missing id" }, { status: 400 });
    const terminated = terminateBackgroundJob(id);
    return NextResponse.json({ success: true, data: { cancelled: Boolean(terminated), job: publicJob(terminated) } });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
