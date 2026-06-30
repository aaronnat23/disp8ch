/**
 * Design Studio intake UI smoke (static source assertion, no browser).
 *
 * Verifies the clean design-focused intake: a friendly headline, two
 * import pills (screenshot / HTML), a bottom composer (design-system picker,
 * brief textarea, recipe chips, Send/generate), a shared in-place assistant,
 * and the preview/edit/code
 * canvas views. Deterministic so it runs in the release suite; the live Windows
 * run exercises actual rendering.
 *
 * Run: pnpm exec tsx scripts/design-studio-intake-ui-smoke.ts
 */
import fs from "node:fs";
import path from "node:path";

let passed = 0,
  failed = 0;
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

const shellPath = path.join(process.cwd(), "src/components/design-studio/DesignStudioShell.tsx");
const src = fs.readFileSync(shellPath, "utf8");

console.log("\n[1] Clean intake: headline + import pills");
check("friendly headline", src.includes("What are we") && src.includes("designing?"));
check("lo-fi subtitle", src.includes("Lo-fi moves fast"));
check("add a screenshot pill", src.includes("Add a screenshot"));
check("paste HTML/notes pill", src.includes("Paste HTML or notes"));

console.log("\n[2] Import flows wired");
check("image import mode", src.includes('setImportMode("image")'));
check("html/source import mode", src.includes('setImportMode("html")'));

console.log("\n[3] Composer with brief + generate");
check("brief composer placeholder", src.includes("Describe what you want to create"));
check("in-place shared assistant", src.includes("SurfaceAssistantPanel") && src.includes("assistantSessionId"));
check("Send/generate action", src.includes("buildAssistantRequest") && src.includes('textareaId="design-ai-composer"'));
check("design system label", src.includes("Design system"));

console.log("\n[4] Template (recipe) picker");
check("loads recipes", src.includes("/api/design/recipes"));
check("recipe chips render", src.includes("recipes") && src.includes(".map((recipe)"));
check("selects a recipe", src.includes("setSelectedRecipeId"));

console.log("\n[5] Design-system picker + canvas views");
check("loads systems", src.includes("/api/design/systems"));
check("system options render", src.includes("systems.map"));
check("preview/edit/code views", src.includes('"preview", "edit", "code"'));
check("clean canvas empty state", src.includes("No file open"));
check("active artifact revisions stay in place", src.includes('mode: activeArtifact ? "revise" : "create"'));
check("selected element can scope AI edits", src.includes("scopeSelectedElement") && src.includes("Scope the next AI change"));

console.log(`\ndesign-studio-intake-ui-smoke: ${passed}/${passed + failed} passed`);
if (failed > 0) {
  console.error(`Failures: ${failures.join(", ")}`);
  process.exit(1);
}
