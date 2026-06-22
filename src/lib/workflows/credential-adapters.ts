import type { WorkflowCredential } from "@/lib/workflows/credentials";
import { resolveCredentialValue } from "@/lib/workflows/credentials";

export type CredentialField = {
  key: string;
  label: string;
  type: "secret" | "string" | "url" | "select";
  required?: boolean;
  help?: string;
};

export type CredentialTestResult = {
  ok: boolean;
  status: string;
  checkedAt: string;
};

export type HttpRequestDraft = {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
};

export type WorkflowCredentialAdapter = {
  serviceType: string;
  label: string;
  fields: CredentialField[];
  test: (credential: WorkflowCredential) => Promise<CredentialTestResult>;
  applyToRequest?: (credential: WorkflowCredential, request: HttpRequestDraft) => HttpRequestDraft;
};

function result(ok: boolean, status: string): CredentialTestResult {
  return { ok, status, checkedAt: new Date().toISOString() };
}

function readSecret(credential: WorkflowCredential): string | null {
  return resolveCredentialValue(credential.secretRef);
}

function withBearer(credential: WorkflowCredential, request: HttpRequestDraft): HttpRequestDraft {
  const token = readSecret(credential);
  return {
    ...request,
    headers: {
      ...(request.headers ?? {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  };
}

function parseMetadata(credential: WorkflowCredential): Record<string, unknown> {
  if (!credential.metadataJson) return {};
  try {
    const parsed = JSON.parse(credential.metadataJson) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

async function safeFetch(url: string, init: RequestInit): Promise<CredentialTestResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6_000);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return result(response.ok, response.ok ? `HTTP ${response.status}: credential accepted` : `HTTP ${response.status}: credential rejected`);
  } catch (error) {
    return result(false, `Credential test failed: ${String(error)}`);
  } finally {
    clearTimeout(timeout);
  }
}

const genericBearerAdapter: WorkflowCredentialAdapter = {
  serviceType: "generic-bearer",
  label: "Generic Bearer Token",
  fields: [{ key: "token", label: "Bearer token", type: "secret", required: true }],
  async test(credential) {
    return readSecret(credential)
      ? result(true, "Bearer token secret is present. Add a test URL in metadata for live validation.")
      : result(false, "Bearer token secret is missing.");
  },
  applyToRequest: withBearer,
};

const genericHeaderAdapter: WorkflowCredentialAdapter = {
  serviceType: "generic-header",
  label: "Generic Header",
  fields: [
    { key: "headerName", label: "Header name", type: "string", required: true },
    { key: "headerValue", label: "Header value", type: "secret", required: true },
  ],
  async test(credential) {
    const metadata = parseMetadata(credential);
    const headerName = String(metadata.headerName || "").trim();
    if (!headerName) return result(false, "Header name is missing from metadata.");
    return readSecret(credential) ? result(true, "Header credential is present.") : result(false, "Header secret is missing.");
  },
  applyToRequest(credential, request) {
    const metadata = parseMetadata(credential);
    const headerName = String(metadata.headerName || "Authorization").trim();
    const secret = readSecret(credential);
    return {
      ...request,
      headers: {
        ...(request.headers ?? {}),
        ...(secret ? { [headerName]: secret } : {}),
      },
    };
  },
};

const basicAuthAdapter: WorkflowCredentialAdapter = {
  serviceType: "basic-auth",
  label: "Basic Auth",
  fields: [
    { key: "username", label: "Username", type: "string", required: true },
    { key: "password", label: "Password", type: "secret", required: true },
  ],
  async test(credential) {
    const metadata = parseMetadata(credential);
    return metadata.username && readSecret(credential)
      ? result(true, "Basic auth username and password are present.")
      : result(false, "Basic auth username or password is missing.");
  },
  applyToRequest(credential, request) {
    const metadata = parseMetadata(credential);
    const username = String(metadata.username || "");
    const password = readSecret(credential) || "";
    const token = Buffer.from(`${username}:${password}`).toString("base64");
    return {
      ...request,
      headers: {
        ...(request.headers ?? {}),
        Authorization: `Basic ${token}`,
      },
    };
  },
};

const openAiAdapter: WorkflowCredentialAdapter = {
  serviceType: "openai",
  label: "OpenAI",
  fields: [{ key: "apiKey", label: "API key", type: "secret", required: true }],
  async test(credential) {
    const token = readSecret(credential);
    if (!token) return result(false, "OpenAI API key is missing.");
    return safeFetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${token}` },
    });
  },
  applyToRequest: withBearer,
};

const githubAdapter: WorkflowCredentialAdapter = {
  serviceType: "github",
  label: "GitHub",
  fields: [{ key: "token", label: "Token", type: "secret", required: true }],
  async test(credential) {
    const token = readSecret(credential);
    if (!token) return result(false, "GitHub token is missing.");
    return safeFetch("https://api.github.com/rate_limit", {
      headers: { Authorization: `Bearer ${token}`, "User-Agent": "disp8ch-credential-test" },
    });
  },
  applyToRequest: withBearer,
};

const telegramAdapter: WorkflowCredentialAdapter = {
  serviceType: "telegram",
  label: "Telegram Bot",
  fields: [{ key: "botToken", label: "Bot token", type: "secret", required: true }],
  async test(credential) {
    const token = readSecret(credential);
    if (!token) return result(false, "Telegram bot token is missing.");
    return safeFetch(`https://api.telegram.org/bot${token}/getMe`, {});
  },
};

const slackAdapter: WorkflowCredentialAdapter = {
  serviceType: "slack",
  label: "Slack",
  fields: [{ key: "botToken", label: "Bot token", type: "secret", required: true }],
  async test(credential) {
    const token = readSecret(credential);
    if (!token) return result(false, "Slack token is missing.");
    return safeFetch("https://slack.com/api/auth.test", {
      headers: { Authorization: `Bearer ${token}` },
    });
  },
  applyToRequest: withBearer,
};

const discordAdapter: WorkflowCredentialAdapter = {
  serviceType: "discord",
  label: "Discord",
  fields: [{ key: "token", label: "Bot token or webhook secret", type: "secret", required: true }],
  async test(credential) {
    return readSecret(credential)
      ? result(true, "Discord secret is present. Live validation depends on bot/webhook mode.")
      : result(false, "Discord secret is missing.");
  },
};

const googleOAuthAdapter: WorkflowCredentialAdapter = {
  serviceType: "google-oauth",
  label: "Google OAuth",
  fields: [{ key: "token", label: "Access or refresh token", type: "secret", required: true }],
  async test(credential) {
    return readSecret(credential)
      ? result(true, "Google OAuth token is present. OAuth refresh status is validated by the Google integration.")
      : result(false, "Google OAuth token is missing.");
  },
};

export const WORKFLOW_CREDENTIAL_ADAPTERS: WorkflowCredentialAdapter[] = [
  genericBearerAdapter,
  genericHeaderAdapter,
  basicAuthAdapter,
  openAiAdapter,
  googleOAuthAdapter,
  slackAdapter,
  discordAdapter,
  telegramAdapter,
  githubAdapter,
];

export function getWorkflowCredentialAdapter(serviceType: string): WorkflowCredentialAdapter {
  return (
    WORKFLOW_CREDENTIAL_ADAPTERS.find((adapter) => adapter.serviceType === serviceType) ??
    genericBearerAdapter
  );
}

export function listWorkflowCredentialAdapters(): Array<Pick<WorkflowCredentialAdapter, "serviceType" | "label" | "fields">> {
  return WORKFLOW_CREDENTIAL_ADAPTERS.map(({ serviceType, label, fields }) => ({ serviceType, label, fields }));
}
