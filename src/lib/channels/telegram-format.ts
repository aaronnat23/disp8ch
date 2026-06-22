import { chunkMessage } from "./chunk";

const RAW_CHUNK_LIMIT = 3200;
const RENDERED_CHUNK_LIMIT = 3900;

function escapeTelegramHtml(text: string): string {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function stripWrappingBold(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("**") && trimmed.endsWith("**") && trimmed.length > 4) {
    return trimmed.slice(2, -2).trim();
  }
  return trimmed;
}

function formatInlineTelegramHtml(text: string): string {
  const placeholders: string[] = [];

  let escaped = escapeTelegramHtml(text);

  escaped = escaped.replace(/```([\s\S]*?)```/g, (_, block: string) => {
    const token = `@@TG_BLOCK_${placeholders.length}@@`;
    const content = String(block).replace(/^\n+|\n+$/g, "");
    placeholders.push(`<pre>${content}</pre>`);
    return token;
  });

  escaped = escaped.replace(/`([^`\n]+)`/g, (_, code: string) => {
    const token = `@@TG_CODE_${placeholders.length}@@`;
    placeholders.push(`<code>${code}</code>`);
    return token;
  });

  escaped = escaped.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label: string, url: string) => {
    return `<a href="${url}">${label}</a>`;
  });

  escaped = escaped.replace(/\*\*([^*\n][\s\S]*?[^*\n])\*\*/g, "<b>$1</b>");

  for (let i = 0; i < placeholders.length; i += 1) {
    escaped = escaped.replace(`@@TG_${placeholders[i].includes("<pre>") ? "BLOCK" : "CODE"}_${i}@@`, placeholders[i]);
  }

  return escaped;
}

function formatTelegramLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed) return "";

  const headingMatch = trimmed.match(/^#{1,6}\s+(.+)$/);
  if (headingMatch?.[1]) {
    return `<b>${formatInlineTelegramHtml(stripWrappingBold(headingMatch[1]))}</b>`;
  }

  const unorderedMatch = trimmed.match(/^[-*]\s+(.+)$/);
  if (unorderedMatch?.[1]) {
    return `• ${formatInlineTelegramHtml(unorderedMatch[1])}`;
  }

  const orderedMatch = trimmed.match(/^(\d+)\.\s+(.+)$/);
  if (orderedMatch?.[1] && orderedMatch?.[2]) {
    return `${orderedMatch[1]}. ${formatInlineTelegramHtml(orderedMatch[2])}`;
  }

  return formatInlineTelegramHtml(line);
}

export function renderTelegramHtml(text: string): string {
  const lines = String(text || "").replace(/\r\n/g, "\n").trim().split("\n");
  const rendered: string[] = [];
  let previousBlank = false;

  for (const line of lines) {
    if (!line.trim()) {
      if (!previousBlank && rendered.length > 0) {
        rendered.push("");
      }
      previousBlank = true;
      continue;
    }

    previousBlank = false;
    rendered.push(formatTelegramLine(line));
  }

  return rendered.join("\n").trim();
}

export function prepareTelegramHtmlChunks(text: string): string[] {
  const rawChunks = chunkMessage(text, RAW_CHUNK_LIMIT);
  const renderedChunks: string[] = [];

  for (const rawChunk of rawChunks) {
    const rendered = renderTelegramHtml(rawChunk);
    if (rendered.length <= RENDERED_CHUNK_LIMIT) {
      renderedChunks.push(rendered);
      continue;
    }

    const smallerChunks = chunkMessage(rawChunk, Math.floor(RAW_CHUNK_LIMIT / 2));
    for (const smallerChunk of smallerChunks) {
      const smallerRendered = renderTelegramHtml(smallerChunk);
      renderedChunks.push(
        smallerRendered.length <= RENDERED_CHUNK_LIMIT
          ? smallerRendered
          : escapeTelegramHtml(smallerChunk),
      );
    }
  }

  return renderedChunks.filter(Boolean);
}
