import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { initializeDatabase } from "@/lib/db";
import {
  createAgentTool,
  deleteAgentTool,
  listAgentTools,
  updateAgentTool,
  validateAgentToolSchema,
} from "@/lib/workflows/agent-tools";
import { requireOperatorAccess } from "@/lib/security/admin";
import { readCappedJson, RequestBodyTooLargeError } from "@/lib/security/body";
import { sanitizeStructuredJson } from "@/lib/security/json";

const agentToolSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    workflowId: z.string().min(1).max(128),
    toolName: z.string().min(1).max(120).regex(/^[a-zA-Z0-9_-]+$/),
    description: z.string().min(1).max(1000),
    inputSchemaJson: z.string().min(2).max(32_000),
    outputSchemaJson: z.string().max(32_000).optional().nullable(),
    allowedAgentIdsJson: z.string().max(32_000).optional().nullable(),
    allowedOrganizationIdsJson: z.string().max(32_000).optional().nullable(),
    approvalPolicy: z.enum(["inherit", "none", "human", "read-only", "disabled"]).optional(),
  }),
  z.object({
    action: z.literal("update"),
    id: z.string().min(1).max(128),
    toolName: z.string().min(1).max(120).regex(/^[a-zA-Z0-9_-]+$/).optional(),
    description: z.string().min(1).max(1000).optional(),
    inputSchemaJson: z.string().min(2).max(32_000).optional(),
    outputSchemaJson: z.string().max(32_000).optional().nullable(),
    allowedAgentIdsJson: z.string().max(32_000).optional().nullable(),
    allowedOrganizationIdsJson: z.string().max(32_000).optional().nullable(),
    approvalPolicy: z.enum(["inherit", "none", "human", "read-only", "disabled"]).optional(),
    enabled: z.boolean().optional(),
  }),
  z.object({
    action: z.literal("delete"),
    id: z.string().min(1).max(128),
  }),
]);

export async function GET(request: NextRequest) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;

  try {
    initializeDatabase();
    const workflowId = new URL(request.url).searchParams.get("workflowId") || undefined;
    return NextResponse.json({ success: true, data: listAgentTools(workflowId) });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;

  try {
    initializeDatabase();
    const body = await readCappedJson<unknown>(request, 96 * 1024);
    const parsed = agentToolSchema.parse(sanitizeStructuredJson(body));
    if (parsed.action === "create") {
      const schemaCheck = validateAgentToolSchema(parsed.inputSchemaJson, parsed.outputSchemaJson ?? null);
      if (!schemaCheck.ok) {
        return NextResponse.json({ success: false, error: schemaCheck.error }, { status: 400 });
      }
      const tool = createAgentTool({
        workflowId: parsed.workflowId,
        toolName: parsed.toolName,
        description: parsed.description,
        inputSchemaJson: parsed.inputSchemaJson,
        outputSchemaJson: parsed.outputSchemaJson ?? null,
        allowedAgentIdsJson: parsed.allowedAgentIdsJson ?? null,
        allowedOrganizationIdsJson: parsed.allowedOrganizationIdsJson ?? null,
        approvalPolicy: parsed.approvalPolicy ?? "inherit",
      });
      return NextResponse.json({ success: true, data: tool });
    }
    if (parsed.action === "update") {
      const { action: _action, id, ...updates } = parsed;
      if (updates.inputSchemaJson !== undefined) {
        const schemaCheck = validateAgentToolSchema(updates.inputSchemaJson, updates.outputSchemaJson ?? null);
        if (!schemaCheck.ok) {
          return NextResponse.json({ success: false, error: schemaCheck.error }, { status: 400 });
        }
      }
      const tool = updateAgentTool(id, updates);
      if (!tool) {
        return NextResponse.json({ success: false, error: "Agent tool not found" }, { status: 404 });
      }
      return NextResponse.json({ success: true, data: tool });
    }
    deleteAgentTool(parsed.id);
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 413 });
    }
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
