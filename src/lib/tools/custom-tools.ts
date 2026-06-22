import type Database from "better-sqlite3";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { sanitizeHostExecEnv } from "@/lib/security/host-env";

const execFileAsync = promisify(execFile);

export type CustomToolType = "bash" | "javascript";
export type CustomToolWrapperMode = "manual" | "generated";
export type CustomToolOutputMode = "text" | "json";
export type CustomToolValidationStatus = "untested" | "passed" | "failed";

export type JsonRecord = Record<string, unknown>;

export interface CustomToolRow {
  id: string;
  name: string;
  description: string;
  type: string;
  code: string;
  parameters: string;
  is_active: number;
  created_at: string;
  updated_at: string;
  wrapper_mode?: string | null;
  command_template?: string | null;
  output_mode?: string | null;
  output_schema?: string | null;
  sample_args?: string | null;
  validation_status?: string | null;
  validation_error?: string | null;
  last_validated_at?: string | null;
  last_output_preview?: string | null;
}

export interface CustomToolRecord {
  id: string;
  name: string;
  description: string;
  type: CustomToolType;
  code: string;
  parameters: JsonRecord;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  wrapperMode: CustomToolWrapperMode;
  commandTemplate: string | null;
  outputMode: CustomToolOutputMode;
  outputSchema: JsonRecord | null;
  sampleArgs: JsonRecord | null;
  validationStatus: CustomToolValidationStatus;
  validationError: string | null;
  lastValidatedAt: string | null;
  lastOutputPreview: string | null;
}

export interface CustomToolDraft {
  name: string;
  description: string;
  type: CustomToolType;
  code: string;
  parameters: JsonRecord;
  wrapperMode: CustomToolWrapperMode;
  commandTemplate: string | null;
  outputMode: CustomToolOutputMode;
  outputSchema: JsonRecord | null;
  sampleArgs: JsonRecord | null;
}

export interface CustomToolPreviewResult {
  ok: boolean;
  output: string;
  parsedJson: unknown | null;
  validationStatus: CustomToolValidationStatus;
  validationError: string | null;
}

const CUSTOM_TOOL_COLUMNS: Array<{ name: string; sql: string }> = [
  { name: "wrapper_mode", sql: "ALTER TABLE custom_tools ADD COLUMN wrapper_mode TEXT NOT NULL DEFAULT 'manual'" },
  { name: "command_template", sql: "ALTER TABLE custom_tools ADD COLUMN command_template TEXT" },
  { name: "output_mode", sql: "ALTER TABLE custom_tools ADD COLUMN output_mode TEXT NOT NULL DEFAULT 'text'" },
  { name: "output_schema", sql: "ALTER TABLE custom_tools ADD COLUMN output_schema TEXT" },
  { name: "sample_args", sql: "ALTER TABLE custom_tools ADD COLUMN sample_args TEXT" },
  { name: "validation_status", sql: "ALTER TABLE custom_tools ADD COLUMN validation_status TEXT NOT NULL DEFAULT 'untested'" },
  { name: "validation_error", sql: "ALTER TABLE custom_tools ADD COLUMN validation_error TEXT" },
  { name: "last_validated_at", sql: "ALTER TABLE custom_tools ADD COLUMN last_validated_at TEXT" },
  { name: "last_output_preview", sql: "ALTER TABLE custom_tools ADD COLUMN last_output_preview TEXT" },
];

export function ensureCustomToolsTable(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_tools (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'bash',
      code TEXT NOT NULL,
      parameters TEXT NOT NULL DEFAULT '{}',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  const existing = new Set(
    (
      db.prepare("PRAGMA table_info(custom_tools)").all() as Array<{ name: string }>
    ).map((column) => column.name),
  );
  for (const column of CUSTOM_TOOL_COLUMNS) {
    if (!existing.has(column.name)) {
      db.exec(column.sql);
    }
  }

  return db;
}

function parseJsonValue(value: string | null | undefined, fallback: JsonRecord | null = null): JsonRecord | null {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as JsonRecord)
      : fallback;
  } catch {
    return fallback;
  }
}

function parseStatus(value: string | null | undefined): CustomToolValidationStatus {
  return value === "passed" || value === "failed" ? value : "untested";
}

function parseWrapperMode(value: string | null | undefined): CustomToolWrapperMode {
  return value === "generated" ? "generated" : "manual";
}

function parseOutputMode(value: string | null | undefined): CustomToolOutputMode {
  return value === "json" ? "json" : "text";
}

export function rowToCustomTool(row: CustomToolRow): CustomToolRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    type: row.type === "javascript" ? "javascript" : "bash",
    code: row.code,
    parameters: parseJsonValue(row.parameters, {}) ?? {},
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    wrapperMode: parseWrapperMode(row.wrapper_mode),
    commandTemplate: row.command_template ?? null,
    outputMode: parseOutputMode(row.output_mode),
    outputSchema: parseJsonValue(row.output_schema, null),
    sampleArgs: parseJsonValue(row.sample_args, null),
    validationStatus: parseStatus(row.validation_status),
    validationError: row.validation_error ?? null,
    lastValidatedAt: row.last_validated_at ?? null,
    lastOutputPreview: row.last_output_preview ?? null,
  };
}

export function buildStoredCustomToolCode(input: {
  wrapperMode: CustomToolWrapperMode;
  code?: string | null;
  commandTemplate?: string | null;
}): string {
  if (input.wrapperMode === "generated") {
    return String(input.commandTemplate || "").trim();
  }
  return String(input.code || "").trim();
}

export function hasCustomToolOutputSchema(schema: JsonRecord | null | undefined): boolean {
  return Boolean(schema && Object.keys(schema).length > 0);
}

export function customToolRequiresValidation(tool: {
  wrapperMode: CustomToolWrapperMode;
  outputMode: CustomToolOutputMode;
  outputSchema?: JsonRecord | null;
}): boolean {
  return tool.wrapperMode === "generated" || tool.outputMode === "json";
}

export function renderCustomBashCommand(template: string, args: Record<string, unknown>, argsJson: string): string {
  let command = template;
  for (const [key, value] of Object.entries(args)) {
    const escaped = "'" + String(value).replace(/'/g, "'\\''") + "'";
    command = command.replace(
      new RegExp(`\\{\\{args\\.${key}\\}\\}`, "g"),
      escaped,
    );
  }
  const escapedJson = "'" + argsJson.replace(/'/g, "'\\''") + "'";
  command = command.replace(/\{\{args_json\}\}/g, escapedJson);
  return command;
}

function normalizePreviewText(output: string): string {
  const trimmed = output.trim();
  if (!trimmed) return "(empty output)";
  return trimmed.slice(0, 2000);
}

function extractJsonCandidate(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("```") && trimmed.endsWith("```")) {
    const withoutFence = trimmed.replace(/^```[a-zA-Z0-9_-]*\n?/, "").replace(/\n?```$/, "");
    return withoutFence.trim();
  }
  return trimmed;
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function valueMatchesSchemaType(value: unknown, expected: string): boolean {
  switch (expected) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return isJsonRecord(value);
    case "array":
      return Array.isArray(value);
    case "null":
      return value === null;
    default:
      return true;
  }
}

function appendSchemaErrors(errors: string[], value: unknown, schema: JsonRecord, path: string) {
  const expectedType = schema.type;
  const allowedTypes = Array.isArray(expectedType)
    ? expectedType.filter((item): item is string => typeof item === "string")
    : typeof expectedType === "string"
      ? [expectedType]
      : [];

  if (allowedTypes.length > 0 && !allowedTypes.some((type) => valueMatchesSchemaType(value, type))) {
    errors.push(`${path} should be ${allowedTypes.join(" or ")}`);
    return;
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((item) => Object.is(item, value))) {
    errors.push(`${path} must be one of ${schema.enum.map((item) => JSON.stringify(item)).join(", ")}`);
  }

  if (isJsonRecord(value)) {
    const properties = isJsonRecord(schema.properties) ? (schema.properties as Record<string, JsonRecord>) : null;
    const required = Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === "string")
      : [];
    for (const key of required) {
      if (!(key in value)) {
        errors.push(`${path}.${key} is required`);
      }
    }
    if (properties) {
      for (const [key, childSchema] of Object.entries(properties)) {
        if (!(key in value)) continue;
        if (isJsonRecord(childSchema)) {
          appendSchemaErrors(errors, value[key], childSchema, `${path}.${key}`);
        }
      }
    }
    if (schema.additionalProperties === false && properties) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) {
          errors.push(`${path}.${key} is not allowed`);
        }
      }
    }
    return;
  }

  if (Array.isArray(value) && isJsonRecord(schema.items)) {
    value.forEach((item, index) => appendSchemaErrors(errors, item, schema.items as JsonRecord, `${path}[${index}]`));
  }
}

export function validateCustomToolOutput(
  rawOutput: string,
  outputMode: CustomToolOutputMode,
  outputSchema: JsonRecord | null,
): CustomToolPreviewResult {
  const normalizedOutput = normalizePreviewText(rawOutput);
  if (outputMode !== "json") {
    return {
      ok: true,
      output: normalizedOutput,
      parsedJson: null,
      validationStatus: outputSchema ? "passed" : "untested",
      validationError: null,
    };
  }

  try {
    const parsedJson = JSON.parse(extractJsonCandidate(rawOutput)) as unknown;
    const errors: string[] = [];
    if (outputSchema) {
      appendSchemaErrors(errors, parsedJson, outputSchema, "$");
    }
    if (errors.length > 0) {
      return {
        ok: false,
        output: normalizedOutput,
        parsedJson,
        validationStatus: "failed",
        validationError: errors.join("; "),
      };
    }
    return {
      ok: true,
      output: JSON.stringify(parsedJson, null, 2),
      parsedJson,
      validationStatus: "passed",
      validationError: null,
    };
  } catch (error) {
    return {
      ok: false,
      output: normalizedOutput,
      parsedJson: null,
      validationStatus: "failed",
      validationError: `Invalid JSON output: ${String(error)}`,
    };
  }
}

export async function runCustomToolPreview(
  tool: Pick<CustomToolDraft, "type" | "code" | "wrapperMode" | "commandTemplate" | "outputMode" | "outputSchema">,
  args: JsonRecord,
): Promise<CustomToolPreviewResult> {
  const argsJson = JSON.stringify(args, null, 2);
  const code = buildStoredCustomToolCode(tool);

  if (tool.type === "javascript") {
    const vm = await import("node:vm");
    const sandbox: Record<string, unknown> = {
      args,
      argsJson,
      console: { log: (...items: unknown[]) => void items, error: (...items: unknown[]) => void items },
      output: "",
      JSON,
      Math,
      Date,
      String,
      Number,
      Boolean,
      Array,
      Object,
    };
    const context = vm.createContext(sandbox);
    try {
      const script = new vm.Script(`(function(args) { ${code} })(args)`);
      const result = script.runInContext(context, { timeout: 10000 });
      const rawOutput = sandbox.output !== "" ? String(sandbox.output) : result !== undefined ? JSON.stringify(result, null, 2) : "(no output)";
      return validateCustomToolOutput(rawOutput, tool.outputMode, tool.outputSchema ?? null);
    } catch (error) {
      return {
        ok: false,
        output: "",
        parsedJson: null,
        validationStatus: "failed",
        validationError: String(error),
      };
    }
  }

  try {
    const command = renderCustomBashCommand(code, args, argsJson);
    const env = sanitizeHostExecEnv() as NodeJS.ProcessEnv;
    if (process.platform === "win32") {
      const { stdout, stderr } = await execFileAsync(
        "cmd.exe",
        ["/d", "/s", "/c", command],
        { timeout: 30000, maxBuffer: 512 * 1024, windowsHide: true, env },
      );
      return validateCustomToolOutput((stdout + (stderr ? `\nSTDERR:\n${stderr}` : "")).trim(), tool.outputMode, tool.outputSchema ?? null);
    }
    const { stdout, stderr } = await execFileAsync(
      "bash",
      ["-c", command],
      { timeout: 30000, maxBuffer: 512 * 1024, env },
    );
    return validateCustomToolOutput((stdout + (stderr ? `\nSTDERR:\n${stderr}` : "")).trim(), tool.outputMode, tool.outputSchema ?? null);
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string; code?: unknown };
    return {
      ok: false,
      output: [err.stdout?.trim(), err.stderr?.trim()].filter(Boolean).join("\n"),
      parsedJson: null,
      validationStatus: "failed",
      validationError: [`Exit code: ${String(err.code ?? "?")}`, err.message].filter(Boolean).join(" :: "),
    };
  }
}
