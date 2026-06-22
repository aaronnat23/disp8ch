/**
 * n8n import repair assistant.
 *
 * Turns an {@link N8nImportResult} into an actionable checklist so a user can
 * see exactly what needs review after importing an n8n workflow — and offers
 * non-destructive repair suggestions (nearest disp8ch node, expression mapper
 * hints). It never rewrites the workflow automatically; the user confirms.
 */

import type { N8nImportResult } from "@/lib/workflows/n8n-import";

export type ChecklistStatus = "ok" | "review" | "action-needed";

export interface N8nImportChecklistItem {
  key: string;
  label: string;
  count: number;
  status: ChecklistStatus;
  detail: string[];
}

export interface N8nImportChecklist {
  items: N8nImportChecklistItem[];
  needsReview: boolean;
  summary: string;
}

const BINARY_NODE_HINT = /(binary|readbinary|movebinary|writebinary|spreadsheetfile|readpdf|extractfromfile|files?\b)/i;

/**
 * Suggest the nearest disp8ch node type for an unsupported n8n node type.
 * Structural keyword mapping — not a per-workflow answer table.
 */
export function suggestNearestDisp8chNode(n8nType: string): string | null {
  const t = String(n8nType || "").toLowerCase();
  const rules: Array<[RegExp, string]> = [
    [/httprequest|webhook$|graphql/, "http-request"],
    [/slack/, "send-slack"],
    [/telegram/, "send-telegram"],
    [/discord/, "send-discord"],
    [/emailsend|sendemail|gmail|smtp/, "send-email"],
    [/(^|\.)set$|editfields|set\b/, "set-variables"],
    [/code|function|functionitem/, "run-code"],
    [/\bif\b|filter/, "if-else"],
    [/switch/, "switch"],
    [/merge/, "merge"],
    [/splitinbatches|loop|itemlists?/, "loop"],
    [/aggregate|summarize/, "aggregate"],
    [/wait|schedule|cron|interval/, "cron-trigger"],
    [/openai|anthropic|llm|agent|chat/, "claude-agent"],
    [/notion|airtable|sheets|googlesheets/, "http-request"],
    [/noop|nooperation/, "set-variables"],
  ];
  for (const [pattern, target] of rules) {
    if (pattern.test(t)) return target;
  }
  return null;
}

/**
 * Suggest a disp8ch mapper expression for a raw n8n expression fragment.
 * Handles the common `$json`, `$node["X"].json`, and `$input` forms.
 */
export function suggestExpressionMapping(raw: string): string | null {
  const expr = String(raw || "").trim();
  if (!expr) return null;
  // $json.field  ->  {{ data.field }}
  const jsonMatch = expr.match(/\$json(?:\.|\[['"])([\w.\]['"]+)/);
  if (jsonMatch) {
    const path = jsonMatch[1].replace(/['"\]]/g, "");
    return `{{ data.${path} }}`;
  }
  // $node["Label"].json.field  ->  {{ nodes.label.field }}
  const nodeMatch = expr.match(/\$node\[['"]([^'"]+)['"]\]\.json\.?([\w.]*)/);
  if (nodeMatch) {
    const label = nodeMatch[1].replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
    const field = nodeMatch[2] ? `.${nodeMatch[2]}` : "";
    return `{{ nodes.${label}${field} }}`;
  }
  // $input.first().json -> {{ data }}
  if (/\$input/.test(expr)) {
    return "{{ data }}";
  }
  return null;
}

function uniqueStrings(values: string[], cap = 8): string[] {
  return Array.from(new Set(values.filter(Boolean))).slice(0, cap);
}

/**
 * Build the post-import review checklist from an import result.
 */
export function buildN8nImportChecklist(result: N8nImportResult): N8nImportChecklist {
  const report = result.compatibilityReport;
  const items: N8nImportChecklistItem[] = [];

  items.push({
    key: "mapped-nodes",
    label: "Mapped nodes",
    count: result.stats.mapped,
    status: "ok",
    detail: uniqueStrings(report.supportedNodes.map((n) => `${n.nodeName} → ${n.disp8chType}`)),
  });

  const unsupported = report.unsupportedNodes;
  items.push({
    key: "unsupported-placeholders",
    label: "Unsupported placeholders",
    count: unsupported.length,
    status: unsupported.length > 0 ? "action-needed" : "ok",
    detail: uniqueStrings(
      unsupported.map((n) => {
        const suggestion = suggestNearestDisp8chNode(n.n8nType);
        return `${n.nodeName} (${n.n8nType})${suggestion ? ` → try ${suggestion}` : ""}`;
      }),
    ),
  });

  const creds = report.credentialPlaceholders;
  items.push({
    key: "credentials-needed",
    label: "Credentials needed",
    count: creds.length,
    status: creds.length > 0 ? "action-needed" : "ok",
    detail: uniqueStrings(creds.map((c) => `${c.nodeName}: ${c.credentialType}`)),
  });

  const expressionsCount = report.expressionTranslations.length + report.codeTranslations.length;
  items.push({
    key: "expressions-review",
    label: "Expressions needing review",
    count: expressionsCount,
    status: expressionsCount > 0 ? "review" : "ok",
    detail: uniqueStrings([
      ...report.expressionTranslations.map((e) => `${e.nodeName}.${e.field}: ${e.from} → ${e.to}`),
      ...report.codeTranslations.map((c) => `${c.nodeName}: ${c.warning}`),
    ]),
  });

  const binaryNodes = [
    ...unsupported.filter((n) => BINARY_NODE_HINT.test(n.n8nType)).map((n) => n.nodeName),
    ...report.partiallySupportedNodes.filter((n) => BINARY_NODE_HINT.test(n.n8nType)).map((n) => n.nodeName),
  ];
  items.push({
    key: "binary-data",
    label: "Binary data (unsupported)",
    count: binaryNodes.length,
    status: binaryNodes.length > 0 ? "action-needed" : "ok",
    detail: binaryNodes.length > 0
      ? uniqueStrings(binaryNodes.map((n) => `${n}: binary/file handling is not imported — rebuild with disp8ch file nodes`))
      : [],
  });

  // n8n links items 1:1; disp8ch passes object-level data between nodes. Flag
  // multi-output / split nodes so the user reviews item-linking assumptions.
  const itemLinkingNodes = report.partiallySupportedNodes
    .filter((n) => /splitinbatches|itemlists?|split|merge|aggregate/i.test(n.n8nType))
    .map((n) => n.nodeName);
  items.push({
    key: "item-linking",
    label: "Item-linking assumptions",
    count: itemLinkingNodes.length,
    status: itemLinkingNodes.length > 0 ? "review" : "ok",
    detail: itemLinkingNodes.length > 0
      ? uniqueStrings(itemLinkingNodes.map((n) => `${n}: disp8ch uses object-level data; verify per-item handling`))
      : [],
  });

  const pinCount = Object.keys(result.pinData).length;
  items.push({
    key: "pin-data",
    label: "Pin data imported",
    count: pinCount,
    status: "ok",
    detail: uniqueStrings(Object.values(result.pinData).map((p) => p.nodeName)),
  });

  const needsReview = items.some((i) => i.status !== "ok");
  const actionItems = items.filter((i) => i.status === "action-needed");
  const summary = needsReview
    ? `Imported ${result.stats.mapped}/${result.stats.total} nodes. ${actionItems.length > 0
        ? `${actionItems.length} item(s) need action: ${actionItems.map((i) => i.label.toLowerCase()).join(", ")}.`
        : "Review the flagged items before running live."}`
    : `Imported ${result.stats.mapped}/${result.stats.total} nodes cleanly. No repairs needed.`;

  return { items, needsReview, summary };
}
