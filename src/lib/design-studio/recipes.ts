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

function parseInlineList(value: string): string[] {
  const trimmed = value.trim().replace(/^\[|\]$/g, "");
  return trimmed
    .split(",")
    .map((item) => item.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

/** Parse a recipe `.md` file with simple YAML frontmatter into a DesignRecipe. */
function parseRecipeFile(id: string, raw: string): DesignRecipe {
  const fm = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  const meta: Record<string, string> = {};
  let body = raw;
  if (fm) {
    body = fm[2];
    for (const line of fm[1].split(/\r?\n/)) {
      const m = line.match(/^([a-zA-Z][\w-]*)\s*:\s*(.*)$/);
      if (m) meta[m[1].trim()] = m[2].trim();
    }
  }
  const defaultLabel = id.split("-").map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" ");
  return {
    id,
    label: meta.label || defaultLabel,
    artifactKind: "html",
    defaultCanvas: meta.canvas || "responsive",
    sections: meta.sections ? parseInlineList(meta.sections) : [],
    qualityChecks: meta.qualityChecks ? parseInlineList(meta.qualityChecks) : [],
    outputContract: meta.outputContract || undefined,
    body: body.trim(),
  };
}

export function listDesignRecipes(): DesignRecipe[] {
  const dir = recipesDir();
  if (!fs.existsSync(dir)) return BUILTIN_RECIPES;
  const fileRecipes = fs.readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => parseRecipeFile(name.replace(/\.md$/i, ""), fs.readFileSync(path.join(dir, name), "utf8")));
  const seen = new Set(fileRecipes.map((recipe) => recipe.id));
  return [...fileRecipes, ...BUILTIN_RECIPES.filter((recipe) => !seen.has(recipe.id))];
}

export function getDesignRecipe(id: string): DesignRecipe | null {
  return listDesignRecipes().find((r) => r.id === id) ?? null;
}
