export type ExtractedClaim = {
  text: string;
  kind: "web" | "repo" | "memory" | "app" | "verification" | "recommendation" | "other";
};

export function extractImportantClaims(answer: string): ExtractedClaim[] {
  const sentences = String(answer || "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 24)
    .slice(0, 80);
  return sentences.map((text) => {
    if (/https?:\/\//i.test(text) || /\b(?:public|discussion|source|article|docs?|release|GitHub|Reddit|HN)\b/i.test(text)) return { text, kind: "web" };
    if (/\b(?:src|docs|app|lib|scripts)\/[A-Za-z0-9._/() -]+|read_file|repo|codebase|implementation|router|component\b/i.test(text)) return { text, kind: "repo" };
    if (/\bmemory|remember|preference|saved fact\b/i.test(text)) return { text, kind: "memory" };
    if (/\bworkflow|node|template|schedule|board|channel_status|governance\b/i.test(text)) return { text, kind: "app" };
    if (/\b(?:I|we)\s+(?:verified|confirmed|searched|inspected|read|checked)\b/i.test(text)) return { text, kind: "verification" };
    if (/\b(?:should|recommend|next step|implement|add|change|use)\b/i.test(text)) return { text, kind: "recommendation" };
    return { text, kind: "other" };
  });
}

