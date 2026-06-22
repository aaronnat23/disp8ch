import { getSqlite } from "@/lib/db";
import { nanoid } from "nanoid";
import { scheduleCronWorkflow } from "@/lib/cron/manager";

export function buildDurableScheduleWrapper(params: {
  targetWorkflowId: string;
  targetWorkflowName: string;
  cronExpression: string;
  timezone?: string;
  scheduleLabel?: string;
  source?: string;
}): { workflowId: string; nodeId: string } {
  const db = getSqlite();
  const workflowId = nanoid(12);
  const triggerNodeId = nanoid(8);
  const callNodeId = nanoid(8);
  const now = new Date().toISOString();
  const tz = params.timezone || "UTC";
  const label = params.scheduleLabel || `Schedule for ${params.targetWorkflowName}`;

  const nodes = [
    {
      id: triggerNodeId,
      type: "cron-trigger",
      position: { x: 200, y: 200 },
      data: {
        label: "Cron Trigger",
        cronExpression: params.cronExpression,
        timezone: tz,
      },
    },
    {
      id: callNodeId,
      type: "call-workflow",
      position: { x: 500, y: 200 },
      data: {
        label: `Call: ${params.targetWorkflowName}`,
        workflowId: params.targetWorkflowId,
      },
    },
  ];

  const edges = [
    {
      id: nanoid(8),
      source: triggerNodeId,
      target: callNodeId,
    },
  ];

  db.prepare(
    `INSERT INTO workflows (id, name, description, nodes, edges, source_type, source_ref, schedule_profile, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    workflowId,
    label,
    `Auto-generated schedule wrapper for ${params.targetWorkflowName}. Cron: ${params.cronExpression}. Source: ${params.source ?? "agent-tool"}.`,
    JSON.stringify(nodes),
    JSON.stringify(edges),
    params.source ?? "agent-tool",
    params.targetWorkflowId,
    null,
    now,
    now,
  );

  // Schedule the wrapper workflow
  scheduleCronWorkflow(workflowId, triggerNodeId, params.cronExpression, tz);

  return { workflowId, nodeId: triggerNodeId };
}
