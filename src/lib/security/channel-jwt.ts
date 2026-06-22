import crypto from "node:crypto";

type JwtHeader = { alg?: string; kid?: string; x5t?: string };
type JwtPayload = Record<string, unknown> & { aud?: string | string[]; iss?: string; exp?: number; nbf?: number };
type SigningKey = JsonWebKey & { kid?: string; x5t?: string; endorsements?: string[]; x5c?: string[] };

type KeyCacheEntry = { expiresAt: number; keys: SigningKey[] };
const cache = new Map<string, KeyCacheEntry>();
const CACHE_MS = 6 * 60 * 60 * 1000;
const CLOCK_SKEW_SECONDS = 5 * 60;

function decodePart<T>(part: string): T {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as T;
}

function bearerToken(request: Request): string {
  const value = String(request.headers.get("authorization") || "").trim();
  if (!/^Bearer\s+/i.test(value)) throw new Error("Missing bearer token");
  return value.replace(/^Bearer\s+/i, "").trim();
}

function parseJwt(token: string): { header: JwtHeader; payload: JwtPayload; signed: string; signature: Buffer } {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed JWT");
  const header = decodePart<JwtHeader>(parts[0]!);
  const payload = decodePart<JwtPayload>(parts[1]!);
  if (header.alg !== "RS256") throw new Error("Unsupported JWT algorithm");
  return {
    header,
    payload,
    signed: `${parts[0]}.${parts[1]}`,
    signature: Buffer.from(parts[2]!, "base64url"),
  };
}

function validateStandardClaims(payload: JwtPayload, audience: string, issuers: string[]): void {
  const now = Math.floor(Date.now() / 1000);
  if (!payload.iss || !issuers.includes(payload.iss)) throw new Error("Invalid JWT issuer");
  const audiences = Array.isArray(payload.aud) ? payload.aud.map(String) : [String(payload.aud || "")];
  if (!audiences.includes(audience)) throw new Error("Invalid JWT audience");
  if (!Number.isFinite(Number(payload.exp)) || Number(payload.exp) < now - CLOCK_SKEW_SECONDS) {
    throw new Error("Expired JWT");
  }
  if (Number.isFinite(Number(payload.nbf)) && Number(payload.nbf) > now + CLOCK_SKEW_SECONDS) {
    throw new Error("JWT is not active yet");
  }
}

function publicKeyFor(key: SigningKey): crypto.KeyObject {
  if (Array.isArray(key.x5c) && key.x5c[0]) {
    const body = key.x5c[0].match(/.{1,64}/g)?.join("\n") || key.x5c[0];
    return crypto.createPublicKey(`-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`);
  }
  return crypto.createPublicKey({ key: key as unknown as crypto.JsonWebKey, format: "jwk" });
}

function verifySignature(parsed: ReturnType<typeof parseJwt>, keys: SigningKey[]): SigningKey {
  const key = keys.find((candidate) =>
    (parsed.header.kid && candidate.kid === parsed.header.kid) ||
    (parsed.header.x5t && candidate.x5t === parsed.header.x5t),
  );
  if (!key) throw new Error("JWT signing key not found");
  const valid = crypto.verify("RSA-SHA256", Buffer.from(parsed.signed), publicKeyFor(key), parsed.signature);
  if (!valid) throw new Error("Invalid JWT signature");
  return key;
}

async function readJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Signing-key request failed: HTTP ${response.status}`);
  return await response.json() as Record<string, unknown>;
}

async function cachedJwks(url: string): Promise<SigningKey[]> {
  const hit = cache.get(url);
  if (hit && hit.expiresAt > Date.now()) return hit.keys;
  const json = await readJson(url);
  const keys = Array.isArray(json.keys) ? json.keys as SigningKey[] : [];
  if (keys.length === 0) throw new Error("Signing-key response was empty");
  cache.set(url, { keys, expiresAt: Date.now() + CACHE_MS });
  return keys;
}

async function cachedPemKeys(url: string): Promise<SigningKey[]> {
  const hit = cache.get(url);
  if (hit && hit.expiresAt > Date.now()) return hit.keys;
  const json = await readJson(url);
  const keys = Object.entries(json).map(([kid, pem]) => {
    const key = crypto.createPublicKey(String(pem)).export({ format: "jwk" }) as JsonWebKey;
    return { ...key, kid } as SigningKey;
  });
  if (keys.length === 0) throw new Error("Signing-certificate response was empty");
  cache.set(url, { keys, expiresAt: Date.now() + CACHE_MS });
  return keys;
}

export async function verifyTeamsIngress(
  request: Request,
  activity: { serviceUrl?: string; channelId?: string },
  appId: string,
): Promise<void> {
  if (!appId) throw new Error("Teams App ID is not configured");
  const parsed = parseJwt(bearerToken(request));
  validateStandardClaims(parsed.payload, appId, ["https://api.botframework.com"]);
  const metadata = await readJson("https://login.botframework.com/v1/.well-known/openidconfiguration");
  const jwksUri = String(metadata.jwks_uri || "");
  if (!jwksUri.startsWith("https://login.botframework.com/")) throw new Error("Invalid Teams signing-key endpoint");
  const signingKey = verifySignature(parsed, await cachedJwks(jwksUri));
  if (String(parsed.payload.serviceurl || parsed.payload.serviceUrl || "") !== String(activity.serviceUrl || "")) {
    throw new Error("Teams serviceUrl claim does not match the activity");
  }
  if (signingKey.endorsements?.length && activity.channelId && !signingKey.endorsements.includes(activity.channelId)) {
    throw new Error("Teams signing key is not endorsed for this channel");
  }
}

export async function verifyGoogleChatIngress(request: Request, audience: string): Promise<void> {
  if (!audience) throw new Error("Google Chat authentication audience is not configured");
  const parsed = parseJwt(bearerToken(request));
  const issuer = String(parsed.payload.iss || "");
  const chatIssuer = "chat@system.gserviceaccount.com";
  const projectJwt = issuer === chatIssuer;
  validateStandardClaims(
    parsed.payload,
    audience,
    projectJwt ? [chatIssuer] : ["https://accounts.google.com", "accounts.google.com"],
  );
  const certUrl = projectJwt
    ? `https://www.googleapis.com/service_accounts/v1/metadata/x509/${encodeURIComponent(chatIssuer)}`
    : "https://www.googleapis.com/oauth2/v1/certs";
  verifySignature(parsed, await cachedPemKeys(certUrl));
  if (!projectJwt) {
    if (String(parsed.payload.email || "") !== chatIssuer || parsed.payload.email_verified !== true) {
      throw new Error("Google Chat token email is invalid");
    }
  }
}
