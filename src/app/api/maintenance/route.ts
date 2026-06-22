import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { getSqlite, initializeDatabase } from "@/lib/db";
import { listAgents } from "@/lib/agents/registry";
import { listPendingApprovals } from "@/lib/engine/tools";
import {
  WORKSPACE_BOOTSTRAP_FILE_NAMES,
  getWorkspaceDir,
  WORKSPACE_PATH,
  collectStartupContext,
  simulateContextBudget,
  STARTUP_CONTEXT_MAX_CHARS,
  detectStaleMemoryEntries,
} from "@/lib/workspace/files";
import type { ContextBudgetReport, StaleMemoryEntry } from "@/lib/workspace/files";
import { listScheduledCronJobs } from "@/lib/cron/manager";
import { requireOperatorAccess } from "@/lib/security/admin";

export const dynamic = "force-dynamic";

// ── Thresholds ────────────────────────────────────────────────────────────────
const FILE_WARN_CHARS = 8_000;
const FILE_CRITICAL_CHARS = 20_000;
const TOTAL_WARN_CHARS = 40_000;
const STALE_EXECUTION_MS = 30 * 60 * 1_000; // 30 min

// ── Types ─────────────────────────────────────────────────────────────────────
export type FileStat = {
  name: string;
  chars: number;
  lines: number;
  severity: "ok" | "warn" | "critical";
  missing: boolean;
};

export type WorkspaceReport = {
  agentId: string;
  agentName: string;
  workspacePath: string;
  totalChars: number;
  totalSeverity: "ok" | "warn" | "critical";
  files: FileStat[];
};

export type CronReport = {
  workflowId: string;
  workflowName: string;
  isLive: boolean;
  expression: string;
  enabled: boolean;
};

export type DbReport = {
  staleExecutions: number;
  lockedTasks: number;
  pendingApprovals: number;
};

export type ContextBudgetSummary = {
  agentId: string;
  agentName: string;
  report: ContextBudgetReport;
};

export type StaleMemorySummary = {
  agentId: string;
  agentName: string;
  staleCount: number;
  entries: StaleMemoryEntry[];
};

export type MaintenanceReport = {
  generatedAt: string;
  overallSeverity: "ok" | "warn" | "critical";
  workspace: WorkspaceReport[];
  contextBudget: ContextBudgetSummary[];
  staleMemory: StaleMemorySummary[];
  cron: CronReport[];
  db: DbReport;
  suggestions: string[];
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function fileSeverity(chars: number): "ok" | "warn" | "critical" {
  if (chars >= FILE_CRITICAL_CHARS) return "critical";
  if (chars >= FILE_WARN_CHARS) return "warn";
  return "ok";
}

function maxSeverity(a: "ok" | "warn" | "critical", b: "ok" | "warn" | "critical"): "ok" | "warn" | "critical" {
  if (a === "critical" || b === "critical") return "critical";
  if (a === "warn" || b === "warn") return "warn";
  return "ok";
}

function scanWorkspaceDir(agentId: string, agentName: string, workspacePath: string): WorkspaceReport {
  const files: FileStat[] = [];
  let totalChars = 0;
  let totalSeverity: "ok" | "warn" | "critical" = "ok";

  for (const name of WORKSPACE_BOOTSTRAP_FILE_NAMES) {
    const filePath = path.join(workspacePath, name);
    if (!fs.existsSync(filePath)) {
      files.push({ name, chars: 0, lines: 0, severity: "ok", missing: true });
      continue;
    }
    let content = "";
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      files.push({ name, chars: 0, lines: 0, severity: "ok", missing: true });
      continue;
    }
    const chars = content.length;
    const lines = content.split("\n").length;
    const severity = fileSeverity(chars);
    totalChars += chars;
    totalSeverity = maxSeverity(totalSeverity, severity);
    files.push({ name, chars, lines, severity, missing: false });
  }

  if (totalChars >= TOTAL_WARN_CHARS && totalSeverity === "ok") {
    totalSeverity = "warn";
  }

  return { agentId, agentName, workspacePath, totalChars, totalSeverity, files };
}

// ── Route ─────────────────────────────────────────────────────────────────────
export async function GET(request: Request) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const url = new URL(request.url);
    const scope = String(url.searchParams.get("scope") || "global").trim().toLowerCase();
    const detail = String(url.searchParams.get("detail") || "lite").trim().toLowerCase();
    const includeHeavyChecks = detail === "full" || scope === "all";
    initializeDatabase();
    const db = getSqlite();

    // ── 1. Workspace file bloat scan ─────────────────────────────────────────
    const workspaceReports: WorkspaceReport[] = [];

    // Global workspace
    const globalWsPath = path.resolve(WORKSPACE_PATH);
    workspaceReports.push(scanWorkspaceDir("global", "Global Workspace", globalWsPath));

    // Per-agent workspaces. Default to the global workspace only because some
    // installs accumulate thousands of imported/test agents, which makes a
    // full scan too expensive for an operator dashboard refresh.
    let agents: ReturnType<typeof listAgents> = [];
    let scannedAgentWorkspaces = 0;
    let skippedAgentWorkspaces = 0;
    if (scope === "all") {
      try {
        agents = listAgents();
      } catch {
        agents = [];
      }
      for (const agent of agents) {
        const wsPath = path.resolve(agent.workspacePath);
        if (wsPath === globalWsPath) continue; // deduplicate
        workspaceReports.push(scanWorkspaceDir(agent.id, agent.name, wsPath));
        scannedAgentWorkspaces += 1;
      }
    } else {
      try {
        agents = listAgents();
        skippedAgentWorkspaces = Math.max(
          0,
          agents.filter((agent) => path.resolve(agent.workspacePath) !== globalWsPath).length,
        );
      } catch {
        skippedAgentWorkspaces = 0;
      }
    }

    // ── 2. Cron health ────────────────────────────────────────────────────────
    const cronReports: CronReport[] = [];
    if (includeHeavyChecks) {
      const liveJobs = listScheduledCronJobs();
      const liveSet = new Set(liveJobs.map((j) => `${j.workflowId}::${j.nodeId}`));

      type WfRow = { id: string; name: string; is_active: number; nodes: string | null };
      const wfRows = db.prepare("SELECT id, name, is_active, nodes FROM workflows").all() as WfRow[];

      for (const wf of wfRows) {
        if (!wf.is_active) continue;
        let nodes: Array<{ type?: string; id?: string; data?: { expression?: string } }> = [];
        try {
          nodes = JSON.parse(wf.nodes ?? "[]") as typeof nodes;
        } catch {
          continue;
        }
        for (const node of nodes) {
          if (node.type !== "cron-trigger") continue;
          const isLive = liveSet.has(`${wf.id}::${node.id}`);
          cronReports.push({
            workflowId: wf.id,
            workflowName: wf.name,
            isLive,
            expression: node.data?.expression ?? "",
            enabled: true,
          });
        }
      }
    }

    // ── 3. DB integrity ───────────────────────────────────────────────────────
    const staleThreshold = new Date(Date.now() - STALE_EXECUTION_MS).toISOString();
    const staleExec = (
      db
        .prepare("SELECT COUNT(*) as c FROM executions WHERE status = 'running' AND started_at < ?")
        .get(staleThreshold) as { c: number }
    ).c;

    let lockedTasks = 0;
    try {
      lockedTasks = (
        db
          .prepare("SELECT COUNT(*) as c FROM board_tasks WHERE execution_locked_at IS NOT NULL AND status != 'done'")
          .get() as { c: number }
      ).c;
    } catch {
      // column may not exist on older DBs
    }

    const pendingApprovals = includeHeavyChecks ? listPendingApprovals().length : 0;

    // ── 4. Context budget simulation ──────────────────────────────────────────
    const contextBudgetSummaries: ContextBudgetSummary[] = [];
    try {
      const globalBundle = collectStartupContext({ workspacePath: globalWsPath });
      contextBudgetSummaries.push({
        agentId: "global",
        agentName: "Global Workspace",
        report: simulateContextBudget(globalBundle),
      });
      for (const agent of agents) {
        const wsPath = path.resolve(agent.workspacePath);
        if (wsPath === globalWsPath) continue;
        try {
          const bundle = collectStartupContext({ workspacePath: wsPath });
          contextBudgetSummaries.push({
            agentId: agent.id,
            agentName: agent.name,
            report: simulateContextBudget(bundle),
          });
        } catch {
          // agent workspace may be missing; skip
        }
      }
    } catch {
      // startup context load failure — skip budget checks
    }

    // ── 5. Stale memory entry scan ─────────────────────────────────────────
    const staleMemorySummaries: StaleMemorySummary[] = [];
    try {
      const globalStale = detectStaleMemoryEntries({ workspacePath: globalWsPath });
      if (globalStale.length > 0) {
        staleMemorySummaries.push({
          agentId: "global",
          agentName: "Global Workspace",
          staleCount: globalStale.length,
          entries: globalStale.slice(0, 20),
        });
      }
      for (const agent of agents) {
        const wsPath = path.resolve(agent.workspacePath);
        if (wsPath === globalWsPath) continue;
        try {
          const agentStale = detectStaleMemoryEntries({ workspacePath: wsPath });
          if (agentStale.length > 0) {
            staleMemorySummaries.push({
              agentId: agent.id,
              agentName: agent.name,
              staleCount: agentStale.length,
              entries: agentStale.slice(0, 10),
            });
          }
        } catch {
          // agent workspace may be missing; skip
        }
      }
    } catch {
      // stale scan failure — skip gracefully
    }

    // ── 6. Overall severity + suggestions ────────────────────────────────────
    const suggestions: string[] = [];
    let overallSeverity: "ok" | "warn" | "critical" = "ok";

    for (const report of workspaceReports) {
      overallSeverity = maxSeverity(overallSeverity, report.totalSeverity);
      for (const f of report.files) {
        if (f.severity === "critical") {
          suggestions.push(
            `[CRITICAL] ${report.agentName} / ${f.name} is very large (${Math.round(f.chars / 1000)}k chars). Prune outdated entries or split into dated memory files.`,
          );
        } else if (f.severity === "warn") {
          suggestions.push(
            `[WARN] ${report.agentName} / ${f.name} is getting large (${Math.round(f.chars / 1000)}k chars). Consider trimming stale entries.`,
          );
        }
      }
      if (report.totalChars >= TOTAL_WARN_CHARS) {
        suggestions.push(
          `[WARN] ${report.agentName} total bootstrap budget is ${Math.round(report.totalChars / 1000)}k chars — may slow context loading.`,
        );
      }
    }

    const deadCron = cronReports.filter((c) => !c.isLive);
    if (deadCron.length > 0) {
      overallSeverity = maxSeverity(overallSeverity, "warn");
      for (const c of deadCron) {
        suggestions.push(`[WARN] Cron workflow "${c.workflowName}" has a cron-trigger node that is not live in the scheduler. Try POST /api/cron { action:"resync" }.`);
      }
    }

    if (staleExec > 0) {
      overallSeverity = maxSeverity(overallSeverity, "warn");
      suggestions.push(`[WARN] ${staleExec} execution(s) stuck in "running" state for >30 min. Check the Activity log.`);
    }

    if (lockedTasks > 0) {
      overallSeverity = maxSeverity(overallSeverity, "warn");
      suggestions.push(`[WARN] ${lockedTasks} board task(s) locked by a workflow that may have crashed. Inspect and manually unlock if needed.`);
    }

    if (pendingApprovals > 0) {
      suggestions.push(`[INFO] ${pendingApprovals} tool approval request(s) pending in the Approvals queue.`);
    }

    for (const budget of contextBudgetSummaries) {
      if (!budget.report.overBudget) continue;
      const truncated = budget.report.entries.filter((e) => e.truncatedChars > 0);
      if (truncated.length === 0) continue;
      const budgetK = Math.round(STARTUP_CONTEXT_MAX_CHARS / 1000);
      const actualK = Math.round(budget.report.totalActual / 1000);
      const fileList = truncated
        .map((e) => `${e.path} (${e.percentSurviving}% surviving)`)
        .join(", ");
      suggestions.push(
        `[WARN] ${budget.agentName} startup files total ${actualK}k chars but only ${budgetK}k are injected. Truncated: ${fileList}. Prune low-value entries to avoid losing agent personality.`,
      );
      overallSeverity = maxSeverity(overallSeverity, "warn");
    }

    for (const sm of staleMemorySummaries) {
      if (sm.staleCount > 0) {
        suggestions.push(
          `[INFO] ${sm.agentName} has ${sm.staleCount} stale MEMORY.md entries (old dates, missing file refs, or empty notes). Review and prune to free context budget.`,
        );
      }
    }

    if (suggestions.length === 0) {
      suggestions.push("All systems look healthy. No maintenance needed right now.");
    }

    if (scope !== "all" && skippedAgentWorkspaces > 0) {
      suggestions.push(
        `[WARN] Per-agent workspace scan skipped ${skippedAgentWorkspaces} agent workspace${skippedAgentWorkspaces === 1 ? "" : "s"} for speed. Re-run with \`/api/maintenance?scope=all\` for the full sweep.`,
      );
    }
    if (!includeHeavyChecks) {
      suggestions.push(
        "[INFO] Heavy maintenance checks (cron liveness and pending approvals) were skipped for speed. Re-run with `/api/maintenance?detail=full` for the full report.",
      );
    }

    const report: MaintenanceReport = {
      generatedAt: new Date().toISOString(),
      overallSeverity,
      workspace: workspaceReports,
      contextBudget: contextBudgetSummaries,
      staleMemory: staleMemorySummaries,
      cron: cronReports,
      db: { staleExecutions: staleExec, lockedTasks, pendingApprovals },
      suggestions,
    };

    return NextResponse.json({
      success: true,
      data: report,
      meta: {
        scope,
        detail,
        scannedAgentWorkspaces,
        skippedAgentWorkspaces,
      },
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
