import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectRepoDatabaseCandidate, importDatabaseFromFile } from "../desktop/data-import";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "disp8ch-db-import-"));
try {
  const appRoot = path.join(tempRoot, "app");
  const repoData = path.join(appRoot, "data");
  fs.mkdirSync(repoData, { recursive: true });
  const repoDb = path.join(repoData, "disp8ch.db");
  fs.writeFileSync(repoDb, "repo-db");

  assert.equal(detectRepoDatabaseCandidate(appRoot), repoDb);
  assert.equal(detectRepoDatabaseCandidate(path.join(tempRoot, "missing")), null);

  const dataDir = path.join(tempRoot, "desktop-data");
  fs.mkdirSync(dataDir, { recursive: true });
  const activeDb = path.join(dataDir, "disp8ch.db");
  fs.writeFileSync(activeDb, "old-db");

  const result = importDatabaseFromFile(repoDb, dataDir);
  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(activeDb, "utf8"), "repo-db");
  assert(result.backupPath, "existing desktop DB should be backed up before import");
  assert.equal(fs.readFileSync(result.backupPath!, "utf8"), "old-db");

  const noOp = importDatabaseFromFile(activeDb, dataDir);
  assert.equal(noOp.ok, true);
  assert(noOp.message.includes("already"));

  assert.throws(() => importDatabaseFromFile(path.join(tempRoot, "nope.db"), dataDir), /does not exist/);
  console.log("desktop-data-import-regression: ok");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
