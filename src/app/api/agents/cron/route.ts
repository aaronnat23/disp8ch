import { NextRequest, NextResponse } from "next/server";
import { initializeDatabase, getSqlite } from "@/lib/db";
import { getAgentById, getDefaultAgent } from "@/lib/agents/registry";
import {
  extractCronNodes,
  parseWorkflowNodes,
  workflowUsesAgent,
} from "@/lib/agents/workflow-insights";
import { requireOperatorAccess } from "@/lib/security/admin";

export const dynamic = "force-dynamic";

type WorkflowRow = {
  id: string;
  name: string;
  is_active: number | string;
  nodes: string;
};

type CronJobView = {
  workflowId: string;
  workflowName: string;
  workflowActive: boolean;
  nodeId: string;
  label: string;
  expression: string;
  timezone: string;
  isScheduled: boolean;
};

function resolveAgent(agentIdRaw?: string | null) {
  const requested = String(agentIdRaw ?? "").trim();
  if (!requested) {
    return getDefaultAgent();
  }
  const agent = getAgentById(requested);
  if (!agent) {
    throw new Error(`Agent not found: ${requested}`);
  }
  return agent;
}

function mapErrorStatus(error: unknown): number {
  const message = String(error);
  if (message.includes("Agent not found")) return 404;
  return 500;
}

export async function GET(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    initializeDatabase();
    const { searchParams } = new URL(request.url);
    const agent = resolveAgent(searchParams.get("agentId"));
    const defaultAgent = getDefaultAgent();
    const db = getSqlite();

    const rows = db
      .prepare("SELECT id, name, is_active, nodes FROM workflows ORDER BY updated_at DESC")
      .all() as WorkflowRow[];

    const jobs: CronJobView[] = [];
    for (const row of rows) {
      const nodes = parseWorkflowNodes(row.nodes);
      if (!workflowUsesAgent(nodes, agent.id, defaultAgent.id)) continue;
      const workflowActive = Number(row.is_active) === 1;

      const cronNodes = extractCronNodes(nodes);
      for (const cronNode of cronNodes) {
        jobs.push({
          workflowId: row.id,
          workflowName: row.name,
          workflowActive,
          nodeId: cronNode.nodeId,
          label: cronNode.label,
          expression: cronNode.expression,
          timezone: cronNode.timezone,
          isScheduled: workflowActive,
        });
      }
    }

    const totalJobs = jobs.length;
    const scheduledJobs = jobs.filter((job) => job.isScheduled).length;
    const activeWorkflows = new Set(
      jobs.filter((job) => job.workflowActive).map((job) => job.workflowId),
    ).size;

    return NextResponse.json({
      success: true,
      data: {
        agentId: agent.id,
        summary: {
          totalJobs,
          scheduledJobs,
          activeWorkflows,
        },
        jobs,
      },
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: mapErrorStatus(error) });
  }
}
