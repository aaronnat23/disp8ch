import { NextRequest, NextResponse } from "next/server";
import { requireOperatorAccess } from "@/lib/security/admin";
import { resolveMemoryScope } from "@/lib/memory/scope-resolver";
import {
  applyMemoryCandidate,
  approveMemoryCandidate,
  classifyCandidate,
  createMemoryCandidate,
  getMemoryCandidate,
  listMemoryCandidates,
  rejectMemoryCandidate,
  type CandidateOrigin,
  type CandidateResolution,
  type CandidateScopeKind,
  type CandidateStatus,
} from "@/lib/memory/candidates";
import { MemoryBatchValidationError } from "@/lib/memory/atomic-operations";

const VALID_ORIGINS = new Set<CandidateOrigin>(["webchat", "workflow", "board", "council", "notebook"]);
const VALID_RESOLUTIONS = new Set<CandidateResolution>(["keep_both", "replace_existing", "mark_superseded", "reject", "reinforce_existing"]);

export async function GET(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const sp = request.nextUrl.searchParams;
    const id = sp.get("id");
    if (id) {
      const candidate = getMemoryCandidate(id);
      if (!candidate) return NextResponse.json({ success: false, error: "candidate not found" }, { status: 404 });
      return NextResponse.json({ success: true, data: candidate });
    }
    const scope = resolveMemoryScope(sp.get("agentId"));
    const status = sp.get("status") as CandidateStatus | null;
    const data = listMemoryCandidates({
      agentId: sp.get("allAgents") === "1" ? undefined : scope.memoryAgentId,
      status: status ?? undefined,
      limit: Number(sp.get("limit")) || 100,
    });
    return NextResponse.json({ success: true, data });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const body = (await request.json()) as Record<string, unknown>;
    const action = String(body.action || "create");

    if (action === "create") {
      // Operator-authored / source-surface candidate. Scope id is authoritative
      // here only because the operator explicitly composes it; model tool
      // arguments never reach this route.
      const originType = String(body.originType || "") as CandidateOrigin;
      if (!VALID_ORIGINS.has(originType)) {
        return NextResponse.json({ success: false, error: "invalid originType" }, { status: 400 });
      }
      const scope = resolveMemoryScope(typeof body.agentId === "string" ? body.agentId : null);
      const scopeKind: CandidateScopeKind = body.scopeKind === "workflow" ? "workflow" : "agent";
      const result = createMemoryCandidate({
        agentId: scope.memoryAgentId,
        content: String(body.content || ""),
        type: typeof body.type === "string" ? body.type : undefined,
        tags: body.tags,
        confidence: typeof body.confidence === "number" ? body.confidence : undefined,
        whenToUse: typeof body.whenToUse === "string" ? body.whenToUse : null,
        happenedAt: typeof body.happenedAt === "string" ? body.happenedAt : null,
        scopeKind,
        scopeId: scopeKind === "workflow" && typeof body.scopeId === "string" ? body.scopeId : null,
        originType,
        originId: typeof body.originId === "string" ? body.originId : null,
        sessionId: typeof body.sessionId === "string" ? body.sessionId : null,
        documentId: typeof body.documentId === "string" ? body.documentId : null,
        evidence: Array.isArray(body.evidence) ? body.evidence.map(String) : [],
        sourceSummary: typeof body.sourceSummary === "string" ? body.sourceSummary : null,
        reviewAfter: typeof body.reviewAfter === "string" ? body.reviewAfter : null,
        expiresAt: typeof body.expiresAt === "string" ? body.expiresAt : null,
      });
      return NextResponse.json({ success: true, data: result.candidate, created: result.created });
    }

    const id = String(body.id || "").trim();
    if (!id) return NextResponse.json({ success: false, error: "id is required" }, { status: 400 });

    if (action === "approve") {
      return NextResponse.json({ success: true, data: approveMemoryCandidate(id) });
    }
    if (action === "reject") {
      return NextResponse.json({ success: true, data: rejectMemoryCandidate(id, typeof body.note === "string" ? body.note : undefined) });
    }
    if (action === "reclassify") {
      const c = getMemoryCandidate(id);
      if (!c) return NextResponse.json({ success: false, error: "candidate not found" }, { status: 404 });
      classifyCandidate(c);
      return NextResponse.json({ success: true, data: getMemoryCandidate(id) });
    }
    if (action === "apply") {
      const resolution = VALID_RESOLUTIONS.has(body.resolution as CandidateResolution) ? (body.resolution as CandidateResolution) : undefined;
      const result = await applyMemoryCandidate(id, {
        resolution,
        targetMemoryId: typeof body.targetMemoryId === "string" ? body.targetMemoryId : null,
      });
      return NextResponse.json({ success: true, data: result.candidate, appliedEntryId: result.appliedEntryId, reinforced: result.reinforced });
    }

    return NextResponse.json({ success: false, error: `unknown action: ${action}` }, { status: 400 });
  } catch (error) {
    const status = error instanceof MemoryBatchValidationError ? 400 : 500;
    return NextResponse.json({ success: false, error: String(error instanceof Error ? error.message : error) }, { status });
  }
}
