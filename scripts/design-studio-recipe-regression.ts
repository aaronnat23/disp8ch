/**
 * Design Studio recipe + generation-context regression (temp DB, no model).
 *
 * Proves Phase 6 template contract:
 *  - recipe `.md` packs load with parsed sections/quality/output contract,
 *  - the generation context injects required sections + quality checks,
 *  - the output contract requires standalone HTML with editable markers,
 *  - a built-in design system contributes tokens to the context.
 *
 * Run: pnpm exec tsx scripts/design-studio-recipe-regression.ts
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const tmp = path.join(os.tmpdir(), `disp8ch_design_recipe_${Date.now()}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.DATABASE_PATH = path.join(tmp, "design.db");
process.env.MEMORY_PATH = path.join(tmp, "memories");
process.env.WORKSPACE_PATH = path.join(tmp, "workspace");

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

async function main() {
  const { initializeDatabase } = await import("../src/lib/db");
  const { listDesignRecipes, getDesignRecipe } = await import("../src/lib/design-studio/recipes");
  const { buildDesignGenerationContext } = await import("../src/lib/design-studio/generation-context");
  const { listBuiltinDesignSystems } = await import("../src/lib/design-studio/design-systems");

  initializeDatabase();

  console.log("\n[1] Recipe packs load with parsed metadata");
  const recipes = listDesignRecipes();
  const ids = recipes.map((r) => r.id);
  for (const id of ["web-prototype", "saas-landing", "kanban-board", "dashboard", "admin-tool", "mobile-app", "deck"]) {
    check(`recipe ${id} present`, ids.includes(id));
  }
  const saas = getDesignRecipe("saas-landing")!;
  check("saas-landing has sections", saas.sections.length > 0, `got ${saas.sections.length}`);
  check("saas-landing has quality checks", saas.qualityChecks.length > 0);
  check("saas-landing has output contract", Boolean(saas.outputContract));

  console.log("\n[2] Built-in design systems load (recommended first)");
  const systems = listBuiltinDesignSystems();
  check("at least 3 built-in systems", systems.length >= 3, `got ${systems.length}`);
  check("disp8ch-terminal present", systems.some((s) => s.id === "builtin:disp8ch-terminal"));
  check("first system is recommended", systems[0]?.recommended === true);

  console.log("\n[3] Generation context injects required sections + quality + contract");
  const ctx = buildDesignGenerationContext({ recipeId: "kanban-board", designSystemId: "builtin:disp8ch-terminal" });
  check("required sections populated", ctx.requiredSections.includes("block-badge") || ctx.requiredSections.length > 0);
  check("quality checks populated", ctx.qualityChecks.length > 0);
  check("prompt mentions required sections", ctx.promptText.toLowerCase().includes("required sections"));
  check("prompt mentions quality checklist", ctx.promptText.toLowerCase().includes("quality checklist"));

  console.log("\n[4] Output contract requires standalone HTML + edit markers");
  check("contract mentions standalone HTML", /standalone html/i.test(ctx.outputContract));
  check("contract mentions data-disp8ch-id markers", /data-disp8ch-id/i.test(ctx.outputContract));

  console.log("\n[5] Design system tokens contribute to the context");
  check("prompt includes design system name", ctx.promptText.includes("disp8ch Terminal"));
  check("prompt includes design tokens", ctx.promptText.includes("--color-accent"));

  console.log(`\ndesign-studio-recipe: ${passed}/${passed + failed} passed`);
  if (failed > 0) {
    console.error(`Failures: ${failures.join(", ")}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
