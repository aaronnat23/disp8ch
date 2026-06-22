import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  dismissLearningCandidate,
  formatLearningStatusMarkdown,
  getLearningConfig,
  listLearningCandidates,
  listLearningEvents,
  promoteLearningCandidate,
} from "@/lib/learning/loop";
import { importExternalSkillLibraryRepo, importWorkspaceSkillLibraryRepo } from "@/lib/learning/importers";
import { requireOperatorAccess } from "@/lib/security/admin";
import {
  applySelfImprovementProposal,
  listSelfImprovementProposals,
  updateSelfImprovementProposalStatus,
} from "@/lib/channels/self-improvement-proposals";

export const dynamic = "force-dynamic";

const PostSchema = z.object({
  action: z.string().min(1),
  candidateId: z.string().optional(),
  proposalId: z.string().optional(),
  repoPath: z.string().optional(),
});

export async function GET(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const { searchParams } = new URL(request.url);
    const action = String(searchParams.get("action") || "status").trim().toLowerCase();

    if (action === "events") {
      const limit = Math.max(1, Math.min(200, Number(searchParams.get("limit")) || 50));
      return NextResponse.json({ success: true, data: listLearningEvents(limit) });
    }

    if (action === "candidates") {
      const status = String(searchParams.get("status") || "all").trim().toLowerCase() as
        | "all"
        | "proposed"
        | "promoted"
        | "dismissed";
      return NextResponse.json({ success: true, data: listLearningCandidates(status) });
    }

    if (action === "self-improvement-proposals" || action === "proposals") {
      const status = String(searchParams.get("status") || "all").trim().toLowerCase();
      const proposals = listSelfImprovementProposals().filter((proposal) =>
        status === "all" ? true : proposal.status === status,
      );
      return NextResponse.json({ success: true, data: proposals });
    }

    if (action === "quality-report") {
      const config = getLearningConfig();
      const all = listLearningCandidates("all");
      const promoted = all.filter((c) => c.status === "promoted").length;
      const dismissed = all.filter((c) => c.status === "dismissed").length;
      const proposed = all.filter((c) => c.status === "proposed").length;
      const now = Date.now();
      const staleCandidates = all.filter((c) => {
        if (c.status !== "proposed") return false;
        const ageMs = now - new Date(c.createdAt).getTime();
        return ageMs > 7 * 24 * 60 * 60 * 1000;
      }).map((c) => ({
        id: c.id,
        title: (c.title ?? c.id).slice(0, 60),
        createdAt: c.createdAt,
        daysSinceCreated: Math.floor((now - new Date(c.createdAt).getTime()) / (24 * 60 * 60 * 1000)),
      }));
      const recentEvents = listLearningEvents(200);
      const guardBlockCount = recentEvents.filter((e) =>
        (e.summary ?? "").includes("guard") || (e.summary ?? "").includes("blocked"),
      ).length;
      return NextResponse.json({
        success: true,
        data: {
          promotedCount: promoted,
          dismissedCount: dismissed,
          proposedCount: proposed,
          totalReviewed: promoted + dismissed,
          promotedToDismissedRatio: dismissed > 0 ? +(promoted / dismissed).toFixed(1) : null,
          staleCandidates,
          staleCandidateCount: staleCandidates.length,
          guardBlockCount,
          feedbackEnabled: Boolean(config.showFeedback),
          capturePreferences: Boolean(config.capturePreferences),
          capturePlaybooks: Boolean(config.capturePlaybooks),
          learningMode: config.mode,
          llmReviewEnabled: Boolean(config.llmReviewEnabled),
        },
      });
    }

    return NextResponse.json({
      success: true,
      data: {
        config: getLearningConfig(),
        summary: formatLearningStatusMarkdown(),
        candidates: listLearningCandidates("all"),
      },
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const body = PostSchema.parse(await request.json());
    const action = body.action.trim().toLowerCase();

    if (action === "promote") {
      if (!body.candidateId) {
        return NextResponse.json({ success: false, error: "candidateId is required" }, { status: 400 });
      }
      const promoted = await promoteLearningCandidate(body.candidateId);
      try {
        const fs = await import("node:fs");
        const path = await import("node:path");
        const memoryDir = path.join(process.cwd(), "data", "workspace", "memory", "learned");
        fs.mkdirSync(memoryDir, { recursive: true });
        const candidateContent = typeof promoted.content === "string" ? promoted.content :
          typeof (promoted as Record<string, unknown>).text === "string" ? String((promoted as Record<string, unknown>).text) :
          promoted.summary || "";
        if (candidateContent) {
          const fileName = `learned-${Date.now()}.md`;
          const filePath = path.join(memoryDir, fileName);
          const entry = `# Learned: ${promoted.kind || "fact"}\n\n${candidateContent}\n\n_auto-promoted ${new Date().toISOString()}_`;
          fs.writeFileSync(filePath, entry, "utf-8");
        }
      } catch { /* best-effort — promotion itself still succeeded */ }
      return NextResponse.json({ success: true, data: promoted });
    }

    if (action === "dismiss") {
      if (!body.candidateId) {
        return NextResponse.json({ success: false, error: "candidateId is required" }, { status: 400 });
      }
      return NextResponse.json({ success: true, data: dismissLearningCandidate(body.candidateId) });
    }

    if (action === "approve-proposal" || action === "reject-proposal" || action === "apply-proposal") {
      if (!body.proposalId) {
        return NextResponse.json({ success: false, error: "proposalId is required" }, { status: 400 });
      }
      if (action === "approve-proposal") {
        return NextResponse.json({
          success: true,
          data: updateSelfImprovementProposalStatus(body.proposalId, "approved"),
        });
      }
      if (action === "reject-proposal") {
        return NextResponse.json({
          success: true,
          data: updateSelfImprovementProposalStatus(body.proposalId, "rejected"),
        });
      }
      return NextResponse.json({
        success: true,
        data: applySelfImprovementProposal(body.proposalId),
      });
    }

    if (action === "import-external-skill-library") {
      if (!body.repoPath) {
        return NextResponse.json({ success: false, error: "repoPath is required" }, { status: 400 });
      }
      return NextResponse.json({ success: true, data: importExternalSkillLibraryRepo(body.repoPath) }, { status: 201 });
    }

    if (action === "import-workspace-skill-library") {
      if (!body.repoPath) {
        return NextResponse.json({ success: false, error: "repoPath is required" }, { status: 400 });
      }
      return NextResponse.json({ success: true, data: importWorkspaceSkillLibraryRepo(body.repoPath) }, { status: 201 });
    }

    return NextResponse.json({ success: false, error: "Unknown action" }, { status: 400 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
