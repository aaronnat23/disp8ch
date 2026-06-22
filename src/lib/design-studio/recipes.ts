import fs from "node:fs";
import path from "node:path";
import type { DesignRecipe } from "@/lib/design-studio/types";

const BUILTIN_RECIPES: DesignRecipe[] = [
  {
    id: "landing-page",
    label: "Landing Page",
    artifactKind: "html",
    defaultCanvas: "responsive",
    sections: ["nav", "hero", "proof", "features", "pricing", "cta", "footer"],
    qualityChecks: ["strong-first-viewport", "responsive", "clear-cta", "no-fake-claims"],
    body: "Use for product, venue, portfolio, or campaign pages. Keep the first viewport focused and include stable data-disp8ch-id markers on major sections.",
  },
  {
    id: "dashboard",
    label: "Dashboard",
    artifactKind: "html",
    defaultCanvas: "responsive",
    sections: ["sidebar", "topbar", "kpis", "chart", "table", "empty-state"],
    qualityChecks: ["dense-but-scannable", "no-fake-live-data", "responsive-table-state"],
    body: "Use quiet operational layouts with compact controls, clear hierarchy, and sample data labeled as sample.",
  },
  {
    id: "poster",
    label: "Poster",
    artifactKind: "html",
    defaultCanvas: "portrait",
    sections: ["masthead", "details", "visual", "cta", "sponsors"],
    qualityChecks: ["text-fit", "print-friendly", "mobile-preview"],
    body: "Use for event or promotional posters. Prioritize legibility and avoid tiny dense copy.",
  },
  {
    id: "deck",
    label: "Deck",
    artifactKind: "html",
    defaultCanvas: "wide",
    sections: ["cover", "problem", "solution", "evidence", "plan", "close"],
    qualityChecks: ["one-idea-per-slide", "print-friendly", "no-overlap"],
    body: "Use semantic slide sections with data-disp8ch-id markers so individual slides can be edited later.",
  },
  {
    id: "admin-tool",
    label: "Admin Tool",
    artifactKind: "html",
    defaultCanvas: "responsive",
    sections: ["nav", "filters", "table", "detail-panel", "bulk-actions"],
    qualityChecks: ["predictable-controls", "keyboard-scannable", "no-marketing-hero"],
    body: "Use restrained work-focused UI with dense but readable information and stable controls.",
  },
];

function recipesDir(): string {
  return path.resolve(process.cwd(), "src", "lib", "design-studio", "recipes");
}

export function listDesignRecipes(): DesignRecipe[] {
  const dir = recipesDir();
  if (!fs.existsSync(dir)) return BUILTIN_RECIPES;
  const fileRecipes = fs.readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => {
      const body = fs.readFileSync(path.join(dir, name), "utf8");
      const id = name.replace(/\.md$/i, "");
      const label = id.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
      return {
        id,
        label,
        artifactKind: "html" as const,
        defaultCanvas: "responsive",
        sections: [],
        qualityChecks: [],
        body,
      };
    });
  const seen = new Set(fileRecipes.map((recipe) => recipe.id));
  return [...fileRecipes, ...BUILTIN_RECIPES.filter((recipe) => !seen.has(recipe.id))];
}
