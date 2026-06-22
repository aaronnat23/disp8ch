"use client";

import { Fragment, useMemo, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { highlightCode, type TokenKind } from "@/components/chat/code-highlight";

const TOKEN_CLASS: Record<TokenKind, string> = {
  plain: "",
  kw: "text-violet-300",
  str: "text-emerald-300",
  num: "text-amber-300",
  com: "text-muted-foreground italic",
  fn: "text-sky-300",
  ty: "text-sky-200",
  op: "text-foreground/80",
  tag: "text-rose-300",
  attr: "text-amber-200",
};

type ChatMarkdownProps = {
  content: string;
  className?: string;
};

type Block =
  | { type: "heading"; level: number; content: string }
  | { type: "paragraph"; lines: string[] }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "blockquote"; lines: string[] }
  | { type: "code"; language: string; content: string }
  | { type: "hr" }
  | { type: "table"; rows: string[][] };

const INLINE_TOKEN_REGEX = /(`[^`]+`|!\[[^\]]+\]\((https?:\/\/[^)\s]+)\)|\[[^\]]+\]\((https?:\/\/[^)\s]+)\)|https?:\/\/[^\s<]+|\*\*[^*]+\*\*)/g;
const TABLE_ALIGN_REGEX = /^\|?[\s:-]+\|[\s|:-]*$/;

function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let tokenIndex = 0;

  for (const match of text.matchAll(INLINE_TOKEN_REGEX)) {
    const full = match[0];
    const index = match.index ?? 0;
    if (index > lastIndex) {
      nodes.push(text.slice(lastIndex, index));
    }

    if (full.startsWith("`") && full.endsWith("`")) {
      nodes.push(
        <code
          key={`${keyPrefix}-code-${tokenIndex}`}
          className="rounded border border-border/70 bg-background/70 px-1.5 py-0.5 font-mono text-[0.92em] text-foreground max-w-full break-all"
        >
          {full.slice(1, -1)}
        </code>,
      );
    } else if (full.startsWith("![")) {
      const labelEnd = full.indexOf("](");
      const alt = full.slice(2, labelEnd);
      const src = full.slice(labelEnd + 2, -1);
      nodes.push(
        <img
          key={`${keyPrefix}-img-${tokenIndex}`}
          src={src}
          alt={alt}
          className="my-2 max-h-60 max-w-full cursor-pointer rounded-md border object-contain hover:opacity-90 transition-opacity"
          loading="lazy"
        />,
      );
    } else if (full.startsWith("[") && full.includes("](") && full.endsWith(")")) {
      const labelEnd = full.indexOf("](");
      const label = full.slice(1, labelEnd);
      const href = full.slice(labelEnd + 2, -1);
      nodes.push(
        <a
          key={`${keyPrefix}-link-${tokenIndex}`}
          href={href}
          target="_blank"
          rel="noreferrer"
          className="font-medium text-terminal-red underline decoration-terminal-red/50 underline-offset-2 break-all"
        >
          {label}
        </a>,
      );
    } else if (full.startsWith("**") && full.endsWith("**")) {
      nodes.push(
        <strong key={`${keyPrefix}-strong-${tokenIndex}`} className="font-semibold text-foreground">
          {full.slice(2, -2)}
        </strong>,
      );
    } else {
      nodes.push(
        <a
          key={`${keyPrefix}-url-${tokenIndex}`}
          href={full}
          target="_blank"
          rel="noreferrer"
          className="font-medium text-terminal-red underline decoration-terminal-red/50 underline-offset-2 break-all"
        >
          {full}
        </a>,
      );
    }

    lastIndex = index + full.length;
    tokenIndex += 1;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}

function renderInlineLines(lines: string[], keyPrefix: string): ReactNode {
  return lines.map((line, index) => (
    <Fragment key={`${keyPrefix}-line-${index}`}>
      {renderInline(line, `${keyPrefix}-${index}`)}
      {index < lines.length - 1 ? <br /> : null}
    </Fragment>
  ));
}

function parseBlocks(content: string): Block[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      index += 1;
      continue;
    }

    const codeStart = trimmed.match(/^```([\w-]+)?\s*$/);
    if (codeStart) {
      const language = codeStart[1] ?? "";
      const chunk: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith("```")) {
        chunk.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: "code", language, content: chunk.join("\n") });
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (heading?.[2]) {
      blocks.push({ type: "heading", level: heading[1].length, content: heading[2] });
      index += 1;
      continue;
    }

    if (/^[-*_]{3,}\s*$/.test(trimmed)) {
      blocks.push({ type: "hr" });
      index += 1;
      continue;
    }

    if (trimmed.startsWith(">")) {
      const chunk: string[] = [];
      while (index < lines.length && lines[index].trim().startsWith(">")) {
        chunk.push(lines[index].trim().replace(/^>\s?/, ""));
        index += 1;
      }
      blocks.push({ type: "blockquote", lines: chunk });
      continue;
    }

    if (trimmed.includes("|") && index + 1 < lines.length && TABLE_ALIGN_REGEX.test(lines[index + 1].trim())) {
      const rows: string[][] = [splitTableRow(trimmed)];
      index += 2;
      while (index < lines.length && lines[index].trim().includes("|")) {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }
      blocks.push({ type: "table", rows });
      continue;
    }

    const ordered = trimmed.match(/^\d+\.\s+(.+)$/);
    const unordered = trimmed.match(/^[-*]\s+(.+)$/);
    if (ordered || unordered) {
      const items: string[] = [];
      const orderedList = Boolean(ordered);
      while (index < lines.length) {
        const current = lines[index].trim();
        const match = orderedList
          ? current.match(/^\d+\.\s+(.+)$/)
          : current.match(/^[-*]\s+(.+)$/);
        if (!match?.[1]) break;
        items.push(match[1]);
        index += 1;
      }
      blocks.push({ type: "list", ordered: orderedList, items });
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length) {
      const current = lines[index];
      const currentTrimmed = current.trim();
      if (!currentTrimmed) break;
      if (/^(#{1,6})\s+/.test(currentTrimmed)) break;
      if (/^```/.test(currentTrimmed)) break;
      if (/^[-*_]{3,}\s*$/.test(currentTrimmed)) break;
      if (currentTrimmed.startsWith(">")) break;
      if (/^\d+\.\s+/.test(currentTrimmed)) break;
      if (/^[-*]\s+/.test(currentTrimmed)) break;
      if (
        currentTrimmed.includes("|") &&
        index + 1 < lines.length &&
        TABLE_ALIGN_REGEX.test(lines[index + 1].trim())
      ) {
        break;
      }
      paragraph.push(current);
      index += 1;
    }
    blocks.push({ type: "paragraph", lines: paragraph });
  }

  return blocks;
}

function headingClass(level: number): string {
  if (level <= 1) return "text-xl font-semibold tracking-tight";
  if (level === 2) return "text-lg font-semibold tracking-tight";
  if (level === 3) return "text-base font-semibold";
  return "text-sm font-semibold uppercase tracking-[0.16em] text-muted-foreground";
}

// Tiny in-component code block with hover Copy button and zero-dep syntax
// highlighting via highlightCode(). Falls back to plain text for unsupported
// languages.
function CodeBlock({ language, content }: { language: string; content: string }) {
  const [copied, setCopied] = useState(false);

  const tokens = useMemo(() => {
    if (!language) return null;
    return highlightCode(language, content);
  }, [language, content]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard not available */
    }
  };

  return (
    <div className="group/code relative overflow-hidden rounded-md border border-border/70 bg-background/80">
      <div className="flex items-center justify-between border-b border-border/70 px-3 py-1">
        <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
          {language || "code"}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-muted-foreground opacity-0 transition-opacity group-hover/code:opacity-100 focus-visible:opacity-100 hover:text-foreground"
          aria-label="Copy code"
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto px-3 py-3 text-[12px] leading-6 text-foreground">
        <code>
          {tokens ? (
            tokens.map((tok, i) => (
              <span key={i} className={TOKEN_CLASS[tok.kind]}>
                {tok.text}
              </span>
            ))
          ) : (
            content
          )}
        </code>
      </pre>
    </div>
  );
}

export function ChatMarkdown({ content, className }: ChatMarkdownProps) {
  const blocks = parseBlocks(content);

  return (
    <div className={cn("space-y-3 text-sm leading-6 [&_table]:block [&_table]:overflow-x-auto [&_table]:max-w-full", className)}>
      {blocks.map((block, index) => {
        const key = `block-${index}`;
        switch (block.type) {
          case "heading":
            return (
              <div key={key} className="space-y-1">
                <div className={headingClass(block.level)}>
                  {renderInline(block.content, key)}
                </div>
                {block.level <= 2 ? <div className="h-px w-full bg-border/70" /> : null}
              </div>
            );
          case "paragraph":
            return (
              <p key={key} className="whitespace-normal text-sm leading-6 text-current break-words">
                {renderInlineLines(block.lines, key)}
              </p>
            );
          case "list": {
            const ListTag = block.ordered ? "ol" : "ul";
            return (
              <ListTag
                key={key}
                className={cn(
                  "space-y-1.5 pl-5 text-sm leading-6",
                  block.ordered ? "list-decimal" : "list-disc",
                )}
              >
                {block.items.map((item, itemIndex) => (
                  <li key={`${key}-item-${itemIndex}`}>{renderInline(item, `${key}-${itemIndex}`)}</li>
                ))}
              </ListTag>
            );
          }
          case "blockquote":
            return (
              <blockquote
                key={key}
                className="border-l-2 border-terminal-red/60 bg-background/40 px-4 py-3 text-sm text-muted-foreground"
              >
                {renderInlineLines(block.lines, key)}
              </blockquote>
            );
          case "code":
            return <CodeBlock key={key} language={block.language} content={block.content} />;
          case "hr":
            return <div key={key} className="h-px w-full bg-border/70" />;
          case "table":
            return (
              <div key={key} className="overflow-x-auto rounded-md border border-border/70">
                <table className="min-w-full border-collapse text-left text-sm">
                  <thead className="bg-background/70">
                    <tr>
                      {block.rows[0].map((cell, cellIndex) => (
                        <th key={`${key}-head-${cellIndex}`} className="border-b border-border/70 px-3 py-2 font-semibold">
                          {renderInline(cell, `${key}-head-${cellIndex}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.slice(1).map((row, rowIndex) => (
                      <tr key={`${key}-row-${rowIndex}`} className="border-b border-border/50 last:border-b-0">
                        {row.map((cell, cellIndex) => (
                          <td key={`${key}-cell-${rowIndex}-${cellIndex}`} className="px-3 py-2 align-top text-muted-foreground">
                            {renderInline(cell, `${key}-cell-${rowIndex}-${cellIndex}`)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          default:
            return null;
        }
      })}
    </div>
  );
}
