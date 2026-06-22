/**
 * Deterministic app-command registry.
 * Known direct commands bypass the LLM planner and execute directly.
 * The planner is a fallback for ambiguous multi-step prompts.
 */

export type AppCommandRisk = "read" | "direct-write" | "confirm-write" | "destructive" | "sensitive";

export interface AppCommandContext {
  sessionId: string;
  channel: string;
  message: string;
}

export interface AppCommandEntry {
  id: string;
  domain: string;
  patterns: RegExp[];
  risk: AppCommandRisk;
  handler: (message: string, ctx: AppCommandContext) => Promise<AppCommandResult | null>;
  requiresExactTarget: boolean;
  clearsPendingMutation: boolean;
}

export type AppCommandResult = {
  response: string;
  source: "app-command-registry";
  workflowId?: string | null;
  workflowName?: string | null;
  pendingMutation?: boolean;
  risk: AppCommandRisk;
};

const registry: AppCommandEntry[] = [];

export function registerAppCommand(entry: AppCommandEntry): void {
  const existing = registry.findIndex(e => e.id === entry.id);
  if (existing >= 0) registry[existing] = entry;
  else registry.push(entry);
}

export function matchAppCommand(message: string): AppCommandEntry | null {
  for (const entry of registry) {
    for (const pattern of entry.patterns) {
      if (pattern.test(message)) {
        return entry;
      }
    }
  }
  return null;
}

export function getAppCommandRegistry(): readonly AppCommandEntry[] {
  return registry;
}

// ── Built-in commands ──

// 1. Start/run/execute research for existing org
registerAppCommand({
  id: "run-org-execution",
  domain: "orgs",
  patterns: [
    /(?:start|run|execute|begin|launch)\s+(?:the\s+)?(?:research|analysis|task|work|execution|investigation|study|survey)\s+(?:for|using|with|on)\s+(.+?)\s*(?:org|organization|team|crew)\b/i,
    /(?:start|run|execute|launch)\s+(.+?)\s*(?:org|organization|team|crew)\s+(?:to\s+)?(?:research|analyze|investigate|study|work on|run)/i,
  ],
  risk: "direct-write",
  requiresExactTarget: true,
  clearsPendingMutation: true,
  handler: async (message, ctx) => {
    const orgMatch = message.match(/for\s+(.+?)\s+org|with\s+(.+?)\s+org|using\s+(.+?)\s+org/i);
    const orgName = (orgMatch?.[1] || orgMatch?.[2] || orgMatch?.[3])?.trim();
    if (!orgName) return null;

    const topicMatch = message.match(/(?:about|on|to|for|research|analyze|investigate)\s+(.+?)(?:\s*$|\s+(?:using|with|for))/i);
    const topic = topicMatch?.[1]?.trim() || "research";

    const { runOrganizationCollaborationTask } = await import("@/lib/channels/router");
    const response = await runOrganizationCollaborationTask({
      rawMessage: message,
      topic,
      organizationRef: orgName,
      explicitMode: "execution",
      ctx: { channel: ctx.channel, sender: "webchat", sessionId: ctx.sessionId },
    });

    return {
      response,
      source: "app-command-registry",
      risk: "direct-write",
    };
  },
});

// 2. Switch active org
registerAppCommand({
  id: "switch-org",
  domain: "orgs",
  patterns: [
    /(?:switch|set|change|use)\s+(?:active\s+)?(?:org|organization)\s+to\s+(.+)/i,
    /select\s+(.+?)\s*(?:org|organization)/i,
  ],
  risk: "direct-write",
  requiresExactTarget: true,
  clearsPendingMutation: true,
  handler: async (message, _ctx) => {
    const match = message.match(/(?:switch|set|change|use)\s+(?:active\s+)?(?:org|organization)\s+to\s+(.+)/i)
      || message.match(/select\s+(.+?)\s*(?:org|organization)/i);
    const orgName = match?.[1]?.trim();
    if (!orgName) return null;

    const { applyHierarchyOrganization } = await import("@/lib/hierarchy/organizations");
    const org = applyHierarchyOrganization(orgName);

    return {
      response: `Switched active organization to "${org.name}".`,
      source: "app-command-registry",
      risk: "direct-write",
    };
  },
});

// 3. Run existing workflow
registerAppCommand({
  id: "run-workflow",
  domain: "workflows",
  patterns: [
    /^\s*(?:run|execute|start|trigger)\s+(?:the\s+)?(?:workflow\s+|automation\s+)?(?:named\s+)?["\u201C]?(.+?)["\u201D]?(?:\s*(?:workflow|now))?$/i,
    /^\s*(?:run|execute)\s+(?:workflow\s+)?["\u201C]?(.+?)["\u201D]?\s*(?:workflow|now)?$/i,
  ],
  risk: "direct-write",
  requiresExactTarget: true,
  clearsPendingMutation: true,
  handler: async (message, ctx) => {
    const match = message.match(/(?:run|execute|start|trigger)\s+(?:the\s+)?(?:workflow\s+)?["\u201C]?(.+?)["\u201D]?(?:\s*(?:workflow|now))?$/i);
    const wfName = match?.[1]?.trim();
    if (!wfName) return null;

    const { getSqlite } = require("@/lib/db") as typeof import("@/lib/db");
    const db = getSqlite();
    const wf = db.prepare("SELECT id, name FROM workflows WHERE name = ? AND is_active = 1 LIMIT 1").get(wfName) as { id: string; name: string } | undefined;
    // Return null, not a "not found" message — a false-positive match on a
    // multi-step prompt ("…run a 70B local model") must hand off to the tool
    // lane instead of returning a confusing stub. Genuine misses also benefit:
    // the LLM with tools can check the workflow list and suggest alternatives.
    if (!wf) return null;

    const { executeWorkflow } = await import("@/lib/engine/executor");
    const { getModelConfig } = await import("@/lib/agents/model-router");
    executeWorkflow({
      workflowId: wf.id,
      nodes: [],
      edges: [],
      triggerType: "manual",
      triggerData: { message: ctx.message },
      modelConfig: getModelConfig({}),
      clientTurnId: ctx.sessionId,
    });

    return {
      response: `Started workflow "${wf.name}". Check Activity for progress.`,
      source: "app-command-registry",
      risk: "direct-write",
    };
  },
});

// 4. Validate channel connection
registerAppCommand({
  id: "validate-channel",
  domain: "channels",
  patterns: [
    /(?:validate|check|test|diagnose)\s+(.+?)\s+(?:channel\s+)?connection/i,
    /is\s+(.+?)\s+(?:connected|working|online|up|alive)/i,
  ],
  risk: "read",
  requiresExactTarget: true,
  clearsPendingMutation: true,
  handler: async (message, _ctx) => {
    const match = message.match(/(?:validate|check|test|diagnose)\s+(.+?)\s+(?:channel\s+)?connection/i);
    const channel = match?.[1]?.trim().toLowerCase();
    if (!channel) return null;

    try {
      const { runChannelDoctor, formatChannelDoctorReport } = await import("@/lib/channels/channel-doctor");
      const report = runChannelDoctor();
      const formatted = formatChannelDoctorReport(report);
      return { response: formatted, source: "app-command-registry", risk: "read" };
    } catch {
      return { response: `Channel "${channel}" status: could not validate. Check Channels tab for configuration.`, source: "app-command-registry", risk: "read" };
    }
  },
});

// 5. Show/open/list app surfaces (read-only)
registerAppCommand({
  id: "show-surface",
  domain: "app",
  patterns: [
    /^(?:show|open|list|display|view|go to|navigate to)\s+(.+)$/i,
    /^(?:take me to|bring up|pull up|let me see)\s+(.+)$/i,
    /^(?:what(?:'s|\s+is)\s+on|show me)\s+(.+)$/i,
  ],
  risk: "read",
  requiresExactTarget: false,
  clearsPendingMutation: false,
  handler: async (message, _ctx) => {
    const match = message.match(/^(?:show|open|list|display|view|go to|navigate to|take me to|bring up|pull up|let me see)\s+(.+)$/i);
    const surface = match?.[1]?.trim().toLowerCase();
    if (!surface) return null;
    // Decline status/report/builtin-style commands — these have dedicated
    // handlers (e.g. "show learning status", "list learning candidates",
    // "show config"). A bare "Opening ..." stub would shadow the real report.
    if (/\b(status|candidates?|queue|snapshot|config|configuration|commands?|setup)\b/.test(surface)
      || /^(?:tasks?|board tasks?|agents?|models?|tools?|documents?|docs?|data sources?|schedules?|cron jobs?|automations?|secrets?|memory)$/.test(surface)
      || /\b(skills?|extensions?)\s+for\b/.test(surface)) {
      return null;
    }
    return { response: `Opening ${surface}...`, source: "app-command-registry", risk: "read" };
  },
});

// 6. One exact board task
registerAppCommand({
  id: "create-board-task",
  domain: "boards",
  patterns: [
    /(?:add|create|make)\s+(?:a\s+)?(?:task|board task|todo)\s+(?:called|named|titled)\s+["\u201C]?(.+?)["\u201D]?(?:\s*$|\s+on\s+|\s+in\s+)/i,
    /task:\s*(.+)/i,
  ],
  risk: "direct-write",
  requiresExactTarget: true,
  clearsPendingMutation: false,
  handler: async (message, _ctx) => {
    const match = message.match(/(?:add|create|make)\s+(?:a\s+)?(?:task|board task|todo)\s+(?:called|named|titled)\s+["\u201C]?(.+?)["\u201D]?(?:\s*$|\s+on\s+|\s+in\s+)/i)
      || message.match(/task:\s*(.+)/i);
    const title = match?.[1]?.trim();
    if (!title) return null;

    const { getSqlite } = require("@/lib/db") as typeof import("@/lib/db");
    const db = getSqlite();
    const { nanoid } = await import("nanoid");
    const taskId = nanoid(8);
    const now = new Date().toISOString();
    db.prepare("INSERT INTO board_tasks(id, board_id, title, status, priority, created_at, updated_at) VALUES(?, 'main-board', ?, 'inbox', 'medium', ?, ?)")
      .run(taskId, title, now, now);

    return {
      response: `Created board task: "${title}" (status: inbox).`,
      source: "app-command-registry",
      risk: "direct-write",
    };
  },
});

// 7. Run schedule now
registerAppCommand({
  id: "run-schedule-now",
  domain: "scheduler",
  patterns: [
    /(?:run|execute|trigger|fire)\s+(?:schedule|cron\s+job)\s+["\u201C]?(.+?)["\u201D]?\s*(?:now|immediately|right now)/i,
  ],
  risk: "direct-write",
  requiresExactTarget: true,
  clearsPendingMutation: true,
  handler: async (message, ctx) => {
    const match = message.match(/(?:run|execute|trigger|fire)\s+(?:schedule|cron\s+job)\s+["\u201C]?(.+?)["\u201D]?\s*(?:now|immediately|right now)/i);
    const scheduleName = match?.[1]?.trim();
    if (!scheduleName) return null;

    const { getSqlite } = require("@/lib/db") as typeof import("@/lib/db");
    const db = getSqlite();
    const wf = db.prepare("SELECT id, name FROM workflows WHERE name = ? AND is_active = 1 AND nodes LIKE '%cron-trigger%' LIMIT 1").get(scheduleName) as { id: string; name: string } | undefined;
    if (!wf) return { response: `Schedule "${scheduleName}" not found.`, source: "app-command-registry", risk: "read" };

    const { executeWorkflow } = await import("@/lib/engine/executor");
    const { getModelConfig } = await import("@/lib/agents/model-router");
    executeWorkflow({
      workflowId: wf.id,
      nodes: [],
      edges: [],
      triggerType: "manual",
      triggerData: { message: ctx.message },
      modelConfig: getModelConfig({}),
    });

    return {
      response: `Fired schedule "${wf.name}" now.`,
      source: "app-command-registry",
      risk: "direct-write",
    };
  },
});

// 8. Refresh/resync
registerAppCommand({
  id: "refresh-surface",
  domain: "app",
  patterns: [
    /^(?:refresh|reload|resync|update)\s+(.+)$/i,
  ],
  risk: "read",
  requiresExactTarget: false,
  clearsPendingMutation: false,
  handler: async (message, _ctx) => {
    const match = message.match(/^(?:refresh|reload|resync|update)\s+(.+)$/i);
    const surface = match?.[1]?.trim();
    return {
      response: `Refreshed ${surface || "app state"}.`,
      source: "app-command-registry",
      risk: "read",
    };
  },
});

// 9. Explicit dynamic-workflow controls.
// This is a structural fallback for named dynamic-workflow operations; open-ended
// work still routes through the universal/app-action planner.
registerAppCommand({
  id: "dynamic-workflow-direct-control",
  domain: "workflow",
  patterns: [
    /\bdynamic\s+workflow\b/i,
    /\bproject\s+manager\s+agent\s+harness\b/i,
    /^save\s+(?:this|the)\s+(?:successful\s+)?run\s+as\s+\/?[a-z0-9_.-]+\.?$/i,
  ],
  risk: "read",
  requiresExactTarget: false,
  clearsPendingMutation: false,
  handler: async (message, ctx) => {
    const normalized = String(message || "").trim();
    const lower = normalized.toLowerCase();

    if (/\bproject\s+manager\s+agent\s+harness\b/i.test(normalized)) {
      const { applyHarnessTemplate } = await import("@/lib/dynamic-workflows/harness-templates");
      const plan = applyHarnessTemplate("project-manager-harness", {
        projectName: "Current Repository",
        repoLocalPath: process.cwd(),
        appUrl: process.env.NEXT_PUBLIC_APP_URL || "http://127.0.0.1:3100",
        maxConcurrency: 4,
        budgetLimitUsd: 5,
      });
      const workerCount = plan.phases.reduce((sum, phase) => sum + phase.workers.length, 0);
      const phaseLines = plan.phases
        .map((phase, index) => `${index + 1}. ${phase.name} — ${phase.workers.length} worker${phase.workers.length === 1 ? "" : "s"}`)
        .join("\n");
      return {
        response:
          `Project Manager Agent Harness plan ready.\n\n` +
          `This is a dynamic workflow harness for the current repo in read-only mode unless you explicitly approve writes.\n\n` +
          `Phases: ${plan.phases.length}; workers: ${workerCount}; max concurrency: ${plan.limits.maxConcurrency}; budget: $${plan.limits.budgetLimitUsd ?? 0}.\n\n` +
          phaseLines +
          "\n\nVerification includes command checks, browser checks, screenshots, and final synthesis. Ask me to create the run when you want it queued.",
        source: "app-command-registry",
        risk: "read",
      };
    }

    if (/\b(?:pause|halt|suspend)\b/.test(lower)) {
      const { listRuns } = await import("@/lib/dynamic-workflows/store");
      const { pauseRun } = await import("@/lib/dynamic-workflows/runner");
      const target = listRuns({ status: "running", limit: 1 })[0] ?? null;
      if (!target) {
        return {
          response: "Nothing to pause: no active dynamic workflow run is currently running. Use `/loop status` to inspect recent runs.",
          source: "app-command-registry",
          risk: "read",
        };
      }
      pauseRun(target.id);
      return {
        response: `Paused dynamic workflow run "${target.name}". Use \`/loop status\` to inspect it or \`/loop resume\` to continue.`,
        source: "app-command-registry",
        risk: "confirm-write",
      };
    }

    if (/\bresume\b/.test(lower)) {
      const { listRuns } = await import("@/lib/dynamic-workflows/store");
      const { resumeRun } = await import("@/lib/dynamic-workflows/runner");
      const target = listRuns({ status: "paused", limit: 1 })[0] ?? null;
      if (!target) {
        return {
          response: "No paused dynamic workflow run is available to resume. Use `/loop status` to inspect recent runs.",
          source: "app-command-registry",
          risk: "read",
        };
      }
      await resumeRun(target.id);
      return {
        response: `Resumed dynamic workflow run "${target.name}". Use \`/loop status\` to monitor progress.`,
        source: "app-command-registry",
        risk: "confirm-write",
      };
    }

    if (/\b(?:cancel|stop)\b/.test(lower)) {
      const { listRuns } = await import("@/lib/dynamic-workflows/store");
      const { cancelRun } = await import("@/lib/dynamic-workflows/runner");
      const target =
        listRuns({ status: "running", limit: 1 })[0] ??
        listRuns({ status: "paused", limit: 1 })[0] ??
        listRuns({ status: "queued", limit: 1 })[0] ??
        null;
      if (!target) {
        return {
          response: "No active dynamic workflow run is available to cancel. Use `/loop status` to inspect recent runs.",
          source: "app-command-registry",
          risk: "read",
        };
      }
      cancelRun(target.id);
      return {
        response: `Cancelled dynamic workflow run "${target.name}".`,
        source: "app-command-registry",
        risk: "confirm-write",
      };
    }

    if (/\bsave\b.+\brun\b.+\bas\b/i.test(normalized)) {
      const commandMatch = normalized.match(/\bas\s+\/?([a-z0-9_.-]+)/i);
      const commandName = commandMatch?.[1]?.trim().replace(/[.,;:!?]+$/, "");
      if (!commandName) {
        return {
          response: "Tell me the command name to save, for example `Save this successful run as /repo-audit`.",
          source: "app-command-registry",
          risk: "read",
        };
      }

      const { listRuns } = await import("@/lib/dynamic-workflows/store");
      const { saveRunAsCommand } = await import("@/lib/dynamic-workflows/commands");
      const target = listRuns({ status: "completed", limit: 1 })[0] ?? null;
      if (!target) {
        return {
          response: `No completed dynamic workflow run is available to save as \`/${commandName}\`. Run \`/loop status\` to inspect recent runs.`,
          source: "app-command-registry",
          risk: "read",
        };
      }

      try {
        const command = saveRunAsCommand(target.id, commandName);
        return {
          response: `Saved dynamic workflow run "${target.name}" as \`/${command.name}\`. You can reuse it from the Dynamic Runs command list.`,
          source: "app-command-registry",
          risk: "confirm-write",
        };
      } catch (err) {
        return {
          response: `Could not save \`/${commandName}\`: ${String(err)}`,
          source: "app-command-registry",
          risk: "read",
        };
      }
    }

    const objective = normalized
      .replace(/^(?:please\s+)?(?:use|plan|create|start)\s+(?:a\s+)?dynamic\s+workflow\s+(?:to|for|that)?\s*/i, "")
      .replace(/\.$/, "")
      .trim() || normalized;

    const { generatePlanOutline } = await import("@/lib/dynamic-workflows/planner");
    const result = generatePlanOutline(objective, { sessionId: ctx.sessionId });
    const plan = result.plan;
    if (!plan) {
      return {
        response: `Could not generate a dynamic workflow plan for "${objective}". ${result.summary}`,
        source: "app-command-registry",
        risk: "read",
      };
    }

    const workerCount = plan.phases.reduce((sum, phase) => sum + phase.workers.length, 0);
    const phaseLines = plan.phases
      .map((phase, index) => `${index + 1}. ${phase.name} — ${phase.workers.length} worker${phase.workers.length === 1 ? "" : "s"}`)
      .join("\n");
    const verification =
      /screenshot|screen|verify|verification/i.test(normalized)
        ? "\n\nVerification: include command checks and browser/screenshot evidence before final synthesis."
        : "\n\nVerification: include concrete evidence and a final synthesis before closing the run.";

    return {
      response:
        `Dynamic workflow plan for: ${plan.objective}\n\n` +
        `Phases: ${plan.phases.length}; workers: ${workerCount}; max concurrency: ${plan.limits.maxConcurrency}.\n\n` +
        phaseLines +
        verification +
        "\n\nUse `/loop <objective>` to start this as a run, or ask me to create the run if you want it queued now.",
      source: "app-command-registry",
      risk: "read",
    };
  },
});

// 10. /loop command — dynamic workflow orchestration alias
registerAppCommand({
  id: "loop-command",
  domain: "app",
  patterns: [
    /^\/loop(?:\s+(\S+.*))?$/i,
  ],
  risk: "confirm-write",
  requiresExactTarget: false,
  clearsPendingMutation: false,
  handler: async (message, ctx) => {
    const args = message.replace(/^\/loop\s*/i, "").trim();
    const action = args.toLowerCase().split(/\s+/)[0] || "";

    // /loop status
    if (action === "status" || args === "" || args === "status") {
      try {
        const { listRuns } = await import("@/lib/dynamic-workflows/store");
        const activeRuns = listRuns({ status: "running" });
        const pausedRuns = listRuns({ status: "paused" });
        const recentRuns = listRuns({ limit: 3 });
        const parts: string[] = [];
        parts.push("**Loop Status**\n");
        if (activeRuns.length > 0) {
          parts.push(`Active dynamic runs: ${activeRuns.length}`);
          for (const r of activeRuns) {
            parts.push(`  - ${r.name} (${r.status}) [${r.id.slice(0, 8)}...]`);
          }
        } else {
          parts.push("No active dynamic workflow runs.");
        }
        if (pausedRuns.length > 0) {
          parts.push(`\nPaused runs: ${pausedRuns.length}`);
          for (const r of pausedRuns) {
            parts.push(`  - ${r.name} (${r.status})`);
          }
        }
        if (recentRuns.length > 0 && activeRuns.length === 0 && pausedRuns.length === 0) {
          parts.push(`\nRecent runs:`);
          for (const r of recentRuns) {
            parts.push(`  - ${r.name} (${r.status})`);
          }
        }
        parts.push(`\nUse \`/loop <objective>\` to start a new dynamic workflow run.`);
        parts.push(`Use \`/goal status\` for standing goal state.`);
        return {
          response: parts.join("\n"),
          source: "app-command-registry",
          risk: "read",
        };
      } catch (err) {
        return {
          response: `Loop status is unavailable (dynamic workflows not initialized).\n\nUse \`/goal status\` to check standing goal state.`,
          source: "app-command-registry",
          risk: "read",
        };
      }
    }

    // /loop pause|resume|cancel
    if (action === "pause" || action === "resume" || action === "cancel" || action === "stop") {
      try {
        const { listRuns } = await import("@/lib/dynamic-workflows/store");
        const { pauseRun, resumeRun, cancelRun } = await import("@/lib/dynamic-workflows/runner");
        const activeRuns =
          action === "resume"
            ? listRuns({ status: "paused" })
            : action === "cancel" || action === "stop"
              ? [
                  ...listRuns({ status: "running" }),
                  ...listRuns({ status: "paused" }),
                  ...listRuns({ status: "queued" }),
                ]
              : listRuns({ status: "running" });

        if (activeRuns.length === 0) {
          const targetState = action === "resume" ? "paused" : "active";
          return {
            response: `No ${targetState} dynamic workflow runs to ${action}. Use \`/loop <objective>\` to start one, or \`/goal ${action}\` for standing goals.`,
            source: "app-command-registry",
            risk: "read",
          };
        }

        const target = activeRuns[0]!;
        if (action === "pause") pauseRun(target.id);
        else if (action === "resume") resumeRun(target.id);
        else cancelRun(target.id);

        const verb = action === "stop" ? "cancelled" : `${action}d`;
        return {
          response: `Run "${target.name}" ${verb}.\n\nUse \`/loop status\` to see current state.`,
          source: "app-command-registry",
          risk: "confirm-write",
        };
      } catch (err) {
        return {
          response: `Could not ${action} loop run: ${String(err)}`,
          source: "app-command-registry",
          risk: "read",
        };
      }
    }

    // /loop <objective> — create a dynamic workflow run
    if (args) {
      try {
        const { generatePlanOutline } = await import("@/lib/dynamic-workflows/planner");
        const { createAndStartRun } = await import("@/lib/dynamic-workflows/runner");
        const result = generatePlanOutline(args, { sessionId: ctx.sessionId });
        if (!result.plan) {
          return {
            response: `Could not generate a dynamic workflow plan for: "${args}"\n\n${result.summary}`,
            source: "app-command-registry",
            risk: "read",
          };
        }
        const run = await createAndStartRun(result.plan, {
          name: `Loop: ${args.slice(0, 80)}`,
          description: args.slice(0, 200),
          sourceType: "webchat",
          sessionId: ctx.sessionId,
        });
        return {
          response: `**Dynamic workflow started**\n\nObjective: ${result.plan.objective}\nPhases: ${result.plan.phases.length}\nRun: ${run.id.slice(0, 8)}...\n\nUse \`/loop status\` to monitor progress or \`/loop pause\` to pause.`,
          source: "app-command-registry",
          risk: "confirm-write",
        };
      } catch (err) {
        return {
          response: `Could not start loop workflow: ${String(err)}`,
          source: "app-command-registry",
          risk: "read",
        };
      }
    }

    return {
      response: "**/loop** — Dynamic workflow orchestration\n\n`/loop <objective>` — Start a new dynamic workflow run\n`/loop status` — Show active and recent runs\n`/loop pause|resume|cancel` — Control the active run\n\nUse `/goal` for durable standing goals and board tasks.",
      source: "app-command-registry",
      risk: "read",
    };
  },
});
