import { execFile } from "node:child_process";
import { logger } from "@/lib/utils/logger";

const log = logger.child("agents:runtime-adapters");

export type AgentAdapterType = "claude_local" | "codex_local" | "opencode_local" | "process" | "http";

export type AgentAdapterConfig = {
  type: AgentAdapterType;
  cwd: string;
  model?: string;
  promptTemplate?: string;
  env?: Record<string, string>;
  timeoutMs: number;
  graceMs: number;
};

export type ReadinessProbeResult = {
  ready: boolean;
  adapterType: AgentAdapterType;
  probeOutput: string;
  error?: string;
  durationMs: number;
};

async function runProbeCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  input: string,
  env?: Record<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    const child = execFile(command, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 64 * 1024,
      env: { ...process.env, ...(env ?? {}) },
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (data: Buffer) => { stdout += data.toString(); });
    child.stderr?.on("data", (data: Buffer) => { stderr += data.toString(); });
    child.stdin?.end(input);
    child.on("close", (code) => resolve({ stdout, stderr, exitCode: code }));
    child.on("error", (err) => resolve({ stdout, stderr: stderr || err.message, exitCode: null }));
  });
}

function probeSucceeded(result: { stdout: string; stderr: string; exitCode: number | null }): boolean {
  return result.exitCode === 0 && /\bhello\b/i.test(`${result.stdout}\n${result.stderr}`);
}

export async function probeClaudeLocal(config: AgentAdapterConfig): Promise<ReadinessProbeResult> {
  const t0 = Date.now();
  try {
    const { stdout, stderr, exitCode } = await runProbeCommand(
      "claude",
      ["--print", "-", "--output-format", "stream-json", "--verbose"],
      config.cwd,
      config.timeoutMs,
      "Respond with hello.",
      config.env,
    );
    const hasOutput = probeSucceeded({ stdout, stderr, exitCode });
    return {
      ready: hasOutput,
      adapterType: "claude_local",
      probeOutput: (stdout + stderr).slice(0, 500),
      error: hasOutput ? undefined : `Claude probe exited with code ${exitCode ?? "unknown"} or did not return hello`,
      durationMs: Date.now() - t0,
    };
  } catch {
    return {
      ready: false,
      adapterType: "claude_local",
      probeOutput: "",
      error: "Claude CLI not found or failed to respond",
      durationMs: Date.now() - t0,
    };
  }
}

export async function probeCodexLocal(config: AgentAdapterConfig): Promise<ReadinessProbeResult> {
  const t0 = Date.now();
  try {
    const { stdout, stderr, exitCode } = await runProbeCommand(
      "codex",
      ["exec", "--json", "-"],
      config.cwd,
      config.timeoutMs,
      "Respond with hello.",
      config.env,
    );
    const hasOutput = probeSucceeded({ stdout, stderr, exitCode });
    return {
      ready: hasOutput,
      adapterType: "codex_local",
      probeOutput: (stdout + stderr).slice(0, 500),
      error: hasOutput ? undefined : `Codex probe exited with code ${exitCode ?? "unknown"} or did not return hello`,
      durationMs: Date.now() - t0,
    };
  } catch {
    return {
      ready: false,
      adapterType: "codex_local",
      probeOutput: "",
      error: "Codex CLI not found or failed to respond",
      durationMs: Date.now() - t0,
    };
  }
}

export async function probeOpenCodeLocal(config: AgentAdapterConfig): Promise<ReadinessProbeResult> {
  const t0 = Date.now();
  try {
    const { stdout, stderr, exitCode } = await runProbeCommand(
      "opencode",
      ["exec", "--json", "-"],
      config.cwd,
      config.timeoutMs,
      "Respond with hello.",
      config.env,
    );
    return {
      ready: probeSucceeded({ stdout, stderr, exitCode }),
      adapterType: "opencode_local",
      probeOutput: (stdout + stderr).slice(0, 500),
      error: exitCode === 0 ? undefined : `OpenCode probe exited with code ${exitCode ?? "unknown"}`,
      durationMs: Date.now() - t0,
    };
  } catch {
    return {
      ready: false,
      adapterType: "opencode_local",
      probeOutput: "",
      error: "OpenCode CLI not found or failed to respond",
      durationMs: Date.now() - t0,
    };
  }
}

export async function probeAgentAdapter(config: AgentAdapterConfig): Promise<ReadinessProbeResult> {
  if (config.type === "claude_local") return probeClaudeLocal(config);
  if (config.type === "codex_local") return probeCodexLocal(config);
  if (config.type === "opencode_local") return probeOpenCodeLocal(config);
  return {
    ready: config.type === "http" || config.type === "process",
    adapterType: config.type,
    probeOutput: "",
    durationMs: 0,
  };
}

export function getAdapterProbes(): Array<{
  type: AgentAdapterType;
  label: string;
  command: string;
  probeArgs: string[];
}> {
  return [
    {
      type: "claude_local",
      label: "Claude Local (Anthropic CLI)",
      command: "claude",
      probeArgs: ["--print", "-", "--output-format", "stream-json", "--verbose"],
    },
    {
      type: "codex_local",
      label: "Codex Local (OpenAI CLI)",
      command: "codex",
      probeArgs: ["exec", "--json", "-"],
    },
    {
      type: "opencode_local",
      label: "OpenCode Local",
      command: "opencode",
      probeArgs: ["exec", "--json", "-"],
    },
  ];
}
