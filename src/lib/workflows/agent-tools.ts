import { getSqlite } from "@/lib/db";
import { nanoid } from "nanoid";

export type WorkflowAgentTool = {
  id: string;
  workflowId: string;
  toolName: string;
  description: string;
  inputSchemaJson: string;
  outputSchemaJson: string | null;
  allowedAgentIdsJson: string | null;
  allowedOrganizationIdsJson: string | null;
  approvalPolicy: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export function listAgentTools(workflowId?: string): WorkflowAgentTool[] {
  const db = getSqlite();
  const query = workflowId
    ? "SELECT * FROM workflow_agent_tools WHERE workflow_id = ? ORDER BY created_at"
    : "SELECT * FROM workflow_agent_tools ORDER BY created_at";
  const params = workflowId ? [workflowId] : [];
  const rows = db.prepare(query).all(...params) as Array<Record<string, unknown>>;
  return rows.map(rowToTool);
}

export function getAgentTool(toolName: string): WorkflowAgentTool | null {
  const db = getSqlite();
  const row = db.prepare("SELECT * FROM workflow_agent_tools WHERE tool_name = ?").get(toolName) as Record<string, unknown> | undefined;
  return row ? rowToTool(row) : null;
}

export function getAgentToolById(id: string): WorkflowAgentTool | null {
  const db = getSqlite();
  const row = db.prepare("SELECT * FROM workflow_agent_tools WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? rowToTool(row) : null;
}

export function createAgentTool(params: {
  workflowId: string;
  toolName: string;
  description: string;
  inputSchemaJson: string;
  outputSchemaJson?: string | null;
  allowedAgentIdsJson?: string | null;
  allowedOrganizationIdsJson?: string | null;
  approvalPolicy?: string;
}): WorkflowAgentTool {
  const db = getSqlite();
  const id = nanoid(12);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO workflow_agent_tools (id, workflow_id, tool_name, description, input_schema_json, output_schema_json, allowed_agent_ids_json, allowed_organization_ids_json, approval_policy, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(
    id, params.workflowId, params.toolName, params.description,
    params.inputSchemaJson, params.outputSchemaJson ?? null,
    params.allowedAgentIdsJson ?? null, params.allowedOrganizationIdsJson ?? null,
    params.approvalPolicy ?? "inherit", now, now,
  );
  return getAgentToolById(id)!;
}

export function updateAgentTool(id: string, updates: Partial<Pick<WorkflowAgentTool, "toolName" | "description" | "inputSchemaJson" | "outputSchemaJson" | "allowedAgentIdsJson" | "allowedOrganizationIdsJson" | "approvalPolicy" | "enabled">>): WorkflowAgentTool | null {
  const db = getSqlite();
  const existing = getAgentToolById(id);
  if (!existing) return null;
  const now = new Date().toISOString();
  const fields: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(updates)) {
    const col = key.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
    fields.push(`${col} = ?`);
    values.push(key === "enabled" ? (value ? 1 : 0) : value);
  }
  if (fields.length === 0) return existing;
  fields.push("updated_at = ?");
  values.push(now);
  values.push(id);
  db.prepare(`UPDATE workflow_agent_tools SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  return getAgentToolById(id);
}

export function deleteAgentTool(id: string): void {
  const db = getSqlite();
  db.prepare("DELETE FROM workflow_agent_tools WHERE id = ?").run(id);
}

export function listEnabledAgentToolsForAgent(agentId?: string): WorkflowAgentTool[] {
  const db = getSqlite();
  const rows = db.prepare(
    "SELECT * FROM workflow_agent_tools WHERE enabled = 1 ORDER BY created_at",
  ).all() as Array<Record<string, unknown>>;
  return rows
    .map(rowToTool)
    .filter((tool) => {
      if (!tool.allowedAgentIdsJson) return true;
      try {
        const allowed: string[] = JSON.parse(tool.allowedAgentIdsJson);
        if (allowed.length === 0) return true;
        if (!agentId) return false;
        return allowed.includes(agentId);
      } catch {
        return false;
      }
    });
}

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

export type AgentToolSchemaValidation = { ok: true } | { ok: false; error: string };

/**
 * Validate that the input/output schema JSON is a usable JSON Schema object.
 * Tool inputs must be object schemas so the agent can pass named arguments.
 */
export function validateAgentToolSchema(
  inputSchemaJson: string,
  outputSchemaJson?: string | null,
): AgentToolSchemaValidation {
  const parseObject = (raw: string, which: string): AgentToolSchemaValidation => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return { ok: false, error: `${which} schema is not valid JSON: ${String(err)}` };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: `${which} schema must be a JSON Schema object.` };
    }
    const obj = parsed as Record<string, unknown>;
    const declaredType = typeof obj.type === "string" ? obj.type : undefined;
    if (declaredType && declaredType !== "object") {
      return { ok: false, error: `${which} schema "type" must be "object" (got "${declaredType}").` };
    }
    if (!declaredType && !("properties" in obj)) {
      return { ok: false, error: `${which} schema must declare "type": "object" or "properties".` };
    }
    if ("properties" in obj && (typeof obj.properties !== "object" || obj.properties === null || Array.isArray(obj.properties))) {
      return { ok: false, error: `${which} schema "properties" must be an object.` };
    }
    return { ok: true };
  };

  const inputResult = parseObject(inputSchemaJson, "Input");
  if (!inputResult.ok) return inputResult;
  if (outputSchemaJson != null && String(outputSchemaJson).trim() !== "") {
    const outputResult = parseObject(outputSchemaJson, "Output");
    if (!outputResult.ok) return outputResult;
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Runtime permission resolution
// ---------------------------------------------------------------------------

export type AgentToolPermissionDecision = {
  allowed: boolean;
  requiresApproval: boolean;
  reason: string;
};

function parseIdList(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * Decide whether an agent may call a workflow-backed tool, and whether the call
 * needs confirmation. Enforced again at runtime — UI visibility is not enough.
 *
 * Approval policies:
 * - inherit / none: allowed (inherit defers approval to the caller's defaults)
 * - human: allowed but requires confirmation
 * - read-only: allowed only for read-only calls; otherwise requires confirmation
 * - disabled: never callable
 */
export function resolveAgentToolPermission(
  tool: WorkflowAgentTool,
  ctx: { agentId?: string | null; organizationId?: string | null; readOnly?: boolean } = {},
): AgentToolPermissionDecision {
  if (!tool.enabled) {
    return { allowed: false, requiresApproval: false, reason: "Tool is disabled." };
  }
  if (tool.approvalPolicy === "disabled") {
    return { allowed: false, requiresApproval: false, reason: "Tool approval policy is disabled." };
  }

  const allowedAgents = parseIdList(tool.allowedAgentIdsJson);
  if (allowedAgents.length > 0) {
    if (!ctx.agentId || !allowedAgents.includes(ctx.agentId)) {
      return { allowed: false, requiresApproval: false, reason: "Agent is not in the tool's allowed agents." };
    }
  }

  const allowedOrgs = parseIdList(tool.allowedOrganizationIdsJson);
  if (allowedOrgs.length > 0) {
    if (!ctx.organizationId || !allowedOrgs.includes(ctx.organizationId)) {
      return { allowed: false, requiresApproval: false, reason: "Organization is not in the tool's allowed organizations." };
    }
  }

  if (tool.approvalPolicy === "human") {
    return { allowed: true, requiresApproval: true, reason: "Tool requires human confirmation." };
  }
  if (tool.approvalPolicy === "read-only") {
    return ctx.readOnly
      ? { allowed: true, requiresApproval: false, reason: "Read-only call permitted." }
      : { allowed: true, requiresApproval: true, reason: "Non-read-only call requires confirmation." };
  }
  return { allowed: true, requiresApproval: false, reason: "Allowed." };
}

function rowToTool(row: Record<string, unknown>): WorkflowAgentTool {
  return {
    id: String(row.id),
    workflowId: String(row.workflow_id),
    toolName: String(row.tool_name),
    description: String(row.description),
    inputSchemaJson: String(row.input_schema_json),
    outputSchemaJson: row.output_schema_json ? String(row.output_schema_json) : null,
    allowedAgentIdsJson: row.allowed_agent_ids_json ? String(row.allowed_agent_ids_json) : null,
    allowedOrganizationIdsJson: row.allowed_organization_ids_json ? String(row.allowed_organization_ids_json) : null,
    approvalPolicy: String(row.approval_policy),
    enabled: Boolean(row.enabled),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
