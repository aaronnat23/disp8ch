import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

export type ShellSandboxMode = "off" | "docker";

export type ShellSandboxConfig = {
  mode: ShellSandboxMode;
  image: string;
  persistent: boolean;
  forwardEnv: string[];
};

export type ShellRunOptions = {
  command: string;
  cwd: string;
  timeoutMs: number;
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
  background?: boolean;
};

export type ShellRunResult = {
  stdout: string;
  stderr: string;
};

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function parseBool(value: string | undefined, fallback = false): boolean {
  if (value === undefined || value === "") return fallback;
  return /^(?:1|true|yes|on)$/i.test(value);
}

function parseForwardEnv(value: string | undefined): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const raw of String(value || "").split(",")) {
    const key = raw.trim();
    if (!key || !ENV_NAME_RE.test(key) || seen.has(key)) continue;
    seen.add(key);
    names.push(key);
  }
  return names;
}

export function getShellSandboxConfig(): ShellSandboxConfig {
  const mode = String(process.env.DISP8CH_EXEC_SANDBOX || "off").trim().toLowerCase() === "docker"
    ? "docker"
    : "off";
  return {
    mode,
    image: String(process.env.DISP8CH_EXEC_SANDBOX_IMAGE || "node:22-bookworm-slim").trim() || "node:22-bookworm-slim",
    persistent: parseBool(process.env.DISP8CH_EXEC_SANDBOX_PERSISTENT, false),
    forwardEnv: parseForwardEnv(process.env.DISP8CH_EXEC_SANDBOX_FORWARD_ENV),
  };
}

export function findContainerRuntime(): string | null {
  const explicit = String(process.env.DISP8CH_CONTAINER_RUNTIME || "").trim();
  const candidates = explicit ? [explicit] : ["docker", "podman"];
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["--version"], { timeout: 3000, stdio: "ignore" });
    if (!result.error && result.status === 0) {
      return candidate;
    }
  }
  return null;
}

function ensureContainerRuntime(): string {
  const runtime = findContainerRuntime();
  if (runtime) return runtime;
  throw new Error("Shell sandbox is enabled but docker/podman is not available.");
}

function resolveSandboxRoot(): string {
  const root = path.resolve(process.env.DISP8CH_EXEC_SANDBOX_ROOT || path.join(os.tmpdir(), "disp8ch-shell-sandbox"));
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function sanitizeMountCwd(cwd: string): string {
  const resolved = path.resolve(cwd || ".");
  if (!fs.existsSync(resolved)) {
    throw new Error(`Working directory does not exist: ${resolved}`);
  }
  return resolved;
}

function buildDockerArgs(config: ShellSandboxConfig, opts: ShellRunOptions): string[] {
  const cwd = sanitizeMountCwd(opts.cwd);
  const args = [
    "run",
    "--rm",
    "--network", "none",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--pids-limit", "256",
    "--cpus", process.env.DISP8CH_EXEC_SANDBOX_CPUS || "1",
    "--memory", process.env.DISP8CH_EXEC_SANDBOX_MEMORY || "1024m",
    "--tmpfs", "/tmp:rw,nosuid,size=256m",
    "-v", `${cwd}:/workspace:rw`,
    "-w", "/workspace",
  ];

  if (config.persistent) {
    const homeDir = path.join(resolveSandboxRoot(), "home");
    fs.mkdirSync(homeDir, { recursive: true });
    args.push("-v", `${homeDir}:/root:rw`);
  }

  for (const key of config.forwardEnv) {
    const value = opts.env?.[key] ?? process.env[key];
    if (value !== undefined) args.push("-e", `${key}=${value}`);
  }

  args.push(config.image, "bash", "-lc", opts.command);
  return args;
}

function runSpawn(bin: string, args: string[], opts: ShellRunOptions): Promise<ShellRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const maxBuffer = opts.maxBuffer ?? 512 * 1024;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(Object.assign(new Error("Command timed out"), { code: "ETIMEDOUT", stdout, stderr }));
    }, opts.timeoutMs);
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
      if (stdout.length + stderr.length > maxBuffer) child.kill("SIGTERM");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
      if (stdout.length + stderr.length > maxBuffer) child.kill("SIGTERM");
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(Object.assign(new Error(`Command failed: ${bin}`), { code, stdout, stderr }));
      }
    });
  });
}

export async function runShellCommand(opts: ShellRunOptions, config = getShellSandboxConfig()): Promise<ShellRunResult> {
  if (config.mode === "off" || process.platform === "win32") {
    const bin = process.platform === "win32" ? "cmd.exe" : "bash";
    const args = process.platform === "win32" ? ["/d", "/s", "/c", opts.command] : ["-c", opts.command];
    return runSpawn(bin, args, opts);
  }

  const runtime = ensureContainerRuntime();
  const args = buildDockerArgs(config, opts);
  return runSpawn(runtime, args, { ...opts, cwd: path.resolve(".") });
}

export function formatShellSandboxStatus(config = getShellSandboxConfig()): string {
  if (config.mode === "off") return "off";
  return `${config.mode}:${config.image}${config.persistent ? ":persistent" : ":ephemeral"}`;
}
