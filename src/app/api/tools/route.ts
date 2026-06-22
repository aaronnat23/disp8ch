import { NextRequest, NextResponse } from "next/server";
import { getSqlite } from "@/lib/db";
import {
  TOOL_CATALOG,
  listToolKnowledgeDocs,
  resolveRuntimeToolAvailability,
  searchToolKnowledgeDocs,
} from "@/lib/engine/tools";
import { z } from "zod";
import crypto from "node:crypto";
import { readCappedJson, RequestBodyTooLargeError } from "@/lib/security/body";
import { requireOperatorAccess } from "@/lib/security/admin";
import { getAgentById } from "@/lib/agents/registry";
import {
  buildStoredCustomToolCode,
  customToolRequiresValidation,
  ensureCustomToolsTable,
  rowToCustomTool,
  runCustomToolPreview,
  type CustomToolRow,
  type CustomToolValidationStatus,
} from "@/lib/tools/custom-tools";

// ── Schema helpers ─────────────────────────────────────────────────────────────
function getCustomToolDb() {
  return ensureCustomToolsTable(getSqlite());
}

// ── GET /api/tools ─────────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const action = request.nextUrl.searchParams.get("action");
    if (action === "knowledge-search") {
      const query = String(request.nextUrl.searchParams.get("query") || "").trim();
      const limit = Math.max(1, Math.min(8, Number(request.nextUrl.searchParams.get("limit")) || 5));
      if (!query) {
        return NextResponse.json({ success: false, error: "query required" }, { status: 400 });
      }
      return NextResponse.json({ success: true, data: await searchToolKnowledgeDocs(query, limit) });
    }
    if (action === "knowledge-list") {
      return NextResponse.json({ success: true, data: await listToolKnowledgeDocs() });
    }
    if (action === "runtime") {
      const agentId = String(request.nextUrl.searchParams.get("agentId") || "").trim();
      const enabledTools = String(request.nextUrl.searchParams.get("enabledTools") || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      const disabledTools = String(request.nextUrl.searchParams.get("disabledTools") || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      const enabledToolsets = String(request.nextUrl.searchParams.get("toolsets") || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      const approvalModeRaw = String(request.nextUrl.searchParams.get("approvalMode") || "").trim();
      const approvalMode =
        approvalModeRaw === "off" || approvalModeRaw === "model" || approvalModeRaw === "human"
          ? approvalModeRaw
          : undefined;
      const agent = agentId ? getAgentById(agentId) : null;
      const runtime = resolveRuntimeToolAvailability({
        enabledToolNames: enabledTools,
        disabledToolNames: [...(agent?.disabledTools ?? []), ...disabledTools],
        enabledToolsets: agent?.enabledToolsets?.length ? agent.enabledToolsets : enabledToolsets,
        toolPolicy: approvalMode ? { approvalMode } : undefined,
      });
      return NextResponse.json({
        success: true,
        data: {
          ...runtime,
          agentId: agent?.id ?? null,
        },
      });
    }
    const db = getCustomToolDb();
    const rows = db.prepare("SELECT * FROM custom_tools ORDER BY created_at DESC").all() as CustomToolRow[];
    return NextResponse.json({ success: true, data: rows.map(rowToCustomTool) });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

// ── POST /api/tools ────────────────────────────────────────────────────────────

const BaseCreateSchema = z.object({
  name: z.string().min(1).max(64).regex(/^[a-z_][a-z0-9_]*$/, "Name must be lowercase with underscores (snake_case)"),
  description: z.string().min(1).max(500),
  type: z.enum(["bash", "javascript"]),
  code: z.string().max(100000).optional(),
  parameters: z.record(z.unknown()).optional(),
  wrapperMode: z.enum(["manual", "generated"]).optional(),
  commandTemplate: z.string().max(100000).optional().nullable(),
  outputMode: z.enum(["text", "json"]).optional(),
  outputSchema: z.record(z.unknown()).optional().nullable(),
  sampleArgs: z.record(z.unknown()).optional().nullable(),
  isActive: z.boolean().optional(),
});

const CreateSchema = BaseCreateSchema.superRefine((value, ctx) => {
  const wrapperMode = value.wrapperMode ?? "manual";
  if (wrapperMode === "generated") {
    if (value.type !== "bash") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["type"],
        message: "Generated wrappers currently support bash tools only",
      });
    }
    if (!String(value.commandTemplate || "").trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["commandTemplate"],
        message: "Command template is required for generated wrappers",
      });
    }
  } else if (!String(value.code || "").trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["code"],
      message: "Code is required for manual tools",
    });
  }
});

export async function POST(req: NextRequest) {
  try {
    const denied = await requireOperatorAccess(req);
    if (denied) return denied;
    const body = await readCappedJson<unknown>(req, 64 * 1024);
    const parsed = CreateSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ success: false, error: parsed.error.message }, { status: 400 });
    }

    const {
      name,
      description,
      type,
      code,
      parameters,
      wrapperMode = "manual",
      commandTemplate = null,
      outputMode = "text",
      outputSchema = null,
      sampleArgs = null,
      isActive,
    } = parsed.data;

    // Prevent shadowing built-in tools
    if (TOOL_CATALOG[name]) {
      return NextResponse.json(
        { success: false, error: `"${name}" is a built-in tool and cannot be overridden. Choose a different name.` },
        { status: 409 }
      );
    }

    const db = getCustomToolDb();
    const id = `ctool_${crypto.randomBytes(6).toString("hex")}`;
    const now = new Date().toISOString();
    const storedCode = buildStoredCustomToolCode({ wrapperMode, code, commandTemplate });
    let validationStatus: CustomToolValidationStatus = "untested";
    let validationError: string | null = null;
    let lastValidatedAt: string | null = null;
    let lastOutputPreview: string | null = null;

    if (sampleArgs && customToolRequiresValidation({ wrapperMode, outputMode, outputSchema })) {
      const preview = await runCustomToolPreview(
        {
          type,
          code: storedCode,
          wrapperMode,
          commandTemplate,
          outputMode,
          outputSchema,
        },
        sampleArgs,
      );
      validationStatus = preview.validationStatus;
      validationError = preview.validationError;
      lastValidatedAt = now;
      lastOutputPreview = preview.output.slice(0, 2000);
    }

    const nextIsActive = isActive !== undefined
      ? isActive
      : customToolRequiresValidation({ wrapperMode, outputMode, outputSchema })
        ? validationStatus === "passed"
        : true;

    if (nextIsActive && customToolRequiresValidation({ wrapperMode, outputMode, outputSchema }) && validationStatus !== "passed") {
      return NextResponse.json(
        {
          success: false,
          error: "Wrapper tools must pass a sample test run before they can be enabled for agents.",
        },
        { status: 409 },
      );
    }

    db.prepare(`
      INSERT INTO custom_tools (
        id, name, description, type, code, parameters, is_active, created_at, updated_at,
        wrapper_mode, command_template, output_mode, output_schema, sample_args,
        validation_status, validation_error, last_validated_at, last_output_preview
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      name,
      description,
      type,
      storedCode,
      JSON.stringify(parameters ?? {}),
      nextIsActive ? 1 : 0,
      now,
      now,
      wrapperMode,
      commandTemplate,
      outputMode,
      outputSchema ? JSON.stringify(outputSchema) : null,
      sampleArgs ? JSON.stringify(sampleArgs) : null,
      validationStatus,
      validationError,
      lastValidatedAt,
      lastOutputPreview,
    );

    const row = db.prepare("SELECT * FROM custom_tools WHERE id = ?").get(id) as CustomToolRow;
    return NextResponse.json({ success: true, data: rowToCustomTool(row) }, { status: 201 });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 413 });
    }
    const msg = String(error);
    if (msg.includes("UNIQUE constraint")) {
      return NextResponse.json({ success: false, error: "A tool with that name already exists" }, { status: 409 });
    }
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

// ── PUT /api/tools?id=xxx ──────────────────────────────────────────────────────

const BaseUpdateSchema = z.object({
  description: z.string().min(1).max(500).optional(),
  type: z.enum(["bash", "javascript"]).optional(),
  code: z.string().max(100000).optional(),
  parameters: z.record(z.unknown()).optional(),
  isActive: z.boolean().optional(),
  wrapperMode: z.enum(["manual", "generated"]).optional(),
  commandTemplate: z.string().max(100000).optional().nullable(),
  outputMode: z.enum(["text", "json"]).optional(),
  outputSchema: z.record(z.unknown()).optional().nullable(),
  sampleArgs: z.record(z.unknown()).optional().nullable(),
});

const UpdateSchema = BaseUpdateSchema.superRefine((value, ctx) => {
  if (value.wrapperMode === "generated" && value.type === "javascript") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["type"],
      message: "Generated wrappers currently support bash tools only",
    });
  }
});

export async function PUT(req: NextRequest) {
  try {
    const denied = await requireOperatorAccess(req);
    if (denied) return denied;
    const id = req.nextUrl.searchParams.get("id");
    if (!id) return NextResponse.json({ success: false, error: "id required" }, { status: 400 });

    const body = await readCappedJson<unknown>(req, 64 * 1024);
    const parsed = UpdateSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ success: false, error: parsed.error.message }, { status: 400 });
    }

    const db = getCustomToolDb();
    const existing = db.prepare("SELECT * FROM custom_tools WHERE id = ?").get(id) as CustomToolRow | undefined;
    if (!existing) return NextResponse.json({ success: false, error: "Tool not found" }, { status: 404 });

    const now = new Date().toISOString();
    const current = rowToCustomTool(existing);
    const {
      description,
      type,
      code,
      parameters,
      isActive,
      wrapperMode,
      commandTemplate,
      outputMode,
      outputSchema,
      sampleArgs,
    } = parsed.data;
    const nextWrapperMode = wrapperMode ?? current.wrapperMode;
    const nextType = type ?? current.type;
    if (nextWrapperMode === "generated" && nextType !== "bash") {
      return NextResponse.json({ success: false, error: "Generated wrappers currently support bash tools only" }, { status: 400 });
    }
    const nextCommandTemplate = commandTemplate !== undefined ? commandTemplate : current.commandTemplate;
    const nextCode = buildStoredCustomToolCode({
      wrapperMode: nextWrapperMode,
      code: code ?? current.code,
      commandTemplate: nextCommandTemplate,
    });
    if (!nextCode) {
      return NextResponse.json({ success: false, error: "Tool code is required" }, { status: 400 });
    }

    const nextOutputMode = outputMode ?? current.outputMode;
    const nextOutputSchema = outputSchema !== undefined ? outputSchema : current.outputSchema;
    const nextSampleArgs = sampleArgs !== undefined ? sampleArgs : current.sampleArgs;

    const definitionChanged =
      description !== undefined ||
      type !== undefined ||
      code !== undefined ||
      parameters !== undefined ||
      wrapperMode !== undefined ||
      commandTemplate !== undefined ||
      outputMode !== undefined ||
      outputSchema !== undefined ||
      sampleArgs !== undefined;

    const nextRequiresValidation = customToolRequiresValidation({
      wrapperMode: nextWrapperMode,
      outputMode: nextOutputMode,
      outputSchema: nextOutputSchema,
    });
    const nextValidationStatus = definitionChanged && nextRequiresValidation ? "untested" : current.validationStatus;
    const nextValidationError = definitionChanged && nextRequiresValidation ? "Re-test required after editing this tool." : current.validationError;
    const nextLastValidatedAt = definitionChanged && nextRequiresValidation ? null : current.lastValidatedAt;
    const nextLastOutputPreview = definitionChanged && nextRequiresValidation ? null : current.lastOutputPreview;

    if ((isActive ?? current.isActive) && nextRequiresValidation && nextValidationStatus !== "passed") {
      return NextResponse.json(
        {
          success: false,
          error: "Wrapper tools must pass a sample test run before they can be enabled for agents.",
        },
        { status: 409 },
      );
    }

    db.prepare(`
      UPDATE custom_tools SET
        description = ?,
        type = ?,
        code = ?,
        parameters = ?,
        is_active = ?,
        updated_at = ?,
        wrapper_mode = ?,
        command_template = ?,
        output_mode = ?,
        output_schema = ?,
        sample_args = ?,
        validation_status = ?,
        validation_error = ?,
        last_validated_at = ?,
        last_output_preview = ?
      WHERE id = ?
    `).run(
      description ?? current.description,
      nextType,
      nextCode,
      parameters !== undefined ? JSON.stringify(parameters) : JSON.stringify(current.parameters),
      isActive !== undefined ? (isActive ? 1 : 0) : existing.is_active,
      now,
      nextWrapperMode,
      nextCommandTemplate,
      nextOutputMode,
      nextOutputSchema ? JSON.stringify(nextOutputSchema) : null,
      nextSampleArgs ? JSON.stringify(nextSampleArgs) : null,
      nextValidationStatus,
      nextValidationError,
      nextLastValidatedAt,
      nextLastOutputPreview,
      id,
    );

    const row = db.prepare("SELECT * FROM custom_tools WHERE id = ?").get(id) as CustomToolRow;
    return NextResponse.json({ success: true, data: rowToCustomTool(row) });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 413 });
    }
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

// ── DELETE /api/tools?id=xxx ───────────────────────────────────────────────────

export async function DELETE(req: NextRequest) {
  try {
    const denied = await requireOperatorAccess(req);
    if (denied) return denied;
    const id = req.nextUrl.searchParams.get("id");
    if (!id) return NextResponse.json({ success: false, error: "id required" }, { status: 400 });

    const db = getCustomToolDb();
    db.prepare("DELETE FROM custom_tools WHERE id = ?").run(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
