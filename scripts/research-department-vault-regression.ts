/**
 * Research Department vault initializer regression (no DB, no model).
 *
 * Guards the reusable vault helpers: folder tree creation, SCHEMA.md, slug
 * sanitization, and the path-safety check that keeps writes inside the vault.
 *
 * Run: pnpm exec tsx scripts/research-department-vault-regression.ts
 */

import fs from "node:fs";
import path from "node:path";
import {
  computeVaultPaths,
  defaultVaultRoot,
  initializeVault,
  isInsideVault,
  RESEARCH_SUBDIRS,
  removeVault,
  sanitizeSlug,
  validateVaultRoot,
  WIKI_SUBDIRS,
} from "../src/lib/research-department/vault";

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

const testRoot = path.join("data", "workspace", "research-department", `__vault-test-${Date.now()}`);

try {
  console.log("\nSlug sanitization");
  check("uppercase + spaces become kebab", sanitizeSlug("My Research Desk!") === "my-research-desk");
  check("empty falls back", sanitizeSlug("   ") === "research-department");
  check("default vault root uses slug", defaultVaultRoot("AI Desk").endsWith(path.join("research-department", "ai-desk")));

  console.log("\nPath safety");
  check("inside vault detected", isInsideVault("/a/b", "/a/b/c/d.md"));
  check("root itself is inside", isInsideVault("/a/b", "/a/b"));
  check("escape rejected", !isInsideVault("/a/b", "/a/c/x.md"));
  check("dotdot escape rejected", !isInsideVault("/a/b", "/a/b/../x.md"));
  check("custom path outside workspace rejected by default", !validateVaultRoot("/tmp/whatever").ok);
  check("custom path allowed with confirmation", validateVaultRoot("/tmp/whatever", { allowCustomPath: true }).ok);
  check("workspace path always allowed", validateVaultRoot(testRoot).ok);

  console.log("\nVault initialization");
  const { paths, createdSchema } = initializeVault(testRoot, { focusArea: "local-first AI agents" });
  check("vault root created", fs.existsSync(paths.root));
  check("SCHEMA.md created", fs.existsSync(paths.schema) && createdSchema);
  for (const sub of [...RESEARCH_SUBDIRS, ...WIKI_SUBDIRS]) {
    check(`folder exists: ${sub}`, fs.existsSync(path.join(paths.root, sub)));
  }
  const schemaText = fs.readFileSync(paths.schema, "utf-8");
  check("SCHEMA references focus area", schemaText.includes("local-first AI agents"));
  check("SCHEMA documents confidence tags", /\[verified\]/.test(schemaText) && /\[conflicting\]/.test(schemaText));

  // Idempotency
  const second = initializeVault(testRoot, { focusArea: "local-first AI agents" });
  check("re-init is idempotent (schema not recreated)", second.createdSchema === false);

  // computeVaultPaths consistency
  const cp = computeVaultPaths(testRoot);
  check("computeVaultPaths matches init paths", cp.inbox === paths.inbox && cp.wikiBriefs === paths.wikiBriefs);
} finally {
  removeVault(testRoot);
}

console.log(`\n${"─".repeat(50)}`);
console.log(`research-department-vault-regression: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("Failed cases:", failures.join(", "));
  process.exit(1);
}
console.log("All vault regression tests passed.");
process.exit(0);
