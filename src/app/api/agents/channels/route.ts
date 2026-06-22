import { NextRequest, NextResponse } from "next/server";
import { initializeDatabase, getSqlite } from "@/lib/db";
import { getAgentById, getDefaultAgent } from "@/lib/agents/registry";
import { getTelegramStatus } from "@/lib/channels/telegram";
import { getDiscordStatus } from "@/lib/channels/discord";
import { getWhatsAppStatus } from "@/lib/channels/whatsapp";
import {
  extractOutputChannels,
  extractTriggerChannels,
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

type ChannelCoverage = {
  triggeredWorkflows: number;
  outboundWorkflows: number;
};

type WorkflowRoute = {
  id: string;
  name: string;
  isActive: boolean;
  triggers: string[];
  outputs: string[];
};

type ChannelStatus = {
  id: string;
  label: string;
  connected: boolean | null;
  statusText: string;
  triggeredWorkflows: number;
  outboundWorkflows: number;
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

function createCoverageMap(routes: WorkflowRoute[]): Record<string, ChannelCoverage> {
  const coverage: Record<string, ChannelCoverage> = {};
  for (const route of routes) {
    for (const channel of route.triggers) {
      if (!coverage[channel]) {
        coverage[channel] = { triggeredWorkflows: 0, outboundWorkflows: 0 };
      }
      coverage[channel].triggeredWorkflows += 1;
    }
    for (const channel of route.outputs) {
      if (!coverage[channel]) {
        coverage[channel] = { triggeredWorkflows: 0, outboundWorkflows: 0 };
      }
      coverage[channel].outboundWorkflows += 1;
    }
  }
  return coverage;
}

function buildChannelStatuses(
  coverage: Record<string, ChannelCoverage>,
): ChannelStatus[] {
  const telegram = getTelegramStatus();
  const discord = getDiscordStatus();
  const whatsapp = getWhatsAppStatus();

  const statusMap: Record<string, Omit<ChannelStatus, "triggeredWorkflows" | "outboundWorkflows">> = {
    webchat: {
      id: "webchat",
      label: "WebChat",
      connected: true,
      statusText: "Always available",
    },
    telegram: {
      id: "telegram",
      label: "Telegram",
      connected: telegram.connected,
      statusText: telegram.connected ? `Connected @${telegram.username || "bot"}` : "Not connected",
    },
    discord: {
      id: "discord",
      label: "Discord",
      connected: discord.connected,
      statusText: discord.connected ? `Connected ${discord.username || "bot"}` : "Not connected",
    },
    whatsapp: {
      id: "whatsapp",
      label: "WhatsApp",
      connected: whatsapp.connected,
      statusText: whatsapp.connected ? `Connected ${whatsapp.phoneNumber || ""}`.trim() : "Not connected",
    },
    email: {
      id: "email",
      label: "Email",
      connected: null,
      statusText: "Per-node SMTP settings",
    },
    webhook: {
      id: "webhook",
      label: "Webhook",
      connected: null,
      statusText: "Endpoint-based trigger",
    },
  };

  const ids = new Set<string>([
    ...Object.keys(statusMap),
    ...Object.keys(coverage),
  ]);

  return [...ids]
    .map((id) => {
      const base = statusMap[id] ?? {
        id,
        label: id,
        connected: null,
        statusText: "Unknown",
      };
      const counts = coverage[id] ?? { triggeredWorkflows: 0, outboundWorkflows: 0 };
      return {
        ...base,
        triggeredWorkflows: counts.triggeredWorkflows,
        outboundWorkflows: counts.outboundWorkflows,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
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

    const workflows: WorkflowRoute[] = [];
    for (const row of rows) {
      const nodes = parseWorkflowNodes(row.nodes);
      if (!workflowUsesAgent(nodes, agent.id, defaultAgent.id)) continue;
      workflows.push({
        id: row.id,
        name: row.name,
        isActive: Number(row.is_active) === 1,
        triggers: extractTriggerChannels(nodes),
        outputs: extractOutputChannels(nodes),
      });
    }

    const coverage = createCoverageMap(workflows);
    const channels = buildChannelStatuses(coverage);

    return NextResponse.json({
      success: true,
      data: {
        agentId: agent.id,
        channels,
        workflows,
      },
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: mapErrorStatus(error) });
  }
}
