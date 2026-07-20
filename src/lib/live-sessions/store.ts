import crypto from "node:crypto";
import { nanoid } from "nanoid";
import { getSqlite, initializeDatabase } from "@/lib/db";
import { appendWorkTrailEvent, createWorkTrail } from "@/lib/work-trails/work-trails";
import type { LiveSession, LiveSessionDetail, LiveSessionSegment, LiveSessionStatus, TranscriptAnalysis } from "./types";

type Row = Record<string, unknown>;

function json(value: unknown): Record<string, unknown> {
  try { return JSON.parse(String(value || "{}")) as Record<string, unknown>; } catch { return {}; }
}

function ensureTables() {
  initializeDatabase();
  const db = getSqlite();
  db.exec(`
    CREATE TABLE IF NOT EXISTS live_sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      source TEXT NOT NULL,
      language TEXT,
      stt_provider TEXT,
      consent_confirmed_at TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      notebook_id TEXT,
      work_trail_id TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS live_session_segments (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      start_ms INTEGER NOT NULL,
      end_ms INTEGER NOT NULL,
      speaker_label TEXT,
      text TEXT NOT NULL DEFAULT '',
      confidence REAL,
      provider_segment_id TEXT,
      audio_sha256 TEXT NOT NULL,
      status TEXT NOT NULL,
      timestamp_precision TEXT NOT NULL DEFAULT 'chunk',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(session_id) REFERENCES live_sessions(id) ON DELETE CASCADE,
      UNIQUE(session_id, sequence, audio_sha256)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_live_segments_sequence ON live_session_segments(session_id, sequence);
    CREATE INDEX IF NOT EXISTS idx_live_sessions_updated ON live_sessions(updated_at DESC);
  `);
  return db;
}

function mapSession(row: Row): LiveSession {
  return {
    id: String(row.id), title: String(row.title), status: String(row.status) as LiveSessionStatus,
    source: String(row.source) as LiveSession["source"], language: row.language ? String(row.language) : null,
    sttProvider: row.stt_provider ? String(row.stt_provider) : null,
    consentConfirmedAt: String(row.consent_confirmed_at), startedAt: String(row.started_at),
    endedAt: row.ended_at ? String(row.ended_at) : null, notebookId: row.notebook_id ? String(row.notebook_id) : null,
    workTrailId: row.work_trail_id ? String(row.work_trail_id) : null, metadata: json(row.metadata_json),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function mapSegment(row: Row): LiveSessionSegment {
  return {
    id: String(row.id), sessionId: String(row.session_id), sequence: Number(row.sequence),
    startMs: Number(row.start_ms), endMs: Number(row.end_ms), speakerLabel: row.speaker_label ? String(row.speaker_label) : null,
    text: String(row.text || ""), confidence: row.confidence == null ? null : Number(row.confidence),
    providerSegmentId: row.provider_segment_id ? String(row.provider_segment_id) : null,
    audioSha256: String(row.audio_sha256), status: String(row.status) as LiveSessionSegment["status"],
    timestampPrecision: String(row.timestamp_precision || "chunk") as LiveSessionSegment["timestampPrecision"],
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

export function createLiveSession(input: {
  title?: string; language?: string | null; source?: LiveSession["source"];
  consentConfirmed: boolean; workTrailId?: string | null; metadata?: Record<string, unknown>;
}): LiveSessionDetail {
  if (!input.consentConfirmed) throw new Error("Recording/transcription consent must be confirmed.");
  const db = ensureTables();
  const now = new Date().toISOString();
  const id = `live_${nanoid(16)}`;
  const trail = input.workTrailId ? null : createWorkTrail({
    userMessage: input.title?.trim() || "Live session",
    intent: { kind: "live_session", source: input.source || "microphone", objectId: id },
    status: "executing",
  });
  const trailId = input.workTrailId || trail || null;
  db.prepare(`INSERT INTO live_sessions
    (id,title,status,source,language,stt_provider,consent_confirmed_at,started_at,ended_at,notebook_id,work_trail_id,metadata_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,NULL,NULL,?,?,?,?)`).run(
      id, input.title?.trim() || `Live session ${new Date().toLocaleString()}`, "recording", input.source || "microphone",
      input.language?.trim() || null, null, now, now, trailId, JSON.stringify(input.metadata || {}), now, now,
    );
  if (trailId) appendWorkTrailEvent({ trailId, eventType: "live_session_started", surface: "sessions", objectType: "live-session", objectId: id, objectName: input.title || "Live session", summary: "Recording consent confirmed" });
  return getLiveSession(id)!;
}

export function listLiveSessions(limit = 30): LiveSession[] {
  const db = ensureTables();
  return (db.prepare("SELECT * FROM live_sessions ORDER BY updated_at DESC LIMIT ?").all(Math.min(Math.max(limit, 1), 100)) as Row[]).map(mapSession);
}

export function getLiveSession(id: string): LiveSessionDetail | null {
  const db = ensureTables();
  const row = db.prepare("SELECT * FROM live_sessions WHERE id = ?").get(id) as Row | undefined;
  if (!row) return null;
  const segments = (db.prepare("SELECT * FROM live_session_segments WHERE session_id = ? ORDER BY sequence ASC").all(id) as Row[]).map(mapSegment);
  return { ...mapSession(row), segments };
}

export function saveLiveSessionAnalysis(id: string, analysis: TranscriptAnalysis): LiveSessionDetail {
  const db = ensureTables();
  const session = getLiveSession(id);
  if (!session) throw new Error("Live session not found.");
  const now = new Date().toISOString();
  const metadata = {
    ...session.metadata,
    transcriptAnalysis: analysis,
    transcriptAnalysisUpdatedAt: now,
  };
  db.prepare("UPDATE live_sessions SET metadata_json=?,updated_at=? WHERE id=?").run(JSON.stringify(metadata), now, id);
  return getLiveSession(id)!;
}

export function beginLiveSegment(input: { sessionId: string; sequence: number; startMs: number; endMs: number; audioSha256: string }): LiveSessionSegment {
  const db = ensureTables();
  const session = getLiveSession(input.sessionId);
  if (!session) throw new Error("Live session not found.");
  if (!Number.isInteger(input.sequence) || input.sequence < 0) throw new Error("Invalid segment sequence.");
  if (!/^[a-f0-9]{64}$/i.test(input.audioSha256)) throw new Error("Invalid audio SHA-256.");
  const existing = db.prepare("SELECT * FROM live_session_segments WHERE session_id = ? AND sequence = ?").get(input.sessionId, input.sequence) as Row | undefined;
  if (existing) {
    if (String(existing.audio_sha256) !== input.audioSha256) throw new Error("Sequence already exists with different audio content.");
    return mapSegment(existing);
  }
  const now = new Date().toISOString();
  const id = `segment_${nanoid(16)}`;
  db.prepare(`INSERT INTO live_session_segments
    (id,session_id,sequence,start_ms,end_ms,speaker_label,text,confidence,provider_segment_id,audio_sha256,status,timestamp_precision,created_at,updated_at)
    VALUES (?,?,?,?,?,NULL,'',NULL,NULL,?,'processing','chunk',?,?)`).run(
      id, input.sessionId, input.sequence, Math.max(0, Math.round(input.startMs)), Math.max(input.startMs, Math.round(input.endMs)), input.audioSha256.toLowerCase(), now, now,
    );
  return mapSegment(db.prepare("SELECT * FROM live_session_segments WHERE id = ?").get(id) as Row);
}

export function completeLiveSegment(input: {
  segmentId: string; text: string; provider: string; confidence?: number | null;
  providerSegmentId?: string | null; timestampPrecision?: LiveSessionSegment["timestampPrecision"];
}): LiveSessionSegment {
  const db = ensureTables();
  const now = new Date().toISOString();
  db.prepare(`UPDATE live_session_segments SET text=?,confidence=?,provider_segment_id=?,status='complete',timestamp_precision=?,updated_at=? WHERE id=?`).run(
    input.text.trim().slice(0, 100_000), input.confidence ?? null, input.providerSegmentId ?? null, input.timestampPrecision || "chunk", now, input.segmentId,
  );
  const row = db.prepare("SELECT * FROM live_session_segments WHERE id = ?").get(input.segmentId) as Row | undefined;
  if (!row) throw new Error("Live session segment not found.");
  db.prepare("UPDATE live_sessions SET stt_provider=?, updated_at=? WHERE id=?").run(input.provider, now, row.session_id);
  return mapSegment(row);
}

export function failLiveSegment(segmentId: string): void {
  ensureTables().prepare("UPDATE live_session_segments SET status='failed',updated_at=? WHERE id=?").run(new Date().toISOString(), segmentId);
}

export function updateLiveSegment(input: { sessionId: string; segmentId: string; text?: string; speakerLabel?: string | null }): LiveSessionSegment {
  const db = ensureTables();
  const existing = db.prepare("SELECT * FROM live_session_segments WHERE id=? AND session_id=?").get(input.segmentId, input.sessionId) as Row | undefined;
  if (!existing) throw new Error("Live session segment not found.");
  const text = input.text === undefined ? String(existing.text) : input.text.trim().slice(0, 100_000);
  const speaker = input.speakerLabel === undefined ? existing.speaker_label : input.speakerLabel?.trim().slice(0, 100) || null;
  db.prepare("UPDATE live_session_segments SET text=?,speaker_label=?,updated_at=? WHERE id=?").run(text, speaker, new Date().toISOString(), input.segmentId);
  return mapSegment(db.prepare("SELECT * FROM live_session_segments WHERE id=?").get(input.segmentId) as Row);
}

export function setLiveSessionStatus(id: string, status: LiveSessionStatus): LiveSessionDetail {
  const db = ensureTables();
  const existing = getLiveSession(id);
  if (!existing) throw new Error("Live session not found.");
  if (existing.status === "complete" && status === "complete") return existing;
  const now = new Date().toISOString();
  const endedAt = status === "complete" || status === "error" ? existing.endedAt || now : existing.endedAt;
  db.prepare("UPDATE live_sessions SET status=?,ended_at=?,updated_at=? WHERE id=?").run(status, endedAt, now, id);
  const updated = getLiveSession(id)!;
  if (updated.workTrailId && status === "complete" && existing.status !== "complete") {
    appendWorkTrailEvent({ trailId: updated.workTrailId, eventType: "live_session_stopped", surface: "sessions", objectType: "live-session", objectId: id, summary: `${updated.segments.length} transcript segments` });
  }
  return updated;
}

export function addFixtureSegments(sessionId: string, items: Array<{ startMs: number; endMs: number; speaker?: string; text: string }>): LiveSessionDetail {
  for (let sequence = 0; sequence < items.length; sequence++) {
    const item = items[sequence];
    const hash = crypto.createHash("sha256").update(`${sequence}\0${item.text}`).digest("hex");
    const segment = beginLiveSegment({ sessionId, sequence, startMs: item.startMs, endMs: item.endMs, audioSha256: hash });
    completeLiveSegment({ segmentId: segment.id, text: item.text, provider: "fixture", timestampPrecision: "fixture" });
    updateLiveSegment({ sessionId, segmentId: segment.id, speakerLabel: item.speaker || null });
  }
  return setLiveSessionStatus(sessionId, "complete");
}

export function linkLiveSessionNotebook(sessionId: string, notebookId: string): LiveSessionDetail {
  const db = ensureTables();
  const session = getLiveSession(sessionId);
  if (!session) throw new Error("Live session not found.");
  db.prepare("UPDATE live_sessions SET notebook_id=?,updated_at=? WHERE id=?").run(notebookId, new Date().toISOString(), sessionId);
  if (session.workTrailId) appendWorkTrailEvent({ trailId: session.workTrailId, eventType: "live_session_saved", surface: "sources", objectType: "notebook", objectId: notebookId, summary: `Transcript from ${sessionId}` });
  return getLiveSession(sessionId)!;
}
