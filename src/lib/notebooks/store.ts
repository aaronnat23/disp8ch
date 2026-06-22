// Server-only notebook persistence over existing document sources.
import { nanoid } from "nanoid";
import { getSqlite, initializeDatabase, withSqliteWriteRecovery } from "@/lib/db";
import { getDocumentById } from "@/lib/documents/store";
import { searchDocumentsSemantic, type DocumentChunkRecord } from "@/lib/documents/chunks";

export type NotebookContextMode = "off" | "summary" | "full";
export type NotebookNoteOrigin = "user" | "assistant" | "insight";
export type NotebookOutputType = "mind_map" | "timeline" | "audio_script" | "json";

export type NotebookRecord = {
  id: string;
  name: string;
  description: string | null;
  settings: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  documentCount?: number;
  noteCount?: number;
};

export type NotebookDocumentRecord = {
  notebookId: string;
  documentId: string;
  documentName: string;
  contextMode: NotebookContextMode;
  createdAt: string;
  updatedAt: string;
};

export type NotebookNoteRecord = {
  id: string;
  notebookId: string;
  title: string;
  contentMd: string;
  origin: NotebookNoteOrigin;
  createdAt: string;
  updatedAt: string;
};

export type NotebookTransformationRecord = {
  id: string;
  name: string;
  prompt: string;
  builtIn: boolean;
  applyOnIngest: boolean;
  createdAt: string;
  updatedAt: string;
};

export type DocumentInsightRecord = {
  id: string;
  documentId: string;
  notebookId: string | null;
  transformationId: string;
  contentMd: string;
  createdAt: string;
};

export type NotebookOutputRecord = {
  id: string;
  notebookId: string;
  type: NotebookOutputType;
  title: string;
  payload: Record<string, unknown>;
  version: number;
  createdAt: string;
  updatedAt: string;
};

const BUILT_IN_TRANSFORMATIONS: Array<{ id: string; name: string; prompt: string }> = [
  { id: "summary", name: "Summary", prompt: "Summarize the source into the most important claims and caveats." },
  { id: "key-topics", name: "Key Topics", prompt: "Extract the key topics and explain why each matters." },
  { id: "faq", name: "FAQ", prompt: "Create a concise FAQ from the source." },
  { id: "study-guide", name: "Study Guide", prompt: "Create a study guide with major concepts and review questions." },
  { id: "briefing", name: "Briefing", prompt: "Write an executive briefing with decisions, risks, and follow-ups." },
  { id: "timeline", name: "Timeline", prompt: "Extract dated events and temporal sequence from the source." },
  { id: "glossary", name: "Glossary", prompt: "Extract important terms and short definitions." },
];

function ensureNotebookTables() {
  initializeDatabase();
  const db = getSqlite();
  db.exec(`
    CREATE TABLE IF NOT EXISTS notebooks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      settings_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notebooks_updated_at ON notebooks(updated_at DESC);

    CREATE TABLE IF NOT EXISTS notebook_documents (
      notebook_id TEXT NOT NULL,
      document_id TEXT NOT NULL,
      context_mode TEXT NOT NULL DEFAULT 'summary',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (notebook_id, document_id)
    );

    CREATE TABLE IF NOT EXISTS notebook_notes (
      id TEXT PRIMARY KEY,
      notebook_id TEXT NOT NULL,
      title TEXT NOT NULL,
      content_md TEXT NOT NULL,
      origin TEXT NOT NULL DEFAULT 'user',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notebook_transformations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      built_in INTEGER NOT NULL DEFAULT 0,
      apply_on_ingest INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS document_insights (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      notebook_id TEXT,
      transformation_id TEXT NOT NULL,
      content_md TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notebook_outputs (
      id TEXT PRIMARY KEY,
      notebook_id TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  seedBuiltInTransformations(db);
  return db;
}

function seedBuiltInTransformations(db = getSqlite()) {
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO notebook_transformations
      (id, name, prompt, built_in, apply_on_ingest, created_at, updated_at)
     VALUES (?, ?, ?, 1, 0, ?, ?)`,
  );
  for (const item of BUILT_IN_TRANSFORMATIONS) {
    stmt.run(item.id, item.name, item.prompt, now, now);
  }
}

function parseJsonObject(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeContextMode(value: unknown): NotebookContextMode {
  const mode = String(value || "summary").trim().toLowerCase();
  return mode === "off" || mode === "full" ? mode : "summary";
}

function normalizeOrigin(value: unknown): NotebookNoteOrigin {
  const origin = String(value || "user").trim().toLowerCase();
  return origin === "assistant" || origin === "insight" ? origin : "user";
}

function mapNotebook(row: any): NotebookRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    settings: parseJsonObject(row.settings_json ?? null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    documentCount: Number(row.document_count ?? 0),
    noteCount: Number(row.note_count ?? 0),
  };
}

function mapNote(row: any): NotebookNoteRecord {
  return {
    id: row.id,
    notebookId: row.notebook_id,
    title: row.title,
    contentMd: row.content_md,
    origin: normalizeOrigin(row.origin),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTransformation(row: any): NotebookTransformationRecord {
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    builtIn: Number(row.built_in || 0) === 1,
    applyOnIngest: Number(row.apply_on_ingest || 0) === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapOutput(row: any): NotebookOutputRecord {
  return {
    id: row.id,
    notebookId: row.notebook_id,
    type: row.type,
    title: row.title,
    payload: parseJsonObject(row.payload_json),
    version: Number(row.version || 1),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listNotebooks(): NotebookRecord[] {
  const db = ensureNotebookTables();
  return db
    .prepare(
      `SELECT n.*,
              COUNT(DISTINCT nd.document_id) AS document_count,
              COUNT(DISTINCT nn.id) AS note_count
         FROM notebooks n
         LEFT JOIN notebook_documents nd ON nd.notebook_id = n.id
         LEFT JOIN notebook_notes nn ON nn.notebook_id = n.id
        GROUP BY n.id
        ORDER BY n.updated_at DESC`,
    )
    .all()
    .map(mapNotebook);
}

export function createNotebook(params: {
  name: string;
  description?: string | null;
  settings?: Record<string, unknown>;
}): NotebookRecord {
  const db = ensureNotebookTables();
  const id = nanoid(12);
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO notebooks (id, name, description, settings_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    id,
    params.name.trim() || "Untitled Notebook",
    params.description?.trim() || null,
    JSON.stringify(params.settings || {}),
    now,
    now,
  );
  return getNotebook(id)!;
}

export function getNotebook(id: string): NotebookRecord | null {
  const db = ensureNotebookTables();
  const row = db
    .prepare(
      `SELECT n.*,
              COUNT(DISTINCT nd.document_id) AS document_count,
              COUNT(DISTINCT nn.id) AS note_count
         FROM notebooks n
         LEFT JOIN notebook_documents nd ON nd.notebook_id = n.id
         LEFT JOIN notebook_notes nn ON nn.notebook_id = n.id
        WHERE n.id = ?
        GROUP BY n.id`,
    )
    .get(id);
  return row ? mapNotebook(row) : null;
}

export function updateNotebook(id: string, params: Partial<{ name: string; description: string | null; settings: Record<string, unknown> }>): NotebookRecord | null {
  const existing = getNotebook(id);
  if (!existing) return null;
  const db = ensureNotebookTables();
  const now = new Date().toISOString();
  db.prepare("UPDATE notebooks SET name = ?, description = ?, settings_json = ?, updated_at = ? WHERE id = ?").run(
    params.name?.trim() || existing.name,
    params.description === undefined ? existing.description : params.description,
    JSON.stringify(params.settings || existing.settings),
    now,
    id,
  );
  return getNotebook(id);
}

export function deleteNotebook(id: string): boolean {
  const db = ensureNotebookTables();
  const existing = getNotebook(id);
  if (!existing) return false;
  withSqliteWriteRecovery("notebook-delete", (database) => {
    database.prepare("DELETE FROM notebook_documents WHERE notebook_id = ?").run(id);
    database.prepare("DELETE FROM notebook_notes WHERE notebook_id = ?").run(id);
    database.prepare("DELETE FROM document_insights WHERE notebook_id = ?").run(id);
    database.prepare("DELETE FROM notebook_outputs WHERE notebook_id = ?").run(id);
    database.prepare("DELETE FROM notebooks WHERE id = ?").run(id);
  });
  return true;
}

export function listNotebookDocuments(notebookId: string): NotebookDocumentRecord[] {
  const db = ensureNotebookTables();
  return db
    .prepare(
      `SELECT nd.*, d.name AS document_name
         FROM notebook_documents nd
         JOIN documents d ON d.id = nd.document_id
        WHERE nd.notebook_id = ?
        ORDER BY nd.created_at ASC`,
    )
    .all(notebookId)
    .map((row: any) => ({
      notebookId: row.notebook_id,
      documentId: row.document_id,
      documentName: row.document_name,
      contextMode: normalizeContextMode(row.context_mode),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
}

export function setNotebookDocument(params: {
  notebookId: string;
  documentId: string;
  contextMode?: NotebookContextMode;
}): NotebookDocumentRecord {
  const db = ensureNotebookTables();
  const notebook = getNotebook(params.notebookId);
  if (!notebook) throw new Error("Notebook not found");
  const document = getDocumentById(params.documentId);
  if (!document) throw new Error("Document not found");
  const mode = normalizeContextMode(params.contextMode);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO notebook_documents (notebook_id, document_id, context_mode, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(notebook_id, document_id) DO UPDATE SET context_mode = excluded.context_mode, updated_at = excluded.updated_at`,
  ).run(params.notebookId, params.documentId, mode, now, now);
  db.prepare("UPDATE notebooks SET updated_at = ? WHERE id = ?").run(now, params.notebookId);
  return listNotebookDocuments(params.notebookId).find((item) => item.documentId === params.documentId)!;
}

export function removeNotebookDocument(notebookId: string, documentId: string): boolean {
  const db = ensureNotebookTables();
  const result = db.prepare("DELETE FROM notebook_documents WHERE notebook_id = ? AND document_id = ?").run(notebookId, documentId);
  db.prepare("UPDATE notebooks SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), notebookId);
  return result.changes > 0;
}

export function listNotebookNotes(notebookId: string): NotebookNoteRecord[] {
  const db = ensureNotebookTables();
  return db
    .prepare("SELECT * FROM notebook_notes WHERE notebook_id = ? ORDER BY updated_at DESC")
    .all(notebookId)
    .map(mapNote);
}

export function createNotebookNote(params: {
  notebookId: string;
  title: string;
  contentMd: string;
  origin?: NotebookNoteOrigin;
}): NotebookNoteRecord {
  const db = ensureNotebookTables();
  if (!getNotebook(params.notebookId)) throw new Error("Notebook not found");
  const id = nanoid(12);
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO notebook_notes (id, notebook_id, title, content_md, origin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(id, params.notebookId, params.title.trim() || "Untitled Note", params.contentMd || "", normalizeOrigin(params.origin), now, now);
  db.prepare("UPDATE notebooks SET updated_at = ? WHERE id = ?").run(now, params.notebookId);
  return listNotebookNotes(params.notebookId).find((note) => note.id === id)!;
}

export function listNotebookTransformations(): NotebookTransformationRecord[] {
  const db = ensureNotebookTables();
  return db.prepare("SELECT * FROM notebook_transformations ORDER BY built_in DESC, name ASC").all().map(mapTransformation);
}

export function createNotebookTransformation(params: {
  name: string;
  prompt: string;
  applyOnIngest?: boolean;
}): NotebookTransformationRecord {
  const db = ensureNotebookTables();
  const id = nanoid(12);
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO notebook_transformations (id, name, prompt, built_in, apply_on_ingest, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?)",
  ).run(id, params.name.trim(), params.prompt.trim(), params.applyOnIngest ? 1 : 0, now, now);
  return listNotebookTransformations().find((item) => item.id === id)!;
}

export async function askNotebook(params: {
  notebookId?: string;
  query: string;
  limit?: number;
}): Promise<{ answerMd: string; citations: DocumentChunkRecord[] }> {
  const hits = await searchDocumentsSemantic(params.query, {
    notebookId: params.notebookId,
    limit: params.limit || 6,
  });
  if (hits.length === 0) {
    return {
      answerMd: params.notebookId
        ? "The selected notebook sources do not contain enough indexed evidence to answer that."
        : "The document library does not contain enough indexed evidence to answer that.",
      citations: [],
    };
  }
  const bullets = hits.slice(0, 5).map((hit) => {
    const text = hit.text.replace(/\s+/g, " ").trim().slice(0, 360);
    return `- ${text} [${hit.citation}]`;
  });
  return {
    answerMd: [`Evidence found for: ${params.query}`, "", ...bullets].join("\n"),
    citations: hits,
  };
}

export function runNotebookTransformation(params: {
  notebookId?: string;
  documentId: string;
  transformationId: string;
}): DocumentInsightRecord {
  const db = ensureNotebookTables();
  const document = getDocumentById(params.documentId);
  if (!document) throw new Error("Document not found");
  const transformation = listNotebookTransformations().find((item) => item.id === params.transformationId);
  if (!transformation) throw new Error("Transformation not found");
  const text = document.extractedText.replace(/\s+/g, " ").trim();
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean).slice(0, 8);
  const content = [
    `### ${transformation.name}: ${document.name}`,
    "",
    `Prompt: ${transformation.prompt}`,
    "",
    ...sentences.map((sentence) => `- ${sentence.slice(0, 420)}`),
  ].join("\n");
  const id = nanoid(12);
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO document_insights (id, document_id, notebook_id, transformation_id, content_md, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, params.documentId, params.notebookId || null, params.transformationId, content, now);
  return {
    id,
    documentId: params.documentId,
    notebookId: params.notebookId || null,
    transformationId: params.transformationId,
    contentMd: content,
    createdAt: now,
  };
}

export async function createNotebookOutput(params: {
  notebookId: string;
  type: NotebookOutputType;
  title?: string;
  query?: string;
}): Promise<NotebookOutputRecord> {
  const db = ensureNotebookTables();
  if (!getNotebook(params.notebookId)) throw new Error("Notebook not found");
  const query = params.query || "overview";
  const hits = await searchDocumentsSemantic(query, { notebookId: params.notebookId, limit: 10 });
  const payload = buildOutputPayload(params.type, hits);
  const id = nanoid(12);
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO notebook_outputs (id, notebook_id, type, title, payload_json, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
  ).run(id, params.notebookId, params.type, params.title || defaultOutputTitle(params.type), JSON.stringify(payload), now, now);
  return listNotebookOutputs(params.notebookId).find((item) => item.id === id)!;
}

function defaultOutputTitle(type: NotebookOutputType): string {
  if (type === "mind_map") return "Mind Map";
  if (type === "timeline") return "Timeline";
  if (type === "audio_script") return "Audio Overview Script";
  return "Notebook Output";
}

function buildOutputPayload(type: NotebookOutputType, hits: DocumentChunkRecord[]): Record<string, unknown> {
  if (type === "mind_map") {
    return {
      nodes: [
        {
          label: "Notebook",
          citations: hits.slice(0, 2).map((hit) => hit.citation),
          children: hits.slice(0, 6).map((hit) => ({
            label: hit.text.replace(/\s+/g, " ").trim().slice(0, 80) || hit.documentName,
            citations: [hit.citation],
            children: [],
          })),
        },
      ],
    };
  }
  if (type === "timeline") {
    return {
      events: hits.slice(0, 8).map((hit, index) => ({
        label: hit.text.replace(/\s+/g, " ").trim().slice(0, 120),
        date: null,
        order: index + 1,
        citations: [hit.citation],
      })),
    };
  }
  if (type === "audio_script") {
    return {
      ttsConfigured: false,
      script: hits.length
        ? hits.slice(0, 6).map((hit, index) => `Speaker ${index % 2 === 0 ? "A" : "B"}: ${hit.text.replace(/\s+/g, " ").trim().slice(0, 260)} [${hit.citation}]`).join("\n")
        : "No cited notebook evidence was available for an audio overview.",
    };
  }
  return { citations: hits.map((hit) => hit.citation), excerpts: hits.map((hit) => hit.text) };
}

export function listNotebookOutputs(notebookId: string): NotebookOutputRecord[] {
  const db = ensureNotebookTables();
  return db
    .prepare("SELECT * FROM notebook_outputs WHERE notebook_id = ? ORDER BY updated_at DESC")
    .all(notebookId)
    .map(mapOutput);
}

export function getNotebookBundle(id: string) {
  const notebook = getNotebook(id);
  if (!notebook) return null;
  return {
    notebook,
    documents: listNotebookDocuments(id),
    notes: listNotebookNotes(id),
    outputs: listNotebookOutputs(id),
    transformations: listNotebookTransformations(),
  };
}

