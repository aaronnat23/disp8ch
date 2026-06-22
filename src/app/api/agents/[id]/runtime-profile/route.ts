import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { getAgentById } from "@/lib/agents/registry";
import { resolveModelRefConfig, getModelConfig } from "@/lib/agents/model-router";
import { checkModelToolSupport } from "@/lib/agents/model-capabilities";
import { getModelContextWindow } from "@/lib/agents/context-windows";
import { requireOperatorAccess } from "@/lib/security/admin";
import type { AgentRuntimeProfile, AgentModelSource } from "@/components/agents/types";

export const dynamic = "force-dynamic";

const HIGH_RISK_TOOL_NAMES = new Set(["bash_exec", "write_file"]);
const STARTUP_FILES = ["SOUL.md", "USER.md", "IDENTITY.md", "TOOLS.md", "MEMORY.md", "BOOT.md"];

function resolveModelSource(agent: {
  modelRef: string | null;
}): { provider: string; modelId: string; source: AgentModelSource } {
  if (!agent.modelRef) {
    // No agent-level override — resolve from global default.
    try {
      const globalConfig = getModelConfig({ agentId: undefined });
      if (globalConfig) {
        return {
          provider: globalConfig.provider,
          modelId: globalConfig.modelId,
          source: "global_default",
        };
      }
    } catch {
      // getModelConfig may fail if no model row exists yet.
    }
    return { provider: "unknown", modelId: "none configured", source: "global_default" };
  }

  // Check if it is a provider:model-id style ref (custom).
  const parts = agent.modelRef.split(":");
  if (parts.length === 2 && parts[0].trim().length > 0 && parts[1].trim().length > 0) {
    const config = resolveModelRefConfig(agent.modelRef);
    if (config) {
      return { provider: config.provider, modelId: config.modelId, source: "custom" };
    }
    return { provider: parts[0].trim(), modelId: parts[1].trim(), source: "custom" };
  }

  // It's a model-row id reference.
  const config = resolveModelRefConfig(agent.modelRef);
  if (config) {
    return { provider: config.provider, modelId: config.modelId, source: "agent_override" };
  }

  return { provider: "unknown", modelId: agent.modelRef, source: "agent_override" };
}

function checkWorkspacePath(workspacePath: string | null): {
  resolved: string | null;
  trusted: boolean;
} {
  if (!workspacePath) {
    return { resolved: null, trusted: false };
  }
  try {
    const exists = fs.existsSync(workspacePath);
    return { resolved: workspacePath, trusted: exists };
  } catch {
    return { resolved: workspacePath, trusted: false };
  }
}

function getStartupFiles(): Record<string, boolean> {
  const workspaceDir = path.join(process.cwd(), "data", "workspace");
  const result: Record<string, boolean> = {};
  for (const filename of STARTUP_FILES) {
    try {
      result[filename] = fs.existsSync(path.join(workspaceDir, filename));
    } catch {
      result[filename] = false;
    }
  }
  return result;
}

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;

    const agentId = params.id;
    const agent = getAgentById(agentId);
    if (!agent) {
      return NextResponse.json({ success: false, error: "Agent not found" }, { status: 404 });
    }

    // Resolve effective model.
    const { provider, modelId, source } = resolveModelSource(agent);

    // Check provider health by tool support lookup (no live call).
    const toolSupport = checkModelToolSupport(provider, modelId);
    const providerHealth: "ok" | "error" | "unknown" =
      toolSupport.status === "unsupported" ? "error"
      : toolSupport.status === "unknown" ? "unknown"
      : "ok";

    // Context window.
    const contextWindow = getModelContextWindow(modelId);

    // Workspace.
    const { resolved: workspacePath, trusted: workspaceTrusted } =
      checkWorkspacePath(agent.workspacePath || null);

    // Tools: count enabled (not disabled).
    // disabledTools is a list of tool names to suppress.
    const disabledSet = new Set(agent.disabledTools ?? []);
    // We can't enumerate all tools without importing the full catalog,
    // so we use the count of explicitly disabled tools as a proxy.
    // enabledToolsCount is a rough estimate: tools enabled = all known - disabled.
    // Use a reasonable known-tools estimate.
    const APPROXIMATE_TOTAL_TOOLS = 40;
    const enabledToolsCount = Math.max(0, APPROXIMATE_TOTAL_TOOLS - disabledSet.size);
    const highRiskToolsEnabled = Array.from(HIGH_RISK_TOOL_NAMES)
      .some((toolName) => !disabledSet.has(toolName));

    // Skills.
    const skillsReady =
      (agent.enabledSkills?.length ?? 0) > 0 ||
      (agent.enabledExtensions?.length ?? 0) > 0;

    // Channels: query DB for configured channels.
    let channelsConfigured = 0;
    try {
      const { getSqlite } = await import("@/lib/db");
      const db = getSqlite();
      const row = db.prepare("SELECT COUNT(*) AS cnt FROM channels WHERE is_active = 1").get() as { cnt: number } | undefined;
      channelsConfigured = row?.cnt ?? 0;
    } catch {
      channelsConfigured = 0;
    }

    // Cron wakeup.
    const hasCronWakeup = Boolean(agent.heartbeatCron);

    // Budget.
    const budgetCap = agent.budgetMonthlyCents ?? null;
    const budgetSpent = agent.spentMonthlyCents ?? null;
    const budgetAction = budgetCap !== null ? (agent.budgetAction ?? "warn") : null;

    // Startup files.
    const startupFiles = getStartupFiles();

    const profile: AgentRuntimeProfile = {
      effectiveProvider: provider,
      effectiveModel: modelId,
      modelSource: source,
      providerHealth,
      toolCallSupport: toolSupport.status !== "unsupported",
      contextWindow,
      workspacePath,
      workspaceTrusted,
      enabledToolsCount,
      highRiskToolsEnabled,
      skillsReady,
      channelsConfigured,
      hasCronWakeup,
      budgetCap,
      budgetSpent,
      budgetAction,
      startupFiles,
    };

    return NextResponse.json({ success: true, data: profile });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
