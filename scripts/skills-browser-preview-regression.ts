/**
 * Skills catalog browse/preview regression (no server, reads bundled packs).
 *
 * Guards source-neutral discovery (bundled + optional), search filtering,
 * preview shaping (instructions/files/requested-tools/security findings without
 * executing skill content), and path-traversal safety on preview lookups.
 *
 * Run: pnpm exec tsx scripts/skills-browser-preview-regression.ts
 */
import { getSkillCatalogPreview, listSkillCatalog } from "../src/lib/skills/catalog";

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

console.log("\nDiscovery");
const all = listSkillCatalog();
check("catalog is non-empty", all.length > 0, `count=${all.length}`);
check("entries have title + description + source", all.every((e) => e.title && typeof e.description === "string" && (e.source === "bundled" || e.source === "optional")));
check("includes bundled skills", all.some((e) => e.source === "bundled"));
check("includes optional skills", all.some((e) => e.source === "optional"));
check("source filter works", listSkillCatalog({ source: "optional" }).every((e) => e.source === "optional"));

console.log("\nSearch");
const first = all[0];
const q = first.name.slice(0, Math.min(5, first.name.length));
const searched = listSkillCatalog({ query: q });
check("search returns matches", searched.length > 0 && searched.length <= all.length, `q=${q} -> ${searched.length}`);
check("nonsense search returns nothing", listSkillCatalog({ query: "zzz_no_such_skill_zzz" }).length === 0);

console.log("\nPreview");
const preview = getSkillCatalogPreview(first.name);
check("preview resolves a real skill", Boolean(preview) && preview!.name === first.name);
check("preview has instructions (not executed, just text)", Boolean(preview && preview.instructions.length > 0));
check("preview lists files", Boolean(preview && preview.files.length >= 1));
check("preview exposes requestedTools array", Array.isArray(preview?.requestedTools));
check("preview exposes security findings array", Array.isArray(preview?.securityFindings));

console.log("\nPath-traversal safety");
check("traversal name does not escape the skill dirs", getSkillCatalogPreview("../../package.json") === null);
check("absolute path rejected", getSkillCatalogPreview("/etc/passwd") === null);

console.log(`\n${"─".repeat(50)}`);
console.log(`skills-browser-preview-regression: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("Failed cases:", failures.join(", "));
  process.exit(1);
}
console.log("All skills browse/preview tests passed.");
process.exit(0);
