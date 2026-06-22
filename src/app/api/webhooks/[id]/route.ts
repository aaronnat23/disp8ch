import { NextRequest, NextResponse } from "next/server";
import { getSqlite, initializeDatabase } from "@/lib/db";
import { executeWorkflow } from "@/lib/engine/executor";
import { getModelConfig } from "@/lib/agents/model-router";
import { checkRateLimit, getClientIp, getRateLimitConfig } from "@/lib/utils/rate-limit";
import { sanitizeStructuredJson } from "@/lib/security/json";
import { readCappedText, RequestBodyTooLargeError } from "@/lib/security/body";
import { consumeReplayNonce, isTimestampFresh, parseTimestampHeader } from "@/lib/security/replay";
import crypto from "node:crypto";
import type { ExecutionRecord } from "@/types/execution";
import type { WorkflowNode } from "@/types/workflow";

const WEBHOOK_MAX_BODY_BYTES = 256 * 1024;
const WEBHOOK_REPLAY_TTL_MS = 5 * 60 * 1000;
const WEBHOOK_EXECUTION_TIMEOUT_MS = Math.min(
  30_000,
  Math.max(100, Number(process.env.WEBHOOK_EXECUTION_TIMEOUT_MS || 30_000)),
);

type WorkflowWebhookResponse = {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
};

function findWorkflowWebhookResponse(result: ExecutionRecord, nodes: WorkflowNode[]): WorkflowWebhookResponse | null {
  const responseNodeIds = new Set(nodes.filter((node) => node.type === "webhook-response").map((node) => node.id));
  if (responseNodeIds.size === 0) return null;
  for (const [nodeId, nodeResult] of Object.entries(result.nodeResults || {})) {
    if (!responseNodeIds.has(nodeId)) continue;
    const response = (nodeResult.output || {}).webhookResponse as Partial<WorkflowWebhookResponse> | undefined;
    if (!response || typeof response !== "object") continue;
    const statusCode = Number(response.statusCode || 200);
    const headers = response.headers && typeof response.headers === "object" && !Array.isArray(response.headers)
      ? Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key, String(value)]))
      : {};
    return {
      statusCode: Number.isFinite(statusCode) ? Math.max(100, Math.min(599, Math.trunc(statusCode))) : 200,
      headers,
      body: response.body,
    };
  }
  return null;
}

function renderWorkflowWebhookResponse(response: WorkflowWebhookResponse): NextResponse {
  const headers = new Headers(response.headers);
  const body = response.body;
  if (body === undefined || body === null || response.statusCode === 204 || response.statusCode === 304) {
    return new NextResponse(null, { status: response.statusCode, headers });
  }
  if (typeof body === "string") {
    if (!headers.has("content-type")) headers.set("content-type", "text/plain; charset=utf-8");
    return new NextResponse(body, { status: response.statusCode, headers });
  }
  return NextResponse.json(body, { status: response.statusCode, headers });
}

function executionTimeout<T>(ms: number): Promise<T | "timeout"> {
  return new Promise((resolve) => setTimeout(() => resolve("timeout"), ms));
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const ip = getClientIp(request);
  const rl = checkRateLimit(`webhook:${ip}`, getRateLimitConfig().webhooks, 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } },
    );
  }

  try {
    initializeDatabase();
    const db = getSqlite();
    const webhookId = params.id;

    const webhook = db.prepare("SELECT * FROM webhooks WHERE id = ? AND is_active = 1").get(webhookId) as {
      id: string; workflow_id: string; name: string; secret: string;
    } | undefined;

    if (!webhook) {
      return NextResponse.json({ error: "Webhook not found" }, { status: 404 });
    }

    // Verify HMAC signature
    const signature = request.headers.get("x-webhook-signature");
    const timestampHeader = request.headers.get("x-webhook-timestamp");
    const nonceHeader = request.headers.get("x-webhook-nonce");
    const body = await readCappedText(request, WEBHOOK_MAX_BODY_BYTES);

    const signedPayload = timestampHeader ? `${timestampHeader}.${body}` : body;
    const expectedSig = crypto.createHmac("sha256", webhook.secret).update(signedPayload).digest("hex");

    const sigValid =
      signature !== null &&
      signature.length === expectedSig.length &&
      crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig));

    if (!sigValid) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }

    if (timestampHeader || nonceHeader) {
      const timestampMs = parseTimestampHeader(timestampHeader);
      if (!isTimestampFresh(timestampMs, WEBHOOK_REPLAY_TTL_MS)) {
        return NextResponse.json({ error: "Webhook timestamp expired or invalid" }, { status: 401 });
      }
      const nonce = String(nonceHeader || "").trim();
      if (!nonce) {
        return NextResponse.json({ error: "Missing webhook nonce" }, { status: 401 });
      }
      if (!consumeReplayNonce(`webhook:${webhook.id}`, nonce, WEBHOOK_REPLAY_TTL_MS)) {
        return NextResponse.json({ error: "Replay rejected" }, { status: 409 });
      }
    }

    const payload = sanitizeStructuredJson(JSON.parse(body));

    // Get workflow
    const workflow = db.prepare("SELECT * FROM workflows WHERE id = ?").get(webhook.workflow_id) as {
      id: string; nodes: string; edges: string;
    } | undefined;

    if (!workflow) {
      return NextResponse.json({ error: "Workflow not found" }, { status: 404 });
    }

    const modelConfig = getModelConfig();
    const nodes = JSON.parse(workflow.nodes) as WorkflowNode[];
    const edges = JSON.parse(workflow.edges);
    let executionId: string | null = null;
    const executionPromise = executeWorkflow({
      workflowId: workflow.id,
      nodes,
      edges,
      triggerType: "webhook",
      triggerData: {
        webhook: { id: webhook.id, name: webhook.name },
        headers: Object.fromEntries(request.headers.entries()),
        body: payload,
        query: sanitizeStructuredJson(Object.fromEntries(new URL(request.url).searchParams.entries())),
      },
      modelConfig,
      onExecutionStart: (id) => {
        executionId = id;
      },
    });
    void executionPromise.catch((error) => {
      console.error("[webhook] workflow execution failed after response boundary", error);
    });

    const result = await Promise.race([
      executionPromise,
      executionTimeout<ExecutionRecord>(WEBHOOK_EXECUTION_TIMEOUT_MS),
    ]);

    if (result === "timeout") {
      return NextResponse.json(
        {
          success: true,
          data: {
            accepted: true,
            status: "running",
            workflowId: workflow.id,
            executionId,
            pollUrl: `/api/workflows/executions?workflowId=${encodeURIComponent(workflow.id)}&limit=20`,
          },
        },
        { status: 202 },
      );
    }

    const workflowResponse = findWorkflowWebhookResponse(result, nodes);
    if (workflowResponse) {
      return renderWorkflowWebhookResponse(workflowResponse);
    }

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ error: error.message }, { status: 413 });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
