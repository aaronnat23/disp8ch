import { resolveSecretValue } from "@/lib/secrets/store";
import type { PublishProvider, PublishRequest, PublishResult } from "../types";

function token(): string {
  return resolveSecretValue("VERCEL_TOKEN") ?? process.env.VERCEL_TOKEN ?? "";
}

function teamQuery(): string {
  const teamId = resolveSecretValue("VERCEL_TEAM_ID") ?? process.env.VERCEL_TEAM_ID ?? "";
  return teamId ? `?teamId=${encodeURIComponent(teamId)}` : "";
}

function safeProjectName(artifactId: string): string {
  const normalized = `disp8ch-${artifactId}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-");
  return normalized.slice(0, 80).replace(/^-|-$/g, "") || "disp8ch-artifact";
}

async function requestJson(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(url, init);
  const text = await response.text();
  let json: Record<string, unknown> = {};
  try { json = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { /* bounded error below */ }
  if (!response.ok) {
    const detail = json.error && typeof json.error === "object" ? JSON.stringify(json.error) : String(json.error || json.message || text);
    throw new Error(`Vercel publish failed (${response.status}): ${detail.slice(0, 1000)}`);
  }
  return json;
}

async function waitForReady(remoteId: string, initial: Record<string, unknown>): Promise<Record<string, unknown>> {
  let latest = initial;
  for (let attempt = 0; attempt < 30; attempt++) {
    const state = String(latest.readyState || latest.state || "").toUpperCase();
    if (state === "READY" || state === "ERROR" || state === "CANCELED") return latest;
    await new Promise((resolve) => setTimeout(resolve, 1000));
    latest = await requestJson(`https://api.vercel.com/v13/deployments/${encodeURIComponent(remoteId)}${teamQuery()}`, {
      method: "GET",
      headers: { authorization: `Bearer ${token()}` },
    });
  }
  return latest;
}

async function deploy(request: PublishRequest): Promise<PublishResult> {
  const apiToken = token();
  if (!apiToken) throw new Error("VERCEL_TOKEN is not configured in the secret store.");
  if (request.visibility !== "public") throw new Error("The Vercel static provider supports public deployments only.");
  if (request.expiresAt) throw new Error("The Vercel static provider does not support automatic expiry.");
  const projectName = String(request.existingMetadata?.projectName || safeProjectName(request.artifactId));
  const payload = {
    name: projectName,
    target: "production",
    files: request.files.map((file) => ({ file: file.path, data: file.content.toString("base64"), encoding: "base64" })),
    projectSettings: { framework: null },
  };
  const json = await requestJson(`https://api.vercel.com/v13/deployments${teamQuery()}`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const remoteId = String(json.id || "");
  if (!remoteId) throw new Error("Vercel returned an incomplete deployment response.");
  const settled = await waitForReady(remoteId, json);
  const deploymentUrl = String(settled.url || json.url || "");
  if (!remoteId || !deploymentUrl) throw new Error("Vercel returned an incomplete deployment response.");
  const alias = Array.isArray(settled.alias) ? String(settled.alias[0] || "") : "";
  return {
    provider: "vercel",
    remoteId,
    url: `https://${alias || deploymentUrl}`,
    status: String(settled.readyState || "").toUpperCase() === "READY" ? "live" : "processing",
    providerMetadata: { projectName, deploymentUrl },
  };
}

export const vercelPublishProvider: PublishProvider = {
  id: "vercel",
  capabilities: { stableUrl: true, protectedVisibility: false, expiry: false, feedback: false },
  async validateConfiguration() {
    return token() ? { ok: true } : { ok: false, reason: "Add VERCEL_TOKEN to Settings > Secrets." };
  },
  publish: deploy,
  update: deploy,
  async revoke(remoteId) {
    const apiToken = token();
    if (!apiToken) throw new Error("VERCEL_TOKEN is not configured in the secret store.");
    await requestJson(`https://api.vercel.com/v13/deployments/${encodeURIComponent(remoteId)}${teamQuery()}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${apiToken}` },
    });
  },
};
