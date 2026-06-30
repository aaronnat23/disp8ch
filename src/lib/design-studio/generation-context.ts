/**
 * Composes the recipe + design-system generation contract that is injected into
 * the Design Studio prompt. This is the "resource-driven generation" contract:
 * required sections, quality checklist, output contract, and the selected design
 * system's tokens/guidance — not just a style hint.
 */
import { getDesignRecipe } from "@/lib/design-studio/recipes";
import { getDesignSystem } from "@/lib/design-studio/store";

export type DesignGenerationContext = {
  recipeId: string | null;
  designSystemId: string | null;
  requiredSections: string[];
  qualityChecks: string[];
  outputContract: string;
  promptText: string;
};

const DEFAULT_OUTPUT_CONTRACT =
  "Return one standalone HTML document (inline CSS via a <style> block). No external build step or framework runtime. Put stable data-disp8ch-id attributes on every major editable section.";

export function buildDesignGenerationContext(input: {
  recipeId?: string | null;
  designSystemId?: string | null;
}): DesignGenerationContext {
  const recipe = input.recipeId ? getDesignRecipe(input.recipeId) : null;
  const system = input.designSystemId ? getDesignSystem(input.designSystemId) : null;

  const requiredSections = recipe?.sections ?? [];
  const qualityChecks = recipe?.qualityChecks ?? [];
  const outputContract = recipe?.outputContract
    ? `${recipe.outputContract}. ${DEFAULT_OUTPUT_CONTRACT}`
    : DEFAULT_OUTPUT_CONTRACT;

  const lines: string[] = [];
  if (recipe) {
    lines.push(`Template: ${recipe.label} (${recipe.defaultCanvas}).`);
    if (requiredSections.length > 0) lines.push(`Required sections: ${requiredSections.join(", ")}.`);
    if (qualityChecks.length > 0) lines.push(`Quality checklist: ${qualityChecks.join(", ")}.`);
    if (recipe.body) lines.push(recipe.body);
  }
  if (system) {
    lines.push(`Design system: ${system.name}.`);
    if (system.description) lines.push(system.description);
    if (system.tokensCss) {
      lines.push("Use these design tokens:");
      lines.push(system.tokensCss.trim().slice(0, 1600));
    }
    if (system.designMd) lines.push(system.designMd.trim().slice(0, 1200));
  }
  lines.push(`Output contract: ${outputContract}`);

  return {
    recipeId: recipe?.id ?? null,
    designSystemId: system?.id ?? null,
    requiredSections,
    qualityChecks,
    outputContract,
    promptText: lines.join("\n"),
  };
}

export type DesignImportClassification = {
  kind: "reference" | "artifact";
  reason: string;
  conversionAction: string | null;
};

/**
 * Decide whether an import becomes an editable artifact directly, or stays a
 * reference until the user explicitly converts it. Images and framework/source
 * code are references by default; only standalone HTML is a direct artifact.
 */
export function classifyDesignImport(input: {
  mimeType?: string | null;
  fileName?: string | null;
  content?: string | null;
}): DesignImportClassification {
  const mime = String(input.mimeType || "").toLowerCase();
  const name = String(input.fileName || "").toLowerCase();
  const content = String(input.content || "");

  if (mime.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|svg)$/.test(name)) {
    return {
      kind: "reference",
      reason: "Images are imported as a reference, not the final artifact.",
      conversionAction: "Generate editable HTML from this image",
    };
  }

  const isStandaloneHtml = /<!doctype html>/i.test(content) || /<html[\s>]/i.test(content);
  if (isStandaloneHtml) {
    return { kind: "artifact", reason: "Standalone HTML becomes an editable artifact directly.", conversionAction: null };
  }

  // React / Tailwind / JSX / other source: reference until conversion.
  if (
    /\.(jsx|tsx|vue|svelte)$/.test(name) ||
    /\bimport\s+React\b/.test(content) ||
    /className=|export default function|@apply\b/.test(content)
  ) {
    return {
      kind: "reference",
      reason: "Framework/source code is imported as a reference until converted to standalone HTML.",
      conversionAction: "Convert source to standalone HTML",
    };
  }

  // Plain HTML fragment: treat as a convertible reference.
  return {
    kind: "reference",
    reason: "Imported source is a reference until converted to a standalone HTML artifact.",
    conversionAction: "Convert source to standalone HTML",
  };
}
