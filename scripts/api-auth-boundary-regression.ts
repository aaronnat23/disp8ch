/**
 * API auth-boundary inventory regression (static, no server).
 *
 * Every `src/app/api/**\/route.ts` must have a declared security classification:
 *   - GUARDED:  references an operator/admin/access/acp/signature guard
 *   - PUBLIC:   explicitly allowlisted as intentionally unauthenticated
 *   - SIGNED:   explicitly allowlisted as external signed/ingress
 * A new route with none of the above FAILS this test — forcing a classification
 * decision rather than shipping an unguarded endpoint by accident.
 *
 * Run: pnpm exec tsx scripts/api-auth-boundary-regression.ts
 */
import fs from "node:fs";
import path from "node:path";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const GUARD_PATTERNS = [
  "requireOperatorAccess",
  "requireAdminAccess",
  "requireAccess",
  "prepareDesignApi",
  "requireSignedWebhook",
  "verifyWebhook",
  "requireChannelAccess",
  "requireAcpAuth",
  "validateAcpBearerToken",
  "verifyWebhookSignature",
];

// Intentionally unauthenticated (liveness, first-run, auth flow, static caps).
const PUBLIC_ALLOWLIST = new Set([
  "health/route.ts",
  "capabilities/route.ts",
  "onboarding/route.ts",
  "auth/logout/route.ts",
  "auth/me/route.ts",
  "auth/google/callback/route.ts",
  "auth/google/login/route.ts",
]);

// External signed/ingress endpoints (verify a signature/token internally).
const SIGNED_ALLOWLIST = new Set([
  "webhooks/[id]/route.ts",
  "channels/teams/route.ts",
  "channels/google-chat/route.ts",
]);

// These specific sensitive routes MUST be operator-guarded (the P0 finding).
const MUST_BE_OPERATOR_GUARDED = [
  "provider-oauth/route.ts",
  "logs/bootstrap/route.ts",
  "maintenance/bootstrap/route.ts",
  "dashboard/bootstrap/route.ts",
  "files/bootstrap/route.ts",
  "usage/bootstrap/route.ts",
  "metrics/bootstrap/route.ts",
  "settings/bootstrap/route.ts",
  "search/route.ts",
  "app-shell/route.ts",
  "undo/route.ts",
];

const apiRoot = path.join("src", "app", "api");
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name === "route.ts") out.push(full);
  }
  return out;
}

const routes = walk(apiRoot).map((f) => f.replace(apiRoot + path.sep, "").replace(/\\/g, "/"));
console.log(`\nClassifying ${routes.length} API routes`);

const unclassified: string[] = [];
let guardedCount = 0;
let publicCount = 0;
let signedCount = 0;
for (const rel of routes) {
  const src = fs.readFileSync(path.join(apiRoot, rel), "utf-8");
  const guarded = GUARD_PATTERNS.some((p) => src.includes(p));
  if (guarded) guardedCount++;
  else if (PUBLIC_ALLOWLIST.has(rel)) publicCount++;
  else if (SIGNED_ALLOWLIST.has(rel)) signedCount++;
  else unclassified.push(rel);
}

console.log(`  guarded=${guardedCount} public=${publicCount} signed=${signedCount} unclassified=${unclassified.length}`);
check(
  "every API route has a security classification",
  unclassified.length === 0,
  unclassified.length ? `unclassified: ${unclassified.join(", ")}` : undefined,
);

console.log("\nSensitive routes are operator-guarded");
for (const rel of MUST_BE_OPERATOR_GUARDED) {
  const full = path.join(apiRoot, rel);
  const src = fs.existsSync(full) ? fs.readFileSync(full, "utf-8") : "";
  check(`${rel} calls requireOperatorAccess`, src.includes("requireOperatorAccess"));
}

console.log("\nHealth redaction");
{
  const src = fs.readFileSync(path.join(apiRoot, "health/route.ts"), "utf-8");
  check("health references operator access for redaction", src.includes("requireOperatorAccess"));
  check("health redacts detailed view when unauthenticated", /detailed|publicChecks/.test(src));
}

console.log("\nExternal channel ingress verifies platform JWTs");
for (const rel of ["channels/teams/route.ts", "channels/google-chat/route.ts"]) {
  const src = fs.readFileSync(path.join(apiRoot, rel), "utf-8");
  check(`${rel} calls a platform JWT verifier`, /verify(?:Teams|GoogleChat)Ingress/.test(src));
}
{
  const onboarding = fs.readFileSync(path.join(apiRoot, "onboarding/route.ts"), "utf-8");
  check("completed onboarding changes require operator access", onboarding.includes("requireOperatorAccess") && onboarding.includes("onboarding_done"));
}

console.log(`\n${"─".repeat(50)}`);
console.log(`api-auth-boundary-regression: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("Failed cases:", failures.join(", "));
  process.exit(1);
}
console.log("All API auth-boundary checks passed.");
process.exit(0);
