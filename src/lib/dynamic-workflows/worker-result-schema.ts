import { z } from "zod";
import type { DynamicWorkflowWorkerResult } from "./types";

const findingSchema = z.object({
  claim: z.string().trim().min(1).max(4000),
  evidence: z.string().trim().max(8000).optional(),
  confidence: z.number().min(0).max(1).optional(),
}).strict();

const artifactSchema = z.object({
  type: z.string().trim().min(1).max(100),
  path: z.string().trim().max(2000).optional(),
  url: z.string().url().max(4000).optional(),
  label: z.string().trim().max(500).optional(),
}).strict();

const criterionEvaluationSchema = z.object({
  criterionId: z.string().trim().min(1).max(120),
  status: z.enum(["passed", "failed", "warning", "unverified"]),
  summary: z.string().trim().min(1).max(4000),
  evidence: z.string().trim().max(8000).optional(),
}).strict();

const workerResultSchema = z.object({
  status: z.enum(["completed", "failed"]),
  summary: z.string().trim().min(1).max(12000),
  findings: z.array(findingSchema).max(100).optional(),
  criterionEvaluations: z.array(criterionEvaluationSchema).max(100).optional(),
  changedFiles: z.array(z.string().trim().min(1).max(2000)).max(250).optional(),
  artifacts: z.array(artifactSchema).max(100).optional(),
  screenshots: z.array(z.string().trim().min(1).max(2000)).max(100).optional(),
  nextActions: z.array(z.string().trim().min(1).max(2000)).max(100).optional(),
}).strict();

function extractJsonObject(value: string): unknown {
  const trimmed = value.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1]?.trim();
  const candidate = fenced || trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const first = candidate.indexOf("{");
    const last = candidate.lastIndexOf("}");
    if (first >= 0 && last > first) {
      return JSON.parse(candidate.slice(first, last + 1));
    }
    throw new Error("Worker response did not contain a JSON object.");
  }
}

export function parseWorkerResult(value: unknown): DynamicWorkflowWorkerResult {
  const parsedInput = typeof value === "string" ? extractJsonObject(value) : value;
  const result = workerResultSchema.safeParse(parsedInput);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 8)
      .map((issue) => `${issue.path.join(".") || "result"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Worker returned invalid structured output: ${issues}`);
  }
  return result.data;
}

export const WORKER_RESULT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "summary"],
  properties: {
    status: { type: "string", enum: ["completed", "failed"] },
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["claim"],
        properties: {
          claim: { type: "string" },
          evidence: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
      },
    },
    criterionEvaluations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["criterionId", "status", "summary"],
        properties: {
          criterionId: { type: "string" },
          status: { type: "string", enum: ["passed", "failed", "warning", "unverified"] },
          summary: { type: "string" },
          evidence: { type: "string" },
        },
      },
    },
    changedFiles: { type: "array", items: { type: "string" } },
    artifacts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type"],
        properties: {
          type: { type: "string" },
          path: { type: "string" },
          url: { type: "string" },
          label: { type: "string" },
        },
      },
    },
    screenshots: { type: "array", items: { type: "string" } },
    nextActions: { type: "array", items: { type: "string" } },
  },
} as const;
