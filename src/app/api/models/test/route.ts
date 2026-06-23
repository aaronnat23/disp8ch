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
import { getSqlite, initializeDatabase } from "@/lib/db";
import { resolveModelApiKey } from "@/lib/agents/provider-auth";
import { createModelAdvisory } from "@/lib/model-fit/advisory";

export const dynamic = "force-dynamic";

async function probeEndpointMetadata(input: {
  provider: string;
  baseUrl: string | null;
  modelId: string;
  apiKey: string;
}): Promise<{
  exactModelListed: boolean | null;
  contextMax: number | null;
  capabilities: string[];
  modalities: string[];
  runtimeVersion: string | null;
}> {
  const empty: {
    exactModelListed: boolean | null;
    contextMax: number | null;
    capabilities: string[];
    modalities: string[];
    runtimeVersion: string | null;
  } = { exactModelListed: null, contextMax: null, capabilities: [], modalities: [], runtimeVersion: null };
  if (!input.baseUrl || !["ollama", "openai-compatible", "lmstudio", "vllm", "sglang"].includes(input.provider)) return empty;
  const headers: Record<string, string> = {};
  if (input.apiKey) headers.Authorization = `Bearer ${input.apiKey}`;
  try {
    const modelsResponse = await fetch(`${input.baseUrl.replace(/\/+$/, "")}/models`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    const json = await modelsResponse.json() as {
      data?: Array<Record<string, unknown> & { id?: string }>;
    };
    const listed = json.data?.find((entry) => entry.id === input.modelId);
    const evidence = {
      ...empty,
      exactModelListed: Boolean(listed),
      contextMax: Number(listed?.context_length || listed?.max_context_length || 0) || null,
      capabilities: Array.isArray(listed?.capabilities) ? listed.capabilities.map(String) : [],
      modalities: Array.isArray(listed?.modalities) ? listed.modalities.map(String) : [],
    };
    if (input.provider === "ollama") {
      const root = input.baseUrl.replace(/\/v1\/?$/i, "");
      const [versionResponse, showResponse] = await Promise.all([
        fetch(`${root}/api/version`, { signal: AbortSignal.timeout(5000) }),
        fetch(`${root}/api/show`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: input.modelId }),
          signal: AbortSignal.timeout(5000),
        }),
      ]);
      const version = await versionResponse.json() as { version?: string };
      const show = await showResponse.json() as {
        capabilities?: string[];
        model_info?: Record<string, unknown>;
      };
      const contextEntry = Object.entries(show.model_info || {}).find(([key]) => key.endsWith(".context_length"));
      evidence.runtimeVersion = version.version || null;
      evidence.contextMax = Number(contextEntry?.[1] || 0) || evidence.contextMax;
      evidence.capabilities = Array.isArray(show.capabilities) ? show.capabilities.map(String) : evidence.capabilities;
      evidence.modalities = evidence.capabilities.includes("vision") ? ["text", "image"] : ["text"];
    }
    return evidence;
  } catch {
    return empty;
  }
}

export async function POST(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;

    const body = await request.json();
    let storedRow: {
      id: string;
      provider: string;
      model_id: string;
      name: string;
      api_key: string;
      base_url: string | null;
    } | undefined;
    if (body.modelRowId) {
      initializeDatabase();
      storedRow = getSqlite().prepare(
        "SELECT id, provider, model_id, name, api_key, base_url FROM models WHERE id = ? LIMIT 1"
      ).get(String(body.modelRowId)) as typeof storedRow;
      if (!storedRow) {
        return NextResponse.json({ success: false, error: "Configured model not found" }, { status: 404 });
      }
    }
    const providerRaw = String(storedRow?.provider || body.provider || "anthropic");
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
    const storedApiKey = String(storedRow?.api_key || body.apiKey || "").trim();
    const apiKey = resolveModelApiKey({ provider: providerId, storedApiKey }).apiKey;
    const normalizedInputBaseUrl = normalizeProviderBaseUrl(providerId, storedRow?.base_url || body.baseUrl as string | undefined);
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
      requestedModelId: storedRow?.model_id || body.modelId as string | undefined,
      requestedName: storedRow?.name || body.name as string | undefined,
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
    if (matched && storedRow) {
      const evidence = await probeEndpointMetadata({ provider: providerId, baseUrl, modelId, apiKey });
      void createModelAdvisory({
        modelRowId: storedRow.id,
        provider: providerId,
        modelId,
        latencyMs,
        evidence,
      }).catch(() => {});
    }

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
