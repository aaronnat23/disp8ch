import { claimBoardTask, getBoardTask, updateBoardTask } from "@/lib/boards/manager";
import { getSqlite, initializeDatabase } from "@/lib/db";
import { executeWorkflow } from "@/lib/engine/executor";
import { createChildProvenance, type ProvenanceRecord } from "@/lib/provenance";
import { resolveWorkflowTemplateReference } from "@/lib/workflows/template-catalog";
import type { ExecutionRecord } from "@/types/execution";
import { getModelConfig } from "@/lib/agents/model-router";
import { getDefaultAgent } from "@/lib/agents/registry";
import { withRetry } from "@/lib/utils/retry";
import { nanoid } from "nanoid";

const DEFAULT_TASK_EXECUTOR_TEMPLATE_KEY =
  resolveWorkflowTemplateReference("general task executor")?.key ?? "general-task-executor";

type WorkflowRow = {
  id: string;
  name: string;
  nodes: string;
  edges: string;
  is_active: number;
};

type CreateWorkflowResponse = {
  success: boolean;
  data?: {
    id?: string;
    name?: string;
  };
  error?: string;
};

function buildLocalTaskWorkflow(templateKey: string, task: { title: string; description?: string | null }) {
  const manualId = nanoid(8);
  const agentId = nanoid(8);
  const sendId = nanoid(8);
  const isSimpleChat = templateKey === "simple-chat";
  const systemPrompt = isSimpleChat
    ? "You are a helpful AI assistant. Be concise and helpful."
    : [
        "You are the execution engine for a board task.",
        "",
        "Treat the incoming task title and description as the work request.",
        "Use available context from the trigger. Return a concise execution summary with: what you did, result, and any next step.",
        "",
        "Incoming board task:",
        `- Title: ${task.title}`,
        `- Description: ${task.description || ""}`,
      ].join("\n");

  return {
    nodes: [
      {
        id: manualId,
        type: "manual-trigger",
        position: { x: 100, y: 200 },
        data: { label: "Manual Trigger" },
      },
      {
        id: agentId,
        type: "claude-agent",
        position: { x: 400, y: 200 },
        data: {
          label: isSimpleChat ? "Agent" : "General Task Executor",
          systemPrompt,
          temperature: isSimpleChat ? 0.7 : 0.3,
          maxTokens: isSimpleChat ? 1024 : 2200,
        },
      },
      {
        id: sendId,
        type: "send-webchat",
        position: { x: 700, y: 200 },
        data: { label: "Send WebChat" },
      },
    ],
    edges: [
      { id: `e-${manualId}-${agentId}`, source: manualId, target: agentId },
      { id: `e-${agentId}-${sendId}`, source: agentId, target: sendId },
    ],
  };
}

function createLocalWorkflowForTask(
  task: NonNullable<ReturnType<typeof getBoardTask>>,
  workflowTemplateKey: string,
): { workflowId: string; workflowName: string } {
  initializeDatabase();
  const db = getSqlite();
  const id = nanoid(12);
  const now = new Date().toISOString();
  const workflowName = `[Board Task] ${task.title}`.slice(0, 120);
  const workflow = buildLocalTaskWorkflow(workflowTemplateKey, task);
  db.prepare(
    "INSERT INTO workflows (id, name, description, nodes, edges, organization_id, goal_id, source_type, source_ref, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    id,
    workflowName,
    task.description ?? `Created from board task ${task.id}`,
    JSON.stringify(workflow.nodes),
    JSON.stringify(workflow.edges),
    task.organizationId ?? null,
    task.goalId ?? null,
    "board-task",
    task.id,
    1,
    now,
    now,
  );
  updateBoardTask(task.id, {
    workflowId: id,
    workflowTemplateKey,
  });
  return { workflowId: id, workflowName };
}

function extractExecutionResponse(result: ExecutionRecord): string | null {
  const nodeResults = Object.values(result.nodeResults);
  for (const item of nodeResults.reverse()) {
    const output = item.output as Record<string, unknown>;
    if (typeof output.response === "string" && output.response.trim()) {
      return output.response;
    }
    if (typeof output.content === "string" && output.content.trim()) {
      return output.content;
    }
    if (typeof output.result === "string" && output.result.trim()) {
      return output.result;
    }
    if (output.result && typeof output.result === "object") {
      const nested = output.result as Record<string, unknown>;
      if (typeof nested.response === "string" && nested.response.trim()) {
        return nested.response;
      }
      if (typeof nested.content === "string" && nested.content.trim()) {
        return nested.content;
      }
    }
  }
  return null;
}

async function ensureWorkflowForTask(taskId: string): Promise<{ workflowId: string; workflowName: string }> {
  const task = getBoardTask(taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  initializeDatabase();
  const db = getSqlite();

  if (task.workflowId) {
    const existing = db.prepare("SELECT id, name FROM workflows WHERE id = ? LIMIT 1").get(task.workflowId) as
      | { id: string; name: string }
      | undefined;
    if (existing) {
      return { workflowId: existing.id, workflowName: existing.name };
    }
  }

  const workflowTemplateKey = task.workflowTemplateKey || DEFAULT_TASK_EXECUTOR_TEMPLATE_KEY;

  try {
    const createResponse = await withRetry(
      () =>
        fetch(`http://127.0.0.1:${process.env.PORT ?? 3100}/api/workflows`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: `[Board Task] ${task.title}`.slice(0, 120),
            description: task.description ?? `Created from board task ${task.id}`,
            template: workflowTemplateKey,
            organizationId: task.organizationId ?? undefined,
            goalId: task.goalId ?? undefined,
            sourceType: "board-task",
            sourceRef: task.id,
          }),
        }),
      {
        label: "board-task-create-workflow",
        shouldRetry: (error) => {
          const message = String(error).toLowerCase();
          return message.includes("fetch failed") || message.includes("econnrefused") || message.includes("socket");
        },
      },
    );

    const createText = await createResponse.text();
    let createPayload: CreateWorkflowResponse | null = null;
    try {
      createPayload = JSON.parse(createText) as CreateWorkflowResponse;
    } catch {
      createPayload = null;
    }

    if (createResponse.ok && createPayload?.success && createPayload.data?.id) {
      const workflowId = createPayload.data.id;
      const workflowName = createPayload.data.name || `[Board Task] ${task.title}`;
      const localWorkflow = db.prepare("SELECT id, name FROM workflows WHERE id = ? LIMIT 1").get(workflowId) as
        | { id: string; name: string }
        | undefined;
      if (localWorkflow) {
        updateBoardTask(task.id, {
          workflowId,
          workflowTemplateKey,
        });
        return { workflowId, workflowName };
      }
    }
  } catch {
    // Fall through to local creation. Board-task execution must not depend on
    // a loopback API server, because tests and desktop runs may use a different DB.
  }

  return createLocalWorkflowForTask(task, workflowTemplateKey);
}

export async function runWorkflowBackedBoardTask(
  taskId: string,
  options?: { provenance?: Partial<ProvenanceRecord> | null },
): Promise<{
  taskId: string;
  workflowId: string;
  workflowName: string;
  executionId: string;
  executionStatus: string;
  response: string | null;
}> {
  const task = getBoardTask(taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  const { workflowId, workflowName } = await ensureWorkflowForTask(taskId);
  const claimerAgentId = task.assignedAgentId || getDefaultAgent().id;
  const claimedTask = claimBoardTask(task.id, claimerAgentId);

  initializeDatabase();
  const db = getSqlite();
  const row = db.prepare("SELECT id, name, nodes, edges, is_active FROM workflows WHERE id = ? LIMIT 1").get(workflowId) as
    | WorkflowRow
    | undefined;

  if (!row) {
    throw new Error(`Workflow not found: ${workflowId}`);
  }
  if (Number(row.is_active) !== 1) {
    throw new Error(`Workflow is inactive: ${row.name}`);
  }

  updateBoardTask(task.id, {
    status: "in_progress",
    workflowId: row.id,
  });

  const triggerMessage = claimedTask.description?.trim()
    ? `${claimedTask.title}\n\n${claimedTask.description}`
    : claimedTask.title;

  const result = await executeWorkflow({
    workflowId: row.id,
    nodes: JSON.parse(row.nodes),
    edges: JSON.parse(row.edges),
    triggerType: "manual",
    triggerData: {
      message: triggerMessage,
      taskId: claimedTask.id,
      taskTitle: claimedTask.title,
      taskDescription: claimedTask.description ?? "",
      boardId: claimedTask.boardId,
      boardName: claimedTask.boardName ?? "",
      organizationId: claimedTask.organizationId ?? "",
      goalId: claimedTask.goalId ?? "",
      workflowTemplateKey: claimedTask.workflowTemplateKey ?? "",
    },
    provenance: createChildProvenance(options?.provenance, "board-task", "board-task-runner", {
      taskId: claimedTask.id,
      taskTitle: claimedTask.title,
      boardId: claimedTask.boardId,
      boardName: claimedTask.boardName ?? "",
      organizationId: claimedTask.organizationId ?? "",
      goalId: claimedTask.goalId ?? "",
      goalName: claimedTask.goalName ?? "",
      checkedOutByAgentId: claimedTask.checkedOutByAgentId ?? claimerAgentId,
      checkedOutByAgentName: claimedTask.checkedOutByAgentName ?? "",
      workflowId: row.id,
      workflowName,
    }),
    modelConfig: getModelConfig(),
  });

  return {
    taskId: claimedTask.id,
    workflowId: row.id,
    workflowName,
    executionId: result.id,
    executionStatus: result.status,
    response: extractExecutionResponse(result),
  };
}
