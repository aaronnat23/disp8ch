import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  createAgent,
  deleteAgent,
  getAgentById,
  getDefaultAgent,
  listAgents,
  updateAgent,
} from "@/lib/agents/registry";
import { getAgentBudgetSummaries, getAgentBudgetSummary } from "@/lib/agents/budgets";
import { logActivity } from "@/lib/governance/activity-log";
import { recordConfigRevision } from "@/lib/governance/config-revisions";
import { requireOperatorAccess } from "@/lib/security/admin";
import { logger } from "@/lib/utils/logger";

export const dynamic = "force-dynamic";
const log = logger.child("api:agents");

const CreateAgentSchema = z.object({
  id: z.string().min(1).max(64).optional(),
  name: z.string().min(1).max(120),
  workspacePath: z.string().min(1).optional(),
  modelRef: z.string().min(1).nullable().optional(),
  modelApiKey: z.string().min(1).max(512).nullable().optional(),
  modelBaseUrl: z.string().url().nullable().optional(),
  systemPrompt: z.string().max(8000).nullable().optional(),
  temperature: z.number().min(0).max(1).nullable().optional(),
  maxTokens: z.number().int().min(1).max(200000).nullable().optional(),
  disabledTools: z.array(z.string().min(1)).optional(),
  enabledToolsets: z.array(z.string().min(1)).optional(),
  enabledExtensions: z.array(z.string().min(1)).optional(),
  enabledSkills: z.array(z.string().min(1)).optional(),
  heartbeatCron: z.string().max(64).nullable().optional(),
  spendCapUsd: z.number().min(0).nullable().optional(),
  spendWindowDays: z.number().int().min(1).max(365).optional(),
  budgetAction: z.enum(["warn", "block"]).optional(),
  budgetMonthlyCents: z.number().int().min(0).nullable().optional(),
  isDefault: z.boolean().optional(),
});

const UpdateAgentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(120).optional(),
  workspacePath: z.string().min(1).optional(),
  modelRef: z.string().min(1).nullable().optional(),
  modelApiKey: z.string().min(1).max(512).nullable().optional(),
  modelBaseUrl: z.string().url().nullable().optional(),
  systemPrompt: z.string().max(8000).nullable().optional(),
  temperature: z.number().min(0).max(1).nullable().optional(),
  maxTokens: z.number().int().min(1).max(200000).nullable().optional(),
  disabledTools: z.array(z.string().min(1)).optional(),
  enabledToolsets: z.array(z.string().min(1)).optional(),
  enabledExtensions: z.array(z.string().min(1)).optional(),
  enabledSkills: z.array(z.string().min(1)).optional(),
  heartbeatCron: z.string().max(64).nullable().optional(),
  spendCapUsd: z.number().min(0).nullable().optional(),
  spendWindowDays: z.number().int().min(1).max(365).optional(),
  budgetAction: z.enum(["warn", "block"]).optional(),
  budgetMonthlyCents: z.number().int().min(0).nullable().optional(),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

function mapErrorStatus(error: unknown): number {
  const message = String(error);
  if (message.includes("not found")) return 404;
  if (message.includes("already exists") || message.includes("cannot be deleted")) return 400;
  return 500;
}

export async function GET(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (id) {
      const agent = getAgentById(id);
      if (!agent) {
        return NextResponse.json({ success: false, error: "Agent not found" }, { status: 404 });
      }
      return NextResponse.json({ success: true, data: { ...agent, budgetSummary: getAgentBudgetSummary(agent) } });
    }

    const agents = listAgents();
    const defaultAgent = getDefaultAgent();
    const budgets = getAgentBudgetSummaries(agents);
    return NextResponse.json({
      success: true,
      data: {
        agents: agents.map((agent) => ({
          ...agent,
          budgetSummary: budgets[agent.id] ?? null,
        })),
        defaultId: defaultAgent.id,
      },
    });
  } catch (error) {
    log.error("GET /api/agents failed", { error: String(error) });
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const body = await request.json();
    const parsed = CreateAgentSchema.parse(body);
    const agent = createAgent(parsed);
    logActivity({ actorType: "user", action: "agent.created", entityType: "agent", entityId: agent.id, details: { name: agent.name } });
    return NextResponse.json({ success: true, data: agent }, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    log.error("POST /api/agents failed", { error: String(error) });
    return NextResponse.json({ success: false, error: String(error) }, { status: mapErrorStatus(error) });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const body = await request.json();
    const parsed = UpdateAgentSchema.parse(body);
    const { id, ...updates } = parsed;
    const before = getAgentById(id);
    const agent = updateAgent(id, updates);
    if (before) {
      const bRec = before as unknown as Record<string, unknown>;
      const aRec = agent as unknown as Record<string, unknown>;
      const changedKeys = Object.keys(updates).filter(k => {
        return JSON.stringify(bRec[k]) !== JSON.stringify(aRec[k]);
      });
      if (changedKeys.length > 0) {
        const beforeSnap: Record<string, unknown> = {};
        const afterSnap: Record<string, unknown> = {};
        for (const k of changedKeys) {
          beforeSnap[k] = bRec[k];
          afterSnap[k] = aRec[k];
        }
        recordConfigRevision({ agentId: id, changedKeys, beforeSnapshot: beforeSnap, afterSnapshot: afterSnap });
      }
    }
    logActivity({ actorType: "user", action: "agent.updated", entityType: "agent", entityId: id, details: { updatedFields: Object.keys(updates) } });
    return NextResponse.json({ success: true, data: agent });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: String(error) }, { status: mapErrorStatus(error) });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) {
      return NextResponse.json({ success: false, error: "Missing id" }, { status: 400 });
    }
    deleteAgent(id);
    logActivity({ actorType: "user", action: "agent.deleted", entityType: "agent", entityId: id });
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: mapErrorStatus(error) });
  }
}
