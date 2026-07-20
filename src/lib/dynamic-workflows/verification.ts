import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { getAgentById, getDefaultAgent } from "@/lib/agents/registry";
import { evaluateCriterion, listRunCriteria, recordEvidence } from "./criteria";
import type { DynamicWorkflowPlan, DynamicWorkflowRunRecord } from "./types";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT = 16_000;
const FORBIDDEN_SHELL_TOKENS = /(?:&&|\|\||[|;<>`]|\$\(|\r|\n)/;

export interface VerificationCheckResult {
  kind: "command" | "browser";
  label: string;
  passed: boolean;
  unavailable?: boolean;
  durationMs: number;
  detail: string;
  evidenceId?: string;
}

function parseCommand(command: string): { executable: string; args: string[] } {
  const text = command.trim();
  if (!text) throw new Error("Verification command is empty.");
  if (FORBIDDEN_SHELL_TOKENS.test(text)) {
    throw new Error("Shell operators and command substitution are not allowed in verification commands.");
  }
  const tokens: string[] = [];
  let current = "";
  let quote: "\"" | "'" | null = null;
  let escaping = false;
  for (const char of text) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\" && quote === "\"") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (quote) throw new Error("Verification command contains an unterminated quote.");
  if (current) tokens.push(current);
  if (tokens.length === 0) throw new Error("Verification command is empty.");
  return { executable: tokens[0], args: tokens.slice(1) };
}

function bounded(value: string): string {
  return value.length <= MAX_OUTPUT ? value : `${value.slice(0, MAX_OUTPUT)}\n[truncated]`;
}

function resolveWorkspaceRoot(run: DynamicWorkflowRunRecord, plan: DynamicWorkflowPlan): string {
  const manager = run.managerAgentId ? getAgentById(run.managerAgentId) : null;
  const fallback = manager ?? getDefaultAgent();
  const requested = String(plan.workspaceRoot || fallback.workspacePath || "").trim();
  if (!requested || !path.isAbsolute(requested)) throw new Error("Verification requires an absolute workspace root.");
  const resolved = fs.realpathSync.native(requested);
  if (!fs.statSync(resolved).isDirectory()) throw new Error("Verification workspace root is not a directory.");
  return resolved;
}

function commandHash(executable: string, args: string[]): string {
  return crypto.createHash("sha256").update(JSON.stringify([executable, ...args])).digest("hex");
}

async function runCommandCheck(
  runId: string,
  root: string,
  command: string,
  signal?: AbortSignal,
): Promise<VerificationCheckResult> {
  const started = Date.now();
  try {
    const { executable, args } = parseCommand(command);
    if (signal?.aborted) throw new Error("Verification cancelled.");
    const result = await execFileAsync(executable, args, {
      cwd: root,
      windowsHide: true,
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
      encoding: "utf8",
      signal,
    });
    const detail = bounded([result.stdout, result.stderr].filter(Boolean).join("\n").trim() || "Command exited successfully.");
    const evidence = recordEvidence({
      runId,
      evidenceType: "command",
      sourceType: "verification",
      summary: `${command} exited with code 0.`,
      payload: { commandHash: commandHash(executable, args), executable, args, exitCode: 0, output: detail },
    });
    return { kind: "command", label: command, passed: true, durationMs: Date.now() - started, detail, evidenceId: evidence.id };
  } catch (error) {
    const err = error as Error & { stdout?: string; stderr?: string; code?: number | string; killed?: boolean };
    return {
      kind: "command",
      label: command,
      passed: false,
      durationMs: Date.now() - started,
      detail: bounded([err.message, err.stdout, err.stderr].filter(Boolean).join("\n")),
    };
  }
}

async function runBrowserCheck(
  runId: string,
  check: { url: string; instruction: string; screenshotName?: string },
  signal?: AbortSignal,
): Promise<VerificationCheckResult> {
  const started = Date.now();
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  try {
    const url = new URL(check.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only HTTP(S) browser checks are allowed.");
    if (signal?.aborted) throw new Error("Verification cancelled.");
    browser = await chromium.launch({ headless: true });
    const closeOnAbort = () => { void browser?.close().catch(() => undefined); };
    signal?.addEventListener("abort", closeOnAbort, { once: true });
    const errors: string[] = [];
    const assetRoot = path.join(process.cwd(), "data", "dynamic-workflow-artifacts", runId);
    fs.mkdirSync(assetRoot, { recursive: true });
    const baseName = String(check.screenshotName || `browser-${crypto.randomUUID()}`)
      .replace(/[^a-zA-Z0-9._-]/g, "-")
      .slice(0, 100);
    const screenshots: string[] = [];
    for (const viewport of [
      { name: "desktop", width: 1440, height: 900 },
      { name: "mobile", width: 390, height: 844 },
    ]) {
      if (signal?.aborted) throw new Error("Verification cancelled.");
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
      const page = await context.newPage();
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(`${viewport.name} console: ${message.text()}`);
      });
      page.on("pageerror", (error) => errors.push(`${viewport.name} page: ${error.message}`));
      await page.goto(url.toString(), { waitUntil: "networkidle", timeout: 45_000 });
      if (signal?.aborted) throw new Error("Verification cancelled.");
      const state = await page.evaluate(() => ({
        textLength: (document.body?.innerText || "").trim().length,
        elementCount: document.body?.querySelectorAll("*").length || 0,
        overflow: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0) > window.innerWidth + 2,
      }));
      if (state.textLength === 0 && state.elementCount < 3) errors.push(`${viewport.name}: blank render`);
      if (state.overflow) errors.push(`${viewport.name}: horizontal overflow`);
      const screenshotPath = path.join(assetRoot, `${baseName}-${viewport.name}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      screenshots.push(screenshotPath);
      await context.close();
    }
    const passed = errors.length === 0;
    const detail = passed ? `Desktop and mobile checks passed: ${check.instruction}` : errors.join("\n");
    const evidence = recordEvidence({
      runId,
      evidenceType: "browser",
      sourceType: "playwright",
      summary: detail,
      payload: { url: url.toString(), instruction: check.instruction, screenshots, errors },
    });
    return {
      kind: "browser",
      label: `${url}: ${check.instruction}`,
      passed,
      durationMs: Date.now() - started,
      detail,
      evidenceId: evidence.id,
    };
  } catch (error) {
    return {
      kind: "browser",
      label: `${check.url}: ${check.instruction}`,
      passed: false,
      unavailable: /executable|browser.*install/i.test(String(error)),
      durationMs: Date.now() - started,
      detail: bounded(String(error)),
    };
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

function applyMethodOutcome(
  runId: string,
  method: "command" | "browser",
  checks: VerificationCheckResult[],
): void {
  const criteria = listRunCriteria(runId).filter((criterion) => criterion.methods.includes(method));
  if (criteria.length === 0) return;
  const hasChecks = checks.length > 0;
  const passed = hasChecks && checks.every((check) => check.passed);
  const unavailable = !hasChecks || checks.some((check) => check.unavailable);
  for (const criterion of criteria) {
    const status = unavailable ? "unverified" : passed ? "passed" : "failed";
    evaluateCriterion({ runId, criterionId: criterion.id, status });
    if (status === "passed") {
      recordEvidence({
        runId,
        criterionId: criterion.id,
        evidenceType: method,
        sourceType: "verification-summary",
        summary: checks.map((check) => `${check.label}: passed`).join("; ").slice(0, 8000),
        payload: { evidenceIds: checks.map((check) => check.evidenceId).filter(Boolean) },
      });
    }
  }
}

export async function executeVerification(input: {
  run: DynamicWorkflowRunRecord;
  plan: DynamicWorkflowPlan;
  signal?: AbortSignal;
}): Promise<{ passed: boolean; results: VerificationCheckResult[] }> {
  const verification = input.plan.verification;
  const root = resolveWorkspaceRoot(input.run, input.plan);
  const commandResults: VerificationCheckResult[] = [];
  const browserResults: VerificationCheckResult[] = [];

  for (const command of verification?.commands?.slice(0, 20) ?? []) {
    commandResults.push(await runCommandCheck(input.run.id, root, command, input.signal));
  }
  for (const check of verification?.browserChecks?.slice(0, 10) ?? []) {
    browserResults.push(await runBrowserCheck(input.run.id, check, input.signal));
  }

  applyMethodOutcome(input.run.id, "command", commandResults);
  applyMethodOutcome(input.run.id, "browser", browserResults);
  const results = [...commandResults, ...browserResults];
  const requested = (verification?.commands?.length || 0) + (verification?.browserChecks?.length || 0);
  return { passed: requested > 0 && results.length === requested && results.every((result) => result.passed), results };
}

export const verificationInternals = { parseCommand, commandHash };
