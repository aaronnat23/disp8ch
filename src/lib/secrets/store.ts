import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getSqlite, initializeDatabase, withSqliteWriteRecovery } from "@/lib/db";
import { logger } from "@/lib/utils/logger";

const log = logger.child("secrets:store");

const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
const SECRET_MAX_LEN = 16_384;
const ENCRYPTION_PREFIX = "v1:";
const LOCAL_MASTER_KEY_FILE = ".disp8ch-secrets-key";

type SecretRow = {
  name: string;
  value_enc: string;
  source: string;
  created_at: string;
  updated_at: string;
};

export type SecretMeta = {
  name: string;
  source: string;
  createdAt: string;
  updatedAt: string;
};

function normalizeSecretName(name: string): string {
  return name.trim().toUpperCase();
}

function ensureSecretsTable(): void {
  const db = getSqlite();
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_secrets (
      name TEXT PRIMARY KEY,
      value_enc TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

function resolveMasterKey(): { key: Buffer; source: string } | null {
  const rawSecretsKey = String(process.env.SECRETS_MASTER_KEY ?? "").trim();
  const rawEncryptionKey = String(process.env.ENCRYPTION_KEY ?? "").trim();
  const raw = rawSecretsKey || rawEncryptionKey;
  if (!raw) return resolveLocalMasterKey();

  const source = rawSecretsKey ? "SECRETS_MASTER_KEY" : "ENCRYPTION_KEY";
  if (/^[a-fA-F0-9]{64}$/.test(raw)) {
    return { key: Buffer.from(raw, "hex"), source };
  }
  return {
    key: crypto.createHash("sha256").update(raw).digest(),
    source,
  };
}

function getLocalMasterKeyPath(): string {
  const dbPath = process.env.DATABASE_PATH || "./data/disp8ch.db";
  return path.join(path.dirname(path.resolve(dbPath)), LOCAL_MASTER_KEY_FILE);
}

function resolveLocalMasterKey(): { key: Buffer; source: string } | null {
  try {
    const keyPath = getLocalMasterKeyPath();
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    let raw = "";
    if (fs.existsSync(keyPath)) {
      raw = fs.readFileSync(keyPath, "utf8").trim();
    }
    if (!raw) {
      raw = crypto.randomBytes(32).toString("hex");
      fs.writeFileSync(keyPath, `${raw}\n`, { encoding: "utf8", mode: 0o600 });
    }
    if (/^[a-fA-F0-9]{64}$/.test(raw)) {
      return { key: Buffer.from(raw, "hex"), source: "local-key-file" };
    }
    return { key: crypto.createHash("sha256").update(raw).digest(), source: "local-key-file" };
  } catch (error) {
    log.warn("Local secrets master key unavailable", { error: String(error) });
    return null;
  }
}

function encryptSecret(plainText: string, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([iv, tag, encrypted]).toString("base64");
  return `${ENCRYPTION_PREFIX}${payload}`;
}

function decryptSecret(cipherText: string, key: Buffer): string {
  if (!cipherText.startsWith(ENCRYPTION_PREFIX)) {
    throw new Error("Unsupported secret encryption format");
  }
  const payload = Buffer.from(cipherText.slice(ENCRYPTION_PREFIX.length), "base64");
  if (payload.length < 29) {
    throw new Error("Invalid encrypted payload");
  }
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const encrypted = payload.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return plain.toString("utf8");
}

export function getSecretsStatus(): {
  masterKeyConfigured: boolean;
  keySource: string | null;
} {
  initializeDatabase();
  ensureSecretsTable();
  const key = resolveMasterKey();
  return {
    masterKeyConfigured: Boolean(key),
    keySource: key?.source ?? null,
  };
}

export function listSecretsMeta(): SecretMeta[] {
  initializeDatabase();
  ensureSecretsTable();
  const db = getSqlite();
  const rows = db
    .prepare("SELECT name, source, created_at, updated_at FROM app_secrets ORDER BY name ASC")
    .all() as Array<{ name: string; source: string; created_at: string; updated_at: string }>;
  return rows.map((row) => ({
    name: row.name,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export function upsertSecret(params: {
  name: string;
  value: string;
  source?: string;
}): SecretMeta {
  initializeDatabase();
  ensureSecretsTable();

  const name = normalizeSecretName(params.name);
  const value = String(params.value ?? "");
  if (!SECRET_NAME_RE.test(name)) {
    throw new Error("Secret name must match ^[A-Z][A-Z0-9_]{1,63}$");
  }
  if (!value.trim()) {
    throw new Error("Secret value is required");
  }
  if (value.length > SECRET_MAX_LEN) {
    throw new Error(`Secret value too large (max ${SECRET_MAX_LEN} chars)`);
  }

  const master = resolveMasterKey();
  if (!master) {
    throw new Error("No master key configured. Set ENCRYPTION_KEY or SECRETS_MASTER_KEY.");
  }
  const encrypted = encryptSecret(value, master.key);
  const now = new Date().toISOString();
  const source = String(params.source ?? "user").trim() || "user";
  withSqliteWriteRecovery("secrets:upsert", (db) => {
    db.prepare(`
      INSERT INTO app_secrets (name, value_enc, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        value_enc = excluded.value_enc,
        source = excluded.source,
        updated_at = excluded.updated_at
    `).run(name, encrypted, source, now, now);
  });

  const db = getSqlite();
  const row = db
    .prepare("SELECT name, source, created_at, updated_at FROM app_secrets WHERE name = ?")
    .get(name) as { name: string; source: string; created_at: string; updated_at: string } | undefined;
  if (!row) throw new Error("Secret was not saved");
  return {
    name: row.name,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function deleteSecret(name: string): boolean {
  initializeDatabase();
  ensureSecretsTable();
  const normalized = normalizeSecretName(name);
  if (!SECRET_NAME_RE.test(normalized)) return false;
  const db = getSqlite();
  const result = db.prepare("DELETE FROM app_secrets WHERE name = ?").run(normalized);
  return result.changes > 0;
}

function getSecretRow(name: string): SecretRow | undefined {
  initializeDatabase();
  ensureSecretsTable();
  const normalized = normalizeSecretName(name);
  if (!SECRET_NAME_RE.test(normalized)) return undefined;
  const db = getSqlite();
  return db
    .prepare("SELECT name, value_enc, source, created_at, updated_at FROM app_secrets WHERE name = ? LIMIT 1")
    .get(normalized) as SecretRow | undefined;
}

export function resolveSecretValue(name: string): string | null {
  const row = getSecretRow(name);
  if (!row) return null;
  const master = resolveMasterKey();
  if (!master) return null;
  try {
    return decryptSecret(row.value_enc, master.key);
  } catch (error) {
    log.warn("Secret decryption failed", { name: row.name, error: String(error) });
    return null;
  }
}

export function parseSecretReference(input: string): string | null {
  const raw = String(input ?? "").trim();
  if (!raw) return null;

  if (raw.startsWith("secret://")) {
    const candidate = normalizeSecretName(raw.slice("secret://".length));
    return SECRET_NAME_RE.test(candidate) ? candidate : null;
  }

  if (raw.startsWith("secret:")) {
    const candidate = normalizeSecretName(raw.slice("secret:".length));
    return SECRET_NAME_RE.test(candidate) ? candidate : null;
  }

  return null;
}
