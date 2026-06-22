export type RequestedOutputShape = {
  bulletCount: number | null;
  wantsBullets: boolean;
  wantsUncertainty: boolean;
};

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

function parseSmallNumber(value: string | undefined): number | null {
  if (!value) return null;
  const normalized = value.toLowerCase();
  if (/^\d+$/.test(normalized)) {
    const parsed = Number.parseInt(normalized, 10);
    return parsed > 0 && parsed <= 20 ? parsed : null;
  }
  return NUMBER_WORDS[normalized] ?? null;
}

export function detectRequestedOutputShape(message: string): RequestedOutputShape {
  const text = String(message || "");
  const number = "(\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)";
  const bulletWord = "(?:bullets?|bullet\\s+points?)";
  const requested =
    text.match(new RegExp(`\\b(?:use|include|give|return|provide|write|make|keep(?:\\s+it)?\\s+to|in|as|with|into|to)\\s+(?:exactly\\s+|only\\s+|about\\s+)?${number}\\s+(?:concise\\s+|short\\s+|technical\\s+|practical\\s+)?${bulletWord}\\b`, "i")) ??
    text.match(new RegExp(`\\b${number}\\s+(?:concise\\s+|short\\s+|technical\\s+|practical\\s+)?${bulletWord}\\b`, "i"));
  const bulletCount = parseSmallNumber(requested?.[1]);
  return {
    bulletCount,
    wantsBullets: bulletCount !== null || /\b(?:as|in)\s+(?:a\s+)?bullet\s+list\b/i.test(text),
    wantsUncertainty: /\binclude\s+one\s+uncertainty\b/i.test(text) || /\bone\s+uncertainty\b/i.test(text),
  };
}

export function formatRequestedOutputShapeInstruction(message: string): string {
  const shape = detectRequestedOutputShape(message);
  if (!shape.wantsBullets) return "";
  const countText = shape.bulletCount ? `exactly ${shape.bulletCount} bullet list items` : "a bullet list";
  const uncertaintyText = shape.wantsUncertainty
    ? " If the user asks for one uncertainty, make exactly one bullet the uncertainty bullet."
    : "";
  return `Output shape required by the user: ${countText}. Do not use a markdown table as a substitute for bullets.${uncertaintyText}`;
}

function countMarkdownListItems(text: string): number {
  return String(text || "")
    .split(/\r?\n/)
    .filter((line) => /^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(line))
    .length;
}

function isMarkdownTableSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function splitMarkdownTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim().replace(/^:+|:+$/g, ""))
    .filter(Boolean);
}

function stripInlineMarkdown(text: string): string {
  return text
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

function extractFirstMarkdownTable(response: string): { header: string[]; rows: string[][]; start: number; end: number } | null {
  const lines = String(response || "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i]?.includes("|")) continue;
    const header = splitMarkdownTableRow(lines[i]);
    if (header.length < 2) continue;
    const next = lines[i + 1] ?? "";
    if (!isMarkdownTableSeparator(next)) continue;
    const rows: string[][] = [];
    let end = i + 1;
    for (let j = i + 2; j < lines.length; j += 1) {
      const line = lines[j] ?? "";
      if (!line.includes("|") || isMarkdownTableSeparator(line)) {
        end = j - 1;
        break;
      }
      const cells = splitMarkdownTableRow(line);
      if (cells.length >= 2) rows.push(cells);
      end = j;
    }
    if (rows.length > 0) return { header, rows, start: i, end };
  }
  return null;
}

function extractUncertainty(response: string): string | null {
  const section = String(response || "").match(/(?:^|\n)#{1,6}\s*uncertainty\s*\n+([\s\S]*?)(?=\n#{1,6}\s|\s*$)/i);
  const source = section?.[1] ?? String(response || "").match(/\buncertainty\s*:\s*([^\n]+)/i)?.[1] ?? "";
  const cleaned = source
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, "").trim())
    .filter((line) => line && !line.includes("|"))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || null;
}

function tableRowToBullet(header: string[], row: string[]): string {
  const label = stripInlineMarkdown(row[0] ?? "Point");
  if (row.length >= 3) {
    const parts = row.slice(1).map((cell, index) => {
      const heading = stripInlineMarkdown(header[index + 1] ?? `Side ${index + 1}`);
      return `${heading}: ${stripInlineMarkdown(cell)}`;
    });
    return `- **${label}:** ${parts.join("; ")}`;
  }
  return `- **${label}:** ${stripInlineMarkdown(row.slice(1).join(" "))}`;
}

export function applyRequestedOutputShape(response: string, message: string): string {
  const shape = detectRequestedOutputShape(message);
  if (!shape.wantsBullets) return response;
  if (shape.bulletCount && countMarkdownListItems(response) === shape.bulletCount && !extractFirstMarkdownTable(response)) {
    return response;
  }

  const table = extractFirstMarkdownTable(response);
  if (!table || table.rows.length === 0) return response;

  const uncertainty = shape.wantsUncertainty ? extractUncertainty(response) : null;
  const targetCount = shape.bulletCount ?? table.rows.length + (uncertainty ? 1 : 0);
  const rowLimit = Math.max(0, targetCount - (uncertainty ? 1 : 0));
  const bullets = table.rows.slice(0, rowLimit).map((row) => tableRowToBullet(table.header, row));
  if (uncertainty) bullets.push(`- **Uncertainty:** ${stripInlineMarkdown(uncertainty)}`);
  if (shape.bulletCount && bullets.length !== shape.bulletCount) return response;

  const lines = response.split(/\r?\n/);
  const prefix = lines.slice(0, table.start).filter((line) => line.trim() && !/^#{1,6}\s*uncertainty\b/i.test(line));
  return [...prefix, ...bullets].join("\n").trim();
}
