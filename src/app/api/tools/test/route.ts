import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSqlite } from "@/lib/db";
import { readCappedJson, RequestBodyTooLargeError } from "@/lib/security/body";
import { requireOperatorAccess } from "@/lib/security/admin";
import {
  buildStoredCustomToolCode,
  ensureCustomToolsTable,
  rowToCustomTool,
  runCustomToolPreview,
  type CustomToolRow,
} from "@/lib/tools/custom-tools";

const DraftSchema = z.object({
  type: z.enum(["bash", "javascript"]),
  code: z.string().max(100000).optional(),
  wrapperMode: z.enum(["manual", "generated"]).optional(),
  commandTemplate: z.string().max(100000).optional().nullable(),
  outputMode: z.enum(["text", "json"]).optional(),
  outputSchema: z.record(z.unknown()).optional().nullable(),
});

const TestSchema = z.object({
  id: z.string().min(1).optional(),
  args: z.record(z.unknown()).optional(),
  draft: DraftSchema.optional(),
}).superRefine((value, ctx) => {
  if (!value.id && !value.draft) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["draft"],
      message: "Provide either an existing tool id or a draft tool definition",
    });
  }
});

export async function POST(req: NextRequest) {
  try {
    const denied = await requireOperatorAccess(req);
    if (denied) return denied;
    const body = await readCappedJson<unknown>(req, 64 * 1024);
    const parsed = TestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ success: false, error: parsed.error.message }, { status: 400 });
    }

    const db = ensureCustomToolsTable(getSqlite());
    const args = parsed.data.args ?? {};
    let tool:
      | {
          type: "bash" | "javascript";
          code: string;
          wrapperMode: "manual" | "generated";
          commandTemplate: string | null;
          outputMode: "text" | "json";
          outputSchema: Record<string, unknown> | null;
        }
      | null = null;
    let toolId: string | null = null;

    if (parsed.data.id) {
      const row = db.prepare("SELECT * FROM custom_tools WHERE id = ?").get(parsed.data.id) as CustomToolRow | undefined;
      if (!row) {
        return NextResponse.json({ success: false, error: "Tool not found" }, { status: 404 });
      }
      const current = rowToCustomTool(row);
      toolId = current.id;
      tool = {
        type: current.type,
        code: current.code,
        wrapperMode: current.wrapperMode,
        commandTemplate: current.commandTemplate,
        outputMode: current.outputMode,
        outputSchema: current.outputSchema,
      };
    } else if (parsed.data.draft) {
      const draft = parsed.data.draft;
      const wrapperMode = draft.wrapperMode ?? "manual";
      tool = {
        type: draft.type,
        code: buildStoredCustomToolCode({
          wrapperMode,
          code: draft.code,
          commandTemplate: draft.commandTemplate,
        }),
        wrapperMode,
        commandTemplate: draft.commandTemplate ?? null,
        outputMode: draft.outputMode ?? "text",
        outputSchema: draft.outputSchema ?? null,
      };
    }

    if (!tool || !tool.code) {
      return NextResponse.json({ success: false, error: "Tool code is required" }, { status: 400 });
    }

    const preview = await runCustomToolPreview(tool, args);
    if (toolId) {
      const now = new Date().toISOString();
      db.prepare(`
        UPDATE custom_tools
        SET validation_status = ?, validation_error = ?, last_validated_at = ?, last_output_preview = ?, updated_at = ?
        WHERE id = ?
      `).run(
        preview.validationStatus,
        preview.validationError,
        now,
        preview.output.slice(0, 2000),
        now,
        toolId,
      );
    }

    return NextResponse.json({
      success: true,
      data: preview,
    });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 413 });
    }
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
