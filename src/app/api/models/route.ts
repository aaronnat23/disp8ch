import { NextRequest, NextResponse } from "next/server";
import { getSqlite, initializeDatabase, withSqliteWriteRecovery } from "@/lib/db";
import { PROVIDERS } from "@/types/model";
import { normalizeProviderBaseUrl } from "@/lib/agents/provider-base-url";
import { normalizeProviderId } from "@/lib/agents/provider-normalization";
import {
  providerRequiresApiKey,
  resolveProviderModelSelection,
} from "@/lib/agents/provider-plugins";
import { checkModelToolSupport, getToolCapableRecommendations } from "@/lib/agents/model-capabilities";
import { nanoid } from "nanoid";
import { requireOperatorAccess } from "@/lib/security/admin";
import { parseSecretReference, upsertSecret } from "@/lib/secrets/store";
import { getRuntimeModelAvailability } from "@/lib/agents/model-availability";

export async function GET(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    initializeDatabase();

    withSqliteWriteRecovery("models:ensure-columns", (writer) => {
      try {
        writer.prepare("SELECT base_url FROM models LIMIT 0").get();
      } catch {
        writer.exec("ALTER TABLE models ADD COLUMN base_url TEXT");
      }
      try {
        writer.prepare("SELECT fast_mode FROM models LIMIT 0").get();
      } catch {
        writer.exec("ALTER TABLE models ADD COLUMN fast_mode INTEGER DEFAULT 0");
      }
    });
    const db = getSqlite();

    const rows = db
      .prepare("SELECT * FROM models ORDER BY priority DESC")
      .all() as Array<{
        id: string; provider: string; model_id: string; name: string;
        api_key: string; priority: number; is_active: number; max_tokens: number | null;
        base_url: string | null; fast_mode: number | null; created_at: string;
      }>;

    const models = rows.map((r) => ({
      id: r.id,
      provider: normalizeProviderId(r.provider) ?? r.provider,
      modelId: r.model_id,
      name: r.name,
      priority: r.priority,
      isActive: r.is_active === 1,
      maxTokens: r.max_tokens,
      baseUrl: normalizeProviderBaseUrl(r.provider, r.base_url) ?? null,
      fastMode: r.fast_mode === 1,
      createdAt: r.created_at,
    }));

    if (models.length === 0) {
      const runtimeModel = getRuntimeModelAvailability(db);
      if (runtimeModel.available && runtimeModel.source !== "db") {
        const modelId = runtimeModel.details.match(/\(([^)]+)\)/)?.[1] ?? runtimeModel.source;
        models.push({
          id: `runtime-${runtimeModel.source}`,
          provider: runtimeModel.source,
          modelId,
          name: runtimeModel.details,
          priority: 0,
          isActive: true,
          maxTokens: null,
          baseUrl: null,
          fastMode: false,
          createdAt: new Date(0).toISOString(),
        });
      }
    }

    return NextResponse.json({ success: true, data: models });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    initializeDatabase();
    const body = await request.json();
    const now = new Date().toISOString();

    withSqliteWriteRecovery("models:ensure-columns", (writer) => {
      try {
        writer.prepare("SELECT base_url FROM models LIMIT 0").get();
      } catch {
        writer.exec("ALTER TABLE models ADD COLUMN base_url TEXT");
      }
      try {
        writer.prepare("SELECT fast_mode FROM models LIMIT 0").get();
      } catch {
        writer.exec("ALTER TABLE models ADD COLUMN fast_mode INTEGER DEFAULT 0");
      }
    });

    const providerRaw = String(body.provider || "anthropic");
    const provider = normalizeProviderId(providerRaw);
    if (!provider) {
      return NextResponse.json({ success: false, error: `Unknown provider: ${providerRaw}` }, { status: 400 });
    }
    const providerInfo = PROVIDERS.find((p) => p.id === provider);
    let defaultModelId = body.modelId || providerInfo?.defaultModel || "claude-sonnet-4-5";
    let defaultName = body.name || providerInfo?.defaultName || "Unknown Model";
    const warnings: string[] = [];
    const normalizedInputBaseUrl = normalizeProviderBaseUrl(provider, body.baseUrl as string | undefined);
    const normalizedDefaultBaseUrl = normalizeProviderBaseUrl(provider, providerInfo?.baseUrl);
    const baseUrl = normalizedInputBaseUrl ?? normalizedDefaultBaseUrl ?? null;
    const apiKey = String(body.apiKey || "").trim();
    const fastMode = body.fastMode === true ? 1 : 0;
    const selection = await resolveProviderModelSelection({
      provider,
      requestedModelId: body.modelId as string | undefined,
      requestedName: body.name as string | undefined,
      baseUrl,
      apiKey,
    });
    defaultModelId = selection.modelId || defaultModelId;
    defaultName = selection.name || defaultName;
    warnings.push(...selection.warnings);

    const toolSupport = checkModelToolSupport(provider, defaultModelId);
    if (toolSupport.status === "unsupported") {
      const recommendations = getToolCapableRecommendations(provider).map((m) => m.id);
      const suffix =
        recommendations.length > 0 ? ` Try one of: ${recommendations.join(", ")}` : "";
      return NextResponse.json(
        { success: false, error: `${toolSupport.reason}${suffix}` },
        { status: 400 },
      );
    }
    if (toolSupport.status === "unknown") {
      warnings.push(toolSupport.reason);
    }
    if (!providerRequiresApiKey(provider) && !apiKey) {
      warnings.push(
        `No API key stored for ${provider}; runtime will use its local/default auth path.`,
      );
    }

    let storedApiKey = apiKey;
    const apiKeyLooksStored =
      Boolean(parseSecretReference(apiKey)) ||
      apiKey.startsWith("env:") ||
      apiKey.startsWith("$");
    if (apiKey && !apiKeyLooksStored) {
      try {
        const secretName = String(providerInfo?.envKey || `${provider}_API_KEY`)
          .trim()
          .toUpperCase()
          .replace(/[^A-Z0-9_]/g, "_");
        const saved = upsertSecret({
          name: secretName,
          value: apiKey,
          source: "models-api",
        });
        storedApiKey = `secret:${saved.name}`;
      } catch (secretError) {
        warnings.push(`Could not save ${provider} credential into encrypted secrets store; storing the provided value directly.`);
        warnings.push(String(secretError));
      }
    }

    const id = nanoid(8);
    withSqliteWriteRecovery("models:create", (writer) => {
      const existingCount = (writer.prepare("SELECT COUNT(*) as count FROM models").get() as { count: number }).count;
      writer.prepare(
        "INSERT INTO models (id, provider, model_id, name, api_key, priority, is_active, max_tokens, base_url, fast_mode, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(
        id,
        provider,
        defaultModelId,
        defaultName,
        storedApiKey,
        existingCount,
        1,
        body.maxTokens || null,
        baseUrl,
        fastMode,
        now
      );
    });

    return NextResponse.json({
      success: true,
      data: { id, provider, modelId: defaultModelId, name: defaultName },
      ...(warnings.length > 0 ? { warnings } : {}),
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    initializeDatabase();
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) {
      return NextResponse.json({ success: false, error: "Missing id" }, { status: 400 });
    }
    const db = getSqlite();
    db.prepare("DELETE FROM models WHERE id = ?").run(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
