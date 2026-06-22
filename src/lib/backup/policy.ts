import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Cron } from "croner";
import { getSqlite, initializeDatabase, withSqliteWriteRecovery } from "@/lib/db";
import { createBackup, listBackups, type BackupSummary, verifyBackup } from "@/lib/backup/manager";
import { logger } from "@/lib/utils/logger";

const execFileAsync = promisify(execFile);
const log = logger.child("backup-policy");

export type BackupReplicationMode = "off" | "mirror-copy" | "rsync";

export type BackupPolicyConfig = {
  enabled: boolean;
  cronExpression: string;
  retentionCount: number;
  includeLogs: boolean;
  replicationMode: BackupReplicationMode;
  replicationTarget: string | null;
  replicationRsyncArgs: string | null;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastBackupId: string | null;
};

export type BackupPolicyRunResult = {
  ok: boolean;
  reason: string;
  backup: BackupSummary;
  verified: boolean;
  prunedBackupIds: string[];
  replication: {
    mode: BackupReplicationMode;
    target: string | null;
    skipped: boolean;
    destination: string | null;
  };
};

export type BackupPolicyStatus = {
  config: BackupPolicyConfig;
  scheduled: boolean;
  nextRunAt: string | null;
  running: boolean;
  latestBackup: BackupSummary | null;
  setupWarnings: string[];
};

type BackupPolicyGlobalState = typeof globalThis & {
  __disp8chBackupPolicyJob?: Cron | null;
  __disp8chBackupPolicyRun?: Promise<BackupPolicyRunResult> | null;
};

const backupPolicyGlobal = globalThis as BackupPolicyGlobalState;

function getPolicyJob(): Cron | null {
  return backupPolicyGlobal.__disp8chBackupPolicyJob ?? null;
}

function setPolicyJob(job: Cron | null): void {
  backupPolicyGlobal.__disp8chBackupPolicyJob = job;
}

function getActiveRun(): Promise<BackupPolicyRunResult> | null {
  return backupPolicyGlobal.__disp8chBackupPolicyRun ?? null;
}

function setActiveRun(run: Promise<BackupPolicyRunResult> | null): void {
  backupPolicyGlobal.__disp8chBackupPolicyRun = run;
}

function isDriveLetterPath(target: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(target);
}

function isRsyncRemoteTarget(target: string): boolean {
  return target.includes(":") && !isDriveLetterPath(target) && !target.startsWith("./") && !target.startsWith("../");
}

function normalizeTargetRoot(target: string): string {
  const trimmed = target.trim();
  if (!trimmed) return trimmed;
  return trimmed.replace(/[\\/]+$/, "");
}

function splitArgs(raw: string | null): string[] {
  const value = String(raw || "").trim();
  if (!value) return [];
  return value.split(/\s+/).filter(Boolean);
}

function getReplicationDestinationRoot(config: BackupPolicyConfig, backupId: string): string | null {
  const targetRoot = normalizeTargetRoot(config.replicationTarget || "");
  if (!targetRoot) return null;
  if (config.replicationMode === "rsync" && isRsyncRemoteTarget(targetRoot)) {
    const suffix = targetRoot.endsWith("/") ? "" : "/";
    return `${targetRoot}${suffix}${backupId}/`;
  }
  return path.join(targetRoot, backupId);
}

function updatePolicyStatus(partial: Partial<Pick<BackupPolicyConfig, "lastRunAt" | "lastSuccessAt" | "lastError" | "lastBackupId">>): void {
  const keys = Object.keys(partial) as Array<keyof typeof partial>;
  if (keys.length === 0) return;
  const now = new Date().toISOString();
  withSqliteWriteRecovery("backup-policy-status", (database) => {
    const columnMap: Record<string, string> = {
      lastRunAt: "backup_last_run_at",
      lastSuccessAt: "backup_last_success_at",
      lastError: "backup_last_error",
      lastBackupId: "backup_last_backup_id",
    };
    const setClauses = keys.map((key) => `${columnMap[String(key)]} = ?`);
    database
      .prepare(`UPDATE app_config SET ${setClauses.join(", ")}, updated_at = ? WHERE id = 'default'`)
      .run(...keys.map((key) => partial[key] ?? null), now);
  });
}

export function getBackupPolicyConfig(): BackupPolicyConfig {
  initializeDatabase();
  const row = getSqlite().prepare(`
    SELECT
      backup_enabled,
      backup_cron,
      backup_retention_count,
      backup_include_logs,
      backup_replication_mode,
      backup_replication_target,
      backup_replication_rsync_args,
      backup_last_run_at,
      backup_last_success_at,
      backup_last_error,
      backup_last_backup_id
    FROM app_config
    WHERE id = 'default'
  `).get() as Record<string, unknown> | undefined;

  return {
    enabled: Number(row?.backup_enabled ?? 0) === 1,
    cronExpression: String(row?.backup_cron || "0 */6 * * *").trim() || "0 */6 * * *",
    retentionCount: Math.max(1, Math.min(200, Number(row?.backup_retention_count ?? 14) || 14)),
    includeLogs: Number(row?.backup_include_logs ?? 0) === 1,
    replicationMode: (["off", "mirror-copy", "rsync"].includes(String(row?.backup_replication_mode || "off"))
      ? String(row?.backup_replication_mode || "off")
      : "off") as BackupReplicationMode,
    replicationTarget: String(row?.backup_replication_target || "").trim() || null,
    replicationRsyncArgs: String(row?.backup_replication_rsync_args || "").trim() || null,
    lastRunAt: String(row?.backup_last_run_at || "").trim() || null,
    lastSuccessAt: String(row?.backup_last_success_at || "").trim() || null,
    lastError: String(row?.backup_last_error || "").trim() || null,
    lastBackupId: String(row?.backup_last_backup_id || "").trim() || null,
  };
}

function pruneOldBackups(retentionCount: number): string[] {
  const backups = listBackups();
  const toRemove = backups.slice(Math.max(0, retentionCount));
  const removedIds: string[] = [];
  for (const backup of toRemove) {
    try {
      fs.rmSync(backup.backupDir, { recursive: true, force: true });
      removedIds.push(backup.id);
    } catch (error) {
      log.warn("Failed to prune old backup", { backupId: backup.id, error: String(error) });
    }
  }
  return removedIds;
}

async function replicateBackup(backup: BackupSummary, config: BackupPolicyConfig): Promise<{ destination: string | null; skipped: boolean }> {
  if (config.replicationMode === "off") {
    return { destination: null, skipped: true };
  }
  const destination = getReplicationDestinationRoot(config, backup.id);
  if (!destination) {
    return { destination: null, skipped: true };
  }

  if (config.replicationMode === "mirror-copy") {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.rmSync(destination, { recursive: true, force: true });
    fs.cpSync(backup.backupDir, destination, { recursive: true, force: true, dereference: false });
    return { destination, skipped: false };
  }

  const rsyncArgs = ["-a", ...splitArgs(config.replicationRsyncArgs), `${backup.backupDir}/`, destination];
  await execFileAsync("rsync", rsyncArgs, { timeout: 10 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 });
  return { destination, skipped: false };
}

export async function runBackupPolicy(reason = "manual", options?: { ignoreDisabled?: boolean }): Promise<BackupPolicyRunResult> {
  const activeRun = getActiveRun();
  if (activeRun) return activeRun;

  const runPromise = (async () => {
    const config = getBackupPolicyConfig();
    if (!config.enabled && !options?.ignoreDisabled) {
      throw new Error("Backup policy is disabled.");
    }

    const startedAt = new Date().toISOString();
    updatePolicyStatus({
      lastRunAt: startedAt,
      lastError: null,
    });

    try {
      const backup = await createBackup({
        includeLogs: config.includeLogs,
      });
      const verified = verifyBackup(backup.id).ok;
      if (!verified) {
        throw new Error(`Backup verification failed for ${backup.id}`);
      }
      const replicationResult = await replicateBackup(backup, config);
      const prunedBackupIds = pruneOldBackups(config.retentionCount);
      updatePolicyStatus({
        lastSuccessAt: new Date().toISOString(),
        lastError: null,
        lastBackupId: backup.id,
      });
      return {
        ok: true,
        reason,
        backup,
        verified,
        prunedBackupIds,
        replication: {
          mode: config.replicationMode,
          target: config.replicationTarget,
          skipped: replicationResult.skipped,
          destination: replicationResult.destination,
        },
      };
    } catch (error) {
      updatePolicyStatus({
        lastError: String(error),
      });
      throw error;
    }
  })();

  setActiveRun(runPromise);
  try {
    return await runPromise;
  } finally {
    setActiveRun(null);
  }
}

export function getBackupPolicyStatus(): BackupPolicyStatus {
  const config = getBackupPolicyConfig();
  const job = getPolicyJob();
  const latestBackup = listBackups()[0] ?? null;
  let nextRunAt: string | null = null;
  try {
    const nextRun = job?.nextRun();
    nextRunAt = nextRun instanceof Date ? nextRun.toISOString() : null;
  } catch {
    nextRunAt = null;
  }
  return {
    config,
    scheduled: Boolean(job && config.enabled),
    nextRunAt,
    running: Boolean(getActiveRun()),
    latestBackup,
    setupWarnings: getBackupSetupWarnings(config),
  };
}

export function getBackupSetupWarnings(config = getBackupPolicyConfig()): string[] {
  const warnings: string[] = [];
  if (!config.enabled) {
    warnings.push("Automated backup policy is disabled.");
  }
  if (config.replicationMode === "off" || !config.replicationTarget) {
    warnings.push("Replication is not configured; backups are local-only.");
  }
  if (config.replicationMode === "rsync" && !config.replicationTarget) {
    warnings.push("rsync replication needs a target such as user@host:/path/backups.");
  }
  if (config.retentionCount < 3) {
    warnings.push("Retention is low; keep at least 3 snapshots for rollback safety.");
  }
  return warnings;
}

export function initBackupManager(): void {
  try {
    const existing = getPolicyJob();
    if (existing) {
      existing.stop();
      setPolicyJob(null);
    }

    const config = getBackupPolicyConfig();
    if (!config.enabled || !config.cronExpression) {
      log.info("Backup policy disabled");
      return;
    }

    const job = new Cron(
      config.cronExpression,
      {
        timezone: "UTC",
        catch: (error) => {
          log.error("Backup policy cron failed", { error: String(error) });
        },
      },
      () => {
        void runBackupPolicy("scheduled").catch((error) => {
          log.error("Scheduled backup policy run failed", { error: String(error) });
        });
      },
    );
    setPolicyJob(job);
    log.info("Backup policy scheduled", { cron: config.cronExpression });
  } catch (error) {
    log.warn("Backup policy init failed", { error: String(error) });
  }
}
