export type DesignToken = {
  name: string;
  value: string;
  type: "color" | "size" | "font" | "other";
};

export function extractCssTokens(html: string): DesignToken[] {
  const tokens: DesignToken[] = [];
  const re = /(--disp8ch-[a-z0-9-]+)\s*:\s*([^;}{]+);/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) && tokens.length < 100) {
    const value = match[2].trim();
    const type = /^#|rgb|hsl/i.test(value)
      ? "color"
      : /\b(?:px|rem|em|vh|vw|%)\b/i.test(value)
        ? "size"
        : /font|serif|sans/i.test(value)
          ? "font"
          : "other";
    tokens.push({ name: match[1], value, type });
  }
  return tokens;
}

export function setCssToken(html: string, token: string, value: string): string {
  const safeToken = String(token || "").trim();
  if (!/^--disp8ch-[a-z0-9-]+$/i.test(safeToken)) throw new Error("Invalid token name");
  if (/[<>{}]/.test(value)) throw new Error("Unsafe token value");
  const re = new RegExp(`(${safeToken.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\s*:\\s*)([^;}{]+)(;)`, "i");
  if (!re.test(html)) throw new Error(`Token not found: ${safeToken}`);
  return html.replace(re, `$1${value}$3`);
}
