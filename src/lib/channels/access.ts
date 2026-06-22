import crypto from "node:crypto";
import { getSqlite, initializeDatabase } from "@/lib/db";
import { logger } from "@/lib/utils/logger";

const log = logger.child("channels:access");

export type ChannelAccessMode = "open" | "allowlist" | "pairing";

export type ApprovedChannelSender = {
  channel: string;
  subjectKey: string;
  subjectLabel: string | null;
  approvedAt: string;
  createdAt: string;
  updatedAt: string;
};

export type PendingChannelPairing = {
  code: string;
  formattedCode: string;
  channel: string;
  subjectKey: string;
  subjectLabel: string | null;
  createdAt: string;
  expiresAt: string;
  ageMinutes: number;
  expiresInMinutes: number;
};

export type ChannelAccessDecision = {
  allowed: boolean;
  mode: ChannelAccessMode;
  reason:
    | "open"
    | "approved"
    | "allowlist-blocked"
    | "pairing-issued"
    | "pairing-pending"
    | "pairing-capacity";
  replyMessage?: string;
  code?: string | null;
  formattedCode?: string | null;
};

const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PAIRING_CODE_LENGTH = 8;
const PAIRING_TTL_MS = 60 * 60 * 1000;
const PAIRING_MAX_PENDING_PER_CHANNEL = 3;

function normalizeChannel(value: string): string {
  return String(value || "").trim().toLowerCase();
}

function normalizeSubjectKey(value: string): string {
  return String(value || "").trim();
}

function normalizeCode(value: string): string {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z2-9]/g, "")
    .slice(0, PAIRING_CODE_LENGTH);
}

function formatCode(value: string): string {
  const normalized = normalizeCode(value);
  if (normalized.length <= 4) return normalized;
  return `${normalized.slice(0, 4)}-${normalized.slice(4)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function futureIso(deltaMs: number): string {
  return new Date(Date.now() + deltaMs).toISOString();
}

function ensureChannelAccessState(): void {
  initializeDatabase();
}

function readModeRow(): { channel_access_mode?: string } | undefined {
  ensureChannelAccessState();
  return getSqlite()
    .prepare("SELECT channel_access_mode FROM app_config WHERE id = 'default'")
    .get() as { channel_access_mode?: string } | undefined;
}

function cleanupExpiredPairings(): void {
  ensureChannelAccessState();
  const now = nowIso();
  getSqlite()
    .prepare(
      "UPDATE channel_pairings SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?",
    )
    .run(now);
}

function findPendingPairing(
  channel: string,
  subjectKey: string,
): {
  code: string;
  created_at: string;
  expires_at: string;
} | null {
  cleanupExpiredPairings();
  return (
    (getSqlite()
      .prepare(
        "SELECT code, created_at, expires_at FROM channel_pairings WHERE channel = ? AND subject_key = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
      )
      .get(channel, subjectKey) as
      | { code: string; created_at: string; expires_at: string }
      | undefined) ?? null
  );
}

function generateCode(): string {
  let out = "";
  for (let index = 0; index < PAIRING_CODE_LENGTH; index += 1) {
    out += PAIRING_ALPHABET[crypto.randomInt(0, PAIRING_ALPHABET.length)];
  }
  return out;
}

function approvedRowToSender(row: {
  channel: string;
  subject_key: string;
  subject_label: string | null;
  approved_at: string;
  created_at: string;
  updated_at: string;
}): ApprovedChannelSender {
  return {
    channel: row.channel,
    subjectKey: row.subject_key,
    subjectLabel: row.subject_label,
    approvedAt: row.approved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function pendingRowToPairing(row: {
  code: string;
  channel: string;
  subject_key: string;
  subject_label: string | null;
  created_at: string;
  expires_at: string;
}): PendingChannelPairing {
  const createdAtMs = Date.parse(row.created_at);
  const expiresAtMs = Date.parse(row.expires_at);
  return {
    code: row.code,
    formattedCode: formatCode(row.code),
    channel: row.channel,
    subjectKey: row.subject_key,
    subjectLabel: row.subject_label,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    ageMinutes: Math.max(0, Math.floor((Date.now() - createdAtMs) / 60_000)),
    expiresInMinutes: Math.max(0, Math.ceil((expiresAtMs - Date.now()) / 60_000)),
  };
}

export function getChannelAccessMode(): ChannelAccessMode {
  const raw = String(readModeRow()?.channel_access_mode || "open").trim().toLowerCase();
  if (raw === "allowlist" || raw === "pairing") {
    return raw;
  }
  return "open";
}

export function setChannelAccessMode(mode: ChannelAccessMode): ChannelAccessMode {
  ensureChannelAccessState();
  getSqlite()
    .prepare("UPDATE app_config SET channel_access_mode = ?, updated_at = ? WHERE id = 'default'")
    .run(mode, nowIso());
  return getChannelAccessMode();
}

export function listApprovedChannelSenders(): ApprovedChannelSender[] {
  ensureChannelAccessState();
  const rows = getSqlite()
    .prepare(
      "SELECT channel, subject_key, subject_label, approved_at, created_at, updated_at FROM channel_sender_access ORDER BY approved_at DESC, channel ASC, subject_key ASC",
    )
    .all() as Array<{
      channel: string;
      subject_key: string;
      subject_label: string | null;
      approved_at: string;
      created_at: string;
      updated_at: string;
    }>;
  return rows.map(approvedRowToSender);
}

export function approveChannelSender(params: {
  channel: string;
  subjectKey: string;
  subjectLabel?: string | null;
}): ApprovedChannelSender {
  ensureChannelAccessState();
  const channel = normalizeChannel(params.channel);
  const subjectKey = normalizeSubjectKey(params.subjectKey);
  if (!channel || !subjectKey) {
    throw new Error("channel and subjectKey are required");
  }
  const subjectLabel = String(params.subjectLabel || "").trim() || null;
  const now = nowIso();
  getSqlite()
    .prepare(
      `
        INSERT INTO channel_sender_access (channel, subject_key, subject_label, approved_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(channel, subject_key) DO UPDATE SET
          subject_label = excluded.subject_label,
          approved_at = excluded.approved_at,
          updated_at = excluded.updated_at
      `,
    )
    .run(channel, subjectKey, subjectLabel, now, now, now);
  return (
    listApprovedChannelSenders().find(
      (entry) => entry.channel === channel && entry.subjectKey === subjectKey,
    ) ?? {
      channel,
      subjectKey,
      subjectLabel,
      approvedAt: now,
      createdAt: now,
      updatedAt: now,
    }
  );
}

export function revokeChannelSender(params: {
  channel: string;
  subjectKey: string;
}): boolean {
  ensureChannelAccessState();
  const channel = normalizeChannel(params.channel);
  const subjectKey = normalizeSubjectKey(params.subjectKey);
  if (!channel || !subjectKey) return false;
  const result = getSqlite()
    .prepare("DELETE FROM channel_sender_access WHERE channel = ? AND subject_key = ?")
    .run(channel, subjectKey);
  return result.changes > 0;
}

export function isChannelSenderApproved(params: {
  channel: string;
  subjectKey: string;
}): boolean {
  ensureChannelAccessState();
  const channel = normalizeChannel(params.channel);
  const subjectKey = normalizeSubjectKey(params.subjectKey);
  if (!channel || !subjectKey) return false;
  const row = getSqlite()
    .prepare(
      "SELECT 1 FROM channel_sender_access WHERE channel = ? AND subject_key = ? LIMIT 1",
    )
    .get(channel, subjectKey) as Record<string, unknown> | undefined;
  return Boolean(row);
}

function createPairing(
  channel: string,
  subjectKey: string,
  subjectLabel: string | null,
): PendingChannelPairing | null {
  const pendingCount = getSqlite()
    .prepare("SELECT COUNT(*) AS n FROM channel_pairings WHERE channel = ? AND status = 'pending'")
    .get(channel) as { n?: number } | undefined;
  if ((pendingCount?.n ?? 0) >= PAIRING_MAX_PENDING_PER_CHANNEL) {
    return null;
  }

  let code: string | null = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = generateCode();
    const exists = getSqlite()
      .prepare("SELECT 1 FROM channel_pairings WHERE code = ? LIMIT 1")
      .get(candidate) as Record<string, unknown> | undefined;
    if (!exists) {
      code = candidate;
      break;
    }
  }
  if (!code) return null;

  const createdAt = nowIso();
  const expiresAt = futureIso(PAIRING_TTL_MS);
  getSqlite()
    .prepare(
      "INSERT INTO channel_pairings (code, channel, subject_key, subject_label, status, created_at, expires_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)",
    )
    .run(code, channel, subjectKey, subjectLabel, createdAt, expiresAt);
  return pendingRowToPairing({
    code,
    channel,
    subject_key: subjectKey,
    subject_label: subjectLabel,
    created_at: createdAt,
    expires_at: expiresAt,
  });
}

export function listPendingChannelPairings(): PendingChannelPairing[] {
  cleanupExpiredPairings();
  const rows = getSqlite()
    .prepare(
      "SELECT code, channel, subject_key, subject_label, created_at, expires_at FROM channel_pairings WHERE status = 'pending' ORDER BY created_at DESC",
    )
    .all() as Array<{
      code: string;
      channel: string;
      subject_key: string;
      subject_label: string | null;
      created_at: string;
      expires_at: string;
    }>;
  return rows.map(pendingRowToPairing);
}

export function approveChannelPairing(codeRaw: string): ApprovedChannelSender | null {
  cleanupExpiredPairings();
  const code = normalizeCode(codeRaw);
  if (!code) return null;
  const row = getSqlite()
    .prepare(
      "SELECT channel, subject_key, subject_label FROM channel_pairings WHERE code = ? AND status = 'pending' LIMIT 1",
    )
    .get(code) as { channel: string; subject_key: string; subject_label: string | null } | undefined;
  if (!row) return null;

  const approved = approveChannelSender({
    channel: row.channel,
    subjectKey: row.subject_key,
    subjectLabel: row.subject_label,
  });
  const now = nowIso();
  getSqlite()
    .prepare(
      "UPDATE channel_pairings SET status = 'approved', approved_at = ? WHERE channel = ? AND subject_key = ? AND status = 'pending'",
    )
    .run(now, row.channel, row.subject_key);
  return approved;
}

export function denyChannelPairing(codeRaw: string): boolean {
  cleanupExpiredPairings();
  const code = normalizeCode(codeRaw);
  if (!code) return false;
  const result = getSqlite()
    .prepare("UPDATE channel_pairings SET status = 'denied', denied_at = ? WHERE code = ? AND status = 'pending'")
    .run(nowIso(), code);
  return result.changes > 0;
}

export function getChannelAccessOverview(): {
  mode: ChannelAccessMode;
  approved: ApprovedChannelSender[];
  pending: PendingChannelPairing[];
  limits: {
    ttlMinutes: number;
    maxPendingPerChannel: number;
  };
} {
  return {
    mode: getChannelAccessMode(),
    approved: listApprovedChannelSenders(),
    pending: listPendingChannelPairings(),
    limits: {
      ttlMinutes: Math.round(PAIRING_TTL_MS / 60_000),
      maxPendingPerChannel: PAIRING_MAX_PENDING_PER_CHANNEL,
    },
  };
}

export function evaluateChannelAccess(params: {
  channel: string;
  subjectKey: string;
  subjectLabel?: string | null;
}): ChannelAccessDecision {
  ensureChannelAccessState();
  const channel = normalizeChannel(params.channel);
  const subjectKey = normalizeSubjectKey(params.subjectKey);
  const subjectLabel = String(params.subjectLabel || "").trim() || null;
  const mode = getChannelAccessMode();

  if (!channel || !subjectKey) {
    return {
      allowed: false,
      mode,
      reason: "allowlist-blocked",
      replyMessage: "This channel could not verify your sender identity. Access is blocked.",
    };
  }

  if (mode === "open") {
    return { allowed: true, mode, reason: "open" };
  }

  if (isChannelSenderApproved({ channel, subjectKey })) {
    return { allowed: true, mode, reason: "approved" };
  }

  if (mode === "allowlist") {
    return {
      allowed: false,
      mode,
      reason: "allowlist-blocked",
      replyMessage:
        "This channel is restricted. Ask the operator to approve your sender ID before using the bot.",
    };
  }

  const existing = findPendingPairing(channel, subjectKey);
  if (existing) {
    return {
      allowed: false,
      mode,
      reason: "pairing-pending",
      code: existing.code,
      formattedCode: formatCode(existing.code),
      replyMessage:
        `This channel is restricted. Share pairing code ${formatCode(existing.code)} with the operator to approve access.`,
    };
  }

  const pairing = createPairing(channel, subjectKey, subjectLabel);
  if (!pairing) {
    log.warn("Channel pairing capacity reached", { channel, subjectKey });
    return {
      allowed: false,
      mode,
      reason: "pairing-capacity",
      replyMessage:
        "This channel is restricted and pairing capacity is full right now. Ask the operator to clear pending access requests.",
    };
  }

  return {
    allowed: false,
    mode,
    reason: "pairing-issued",
    code: pairing.code,
    formattedCode: pairing.formattedCode,
    replyMessage:
      `This channel is restricted. Share pairing code ${pairing.formattedCode} with the operator to approve access.`,
  };
}
