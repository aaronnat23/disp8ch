import { spawnSync, execFile, type ExecFileException } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

import type { DynamicWorkflowWorkerResult, DynamicWorkflowAgentKind } from "./types";
import { parseWorkerResult, WORKER_RESULT_JSON_SCHEMA } from "./worker-result-schema";
import { findClaudeBinary } from "@/lib/sessions/coding-agent-registry";
import { logger } from "@/lib/utils/logger";

const log = logger.child("dynamic-workflows:external-backends");

const DEFAULT_TIMEOUT_MS = 300_000;
const VERSION_CHECK_TIMEOUT_MS = 5_000;
let codexOAuthStatusCache: { checkedAt: number; value: { available: boolean; authenticated: boolean; detail: string } } | null = null;

type BackendLauncher = {
  command: string;
  argsPrefix: string[];
  displayPath: string;
};

function findCodexLauncher(): BackendLauncher {
  const executableCandidates: string[] = [
    process.platform === "win32" && process.env.APPDATA
      ? path.join(process.env.APPDATA, "npm", "node_modules", "@openai", "codex", "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe")
      : "",
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

  for (const candidate of executableCandidates) {
    try {
      if (fs.existsSync(candidate)) return { command: candidate, argsPrefix: [], displayPath: candidate };
    } catch { /* skip */ }
  }

  const npmScriptCandidates = [
    process.platform === "win32" && process.env.APPDATA
      ? path.join(process.env.APPDATA, "npm", "node_modules", "@openai", "codex", "bin", "codex.js")
      : "",
    process.env.HOME
      ? path.join(process.env.HOME, ".npm-global", "lib", "node_modules", "@openai", "codex", "bin", "codex.js")
      : "",
  ].filter(Boolean);
  for (const candidate of npmScriptCandidates) {
    try {
      if (fs.existsSync(candidate)) {
        return { command: process.execPath, argsPrefix: [candidate], displayPath: candidate };
      }
    } catch { /* skip */ }
  }
  return { command: "codex", argsPrefix: [], displayPath: "codex" };
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

function findLauncher(kind: "claude" | "codex" | "gemini"): BackendLauncher {
  switch (kind) {
    case "claude":
      return { command: findClaudeBinary(), argsPrefix: [], displayPath: findClaudeBinary() };
    case "codex":
      return findCodexLauncher();
    case "gemini":
      return { command: findGeminiBinary(), argsPrefix: [], displayPath: findGeminiBinary() };
  }
}

function launcherIsRunnable(launcher: BackendLauncher): boolean {
  try {
    const result = spawnSync(launcher.command, [...launcher.argsPrefix, "--version"], {
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
  const launcher = findLauncher(kind);
  if (launcher.command !== "codex" && !fs.existsSync(launcher.command)) return false;
  return launcherIsRunnable(launcher);
}

export function getBackendCliPath(kind: "claude" | "codex"): string | null {
  const launcher = findLauncher(kind);
  if ((launcher.command !== "codex" && !fs.existsSync(launcher.command)) || !launcherIsRunnable(launcher)) return null;
  return launcher.displayPath;
}

export function checkBackendConfig(kind: "claude" | "codex"): {
  available: boolean;
  cliPath?: string;
  error?: string;
} {
  const launcher = findLauncher(kind);

  if (launcher.command !== "codex" && !fs.existsSync(launcher.command)) {
    return {
      available: false,
      error: `${kind === "claude" ? "Claude Code" : "OpenAI Codex"} CLI not found. Searched: ${launcher.displayPath}. Install the CLI and ensure it is on PATH.`,
    };
  }

  if (!launcherIsRunnable(launcher)) {
    return {
      available: false,
      cliPath: launcher.displayPath,
      error: `${kind === "claude" ? "Claude Code" : "OpenAI Codex"} CLI found at ${launcher.displayPath} but it is not executable or returned a non-zero exit code. Verify the installation and try running "${launcher.displayPath} --version" manually.`,
    };
  }

  return { available: true, cliPath: launcher.displayPath };
}

export function getCodexOAuthStatus(): { available: boolean; authenticated: boolean; detail: string } {
  if (codexOAuthStatusCache && Date.now() - codexOAuthStatusCache.checkedAt < 10_000) {
    return codexOAuthStatusCache.value;
  }
  const config = checkBackendConfig("codex");
  if (!config.available) {
    const value = { available: false, authenticated: false, detail: config.error || "Codex CLI is unavailable." };
    codexOAuthStatusCache = { checkedAt: Date.now(), value };
    return value;
  }
  const launcher = findLauncher("codex");
  try {
    const result = spawnSync(launcher.command, [...launcher.argsPrefix, "login", "status"], {
      timeout: VERSION_CHECK_TIMEOUT_MS,
      windowsHide: true,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
    const authenticated = result.status === 0 && /logged in using chatgpt/i.test(output);
    const value = {
      available: true,
      authenticated,
      detail: authenticated ? "Logged in using ChatGPT" : "Run `codex login` with ChatGPT before selecting this backend.",
    };
    codexOAuthStatusCache = { checkedAt: Date.now(), value };
    return value;
  } catch {
    const value = { available: true, authenticated: false, detail: "Codex login status could not be verified." };
    codexOAuthStatusCache = { checkedAt: Date.now(), value };
    return value;
  }
}

async function runWithTimeout(
  command: string,
  args: string[],
  options: { worktreePath?: string; timeoutMs?: number; signal?: AbortSignal },
): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean; aborted: boolean; errorMessage?: string }> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve) => {
    const controller = new AbortController();
    let timedOut = false;
    let externallyAborted = false;
    const abortFromCaller = () => {
      externallyAborted = true;
      controller.abort();
    };
    if (options.signal?.aborted) abortFromCaller();
    else options.signal?.addEventListener("abort", abortFromCaller, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abortFromCaller);
    };
    let settled = false;
    const finish = (result: { stdout: string; stderr: string; exitCode: number; timedOut: boolean; aborted: boolean; errorMessage?: string }) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

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
        if (error) {
          if (error.killed || error.code === "ETIMEDOUT" || error.signal === "SIGTERM") {
            finish({
              stdout: stdout ?? "",
              stderr: stderr ?? "",
              exitCode: error.code ? (typeof error.code === "number" ? error.code : -1) : -1,
              timedOut,
              aborted: externallyAborted,
              errorMessage: error.message,
            });
          } else {
            finish({
              stdout: stdout ?? "",
              stderr: stderr ?? "",
              exitCode: typeof error.code === "number" ? error.code : (error.code ? -1 : -1),
              timedOut: false,
              aborted: false,
              errorMessage: error.message,
            });
          }
        } else {
          finish({ stdout, stderr, exitCode: 0, timedOut: false, aborted: false });
        }
      },
    );
    child.stdin?.end();

    child.on("error", (error: Error) => {
      finish({ stdout: "", stderr: "", exitCode: -1, timedOut: false, aborted: externallyAborted, errorMessage: error.message });
    });
  });
}

export type CodexPromptResult = {
  output: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
};

function parseCodexJsonl(stdout: string): Omit<CodexPromptResult, "modelId"> {
  let output = "";
  let inputTokens = 0;
  let outputTokens = 0;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as {
        type?: string;
        item?: { type?: string; text?: string };
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      if (event.type === "item.completed" && event.item?.type === "agent_message" && event.item.text) {
        output = event.item.text;
      }
      if (event.type === "turn.completed" && event.usage) {
        inputTokens = Math.max(0, Number(event.usage.input_tokens || 0));
        outputTokens = Math.max(0, Number(event.usage.output_tokens || 0));
      }
    } catch { /* Ignore non-event diagnostics. */ }
  }
  if (!output.trim()) throw new Error("Codex completed without a final agent message.");
  return { output: output.trim(), inputTokens, outputTokens };
}

export async function executeCodexPrompt(input: {
  prompt: string;
  modelId: string;
  worktreePath?: string;
  permissionMode?: "read-only" | "workspace-write";
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<CodexPromptResult> {
  const config = checkBackendConfig("codex");
  if (!config.available) throw new Error(config.error || "OpenAI Codex CLI is unavailable.");
  const launcher = findLauncher("codex");
  const args = [
    ...launcher.argsPrefix,
    "exec",
    "--model", input.modelId,
    "--sandbox", input.permissionMode ?? "read-only",
    "--ephemeral",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "--color", "never",
    "--json",
  ];
  if (input.worktreePath) args.push("-C", input.worktreePath);
  args.push(input.prompt);
  const runOptions = {
    worktreePath: input.worktreePath,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
  };
  let result = await runWithTimeout(launcher.command, args, runOptions);
  if (result.exitCode === -1 && !result.timedOut && !result.aborted && !input.signal?.aborted) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    result = await runWithTimeout(launcher.command, args, runOptions);
  }
  if (result.aborted) throw new Error("OpenAI Codex execution was cancelled.");
  if (result.timedOut) throw new Error(`OpenAI Codex timed out after ${input.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms.`);
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout || result.errorMessage || "No diagnostic output")
      .replace(/(token|secret|authorization)\s*[:=]\s*\S+/gi, "$1=[REDACTED]").trim();
    throw new Error(`OpenAI Codex failed with exit code ${result.exitCode}: ${detail.slice(0, 1200)}`);
  }
  return {
    ...parseCodexJsonl(result.stdout),
    modelId: input.modelId,
  };
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
    signal?: AbortSignal;
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

  const structuredPrompt = [
    prompt,
    "Return exactly one JSON object matching this schema. Do not use Markdown or add other keys:",
    JSON.stringify(WORKER_RESULT_JSON_SCHEMA),
  ].join("\n\n");

  if (kind === "codex") {
    try {
      const result = await executeCodexPrompt({
        prompt: structuredPrompt,
        modelId: options?.model || "gpt-5.6-terra",
        worktreePath: options?.worktreePath,
        permissionMode: permissionMode === "approve-all" ? "workspace-write" : "read-only",
        timeoutMs,
        signal: options?.signal,
      });
      const normalized = parseWorkerResult(parseClaudeOutput(result.output));
      return {
        ...normalized,
        usage: {
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          totalTokens: result.inputTokens + result.outputTokens,
          costUsd: 0,
        },
        resolvedProvider: "codex-oauth",
        resolvedModelId: result.modelId,
        raw: { oauthSubscription: true },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("External codex worker failed", { error: message });
      return {
        status: /timed out/i.test(message) ? "timed_out" : "failed",
        summary: `OpenAI Codex worker failed: ${message.slice(0, 1600)}`,
        nextActions: ["Verify `codex login status`, the selected model entitlement, and the confirmed workspace path."],
      };
    }
  }

  let args: string[];

  args = [
    "--print",
    "--output-format", "json",
    "--permission-mode", permissionMode,
    "--max-turns", String(maxTurns),
    structuredPrompt,
  ];
  if (options?.model) {
    args.splice(4, 0, "--model", options.model);
  }

  try {
    const result = await runWithTimeout(bin, args, {
      worktreePath: options?.worktreePath,
      timeoutMs,
      signal: options?.signal,
    });

    if (result.aborted) {
      return { status: "cancelled", summary: `${kind === "claude" ? "Claude Code" : "OpenAI Codex"} worker was cancelled.` };
    }
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
    const normalized = parseWorkerResult(parsed);

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
