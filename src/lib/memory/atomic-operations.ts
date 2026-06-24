import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { getSqlite, initializeDatabase } from "@/lib/db";
import { logger } from "@/lib/utils/logger";
import type { MemoryEntry, MemoryType } from "@/types/memory";
import { deleteEmbedding } from "./embedding-provider";
import { indexMemoryEmbedding } from "./hybrid-search";
import { markIdentifierObservationsDeleted, recordIdentifierObservation } from "./identifier-index";
import { getMemorySearchManager } from "./manager";
import { computeAtomicContentHash, resolveAtomicMemoryDir, SimpleMemoryProvider } from "./simple";

const log = logger.child("memory:atomic");

export type MemoryOperation =
  | { op: "add"; content: string; type?: string; tags?: string[]; metadata?: Record<string, unknown> }
  | { op: "replace"; id: string; content: string; type?: string; metadata?: Record<string, unknown> }
  | { op: "remove"; id: string };

export interface MemoryBatchResult {
  ok: true;
  requestId: string | null;
  added: string[];
  replaced: string[];
  removed: string[];
  idempotentReplay: boolean;
}

export class MemoryBatchValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryBatchValidationError";
  }
}

export interface MemoryWriteVisibility {
  kind: "agent" | "workflow";
  /** workflow id when kind === "workflow"; null for agent-wide */
  id: string | null;
  sourceExecutionId?: string | null;
  sourceNodeId?: string | null;
}

export interface ApplyOptions {
  agentId?: string;
  requestId?: string | null;
  /**
   * Authoritative visibility for newly added entries. Defaults to agent-wide so
   * existing callers keep current behaviour. The visual Memory Store node and
   * the memory_store tool pass `workflow` scope derived from runtime context.
   */
  visibility?: MemoryWriteVisibility;
  /** Test hook used to prove rollback after file swaps; never exposed by the API. */
  faultInjector?: (point: "after-file-swap" | "before-db-commit") => void;
}

type JournalWrite = { id: string; entry: MemoryEntry; hadOriginal: boolean };
type BatchJournal = {
  batchId: string;
  agentId: string;
  writes: JournalWrite[];
  deletes: Array<{ id: string }>;
};

const MAX_OPS = 50;
const MAX_CONTENT_BYTES = 8_000;
const MAX_TOTAL_BYTES = 120_000;
const MAX_METADATA_BYTES = 16_000;
const SECRET_RE = /(sk-[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9-]{10,})/;
const VALID_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const VALID_TYPES = new Set<MemoryType>([
  "fact", "preference", "entity", "decision", "correction", "relationship", "skill",
  "observation", "profile", "event", "knowledge", "behavior", "tool",
]);

const processLocks = new Map<string, Promise<void>>();

function ensureTables() {
  initializeDatabase();
  const db = getSqlite();
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_batch_log (
      request_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      result_json TEXT NOT NULL,
      operations_hash TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (request_id, agent_id)
    );
    CREATE TABLE IF NOT EXISTS memory_batch_commits (
      batch_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      committed_at TEXT NOT NULL
    );
  `);
  try {
    db.exec("ALTER TABLE memory_batch_log ADD COLUMN operations_hash TEXT");
  } catch {
    // Existing databases already have the column.
  }
  return db;
}

function byteLen(value: string): number {
  return Buffer.byteLength(String(value ?? ""), "utf8");
}

function cleanTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  return Array.from(new Set(tags.map(String).map((tag) => tag.trim()).filter(Boolean)))
    .map((tag) => tag.replace(/[\[\]\r\n,]/g, " ").trim())
    .filter(Boolean)
    .slice(0, 32);
}

function validateOperations(operations: MemoryOperation[]): void {
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new MemoryBatchValidationError("operations must be a non-empty array");
  }
  if (operations.length > MAX_OPS) {
    throw new MemoryBatchValidationError(`too many operations (${operations.length} > ${MAX_OPS})`);
  }
  const touchedIds = new Set<string>();
  let totalBytes = 0;
  for (const op of operations) {
    if (!op || typeof op !== "object" || typeof (op as { op?: unknown }).op !== "string") {
      throw new MemoryBatchValidationError("each operation needs an 'op' field");
    }
    if (op.op === "add" || op.op === "replace") {
      const content = String((op as { content?: unknown }).content ?? "").trim();
      if (!content) throw new MemoryBatchValidationError(`${op.op} requires non-empty content`);
      if (byteLen(content) > MAX_CONTENT_BYTES) {
        throw new MemoryBatchValidationError(`${op.op} content exceeds ${MAX_CONTENT_BYTES} bytes`);
      }
      if (SECRET_RE.test(content)) throw new MemoryBatchValidationError("content appears to contain a secret/credential and was rejected");
      totalBytes += byteLen(content);
      if (op.type && !VALID_TYPES.has(op.type as MemoryType)) {
        throw new MemoryBatchValidationError(`unsupported memory type: ${op.type}`);
      }
      const metadataJson = JSON.stringify(op.metadata ?? {});
      if (byteLen(metadataJson) > MAX_METADATA_BYTES) throw new MemoryBatchValidationError("operation metadata is too large");
      if (SECRET_RE.test(metadataJson)) throw new MemoryBatchValidationError("metadata appears to contain a secret/credential and was rejected");
    }
    if (op.op === "replace" || op.op === "remove") {
      const id = String((op as { id?: unknown }).id ?? "").trim();
      if (!VALID_ID_RE.test(id)) throw new MemoryBatchValidationError(`${op.op} requires a valid 'id'`);
      if (touchedIds.has(id)) throw new MemoryBatchValidationError(`conflicting operations target the same id: ${id}`);
      touchedIds.add(id);
    } else if (op.op !== "add") {
      throw new MemoryBatchValidationError(`unknown op: ${(op as { op: string }).op}`);
    }
  }
  if (totalBytes > MAX_TOTAL_BYTES) throw new MemoryBatchValidationError(`batch body exceeds ${MAX_TOTAL_BYTES} bytes`);
}

function operationsHash(operations: MemoryOperation[]): string {
  return crypto.createHash("sha256").update(JSON.stringify(operations)).digest("hex");
}

function normalizeEntry(entry: Partial<MemoryEntry> & Pick<MemoryEntry, "id" | "content">, now: string): MemoryEntry {
  const type = VALID_TYPES.has(entry.type as MemoryType) ? entry.type as MemoryType : "fact";
  return {
    id: entry.id,
    type,
    content: String(entry.content).trim(),
    confidence: Number.isFinite(Number(entry.confidence)) ? Number(entry.confidence) : 0.8,
    source: String(entry.source || "atomic-batch"),
    tags: cleanTags(entry.tags),
    created: entry.created || now,
    updated: now,
    contentHash: computeAtomicContentHash(String(entry.content), type),
    reinforcementCount: Math.max(1, Math.floor(Number(entry.reinforcementCount) || 1)),
    lastReinforcedAt: now,
    whenToUse: entry.whenToUse,
    happenedAt: entry.happenedAt,
    metadata: entry.metadata,
  };
}

function serializeEntry(entry: MemoryEntry): string {
  return [
    "---",
    `id: ${entry.id}`,
    `type: ${entry.type}`,
    `confidence: ${entry.confidence}`,
    `source: ${entry.source}`,
    `tags: [${cleanTags(entry.tags).join(", ")}]`,
    `created: ${entry.created}`,
    `updated: ${entry.updated}`,
    `content_hash: ${entry.contentHash}`,
    `reinforcement_count: ${entry.reinforcementCount}`,
    `last_reinforced_at: ${entry.lastReinforcedAt}`,
    `when_to_use: ${entry.whenToUse ? JSON.stringify(String(entry.whenToUse)) : "\"\""}`,
    `happened_at: ${entry.happenedAt ? JSON.stringify(String(entry.happenedAt)) : "\"\""}`,
    `metadata: ${entry.metadata ? JSON.stringify(entry.metadata) : "{}"}`,
    "---",
    entry.content,
  ].join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireFileLock(memDir: string): Promise<() => void> {
  const lockPath = path.join(memDir, ".atomic-batch.lock");
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      fs.closeSync(fd);
      return () => {
        try { fs.unlinkSync(lockPath); } catch { /* already released */ }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const age = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (age > 60_000) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) throw new Error("Timed out waiting for the memory batch lock");
      await sleep(25);
    }
  }
}

async function withBatchLock<T>(memDir: string, fn: () => Promise<T>): Promise<T> {
  const prior = processLocks.get(memDir) ?? Promise.resolve();
  let releaseProcess!: () => void;
  const gate = new Promise<void>((resolve) => { releaseProcess = resolve; });
  const chain = prior.then(() => gate);
  processLocks.set(memDir, chain);
  await prior;
  const releaseFile = await acquireFileLock(memDir);
  try {
    return await fn();
  } finally {
    releaseFile();
    releaseProcess();
    if (processLocks.get(memDir) === chain) processLocks.delete(memDir);
  }
}

function restoreJournal(memDir: string, txDir: string, journal: BatchJournal): void {
  for (const write of [...journal.writes].reverse()) {
    const live = path.join(memDir, `${write.id}.md`);
    const backup = path.join(txDir, "backup", `${write.id}.md`);
    const staged = path.join(txDir, "stage", `${write.id}.md`);
    if (write.hadOriginal && fs.existsSync(backup)) {
      try { if (fs.existsSync(live)) fs.unlinkSync(live); } catch { /* continue restoration */ }
      fs.renameSync(backup, live);
    } else if (!write.hadOriginal && !fs.existsSync(staged)) {
      try { if (fs.existsSync(live)) fs.unlinkSync(live); } catch { /* continue restoration */ }
    }
  }
  for (const deletion of [...journal.deletes].reverse()) {
    const live = path.join(memDir, `${deletion.id}.md`);
    const backup = path.join(txDir, "backup", `${deletion.id}.md`);
    if (!fs.existsSync(live) && fs.existsSync(backup)) fs.renameSync(backup, live);
  }
}

async function recoverInterruptedBatches(memDir: string): Promise<void> {
  const db = ensureTables();
  for (const name of fs.readdirSync(memDir).filter((entry) => entry.startsWith(".atomic-batch-"))) {
    const txDir = path.join(memDir, name);
    const journalPath = path.join(txDir, "journal.json");
    if (!fs.existsSync(journalPath)) {
      fs.rmSync(txDir, { recursive: true, force: true });
      continue;
    }
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as BatchJournal;
    const committed = db.prepare("SELECT batch_id FROM memory_batch_commits WHERE batch_id = ?").get(journal.batchId);
    if (!committed) restoreJournal(memDir, txDir, journal);
    fs.rmSync(txDir, { recursive: true, force: true });
  }
}

async function syncAuxiliaryIndexes(
  memDir: string,
  agentId: string,
  writes: JournalWrite[],
  removedSnapshots: MemoryEntry[],
): Promise<void> {
  for (const old of removedSnapshots) {
    deleteEmbedding(old.id, agentId);
    markIdentifierObservationsDeleted({
      agentId,
      memoryEntryId: old.id,
      sourcePath: path.join(memDir, `${old.id}.md`),
    });
  }
  for (const write of writes) {
    recordIdentifierObservation({
      agentId,
      content: write.entry.content,
      sessionId: typeof write.entry.metadata?.sessionId === "string" ? String(write.entry.metadata.sessionId) : null,
      sourcePath: path.join(memDir, `${write.id}.md`),
      memoryEntryId: write.id,
      createdAt: write.entry.created,
      updatedAt: write.entry.updated,
      metadata: write.entry.metadata,
    });
  }
  try {
    const model = await getMemorySearchManager(agentId).getResolvedEmbeddingModel();
    if (model) await Promise.all(writes.map((write) => indexMemoryEmbedding(write.entry, model, agentId)));
  } catch (error) {
    log.warn("Post-commit memory embedding failed", { agentId, error: String(error) });
  }
}

export async function applyMemoryOperations(
  operations: MemoryOperation[],
  options: ApplyOptions = {},
): Promise<MemoryBatchResult> {
  validateOperations(operations);
  const agentId = String(options.agentId || "default").trim() || "default";
  const requestId = options.requestId ? String(options.requestId).trim() : null;
  if (requestId && (requestId.length > 200 || SECRET_RE.test(requestId))) {
    throw new MemoryBatchValidationError("requestId is invalid");
  }
  const opHash = operationsHash(operations);
  const memDir = resolveAtomicMemoryDir(agentId);
  fs.mkdirSync(memDir, { recursive: true });

  return withBatchLock(memDir, async () => {
    await recoverInterruptedBatches(memDir);
    const db = ensureTables();

    if (requestId) {
      const cached = db
        .prepare("SELECT result_json, operations_hash FROM memory_batch_log WHERE request_id = ? AND agent_id = ?")
        .get(requestId, agentId) as { result_json: string; operations_hash?: string | null } | undefined;
      if (cached) {
        if (cached.operations_hash && cached.operations_hash !== opHash) {
          throw new MemoryBatchValidationError("requestId was already used for a different operation batch");
        }
        return { ...(JSON.parse(cached.result_json) as MemoryBatchResult), idempotentReplay: true };
      }
    }

    const provider = new SimpleMemoryProvider(agentId);
    const snapshots = new Map<string, MemoryEntry>();
    const existingVisibility = new Map<string, { kind: string; id: string | null }>();
    for (const op of operations) {
      if (op.op !== "add") {
        const scope = db.prepare("SELECT agent_id, visibility_kind, visibility_id FROM memory_atomic_scope WHERE id = ?").get(op.id) as { agent_id: string; visibility_kind?: string; visibility_id?: string | null } | undefined;
        if (!scope) throw new MemoryBatchValidationError(`memory not found: ${op.id}`);
        if (scope.agent_id !== agentId) throw new MemoryBatchValidationError(`memory ${op.id} belongs to another scope`);
        existingVisibility.set(op.id, { kind: scope.visibility_kind || "agent", id: scope.visibility_id ?? null });
        const existing = await provider.get(op.id);
        if (!existing) throw new MemoryBatchValidationError(`memory file not found: ${op.id}`);
        snapshots.set(op.id, existing);
      }
    }

    // Authoritative visibility for newly added entries (defaults to agent-wide).
    const newVisibility: MemoryWriteVisibility = options.visibility?.kind === "workflow"
      ? { kind: "workflow", id: options.visibility.id ?? null, sourceExecutionId: options.visibility.sourceExecutionId ?? null, sourceNodeId: options.visibility.sourceNodeId ?? null }
      : { kind: "agent", id: null };

    const now = new Date().toISOString();
    const writes: JournalWrite[] = [];
    const deletes: Array<{ id: string }> = [];
    const added: string[] = [];
    const replaced: string[] = [];
    const removed: string[] = [];
    for (const op of operations) {
      if (op.op === "add") {
        let id = `mem_${nanoid(8)}`;
        while (fs.existsSync(path.join(memDir, `${id}.md`))) id = `mem_${nanoid(8)}`;
        writes.push({
          id,
          hadOriginal: false,
          entry: normalizeEntry({ id, content: op.content, type: op.type as MemoryType | undefined, tags: op.tags, metadata: op.metadata }, now),
        });
        added.push(id);
      } else if (op.op === "replace") {
        const existing = snapshots.get(op.id)!;
        writes.push({
          id: op.id,
          hadOriginal: true,
          entry: normalizeEntry({
            ...existing,
            content: op.content,
            type: (op.type as MemoryType | undefined) || existing.type,
            metadata: op.metadata === undefined ? existing.metadata : op.metadata,
          }, now),
        });
        replaced.push(op.id);
      } else {
        deletes.push({ id: op.id });
        removed.push(op.id);
      }
    }

    const batchId = crypto.randomUUID();
    const txDir = path.join(memDir, `.atomic-batch-${batchId}`);
    const stageDir = path.join(txDir, "stage");
    const backupDir = path.join(txDir, "backup");
    fs.mkdirSync(stageDir, { recursive: true });
    fs.mkdirSync(backupDir, { recursive: true });
    const journal: BatchJournal = { batchId, agentId, writes, deletes };
    fs.writeFileSync(path.join(txDir, "journal.json"), JSON.stringify(journal), "utf8");
    for (const write of writes) {
      fs.writeFileSync(path.join(stageDir, `${write.id}.md`), serializeEntry(write.entry), { encoding: "utf8", flag: "wx" });
    }

    const result: MemoryBatchResult = { ok: true, requestId, added, replaced, removed, idempotentReplay: false };
    let transactionOpen = false;
    try {
      db.exec("BEGIN IMMEDIATE");
      transactionOpen = true;
      let swaps = 0;
      for (const write of writes) {
        const live = path.join(memDir, `${write.id}.md`);
        const backup = path.join(backupDir, `${write.id}.md`);
        if (write.hadOriginal) fs.renameSync(live, backup);
        fs.renameSync(path.join(stageDir, `${write.id}.md`), live);
        swaps++;
        if (swaps === 1) options.faultInjector?.("after-file-swap");
        db.prepare("INSERT OR REPLACE INTO memories_fts (id, content, tags, type) VALUES (?, ?, ?, ?)")
          .run(write.id, write.entry.content, write.entry.tags.join(", "), write.entry.type);
        // Adds use the authoritative new visibility; replaces preserve the
        // existing entry's visibility so a scope cannot be silently widened.
        const vis = write.hadOriginal
          ? (existingVisibility.get(write.id) ?? { kind: "agent", id: null })
          : { kind: newVisibility.kind, id: newVisibility.id };
        const srcExec = write.hadOriginal ? null : (newVisibility.sourceExecutionId ?? null);
        const srcNode = write.hadOriginal ? null : (newVisibility.sourceNodeId ?? null);
        db.prepare("INSERT OR REPLACE INTO memory_atomic_scope (id, agent_id, updated_at, visibility_kind, visibility_id, source_execution_id, source_node_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(write.id, agentId, write.entry.updated, vis.kind, vis.id, srcExec, srcNode);
      }
      for (const deletion of deletes) {
        const live = path.join(memDir, `${deletion.id}.md`);
        fs.renameSync(live, path.join(backupDir, `${deletion.id}.md`));
        db.prepare("DELETE FROM memories_fts WHERE id = ?").run(deletion.id);
        db.prepare("DELETE FROM memory_atomic_scope WHERE id = ?").run(deletion.id);
      }
      if (requestId) {
        db.prepare(
          "INSERT INTO memory_batch_log (request_id, agent_id, result_json, operations_hash, created_at) VALUES (?, ?, ?, ?, ?)",
        ).run(requestId, agentId, JSON.stringify(result), opHash, now);
      }
      db.prepare("INSERT INTO memory_batch_commits (batch_id, agent_id, committed_at) VALUES (?, ?, ?)")
        .run(batchId, agentId, now);
      options.faultInjector?.("before-db-commit");
      db.exec("COMMIT");
      transactionOpen = false;
    } catch (error) {
      if (transactionOpen) {
        try { db.exec("ROLLBACK"); } catch { /* preserve the original failure */ }
      }
      let rollbackError: unknown = null;
      try {
        restoreJournal(memDir, txDir, journal);
      } catch (failure) {
        rollbackError = failure;
      }
      fs.rmSync(txDir, { recursive: true, force: true });
      if (rollbackError) {
        throw new Error(`Memory batch failed and rollback also failed: ${String(error)}; rollback: ${String(rollbackError)}`);
      }
      throw new Error(`Memory batch failed with zero committed mutations: ${String(error)}`);
    }

    const removedSnapshots = [
      ...replaced.map((id) => snapshots.get(id)!).filter(Boolean),
      ...removed.map((id) => snapshots.get(id)!).filter(Boolean),
    ];
    await syncAuxiliaryIndexes(memDir, agentId, writes, removedSnapshots);
    fs.rmSync(txDir, { recursive: true, force: true });
    log.info("memory.batch", { agentId, requestId, added: added.length, replaced: replaced.length, removed: removed.length });
    return result;
  });
}
