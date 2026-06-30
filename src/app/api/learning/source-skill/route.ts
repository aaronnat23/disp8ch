import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireOperatorAccess } from "@/lib/security/admin";
import { getModelConfig } from "@/lib/agents/model-router";
import { compileSourceSkill } from "@/lib/learning/source-skill-compiler";
import {
  applySelfImprovementProposal,
  getSelfImprovementProposal,
  listSelfImprovementProposals,
} from "@/lib/channels/self-improvement-proposals";

export const dynamic = "force-dynamic";

const CompileSchema = z.object({
  action: z.literal("compile"),
  sourcePackId: z.string().min(1).max(120),
  instruction: z.string().max(2000).optional(),
  sessionId: z.string().max(120).optional(),
});

const InstallSchema = z.object({
  action: z.literal("install"),
  proposalId: z.string().min(1).max(120),
});

const LOCAL_PROVIDERS = new Set(["ollama", "vllm", "sglang", "lmstudio"]);

export async function GET(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    // Learned-skill candidates are skill-kind self-improvement proposals carrying a sourcePackId.
    const candidates = listSelfImprovementProposals().filter(
      (p) => p.kind === "skill" && Boolean(p.sourcePackId),
    );
    return NextResponse.json({ success: true, data: candidates });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const body = await request.json();

    if (body?.action === "install") {
      const parsed = InstallSchema.parse(body);
      const proposal = getSelfImprovementProposal(parsed.proposalId);
      if (!proposal) {
        return NextResponse.json({ success: false, error: "candidate not found" }, { status: 404 });
      }
      // Explicit, user-approved install — reuses the existing skill install path with provenance.
      const applied = applySelfImprovementProposal(parsed.proposalId);
      return NextResponse.json({ success: true, data: applied });
    }

    const parsed = CompileSchema.parse(body);
    const modelConfig = getModelConfig();
    if (!modelConfig.apiKey && !LOCAL_PROVIDERS.has(modelConfig.provider)) {
      return NextResponse.json(
        { success: false, error: "No LLM configured. Add a model in Settings → Models first." },
        { status: 400 },
      );
    }

    const result = await compileSourceSkill({
      sourcePackId: parsed.sourcePackId,
      instruction: parsed.instruction,
      sessionId: parsed.sessionId,
      provider: modelConfig.provider,
      modelId: modelConfig.modelId,
      apiKey: modelConfig.apiKey,
      baseUrl: modelConfig.baseUrl ?? undefined,
    });

    return NextResponse.json({
      success: true,
      data: {
        candidateId: result.proposal?.id ?? null,
        compileRunId: result.compileRunId,
        verification: result.verification,
        compiled: {
          skill_name: result.compiled.skill_name,
          title: result.compiled.title,
          description: result.compiled.description,
          uncertainties: result.compiled.uncertainties ?? [],
          blocked_claims: result.compiled.blocked_claims ?? [],
        },
        installed: false,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
