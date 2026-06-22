type SlackBlockLike = Record<string, unknown>;

function cleanCandidate(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function readTextField(value: unknown): string {
  if (typeof value === "string") return cleanCandidate(value);
  if (value && typeof value === "object" && "text" in value) {
    return cleanCandidate((value as { text?: unknown }).text);
  }
  return "";
}

export function parseSlackBlocksJson(raw: unknown): SlackBlockLike[] {
  if (Array.isArray(raw)) {
    return raw.filter((entry): entry is SlackBlockLike => Boolean(entry) && typeof entry === "object");
  }
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is SlackBlockLike => Boolean(entry) && typeof entry === "object")
      : [];
  } catch {
    return [];
  }
}

export function buildSlackBlocksFallbackText(blocks: SlackBlockLike[], fallbackText = ""): string {
  const directFallback = cleanCandidate(fallbackText);
  if (directFallback) return directFallback;

  for (const block of blocks) {
    const type = cleanCandidate(block.type);
    if (type === "header" || type === "section") {
      const text = readTextField(block.text);
      if (text) return text;
    }
    if (type === "context" && Array.isArray(block.elements)) {
      const joined = block.elements
        .map((entry) => readTextField(entry))
        .filter(Boolean)
        .join(" ");
      if (joined) return joined;
    }
    if (type === "image") {
      const text = cleanCandidate(block.alt_text) || readTextField(block.title);
      if (text) return text;
      return "Shared an image";
    }
    if (type === "file") {
      return "Shared a file";
    }
  }

  return "Shared a Block Kit message";
}
