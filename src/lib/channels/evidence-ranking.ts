import type { UniversalEvidenceDossier } from "@/lib/channels/universal-evidence-dossier";

export type RankedEvidenceItem = {
  rank: number;
  label: string;
  source: string;
  score: number;
};

function scoreSource(input: {
  request: string;
  toolName?: string;
  kind?: string;
  filePath?: string;
  url?: string;
  title?: string;
}): number {
  const source = `${input.filePath ?? ""} ${input.url ?? ""} ${input.title ?? ""}`;
  let score = 0;
  if (input.request && source && input.request.toLowerCase().includes(source.toLowerCase())) score += 100;
  if (input.url && /\b(?:docs?|documentation|api|developer|github\.com\/[^/]+\/[^/]+(?:\/tree|\/blob|$)|raw\.githubusercontent)\b/i.test(input.url)) score += 80;
  if (input.kind === "runtime" || input.kind === "app_state" || /(?:workflow_list|channel_status|schedules_list|webhooks_list)/i.test(input.toolName ?? "")) score += 70;
  if (input.filePath && /\bsrc\/|server\/|app\/|components\/|lib\//i.test(input.filePath)) score += 60;
  if (input.filePath && /\b(?:scripts\/|test|regression|spec)\b/i.test(input.filePath)) score += 50;
  if (input.filePath && /\bdocs\/improvements\b/i.test(input.filePath)) score += 25;
  if (input.url && /\b(?:reddit|forum|community|discord|x\.com|twitter|medium|blog|youtube)\b/i.test(input.url)) score += 10;
  return score;
}

export function rankEvidenceForFinalAnswer(dossier: UniversalEvidenceDossier, limit = 8): RankedEvidenceItem[] {
  const request = dossier.request ?? "";
  const seen = new Set<string>();
  const ranked: RankedEvidenceItem[] = [];

  for (const source of dossier.sourceMap) {
    const key = source.filePath || source.url || source.label;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    ranked.push({
      rank: 0,
      label: source.label || key,
      source: key,
      score: scoreSource({
        request,
        filePath: source.filePath,
        url: source.url,
        title: source.label,
      }),
    });
  }

  for (const item of dossier.items) {
    const key = item.toolName;
    if (!key) continue;
    const label = `${item.kind}:${item.toolName}`;
    if (seen.has(label)) continue;
    seen.add(label);
    ranked.push({
      rank: 0,
      label,
      source: item.toolName,
      score: scoreSource({ request, kind: item.kind, toolName: item.toolName }),
    });
  }

  return ranked
    .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label))
    .slice(0, Math.max(1, limit))
    .map((item, index) => ({ ...item, rank: index + 1 }));
}

export function formatRankedEvidenceForPrompt(dossier: UniversalEvidenceDossier, limit = 8): string {
  const ranked = rankEvidenceForFinalAnswer(dossier, limit);
  if (ranked.length === 0) return "No ranked evidence is available.";
  return ranked.map((item) => `${item.rank}. ${item.label} — ${item.source}`).join("\n");
}
