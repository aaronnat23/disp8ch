import crypto from "node:crypto";
import { nanoid } from "nanoid";
import { getSqlite, withSqliteWriteRecovery } from "@/lib/db";
import { ensureDynamicWorkflowTables } from "./store";
import type {
  AcceptanceCriterion,
  AcceptanceMethod,
  AcceptanceStatus,
  DynamicWorkflowCriterionRecord,
  DynamicWorkflowEvidenceRecord,
  DynamicWorkflowPlan,
  DynamicWorkflowRepairAttemptRecord,
} from "./types";

const VALID_METHODS = new Set<AcceptanceMethod>([
  "review",
  "command",
  "browser",
  "artifact",
  "citation",
  "human",
]);

function now(): string {
  return new Date().toISOString();
}

function normalizeMethods(value: unknown): AcceptanceMethod[] {
  const values = Array.isArray(value) ? value : [];
  const methods = values.map(String).filter((item): item is AcceptanceMethod => VALID_METHODS.has(item as AcceptanceMethod));
  return [...new Set(methods.length > 0 ? methods : ["review"] as AcceptanceMethod[])];
}

export function normalizeAcceptanceCriteria(plan: DynamicWorkflowPlan): AcceptanceCriterion[] {
  const typed = Array.isArray(plan.acceptanceContract) ? plan.acceptanceContract : [];
  if (typed.length > 0) {
    return typed.slice(0, 100).map((criterion, index) => ({
      id: String(criterion.id || `criterion-${index + 1}`).slice(0, 120),
      statement: String(criterion.statement || "").trim().slice(0, 4000),
      required: criterion.required !== false,
      methods: normalizeMethods(criterion.methods),
      status: "pending" as const,
    })).filter((criterion) => criterion.statement.length > 0);
  }
  return (plan.acceptanceCriteria || []).slice(0, 100).map((statement, index) => ({
    id: `criterion-${index + 1}`,
    statement: String(statement).trim().slice(0, 4000),
    required: true,
    methods: ["review"] as AcceptanceMethod[],
    status: "pending" as const,
  })).filter((criterion) => criterion.statement.length > 0);
}

export function initializeRunCriteria(runId: string, plan: DynamicWorkflowPlan): DynamicWorkflowCriterionRecord[] {
  ensureDynamicWorkflowTables();
  const criteria = normalizeAcceptanceCriteria(plan);
  const timestamp = now();
  withSqliteWriteRecovery("dynamic-workflows:initializeCriteria", (db) => {
    const insert = db.prepare(`
      INSERT OR IGNORE INTO dynamic_workflow_criteria (
        id, run_id, statement, required, methods_json, status,
        evaluator_worker_id, evaluated_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?)
    `);
    const transaction = db.transaction(() => {
      for (const criterion of criteria) {
        insert.run(
          criterion.id,
          runId,
          criterion.statement,
          criterion.required ? 1 : 0,
          JSON.stringify(criterion.methods),
          timestamp,
          timestamp,
        );
      }
    });
    transaction();
  });
  return listRunCriteria(runId);
}

function mapCriterion(row: Record<string, unknown>): DynamicWorkflowCriterionRecord {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    statement: String(row.statement),
    required: Number(row.required) === 1,
    methods: normalizeMethods(JSON.parse(String(row.methods_json || "[]"))),
    status: String(row.status) as AcceptanceStatus,
    evaluatorWorkerId: row.evaluator_worker_id ? String(row.evaluator_worker_id) : null,
    evaluatedAt: row.evaluated_at ? String(row.evaluated_at) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function listRunCriteria(runId: string): DynamicWorkflowCriterionRecord[] {
  ensureDynamicWorkflowTables();
  const rows = getSqlite().prepare(
    "SELECT * FROM dynamic_workflow_criteria WHERE run_id = ? ORDER BY created_at, id",
  ).all(runId) as Array<Record<string, unknown>>;
  return rows.map(mapCriterion);
}

export function evaluateCriterion(input: {
  runId: string;
  criterionId: string;
  status: AcceptanceStatus;
  evaluatorWorkerId?: string | null;
}): DynamicWorkflowCriterionRecord {
  ensureDynamicWorkflowTables();
  const timestamp = now();
  withSqliteWriteRecovery("dynamic-workflows:evaluateCriterion", (db) => {
    const result = db.prepare(`
      UPDATE dynamic_workflow_criteria
      SET status = ?, evaluator_worker_id = ?, evaluated_at = ?, updated_at = ?
      WHERE run_id = ? AND id = ?
    `).run(
      input.status,
      input.evaluatorWorkerId ?? null,
      timestamp,
      timestamp,
      input.runId,
      input.criterionId,
    );
    if (result.changes !== 1) throw new Error(`Criterion ${input.criterionId} was not found.`);
  });
  return listRunCriteria(input.runId).find((criterion) => criterion.id === input.criterionId)!;
}

export function recordEvidence(input: {
  runId: string;
  criterionId?: string | null;
  evidenceType: string;
  sourceType: string;
  sourceId?: string | null;
  summary: string;
  payload?: unknown;
}): DynamicWorkflowEvidenceRecord {
  ensureDynamicWorkflowTables();
  const summary = String(input.summary).trim().slice(0, 8000);
  if (!summary) throw new Error("Evidence summary is required.");
  const payloadJson = input.payload === undefined ? null : JSON.stringify(input.payload).slice(0, 32000);
  const contentSha256 = crypto
    .createHash("sha256")
    .update([input.runId, input.criterionId || "", input.evidenceType, input.sourceType, summary, payloadJson || ""].join("\u0000"))
    .digest("hex");
  const record: DynamicWorkflowEvidenceRecord = {
    id: nanoid(),
    runId: input.runId,
    criterionId: input.criterionId ?? null,
    evidenceType: String(input.evidenceType).slice(0, 100),
    sourceType: String(input.sourceType).slice(0, 100),
    sourceId: input.sourceId ? String(input.sourceId).slice(0, 500) : null,
    summary,
    payloadJson,
    contentSha256,
    createdAt: now(),
  };
  withSqliteWriteRecovery("dynamic-workflows:recordEvidence", (db) => {
    db.prepare(`
      INSERT INTO dynamic_workflow_evidence (
        id, run_id, criterion_id, evidence_type, source_type, source_id,
        summary, payload_json, content_sha256, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.runId,
      record.criterionId,
      record.evidenceType,
      record.sourceType,
      record.sourceId,
      record.summary,
      record.payloadJson,
      record.contentSha256,
      record.createdAt,
    );
  });
  return record;
}

export function listRunEvidence(runId: string): DynamicWorkflowEvidenceRecord[] {
  ensureDynamicWorkflowTables();
  const rows = getSqlite().prepare(
    "SELECT * FROM dynamic_workflow_evidence WHERE run_id = ? ORDER BY created_at, id",
  ).all(runId) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id),
    runId: String(row.run_id),
    criterionId: row.criterion_id ? String(row.criterion_id) : null,
    evidenceType: String(row.evidence_type),
    sourceType: String(row.source_type),
    sourceId: row.source_id ? String(row.source_id) : null,
    summary: String(row.summary),
    payloadJson: row.payload_json ? String(row.payload_json) : null,
    contentSha256: String(row.content_sha256),
    createdAt: String(row.created_at),
  }));
}

export function createRepairAttempt(input: {
  runId: string;
  attemptNumber: number;
  failedCriterionIds: string[];
  implementerWorkerId?: string | null;
  reviewerWorkerId?: string | null;
}): DynamicWorkflowRepairAttemptRecord {
  ensureDynamicWorkflowTables();
  const record: DynamicWorkflowRepairAttemptRecord = {
    id: nanoid(),
    runId: input.runId,
    attemptNumber: Math.max(1, Math.min(2, Math.floor(input.attemptNumber))),
    failedCriterionIds: [...new Set(input.failedCriterionIds)].slice(0, 100),
    implementerWorkerId: input.implementerWorkerId ?? null,
    reviewerWorkerId: input.reviewerWorkerId ?? null,
    status: "running",
    createdAt: now(),
    completedAt: null,
  };
  withSqliteWriteRecovery("dynamic-workflows:createRepairAttempt", (db) => {
    db.prepare(`
      INSERT INTO dynamic_workflow_repair_attempts (
        id, run_id, attempt_number, failed_criterion_ids_json,
        implementer_worker_id, reviewer_worker_id, status, created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(
      record.id,
      record.runId,
      record.attemptNumber,
      JSON.stringify(record.failedCriterionIds),
      record.implementerWorkerId,
      record.reviewerWorkerId,
      record.status,
      record.createdAt,
    );
  });
  return record;
}

export function completeRepairAttempt(id: string, status: "completed" | "failed"): void {
  ensureDynamicWorkflowTables();
  withSqliteWriteRecovery("dynamic-workflows:completeRepairAttempt", (db) => {
    db.prepare(
      "UPDATE dynamic_workflow_repair_attempts SET status = ?, completed_at = ? WHERE id = ?",
    ).run(status, now(), id);
  });
}

export function listRepairAttempts(runId: string): DynamicWorkflowRepairAttemptRecord[] {
  ensureDynamicWorkflowTables();
  const rows = getSqlite().prepare(
    "SELECT * FROM dynamic_workflow_repair_attempts WHERE run_id = ? ORDER BY attempt_number",
  ).all(runId) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id),
    runId: String(row.run_id),
    attemptNumber: Number(row.attempt_number),
    failedCriterionIds: JSON.parse(String(row.failed_criterion_ids_json || "[]")) as string[],
    implementerWorkerId: row.implementer_worker_id ? String(row.implementer_worker_id) : null,
    reviewerWorkerId: row.reviewer_worker_id ? String(row.reviewer_worker_id) : null,
    status: String(row.status) as DynamicWorkflowRepairAttemptRecord["status"],
    createdAt: String(row.created_at),
    completedAt: row.completed_at ? String(row.completed_at) : null,
  }));
}

export function auditAcceptance(runId: string): {
  passed: boolean;
  requiredFailures: DynamicWorkflowCriterionRecord[];
  criteriaWithoutEvidence: DynamicWorkflowCriterionRecord[];
} {
  const criteria = listRunCriteria(runId);
  const evidence = listRunEvidence(runId);
  const requiredFailures = criteria.filter(
    (criterion) => criterion.required && criterion.status !== "passed",
  );
  const evidenceCriterionIds = new Set(evidence.map((item) => item.criterionId).filter(Boolean));
  const criteriaWithoutEvidence = criteria.filter(
    (criterion) => criterion.status === "passed" && !evidenceCriterionIds.has(criterion.id),
  );
  return {
    passed: requiredFailures.length === 0 && criteriaWithoutEvidence.length === 0,
    requiredFailures,
    criteriaWithoutEvidence,
  };
}
