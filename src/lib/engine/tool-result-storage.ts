import * as fs from "node:fs";
import * as path from "node:path";
import crypto from "node:crypto";
import { logger } from "@/lib/utils/logger";

const RESULTS_DIR = path.join(process.cwd(), "data", "tool-results");
const DEFAULT_PER_TOOL_LIMIT = 50000;
const AGGREGATE_TURN_BUDGET = 150000;
const INFINITE_THRESHOLD_TOOLS = new Set(["read_file", "memory_get", "memory_search", "session_recall"]);

try { fs.mkdirSync(RESULTS_DIR, { recursive: true }); } catch { /* exists */ }

export interface PersistedOutput {
  persisted: true;
  preview: string;
  path: string;
  fullSizeChars: number;
}

export interface ToolOutputResult {
  text: string;
  persisted: boolean;
  passthrough?: boolean;
  persistedPath?: string;
  originalSize?: number;
  toolResultId?: string;
  outputHash?: string;
  createdAt?: string;
  metadataPath?: string;
}

function hash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function storeToolOutput(
  toolName: string,
  output: string,
  toolUseId: string,
): ToolOutputResult {
  const originalSize = output.length;
  const outputHash = hash(output);
  const createdAt = new Date().toISOString();
  const stableId = `toolres_${hash(`${toolName}:${toolUseId}:${outputHash}`).slice(0, 16)}`;

  if (INFINITE_THRESHOLD_TOOLS.has(toolName)) {
    return { text: output, persisted: false, passthrough: true, originalSize, toolResultId: stableId, outputHash, createdAt };
  }

  if (output.length <= DEFAULT_PER_TOOL_LIMIT) {
    return { text: output, persisted: false, originalSize, toolResultId: stableId, outputHash, createdAt };
  }

  try {
    const fileName = `${toolName}-${toolUseId.slice(0, 12)}-${Date.now()}.txt`;
    const filePath = path.join(RESULTS_DIR, fileName);
    fs.writeFileSync(filePath, output, "utf-8");
    const metadataPath = `${filePath}.json`;
    fs.writeFileSync(metadataPath, JSON.stringify({
      toolResultId: stableId,
      toolName,
      toolUseId,
      outputHash,
      originalSize,
      createdAt,
      persistedPath: filePath,
    }, null, 2), "utf-8");

    const head = output.slice(0, 2000);
    const tail = output.slice(-500);
    const preview = `<persisted-output id="${stableId}" chars="${output.length}" path="${filePath}">\nPreview:\n${head}\n\n... [${output.length - 2500} chars persisted] ...\n\n${tail}\n</persisted-output>`;

    return {
      text: preview,
      persisted: true,
      persistedPath: filePath,
      originalSize,
      toolResultId: stableId,
      outputHash,
      createdAt,
      metadataPath,
    };
  } catch (err) {
    logger.error("[tool-result-storage] Failed to persist output", { error: String(err) });
    return {
      text: output.slice(0, DEFAULT_PER_TOOL_LIMIT) + `\n\n[Output truncated at ${DEFAULT_PER_TOOL_LIMIT} chars (failed to persist)]`,
      persisted: false,
      originalSize,
      toolResultId: stableId,
      outputHash,
      createdAt,
    };
  }
}

export function enforceTurnBudget(
  results: Array<{ toolName: string; text: string; persisted: boolean }>,
): Array<{ toolName: string; text: string; persisted: boolean }> {
  let total = results.reduce((sum, r) => sum + r.text.length, 0);
  if (total <= AGGREGATE_TURN_BUDGET) return results;

  const candidates = results
    .map((r, i) => ({ ...r, index: i }))
    .filter(r => !r.persisted && !INFINITE_THRESHOLD_TOOLS.has(r.toolName))
    .sort((a, b) => b.text.length - a.text.length);

  for (const candidate of candidates) {
    if (total <= AGGREGATE_TURN_BUDGET) break;
    const reduction = candidate.text.length - Math.max(200, Math.floor(DEFAULT_PER_TOOL_LIMIT / 3));
    candidate.text = candidate.text.slice(0, Math.max(200, Math.floor(DEFAULT_PER_TOOL_LIMIT / 3))) +
      `\n\n[Trimmed ${reduction} chars to stay within turn budget]`;
    results[candidate.index] = candidate;
    total -= reduction;
  }

  return results;
}

export function getPersistedOutput(filePath: string): string | null {
  try {
    if (fs.existsSync(filePath)) return fs.readFileSync(filePath, "utf-8");
  } catch { /* not found */ }
  return null;
}

export function cleanupOldResults(): void {
  try {
    const now = Date.now();
    const files = fs.readdirSync(RESULTS_DIR);
    for (const file of files) {
      const filePath = path.join(RESULTS_DIR, file);
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > 3600_000) {
        fs.unlinkSync(filePath);
      }
    }
  } catch { /* cleanup is best-effort */ }
}

setInterval(cleanupOldResults, 300_000);
