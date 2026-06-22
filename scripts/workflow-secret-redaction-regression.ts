/**
 * Workflow secret-redaction regression.
 *
 * Verifies that secret-like values are scrubbed from exports / trace previews
 * while credential references are preserved.
 *
 * Run: pnpm exec tsx scripts/workflow-secret-redaction-regression.ts
 */

import { redactSecretsDeep, redactWorkflowExport, isSecretKey } from "../src/lib/workflows/secret-redaction";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const REDACTED = "[redacted]";
const OPENAI_STYLE_SECRET = ["sk", "1234567890abcdefghij"].join("-");
const OPENAI_STYLE_BEARER_SECRET = ["sk", "supersecrettoken1234567890"].join("-");
const SLACK_STYLE_SECRET = ["xoxb", "1111111111", "abcdefghijklmnop"].join("-");

// Secret-keyed values are redacted.
console.log("\nKey-based redaction");
{
  const redacted = redactSecretsDeep({
    apiKey: "dummy-api-key-value",
    api_key: "raw-value",
    password: "hunter2",
    authToken: "tok_live_123",
    nested: { client_secret: "very-secret", normal: "keep-me" },
  }) as Record<string, unknown>;
  check("apiKey redacted", redacted.apiKey === REDACTED);
  check("api_key redacted", redacted.api_key === REDACTED);
  check("password redacted", redacted.password === REDACTED);
  check("authToken redacted", redacted.authToken === REDACTED);
  check("nested client_secret redacted", (redacted.nested as Record<string, unknown>).client_secret === REDACTED);
  check("non-secret field preserved", (redacted.nested as Record<string, unknown>).normal === "keep-me");
}

// Credential references are preserved.
console.log("\nReference preservation");
{
  const redacted = redactSecretsDeep({
    secretRef: "secret:my-token",
    credentialId: "cred_123",
    maskedSecretRef: "secret:my-t...oken",
    token: "secret:another-ref",
    headerValue: "{{credentials.github.token}}",
  }) as Record<string, unknown>;
  check("secretRef reference preserved", redacted.secretRef === "secret:my-token");
  check("credentialId preserved", redacted.credentialId === "cred_123");
  check("maskedSecretRef preserved", redacted.maskedSecretRef === "secret:my-t...oken");
  check("token holding a reference preserved", redacted.token === "secret:another-ref");
  check("template expression preserved", redacted.headerValue === "{{credentials.github.token}}");
}

// Value-shape redaction regardless of key.
console.log("\nValue-shape redaction");
{
  const redacted = redactSecretsDeep({
    note: `use ${OPENAI_STYLE_SECRET} to authenticate`,
    header: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456",
    slack: SLACK_STYLE_SECRET,
    plain: "no secrets here",
  }) as Record<string, unknown>;
  check("openai-style key scrubbed in free text", !String(redacted.note).includes(OPENAI_STYLE_SECRET) && String(redacted.note).includes(REDACTED));
  check("bearer header scrubbed", String(redacted.header).includes(REDACTED));
  check("slack token scrubbed", String(redacted.slack).includes(REDACTED));
  check("plain text untouched", redacted.plain === "no secrets here");
}

// Workflow export redaction (nodes with secret config).
console.log("\nWorkflow export redaction");
{
  const exportData = redactWorkflowExport({
    _disp8chExport: true,
    name: "Has Secrets",
    nodes: [
      { id: "n1", type: "http-request", data: { url: "https://api.example.com", headers: { Authorization: `Bearer ${OPENAI_STYLE_BEARER_SECRET}` }, apiKey: "raw-leaked-key" } },
      { id: "n2", type: "http-request", data: { credentialRef: "secret:example-api" } },
    ],
    edges: [],
  }) as { nodes: Array<{ data: Record<string, unknown> }> };
  const serialized = JSON.stringify(exportData);
  check("raw apiKey not present in export", !serialized.includes("raw-leaked-key"));
  check("bearer secret not present in export", !serialized.includes(OPENAI_STYLE_BEARER_SECRET));
  check("credential reference preserved in export", serialized.includes("secret:example-api"));
}

// isSecretKey direct checks.
console.log("\nisSecretKey helper");
{
  check("apiKey is secret key", isSecretKey("apiKey"));
  check("password is secret key", isSecretKey("password"));
  check("secretRef is NOT a secret key (reference)", !isSecretKey("secretRef"));
  check("url is not a secret key", !isSecretKey("url"));
  check("credentialId is not a secret key", !isSecretKey("credentialId"));
}

console.log(`\n${"─".repeat(50)}`);
console.log(`workflow-secret-redaction-regression: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.error("Failed cases:", failures.join(", "));
  process.exit(1);
}
console.log("All secret-redaction regression tests passed.");
