import type { BroadEvidencePack } from "@/lib/channels/broad-evidence-controller";
import { normalizeUrlForCitation, validateCitations } from "@/lib/channels/evidence-ledger-v2";
import type { EvidenceLedgerEntry } from "@/lib/channels/evidence-ledger-v2";
import { classifyResearchTaskSpec } from "@/lib/channels/web-research-task-spec";
import { evaluateWebResearchCoverage } from "@/lib/channels/web-research-coverage-contract";
import type { ResearchSourcePurpose } from "@/lib/channels/web-research-task-spec";

function rawUrls(answer: string): string[] {
  return Array.from(new Set(answer.match(/https?:\/\/[^\s)\]`,;"'<>]+/g) ?? []));
}

function hostnameOf(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function verifiedSourceEntries(evidence?: BroadEvidencePack): EvidenceLedgerEntry[] {
  return (evidence?.ledger ?? []).filter((entry) =>
    entry.verified &&
    (entry.kind === "web_source" || entry.kind === "browser_page" || entry.kind === "document") &&
    entry.metadata?.sourceKind !== "search_index",
  );
}

function repairUnsupportedCitations(answer: string, entries: EvidenceLedgerEntry[]): string {
  const validation = validateCitations(answer, entries);
  let next = answer.replace(
    /\[([^\]]+\.(?:md|mdx|txt|ts|tsx|js|jsx|mjs|cjs|json|py|yml|yaml|toml|css|html|sql))\]\((https?:\/\/[^)]+)\)/gi,
    (_match, _label, url) => {
      const host = hostnameOf(String(url));
      return `[${host ?? "source"}](${url})`;
    },
  );

  if (validation.ok || validation.unsupportedUrls.length === 0) return next;

  const supported = entries.map((entry) => ({
    url: normalizeUrlForCitation(entry.canonicalLocator),
    host: hostnameOf(entry.canonicalLocator),
  }));

  for (const raw of rawUrls(answer)) {
    const normalized = normalizeUrlForCitation(raw);
    if (!validation.unsupportedUrls.includes(normalized)) continue;
    const host = hostnameOf(normalized);
    const sameHost = supported.find((source) => source.host && source.host === host);
    if (sameHost) {
      next = next.split(raw).join(sameHost.url);
      continue;
    }
    const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    next = next.replace(new RegExp(`\\[([^\\]]+)\\]\\(${escaped}\\)`, "g"), "$1");
    next = next.split(raw).join("");
  }
  return next.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function sourcePurposeLabel(purpose: string): string {
  switch (purpose) {
    case "official_primary_product": return "Official primary product";
    case "official_integration_product": return "Official integration product";
    case "model_runtime": return "Model/runtime docs";
    case "community_report": return "Community report";
    case "github_issues": return "GitHub issues";
    case "github_discussions": return "GitHub discussions";
    case "docs_readme": return "Docs/README";
    case "independent_blog": return "Independent blog";
    default: return purpose.replace(/_/g, " ");
  }
}

function buildSourceCategoryAppendix(entries: EvidenceLedgerEntry[]): string {
  const byPurpose = new Map<string, string[]>();
  for (const entry of entries) {
    const purpose = String(entry.metadata?.sourcePurpose ?? "generic");
    const urls = byPurpose.get(purpose) ?? [];
    const url = normalizeUrlForCitation(entry.canonicalLocator);
    if (!urls.includes(url)) urls.push(url);
    byPurpose.set(purpose, urls.slice(0, 2));
  }
  if (byPurpose.size === 0) return "";
  const lines = ["## Source Categories Checked"];
  for (const [purpose, urls] of Array.from(byPurpose.entries()).sort()) {
    lines.push(`- ${sourcePurposeLabel(purpose)}: ${urls.join(", ")}`);
  }
  return lines.join("\n");
}

function buildUncertaintyAppendix(specKind: string): string {
  if (specKind === "local_model_setup") {
    return [
      "## Unknowns / Source Gaps",
      "- Exact tokens-per-second, long-context stability, and tool-call reliability still need a local run on the target Windows/GPU machine.",
      "- VRAM figures are sizing estimates unless the cited source gives a measured number; validate with Task Manager or `nvidia-smi` during the first run.",
    ].join("\n");
  }
  return [
    "## Unknowns / Source Gaps",
    "- Claims not directly covered by the fetched sources should be treated as provisional until verified against the target environment.",
  ].join("\n");
}

export function polishWebResearchAnswer(input: {
  answer: string;
  userMessage: string;
  evidence?: BroadEvidencePack;
}): string {
  const entries = verifiedSourceEntries(input.evidence);
  if (entries.length === 0) return input.answer;

  const spec = classifyResearchTaskSpec(input.userMessage);
  const evidencePurposes = Array.from(new Set(
    entries.map((entry) => (entry.metadata?.sourcePurpose as ResearchSourcePurpose) ?? "generic"),
  ));

  let next = repairUnsupportedCitations(input.answer, entries);

  // Validate command blocks: reject malformed or dangerous commands
  const { validateAnswerCommands } = require("@/lib/channels/command-validation") as {
    validateAnswerCommands: (answer: string) => { ok: boolean; issues: unknown[]; repairedAnswer: string };
  };
  const commandValidation = validateAnswerCommands(next);
  if (!commandValidation.ok) {
    next = commandValidation.repairedAnswer;
  }

  const coverage = evaluateWebResearchCoverage(spec, next, evidencePurposes);
  const appendices: string[] = [];

  if (
    spec.requiredAnswerSections.includes("source_category_separation") &&
    !/(?:^|\n)\s*##\s+Source Categories Checked\b/i.test(next)
  ) {
    appendices.push(buildSourceCategoryAppendix(entries));
  }
  if (coverage.missingAnswerSections.includes("uncertainty_statement")) {
    appendices.push(buildUncertaintyAppendix(spec.taskKind));
  }
  if (/(?:current|latest|recent|today)\b/i.test(input.userMessage) && !/\b(?:source\s+date|published|updated|retrieved|accessed|date\s+unknown)\b/i.test(next)) {
    appendices.push(`Sources checked: retrieved today; source publish/update dates were not consistently visible.`);
  }

  const appendixText = appendices.filter(Boolean).join("\n\n");
  if (!appendixText) return next;
  return [next.trim(), appendixText].filter(Boolean).join("\n\n");
}
