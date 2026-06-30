import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";

const cliPath = path.resolve(process.cwd(), "scripts", "cli.ts");

const raw = execFileSync(process.execPath, ["--import", "tsx", cliPath, "doctor", "--json"], {
  cwd: process.cwd(),
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 45000,
});

const parsed = JSON.parse(raw) as {
  ok?: boolean;
  checks?: Array<{ name?: string; status?: string; summary?: string; repair?: unknown }>;
};

assert.equal(typeof parsed.ok, "boolean");
assert(Array.isArray(parsed.checks));
assert(parsed.checks.length > 0);
assert(parsed.checks.some((check) => check.name === "database"));
assert(parsed.checks.every((check) => ["ok", "warn", "fail"].includes(String(check.status))));
assert(!raw.includes("AIza"));
assert(!raw.includes("sk-"));

console.log("install-doctor-regression: ok");
