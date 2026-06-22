import { getSqlite, initializeDatabase } from "@/lib/db";
import { resolveModelApiKey } from "@/lib/agents/provider-auth";
import { providerRequiresApiKey } from "@/lib/agents/provider-plugins";
import { normalizeProviderId } from "@/lib/agents/provider-normalization";
import { getSecretsStatus, listSecretsMeta } from "@/lib/secrets/store";

export type ValidationStatus = "ok" | "warn" | "error";

export type ConfigValidationCheck = {
  id: string;
  title: string;
  status: ValidationStatus;
  summary: string;
  details?: string[];
};

export type ConfigValidationReport = {
  ok: boolean;
  checkedAt: string;
  errors: number;
  warnings: number;
  checks: ConfigValidationCheck[];
};

function isSecretRef(value: string): boolean {
  const raw = value.trim();
  return raw.startsWith("secret:") || raw.startsWith("secret://");
}

function isEnvRef(value: string): boolean {
  const raw = value.trim();
  return raw.startsWith("env:") || raw.startsWith("$");
}

function isLikelyLiteralCredential(value: string): boolean {
  const parts = value
    .split("||")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return false;
  for (const part of parts) {
    if (isSecretRef(part) || isEnvRef(part)) continue;
    return true;
  }
  return false;
}

function workflowNeedsGoogleOAuth(nodesJson: string): boolean {
  return nodesJson.includes("{{google.accessToken}}") || nodesJson.includes("google.accessToken");
}

export function runConfigValidation(): ConfigValidationReport {
  initializeDatabase();
  const db = getSqlite();
  const checks: ConfigValidationCheck[] = [];

  checks.push({
    id: "database",
    title: "Database",
    status: "ok",
    summary: "Database connection is healthy.",
  });

  const appRow = db.prepare("SELECT * FROM app_config WHERE id = 'default'").get() as Record<string, unknown> | undefined;
  const memRow = db.prepare("SELECT * FROM memory_config WHERE id = 'default'").get() as Record<string, unknown> | undefined;
  if (!appRow || !memRow) {
    checks.push({
      id: "config-rows",
      title: "Config Rows",
      status: "error",
      summary: "Missing default app_config or memory_config row.",
    });
  } else {
    checks.push({
      id: "config-rows",
      title: "Config Rows",
      status: "ok",
      summary: "Default config rows are present.",
    });
  }

  const secretsStatus = getSecretsStatus();
  const secrets = listSecretsMeta();
  if (!secretsStatus.masterKeyConfigured && secrets.length > 0) {
    checks.push({
      id: "secrets",
      title: "Secrets Manager",
      status: "error",
      summary: "Secrets exist but no master key is configured.",
      details: ["Set ENCRYPTION_KEY or SECRETS_MASTER_KEY before starting the app."],
    });
  } else if (!secretsStatus.masterKeyConfigured) {
    checks.push({
      id: "secrets",
      title: "Secrets Manager",
      status: "warn",
      summary: "Master key is not configured.",
      details: ["Set ENCRYPTION_KEY or SECRETS_MASTER_KEY to enable encrypted secret storage."],
    });
  } else {
    checks.push({
      id: "secrets",
      title: "Secrets Manager",
      status: "ok",
      summary: `Encrypted secrets manager ready (${secrets.length} secret${secrets.length === 1 ? "" : "s"}).`,
      details: secretsStatus.keySource ? [`Key source: ${secretsStatus.keySource}`] : undefined,
    });
  }

  const modelRows = db.prepare(
    "SELECT id, provider, model_id, api_key, is_active FROM models WHERE is_active = 1 ORDER BY priority DESC"
  ).all() as Array<{
    id: string;
    provider: string;
    model_id: string;
    api_key: string;
    is_active: number;
  }>;

  if (modelRows.length === 0) {
    checks.push({
      id: "models",
      title: "Model Auth",
      status: "error",
      summary: "No active models configured.",
      details: ["Add at least one model in Settings > Models or via `dpc models add`."],
    });
  } else {
    const missingAuth: string[] = [];
    const literalCredentials: string[] = [];
    for (const row of modelRows) {
      const provider = normalizeProviderId(row.provider) ?? row.provider;
      const auth = resolveModelApiKey({ provider, storedApiKey: row.api_key });
      if (providerRequiresApiKey(provider) && !auth.apiKey) {
        missingAuth.push(`${row.id} (${provider}/${row.model_id})`);
      }
      if (providerRequiresApiKey(provider) && isLikelyLiteralCredential(row.api_key)) {
        literalCredentials.push(`${row.id} (${provider}/${row.model_id})`);
      }
    }

    if (missingAuth.length > 0) {
      checks.push({
        id: "models",
        title: "Model Auth",
        status: "error",
        summary: `${missingAuth.length} active model(s) cannot resolve API keys.`,
        details: missingAuth,
      });
    } else if (literalCredentials.length > 0) {
      checks.push({
        id: "models",
        title: "Model Auth",
        status: "warn",
        summary: `${literalCredentials.length} model(s) still use literal API keys in DB.`,
        details: [
          "Use `secret:NAME` or env refs (`env:OPENAI_API_KEY`) to avoid raw key storage.",
          ...literalCredentials,
        ],
      });
    } else {
      checks.push({
        id: "models",
        title: "Model Auth",
        status: "ok",
        summary: `${modelRows.length} active model(s) resolve credentials correctly.`,
      });
    }
  }

  const activeWorkflows = db.prepare("SELECT id, name, nodes FROM workflows WHERE is_active = 1").all() as Array<{
    id: string;
    name: string;
    nodes: string;
  }>;

  if (activeWorkflows.length === 0) {
    checks.push({
      id: "workflows",
      title: "Workflows",
      status: "warn",
      summary: "No active workflows found.",
    });
  } else {
    checks.push({
      id: "workflows",
      title: "Workflows",
      status: "ok",
      summary: `${activeWorkflows.length} active workflow(s) found.`,
    });
  }

  const oauthRow = db.prepare("SELECT email, expires_at, refresh_token FROM google_oauth WHERE id = 'default'").get() as {
    email: string | null;
    expires_at: number | null;
    refresh_token: string | null;
  } | undefined;
  const needsGoogle = activeWorkflows.filter((wf) => workflowNeedsGoogleOAuth(wf.nodes));
  if (needsGoogle.length > 0 && !oauthRow) {
    checks.push({
      id: "google-oauth",
      title: "Google OAuth",
      status: "error",
      summary: `${needsGoogle.length} active workflow(s) reference {{google.accessToken}} but OAuth is not configured.`,
      details: ["Run `dpc auth google` or configure Google in Settings > Google."],
    });
  } else if (needsGoogle.length > 0 && oauthRow) {
    const now = Math.floor(Date.now() / 1000);
    const expired = oauthRow.expires_at ? oauthRow.expires_at <= now : true;
    if (expired || !oauthRow.refresh_token) {
      checks.push({
        id: "google-oauth",
        title: "Google OAuth",
        status: "warn",
        summary: "Google OAuth exists but may not refresh cleanly.",
        details: [
          expired ? "Access token appears expired." : "Access token active.",
          oauthRow.refresh_token ? "Refresh token is present." : "Refresh token is missing.",
        ],
      });
    } else {
      checks.push({
        id: "google-oauth",
        title: "Google OAuth",
        status: "ok",
        summary: `Google OAuth is configured for ${oauthRow.email ?? "unknown account"}.`,
      });
    }
  } else {
    checks.push({
      id: "google-oauth",
      title: "Google OAuth",
      status: "ok",
      summary: "No active workflow currently requires Google OAuth token injection.",
    });
  }

  const webhookRows = db.prepare("SELECT id, name, secret, is_active FROM webhooks WHERE is_active = 1").all() as Array<{
    id: string;
    name: string;
    secret: string;
    is_active: number;
  }>;
  const weakWebhooks = webhookRows.filter((row) => String(row.secret ?? "").trim().length < 24);
  if (weakWebhooks.length > 0) {
    checks.push({
      id: "webhooks",
      title: "Webhook Secrets",
      status: "error",
      summary: `${weakWebhooks.length} active webhook(s) have weak secrets.`,
      details: weakWebhooks.map((row) => `${row.id} (${row.name})`),
    });
  } else {
    checks.push({
      id: "webhooks",
      title: "Webhook Secrets",
      status: "ok",
      summary: webhookRows.length > 0
        ? `${webhookRows.length} active webhook(s) have strong secrets.`
        : "No active webhooks configured.",
    });
  }

  const rlWebhooks = Number(appRow?.rate_limit_webhooks ?? 30);
  const rlExecute = Number(appRow?.rate_limit_execute ?? 20);
  const rlChannels = Number(appRow?.rate_limit_channels ?? 60);
  const rlInvalid = [
    rlWebhooks <= 0 ? "rate_limit_webhooks must be > 0" : null,
    rlExecute <= 0 ? "rate_limit_execute must be > 0" : null,
    rlChannels <= 0 ? "rate_limit_channels must be > 0" : null,
  ].filter(Boolean) as string[];
  const rlHigh = [
    rlWebhooks > 500 ? `rate_limit_webhooks=${rlWebhooks}` : null,
    rlExecute > 500 ? `rate_limit_execute=${rlExecute}` : null,
    rlChannels > 500 ? `rate_limit_channels=${rlChannels}` : null,
  ].filter(Boolean) as string[];
  if (rlInvalid.length > 0) {
    checks.push({
      id: "rate-limits",
      title: "Rate Limits",
      status: "error",
      summary: "Rate-limit configuration has invalid values.",
      details: rlInvalid,
    });
  } else if (rlHigh.length > 0) {
    checks.push({
      id: "rate-limits",
      title: "Rate Limits",
      status: "warn",
      summary: "Some rate limits are unusually high.",
      details: rlHigh,
    });
  } else {
    checks.push({
      id: "rate-limits",
      title: "Rate Limits",
      status: "ok",
      summary: "Rate-limit configuration looks sane.",
    });
  }

  const laneMain = Number(appRow?.lane_main_max_concurrent ?? 4);
  const laneCron = Number(appRow?.lane_cron_max_concurrent ?? 1);
  const laneSubflow = Number(appRow?.lane_subflow_max_concurrent ?? 8);
  const laneInvalid = [
    laneMain < 1 ? "lane_main_max_concurrent must be >= 1" : null,
    laneCron < 1 ? "lane_cron_max_concurrent must be >= 1" : null,
    laneSubflow < 1 ? "lane_subflow_max_concurrent must be >= 1" : null,
  ].filter(Boolean) as string[];
  const laneHigh = [
    laneMain > 16 ? `lane_main_max_concurrent=${laneMain}` : null,
    laneCron > 8 ? `lane_cron_max_concurrent=${laneCron}` : null,
    laneSubflow > 32 ? `lane_subflow_max_concurrent=${laneSubflow}` : null,
  ].filter(Boolean) as string[];
  if (laneInvalid.length > 0) {
    checks.push({
      id: "execution-lanes",
      title: "Execution Lanes",
      status: "error",
      summary: "Execution lane concurrency has invalid values.",
      details: laneInvalid,
    });
  } else if (laneHigh.length > 0) {
    checks.push({
      id: "execution-lanes",
      title: "Execution Lanes",
      status: "warn",
      summary: "Some execution lane limits are unusually high.",
      details: laneHigh,
    });
  } else {
    checks.push({
      id: "execution-lanes",
      title: "Execution Lanes",
      status: "ok",
      summary: "Execution lane limits look sane.",
    });
  }

  const errors = checks.filter((check) => check.status === "error").length;
  const warnings = checks.filter((check) => check.status === "warn").length;
  return {
    ok: errors === 0,
    checkedAt: new Date().toISOString(),
    errors,
    warnings,
    checks,
  };
}
