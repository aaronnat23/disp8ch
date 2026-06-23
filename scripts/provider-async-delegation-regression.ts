#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "disp8ch-provider-delegate-"));
  process.env.DATABASE_PATH = path.join(root, "disp8ch.db");
  process.env.DISP8CH_STANDING_GOAL_DAEMON = "0";

  let requestCount = 0;
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404).end();
      return;
    }
    requestCount += 1;
    req.resume();
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(`data: ${JSON.stringify({
      id: "chatcmpl-provider-delegation",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: "stub-current-model",
      choices: [{ index: 0, delta: { role: "assistant", content: "PROVIDER_DELEGATION_OK" }, finish_reason: null }],
    })}\n\n`);
    res.write(`data: ${JSON.stringify({
      id: "chatcmpl-provider-delegation",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: "stub-current-model",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
    })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to bind stub provider");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;

  try {
    const [{ initializeDatabase }, { executeTool }, { getBackgroundJob }] = await Promise.all([
      import("../src/lib/db"),
      import("../src/lib/engine/tools"),
      import("../src/lib/runtime/background-jobs"),
    ]);
    initializeDatabase();

    const startedAt = Date.now();
    const response = await executeTool(
      "sessions_spawn",
      {
        mode: "run",
        background: true,
        notify_on_complete: false,
        permission_mode: "deny-all",
        cwd: root,
        task: "Return the provider delegation sentinel.",
        timeout_seconds: 5,
      },
      {
        channelSessionId: `provider-delegate-${Date.now()}`,
        agentId: "test-agent",
        workspacePath: root,
        modelProvider: "openai-compatible",
        modelId: "stub-current-model",
        modelApiKey: "test-only-key",
        modelBaseUrl: baseUrl,
      },
      { approvalMode: "off", execSecurity: "deny", execAsk: "off" },
    );
    const dispatchMs = Date.now() - startedAt;
    const dispatch = JSON.parse(response) as {
      status?: string;
      delegation_id?: string;
      agent?: string;
      provider?: string;
      model?: string;
    };
    if (dispatch.status !== "dispatched" || !dispatch.delegation_id) {
      throw new Error(`Expected provider dispatch, got ${response}`);
    }
    if (dispatch.agent !== "current" || dispatch.provider !== "openai-compatible" || dispatch.model !== "stub-current-model") {
      throw new Error(`Expected active provider/model dispatch, got ${response}`);
    }
    const maxDispatchMs = process.env.GITHUB_ACTIONS ? 2500 : 1000;
    if (dispatchMs > maxDispatchMs) throw new Error(`Provider dispatch blocked for ${dispatchMs}ms`);

    let job = getBackgroundJob(dispatch.delegation_id);
    const maxCompletionPolls = process.env.GITHUB_ACTIONS ? 100 : 40;
    for (let i = 0; i < maxCompletionPolls && job?.status === "running"; i += 1) {
      await sleep(100);
      job = getBackgroundJob(dispatch.delegation_id);
    }
    if (!job || job.status !== "completed") {
      throw new Error(`Expected completed provider job, got ${JSON.stringify(job)}`);
    }
    if (!job.stdout.includes("PROVIDER_DELEGATION_OK")) {
      throw new Error(`Expected provider output, got ${job.stdout}`);
    }
    if (job.metadata?.kind !== "model-delegation" || job.metadata?.provider !== "openai-compatible") {
      throw new Error(`Expected model-delegation metadata, got ${JSON.stringify(job.metadata)}`);
    }
    if (JSON.stringify(job.metadata).includes("test-only-key")) {
      throw new Error("Provider API key leaked into background job metadata");
    }
    if (requestCount !== 1) throw new Error(`Expected one provider request, got ${requestCount}`);

    console.log(JSON.stringify({
      ok: true,
      dispatchMs,
      delegationId: dispatch.delegation_id,
      provider: dispatch.provider,
      model: dispatch.model,
      status: job.status,
      requestCount,
      apiKeyPersisted: false,
    }, null, 2));
    process.exitCode = 0;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
