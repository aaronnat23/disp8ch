export function extractMainContent(html: string): string {
  const mainMatch = html.match(/<(main|article)\b[^>]*>([\s\S]*?)<\/\1>/i);
  let target = mainMatch?.[2] ?? html;

  target = target
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/gi, " ")
    .replace(/<header\b[^>]*>[\s\S]*?<\/header>/gi, " ")
    .replace(/<aside\b[^>]*>[\s\S]*?<\/aside>/gi, " ");

  return target;
}

export function htmlToMarkdown(html: string): string {
  let text = extractMainContent(html);

  text = text
    .replace(/<pre\b[^>]*>\s*<code\b[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi, "\n```\n$1\n```\n")
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, "\n```\n$1\n```\n")
    .replace(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n")
    .replace(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n")
    .replace(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n")
    .replace(/<h4\b[^>]*>([\s\S]*?)<\/h4>/gi, "\n#### $1\n")
    .replace(/<h5\b[^>]*>([\s\S]*?)<\/h5>/gi, "\n##### $1\n")
    .replace(/<h6\b[^>]*>([\s\S]*?)<\/h6>/gi, "\n###### $1\n")
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, "\n- $1\n")
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, "`$1`")
    .replace(/<strong\b[^>]*>([\s\S]*?)<\/strong>/gi, "**$1**")
    .replace(/<b\b[^>]*>([\s\S]*?)<\/b>/gi, "**$1**")
    .replace(/<em\b[^>]*>([\s\S]*?)<\/em>/gi, "*$1*")
    .replace(/<i\b[^>]*>([\s\S]*?)<\/i>/gi, "*$1*")
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)")
    .replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, "$1")
    .replace(/<(br|\/p|\/div|\/section|\/article|\/tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  text = decodeEntities(text);
  text = text.replace(/&(?!#?\w+;)/g, "&amp;");
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.replace(/[ ]{2,}/g, " ");
  text = text.trim();

  return text;
}

function decodeEntities(text: string): string {
  const entities: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    ndash: "\u2013",
    mdash: "\u2014",
    lsquo: "\u2018",
    rsquo: "\u2019",
    ldquo: "\u201C",
    rdquo: "\u201D",
  };
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (_full, code) => {
    if (code.startsWith("#x") || code.startsWith("#X")) {
      const cp = Number.parseInt(code.slice(2), 16);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : "";
    }
    if (code.startsWith("#")) {
      const cp = Number.parseInt(code.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : "";
    }
    return entities[code] ?? "";
  });
}

export function extractTextFromHtmlFallback(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractTitleFromHtml(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match?.[1]) return null;
  return decodeEntities(match[1]).replace(/\s+/g, " ").trim() || null;
}

export function extractCanonicalUrl(html: string, baseUrl: string): string | null {
  const match = html.match(/<link\s+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i);
  if (!match?.[1]) return null;
  try {
    return new URL(match[1], baseUrl).toString();
  } catch {
    return null;
  }
}

export function extractMetaDescription(html: string): string | null {
  const match = html.match(/<meta\s+name=["']description["'][^>]*content=["']([^"']+)["']/i)
    || html.match(/<meta\s+content=["']([^"']+)["'][^>]*name=["']description["']/i);
  return match?.[1]?.trim() || null;
}

export function extractLinksFromHtml(baseUrl: string, html: string): string[] {
  const out = new Set<string>();
  const hrefRegex = /<a\b[^>]*?href\s*=\s*["']([^"'<>]+)["'][^>]*>/gi;
  let match: RegExpExecArray | null = null;
  while ((match = hrefRegex.exec(html))) {
    const raw = String(match[1] || "").trim();
    if (!raw || raw.startsWith("#") || raw.startsWith("mailto:") || raw.startsWith("tel:") ||
      raw.startsWith("javascript:") || raw.startsWith("data:")) continue;
    try {
      const resolved = new URL(raw, baseUrl);
      if (!["http:", "https:"].includes(resolved.protocol)) continue;
      resolved.hash = "";
      out.add(resolved.toString());
    } catch { /* ignore */ }
  }
  return [...out];
}
