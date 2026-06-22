import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { nanoid } from "nanoid";
import { executeWorkflow } from "@/lib/engine/executor";
import { getModelConfig } from "@/lib/agents/model-router";
import { requireOperatorAccess } from "@/lib/security/admin";
import { readCappedJson, RequestBodyTooLargeError } from "@/lib/security/body";
import { sanitizeStructuredJson } from "@/lib/security/json";
import type { WorkflowNode } from "@/types/workflow";

const TESTABLE_NODE_TYPES = new Set([
  "http-request",
  "run-code",
  "read-file",
  "date-time",
  "channel-status",
  "document-tool",
  "workflow-template",
  "scheduler-job",
  "json-transform",
  "split-text",
  "regex-extract",
  "compare-text",
  "webhook-response",
]);

const testNodeSchema = z.object({
  workflowId: z.string().min(1).max(128),
  node: z.object({
    id: z.string().min(1).max(128),
    type: z.string().min(1).max(80),
    position: z.object({ x: z.number(), y: z.number() }).optional(),
    data: z.record(z.unknown()).optional(),
  }),
  triggerData: z.record(z.unknown()).optional(),
});

export async function POST(request: NextRequest) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;

  try {
    const body = await readCappedJson<unknown>(request, 128 * 1024);
    const parsed = testNodeSchema.parse(sanitizeStructuredJson(body));
    if (!TESTABLE_NODE_TYPES.has(parsed.node.type)) {
      return NextResponse.json(
        { success: false, error: `Node type "${parsed.node.type}" is not safe for one-click testing.` },
        { status: 400 },
      );
    }

    const triggerId = `test-${nanoid(6)}`;
    const node = {
      id: parsed.node.id,
      type: parsed.node.type,
      position: parsed.node.position ?? { x: 320, y: 120 },
      data: parsed.node.data ?? {},
    } as WorkflowNode;

    const result = await executeWorkflow({
      workflowId: parsed.workflowId,
      nodes: [
        { id: triggerId, type: "manual-trigger", position: { x: 0, y: 120 }, data: { label: "Test Trigger" } },
        node,
      ],
      edges: [{ id: `e-${triggerId}-${node.id}`, source: triggerId, target: node.id }],
      triggerType: "manual",
      triggerData: sanitizeStructuredJson(parsed.triggerData || { source: "test-node" }) as Record<string, unknown>,
      provenance: { source: "workflow-node-test", nodeId: node.id, nodeType: node.type },
      modelConfig: getModelConfig(),
      lane: "main",
    });

    return NextResponse.json({
      success: result.status === "completed",
      data: {
        executionId: result.id,
        status: result.status,
        nodeResult: result.nodeResults[node.id] ?? null,
        error: result.error,
      },
      error: result.status === "completed" ? undefined : result.error,
    });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 413 });
    }
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
