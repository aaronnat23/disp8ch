import type { HtmlValidationResult } from "@/lib/design-studio/types";

const MAX_HTML_BYTES = 1024 * 1024;

function isApprovedPinnedRuntimeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.hostname === "cdn.jsdelivr.net" &&
      url.search === "" &&
      url.hash === "" &&
      /^\/npm\/three@\d+\.\d+\.\d+\/build\/three\.(?:min|module)\.js$/.test(url.pathname);
  } catch {
    return false;
  }
}

function externalRuntimeUrls(source: string): string[] {
  const urls: string[] = [];
  for (const tag of source.match(/<script\b[^>]*\bsrc=["']?https?:\/\/[^>]*>/gi) || []) {
    const match = tag.match(/\bsrc\s*=\s*(["'])(https:\/\/[^"']+)\1/i);
    if (match) urls.push(match[2]);
  }
  for (const block of source.match(/<script\b[^>]*\btype=["']importmap["'][^>]*>[\s\S]*?<\/script>/gi) || []) {
    for (const match of block.matchAll(/["'](https:\/\/[^"']+)["']/gi)) urls.push(match[1]);
  }
  for (const match of source.matchAll(/\b(?:from\s*|import\s*\(\s*)["'](https:\/\/[^"']+)["']/gi)) urls.push(match[1]);
  return [...new Set(urls)];
}

export function validateDesignHtml(html: string, opts: { requireDocument?: boolean } = {}): HtmlValidationResult {
  const source = String(html || "");
  const lower = source.toLowerCase();
  const warnings: string[] = [];
  const errors: string[] = [];
  const requireDocument = opts.requireDocument ?? true;
  const runtimeUrls = externalRuntimeUrls(source);
  const externalScriptCount = runtimeUrls.length;
  const approvedPinnedRuntimeCount = runtimeUrls.filter(isApprovedPinnedRuntimeUrl).length;
  const blockedExternalScriptCount = externalScriptCount - approvedPinnedRuntimeCount;
  const externalStylesheetCount = (source.match(/<link\b[^>]*rel=["']stylesheet["'][^>]*href=["']?https?:\/\//gi) || []).length;
  const stats = {
    chars: source.length,
    lines: source ? source.split(/\r?\n/).length : 0,
    hasDoctype: /^\s*<!doctype\s+html/i.test(source),
    hasHtmlTag: /<html[\s>]/i.test(source),
    hasBodyTag: /<body[\s>]/i.test(source),
    scriptCount: (source.match(/<script\b/gi) || []).length,
    externalScriptCount,
    externalStylesheetCount,
    dataDisp8chIdCount: (source.match(/\bdata-disp8ch-id=/gi) || []).length,
  };

  if (!source.trim()) errors.push("HTML is empty.");
  if (Buffer.byteLength(source, "utf8") > MAX_HTML_BYTES) errors.push("HTML exceeds the 1 MB core artifact limit.");
  if (requireDocument && !stats.hasHtmlTag) errors.push("Complete artifacts must include an <html> tag.");
  if (requireDocument && !stats.hasBodyTag) errors.push("Complete artifacts must include a <body> tag.");
  if (blockedExternalScriptCount > 0) errors.push("External scripts are blocked unless they are an exact pinned Three.js build from cdn.jsdelivr.net.");
  if (approvedPinnedRuntimeCount > 0) warnings.push("Pinned Three.js runtime requires network access when the preview or export is opened.");
  if (/<(?:iframe|object|embed)\b/i.test(source)) errors.push("<iframe>, <object>, and <embed> are blocked in core artifacts.");
  if (/\son\w+\s*=/i.test(source)) warnings.push("Inline event handlers were detected; prefer unobtrusive scripts.");
  if (!stats.hasDoctype) warnings.push("Missing <!doctype html>.");
  if (!/<meta\b[^>]*name=["']viewport["']/i.test(source)) warnings.push("Missing responsive viewport meta tag.");
  if (externalStylesheetCount > 0) warnings.push("External stylesheets may fail offline or slow preview rendering.");
  if (stats.dataDisp8chIdCount === 0) warnings.push("No data-disp8ch-id markers found; manual editing and scoped AI edits will be weaker.");
  if (/<img\b[^>]*src=["']https?:\/\//i.test(lower)) warnings.push("External images are used; export may not be self-contained.");
  if (/lorem ipsum/i.test(source)) warnings.push("Placeholder lorem ipsum text detected.");

  return { ok: errors.length === 0, warnings, errors, stats };
}

export function buildSandboxedPreviewHtml(source: string): string {
  if (/<head[\s>]/i.test(source)) {
    return source.replace(/<head([^>]*)>/i, `<head$1><base target="_blank">`);
  }
  return source;
}
