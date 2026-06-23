import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import net from "node:net";
import OpenAI from "openai";
import { nanoid } from "nanoid";
import { getSqlite, initializeDatabase, withSqliteWriteRecovery } from "@/lib/db";
import { discoverLocalModels } from "./inventory/local-files";
import { recommendLocalModelsV2 } from "./recommend-v2";
import {
  localCalibrationKey,
  ollamaCalibrationKey,
  saveCalibration,
  type CalibrationMetrics,
} from "./calibration";

export type BenchmarkJob = {
  id: string;
  candidateId: string;
  status: "queued" | "starting" | "running" | "completed" | "failed" | "cancelled";
  contextTokens: number;
  metrics: CalibrationMetrics | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

type ActiveJob = { cancelled: boolean; child: ChildProcess | null };
const activeJobs = new Map<string, ActiveJob>();
let benchmarkStateReconciled = false;

function ensureBenchmarkTable(): void {
  initializeDatabase();
  getSqlite().exec(`
    CREATE TABLE IF NOT EXISTS model_fit_benchmarks (
      id TEXT PRIMARY KEY,
      candidate_id TEXT NOT NULL,
      status TEXT NOT NULL,
      context_tokens INTEGER NOT NULL,
      metrics_json TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_model_fit_benchmarks_updated
      ON model_fit_benchmarks(updated_at DESC);
  `);
  if (!benchmarkStateReconciled) {
    benchmarkStateReconciled = true;
    getSqlite().prepare(`
      UPDATE model_fit_benchmarks
      SET status = 'failed',
          error = 'Benchmark interrupted by application restart',
          updated_at = ?
      WHERE status IN ('queued', 'starting', 'running')
    `).run(new Date().toISOString());
  }
}

function persist(job: BenchmarkJob): void {
  ensureBenchmarkTable();
  withSqliteWriteRecovery("model-fit:benchmark", (db) => {
    db.prepare(`
      INSERT INTO model_fit_benchmarks (
        id, candidate_id, status, context_tokens, metrics_json, error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        metrics_json = excluded.metrics_json,
        error = excluded.error,
        updated_at = excluded.updated_at
    `).run(
      job.id,
      job.candidateId,
      job.status,
      job.contextTokens,
      job.metrics ? JSON.stringify(job.metrics) : null,
      job.error,
      job.createdAt,
      job.updatedAt,
    );
  });
}

export function getBenchmarkJob(id: string): BenchmarkJob | null {
  ensureBenchmarkTable();
  const row = getSqlite().prepare(`
    SELECT id, candidate_id, status, context_tokens, metrics_json, error, created_at, updated_at
    FROM model_fit_benchmarks WHERE id = ? LIMIT 1
  `).get(id) as {
    id: string;
    candidate_id: string;
    status: BenchmarkJob["status"];
    context_tokens: number;
    metrics_json: string | null;
    error: string | null;
    created_at: string;
    updated_at: string;
  } | undefined;
  if (!row) return null;
  return {
    id: row.id,
    candidateId: row.candidate_id,
    status: row.status,
    contextTokens: row.context_tokens,
    metrics: row.metrics_json ? JSON.parse(row.metrics_json) as CalibrationMetrics : null,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function updateJob(job: BenchmarkJob, patch: Partial<BenchmarkJob>): BenchmarkJob {
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  persist(job);
  return job;
}

async function unusedLoopbackPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForEndpoint(baseUrl: string, active: ActiveJob, timeoutMs = 120_000): Promise<number> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (active.cancelled) throw new Error("Benchmark cancelled");
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return Date.now() - started;
    } catch {
      // Runtime may still be loading.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Local model server did not become ready within 120 seconds");
}

function sampleProcessMemoryGB(pid: number): number | null {
  try {
    if (process.platform === "win32") {
      const result = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
        encoding: "utf8",
        timeout: 2000,
        windowsHide: true,
      });
      const fields = String(result.stdout || "").match(/"([^"]*)"/g)?.map((value) => value.slice(1, -1)) ?? [];
      const kb = Number(String(fields[4] || "").replace(/[^\d]/g, ""));
      return Number.isFinite(kb) && kb > 0 ? Math.round((kb / 1024 / 1024) * 100) / 100 : null;
    }
    const result = spawnSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 });
    const kb = Number(String(result.stdout || "").trim());
    return Number.isFinite(kb) && kb > 0 ? Math.round((kb / 1024 / 1024) * 100) / 100 : null;
  } catch {
    return null;
  }
}

function sampleGpuMemoryGB(pid?: number): number | null {
  try {
    const result = spawnSync("nvidia-smi", ["--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"], {
      encoding: "utf8",
      timeout: 2500,
      windowsHide: true,
    });
    const rows = String(result.stdout || "").trim().split(/\r?\n/).filter(Boolean);
    let mib = 0;
    for (const row of rows) {
      const [rowPid, used] = row.split(",").map((part) => Number(part.trim()));
      if (!pid || rowPid === pid) mib += Number.isFinite(used) ? used : 0;
    }
    return mib > 0 ? Math.round((mib / 1024) * 100) / 100 : null;
  } catch {
    return null;
  }
}

function terminateProcessTree(child: ChildProcess | null): void {
  if (!child?.pid) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { timeout: 5000, windowsHide: true });
    } else {
      child.kill("SIGTERM");
    }
  } catch {
    try { child.kill("SIGKILL"); } catch { /* already stopped */ }
  }
}

async function measureOpenAiEndpoint(input: {
  baseUrl: string;
  modelId: string;
  active: ActiveJob;
  processId?: number;
  testTools: boolean;
}): Promise<Omit<CalibrationMetrics, "loadMs">> {
  const client = new OpenAI({ apiKey: "local-benchmark", baseURL: `${input.baseUrl}/v1`, timeout: 45_000, maxRetries: 0 });
  const start = Date.now();
  let firstTokenAt: number | null = null;
  let promptTokens = 0;
  let outputTokens = 0;
  let peakHostRamGB: number | null = null;
  let peakVramGB: number | null = null;
  const sampler = setInterval(() => {
    if (input.active.cancelled) return;
    const host = input.processId ? sampleProcessMemoryGB(input.processId) : null;
    const gpu = sampleGpuMemoryGB(input.processId);
    if (host !== null) peakHostRamGB = Math.max(peakHostRamGB ?? 0, host);
    if (gpu !== null) peakVramGB = Math.max(peakVramGB ?? 0, gpu);
  }, 500);
  try {
    const stream = await client.chat.completions.create({
      model: input.modelId,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 48,
      temperature: 0,
      messages: [
        { role: "system", content: "You are a local inference calibration probe." },
        { role: "user", content: "Write one concise sentence explaining why measured performance is more reliable than an estimate." },
      ],
    });
    for await (const chunk of stream) {
      if (input.active.cancelled) throw new Error("Benchmark cancelled");
      const text = chunk.choices[0]?.delta?.content || "";
      if (text && firstTokenAt === null) firstTokenAt = Date.now();
      if (chunk.usage?.prompt_tokens) promptTokens = chunk.usage.prompt_tokens;
      if (chunk.usage?.completion_tokens) outputTokens = chunk.usage.completion_tokens;
    }
    const finished = Date.now();
    const generationMs = Math.max(1, finished - (firstTokenAt ?? start));
    let toolJsonCorrect: boolean | null = null;
    if (input.testTools && !input.active.cancelled) {
      try {
        const toolResponse = await client.chat.completions.create({
          model: input.modelId,
          max_tokens: 48,
          temperature: 0,
          messages: [{ role: "user", content: "Call report_value with value 7." }],
          tools: [{
            type: "function",
            function: {
              name: "report_value",
              description: "Report one integer value.",
              parameters: {
                type: "object",
                properties: { value: { type: "integer" } },
                required: ["value"],
                additionalProperties: false,
              },
            },
          }],
          tool_choice: "required",
        });
        const call = toolResponse.choices[0]?.message?.tool_calls?.[0];
        toolJsonCorrect = Boolean(call && JSON.parse(call.function.arguments).value === 7);
      } catch {
        toolJsonCorrect = false;
      }
    }
    return {
      timeToFirstTokenMs: firstTokenAt ? firstTokenAt - start : null,
      promptTokensPerSecond: promptTokens > 0 && firstTokenAt
        ? Math.round((promptTokens / Math.max(1, firstTokenAt - start)) * 100_000) / 100
        : null,
      generationTokensPerSecond: outputTokens > 0 ? Math.round((outputTokens / generationMs) * 100_000) / 100 : null,
      peakVramGB,
      peakHostRamGB,
      endpointCorrect: firstTokenAt !== null,
      toolJsonCorrect,
      outputTokens,
    };
  } finally {
    clearInterval(sampler);
  }
}

async function executeBenchmark(job: BenchmarkJob): Promise<void> {
  const active = activeJobs.get(job.id);
  if (!active) return;
  let child: ChildProcess | null = null;
  let ollamaUnload: { endpoint: string; tag: string } | null = null;
  try {
    updateJob(job, { status: "starting" });
    const recommendation = await recommendLocalModelsV2({ contextTokens: job.contextTokens });
    const candidate = recommendation.allCandidates.find((model) => model.modelId === job.candidateId);
    if (!candidate) throw new Error("Candidate is no longer present in local inventory");
    if (candidate.source === "catalog") throw new Error("Download or install this model before benchmarking it");

    let baseUrl: string;
    let modelId: string;
    let loadMs: number | null = null;
    let calibrationKey: string;
    let runtime: string;
    let runtimeVersion: string | null;
    const kvType = job.contextTokens >= 32768 ? "q8_0" : "f16";

    if (candidate.source === "local_gguf") {
      const artifact = discoverLocalModels().find((item) => item.id === candidate.modelId && item.path === candidate.path);
      const serverPath = recommendation.runtimes.llamaCpp.serverPath;
      if (!artifact || !serverPath) throw new Error("The local GGUF or llama-server executable is unavailable");
      const port = await unusedLoopbackPort();
      const args = ["-m", artifact.path, "-c", String(job.contextTokens), "-np", "1", "-ngl", "auto"];
      const caps = recommendation.runtimes.llamaCpp.capabilities;
      if (caps?.fit) args.push("--fit", "on");
      if (caps?.fitTarget) args.push("--fit-target", "1024");
      if (candidate.cpuMoe && caps?.cpuMoe) args.push("--cpu-moe");
      if (caps?.cacheTypeK) args.push("--cache-type-k", kvType);
      if (caps?.cacheTypeV) args.push("--cache-type-v", kvType);
      args.push("--host", "127.0.0.1", "--port", String(port));
      child = spawn(serverPath, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      active.child = child;
      let outputBytes = 0;
      const boundOutput = (chunk: Buffer) => { outputBytes += chunk.length; if (outputBytes > 1_000_000) child?.stdout?.destroy(); };
      child.stdout?.on("data", boundOutput);
      child.stderr?.on("data", boundOutput);
      baseUrl = `http://127.0.0.1:${port}`;
      loadMs = await waitForEndpoint(baseUrl, active);
      const modelsResponse = await fetch(`${baseUrl}/v1/models`, { signal: AbortSignal.timeout(5000) });
      const modelsJson = await modelsResponse.json() as { data?: Array<{ id?: string }> };
      modelId = modelsJson.data?.[0]?.id || candidate.displayName;
      calibrationKey = localCalibrationKey({
        artifact,
        runtime: recommendation.runtimes.llamaCpp,
        hardware: recommendation.hardware,
        contextTokens: job.contextTokens,
        kvType,
      });
      runtime = "llama.cpp";
      runtimeVersion = recommendation.runtimes.llamaCpp.version;
    } else {
      if (!candidate.ollamaTag || !recommendation.runtimes.ollama.serviceUp) throw new Error("Ollama is not running");
      baseUrl = recommendation.runtimes.ollama.endpoint.replace(/\/+$/, "");
      modelId = candidate.ollamaTag;
      ollamaUnload = { endpoint: baseUrl, tag: candidate.ollamaTag };
      calibrationKey = ollamaCalibrationKey({
        tag: candidate.ollamaTag,
        sizeBytes: candidate.sizeBytes ?? 0,
        runtime: recommendation.runtimes.ollama,
        hardware: recommendation.hardware,
        contextTokens: job.contextTokens,
      });
      runtime = "ollama";
      runtimeVersion = recommendation.runtimes.ollama.version;
    }

    updateJob(job, { status: "running" });
    const measured = await measureOpenAiEndpoint({
      baseUrl,
      modelId,
      active,
      processId: child?.pid,
      testTools: candidate.capabilities.includes("tools"),
    });
    const metrics: CalibrationMetrics = { loadMs, ...measured };
    if (!metrics.endpointCorrect) throw new Error("The benchmark endpoint did not return streamed text");
    saveCalibration({
      key: calibrationKey,
      candidateId: candidate.modelId,
      runtime,
      runtimeVersion,
      contextTokens: job.contextTokens,
      kvType,
      metrics,
      measuredAt: new Date().toISOString(),
    });
    updateJob(job, { status: "completed", metrics });
  } catch (error) {
    updateJob(job, {
      status: active.cancelled ? "cancelled" : "failed",
      error: active.cancelled ? "Benchmark cancelled" : String(error),
    });
  } finally {
    terminateProcessTree(child);
    if (ollamaUnload) {
      try {
        await fetch(`${ollamaUnload.endpoint}/api/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: ollamaUnload.tag, keep_alive: 0 }),
          signal: AbortSignal.timeout(5000),
        });
      } catch {
        // Calibration remains valid; unload is best-effort cleanup.
      }
    }
    activeJobs.delete(job.id);
  }
}

export function startBenchmark(input: {
  candidateId: string;
  contextTokens: number;
  confirmed: boolean;
}): BenchmarkJob {
  if (!input.confirmed) throw new Error("Benchmark resource-use confirmation is required");
  if (activeJobs.size >= 1) throw new Error("Another local-model benchmark is already running");
  const contextTokens = Math.min(262144, Math.max(512, Math.floor(input.contextTokens || 8192)));
  const now = new Date().toISOString();
  const job: BenchmarkJob = {
    id: nanoid(12),
    candidateId: String(input.candidateId || "").trim(),
    status: "queued",
    contextTokens,
    metrics: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  };
  if (!job.candidateId) throw new Error("Candidate id is required");
  persist(job);
  activeJobs.set(job.id, { cancelled: false, child: null });
  void executeBenchmark(job);
  return job;
}

export function cancelBenchmark(id: string): BenchmarkJob | null {
  const job = getBenchmarkJob(id);
  if (!job) return null;
  const active = activeJobs.get(id);
  if (active) {
    active.cancelled = true;
    terminateProcessTree(active.child);
  }
  if (!["completed", "failed", "cancelled"].includes(job.status)) {
    updateJob(job, { status: "cancelled", error: "Benchmark cancelled" });
  }
  return job;
}
