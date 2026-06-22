import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";

export type BackupManifestFile = {
  path: string;
  sizeBytes: number;
  sha256: string;
};

export type BackupManifest = {
  id: string;
  createdAt: string;
  appVersion: string;
  backupDir: string;
  options: {
    includeDocuments: boolean;
    includeWorkspace: boolean;
    includeMemories: boolean;
    includeLogs: boolean;
  };
  files: BackupManifestFile[];
};

export type BackupSummary = {
  id: string;
  createdAt: string;
  backupDir: string;
  totalFiles: number;
  totalBytes: number;
  options: BackupManifest["options"];
};

export type BackupVerifyResult = {
  ok: boolean;
  checkedFiles: number;
  totalBytes: number;
  missingFiles: string[];
  mismatchedFiles: string[];
  manifest: BackupManifest;
};

export type BackupRestorePlan = {
  backupId: string;
  backupDir: string;
  targetDataDir: string;
  files: string[];
  warnings: string[];
};

export type BackupRestoreResult = BackupRestorePlan & {
  restored: boolean;
};

const DATA_DIR = path.resolve("./data");
const BACKUPS_DIR = path.resolve(process.env.BACKUPS_DIR || path.join(DATA_DIR, "backups"));
const MAIN_DB_PATH = path.resolve(process.env.DATABASE_PATH || "./data/disp8ch.db");
const VECTOR_DB_PATH = path.resolve(process.env.MEMORY_VECTOR_DB_PATH || "./data/memory-vectors.db");
const DOCUMENTS_DIR = path.join(DATA_DIR, "documents");
const WORKSPACE_DIR = path.join(DATA_DIR, "workspace");
const MEMORIES_DIR = path.join(DATA_DIR, "memories");
const LOGS_DIR = path.join(DATA_DIR, "logs");
const MANIFEST_NAME = "manifest.json";
const PACKAGE_JSON_PATH = path.resolve("./package.json");

function ensureBackupsDir(): void {
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
}

function getAppVersion(): string {
  try {
    const parsed = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, "utf8")) as { version?: string };
    return parsed.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function formatBackupId(date = new Date()): string {
  const compact = date.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const suffix = crypto.randomBytes(3).toString("hex");
  return `backup-${compact}-${suffix}`;
}

function sha256File(filePath: string): string {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

async function snapshotSqlite(sourcePath: string, targetPath: string): Promise<void> {
  if (!fs.existsSync(sourcePath)) return;
  const sourceDb = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    await sourceDb.backup(targetPath);
  } finally {
    sourceDb.close();
  }
}

function copyDirIfExists(sourceDir: string, targetDir: string): void {
  if (!fs.existsSync(sourceDir)) return;
  fs.cpSync(sourceDir, targetDir, {
    recursive: true,
    force: true,
    dereference: false,
    filter: (entry) => !entry.endsWith(".DS_Store"),
  });
}

function collectFiles(baseDir: string): BackupManifestFile[] {
  const out: BackupManifestFile[] = [];

  const walk = (currentDir: string) => {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath);
        continue;
      }
      const stat = fs.statSync(absolutePath);
      out.push({
        path: path.relative(baseDir, absolutePath).replace(/\\/g, "/"),
        sizeBytes: stat.size,
        sha256: sha256File(absolutePath),
      });
    }
  };

  if (fs.existsSync(baseDir)) {
    walk(baseDir);
  }

  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function readManifestFromDir(backupDir: string): BackupManifest | null {
  const manifestPath = path.join(backupDir, MANIFEST_NAME);
  if (!fs.existsSync(manifestPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf8")) as BackupManifest;
  } catch {
    return null;
  }
}

export function listBackups(): BackupSummary[] {
  ensureBackupsDir();
  const entries = fs
    .readdirSync(BACKUPS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(BACKUPS_DIR, entry.name));

  return entries
    .map((backupDir) => readManifestFromDir(backupDir))
    .filter((manifest): manifest is BackupManifest => Boolean(manifest))
    .map((manifest) => ({
      id: manifest.id,
      createdAt: manifest.createdAt,
      backupDir: manifest.backupDir,
      totalFiles: manifest.files.length,
      totalBytes: manifest.files.reduce((sum, file) => sum + file.sizeBytes, 0),
      options: manifest.options,
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function resolveBackup(idOrRef?: string | null): BackupSummary | null {
  const backups = listBackups();
  if (backups.length === 0) return null;
  const target = String(idOrRef || "").trim().toLowerCase();
  if (!target || target === "latest") return backups[0];
  return (
    backups.find((item) => item.id.toLowerCase() === target) ??
    backups.find((item) => item.id.toLowerCase().includes(target))
    ?? null
  );
}

export async function createBackup(options?: Partial<BackupManifest["options"]>): Promise<BackupSummary> {
  ensureBackupsDir();
  const normalizedOptions: BackupManifest["options"] = {
    includeDocuments: options?.includeDocuments !== false,
    includeWorkspace: options?.includeWorkspace !== false,
    includeMemories: options?.includeMemories !== false,
    includeLogs: options?.includeLogs === true,
  };

  const id = formatBackupId();
  const backupDir = path.join(BACKUPS_DIR, id);
  const snapshotDir = path.join(backupDir, "snapshot");
  fs.mkdirSync(snapshotDir, { recursive: true });

  await snapshotSqlite(MAIN_DB_PATH, path.join(snapshotDir, "disp8ch.db"));
  await snapshotSqlite(VECTOR_DB_PATH, path.join(snapshotDir, "memory-vectors.db"));

  if (normalizedOptions.includeDocuments) {
    copyDirIfExists(DOCUMENTS_DIR, path.join(snapshotDir, "documents"));
  }
  if (normalizedOptions.includeWorkspace) {
    copyDirIfExists(WORKSPACE_DIR, path.join(snapshotDir, "workspace"));
  }
  if (normalizedOptions.includeMemories) {
    copyDirIfExists(MEMORIES_DIR, path.join(snapshotDir, "memories"));
  }
  if (normalizedOptions.includeLogs) {
    copyDirIfExists(LOGS_DIR, path.join(snapshotDir, "logs"));
  }

  const manifest: BackupManifest = {
    id,
    createdAt: new Date().toISOString(),
    appVersion: getAppVersion(),
    backupDir,
    options: normalizedOptions,
    files: collectFiles(snapshotDir),
  };
  fs.writeFileSync(path.join(backupDir, MANIFEST_NAME), JSON.stringify(manifest, null, 2));

  return {
    id,
    createdAt: manifest.createdAt,
    backupDir,
    totalFiles: manifest.files.length,
    totalBytes: manifest.files.reduce((sum, file) => sum + file.sizeBytes, 0),
    options: manifest.options,
  };
}

export function verifyBackup(idOrRef?: string | null): BackupVerifyResult {
  const backup = resolveBackup(idOrRef);
  if (!backup) {
    throw new Error(`Backup not found: ${idOrRef || "latest"}`);
  }

  const manifest = readManifestFromDir(backup.backupDir);
  if (!manifest) {
    throw new Error(`Backup manifest missing: ${backup.backupDir}`);
  }

  const snapshotDir = path.join(backup.backupDir, "snapshot");
  const missingFiles: string[] = [];
  const mismatchedFiles: string[] = [];

  for (const file of manifest.files) {
    const absolutePath = path.join(snapshotDir, file.path);
    if (!fs.existsSync(absolutePath)) {
      missingFiles.push(file.path);
      continue;
    }
    const stat = fs.statSync(absolutePath);
    if (stat.size !== file.sizeBytes || sha256File(absolutePath) !== file.sha256) {
      mismatchedFiles.push(file.path);
    }
  }

  return {
    ok: missingFiles.length === 0 && mismatchedFiles.length === 0,
    checkedFiles: manifest.files.length,
    totalBytes: manifest.files.reduce((sum, file) => sum + file.sizeBytes, 0),
    missingFiles,
    mismatchedFiles,
    manifest,
  };
}

export function buildBackupRestorePlan(idOrRef?: string | null, targetDataDir = DATA_DIR): BackupRestorePlan {
  const verification = verifyBackup(idOrRef);
  if (!verification.ok) {
    throw new Error(`Backup failed verification: missing=${verification.missingFiles.length}, mismatched=${verification.mismatchedFiles.length}`);
  }
  const backup = resolveBackup(idOrRef);
  if (!backup) {
    throw new Error(`Backup not found: ${idOrRef || "latest"}`);
  }
  const warnings: string[] = [];
  if (path.resolve(targetDataDir) === DATA_DIR) {
    warnings.push("Restore target is the live data directory; stop the server before applying.");
  }
  return {
    backupId: backup.id,
    backupDir: backup.backupDir,
    targetDataDir: path.resolve(targetDataDir),
    files: verification.manifest.files.map((file) => file.path),
    warnings,
  };
}

export function restoreBackup(idOrRef?: string | null, options?: { targetDataDir?: string; dryRun?: boolean }): BackupRestoreResult {
  const targetDataDir = path.resolve(options?.targetDataDir || DATA_DIR);
  const plan = buildBackupRestorePlan(idOrRef, targetDataDir);
  if (options?.dryRun !== false) {
    return { ...plan, restored: false };
  }

  const snapshotDir = path.join(plan.backupDir, "snapshot");
  if (!fs.existsSync(snapshotDir)) {
    throw new Error(`Backup snapshot directory missing: ${snapshotDir}`);
  }
  fs.mkdirSync(targetDataDir, { recursive: true });
  fs.cpSync(snapshotDir, targetDataDir, { recursive: true, force: true, dereference: false });
  return { ...plan, restored: true };
}
