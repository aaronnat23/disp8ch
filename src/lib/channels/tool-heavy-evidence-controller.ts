import type { ToolHeavyTaskPlan, EvidenceBucket } from "@/lib/channels/tool-heavy-task-plan";
import { bucketToLabel, classifyToolHeavyTask } from "@/lib/channels/tool-heavy-task-plan";
import { executeTool } from "@/lib/engine/tools";
import type { EvidenceLedgerEntry } from "@/lib/channels/evidence-ledger-v2";
import { createEvidenceFromToolResult } from "@/lib/channels/evidence-ledger-v2";

export type BucketEvidence = {
  bucket: EvidenceBucket;
  label: string;
  entries: EvidenceLedgerEntry[];
  toolsUsed: number;
  targetMet: boolean;
};

export type ToolHeavyEvidenceResult = {
  plan: ToolHeavyTaskPlan;
  buckets: BucketEvidence[];
  totalToolsUsed: number;
  totalVerifiedItems: number;
  metrics: {
    searches: number;
    reads: number;
    extracts: number;
    failed: number;
  };
};

function bucketToolNames(bucket: EvidenceBucket): string[] {
  switch (bucket) {
    case "repo_architecture":
      return ["list_files", "search_files", "read_file"];
    case "benchmark_artifacts":
      return ["read_file", "list_files", "search_files"];
    case "current_web":
      return ["web_search", "web_extract", "fetch_url", "browser_navigate"];
    case "app_capability_state":
      return ["read_file", "search_files", "list_files"];
    case "implementation_targets":
      return ["read_file", "search_files"];
    case "tests_and_acceptance":
      return ["search_files", "read_file"];
  }
}

function bucketSearchQueries(bucket: EvidenceBucket, message: string): string[] {
  const clean = message.replace(/\s+/g, " ").trim().slice(0, 120);
  switch (bucket) {
    case "repo_architecture":
      return [clean, "architecture route service controller", "src/lib"];
    case "benchmark_artifacts":
      return [clean, "benchmark results report", "test run evidence"];
    case "current_web":
      return [clean, "latest documentation", "public discussion official"];
    case "app_capability_state":
      return [clean, "capability provider configuration status", "tool registry runtime availability"];
    case "implementation_targets":
      return [clean, "implementation route service component", "files to touch"];
    case "tests_and_acceptance":
      return [clean, "test regression", "acceptance criteria verification"];
  }
}

function bucketSearchPath(bucket: EvidenceBucket): string {
  switch (bucket) {
    case "benchmark_artifacts":
      return "docs";
    case "tests_and_acceptance":
      return "scripts";
    default:
      return ".";
  }
}

function bucketSeedFiles(bucket: EvidenceBucket, _message: string): string[] {
  switch (bucket) {
    case "repo_architecture":
      return [
        "package.json",
        "src/app/api/channels/route.ts",
      ];
    case "benchmark_artifacts":
      return [];
    case "app_capability_state":
      return [
        "src/lib/channels/capability-manifest.ts",
        "src/lib/engine/tools.ts",
      ];
    case "implementation_targets":
      return [];
    case "tests_and_acceptance":
      return [];
    case "current_web":
      return [];
  }
}

function bucketSeedUrls(bucket: EvidenceBucket, message: string): string[] {
  return [];
}

function outputHasEvidence(output: string): boolean {
  return Boolean(output.trim()) && !/^No matches for /i.test(output.trim()) && !/^Error:/i.test(output.trim());
}

function extractFileCandidates(output: string): string[] {
  const candidates = Array.from(output.matchAll(/\b((?:src|docs|scripts)\/[A-Za-z0-9._/() -]+?\.(?:ts|tsx|js|mjs|md|json|py|yml|yaml|txt))(?::\d+)?/g))
    .map((match) => match[1])
    .filter(Boolean);
  return Array.from(new Set(candidates)).slice(0, 2);
}

function extractUrls(output: string): string[] {
  return Array.from(new Set(output.match(/https?:\/\/[^\s)\],;"'<>]+/g) ?? [])).slice(0, 3);
}

function isRelevantCurrentWebUrl(url: string, message: string): boolean {
  return true;
}

export async function runToolHeavyEvidenceCollection(params: {
  message: string;
  sessionId: string;
  agentId: string;
  maxTotalTools?: number;
  onBucketComplete?: (bucket: EvidenceBucket, evidence: BucketEvidence) => void;
}): Promise<ToolHeavyEvidenceResult | null> {
  const plan = classifyToolHeavyTask(params.message);
  if (!plan) return null;

  const maxTotal = params.maxTotalTools ?? 24;
  const buckets: BucketEvidence[] = [];
  const metrics = { searches: 0, reads: 0, extracts: 0, failed: 0 };
  let totalToolsUsed = 0;

  for (const bucketPlan of plan.evidenceBuckets) {
    if (totalToolsUsed >= maxTotal) break;

    const entries: EvidenceLedgerEntry[] = [];
    let bucketTools = 0;
    const queries = bucketSearchQueries(bucketPlan.bucket, params.message);
    const seedFiles = bucketSeedFiles(bucketPlan.bucket, params.message);
    const seedUrls = bucketSeedUrls(bucketPlan.bucket, params.message);

    for (const file of seedFiles) {
      if (bucketTools >= bucketPlan.maxTools) break;
      if (totalToolsUsed >= maxTotal) break;
      try {
        const readOutput = await executeTool(
          "read_file",
          { path: file },
          { agentId: params.agentId, channelSessionId: params.sessionId, readOnly: true },
        );
        metrics.reads++;
        totalToolsUsed++;
        if (outputHasEvidence(readOutput)) {
          bucketTools++;
          entries.push(...createEvidenceFromToolResult({
            tool: "read_file",
            args: { path: file },
            output: readOutput,
          }));
        }
      } catch {
        metrics.failed++;
      }
    }

    if (seedUrls.length > 0 && bucketTools < bucketPlan.maxTools && totalToolsUsed < maxTotal) {
      try {
        const urls = seedUrls.slice(0, Math.min(4, seedUrls.length));
        const extractOutput = await executeTool(
          "web_extract",
          { urls, max_chars_per_url: 2400 },
          { agentId: params.agentId, channelSessionId: params.sessionId, readOnly: true },
        );
        metrics.extracts++;
        totalToolsUsed++;
        if (outputHasEvidence(extractOutput)) {
          const webEntries = createEvidenceFromToolResult({
            tool: "web_extract",
            args: { urls },
            output: extractOutput,
          }).filter((entry) => isRelevantCurrentWebUrl(entry.canonicalLocator, params.message));
          if (webEntries.length > 0) bucketTools++;
          entries.push(...webEntries);
        }
      } catch {
        metrics.failed++;
      }
    }

    for (const query of queries.slice(0, 3)) {
      if (bucketTools >= bucketPlan.maxTools) break;
      if (totalToolsUsed >= maxTotal) break;

      try {
        const toolName = bucketPlan.bucket === "current_web" ? "web_search" : "search_files";
        const output = await executeTool(
          toolName,
          bucketPlan.bucket === "current_web"
            ? { query, maxResults: 4 }
            : { pattern: query, path: bucketSearchPath(bucketPlan.bucket), maxResults: 15 },
          { agentId: params.agentId, channelSessionId: params.sessionId, readOnly: true },
        );
        metrics.searches++;
        totalToolsUsed++;
        const searchHasEvidence = outputHasEvidence(output);
        if (searchHasEvidence) bucketTools++;
        if (searchHasEvidence) {
          entries.push(...createEvidenceFromToolResult({
            tool: toolName,
            args: bucketPlan.bucket === "current_web" ? { query, maxResults: 4 } : { pattern: query },
            output,
          }));
        }

        if (bucketPlan.bucket === "current_web" && bucketTools < bucketPlan.maxTools && totalToolsUsed < maxTotal) {
          const urls = extractUrls(output).filter((url) => isRelevantCurrentWebUrl(url, params.message));
          if (urls.length > 0) {
            const extractOutput = await executeTool(
              "web_extract",
              { urls: urls.slice(0, 2), max_chars_per_url: 2400 },
              { agentId: params.agentId, channelSessionId: params.sessionId, readOnly: true },
            );
            metrics.extracts++;
            totalToolsUsed++;
            if (outputHasEvidence(extractOutput)) {
              const webEntries = createEvidenceFromToolResult({
                tool: "web_extract",
                args: { urls: urls.slice(0, 2) },
                output: extractOutput,
              }).filter((entry) => isRelevantCurrentWebUrl(entry.canonicalLocator, params.message));
              if (webEntries.length > 0) bucketTools++;
              entries.push(...webEntries);
            }
          }
        } else if (bucketTools < bucketPlan.maxTools && totalToolsUsed < maxTotal) {
          const files = extractFileCandidates(output);
          for (const file of files) {
            if (bucketTools >= bucketPlan.maxTools || totalToolsUsed >= maxTotal) break;
            const readOutput = await executeTool(
              "read_file",
              { path: file },
              { agentId: params.agentId, channelSessionId: params.sessionId, readOnly: true },
            );
            metrics.reads++;
            totalToolsUsed++;
            if (outputHasEvidence(readOutput)) {
              bucketTools++;
              entries.push(...createEvidenceFromToolResult({
                tool: "read_file",
                args: { path: file },
                output: readOutput,
              }));
            }
          }
        }
      } catch {
        metrics.failed++;
      }
    }

    const verifiedCount = entries.filter((e) => e.verified).length;
    const bucketEvidence: BucketEvidence = {
      bucket: bucketPlan.bucket,
      label: bucketToLabel(bucketPlan.bucket),
      entries,
      toolsUsed: bucketTools,
      targetMet: verifiedCount >= bucketPlan.targetEvidenceCount,
    };
    buckets.push(bucketEvidence);
    params.onBucketComplete?.(bucketPlan.bucket, bucketEvidence);
  }

  const totalVerifiedItems = buckets.reduce((sum, b) => sum + b.entries.filter((e) => e.verified).length, 0);

  return { plan, buckets, totalToolsUsed, totalVerifiedItems, metrics };
}

export function buildToolHeavyEvidencePrompt(result: ToolHeavyEvidenceResult): string {
  const lines: string[] = [
    "## Tool-Heavy Evidence Collection",
    `Task type: ${result.plan.taskType}. Total tools used: ${result.totalToolsUsed}. Verified items: ${result.totalVerifiedItems}.`,
    `Expected evidence rows: ${result.plan.expectedEvidenceCount}. Expected explicit gaps: ${result.plan.expectedGapCount}.`,
    `Required final answer sections: ${result.plan.finalAnswerSections.join(", ")}.`,
    "",
    "Final answer requirements:",
    "- Lead with the decision/recommendation, then show the evidence.",
    "- Use concrete file paths, source URLs, benchmark artifact names, functions, routes, and components from verified evidence.",
    "- Do not invent file paths, APIs, tables, or source links. Label missing evidence instead.",
    "- If evidence is incomplete, still return the requested sections and mark the relevant rows/gaps as unverified or missing.",
    "",
  ];

  for (const bucket of result.buckets) {
    const status = bucket.targetMet ? "✓ met" : "⚠ below target";
    lines.push(`### ${bucket.label} (${bucket.toolsUsed} tools, ${bucket.entries.filter((e) => e.verified).length} verified) ${status}`);
    for (const entry of bucket.entries.slice(0, 5)) {
      const verified = entry.verified ? "verified" : "partial";
      const excerpt = entry.excerpts.find(Boolean) || "";
      const details = excerpt && excerpt !== entry.summary ? ` Details: ${excerpt.slice(0, 260)}` : "";
      lines.push(`- [${verified}] ${entry.canonicalLocator}: ${entry.summary.slice(0, 180)}${details}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function cleanCell(value: string, max = 220): string {
  return value.replace(/\s+/g, " ").replace(/\|/g, "/").trim().slice(0, max);
}

function verifiedEntries(result: ToolHeavyEvidenceResult): EvidenceLedgerEntry[] {
  return result.buckets
    .flatMap((bucket) => bucket.entries.map((entry) => ({ bucket: bucket.label, entry })))
    .filter(({ entry }) => entry.verified)
    .filter(({ entry }, index, all) => all.findIndex((candidate) => candidate.entry.canonicalLocator === entry.canonicalLocator) === index)
    .sort((a, b) => evidenceSpecificityRank(a.entry) - evidenceSpecificityRank(b.entry))
    .map(({ entry, bucket }) => ({
      ...entry,
      metadata: { ...(entry.metadata ?? {}), bucket },
    }));
}

function evidenceSpecificityRank(entry: EvidenceLedgerEntry): number {
  if (entry.tool === "read_file" || entry.kind === "repo_file") return 0;
  if (entry.tool === "web_extract" || entry.kind === "browser_page" || entry.kind === "web_source") return 1;
  if (entry.tool === "fetch_url") return 2;
  if (entry.tool === "search_files" || entry.tool === "web_search") return 3;
  if (entry.tool === "list_files") return 4;
  return 5;
}

function buildEvidenceTable(entries: EvidenceLedgerEntry[], minRows: number): string[] {
  const concreteEntries = entries.filter((entry) => !["search_files", "list_files", "web_search"].includes(entry.tool));
  const pool = concreteEntries.length >= Math.min(minRows, 8) ? concreteEntries : entries;
  const targetRows = Math.max(minRows, 8);
  const selected: EvidenceLedgerEntry[] = [];
  const seen = new Set<string>();
  const bucketOrder = ["Repo Architecture", "Benchmark Artifacts", "Current Web", "App Capability State", "Implementation Targets", "Tests & Acceptance"];
  for (const bucket of bucketOrder) {
    const entry = pool.find((candidate) => candidate.metadata?.bucket === bucket && !seen.has(candidate.id));
    if (entry) {
      selected.push(entry);
      seen.add(entry.id);
    }
  }
  for (const entry of pool) {
    if (selected.length >= targetRows) break;
    if (seen.has(entry.id)) continue;
    selected.push(entry);
    seen.add(entry.id);
  }
  const lines = ["| Evidence | Bucket | Why it matters |", "|---|---|---|"];
  for (const entry of selected) {
    const bucket = typeof entry.metadata?.bucket === "string" ? entry.metadata.bucket : entry.kind;
    const locator = entry.canonicalLocator || entry.locator;
    lines.push(`| \`${cleanCell(locator, 180)}\` | ${cleanCell(bucket, 60)} | ${cleanCell(entry.summary || entry.excerpts[0] || "Verified by read-only tool output.")} |`);
  }
  if (selected.length === 0) {
    lines.push("| No verified evidence collected | n/a | The route must expose this as incomplete instead of guessing. |");
  }
  return lines;
}

function buildToolHeavyEvidenceRecovery(result: ToolHeavyEvidenceResult): string {
  const entries = verifiedEntries(result);
  const incompleteBuckets = result.buckets.filter((bucket) => !bucket.targetMet);
  return [
    "## Tool-Heavy Recovery",
    "Model-led synthesis was unavailable or rejected. This recovery reports verified evidence only and does not fabricate a decision, architecture, capability verdict, implementation plan, or test result.",
    "",
    `Task type: ${result.plan.taskType}. Tools used: ${result.totalToolsUsed}. Verified items: ${result.totalVerifiedItems}.`,
    "",
    "## Verified Evidence",
    ...buildEvidenceTable(entries, result.plan.expectedEvidenceCount),
    "",
    "## Incomplete Evidence Buckets",
    ...(incompleteBuckets.length > 0
      ? incompleteBuckets.map(
        (bucket) => `- ${bucket.label}: ${bucket.entries.filter((entry) => entry.verified).length} verified item(s); target not met.`,
      )
      : ["- None reported by the evidence collector."]),
    "",
    "## Evidence Limits",
    "- Search and listing hits are discovery signals, not proof of runtime behavior.",
    "- Retry model-led synthesis after resolving provider availability, or gather the missing bucket evidence.",
    "- Do not treat this recovery as a recommendation or as proof that a feature exists, is configured, or requires a specific change.",
  ].join("\n");
}

export function buildToolHeavyContractFallbackAnswer(result: ToolHeavyEvidenceResult): string {
  return buildToolHeavyEvidenceRecovery(result);
}
