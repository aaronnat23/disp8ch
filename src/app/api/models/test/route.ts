import { NextRequest, NextResponse } from "next/server";
import { PROVIDERS } from "@/types/model";
import { callModel } from "@/lib/agents/multi-provider";
import { normalizeProviderBaseUrl } from "@/lib/agents/provider-base-url";
import { normalizeProviderId } from "@/lib/agents/provider-normalization";
import {
  providerRequiresApiKey,
  resolveProviderModelSelection,
} from "@/lib/agents/provider-plugins";
import { checkModelToolSupport, getToolCapableRecommendations } from "@/lib/agents/model-capabilities";
import { requireOperatorAccess } from "@/lib/security/admin";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;

    const body = await request.json();
    const providerRaw = String(body.provider || "anthropic");
    const provider = normalizeProviderId(providerRaw);
    if (!provider) {
      return NextResponse.json({ success: false, error: `Unknown provider: ${providerRaw}` }, { status: 400 });
    }

    const providerInfo = PROVIDERS.find((entry) => entry.id === provider);
    if (!providerInfo) {
      return NextResponse.json({ success: false, error: `Provider metadata not found: ${provider}` }, { status: 400 });
    }

    const providerId = providerInfo.id;
    const warnings: string[] = [];
    const apiKey = String(body.apiKey || "").trim();
    const normalizedInputBaseUrl = normalizeProviderBaseUrl(providerId, body.baseUrl as string | undefined);
    const normalizedDefaultBaseUrl = normalizeProviderBaseUrl(providerId, providerInfo.baseUrl);
    const baseUrl = normalizedInputBaseUrl ?? normalizedDefaultBaseUrl ?? null;

    if (providerRequiresApiKey(providerId) && !apiKey) {
      return NextResponse.json(
        { success: false, error: `API key required for ${providerId}` },
        { status: 400 },
      );
    }

    const selection = await resolveProviderModelSelection({
      provider: providerId,
      requestedModelId: body.modelId as string | undefined,
      requestedName: body.name as string | undefined,
      baseUrl,
      apiKey,
    });
    const modelId = selection.modelId || providerInfo.defaultModel;
    const name = selection.name || providerInfo.defaultName;
    warnings.push(...selection.warnings);

    const toolSupport = checkModelToolSupport(providerId, modelId);
    if (toolSupport.status === "unsupported") {
      const recommendations = getToolCapableRecommendations(providerId).map((entry) => entry.id);
      const suffix = recommendations.length > 0 ? ` Try one of: ${recommendations.join(", ")}` : "";
      return NextResponse.json(
        { success: false, error: `${toolSupport.reason}${suffix}` },
        { status: 400 },
      );
    }
    if (toolSupport.status === "unknown") {
      warnings.push(toolSupport.reason);
    }

    const startedAt = Date.now();
    const result = await callModel({
      provider: providerId,
      modelId,
      apiKey,
      baseUrl: baseUrl ?? undefined,
      systemPrompt: "You are a connectivity probe. Reply with only READY.",
      userMessage: "Reply with only READY.",
      maxTokens: 120,
    });
    const latencyMs = Date.now() - startedAt;
    const responseText = result.response.trim();
    const matched = /^ready\b/i.test(responseText);

    return NextResponse.json({
      success: matched,
      data: {
        provider: providerId,
        modelId,
        name,
        baseUrl,
        latencyMs,
        response: responseText,
        tokensUsed: result.tokensUsed,
      },
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(matched ? {} : { error: `Unexpected validation reply: ${JSON.stringify(responseText.slice(0, 80))}` }),
    }, { status: matched ? 200 : 400 });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
