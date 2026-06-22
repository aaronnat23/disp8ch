/**
 * Parallel-safety guard for tool batches.
 *
 * Disp8ch's tool-call loop dispatches every tool batch via Promise.all by default,
 * but unrestricted parallelism is wrong for two cases:
 *
 *   1. Tools that need user input (clarify, confirm_execution) — they race for
 *      the same user response slot.
 *   2. Tools that mutate shared state — concurrent writes to the same file path,
 *      concurrent destructive bash commands, two image_generate calls writing to
 *      the same artifact id, etc.
 *
 * This helper inspects a batch of tool calls and reports whether the batch can
 * run safely in parallel. The caller falls back to sequential when this returns
 * false.
 *
 * Mirrors the conservative batching rule used by mature tool-calling agents:
 * reads may run together, but user prompts and shared-state mutations do not.
 */

import type { ToolDefinition } from "@/lib/engine/tools";

const NEVER_PARALLEL_TOOLS = new Set<string>([
  "clarify",
  "confirm_execution",
  "wait_for_input",
]);

const FILE_SCOPED_TOOLS = new Set<string>([
  "read_file",
  "write_file",
  "edit_file",
  "patch",
]);

const DESTRUCTIVE_BASH = /(?:^|\s|&&|\|\||;|`)(?:rm\s|rmdir\s|mv\s|sed\s+-i|truncate\s|dd\s|shred\s|git\s+(?:reset|clean|checkout)\s)/;
const REDIRECT_OVERWRITE = /[^>]>[^>]|^>[^>]/;

export type BatchToolCall = {
  name: string;
  args: Record<string, unknown> | undefined;
};

export type ParallelSafetyDecision = {
  parallel: boolean;
  reason: string;
};

function bashCommand(args: Record<string, unknown> | undefined): string | null {
  if (!args) return null;
  const cmd = args.command ?? args.cmd ?? args.script;
  return typeof cmd === "string" ? cmd : null;
}

function isDestructiveBash(call: BatchToolCall): boolean {
  if (call.name !== "bash_exec" && call.name !== "run_shell" && call.name !== "system_command") return false;
  const cmd = bashCommand(call.args);
  if (!cmd) return false;
  if (DESTRUCTIVE_BASH.test(cmd)) return true;
  if (REDIRECT_OVERWRITE.test(cmd)) return true;
  return false;
}

function filePath(call: BatchToolCall): string | null {
  if (!FILE_SCOPED_TOOLS.has(call.name)) return null;
  const p = call.args?.path ?? call.args?.file;
  return typeof p === "string" ? p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\//, "") : null;
}

function pathsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) return true;
  return false;
}

export function isBatchSafeForParallel(
  calls: BatchToolCall[],
  toolDefs: ToolDefinition[],
): ParallelSafetyDecision {
  if (calls.length <= 1) return { parallel: false, reason: "single-call batch — no parallelism needed" };

  // Quick name-based reject: any tool that must not run alongside others.
  for (const call of calls) {
    if (NEVER_PARALLEL_TOOLS.has(call.name)) {
      return { parallel: false, reason: `${call.name} requires user input — must run sequentially` };
    }
  }

  // Lookup tool metadata for concurrency safety.
  const defByName = new Map(toolDefs.map((def) => [def.name, def]));
  for (const call of calls) {
    const def = defByName.get(call.name);
    // Tools with no metadata default to concurrencySafe=false.
    if (!def?.metadata?.concurrencySafe) {
      return { parallel: false, reason: `${call.name} is not marked concurrencySafe — sequential` };
    }
    if (def.metadata?.destructive) {
      return { parallel: false, reason: `${call.name} is destructive — sequential` };
    }
  }

  // Destructive bash command detection (heuristic across args even when metadata says safe).
  for (const call of calls) {
    if (isDestructiveBash(call)) {
      return { parallel: false, reason: `${call.name} command looks destructive — sequential` };
    }
  }

  // File-scope overlap: two read_file/write_file/edit_file/patch calls targeting
  // the same path (or one is a prefix of the other) must be sequential.
  const seenPaths: string[] = [];
  for (const call of calls) {
    const p = filePath(call);
    if (!p) continue;
    for (const existing of seenPaths) {
      if (pathsOverlap(p, existing)) {
        return { parallel: false, reason: `path collision: ${p} overlaps with ${existing}` };
      }
    }
    seenPaths.push(p);
  }

  return { parallel: true, reason: `${calls.length} concurrency-safe calls, no path collisions` };
}
