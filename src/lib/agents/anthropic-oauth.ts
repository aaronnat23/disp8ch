import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Anthropic from "@anthropic-ai/sdk";

const CLAUDE_CODE_VERSION_FALLBACK = "2.1.74";
const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const OAUTH_REFRESH_SKEW_MS = 60_000;
const execFileAsync = promisify(execFile);
let claudeCodeVersionCache: string | null = null;

type ClaudeCodeCredentialPayload = {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    scopes?: string[];
  };
};

type AnthropicRefreshPayload = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
};

export type AnthropicCredentialResolution = {
  token: string;
  source: "api_key" | "oauth_token" | "claude_code_credentials";
};

function looksLikeAnthropicOAuthToken(token: string): boolean {
  const value = String(token || "").trim();
  if (!value) return false;
  if (value.startsWith("sk-ant-api")) return false;
  return value.startsWith("sk-ant-") || value.startsWith("eyJ") || value.startsWith("cc-");
}

function claudeCredentialPaths(): string[] {
  const candidates = new Set<string>();
  const explicit = process.env.CLAUDE_CODE_CREDENTIALS_PATH?.trim();
  if (explicit) candidates.add(explicit);

  const home = os.homedir();
  if (home) {
    candidates.add(path.join(home, ".claude", ".credentials.json"));
  }

  const winProfile = process.env.USERPROFILE?.trim();
  if (winProfile) {
    candidates.add(path.join(winProfile, ".claude", ".credentials.json"));
  }

  const winUser = process.env.USERNAME?.trim();
  if (winUser) {
    candidates.add(path.join("/mnt/c/Users", winUser, ".claude", ".credentials.json"));
  }

  return Array.from(candidates);
}

function readClaudeCodeCredentials(): { path: string; payload: ClaudeCodeCredentialPayload } | null {
  for (const filePath of claudeCredentialPaths()) {
    try {
      if (!fs.existsSync(filePath)) continue;
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as ClaudeCodeCredentialPayload;
      if (parsed?.claudeAiOauth?.accessToken) return { path: filePath, payload: parsed };
    } catch {
      // Try the next known location.
    }
  }
  return null;
}

export function hasClaudeCodeCredentials(): boolean {
  return readClaudeCodeCredentials() !== null;
}

async function detectClaudeCodeVersion(): Promise<string> {
  if (claudeCodeVersionCache) return claudeCodeVersionCache;
  for (const command of ["claude", "claude-code"]) {
    try {
      const result = await execFileAsync(command, ["--version"], { timeout: 5000, windowsHide: true });
      const version = String(result.stdout || "").trim().split(/\s+/)[0] || "";
      if (/^\d+(?:\.\d+){1,3}$/.test(version)) {
        claudeCodeVersionCache = version;
        return version;
      }
    } catch {
      // Try the next known binary name.
    }
  }
  claudeCodeVersionCache = CLAUDE_CODE_VERSION_FALLBACK;
  return CLAUDE_CODE_VERSION_FALLBACK;
}

async function refreshClaudeCodeCredentials(
  credentialPath: string,
  payload: ClaudeCodeCredentialPayload,
): Promise<string | null> {
  const oauth = payload.claudeAiOauth;
  const refreshToken = String(oauth?.refreshToken || "").trim();
  if (!refreshToken) return null;

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLAUDE_OAUTH_CLIENT_ID,
  });

  const endpoints = [
    "https://platform.claude.com/v1/oauth/token",
    "https://console.anthropic.com/v1/oauth/token",
  ];

  let refreshed: AnthropicRefreshPayload | undefined;
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": `claude-cli/${await detectClaudeCodeVersion()} (external, cli)`,
        },
        body,
      });
      if (!response.ok) continue;
      refreshed = (await response.json()) as AnthropicRefreshPayload;
      if (refreshed?.access_token) break;
    } catch {
      // Try the next endpoint.
    }
  }

  const accessToken = String(refreshed?.access_token || "").trim();
  if (!accessToken) return null;

  const nextRefresh = String(refreshed?.refresh_token || refreshToken).trim();
  const expiresIn = Number(refreshed?.expires_in || 3600);
  const expiresAt = Date.now() + Math.max(60, expiresIn) * 1000;
  const nextPayload: ClaudeCodeCredentialPayload = {
    ...payload,
    claudeAiOauth: {
      ...oauth,
      accessToken,
      refreshToken: nextRefresh,
      expiresAt,
    },
  };

  try {
    const tmpPath = `${credentialPath}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(nextPayload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmpPath, credentialPath);
  } catch {
    // Runtime can still use the refreshed token even if the credential file
    // could not be updated.
  }

  return accessToken;
}

export async function resolveAnthropicCredential(apiKey?: string | null): Promise<AnthropicCredentialResolution> {
  const direct = String(apiKey || "").trim();
  if (direct) {
    return {
      token: direct,
      source: looksLikeAnthropicOAuthToken(direct) ? "oauth_token" : "api_key",
    };
  }

  const discovered = readClaudeCodeCredentials();
  const oauth = discovered?.payload.claudeAiOauth;
  const accessToken = String(oauth?.accessToken || "").trim();
  if (!discovered || !accessToken) {
    return { token: "", source: "api_key" };
  }

  const expiresAt = Number(oauth?.expiresAt || 0);
  if (expiresAt > 0 && expiresAt <= Date.now() + OAUTH_REFRESH_SKEW_MS) {
    const refreshed = await refreshClaudeCodeCredentials(discovered.path, discovered.payload);
    if (refreshed) return { token: refreshed, source: "claude_code_credentials" };
  }

  return { token: accessToken, source: "claude_code_credentials" };
}

export async function buildAnthropicClient(params: {
  apiKey?: string | null;
  baseURL?: string;
}): Promise<Anthropic> {
  const credential = await resolveAnthropicCredential(params.apiKey);
  const base = params.baseURL ? { baseURL: params.baseURL } : {};
  if (credential.source === "oauth_token" || credential.source === "claude_code_credentials") {
    const version = await detectClaudeCodeVersion();
    return new Anthropic({
      authToken: credential.token,
      ...base,
      defaultHeaders: {
        "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
        "user-agent": `claude-cli/${version} (external, cli)`,
        "x-app": "cli",
      },
    });
  }

  return new Anthropic({
    apiKey: credential.token,
    ...base,
  });
}

export const __test_anthropicOauth = {
  looksLikeAnthropicOAuthToken,
  claudeCredentialPaths,
};
