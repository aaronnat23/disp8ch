import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireOperatorAccess } from "@/lib/security/admin";
import { getModelConfig } from "@/lib/agents/model-router";
import { runBackgroundSkillReview } from "@/lib/agents/skill-review";
import { resolveChannelSessionAgentId } from "@/lib/channels/session-settings";

const Schema = z.object({ sessionId: z.string().min(1).max(240), agentId: z.string().max(120).optional().nullable() });
const LOCAL_PROVIDERS = new Set(["ollama", "vllm", "sglang", "lmstudio"]);

export async function POST(request: NextRequest) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;
  try {
    const parsed = Schema.parse(await request.json());
    const sessionAgentId = resolveChannelSessionAgentId(parsed.sessionId);
    if (sessionAgentId && parsed.agentId && parsed.agentId !== sessionAgentId) {
      return NextResponse.json({ success: false, error: "The conversation is locked to a different agent." }, { status: 409 });
    }
    const agentId = sessionAgentId || parsed.agentId || null;
    const model = getModelConfig({ agentId: agentId || undefined, sessionId: parsed.sessionId });
    if (!model.apiKey && !LOCAL_PROVIDERS.has(model.provider)) return NextResponse.json({ success: false, error: "No usable model is configured." }, { status: 400 });
    const result = await runBackgroundSkillReview({ sessionId: parsed.sessionId, agentId, provider: model.provider, modelId: model.modelId, apiKey: model.apiKey, baseUrl: model.baseUrl ?? undefined, routeSource: "manual-learning-review", force: true });
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
