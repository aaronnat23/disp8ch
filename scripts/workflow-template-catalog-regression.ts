/**
 * Workflow template catalog consistency regression.
 *
 * Guards the template references that WebChat workflow creation and
 * `recommend_templates` rely on:
 *   - every catalog entry has a unique key
 *   - every entry resolves by key, name, and each alias
 *   - aliases do not collide across different templates
 *   - recommendations only return real catalog keys
 *
 * (The deeper "every template builds a lint-clean graph" check runs against a
 * live server, since template builders live in the API route.)
 *
 * Run: pnpm exec tsx scripts/workflow-template-catalog-regression.ts
 */

import { listWorkflowTemplateCatalog, resolveWorkflowTemplateReference } from "../src/lib/workflows/template-catalog";
import { recommendWorkflowTemplates } from "../src/lib/workflows/template-recommendations";

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

const catalog = listWorkflowTemplateCatalog();

// ---------------------------------------------------------------------------
// Unique keys
// ---------------------------------------------------------------------------
console.log("\nKeys");
{
  const keys = catalog.map((e) => e.key);
  check("catalog is non-empty", keys.length > 0, `count=${keys.length}`);
  check("all keys unique", new Set(keys).size === keys.length, `dupes: ${keys.filter((k, i) => keys.indexOf(k) !== i).join(",")}`);
  check("keys are slug-shaped", keys.every((k) => /^[a-z0-9-]+$/.test(k)), keys.filter((k) => !/^[a-z0-9-]+$/.test(k)).join(","));
}

// ---------------------------------------------------------------------------
// Resolution by key, name, alias
// ---------------------------------------------------------------------------
console.log("\nResolution");
{
  let resolveFailures: string[] = [];
  for (const entry of catalog) {
    if (resolveWorkflowTemplateReference(entry.key)?.key !== entry.key) resolveFailures.push(`key:${entry.key}`);
    if (resolveWorkflowTemplateReference(entry.name)?.key !== entry.key) resolveFailures.push(`name:${entry.name}`);
    for (const alias of entry.aliases) {
      const resolved = resolveWorkflowTemplateReference(alias);
      if (!resolved) resolveFailures.push(`alias:${alias}`);
    }
  }
  check("every entry resolves by key", !resolveFailures.some((f) => f.startsWith("key:")), resolveFailures.filter((f) => f.startsWith("key:")).join(","));
  check("every entry resolves by name", !resolveFailures.some((f) => f.startsWith("name:")), resolveFailures.filter((f) => f.startsWith("name:")).join(","));
  check("every alias resolves to a template", !resolveFailures.some((f) => f.startsWith("alias:")), resolveFailures.filter((f) => f.startsWith("alias:")).join(","));
}

// ---------------------------------------------------------------------------
// Alias collisions across different templates
// ---------------------------------------------------------------------------
console.log("\nAlias collisions");
{
  const aliasOwner = new Map<string, string>();
  const collisions: string[] = [];
  for (const entry of catalog) {
    for (const alias of entry.aliases) {
      const norm = alias.trim().toLowerCase();
      const existing = aliasOwner.get(norm);
      if (existing && existing !== entry.key) collisions.push(`${norm} (${existing} vs ${entry.key})`);
      else aliasOwner.set(norm, entry.key);
    }
  }
  check("no alias is claimed by two templates", collisions.length === 0, collisions.join("; "));
}

// ---------------------------------------------------------------------------
// Recommendations only return real keys
// ---------------------------------------------------------------------------
console.log("\nRecommendations");
{
  const keys = new Set(catalog.map((e) => e.key));
  const recs = recommendWorkflowTemplates("research and summarize the web", 5);
  check("recommendations returned", recs.length > 0, `count=${recs.length}`);
  check("all recommended keys exist in the catalog", recs.every((r) => keys.has(r.entry.key)), recs.map((r) => r.entry.key).join(","));
  const overnight = recommendWorkflowTemplates("overnight autonomy morning brief with telegram approvals and wakeups", 3);
  check(
    "overnight autonomy recommendation is discoverable",
    overnight.some((r) => r.entry.key === "overnight-autonomy-briefing"),
    overnight.map((r) => r.entry.key).join(","),
  );
  const strategy = recommendWorkflowTemplates("research a strategy, challenge its assumptions, and revise the plan", 3);
  check(
    "strategy hardening recommendation is discoverable",
    strategy.some((r) => r.entry.key === "strategy-hardening-loop"),
    strategy.map((r) => r.entry.key).join(","),
  );
  const support = recommendWorkflowTemplates("triage customer support messages and draft a response for approval", 3);
  check(
    "support signal triage recommendation is discoverable",
    support.some((r) => r.entry.key === "support-signal-triage"),
    support.map((r) => r.entry.key).join(","),
  );
}

console.log(`\n${"─".repeat(50)}`);
console.log(`workflow-template-catalog-regression: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.error("Failed cases:", failures.join(", "));
  process.exit(1);
}
console.log("All template-catalog regression tests passed.");
