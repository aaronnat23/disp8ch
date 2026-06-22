import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { initializeDatabase, getSqlite } from "@/lib/db";
import { requireOperatorAccess } from "@/lib/security/admin";

export const dynamic = "force-dynamic";

type Artifact = {
  id: string;
  kind: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  path: string | null;
  createdAt: string;
  source: string;
  previewText?: string | null;
  status?: string | null;
  workflowId?: string | null;
  executionId?: string | null;
  previewUrl?: string | null;
  href?: string | null;
  metadata?: Record<string, string | number | boolean | null>;
};

function readJsonSafe(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function guessMime(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".json") return "application/json";
  if (ext === ".md" || ext === ".markdown") return "text/markdown";
  if (ext === ".csv") return "text/csv";
  if (ext === ".html") return "text/html";
  if ([".txt", ".log", ".xml", ".yaml", ".yml"].includes(ext)) return "text/plain";
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext)) return `image/${ext.slice(1).replace("jpg", "jpeg")}`;
  return "application/octet-stream";
}

async function collectFileMetadata(filePath: string, mimeType: string): Promise<Record<string, string | number | boolean | null>> {
  const stat = fs.statSync(filePath);
  const textLike = mimeType.startsWith("text/") || mimeType === "application/json" || mimeType === "text/csv";
  const metadata: Record<string, string | number | boolean | null> = {
    extension: path.extname(filePath).toLowerCase().replace(/^\./, "") || null,
    modifiedAt: stat.mtime.toISOString(),
    binary: !textLike,
  };
  if (stat.size <= 16 * 1024 * 1024) {
    metadata.sha256 = crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  }
  if (mimeType.startsWith("image/")) {
    try {
      const image = await sharp(filePath).metadata();
      metadata.width = image.width ?? null;
      metadata.height = image.height ?? null;
      metadata.format = image.format ?? null;
      metadata.hasAlpha = image.hasAlpha ?? null;
    } catch {
      metadata.imageMetadata = "unavailable";
    }
  }
  return metadata;
}

function previewFile(filePath: string, mimeType: string): { sizeBytes: number; previewText: string | null } {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) return { sizeBytes: stat.size, previewText: null };
  const textLike = mimeType.startsWith("text/") || mimeType === "application/json";
  if (!textLike || stat.size > 512 * 1024) return { sizeBytes: stat.size, previewText: null };
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(Math.min(6000, stat.size));
    fs.readSync(fd, buffer, 0, buffer.length, 0);
    return { sizeBytes: stat.size, previewText: buffer.toString("utf8").replace(/\0/g, "").slice(0, 6000) };
  } finally {
    fs.closeSync(fd);
  }
}

function stringifyBrief(value: unknown, max = 900): string {
  if (value == null) return "";
  if (typeof value === "string") return value.trim().slice(0, max);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value, null, 2).slice(0, max);
  } catch {
    return String(value).slice(0, max);
  }
}

function summarizeNodeOutput(nodeId: string, result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const record = result as { output?: unknown; data?: unknown; error?: unknown; duration?: unknown };
  const output = record.output && typeof record.output === "object"
    ? record.output as Record<string, unknown>
    : record.data && typeof record.data === "object"
      ? record.data as Record<string, unknown>
      : {};
  const bits: string[] = [];
  if (record.error) bits.push(`error: ${stringifyBrief(record.error, 240)}`);
  for (const key of ["response", "content", "message", "summary", "path", "taskId", "action"]) {
    const text = stringifyBrief(output[key], 500);
    if (text) bits.push(`${key}: ${text}`);
  }
  if (output.written === true && typeof output.path === "string") bits.push(`written: ${output.path}`);
  if (output.task && typeof output.task === "object") {
    const task = output.task as Record<string, unknown>;
    bits.push(`task: ${String(task.title ?? task.id ?? "created task")}`);
  }
  if (bits.length === 0) return null;
  const duration = typeof record.duration === "number" ? ` (${Math.round(record.duration)}ms)` : "";
  return `${nodeId}${duration}\n${bits.join("\n")}`;
}

function summarizeWorkflowOutput(results: Record<string, unknown>): string | null {
  const lines = Object.entries(results)
    .map(([nodeId, result]) => summarizeNodeOutput(nodeId, result))
    .filter((item): item is string => Boolean(item));
  if (lines.length === 0) return null;
  return lines.join("\n\n").slice(0, 6000);
}

async function collectExecutionArtifacts(sessionId: string, limit = 20): Promise<Artifact[]> {
  const db = getSqlite();
  const rows = db
    .prepare(
      `SELECT e.id, e.workflow_id, e.trigger_data, e.provenance, e.node_results, e.started_at, w.name AS workflow_name
       FROM executions e
       LEFT JOIN workflows w ON w.id = e.workflow_id
       ORDER BY e.started_at DESC
       LIMIT 80`,
    )
    .all() as Array<{
      id: string;
      workflow_id: string;
      trigger_data: string | null;
      provenance: string | null;
      node_results: string | null;
      started_at: string;
      workflow_name: string | null;
    }>;

  const artifacts: Artifact[] = [];
  const seenPaths = new Set<string>();
  const matchingWorkflowIds = new Set<string>();
  const matchingExecutionIds = new Set<string>();
  for (const row of rows) {
    const triggerData = readJsonSafe(row.trigger_data);
    const provenance = readJsonSafe(row.provenance);
    const rowSessionId = String(triggerData?.sessionId ?? provenance?.sessionId ?? "").trim();
    if (rowSessionId !== sessionId) continue;
    matchingWorkflowIds.add(row.workflow_id);
    matchingExecutionIds.add(row.id);
    const results = readJsonSafe(row.node_results);
    if (!results) continue;
    const outputPreview = summarizeWorkflowOutput(results);
    if (outputPreview) {
      artifacts.push({
        id: `${row.id}:workflow-output`,
        kind: "workflow-output",
        name: `${row.workflow_name || row.workflow_id} output`,
        mimeType: "application/json",
        sizeBytes: outputPreview.length,
        path: null,
        createdAt: row.started_at,
        source: row.workflow_name || row.workflow_id,
        previewText: outputPreview,
        status: null,
        workflowId: row.workflow_id,
        executionId: row.id,
        href: `/workflows/${encodeURIComponent(row.workflow_id)}`,
      });
    }
    for (const [nodeId, result] of Object.entries(results)) {
      if (!result || typeof result !== "object") continue;
      const data = (result as { output?: unknown; data?: unknown }).output ?? (result as { data?: unknown }).data;
      if (!data || typeof data !== "object") continue;
      const record = data as Record<string, unknown>;
      if (record.task && typeof record.task === "object") {
        const task = record.task as Record<string, unknown>;
        const taskId = String(task.id ?? "").trim();
        artifacts.push({
          id: taskId ? `board-task:${taskId}` : `${row.id}:${nodeId}:board-task`,
          kind: "board-task",
          name: String(task.title ?? "Board task"),
          mimeType: "application/x.disp8ch-board-task",
          sizeBytes: String(task.description ?? "").length,
          path: null,
          createdAt: String(task.createdAt ?? row.started_at),
          source: row.workflow_name ? `${row.workflow_name} / ${nodeId}` : `${row.workflow_id} / ${nodeId}`,
          previewText: [
            String(task.description ?? ""),
            task.status ? `status: ${String(task.status)}` : "",
            task.priority ? `priority: ${String(task.priority)}` : "",
          ].filter(Boolean).join("\n"),
          status: typeof task.status === "string" ? task.status : null,
          workflowId: row.workflow_id,
          executionId: row.id,
          href: taskId ? `/boards?task=${encodeURIComponent(taskId)}` : "/boards",
        });
      }
      const filePath = typeof record.path === "string" ? record.path : null;
      if (!filePath || record.written !== true) continue;
      const resolved = path.resolve(filePath);
      if (seenPaths.has(resolved) || !fs.existsSync(resolved)) continue;
      seenPaths.add(resolved);
      const mimeType = guessMime(resolved);
      const preview = previewFile(resolved, mimeType);
      artifacts.push({
        id: `${row.id}:${nodeId}`,
        kind: "generated-file",
        name: path.basename(resolved),
        mimeType,
        sizeBytes: preview.sizeBytes,
        path: resolved,
        createdAt: row.started_at,
        source: row.workflow_name ? `${row.workflow_name} / ${nodeId}` : `${row.workflow_id} / ${nodeId}`,
        previewText: preview.previewText,
        status: null,
        workflowId: row.workflow_id,
        executionId: row.id,
        previewUrl: mimeType.startsWith("image/") ? null : undefined,
        href: null,
        metadata: await collectFileMetadata(resolved, mimeType),
      });
      if (artifacts.length >= limit) return artifacts;
    }
  }
  const boardTasks = collectBoardTaskArtifacts(matchingWorkflowIds, matchingExecutionIds, Math.max(0, limit - artifacts.length));
  artifacts.push(...boardTasks);
  return artifacts;
}

function collectBoardTaskArtifacts(workflowIds: Set<string>, executionIds: Set<string>, limit: number): Artifact[] {
  if (limit <= 0 || (workflowIds.size === 0 && executionIds.size === 0)) return [];
  const clauses: string[] = [];
  const values: string[] = [];
  if (workflowIds.size > 0) {
    clauses.push(`workflow_id IN (${Array.from(workflowIds).map(() => "?").join(", ")})`);
    values.push(...workflowIds);
  }
  if (executionIds.size > 0) {
    clauses.push(`execution_run_id IN (${Array.from(executionIds).map(() => "?").join(", ")})`);
    values.push(...executionIds);
  }
  const rows = getSqlite()
    .prepare(
      `SELECT id, board_id, title, description, status, priority, workflow_id, workflow_template_key, execution_run_id, updated_at, created_at
       FROM board_tasks
       WHERE ${clauses.join(" OR ")}
       ORDER BY updated_at DESC
       LIMIT ?`,
    )
    .all(...values, limit) as Array<{
      id: string;
      board_id: string;
      title: string;
      description: string | null;
      status: string;
      priority: string;
      workflow_id: string | null;
      workflow_template_key: string | null;
      execution_run_id: string | null;
      updated_at: string;
      created_at: string;
    }>;
  return rows.map((row) => ({
    id: `board-task:${row.id}`,
    kind: "board-task",
    name: row.title,
    mimeType: "application/x.disp8ch-board-task",
    sizeBytes: row.description?.length ?? 0,
    path: null,
    createdAt: row.created_at || row.updated_at,
    source: `board:${row.board_id}`,
    previewText: [
      row.description || "",
      `status: ${row.status}`,
      `priority: ${row.priority}`,
      row.workflow_template_key ? `template: ${row.workflow_template_key}` : "",
      row.execution_run_id ? `execution: ${row.execution_run_id}` : "",
    ].filter(Boolean).join("\n"),
    status: row.status,
    workflowId: row.workflow_id,
    executionId: row.execution_run_id,
    href: `/boards?task=${encodeURIComponent(row.id)}`,
  }));
}

export async function GET(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    initializeDatabase();
    const { searchParams } = new URL(request.url);
    const sessionId = searchParams.get("sessionId")?.trim();
    if (!sessionId) {
      return NextResponse.json({ success: false, error: "Missing sessionId" }, { status: 400 });
    }
    const db = getSqlite();
    const rows = db
      .prepare(
        `SELECT id, file_name, mime_type, size_bytes, path, created_at
         FROM chat_attachments
         WHERE session_id = ?
         ORDER BY created_at DESC
         LIMIT 30`,
      )
      .all(sessionId) as Array<{
        id: string;
        file_name: string;
        mime_type: string;
        size_bytes: number;
        path: string;
        created_at: string;
      }>;
    const uploaded: Artifact[] = [];
    for (const row of rows) {
      let previewText: string | null = null;
      let metadata: Record<string, string | number | boolean | null> | undefined;
      try {
        if (fs.existsSync(row.path)) {
          previewText = previewFile(row.path, row.mime_type).previewText;
          metadata = await collectFileMetadata(row.path, row.mime_type);
        }
      } catch {
        previewText = null;
      }
      uploaded.push({
        id: row.id,
        kind: row.mime_type.startsWith("image/") ? "image" : "file",
        name: row.file_name,
        mimeType: row.mime_type,
        sizeBytes: row.size_bytes,
        path: row.path,
        createdAt: row.created_at,
        source: "chat-upload",
        previewText,
        metadata,
        status: null,
        workflowId: null,
        executionId: null,
        previewUrl: row.mime_type.startsWith("image/") ? `/api/uploads?id=${encodeURIComponent(row.id)}` : null,
        href: null,
      });
    }
    return NextResponse.json({
      success: true,
      data: [...uploaded, ...await collectExecutionArtifacts(sessionId)].slice(0, 50),
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
