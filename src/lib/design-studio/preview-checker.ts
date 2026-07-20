import type { HtmlValidationResult } from "@/lib/design-studio/types";
import { extractDesignEditTargets } from "@/lib/design-studio/edit-targets";
import { extractCssTokens } from "@/lib/design-studio/tokens";
import { validateDesignHtml } from "@/lib/design-studio/html";
import sharp from "sharp";

export type DesignPreviewCheck = {
  ok: boolean;
  score: number;
  validation: HtmlValidationResult;
  warnings: string[];
  failures: string[];
  consoleErrors?: string[];
  screenshots?: {
    desktop?: string;
    mobile?: string;
  };
  metrics: {
    bodyTextChars: number;
    editTargets: number;
    tokens: number;
    interactiveElements: number;
    likelyResponsive: boolean;
    horizontalOverflow?: boolean;
    blankPixelRatio?: number;
    visualLuminanceStdDev?: number;
    visualEdgePixelRatio?: number;
    blankRenderDetected?: boolean;
    canvasCount?: number;
    canvasBlankPixelRatio?: number;
    canvasLuminanceStdDev?: number;
    canvasEdgePixelRatio?: number;
    canvasBlankRenderDetected?: boolean;
    canvasMotionRatio?: number;
  };
};

export type VisualSignal = {
  dominantColorRatio: number;
  luminanceStdDev: number;
  edgePixelRatio: number;
};

export function runLightweightPreviewCheck(html: string): DesignPreviewCheck {
  const validation = validateDesignHtml(html);
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const targets = extractDesignEditTargets(html);
  const tokens = extractCssTokens(html);
  const interactiveElements = (html.match(/<(?:a|button|input|select|textarea)\b/gi) || []).length;
  const likelyResponsive = /name=["']viewport["']/i.test(html) && /@media|clamp\(|min\(|max\(|grid|flex/i.test(html);
  const failures = [...validation.errors];
  const warnings = [...validation.warnings];
  if (text.length < 80) warnings.push("Artifact has very little visible text.");
  if (targets.length < 3) warnings.push("Few editable data-disp8ch-id targets were found.");
  if (!likelyResponsive) warnings.push("Responsive behavior is weak or not obvious.");
  const score = Math.max(0, 100 - failures.length * 30 - warnings.length * 6);
  return {
    ok: failures.length === 0,
    score,
    validation,
    warnings,
    failures,
    metrics: { bodyTextChars: text.length, editTargets: targets.length, tokens: tokens.length, interactiveElements, likelyResponsive },
  };
}

async function normalizedPixels(buffer: Buffer) {
  return sharp(buffer)
    .resize(64, 64, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
}

export async function measureVisualSignal(buffer: Buffer): Promise<VisualSignal> {
  const { data, info } = await normalizedPixels(buffer);
  const buckets = new Map<number, number>();
  const pixels = info.width * info.height;
  let luminanceTotal = 0;
  let luminanceSquaredTotal = 0;
  let edgePixels = 0;
  let edgeComparisons = 0;
  for (let index = 0; index < data.length; index += info.channels) {
    const red = data[index];
    const green = data[index + 1];
    const blue = data[index + 2];
    const key = ((red >> 4) << 8) | ((green >> 4) << 4) | (blue >> 4);
    buckets.set(key, (buckets.get(key) || 0) + 1);
    const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
    luminanceTotal += luminance;
    luminanceSquaredTotal += luminance * luminance;

    const pixel = index / info.channels;
    const x = pixel % info.width;
    const y = Math.floor(pixel / info.width);
    if (x > 0) {
      const left = index - info.channels;
      const delta = Math.abs(red - data[left]) + Math.abs(green - data[left + 1]) + Math.abs(blue - data[left + 2]);
      if (delta > 24) edgePixels += 1;
      edgeComparisons += 1;
    }
    if (y > 0) {
      const above = index - info.width * info.channels;
      const delta = Math.abs(red - data[above]) + Math.abs(green - data[above + 1]) + Math.abs(blue - data[above + 2]);
      if (delta > 24) edgePixels += 1;
      edgeComparisons += 1;
    }
  }
  const mean = luminanceTotal / pixels;
  const variance = Math.max(0, luminanceSquaredTotal / pixels - mean * mean);
  return {
    dominantColorRatio: Math.max(...buckets.values()) / pixels,
    luminanceStdDev: Math.sqrt(variance),
    edgePixelRatio: edgeComparisons > 0 ? edgePixels / edgeComparisons : 0,
  };
}

export function isVisuallyBlank(signal: VisualSignal): boolean {
  return signal.dominantColorRatio > 0.9 && signal.luminanceStdDev < 3 && signal.edgePixelRatio < 0.002;
}

function mergeWorstVisualSignal(current: VisualSignal | undefined, next: VisualSignal): VisualSignal {
  if (!current) return next;
  return {
    dominantColorRatio: Math.max(current.dominantColorRatio, next.dominantColorRatio),
    luminanceStdDev: Math.min(current.luminanceStdDev, next.luminanceStdDev),
    edgePixelRatio: Math.min(current.edgePixelRatio, next.edgePixelRatio),
  };
}

async function estimatePixelDifferenceRatio(before: Buffer, after: Buffer): Promise<number> {
  const [first, second] = await Promise.all([normalizedPixels(before), normalizedPixels(after)]);
  if (first.info.channels !== second.info.channels || first.data.length !== second.data.length) return 1;
  let changed = 0;
  const pixels = first.info.width * first.info.height;
  for (let index = 0; index < first.data.length; index += first.info.channels) {
    const delta = Math.abs(first.data[index] - second.data[index])
      + Math.abs(first.data[index + 1] - second.data[index + 1])
      + Math.abs(first.data[index + 2] - second.data[index + 2]);
    if (delta > 12) changed += 1;
  }
  return changed / pixels;
}

export async function runPlaywrightPreviewCheck(html: string): Promise<DesignPreviewCheck> {
  const base = runLightweightPreviewCheck(html);
  const consoleErrors: string[] = [];
  const screenshots: DesignPreviewCheck["screenshots"] = {};
  let horizontalOverflow = false;
  let visualSignal: VisualSignal | undefined;
  let canvasCount = 0;
  let canvasVisualSignal: VisualSignal | undefined;
  let canvasMotionRatio: number | undefined;

  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    page.on("pageerror", (error) => consoleErrors.push(String(error.message || error)));
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(1_200);
    horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
    const desktop = await page.screenshot({ fullPage: true, type: "png" });
    visualSignal = await measureVisualSignal(desktop);
    screenshots.desktop = `data:image/png;base64,${desktop.toString("base64")}`;

    const canvases = page.locator("canvas");
    canvasCount = await canvases.count();
    let visibleCanvas: import("playwright").Locator | null = null;
    for (let index = 0; index < canvasCount; index += 1) {
      const candidate = canvases.nth(index);
      if (await candidate.isVisible().catch(() => false)) {
        visibleCanvas = candidate;
        break;
      }
    }
    if (visibleCanvas) {
      const firstCanvas = await visibleCanvas.screenshot({ type: "png" });
      await page.waitForTimeout(350);
      const secondCanvas = await visibleCanvas.screenshot({ type: "png" });
      canvasVisualSignal = await measureVisualSignal(secondCanvas);
      canvasMotionRatio = await estimatePixelDifferenceRatio(firstCanvas, secondCanvas);
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(450);
    const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
    horizontalOverflow = horizontalOverflow || mobileOverflow;
    const mobile = await page.screenshot({ fullPage: true, type: "png" });
    visualSignal = mergeWorstVisualSignal(visualSignal, await measureVisualSignal(mobile));
    screenshots.mobile = `data:image/png;base64,${mobile.toString("base64")}`;
    if (visibleCanvas && await visibleCanvas.isVisible().catch(() => false)) {
      const mobileCanvas = await visibleCanvas.screenshot({ type: "png" });
      canvasVisualSignal = mergeWorstVisualSignal(canvasVisualSignal, await measureVisualSignal(mobileCanvas));
    }
  } finally {
    await browser.close();
  }

  const failures = [...base.failures];
  const warnings = [...base.warnings];
  if (consoleErrors.length > 0) failures.push(`Console/page errors: ${consoleErrors.slice(0, 3).join(" | ")}`);
  if (horizontalOverflow) failures.push("Horizontal overflow detected on desktop or mobile viewport.");
  const blankRenderDetected = visualSignal ? isVisuallyBlank(visualSignal) : undefined;
  const canvasBlankRenderDetected = canvasVisualSignal ? isVisuallyBlank(canvasVisualSignal) : undefined;
  if (blankRenderDetected) failures.push("Screenshot appears blank or near blank.");
  if (canvasBlankRenderDetected) failures.push("Canvas appears blank or near blank.");
  const score = Math.max(0, base.score - failures.length * 12 - warnings.length * 2);
  return {
    ...base,
    ok: failures.length === 0,
    score,
    warnings,
    failures,
    consoleErrors,
    screenshots,
    metrics: {
      ...base.metrics,
      horizontalOverflow,
      blankPixelRatio: visualSignal?.dominantColorRatio,
      visualLuminanceStdDev: visualSignal?.luminanceStdDev,
      visualEdgePixelRatio: visualSignal?.edgePixelRatio,
      blankRenderDetected,
      canvasCount,
      canvasBlankPixelRatio: canvasVisualSignal?.dominantColorRatio,
      canvasLuminanceStdDev: canvasVisualSignal?.luminanceStdDev,
      canvasEdgePixelRatio: canvasVisualSignal?.edgePixelRatio,
      canvasBlankRenderDetected,
      canvasMotionRatio,
    },
  };
}
