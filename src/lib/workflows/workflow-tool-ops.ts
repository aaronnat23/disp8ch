import { getSqlite, initializeDatabase } from "@/lib/db";
import { nanoid } from "nanoid";
import { restartWorkflowCrons, unscheduleCronWorkflow } from "@/lib/cron/manager";
import { getNodeContract } from "@/lib/engine/node-contracts";
import { normalizeWorkflowDefinition } from "@/lib/engine/workflow-normalize";

// ── Types ─────────────────────────────────────────────────────────────────────

interface WorkflowDbRow {
  id: string;
  name: string;
  description: string | null;
  nodes: string;
  edges: string;
  organization_id: string | null;
  goal_id: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface WorkflowNode {
  id: string;
  type: string;
  position?: { x: number; y: number };
  data: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ParsedWorkflow {
  id: string;
  name: string;
  description: string | null;
  organization_id: string | null;
  goal_id: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
  nodes: WorkflowNode[];
  edges: unknown[];
}

export interface PatchOp {
  op: "set" | "unset" | "append_unique" | "remove_value" | "replace_array_item" | "replace_assignment" | "set_header" | "remove_header";
  path: string;
  value?: unknown;
  match?: unknown;
  index?: number;
}

export interface ResolveWorkflowResult {
  workflow: ParsedWorkflow;
  ambiguous: Array<{ id: string; name: string }>;
}

export interface ResolveNodeResult {
  node: WorkflowNode;
  ambiguous: Array<{ id: string; label: string; type: string }>;
}

// ── Security & field constants ────────────────────────────────────────────────

export const SECURITY_SENSITIVE_FIELDS = new Set([
  "enabledTools", "execSecurity", "execAllowlist", "url", "headers",
  "auth", "secret", "password", "apiKey", "api_key", "token", "credential",
]);

const SECRET_KEY_PATTERN = /authorization|apiKey|api_key|token|secret|password|credential|key/i;
const BEARER_PATTERN = /Bearer\s+\S+/gi;
const SECRET_REF_PATTERN = /secret:[^\s"]+/gi;

export const GENERIC_EDITABLE_FIELDS = new Set([
  "label", "description", "systemPrompt", "prompt", "url", "method",
  "headers", "body", "assignments", "variables", "expression", "timezone",
  "enabledTools", "execSecurity", "execAllowlist", "temperature", "maxTokens",
  "agentId", "toolMode", "approvalMode", "durationMs", "code", "timeoutMs",
  "condition", "cases", "filter", "channel", "message", "query", "limit",
  "extractMode", "manualContent", "type", "confidence", "title", "status",
  "priority", "boardId", "safetyMode", "path", "encoding", "content",
  "mode", "maxIterations", "concurrency", "onItemError", "aggregateBy",
  "outputField", "retryCount", "retryDelayMs", "onFinalError",
]);

// ── Secret masking ────────────────────────────────────────────────────────────

export function maskSecrets(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "string") {
    return obj
      .replace(BEARER_PATTERN, "Bearer [MASKED]")
      .replace(SECRET_REF_PATTERN, "secret:[MASKED]");
  }
  if (Array.isArray(obj)) return obj.map(maskSecrets);
  if (typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (SECRET_KEY_PATTERN.test(k) && typeof v === "string" && v.trim().length > 0) {
        out[k] = "[MASKED]";
      } else {
        out[k] = maskSecrets(v);
      }
    }
    return out;
  }
  return obj;
}

// ── Workflow loading ──────────────────────────────────────────────────────────

export function loadWorkflows(): ParsedWorkflow[] {
  initializeDatabase();
  const db = getSqlite();
  const rows = db.prepare("SELECT * FROM workflows ORDER BY updated_at DESC").all() as WorkflowDbRow[];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    organization_id: r.organization_id,
    goal_id: r.goal_id,
    is_active: r.is_active,
    created_at: r.created_at,
    updated_at: r.updated_at,
    nodes: JSON.parse(r.nodes) as WorkflowNode[],
    edges: JSON.parse(r.edges) as unknown[],
  }));
}

export function loadWorkflowById(id: string): ParsedWorkflow | null {
  initializeDatabase();
  const db = getSqlite();
  const row = db.prepare("SELECT * FROM workflows WHERE id = ?").get(id) as WorkflowDbRow | undefined;
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    organization_id: row.organization_id,
    goal_id: row.goal_id,
    is_active: row.is_active,
    created_at: row.created_at,
    updated_at: row.updated_at,
    nodes: JSON.parse(row.nodes) as WorkflowNode[],
    edges: JSON.parse(row.edges) as unknown[],
  };
}

// ── Workflow resolver ─────────────────────────────────────────────────────────

export function resolveWorkflow(ref: { id?: string; name?: string }): { workflow: ParsedWorkflow | null; ambiguous: Array<{ id: string; name: string }> } {
  const all = loadWorkflows();

  if (ref.id) {
    const exact = all.find((w) => w.id === ref.id);
    return { workflow: exact ?? null, ambiguous: [] };
  }

  if (!ref.name) return { workflow: null, ambiguous: [] };

  const nameLower = ref.name.toLowerCase().trim();

  const exactMatch = all.find((w) => w.name.toLowerCase() === nameLower);
  if (exactMatch) return { workflow: exactMatch, ambiguous: [] };

  const subMatches = all.filter((w) => w.name.toLowerCase().includes(nameLower));
  if (subMatches.length === 1) return { workflow: subMatches[0], ambiguous: [] };
  if (subMatches.length > 1) {
    return {
      workflow: null,
      ambiguous: subMatches.map((w) => ({ id: w.id, name: w.name })),
    };
  }

  return { workflow: null, ambiguous: [] };
}

// ── Node resolver ─────────────────────────────────────────────────────────────

export function resolveNode(nodes: WorkflowNode[], ref: { nodeId?: string; nodeLabel?: string }): { node: WorkflowNode | null; ambiguous: Array<{ id: string; label: string; type: string }> } {
  if (ref.nodeId) {
    const exact = nodes.find((n) => n.id === ref.nodeId);
    return { node: exact ?? null, ambiguous: [] };
  }

  if (!ref.nodeLabel) return { node: null, ambiguous: [] };

  const labelLower = ref.nodeLabel.toLowerCase().trim();

  const exactLabel = nodes.find(
    (n) => (String(n.data?.label ?? "")).toLowerCase() === labelLower,
  );
  if (exactLabel) return { node: exactLabel, ambiguous: [] };

  const subMatches = nodes.filter(
    (n) => (String(n.data?.label ?? "")).toLowerCase().includes(labelLower),
  );
  if (subMatches.length === 1) return { node: subMatches[0], ambiguous: [] };
  if (subMatches.length > 1) {
    return {
      node: null,
      ambiguous: subMatches.map((n) => ({
        id: n.id,
        label: String(n.data?.label ?? n.id),
        type: n.type,
      })),
    };
  }

  return { node: null, ambiguous: [] };
}

// ── Field validation ──────────────────────────────────────────────────────────

export function getContractEditableFields(nodeType: string): Set<string> | null {
  const contract = getNodeContract(nodeType);
  if (!contract) return null;
  return new Set(contract.configFields.map((f) => f.key));
}

export function isFieldEditable(nodeType: string, fieldKey: string): boolean {
  if (GENERIC_EDITABLE_FIELDS.has(fieldKey)) return true;
  const contractFields = getContractEditableFields(nodeType);
  if (contractFields && contractFields.has(fieldKey)) return true;
  return false;
}

// ── Patch operations ──────────────────────────────────────────────────────────

export function applyPatchOps(data: Record<string, unknown>, ops: PatchOp[]): Record<string, unknown> {
  const out = { ...data };
  for (const op of ops) {
    const key = op.path;
    switch (op.op) {
      case "set":
        out[key] = op.value;
        break;
      case "unset":
        delete out[key];
        break;
      case "append_unique": {
        const arr = Array.isArray(out[key]) ? [...(out[key] as unknown[])] : [];
        if (!arr.some((item) => JSON.stringify(item) === JSON.stringify(op.value))) {
          arr.push(op.value);
        }
        out[key] = arr;
        break;
      }
      case "remove_value": {
        const arr = Array.isArray(out[key]) ? (out[key] as unknown[]) : [];
        out[key] = arr.filter((item) => JSON.stringify(item) !== JSON.stringify(op.value));
        break;
      }
      case "replace_array_item": {
        const arr = Array.isArray(out[key]) ? [...(out[key] as unknown[])] : [];
        const idx = typeof op.index === "number"
          ? op.index
          : arr.findIndex((item) => JSON.stringify(item) === JSON.stringify(op.match));
        if (idx >= 0 && idx < arr.length) arr[idx] = op.value;
        out[key] = arr;
        break;
      }
      case "replace_assignment": {
        const arr = Array.isArray(out[key]) ? [...(out[key] as Array<Record<string, unknown>>)] : [];
        const idx = arr.findIndex((item) => item?.key === op.match || item?.name === op.match);
        if (idx >= 0) {
          arr[idx] = { ...arr[idx], ...(op.value as Record<string, unknown>) };
        } else {
          arr.push(op.value as Record<string, unknown>);
        }
        out[key] = arr;
        break;
      }
      case "set_header": {
        const headers = typeof out[key] === "object" && out[key] !== null
          ? { ...(out[key] as Record<string, unknown>) }
          : {};
        headers[String(op.match ?? op.path)] = op.value;
        if (op.match !== undefined) {
          out[key] = headers;
        } else {
          out[key] = headers;
        }
        break;
      }
      case "remove_header": {
        const headers = typeof out[key] === "object" && out[key] !== null
          ? { ...(out[key] as Record<string, unknown>) }
          : {};
        delete headers[String(op.value ?? op.match)];
        out[key] = headers;
        break;
      }
    }
  }
  return out;
}

// ── Diff generation ───────────────────────────────────────────────────────────

export function generateDiff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string {
  const maskedBefore = maskSecrets(before) as Record<string, unknown>;
  const maskedAfter = maskSecrets(after) as Record<string, unknown>;

  const allKeys = new Set([...Object.keys(maskedBefore), ...Object.keys(maskedAfter)]);
  const lines: string[] = [];

  for (const k of allKeys) {
    const bVal = maskedBefore[k];
    const aVal = maskedAfter[k];
    if (JSON.stringify(bVal) === JSON.stringify(aVal)) continue;

    const bStr = summarizeValue(bVal);
    const aStr = summarizeValue(aVal);
    lines.push(`  ${k}: ${bStr} → ${aStr}`);
  }

  return lines.length > 0 ? lines.join("\n") : "  (no changes)";
}

function summarizeValue(v: unknown): string {
  if (v === undefined) return "(unset)";
  if (v === null) return "null";
  if (typeof v === "string") {
    return v.length > 80 ? `"${v.slice(0, 80)}…" (${v.length} chars)` : `"${v}"`;
  }
  if (Array.isArray(v)) return `[array, ${v.length} items]`;
  if (typeof v === "object") return `{object, ${Object.keys(v as Record<string, unknown>).length} keys}`;
  return String(v);
}

// ── Save helpers ──────────────────────────────────────────────────────────────

export interface WorkflowValidationResult {
  ok: boolean;
  errors: Array<{ nodeId: string; message: string; type: string }>;
  warnings: Array<{ nodeId: string; message: string; type: string }>;
  normalizations: string[];
}

/**
 * Validates a workflow before save. Runs normalization then linting.
 * Returns errors, warnings, and normalizations applied.
 */
export function validateWorkflowNodes(
  workflowId: string,
  nodes: WorkflowNode[],
): WorkflowValidationResult {
  initializeDatabase();
  const db = getSqlite();

  // Load current edges for normalization context
  const row = db.prepare("SELECT edges FROM workflows WHERE id = ?").get(workflowId) as { edges?: string } | undefined;
  const edges = row?.edges ? JSON.parse(row.edges) : [];

  // Normalize first
  const normalized = normalizeWorkflowDefinition({ nodes: nodes as any[], edges: edges as any[], source: "validation-preflight" });

  // Lint
  const { lintWorkflow } = require("@/lib/engine/linter") as {
    lintWorkflow: (nodes: any[], edges: any[]) => { errors: Array<{ nodeId: string; message: string; type: string }>; warnings: Array<{ nodeId: string; message: string; type: string }> };
  };
  const lintResult = lintWorkflow(normalized.nodes, edges);

  return {
    ok: lintResult.errors.length === 0,
    errors: lintResult.errors,
    warnings: lintResult.warnings,
    normalizations: normalized.warnings,
  };
}

export function saveWorkflowNodes(workflowId: string, nodes: WorkflowNode[]): void {
  initializeDatabase();
  const db = getSqlite();
  const now = new Date().toISOString();

  // Load current edges for normalization context
  const row = db.prepare("SELECT edges FROM workflows WHERE id = ?").get(workflowId) as { edges?: string } | undefined;
  const edges = row?.edges ? JSON.parse(row.edges) : [];

  // Normalize: infer missing messages, ensure labels/positions
  const normalized = normalizeWorkflowDefinition({ nodes: nodes as any[], edges: edges as any[], source: "tool-ops-save" });

  db.prepare("UPDATE workflows SET nodes = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(normalized.nodes), now, workflowId);
  restartWorkflowCrons(workflowId);
}

export function saveWorkflowActive(workflowId: string, isActive: boolean): void {
  initializeDatabase();
  const db = getSqlite();
  const now = new Date().toISOString();
  db.prepare("UPDATE workflows SET is_active = ?, updated_at = ? WHERE id = ?")
    .run(isActive ? 1 : 0, now, workflowId);
  restartWorkflowCrons(workflowId);
}

export function saveWorkflowField(workflowId: string, updates: {
  name?: string;
  description?: string;
  isActive?: boolean;
  nodes?: WorkflowNode[];
  organizationId?: string | null;
  goalId?: string | null;
}): void {
  initializeDatabase();
  const db = getSqlite();
  const now = new Date().toISOString();
  const setClauses: string[] = [];
  const values: unknown[] = [];

  if (updates.name !== undefined) { setClauses.push("name = ?"); values.push(updates.name); }
  if (updates.description !== undefined) { setClauses.push("description = ?"); values.push(updates.description); }
  if (updates.isActive !== undefined) { setClauses.push("is_active = ?"); values.push(updates.isActive ? 1 : 0); }
  if (updates.nodes !== undefined) { setClauses.push("nodes = ?"); values.push(JSON.stringify(updates.nodes)); }
  if (updates.organizationId !== undefined) { setClauses.push("organization_id = ?"); values.push(updates.organizationId ?? null); }
  if (updates.goalId !== undefined) { setClauses.push("goal_id = ?"); values.push(updates.goalId ?? null); }

  if (setClauses.length === 0) return;
  setClauses.push("updated_at = ?");
  values.push(now, workflowId);
  db.prepare(`UPDATE workflows SET ${setClauses.join(", ")} WHERE id = ?`).run(...values);
  restartWorkflowCrons(workflowId);
}

// ── Duplicate ─────────────────────────────────────────────────────────────────

export function duplicateWorkflow(
  source: ParsedWorkflow,
  newName: string,
): string {
  initializeDatabase();
  const db = getSqlite();
  const newId = nanoid(10);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO workflows (id, name, description, nodes, edges, organization_id, goal_id, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`)
    .run(
      newId,
      newName,
      source.description ?? null,
      JSON.stringify(source.nodes),
      JSON.stringify(source.edges),
      source.organization_id ?? null,
      source.goal_id ?? null,
      now,
      now,
    );
  return newId;
}

// ── Delete ────────────────────────────────────────────────────────────────────

export function deleteWorkflow(workflowId: string): void {
  initializeDatabase();
  const db = getSqlite();
  db.prepare("UPDATE board_tasks SET workflow_id = NULL WHERE workflow_id = ?").run(workflowId);
  db.prepare("DELETE FROM workflows WHERE id = ?").run(workflowId);
  try {
    db.prepare("DELETE FROM tag_links WHERE target_type = 'workflow' AND target_id = ?").run(workflowId);
  } catch { /* tag_links may not exist on older DBs */ }
  unscheduleCronWorkflow(workflowId);
}

// ── Run workflow (loopback execute) ───────────────────────────────────────────

export async function runWorkflow(workflowId: string, triggerInput?: string): Promise<{ executionId: string | null; error?: string }> {
  const port = process.env.PORT ?? 3100;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflowId,
        triggerType: "manual",
        triggerData: triggerInput ? { input: triggerInput } : {},
      }),
    });
    const payload = await res.json() as { success?: boolean; data?: { executionId?: string; id?: string }; error?: string };
    if (!res.ok || !payload.success) {
      return { executionId: null, error: payload.error ?? `HTTP ${res.status}` };
    }
    const execId = payload.data?.executionId ?? payload.data?.id ?? null;
    return { executionId: execId };
  } catch (err) {
    return { executionId: null, error: String(err) };
  }
}

// ── Execution status ──────────────────────────────────────────────────────────

export function getExecutionStatus(ref: { executionId?: string; workflowId?: string }): {
  found: boolean;
  id?: string;
  status?: string;
  workflowId?: string;
  startedAt?: string;
  completedAt?: string | null;
  error?: string | null;
  outputSummary?: string | null;
} {
  initializeDatabase();
  const db = getSqlite();

  if (ref.executionId) {
    const row = db.prepare(
      "SELECT id, workflow_id, status, started_at, completed_at, error, node_results FROM executions WHERE id = ?",
    ).get(ref.executionId) as {
      id: string; workflow_id: string; status: string;
      started_at: string; completed_at: string | null;
      error: string | null; node_results: string | null;
    } | undefined;
    if (!row) return { found: false };
    return {
      found: true,
      id: row.id,
      status: row.status,
      workflowId: row.workflow_id,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      error: row.error,
      outputSummary: extractOutputSummary(row.node_results),
    };
  }

  if (ref.workflowId) {
    const row = db.prepare(
      "SELECT id, workflow_id, status, started_at, completed_at, error, node_results FROM executions WHERE workflow_id = ? ORDER BY started_at DESC LIMIT 1",
    ).get(ref.workflowId) as {
      id: string; workflow_id: string; status: string;
      started_at: string; completed_at: string | null;
      error: string | null; node_results: string | null;
    } | undefined;
    if (!row) return { found: false };
    return {
      found: true,
      id: row.id,
      status: row.status,
      workflowId: row.workflow_id,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      error: row.error,
      outputSummary: extractOutputSummary(row.node_results),
    };
  }

  return { found: false };
}

function extractOutputSummary(nodeResultsJson: string | null): string | null {
  if (!nodeResultsJson) return null;
  try {
    const parsed = JSON.parse(nodeResultsJson) as Record<string, { output?: unknown; error?: string }>;
    const entries = Object.entries(parsed);
    if (entries.length === 0) return null;
    const lastEntry = entries[entries.length - 1];
    const [, result] = lastEntry;
    if (result.error) return `Error: ${String(result.error).slice(0, 200)}`;
    const outStr = JSON.stringify(result.output ?? "");
    const masked = String(maskSecrets(outStr));
    return masked.slice(0, 500) + (masked.length > 500 ? "…" : "");
  } catch {
    return null;
  }
}

// ── Summary builder for workflow_get ─────────────────────────────────────────

export function buildWorkflowNodeSummary(node: WorkflowNode): Record<string, unknown> {
  const masked = maskSecrets(node.data) as Record<string, unknown>;
  const summary: Record<string, unknown> = {
    id: node.id,
    type: node.type,
    label: String(masked.label ?? node.id),
  };

  const include = (key: string) => {
    if (masked[key] !== undefined && masked[key] !== null && masked[key] !== "") {
      const val = masked[key];
      if (typeof val === "string" && val.length > 2000) {
        summary[key] = val.slice(0, 2000) + "… (truncated — view full config in UI)";
      } else {
        summary[key] = val;
      }
    }
  };

  for (const key of ["systemPrompt", "prompt", "agentId", "temperature", "maxTokens", "toolMode", "approvalMode",
    "enabledTools", "execSecurity", "execAllowlist", "url", "method", "headers", "body",
    "expression", "timezone", "assignments", "code", "message", "condition"]) {
    include(key);
  }

  return summary;
}

// ── Node type helpers ─────────────────────────────────────────────────────────

export const AGENT_NODE_TYPES = new Set([
  "claude-agent", "integration-agent", "parallel-agents", "spawn-coding-agent",
]);

export const CRON_TRIGGER_TYPES = new Set([
  "cron-trigger",
]);
