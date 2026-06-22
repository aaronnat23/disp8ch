import { spawnSync, execFile, type ExecFileException } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

import type { DynamicWorkflowWorkerResult, DynamicWorkflowAgentKind } from "./types";
import { normalizeWorkerOutput } from "./worker-executor";
import { findClaudeBinary } from "@/lib/sessions/coding-agent-registry";
import { logger } from "@/lib/utils/logger";

const log = logger.child("dynamic-workflows:external-backends");

const DEFAULT_TIMEOUT_MS = 300_000;
const VERSION_CHECK_TIMEOUT_MS = 5_000;

function findCodexBinary(): string {
  const candidates: string[] = [
    process.platform === "win32" && process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "Programs", "OpenAI", "Codex", "codex.exe")
      : "",
    process.platform === "win32" && process.env.USERPROFILE
      ? path.join(process.env.USERPROFILE, "AppData", "Local", "Programs", "OpenAI", "Codex", "codex.exe")
      : "",
    process.env.HOME ? path.join(process.env.HOME, ".local", "bin", "codex") : "",
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    "/usr/bin/codex",
  ].filter(Boolean);

  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch { /* skip */ }
  }
  return "codex";
}

function findGeminiBinary(): string {
  const candidates: string[] = [
    process.platform === "win32" && process.env.USERPROFILE
      ? path.join(process.env.USERPROFILE, "AppData", "Roaming", "npm", "gemini-cli.cmd")
      : "",
    process.platform === "win32" && process.env.USERPROFILE
      ? path.join(process.env.USERPROFILE, "AppData", "Roaming", "npm", "gemini-internal.cmd")
      : "",
    process.env.HOME ? path.join(process.env.HOME, ".local", "bin", "gemini") : "",
    "/opt/homebrew/bin/gemini",
    "/usr/local/bin/gemini",
    "/usr/bin/gemini",
  ].filter(Boolean);

  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch { /* skip */ }
  }
  return "gemini";
}

function findBinary(kind: "claude" | "codex" | "gemini"): string {
  switch (kind) {
    case "claude":
      return findClaudeBinary();
    case "codex":
      return findCodexBinary();
    case "gemini":
      return findGeminiBinary();
  }
}

function binaryIsRunnable(binaryPath: string): boolean {
  try {
    const result = spawnSync(binaryPath, ["--version"], {
      timeout: VERSION_CHECK_TIMEOUT_MS,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

export function isBackendAvailable(kind: "claude" | "codex" | "gemini"): boolean {
  const bin = findBinary(kind);
  if (!fs.existsSync(bin)) return false;
  return binaryIsRunnable(bin);
}

export function getBackendCliPath(kind: "claude" | "codex"): string | null {
  const bin = findBinary(kind);
  if (!fs.existsSync(bin) || !binaryIsRunnable(bin)) return null;
  return bin;
}

export function checkBackendConfig(kind: "claude" | "codex"): {
  available: boolean;
  cliPath?: string;
  error?: string;
} {
  const bin = findBinary(kind);

  if (!fs.existsSync(bin)) {
    return {
      available: false,
      error: `${kind === "claude" ? "Claude Code" : "OpenAI Codex"} CLI not found. Searched: ${bin}. Install the CLI and ensure it is on PATH.`,
    };
  }

  if (!binaryIsRunnable(bin)) {
    return {
      available: false,
      cliPath: bin,
      error: `${kind === "claude" ? "Claude Code" : "OpenAI Codex"} CLI found at ${bin} but it is not executable or returned a non-zero exit code. Verify the installation and try running "${bin} --version" manually.`,
    };
  }

  return { available: true, cliPath: bin };
}

async function runWithTimeout(
  command: string,
  args: string[],
  options: { worktreePath?: string; timeoutMs?: number },
): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    const child = execFile(
      command,
      args,
      {
        cwd: options.worktreePath ?? process.cwd(),
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
        signal: controller.signal,
      },
      (error: ExecFileException | null, stdout: string, stderr: string) => {
        clearTimeout(timer);
        if (error) {
          if (error.killed || error.code === "ETIMEDOUT" || error.signal === "SIGTERM") {
            resolve({
              stdout: stdout ?? "",
              stderr: stderr ?? "",
              exitCode: error.code ? (typeof error.code === "number" ? error.code : -1) : -1,
              timedOut: true,
            });
          } else {
            resolve({
              stdout: stdout ?? "",
              stderr: stderr ?? "",
              exitCode: typeof error.code === "number" ? error.code : (error.code ? -1 : -1),
              timedOut: false,
            });
          }
        } else {
          resolve({ stdout, stderr, exitCode: 0, timedOut: false });
        }
      },
    );

    child.on("error", (_err: Error) => {
      clearTimeout(timer);
      resolve({ stdout: "", stderr: "", exitCode: -1, timedOut: false });
    });
  });
}

function parseClaudeOutput(output: string): unknown {
  try {
    const trimmed = output.trim();
    if (!trimmed) return null;

    const firstBrace = trimmed.indexOf("{");
    if (firstBrace < 0) {
      return { summary: trimmed.slice(0, 5000), status: "completed" };
    }

    const jsonBlock = trimmed.slice(firstBrace);

    let balance = 0;
    let inString = false;
    let escape = false;
    let endIndex = -1;
    for (let i = 0; i < jsonBlock.length; i++) {
      const ch = jsonBlock[i]!;
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === "{") balance++;
      if (ch === "}") {
        balance--;
        if (balance === 0) {
          endIndex = i + 1;
          break;
        }
      }
    }

    if (endIndex > 0) {
      return JSON.parse(jsonBlock.slice(0, endIndex));
    }

    return { summary: trimmed.slice(0, 5000), status: "completed" };
  } catch {
    return { summary: output.trim().slice(0, 5000), status: "completed" };
  }
}

function claudeSetupInstructions(): string[] {
  return [
    "Install Claude Code: https://docs.anthropic.com/en/docs/claude-code/overview",
    "Run `claude` to authenticate with your Anthropic account.",
    "Verify the CLI works: `claude --version`",
    "Once installed, Claude Code workers will be available for dynamic workflow runs.",
  ];
}

function codexSetupInstructions(): string[] {
  return [
    "Install OpenAI Codex CLI: https://github.com/openai/codex",
    "Run `codex` to authenticate with your OpenAI account.",
    "Verify the CLI works: `codex --version` (or `codex exec --help`)",
    "Once installed, Codex workers will be available for dynamic workflow runs.",
  ];
}

function geminiSetupInstructions(): string[] {
  return [
    "Install the Gemini CLI: https://github.com/google-gemini/gemini-cli",
    "Run `gemini` to authenticate with your Google account.",
    "Verify the CLI works: `gemini --version`",
    "Once installed, Gemini workers will be available for dynamic workflow runs.",
  ];
}

export async function executeExternalWorker(
  kind: "claude" | "codex",
  prompt: string,
  options?: {
    worktreePath?: string;
    permissionMode?: "approve-reads" | "approve-all" | "deny-all";
    model?: string;
    maxTurns?: number;
    timeoutMs?: number;
  },
): Promise<DynamicWorkflowWorkerResult> {
  const config = checkBackendConfig(kind as "claude" | "codex");
  if (!config.available) {
    log.warn(`External backend ${kind} is not available`, { error: config.error });
    return {
      status: "failed",
      summary: `Cannot execute ${kind} worker: ${config.error ?? "Backend not available."}`,
      findings: [
        {
          claim: `${kind === "claude" ? "Claude Code" : "OpenAI Codex"} backend is not configured.`,
          evidence: config.error ?? "CLI not found or not executable.",
          confidence: 1,
        },
      ],
      nextActions:
        kind === "claude" ? claudeSetupInstructions() : codexSetupInstructions(),
    };
  }

  const bin = config.cliPath!;
  const permissionMode = options?.permissionMode ?? "approve-reads";
  const maxTurns = options?.maxTurns ?? 25;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  log.info(`Executing external ${kind} worker`, {
    kind,
    bin,
    permissionMode,
    maxTurns,
    timeoutMs,
    promptLength: prompt.length,
    worktreePath: options?.worktreePath,
  });

  let args: string[];

  if (kind === "claude") {
    args = [
      "--print",
      "--output-format", "json",
      "--permission-mode", permissionMode,
      "--max-turns", String(maxTurns),
      prompt,
    ];
    if (options?.model) {
      args.splice(4, 0, "--model", options.model);
    }
  } else {
    args = ["exec", "--prompt", prompt];
    if (options?.model) {
      args.push("--model", options.model);
    }
    if (options?.worktreePath) {
      // codex exec respects --cwd to change working directory
      args.unshift("--cwd", options.worktreePath);
    }
  }

  try {
    const result = await runWithTimeout(bin, args, {
      worktreePath: options?.worktreePath,
      timeoutMs,
    });

    if (result.timedOut) {
      log.warn(`External ${kind} worker timed out after ${timeoutMs}ms`);
      return {
        status: "timed_out",
        summary: `${kind === "claude" ? "Claude Code" : "OpenAI Codex"} worker timed out after ${timeoutMs}ms. Consider increasing the timeout or reducing the task scope.`,
        raw: result.stdout ? result.stdout.slice(0, 5000) : null,
      };
    }

    if (result.exitCode !== 0) {
      log.warn(`External ${kind} worker exited with code ${result.exitCode}`, {
        stderr: result.stderr.slice(0, 1000),
      });
      return {
        status: "failed",
        summary: `${kind === "claude" ? "Claude Code" : "OpenAI Codex"} worker failed with exit code ${result.exitCode}.`,
        raw: { exitCode: result.exitCode, stdout: result.stdout.slice(0, 5000), stderr: result.stderr.slice(0, 5000) },
        findings: [
          {
            claim: `Worker execution failed with exit code ${result.exitCode}.`,
            evidence: result.stderr.slice(0, 2000) || "No stderr output.",
            confidence: 1,
          },
        ],
        nextActions: [
          "Check that the backend is authenticated and has access to the worktree.",
          "Verify the worktree path exists and is a valid git repository if the task requires one.",
          `Try running manually: ${[bin, ...args].join(" ")}`,
        ],
      };
    }

    const parsed = parseClaudeOutput(result.stdout);
    const normalized = normalizeWorkerOutput(parsed);

    // Merge any stdout context the parser missed
    if (!normalized.raw) {
      normalized.raw = { cliOutput: result.stdout.slice(0, 5000) };
    }

    log.info(`External ${kind} worker completed`, {
      status: normalized.status,
      summaryLength: normalized.summary.length,
      findingsCount: normalized.findings?.length ?? 0,
    });

    return normalized;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`External ${kind} worker threw an unexpected error`, { error: message });
    return {
      status: "failed",
      summary: `External ${kind} worker threw an unexpected error: ${message}`,
      findings: [
        {
          claim: `Worker execution threw: ${message}`,
          evidence: message,
          confidence: 1,
        },
      ],
      nextActions: [
        "Check the CLI installation and PATH.",
        "Verify the backend is authenticated.",
        kind === "claude" ? claudeSetupInstructions()[0]! : codexSetupInstructions()[0]!,
      ],
    };
  }
}
