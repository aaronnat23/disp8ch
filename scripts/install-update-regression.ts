import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const cli = path.join(root, "scripts", "cli.ts");

const raw = execFileSync(process.execPath, ["--import", "tsx", cli, "update", "--dry-run", "--json"], {
  cwd: root,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    DISP8CH_INSTALL_CHANNEL: "script",
  },
});

const parsed = JSON.parse(raw) as {
  ok?: boolean;
  dryRun?: boolean;
  channel?: string;
  version?: string;
  dataDir?: string;
  databasePath?: string;
  steps?: Array<{ action?: string; status?: string; details?: string }>;
};

assert.equal(parsed.ok, true);
assert.equal(parsed.dryRun, true);
assert.equal(parsed.channel, "script");
assert(parsed.version);
assert(parsed.dataDir);
assert(parsed.databasePath);
assert(Array.isArray(parsed.steps));
assert(parsed.steps.some((step) => step.action === "script-update" && step.details?.includes("preserve")));

console.log("install-update-regression: ok");
