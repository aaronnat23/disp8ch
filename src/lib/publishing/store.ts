import { nanoid } from "nanoid";
import { getSqlite, withSqliteWriteRecovery } from "@/lib/db";
import type { DeploymentEvent, DeploymentFeedback, DeploymentPublishPolicy, DesignDeployment, PublishResult } from "./types";

let ready = false;

export function ensurePublishingTables(): void {
  if (ready) return;
  getSqlite().exec(`
    CREATE TABLE IF NOT EXISTS design_deployments (
      id TEXT PRIMARY KEY,
      artifact_id TEXT NOT NULL,
      artifact_version_id TEXT NOT NULL,
      work_trail_id TEXT,
      provider TEXT NOT NULL,
      remote_id TEXT NOT NULL,
      url TEXT NOT NULL,
      status TEXT NOT NULL,
      visibility TEXT NOT NULL,
      expires_at TEXT,
      provider_metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      revoked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_design_deployments_artifact ON design_deployments(artifact_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_design_deployments_remote ON design_deployments(provider, remote_id);

    CREATE TABLE IF NOT EXISTS design_deployment_events (
      id TEXT PRIMARY KEY,
      deployment_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      from_version_id TEXT,
      to_version_id TEXT,
      summary TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      FOREIGN KEY(deployment_id) REFERENCES design_deployments(id)
    );
    CREATE INDEX IF NOT EXISTS idx_design_deployment_events ON design_deployment_events(deployment_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS deployment_feedback (
      id TEXT PRIMARY KEY,
      deployment_id TEXT NOT NULL,
      provider_item_id TEXT NOT NULL,
      submitted_at TEXT NOT NULL,
      body TEXT NOT NULL,
      contact_redacted TEXT,
      category TEXT,
      severity TEXT,
      status TEXT NOT NULL DEFAULT 'new',
      source_hash TEXT NOT NULL,
      board_task_id TEXT,
      work_trail_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(deployment_id, provider_item_id),
      UNIQUE(deployment_id, source_hash),
      FOREIGN KEY(deployment_id) REFERENCES design_deployments(id)
    );
    CREATE INDEX IF NOT EXISTS idx_deployment_feedback ON deployment_feedback(deployment_id, submitted_at DESC);

    CREATE TABLE IF NOT EXISTS deployment_publish_policies (
      deployment_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      confirmed_at TEXT,
      confirmed_run_id TEXT,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(deployment_id) REFERENCES design_deployments(id)
    );
  `);
  ready = true;
}

function parseMetadata(value: unknown): Record<string, unknown> {
  try { return JSON.parse(String(value || "{}")) as Record<string, unknown>; } catch { return {}; }
}

function deploymentRow(row: Record<string, unknown>): DesignDeployment {
  return {
    id: String(row.id), artifactId: String(row.artifact_id), artifactVersionId: String(row.artifact_version_id),
    workTrailId: row.work_trail_id ? String(row.work_trail_id) : null, provider: String(row.provider),
    remoteId: String(row.remote_id), url: String(row.url), status: String(row.status) as DesignDeployment["status"],
    visibility: String(row.visibility) as DesignDeployment["visibility"], expiresAt: row.expires_at ? String(row.expires_at) : null,
    providerMetadata: parseMetadata(row.provider_metadata_json), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    revokedAt: row.revoked_at ? String(row.revoked_at) : null,
  };
}

function eventRow(row: Record<string, unknown>): DeploymentEvent {
  return {
    id: String(row.id), deploymentId: String(row.deployment_id), eventType: String(row.event_type),
    fromVersionId: row.from_version_id ? String(row.from_version_id) : null,
    toVersionId: row.to_version_id ? String(row.to_version_id) : null,
    summary: String(row.summary), metadata: parseMetadata(row.metadata_json), createdAt: String(row.created_at),
  };
}

export function createDeployment(input: {
  artifactId: string;
  versionId: string;
  workTrailId?: string | null;
  result: PublishResult;
  visibility: "public" | "protected";
  expiresAt?: string | null;
}): DesignDeployment {
  ensurePublishingTables();
  const id = `deploy_${nanoid(16)}`;
  const timestamp = new Date().toISOString();
  withSqliteWriteRecovery("publishing:createDeployment", (db) => {
    const transaction = db.transaction(() => {
      db.prepare(`INSERT INTO design_deployments
        (id, artifact_id, artifact_version_id, work_trail_id, provider, remote_id, url, status, visibility, expires_at, provider_metadata_json, created_at, updated_at, revoked_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`)
        .run(id, input.artifactId, input.versionId, input.workTrailId ?? null, input.result.provider, input.result.remoteId,
          input.result.url, input.result.status, input.visibility, input.expiresAt ?? null,
          JSON.stringify(input.result.providerMetadata ?? {}), timestamp, timestamp);
      db.prepare(`INSERT INTO design_deployment_events
        (id, deployment_id, event_type, from_version_id, to_version_id, summary, metadata_json, created_at)
        VALUES (?, ?, 'created', NULL, ?, ?, '{}', ?)`)
        .run(`depevt_${nanoid(16)}`, id, input.versionId, `Published ${input.versionId}`, timestamp);
    });
    transaction();
  });
  return getDeployment(id)!;
}

export function getDeployment(id: string): DesignDeployment | null {
  ensurePublishingTables();
  const row = getSqlite().prepare("SELECT * FROM design_deployments WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? deploymentRow(row) : null;
}

export function listDeployments(artifactId: string): DesignDeployment[] {
  ensurePublishingTables();
  return (getSqlite().prepare("SELECT * FROM design_deployments WHERE artifact_id = ? ORDER BY created_at DESC LIMIT 100").all(artifactId) as Array<Record<string, unknown>>).map(deploymentRow);
}

export function listDeploymentEvents(deploymentId: string): DeploymentEvent[] {
  ensurePublishingTables();
  return (getSqlite().prepare("SELECT * FROM design_deployment_events WHERE deployment_id = ? ORDER BY created_at DESC LIMIT 200").all(deploymentId) as Array<Record<string, unknown>>).map(eventRow);
}

export function recordDeploymentEvent(input: {
  deploymentId: string;
  eventType: string;
  fromVersionId?: string | null;
  toVersionId?: string | null;
  summary: string;
  metadata?: Record<string, unknown>;
}): void {
  ensurePublishingTables();
  withSqliteWriteRecovery("publishing:recordDeploymentEvent", (db) => {
    db.prepare(`INSERT INTO design_deployment_events
      (id, deployment_id, event_type, from_version_id, to_version_id, summary, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(`depevt_${nanoid(16)}`, input.deploymentId, input.eventType, input.fromVersionId ?? null,
        input.toVersionId ?? null, input.summary.slice(0, 1000), JSON.stringify(input.metadata ?? {}), new Date().toISOString());
  });
}

export function updateDeployment(input: {
  deployment: DesignDeployment;
  result: PublishResult;
  versionId: string;
  eventType: "updated" | "rolled_back";
}): DesignDeployment {
  ensurePublishingTables();
  const timestamp = new Date().toISOString();
  withSqliteWriteRecovery("publishing:updateDeployment", (db) => {
    const transaction = db.transaction(() => {
      db.prepare(`UPDATE design_deployments SET artifact_version_id = ?, remote_id = ?, url = ?, status = ?,
        provider_metadata_json = ?, updated_at = ?, revoked_at = NULL WHERE id = ?`)
        .run(input.versionId, input.result.remoteId, input.result.url, input.result.status,
          JSON.stringify(input.result.providerMetadata ?? {}), timestamp, input.deployment.id);
      db.prepare(`INSERT INTO design_deployment_events
        (id, deployment_id, event_type, from_version_id, to_version_id, summary, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, '{}', ?)`)
        .run(`depevt_${nanoid(16)}`, input.deployment.id, input.eventType, input.deployment.artifactVersionId,
          input.versionId, `${input.eventType === "rolled_back" ? "Rolled back" : "Updated"} to ${input.versionId}`, timestamp);
    });
    transaction();
  });
  return getDeployment(input.deployment.id)!;
}

export function revokeDeploymentRecord(deployment: DesignDeployment): DesignDeployment {
  ensurePublishingTables();
  if (deployment.status === "revoked") return deployment;
  const timestamp = new Date().toISOString();
  withSqliteWriteRecovery("publishing:revokeDeployment", (db) => {
    const transaction = db.transaction(() => {
      db.prepare("UPDATE design_deployments SET status = 'revoked', revoked_at = ?, updated_at = ? WHERE id = ?")
        .run(timestamp, timestamp, deployment.id);
      db.prepare(`INSERT INTO design_deployment_events
        (id, deployment_id, event_type, from_version_id, to_version_id, summary, metadata_json, created_at)
        VALUES (?, ?, 'revoked', ?, NULL, 'Deployment revoked', '{}', ?)`)
        .run(`depevt_${nanoid(16)}`, deployment.id, deployment.artifactVersionId, timestamp);
    });
    transaction();
  });
  return getDeployment(deployment.id)!;
}

export function insertFeedback(record: DeploymentFeedback): boolean {
  ensurePublishingTables();
  let inserted = false;
  withSqliteWriteRecovery("publishing:insertFeedback", (db) => {
    const result = db.prepare(`INSERT OR IGNORE INTO deployment_feedback
      (id, deployment_id, provider_item_id, submitted_at, body, contact_redacted, category, severity, status, source_hash, board_task_id, work_trail_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(record.id, record.deploymentId, record.providerItemId, record.submittedAt, record.body, record.contactRedacted,
        record.category, record.severity, record.status, record.sourceHash, record.boardTaskId, record.workTrailId,
        record.createdAt, record.updatedAt);
    inserted = result.changes === 1;
  });
  return inserted;
}

function feedbackRow(row: Record<string, unknown>): DeploymentFeedback {
  return {
    id: String(row.id), deploymentId: String(row.deployment_id), providerItemId: String(row.provider_item_id),
    submittedAt: String(row.submitted_at), body: String(row.body), contactRedacted: row.contact_redacted ? String(row.contact_redacted) : null,
    category: row.category ? String(row.category) : null, severity: row.severity ? String(row.severity) : null,
    status: String(row.status) as DeploymentFeedback["status"], sourceHash: String(row.source_hash),
    boardTaskId: row.board_task_id ? String(row.board_task_id) : null, workTrailId: row.work_trail_id ? String(row.work_trail_id) : null,
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

export function listFeedback(deploymentId: string): DeploymentFeedback[] {
  ensurePublishingTables();
  return (getSqlite().prepare("SELECT * FROM deployment_feedback WHERE deployment_id = ? ORDER BY submitted_at DESC LIMIT 200").all(deploymentId) as Array<Record<string, unknown>>).map(feedbackRow);
}

export function linkFeedbackTask(feedbackId: string, taskId: string): void {
  ensurePublishingTables();
  withSqliteWriteRecovery("publishing:linkFeedbackTask", (db) => {
    db.prepare("UPDATE deployment_feedback SET board_task_id = ?, status = 'task_created', updated_at = ? WHERE id = ?")
      .run(taskId, new Date().toISOString(), feedbackId);
  });
}

export function getDeploymentPublishPolicy(deploymentId: string): DeploymentPublishPolicy | null {
  ensurePublishingTables();
  const row = getSqlite().prepare("SELECT * FROM deployment_publish_policies WHERE deployment_id = ?").get(deploymentId) as Record<string, unknown> | undefined;
  return row ? {
    deploymentId: String(row.deployment_id),
    enabled: Number(row.enabled) === 1,
    confirmedAt: row.confirmed_at ? String(row.confirmed_at) : null,
    confirmedRunId: row.confirmed_run_id ? String(row.confirmed_run_id) : null,
    updatedAt: String(row.updated_at),
  } : null;
}

export function setDeploymentPublishPolicy(input: { deploymentId: string; enabled: boolean; confirmedRunId?: string | null }): DeploymentPublishPolicy {
  ensurePublishingTables();
  const timestamp = new Date().toISOString();
  getSqlite().prepare(`INSERT INTO deployment_publish_policies (deployment_id, enabled, confirmed_at, confirmed_run_id, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(deployment_id) DO UPDATE SET enabled=excluded.enabled, confirmed_at=excluded.confirmed_at,
      confirmed_run_id=excluded.confirmed_run_id, updated_at=excluded.updated_at`)
    .run(input.deploymentId, input.enabled ? 1 : 0, input.enabled ? timestamp : null, input.enabled ? input.confirmedRunId ?? null : null, timestamp);
  return getDeploymentPublishPolicy(input.deploymentId)!;
}

export function listEnabledDeploymentPolicies(workTrailId: string): Array<{ deployment: DesignDeployment; policy: DeploymentPublishPolicy }> {
  ensurePublishingTables();
  const rows = getSqlite().prepare(`SELECT d.id AS deployment_id FROM design_deployments d
    JOIN deployment_publish_policies p ON p.deployment_id = d.id
    WHERE d.work_trail_id = ? AND p.enabled = 1 AND d.status != 'revoked'`).all(workTrailId) as Array<{ deployment_id: string }>;
  return rows.flatMap((row) => {
    const deployment = getDeployment(row.deployment_id);
    const policy = getDeploymentPublishPolicy(row.deployment_id);
    return deployment && policy ? [{ deployment, policy }] : [];
  });
}
