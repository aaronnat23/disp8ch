/**
 * Google OAuth2 PKCE flow for Gmail/Drive integration.
 *
 * Handles authorization code exchange, token refresh, and DB persistence.
 * Single-user model: one row in google_oauth (id='default').
 */

import crypto from "node:crypto";
import http from "node:http";
import { logger } from "@/lib/utils/logger";

const log = logger.child("google-oauth");

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const GMAIL_PROFILE_URL = "https://gmail.googleapis.com/gmail/v1/users/me/profile";

const DEFAULT_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/drive.readonly",
];

export type GoogleOAuthRow = {
  id: string;
  email: string | null;
  client_id: string;
  client_secret: string;
  access_token: string | null;
  refresh_token: string | null;
  expires_at: number | null;
  scopes: string;
  created_at: string;
  updated_at: string;
};

// ---------------------------------------------------------------------------
// PKCE helpers
// ---------------------------------------------------------------------------

export function generatePkce(): { verifier: string; challenge: string; state: string } {
  const verifier = crypto.randomBytes(32).toString("hex");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const state = crypto.randomBytes(16).toString("hex");
  return { verifier, challenge, state };
}

export function buildAuthUrl(
  clientId: string,
  redirectUri: string,
  scopes: string[],
  challenge: string,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: scopes.join(" "),
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    access_type: "offline",
    prompt: "consent",
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Local callback server
// ---------------------------------------------------------------------------

const SUCCESS_HTML = `<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:60px">
<h1>Authorization successful</h1><p>You can close this window and return to the terminal.</p>
</body></html>`;

const ERROR_HTML = `<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:60px">
<h1>Authorization failed</h1><p>Check the terminal for details.</p>
</body></html>`;

export function waitForCallback(
  port: number = 3102,
  timeoutMs: number = 120000,
): Promise<{ code: string; state: string }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || "/", `http://localhost:${port}`);
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(ERROR_HTML);
        cleanup();
        reject(new Error(`Google OAuth error: ${error}`));
        return;
      }

      if (code && state) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(SUCCESS_HTML);
        cleanup();
        resolve({ code, state });
        return;
      }

      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Missing code or state parameter");
    });

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("OAuth callback timed out after " + (timeoutMs / 1000) + "s"));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      try { server.close(); } catch { /* ignore */ }
    }

    server.listen(port, "0.0.0.0", () => {
      log.info("OAuth callback server listening", { port });
    });

    server.on("error", (err) => {
      cleanup();
      reject(new Error(`Failed to start callback server on port ${port}: ${String(err)}`));
    });
  });
}

// ---------------------------------------------------------------------------
// Token exchange & refresh
// ---------------------------------------------------------------------------

export async function exchangeCode(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
  verifier: string,
): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
    code_verifier: verifier,
  });

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  const data = await res.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  if (!data.access_token) {
    throw new Error("Token exchange returned no access_token");
  }

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || "",
    expires_in: data.expires_in,
  };
}

export async function refreshAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<{ access_token: string; expires_in: number }> {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }

  const data = await res.json() as { access_token: string; expires_in: number };
  return { access_token: data.access_token, expires_in: data.expires_in };
}

export async function revokeToken(token: string): Promise<void> {
  const res = await fetch(`${GOOGLE_REVOKE_URL}?token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  if (!res.ok) {
    log.warn("Token revocation returned non-OK", { status: res.status });
  }
}

// ---------------------------------------------------------------------------
// Gmail profile
// ---------------------------------------------------------------------------

export async function fetchUserEmail(accessToken: string): Promise<string> {
  const res = await fetch(GMAIL_PROFILE_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to fetch Gmail profile (${res.status}): ${text}`);
  }

  const data = await res.json() as { emailAddress?: string };
  return data.emailAddress || "unknown";
}

// ---------------------------------------------------------------------------
// DB persistence (uses inline require to avoid client bundle issues)
// ---------------------------------------------------------------------------

function getOAuthDb(): ReturnType<typeof import("better-sqlite3")> | null {
  if (typeof window !== "undefined") return null;
  try {
    const Database = require("better-sqlite3");
    const path = require("node:path");
    const dbPath = path.resolve(process.env.DATABASE_PATH || "./data/disp8ch.db");
    const db = new Database(dbPath, { readonly: false });
    db.pragma(process.platform === "win32" ? "journal_mode = DELETE" : "journal_mode = WAL");
    return db;
  } catch {
    return null;
  }
}

function ensureGoogleOAuthTable(db: ReturnType<typeof import("better-sqlite3")>): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS google_oauth (
      id TEXT PRIMARY KEY DEFAULT 'default',
      email TEXT,
      client_id TEXT NOT NULL,
      client_secret TEXT NOT NULL,
      access_token TEXT,
      refresh_token TEXT,
      expires_at INTEGER,
      scopes TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
}

export function getStoredToken(): GoogleOAuthRow | null {
  const db = getOAuthDb();
  if (!db) return null;
  try {
    ensureGoogleOAuthTable(db);
    const row = db.prepare("SELECT * FROM google_oauth WHERE id = 'default'").get() as GoogleOAuthRow | undefined;
    return row || null;
  } finally {
    db.close();
  }
}

export function saveToken(data: {
  clientId: string;
  clientSecret: string;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scopes: string[];
  email?: string;
}): void {
  const db = getOAuthDb();
  if (!db) return;
  try {
    ensureGoogleOAuthTable(db);
    const expiresAt = Math.floor(Date.now() / 1000) + data.expiresIn;
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO google_oauth (id, email, client_id, client_secret, access_token, refresh_token, expires_at, scopes, created_at, updated_at)
      VALUES ('default', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        email = excluded.email,
        client_id = excluded.client_id,
        client_secret = excluded.client_secret,
        access_token = excluded.access_token,
        refresh_token = excluded.refresh_token,
        expires_at = excluded.expires_at,
        scopes = excluded.scopes,
        updated_at = excluded.updated_at
    `).run(
      data.email || null,
      data.clientId,
      data.clientSecret,
      data.accessToken,
      data.refreshToken,
      expiresAt,
      data.scopes.join(" "),
      now,
      now,
    );
  } finally {
    db.close();
  }
}

export function updateAccessToken(accessToken: string, expiresIn: number): void {
  const db = getOAuthDb();
  if (!db) return;
  try {
    ensureGoogleOAuthTable(db);
    const expiresAt = Math.floor(Date.now() / 1000) + expiresIn;
    const now = new Date().toISOString();
    db.prepare(
      "UPDATE google_oauth SET access_token = ?, expires_at = ?, updated_at = ? WHERE id = 'default'"
    ).run(accessToken, expiresAt, now);
  } finally {
    db.close();
  }
}

export function deleteToken(): void {
  const db = getOAuthDb();
  if (!db) return;
  try {
    ensureGoogleOAuthTable(db);
    db.prepare("DELETE FROM google_oauth WHERE id = 'default'").run();
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Auto-refresh logic
// ---------------------------------------------------------------------------

export async function getValidAccessToken(): Promise<string | null> {
  const stored = getStoredToken();
  if (!stored || !stored.access_token || !stored.refresh_token) return null;

  const nowSec = Math.floor(Date.now() / 1000);
  const bufferSec = 60;

  // Token still valid
  if (stored.expires_at && stored.expires_at > nowSec + bufferSec) {
    return stored.access_token;
  }

  // Token expired or about to expire — refresh
  try {
    log.info("Refreshing Google OAuth access token");
    const result = await refreshAccessToken(
      stored.client_id,
      stored.client_secret,
      stored.refresh_token,
    );
    updateAccessToken(result.access_token, result.expires_in);
    return result.access_token;
  } catch (err) {
    log.error("Failed to refresh Google OAuth token", { error: String(err) });
    return null;
  }
}

export { DEFAULT_SCOPES };
