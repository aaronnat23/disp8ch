/**
 * Image edit provider-contract regression (no provider credentials).
 *
 * Guards the generate/edit request contract + capability validation: edit
 * requires an edit-capable provider, input images by controlled asset id only
 * (no URLs/paths), MIME/count limits, and that a generation-only provider
 * truthfully rejects edits instead of silently generating.
 *
 * Run: pnpm exec tsx scripts/image-edit-provider-regression.ts
 */
import {
  DEFAULT_IMAGE_CAPABILITIES,
  resolveImageCapabilities,
  validateImageRequest,
  type ImageGenerationRequest,
  type ImageProviderCapabilities,
} from "../src/lib/image-gen/provider";
import { openaiImageProvider } from "../src/lib/image-gen/providers/openai";
import { falProvider } from "../src/lib/image-gen/providers/fal";
import { xaiImageProvider } from "../src/lib/image-gen/providers/xai";

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

const gen: ImageGenerationRequest = { prompt: "a cat", aspectRatio: "square", mode: "generate" };
const editCaps: ImageProviderCapabilities = resolveImageCapabilities(openaiImageProvider);
const genOnlyCaps: ImageProviderCapabilities = resolveImageCapabilities(falProvider);

console.log("\nCapabilities");
check("default capabilities are generation-only", DEFAULT_IMAGE_CAPABILITIES.supportsEditing === false && DEFAULT_IMAGE_CAPABILITIES.supportsGeneration);
check("OpenAI provider advertises editing", editCaps.supportsEditing === true && editCaps.maxReferenceImages >= 1);
check("FAL provider falls back to generation-only", genOnlyCaps.supportsEditing === false);

console.log("\nGenerate validation");
check("generate accepted on a generation provider", validateImageRequest(gen, genOnlyCaps).ok);

console.log("\nEdit validation");
check(
  "edit rejected on a generation-only provider (truthful error)",
  (() => {
    const v = validateImageRequest({ ...gen, mode: "edit", inputImages: [{ assetId: "img_1" }] }, genOnlyCaps);
    return !v.ok && /does not support image editing/i.test(v.error || "");
  })(),
);
check(
  "edit accepted on an edit-capable provider with a valid asset id",
  validateImageRequest({ ...gen, mode: "edit", inputImages: [{ assetId: "img_123", mimeType: "image/png" }] }, editCaps).ok,
);
check(
  "edit without input images rejected",
  !validateImageRequest({ ...gen, mode: "edit", inputImages: [] }, editCaps).ok,
);
check(
  "too many reference images rejected",
  !validateImageRequest({
    ...gen,
    mode: "edit",
    inputImages: Array.from({ length: 17 }, (_, index) => ({ assetId: `asset_${index}` })),
  }, editCaps).ok,
);
check(
  "raw URL asset reference rejected (no SSRF/path)",
  !validateImageRequest({ ...gen, mode: "edit", inputImages: [{ assetId: "https://evil.example/x.png" }] }, editCaps).ok,
);
check(
  "filesystem path asset reference rejected",
  !validateImageRequest({ ...gen, mode: "edit", inputImages: [{ assetId: "../../etc/passwd" }] }, editCaps).ok,
);
check(
  "unsupported MIME rejected",
  !validateImageRequest({ ...gen, mode: "edit", inputImages: [{ assetId: "img_1", mimeType: "image/gif" }] }, editCaps).ok,
);

console.log("\nProvider capability reporting (no DB/provider init)");
{
  // Each built-in provider resolves capabilities without throwing; OpenAI edits.
  check("xai resolves capabilities (generation)", resolveImageCapabilities(xaiImageProvider).supportsGeneration === true);
  check("openai edit cap matches GPT Image multi-reference limit", editCaps.maxReferenceImages === 16);
  check("generation-only provider reports 0 reference images", genOnlyCaps.maxReferenceImages === 0);
}

console.log(`\n${"─".repeat(50)}`);
console.log(`image-edit-provider-regression: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("Failed cases:", failures.join(", "));
  process.exit(1);
}
console.log("All image edit provider-contract tests passed.");
process.exit(0);
