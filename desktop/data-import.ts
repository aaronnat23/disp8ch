import fs from "node:fs";
import path from "node:path";

export type DatabaseImportResult = {
  ok: boolean;
  sourcePath: string;
  targetPath: string;
  backupPath?: string;
  message: string;
};

export function detectRepoDatabaseCandidate(appRoot: string): string | null {
  const candidate = path.join(appRoot, "data", "disp8ch.db");
  return fs.existsSync(candidate) ? candidate : null;
}

export function importDatabaseFromFile(sourcePath: string, dataDir: string): DatabaseImportResult {
  const resolvedSource = path.resolve(sourcePath);
  const targetPath = path.join(dataDir, "disp8ch.db");
  if (!fs.existsSync(resolvedSource)) {
    throw new Error(`Selected database does not exist: ${resolvedSource}`);
  }
  const sourceStat = fs.statSync(resolvedSource);
  if (!sourceStat.isFile()) {
    throw new Error(`Selected database is not a file: ${resolvedSource}`);
  }
  if (path.resolve(resolvedSource) === path.resolve(targetPath)) {
    return {
      ok: true,
      sourcePath: resolvedSource,
      targetPath,
      message: "Selected database is already the active desktop database.",
    };
  }

  fs.mkdirSync(dataDir, { recursive: true });
  let backupPath: string | undefined;
  if (fs.existsSync(targetPath)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupDir = path.join(dataDir, "db-backups");
    fs.mkdirSync(backupDir, { recursive: true });
    backupPath = path.join(backupDir, `pre-import-${stamp}.db`);
    fs.copyFileSync(targetPath, backupPath);
  }
  fs.copyFileSync(resolvedSource, targetPath);
  return {
    ok: true,
    sourcePath: resolvedSource,
    targetPath,
    backupPath,
    message: backupPath
      ? `Imported database and backed up the previous desktop DB to ${backupPath}.`
      : "Imported database into the desktop data directory.",
  };
}
