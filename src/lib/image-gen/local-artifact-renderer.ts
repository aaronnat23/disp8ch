import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export type LocalArtifactKind =
  | "ui_mockup"
  | "workflow_diagram"
  | "architecture_diagram"
  | "hero_mockup"
  | "poster"
  | "generic_visual";

export interface LocalArtifactRenderRequest {
  prompt: string;
  width?: number;
  height?: number;
  kind?: LocalArtifactKind;
}

export interface LocalArtifactRenderResult {
  ok: true;
  provider: "local_artifact_renderer";
  kind: LocalArtifactKind;
  imageId: string;
  imageUrl: string;
  filePath: string;
  width: number;
  height: number;
  format: "png";
  provenance: "local_rendered_artifact";
  caveat: string;
}

export function isLocalRenderEligible(prompt: string): boolean {
  const lowered = prompt.toLowerCase();
  const eligiblePatterns = [
    /\b(?:ui\s+mockup|dashboard\s+mockup|interface\s+mockup)\b/i,
    /\b(?:workflow\s+diagram|node\s+diagram|flow\s+chart)\b/i,
    /\b(?:architecture\s+diagram|system\s+diagram|infrastructure\s+diagram)\b/i,
    /\b(?:hero\s+mockup|hero\s+section|landing\s+page\s+mockup)\b/i,
    /\b(?:poster|infographic|wireframe|layout\s+sketch)\b/i,
    /\b(?:simple\s+diagram|block\s+diagram|process\s+diagram)\b/i,
  ];
  const ineligiblePatterns = [
    /\b(?:photorealistic|realistic\s+photo|photograph|person|portrait|face|celebrity)\b/i,
    /\b(?:cinematic|3d\s+render|hyper[\s-]?realistic|style\s+transfer)\b/i,
    /\b(?:product\s+photo|edit\s+(?:this|the)\s+image|modify\s+(?:this|the)\s+image)\b/i,
    /\b(?:model[\s-]generated|provider[\s-]generated|need\s+a\s+model|use\s+the\s+image\s+model)\b/i,
  ];
  if (ineligiblePatterns.some((p) => p.test(lowered))) return false;
  return eligiblePatterns.some((p) => p.test(lowered));
}

function inferRenderKind(prompt: string): LocalArtifactKind {
  const lowered = prompt.toLowerCase();
  if (/\bui\s+mockup|dashboard\s+mockup|interface\s+mockup\b/i.test(lowered)) return "ui_mockup";
  if (/\bworkflow\s+diagram|node\s+diagram|flow\s+chart\b/i.test(lowered)) return "workflow_diagram";
  if (/\barchitecture\s+diagram|system\s+diagram|infrastructure/i.test(lowered)) return "architecture_diagram";
  if (/\bhero\s+mockup|hero\s+section|landing\s+page\b/i.test(lowered)) return "hero_mockup";
  if (/\bposter\b/i.test(lowered)) return "poster";
  return "generic_visual";
}

async function renderSvgToPng(svgContent: string, width: number, height: number): Promise<Buffer> {
  const sharp = await import("sharp");
  return sharp.default(Buffer.from(svgContent, "utf-8"))
    .resize(width, height)
    .png()
    .toBuffer();
}

function svgFixture(kind: LocalArtifactKind, prompt: string, width: number, height: number): string {
  const colors = themeForKind(kind);
  const title = prompt.slice(0, 80);
  const tag = kindLabel(kind);

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<defs><linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="${colors.bgStart}"/><stop offset="100%" stop-color="${colors.bgEnd}"/></linearGradient></defs>`,
    `<rect width="100%" height="100%" fill="url(#bg)"/>`,
    `<rect x="16" y="16" width="${width - 32}" height="${height - 32}" rx="12" ry="12" fill="none" stroke="${colors.accent}" stroke-width="1.5" opacity="0.4"/>`,
    `<text x="50%" y="${height * 0.35}" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="${Math.min(28, width * 0.04)}" fill="${colors.accent}" font-weight="bold">${escHtml(tag)}</text>`,
    `<text x="50%" y="${height * 0.52}" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="${Math.min(20, width * 0.028)}" fill="${colors.text}" opacity="0.9">${escHtml(title)}</text>`,
    renderKindVisual(kind, width, height, colors),
    `<text x="50%" y="${height - 48}" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="${Math.min(13, width * 0.022)}" fill="${colors.text}" opacity="0.4">local rendered artifact · no provider · no cost</text>`,
    `<text x="${width - 24}" y="${height - 24}" text-anchor="end" font-family="JetBrains Mono, monospace" font-size="11" fill="${colors.text}" opacity="0.25">${width}×${height}</text>`,
    "</svg>",
  ].join("\n");
}

function renderKindVisual(kind: LocalArtifactKind, width: number, height: number, colors: { accent: string; text: string }): string {
  const cx = width / 2;
  const cy = height * 0.68;
  const r = Math.min(width, height) * 0.08;
  switch (kind) {
    case "ui_mockup":
      return [
        `<rect x="${cx - 120}" y="${cy - 40}" width="240" height="80" rx="6" fill="${colors.accent}" opacity="0.1" stroke="${colors.accent}" stroke-width="0.5"/>`,
        `<rect x="${cx - 100}" y="${cy - 24}" width="80" height="12" rx="2" fill="${colors.accent}" opacity="0.15"/>`,
        `<rect x="${cx - 100}" y="${cy}" width="140" height="8" rx="2" fill="${colors.text}" opacity="0.1"/>`,
        `<rect x="${cx - 100}" y="${cy + 14}" width="60" height="8" rx="2" fill="${colors.text}" opacity="0.08"/>`,
      ].join("\n");
    case "workflow_diagram":
      return [
        `<circle cx="${cx - 80}" cy="${cy}" r="${r}" fill="${colors.accent}" opacity="0.15" stroke="${colors.accent}" stroke-width="0.8"/>`,
        `<text x="${cx - 80}" y="${cy + 5}" text-anchor="middle" font-size="12" fill="${colors.accent}" opacity="0.6">A</text>`,
        `<line x1="${cx - 80 + r}" y1="${cy}" x2="${cx + 80 - r}" y2="${cy}" stroke="${colors.accent}" stroke-width="1.2" opacity="0.3" marker-end="url(#arrow)"/>`,
        `<circle cx="${cx + 80}" cy="${cy}" r="${r}" fill="${colors.accent}" opacity="0.15" stroke="${colors.accent}" stroke-width="0.8"/>`,
        `<text x="${cx + 80}" y="${cy + 5}" text-anchor="middle" font-size="12" fill="${colors.accent}" opacity="0.6">B</text>`,
      ].join("\n");
    case "architecture_diagram":
      return [
        `<rect x="${cx - 140}" y="${cy - 30}" width="120" height="28" rx="4" fill="${colors.accent}" opacity="0.12" stroke="${colors.accent}" stroke-width="0.5"/>`,
        `<text x="${cx - 80}" y="${cy - 12}" text-anchor="middle" font-size="11" fill="${colors.accent}" opacity="0.7">API</text>`,
        `<rect x="${cx + 20}" y="${cy - 30}" width="120" height="28" rx="4" fill="${colors.accent}" opacity="0.12" stroke="${colors.accent}" stroke-width="0.5"/>`,
        `<text x="${cx + 80}" y="${cy - 12}" text-anchor="middle" font-size="11" fill="${colors.accent}" opacity="0.7">DB</text>`,
        `<rect x="${cx - 140}" y="${cy + 12}" width="280" height="28" rx="4" fill="${colors.text}" opacity="0.06" stroke="${colors.text}" stroke-width="0.3"/>`,
        `<text x="${cx}" y="${cy + 30}" text-anchor="middle" font-size="11" fill="${colors.text}" opacity="0.5">Service Layer</text>`,
      ].join("\n");
    case "hero_mockup":
      return [
        `<rect x="${cx - 140}" y="${cy - 25}" width="280" height="50" rx="6" fill="${colors.accent}" opacity="0.08" stroke="${colors.accent}" stroke-width="0.5"/>`,
        `<rect x="${cx - 100}" y="${cy - 10}" width="200" height="10" rx="3" fill="${colors.text}" opacity="0.12"/>`,
        `<rect x="${cx - 60}" y="${cy + 6}" width="120" height="10" rx="3" fill="${colors.text}" opacity="0.08"/>`,
      ].join("\n");
    default:
      return [
        `<rect x="${cx - 100}" y="${cy - 24}" width="200" height="48" rx="8" fill="${colors.accent}" opacity="0.08" stroke="${colors.accent}" stroke-width="0.8"/>`,
        `<circle cx="${cx}" cy="${cy}" r="8" fill="${colors.accent}" opacity="0.3"/>`,
      ].join("\n");
  }
}

function themeForKind(kind: LocalArtifactKind): { bgStart: string; bgEnd: string; accent: string; text: string } {
  switch (kind) {
    case "ui_mockup": return { bgStart: "#0a0a12", bgEnd: "#12121f", accent: "#60a5fa", text: "#e0e7ff" };
    case "workflow_diagram": return { bgStart: "#0f0f1a", bgEnd: "#1a1a2e", accent: "#a78bfa", text: "#ede9fe" };
    case "architecture_diagram": return { bgStart: "#0a0f14", bgEnd: "#15202b", accent: "#34d399", text: "#d1fae5" };
    case "hero_mockup": return { bgStart: "#0c0c14", bgEnd: "#181830", accent: "#f472b6", text: "#fce7f3" };
    case "poster": return { bgStart: "#100c08", bgEnd: "#1c1410", accent: "#fb923c", text: "#ffedd5" };
    default: return { bgStart: "#0a0a10", bgEnd: "#14141e", accent: "#94a3b8", text: "#e2e8f0" };
  }
}

function kindLabel(kind: LocalArtifactKind): string {
  switch (kind) {
    case "ui_mockup": return "UI Mockup";
    case "workflow_diagram": return "Workflow Diagram";
    case "architecture_diagram": return "Architecture Diagram";
    case "hero_mockup": return "Hero Mockup";
    case "poster": return "Poster";
    default: return "Visual";
  }
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function resolveLocalArtifactDimensions(prompt: string, fallbackKind: LocalArtifactKind): { width: number; height: number } {
  const dimMatch = prompt.match(/\b(\d{2,4})\s*x\s*(\d{2,4})\b/i);
  if (dimMatch) {
    return {
      width: Math.min(Math.max(Number(dimMatch[1]), 200), 1920),
      height: Math.min(Math.max(Number(dimMatch[2]), 200), 1920),
    };
  }

  const aspectMatch = prompt.match(/\b(\d{1,2})\s*:\s*(\d{1,2})\b/);
  if (aspectMatch) {
    const aw = Math.max(1, Number(aspectMatch[1]));
    const ah = Math.max(1, Number(aspectMatch[2]));
    const longSide = 1024;
    const scale = longSide / Math.max(aw, ah);
    return {
      width: Math.max(200, Math.round(aw * scale)),
      height: Math.max(200, Math.round(ah * scale)),
    };
  }

  if (/\b(?:portrait|tall|poster)\b/i.test(prompt) || fallbackKind === "poster") {
    return { width: 768, height: 1024 };
  }
  if (/\b(?:wide|landscape|banner|hero|header)\b/i.test(prompt) || fallbackKind === "hero_mockup") {
    return { width: 1280, height: 720 };
  }
  if (/\bicon\b/i.test(prompt)) {
    return { width: 512, height: 512 };
  }
  return { width: 1024, height: 1024 };
}

export async function renderLocalArtifact(
  request: LocalArtifactRenderRequest,
): Promise<LocalArtifactRenderResult> {
  const kind = request.kind ?? inferRenderKind(request.prompt);
  const resolved = resolveLocalArtifactDimensions(request.prompt, kind);
  const width = request.width ?? resolved.width;
  const height = request.height ?? resolved.height;

  const svgContent = svgFixture(kind, request.prompt, width, height);
  const pngBuffer = await renderSvgToPng(svgContent, width, height);

  const outputDir = path.resolve(process.cwd(), "data", "generated-images");
  fs.mkdirSync(outputDir, { recursive: true });

  const imageId = `local-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.png`;
  const outputPath = path.join(outputDir, imageId);
  fs.writeFileSync(outputPath, pngBuffer);

  return {
    ok: true,
    provider: "local_artifact_renderer",
    kind,
    imageId,
    imageUrl: `/api/generated-images?id=${encodeURIComponent(imageId)}`,
    filePath: outputPath,
    width,
    height,
    format: "png",
    provenance: "local_rendered_artifact",
    caveat: "This is a local SVG-to-PNG rendered mockup. No image generation provider or AI model was used.",
  };
}

export function buildLocalRenderResponse(result: LocalArtifactRenderResult, prompt: string): string {
  return [
    `![Local rendered ${kindLabel(result.kind)}](${result.imageUrl})`,
    "",
    `**Local rendered ${kindLabel(result.kind).toLowerCase()}**`,
    "",
    "| Item | Result |",
    "| --- | --- |",
    `| Artifact | ${kindLabel(result.kind)} PNG |`,
    `| Link | [Open image](${result.imageUrl}) |`,
    `| Dimensions | ${result.width}×${result.height} |`,
    "| Provider request | Not run |",
    "| Cost | None |",
    "| Generation path | Local SVG rendered to PNG with sharp |",
    "",
    "What this satisfies:",
    "- The request receives a directly usable image artifact link in this turn.",
    "- The output is deterministic and does not depend on a paid image provider.",
    "- The visual is suitable for mockups, diagrams, hero layouts, and workflow-style placeholders.",
    "",
    "What it does not claim:",
    "- It is not a model-generated or photorealistic image.",
    "- It does not use FAL, OpenAI, xAI, or any external image model.",
    "",
    `No paid image-generation request was run. To enable provider-based image generation, configure FAL_API_KEY, OPENAI_API_KEY, or XAI_API_KEY in Settings > General > Image Generation.`,
  ].join("\n");
}

export type ImageProviderStatus = {
  id: "fal" | "openai" | "xai" | "local_artifact_renderer";
  available: boolean;
  configured: boolean;
  active: boolean;
  missing?: string[];
  model?: string;
  supportsPhotorealistic: boolean;
  supportsLocalFallback: boolean;
};

export async function getProviderStatuses(): Promise<ImageProviderStatus[]> {
  const statuses: ImageProviderStatus[] = [];

  const { getProvider } = await import("@/lib/image-gen/registry");

  const fal = getProvider("fal");
  statuses.push({
    id: "fal",
    available: fal ? await fal.isAvailable() : false,
    configured: fal ? await fal.isAvailable() : false,
    active: false,
    missing: fal ? [] : ["FAL_API_KEY not configured"],
    model: fal?.defaultModel?.() ?? "fal-ai/flux-pro/v1.1-ultra",
    supportsPhotorealistic: true,
    supportsLocalFallback: false,
  });

  const openai = getProvider("openai");
  statuses.push({
    id: "openai",
    available: openai ? await openai.isAvailable() : false,
    configured: openai ? await openai.isAvailable() : false,
    active: false,
    missing: openai ? [] : ["OPENAI_API_KEY not configured"],
    model: openai?.defaultModel?.() ?? "dall-e-3",
    supportsPhotorealistic: true,
    supportsLocalFallback: false,
  });

  const xai = getProvider("xai");
  statuses.push({
    id: "xai",
    available: xai ? await xai.isAvailable() : false,
    configured: xai ? await xai.isAvailable() : false,
    active: false,
    missing: xai ? [] : ["XAI_API_KEY not configured"],
    model: xai?.defaultModel?.() ?? "grok-2-image",
    supportsPhotorealistic: true,
    supportsLocalFallback: false,
  });

  statuses.push({
    id: "local_artifact_renderer",
    available: true,
    configured: true,
    active: statuses.every((s) => !s.available),
    missing: [],
    supportsPhotorealistic: false,
    supportsLocalFallback: true,
  });

  return statuses;
}
