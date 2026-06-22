import crypto from "node:crypto";
import { getSqlite, initializeDatabase } from "@/lib/db";
import { parseSecretReference, resolveSecretValue } from "@/lib/secrets/store";

export type AcpAuthMode = "off" | "bearer";

function normalizeAuthMode(value: unknown): AcpAuthMode {
  return String(value || "").trim().toLowerCase() === "bearer" ? "bearer" : "off";
}

export function getConfiguredAcpAuthMode(): AcpAuthMode {
  const envMode = String(process.env.ACP_AUTH_MODE || "").trim().toLowerCase();
  if (envMode === "bearer") return "bearer";
  initializeDatabase();
  const db = getSqlite();
  const row = db
    .prepare("SELECT acp_auth_mode FROM app_config WHERE id = 'default'")
    .get() as { acp_auth_mode?: string | null } | undefined;
  return normalizeAuthMode(row?.acp_auth_mode);
}

export function getConfiguredAcpAuthSecretName(): string | null {
  const envName = String(process.env.ACP_AUTH_SECRET_NAME || "").trim();
  if (envName) return envName;
  initializeDatabase();
  const db = getSqlite();
  const row = db
    .prepare("SELECT acp_auth_secret_name FROM app_config WHERE id = 'default'")
    .get() as { acp_auth_secret_name?: string | null } | undefined;
  return String(row?.acp_auth_secret_name || "").trim() || null;
}

export function resolveAcpBearerToken(): string | null {
  const envToken = String(process.env.ACP_INGRESS_TOKEN || "").trim();
  if (envToken) return envToken;
  const secretName = getConfiguredAcpAuthSecretName();
  if (!secretName) return null;
  const normalized = parseSecretReference(secretName) || secretName.trim().toUpperCase();
  return resolveSecretValue(normalized) || null;
}

export function isAcpAuthConfigured(): boolean {
  if (getConfiguredAcpAuthMode() === "off") return false;
  return Boolean(resolveAcpBearerToken());
}

export function validateAcpBearerToken(authorizationHeader: string | null | undefined): boolean {
  if (getConfiguredAcpAuthMode() === "off") return true;
  const expected = resolveAcpBearerToken();
  if (!expected) return false;
  const value = String(authorizationHeader || "");
  const match = value.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const actual = Buffer.from(match[1], "utf8");
  const wanted = Buffer.from(expected, "utf8");
  if (actual.length !== wanted.length) return false;
  return crypto.timingSafeEqual(actual, wanted);
}
