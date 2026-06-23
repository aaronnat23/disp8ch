import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { LlamaCppCapabilities, RuntimeInventory } from "./types";

const exe = (name: string) => (process.platform === "win32" ? `${name}.exe` : name);

function run(cmd: string, args: string[]): { ok: boolean; out: string } {
  try {
    const res = spawnSync(cmd, args, { encoding: "utf8", timeout: 6000, windowsHide: true });
    return { ok: res.status === 0, out: `${res.stdout || ""}\n${res.stderr || ""}` };
  } catch {
    return { ok: false, out: "" };
  }
}

function findLlamaCppDir(env: NodeJS.ProcessEnv): string | null {
  const candidates = [
    env.DISP8CH_LLAMACPP_DIR,
    env.LLAMA_CPP_DIR,
    process.platform === "win32" ? "C:\\llama.cpp\\bin" : null,
    process.platform === "win32" ? "C:\\llama.cpp" : null,
    env.HOME ? path.join(env.HOME, "llama.cpp", "build", "bin") : null,
    "/usr/local/bin",
  ].filter(Boolean) as string[];
  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, exe("llama-server")))) return dir;
    } catch { /* ignore */ }
  }
  return null;
}

/** Parse capability flags from a llama.cpp --help dump (version-aware). */
export function parseLlamaCapabilities(help: string): LlamaCppCapabilities {
  const has = (flag: string) => help.includes(flag);
  return {
    ngedAuto: /-ngl[, ].*auto|n-gpu-layers.*auto|\bauto\b.*gpu/i.test(help) || has("-ngl") && /auto/i.test(help),
    fit: has("--fit") || /\s-fit\b/.test(help),
    fitTarget: has("--fit-target") || /\s-fitt\b/.test(help),
    cacheTypeK: has("--cache-type-k") || /\s-ctk\b/.test(help),
    cacheTypeV: has("--cache-type-v") || /\s-ctv\b/.test(help),
    cpuMoe: has("--cpu-moe"),
    nCpuMoe: has("--n-cpu-moe"),
    splitMode: has("--split-mode") || /\s-sm\b/.test(help),
    tensorSplit: has("--tensor-split") || /\s-ts\b/.test(help),
    specType: has("--spec-type"),
  };
}

export function detectRuntimes(options?: { env?: NodeJS.ProcessEnv; ollamaEndpoint?: string }): RuntimeInventory {
  const env = options?.env ?? process.env;
  const notes: string[] = [];

  // ── llama.cpp ──
  const binDir = findLlamaCppDir(env);
  const serverPath = binDir ? path.join(binDir, exe("llama-server")) : null;
  const llamaEndpoint = (env.DISP8CH_LLAMACPP_ENDPOINT || "http://127.0.0.1:8080").replace(/\/$/, "");
  const cliPath = binDir && fs.existsSync(path.join(binDir, exe("llama-cli"))) ? path.join(binDir, exe("llama-cli")) : null;
  const fitParamsPath = binDir && fs.existsSync(path.join(binDir, exe("llama-fit-params"))) ? path.join(binDir, exe("llama-fit-params")) : null;
  let version: string | null = null;
  let capabilities: LlamaCppCapabilities | null = null;
  if (serverPath) {
    const ver = run(serverPath, ["--version"]);
    const m = ver.out.match(/version[:\s]+([\w.\-]+)|build[:\s]+(\d+)/i);
    version = m ? (m[1] || m[2]) : "unknown";
    const help = run(serverPath, ["--help"]);
    capabilities = parseLlamaCapabilities(help.out);
    notes.push(`llama.cpp detected at ${binDir}${fitParamsPath ? " (native fitter available)" : ""}.`);
  } else {
    notes.push("llama.cpp not detected; set DISP8CH_LLAMACPP_DIR to enable native fitting.");
  }

  // ── Ollama ──
  const ollamaEndpoint = options?.ollamaEndpoint || env.OLLAMA_HOST || "http://127.0.0.1:11434";
  const ollamaVer = run("ollama", ["--version"]);
  const ollamaVersion = ollamaVer.ok ? (ollamaVer.out.match(/version is ([\w.]+)/)?.[1] ?? "unknown") : null;

  return {
    llamaCpp: {
      available: Boolean(serverPath),
      binDir,
      serverPath,
      cliPath,
      fitParamsPath,
      version,
      capabilities,
      endpoint: llamaEndpoint,
      serviceUp: false,
      loadedModels: [],
    },
    ollama: { available: Boolean(ollamaVersion), version: ollamaVersion, serviceUp: false, endpoint: ollamaEndpoint },
    notes,
  };
}

export async function fetchLlamaCppRuntimeState(options?: {
  endpoint?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<{ endpoint: string; serviceUp: boolean; loadedModels: string[] }> {
  const endpoint = (options?.endpoint || "http://127.0.0.1:8080").replace(/\/$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options?.timeoutMs ?? 2500);
  try {
    const response = await (options?.fetchImpl || fetch)(`${endpoint}/v1/models`, { signal: controller.signal });
    if (!response.ok) return { endpoint, serviceUp: false, loadedModels: [] };
    const body = await response.json() as Record<string, unknown>;
    const rows = [
      ...(Array.isArray(body.data) ? body.data : []),
      ...(Array.isArray(body.models) ? body.models : []),
    ] as Array<Record<string, unknown>>;
    const loadedModels = [...new Set(rows.flatMap((row) => [row.id, row.model, row.name])
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value) => value.trim()))];
    return { endpoint, serviceUp: true, loadedModels };
  } catch {
    return { endpoint, serviceUp: false, loadedModels: [] };
  } finally {
    clearTimeout(timer);
  }
}
