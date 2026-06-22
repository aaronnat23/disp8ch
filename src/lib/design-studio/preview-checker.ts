import type { HtmlValidationResult } from "@/lib/design-studio/types";
import { extractDesignEditTargets } from "@/lib/design-studio/edit-targets";
import { extractCssTokens } from "@/lib/design-studio/tokens";
import { validateDesignHtml } from "@/lib/design-studio/html";

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
  };
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

function estimateBlankPixelRatio(buffer: Buffer): number | undefined {
  // Lightweight PNG sanity check without adding a decoder dependency: if the
  // compressed screenshot is tiny, it is usually blank or near blank.
  return buffer.length < 8_000 ? 0.95 : undefined;
}

export async function runPlaywrightPreviewCheck(html: string): Promise<DesignPreviewCheck> {
  const base = runLightweightPreviewCheck(html);
  const consoleErrors: string[] = [];
  const screenshots: DesignPreviewCheck["screenshots"] = {};
  let horizontalOverflow = false;
  let blankPixelRatio: number | undefined;

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
    horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
    const desktop = await page.screenshot({ fullPage: true, type: "png" });
    blankPixelRatio = estimateBlankPixelRatio(desktop);
    screenshots.desktop = `data:image/png;base64,${desktop.toString("base64")}`;

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(100);
    const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
    horizontalOverflow = horizontalOverflow || mobileOverflow;
    const mobile = await page.screenshot({ fullPage: true, type: "png" });
    screenshots.mobile = `data:image/png;base64,${mobile.toString("base64")}`;
  } finally {
    await browser.close();
  }

  const failures = [...base.failures];
  const warnings = [...base.warnings];
  if (consoleErrors.length > 0) failures.push(`Console/page errors: ${consoleErrors.slice(0, 3).join(" | ")}`);
  if (horizontalOverflow) failures.push("Horizontal overflow detected on desktop or mobile viewport.");
  if (blankPixelRatio !== undefined && blankPixelRatio > 0.9) failures.push("Screenshot appears blank or near blank.");
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
      blankPixelRatio,
    },
  };
}
