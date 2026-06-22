import { TOOL_CATALOG } from "@/lib/engine/tools";

const NODE_REGISTRY_CONTEXT = [
  "Trigger: manual-trigger, message-trigger, webhook-trigger, cron-trigger, telegram-trigger, discord-trigger",
  "Agent: claude-agent, integration-agent, parallel-agents, call-workflow, spawn-coding-agent",
  "Channel: send-webchat, send-whatsapp, send-telegram, send-discord, send-email, send-slack, send-bluebubbles, send-teams",
  "Logic: if-else, switch, delay, set-variables, filter",
  "Memory: memory-recall, memory-store",
  "Tool: system-command, http-request, run-code, read-file, write-file, board-task, document-tool, workflow-template, scheduler-job, date-time, channel-status, council, google-sheets, notion, airtable",
  "Voice: voice-stt, voice-tts",
  "Adv Logic: loop, aggregate, merge, error-handler, wait-for-input, rate-limiter",
  "Adv Data: json-transform, split-text, regex-extract, compare-text",
  "Adv Tool: database-query, clipboard, notification, git-operation, archive",
];

const BOARD_LIFECYCLE = [
  "Status: inbox | in_progress | review | done | blocked",
  "Priority: low | medium | high | urgent",
  "Blocked tasks auto-unblock when all blockers reach done.",
  "Use board_tasks tool to create/read/update board tasks.",
  "Task creation: title required. Optional: description, status, priority, blockedBy (array of task IDs).",
];

const CHANNEL_COMMANDS = [
  "Board: 'add <title> to my board', 'Task: <title>', 'list tasks', 'start task <id>', 'run task <id>'",
  "Automations (cron + webhooks): 'list schedules', 'list webhooks', 'list automations', 'show automations', 'run now <name>'",
  "Designs: 'show designs', 'list design projects', 'create a landing page in Designs', 'change the latest design headline to X'",
  "Routing: 'use <workflow name> to <message>' or 'run workflow: <name> :: <message>'",
  "Skills: 'find skills for <task>', 'is there a skill for <task>'",
  "Agent: 'list agents', 'list models', 'list tools', 'list documents'",
  "Config: 'show config', 'help', 'status' / 'channel status'",
];

const WORKFLOW_TEMPLATES = [
  "Starter: simple-chat, pc-specs-tool-use, smart-command-runner, scheduled-health-check, devops-monitor, code-runner-pipeline, file-processor, api-monitor, local-api-tester, screenshot-analyzer",
  "Integrations: gmail-drive-bridge, google-api-integration, integration-agent-bridge, email-summarizer, daily-email-digest, multi-channel-router, telegram-board-intake, docs-site-crawler-summary, document-intelligence, automated-backup, local-lead-enrichment",
  "Core: cron-board-task-creator, smart-file-organizer, code-reviewer, research-assistant, error-resilient-pipeline, text-processing-pipeline, db-query-dashboard, git-status-reporter, clipboard-to-memory, general-task-executor, channel-workspace-assistant, live-research-assistant, support-signal-triage",
  "Hierarchy: hierarchy-orchestrator-team, ops-control-tower, hierarchy-board-briefing, autonomous-research-pipeline, experiment-loop, ai-crew-orchestrator, parallel-spawn-crew, plan-gated-crew, strategy-hardening-loop, subconscious-loop",
];

const APP_SURFACES = [
  "App surfaces: WebChat (/chat), Workflows (/workflows), Boards (/boards), Hierarchy (/hierarchy), Council (/council), Agents (/agents), Documents (/documents), Automations (/scheduler — cron + webhooks), Memory (/memory), Settings (/settings), Design Studio (/designs)",
  "Design Studio (/designs): create, preview, version, edit, validate, and export HTML design artifacts such as landing pages, dashboards, decks, posters, app mockups, and prototypes.",
  "Council (/council): run poll/debate sessions with 2-12 agents, org/goal scope, data sources, custom options, majority/consensus/weighted/ranked decisions, 2-5 debate rounds, optional moderator synthesis, cost caps, persisted session history, and board tasks from verdicts or concerns.",
  "Monitoring: Activity (/activity), Approvals (/approvals), Metrics (/metrics), Usage (/usage), Debug (/debug), Maintenance (/maintenance)",
  "Channels: WebChat, Telegram, Discord, WhatsApp, Google Chat, Slack, BlueBubbles (iMessage), Teams",
];

const WORKFLOW_MANAGEMENT_TOOLS = [
  "Read tools (safe — call freely):",
  "  schedules_list — list live cron schedules from the Automations tab (expression, timezone, live/inactive). Call this for any cron/schedule query.",
  "  webhooks_list — list webhook automations plus exact signing contract (x-webhook-signature, optional x-webhook-timestamp/x-webhook-nonce, HMAC-SHA256 over `${timestamp}.${rawBody}` when timestamp is sent). Call this for webhook inventory or signing help. Never exposes secrets.",
  "  workflow_list — see all workflows with id, name, isActive state, node count",
  "  workflow_get — see a workflow's full structure: node ids, types, prompts, URLs, enabledTools, allowlists, edges",
  "  workflow_execution_status — check status and output for a workflow run",
  "Action tools (moderate — confirm side effects with user):",
  "  workflow_run — manually trigger a workflow with optional trigger_input",
  "  workflow_toggle_active — enable/disable a workflow (cron scheduler resynced)",
  "  workflow_duplicate — clone a workflow under a new name (created DISABLED)",
  "  webhooks_create — create a webhook automation for an existing workflow; returns the signing secret once. Optional user-provided secret/key is allowed if explicitly supplied.",
  "  webhooks_toggle — enable/disable a webhook automation",
  "  webhooks_rotate_secret — rotate a webhook signing secret; returns the new secret once",
  "Mutation tools (destructive — confirm before calling, masked diff returned):",
  "  workflow_update_node — change a single node's config (prompt, url, headers, enabledTools, execAllowlist, temperature, assignments, etc.)",
  "  workflow_set_model — change supported model/provider/agent binding for agent-capable node(s)",
  "  workflow_create_credential — store a user-provided workflow secret in the encrypted credential store; never echo the secret",
  "  workflow_attach_credential — attach a saved credential id to a workflow node without writing raw secrets into workflow JSON",
  "  workflow_update_schedule — change cron expression/timezone on a cron-trigger node",
  "  workflow_delete — delete a workflow permanently (confirm with user first)",
  "  webhooks_delete — delete a webhook automation permanently (confirm with user first)",
  "",
  "Standard call pattern: workflow_list → workflow_get → mutation/action.",
  "Always call workflow_get BEFORE workflow_update_node — node IDs and current field values are required.",
  "For missing credentials: workflow_get → workflow_create_credential if user supplied a secret → workflow_attach_credential.",
  "Pass ONLY the fields being changed in `updates` or `patch_ops`. Other fields are preserved.",
  "workflow_update_node patch_ops: set/unset/append_unique/remove_value/replace_array_item/replace_assignment/set_header/remove_header.",
  "Workflow-edit tools are generic — use node ids/types/labels from workflow_get; do not assume a specific template shape.",
  "Secrets in diffs are masked automatically.",
];

export type AppFeatureSection = "nodes" | "boards" | "commands" | "templates" | "surfaces" | "workflow_mgmt" | "all";

export function buildAppFeatureContext(sections: AppFeatureSection[] = ["all"]): string {
  const want = new Set(sections);
  const includeAll = want.has("all");
  const lines: string[] = ["disp8ch AI App Feature Context (use this to ground your answers in real disp8ch AI vocabulary):", ""];

  if (includeAll || want.has("nodes")) {
    lines.push("## Node Type Registry (58 types — cite only these in workflow designs)");
    lines.push(...NODE_REGISTRY_CONTEXT.map((line) => `  ${line}`));
    lines.push("");
  }

  if (includeAll || want.has("boards")) {
    lines.push("## Board Task Lifecycle");
    lines.push(...BOARD_LIFECYCLE.map((line) => `  ${line}`));
    lines.push("");
  }

  if (includeAll || want.has("surfaces")) {
    lines.push("## App Surfaces");
    lines.push(...APP_SURFACES.map((line) => `  ${line}`));
    lines.push("");
  }

  if (includeAll || want.has("templates")) {
    lines.push("## Workflow Templates (use workflow_create with exact template key)");
    lines.push(...WORKFLOW_TEMPLATES.map((line) => `  ${line}`));
    lines.push("");
  }

  if (includeAll || want.has("commands")) {
    lines.push("## Channel Commands (what users can type in WebChat)");
    lines.push(...CHANNEL_COMMANDS.map((line) => `  ${line}`));
    lines.push("");
  }

  if (includeAll || want.has("workflow_mgmt")) {
    lines.push("## Workflow Management Tools (LLM-callable — use for workflow editing via natural language)");
    lines.push(...WORKFLOW_MANAGEMENT_TOOLS.map((line) => `  ${line}`));
    lines.push("");
  }

  return lines.join("\n");
}

export function buildCompactToolIndex(toolNames: string[]): string {
  const lines: string[] = ["Available tools:"];
  const catalog = TOOL_CATALOG as Record<string, { name: string; description: string }>;
  for (const name of toolNames) {
    const tool = catalog[name];
    if (!tool) continue;
    const shortDesc = tool.description.split("\n")[0].replace(/\s+/g, " ").trim().slice(0, 120);
    lines.push(`  ${tool.name} — ${shortDesc}`);
  }
  if (lines.length === 1) lines.push("  (no tools available for this lane)");
  lines.push("", "Use tool_docs_search to get full documentation for any tool listed above.");
  return lines.join("\n");
}

export function getToolDoc(toolName: string): string | null {
  const catalog = TOOL_CATALOG as Record<string, { name: string; description: string; parameters?: Record<string, unknown> }>;
  const tool = catalog[toolName];
  if (!tool) return null;

  const paramInfo = tool.parameters
    ? (tool.parameters as { properties?: Record<string, { type?: string; description?: string; enum?: string[] }>; required?: string[] }).properties
    : undefined;
  const required = tool.parameters
    ? (tool.parameters as { required?: string[] }).required ?? []
    : [];

  let paramText = "";
  if (paramInfo) {
    const entries = Object.entries(paramInfo);
    if (entries.length > 0) {
      paramText = "\n\nParameters:";
      for (const [key, prop] of entries) {
        const req = required.includes(key) ? " (required)" : " (optional)";
        const desc = prop?.description ?? key;
        const enumInfo = prop?.enum ? ` [${prop.enum.join(" | ")}]` : "";
        paramText += `\n  ${key}: ${prop?.type ?? "string"}${req}${enumInfo} — ${desc}`;
      }
    }
  }

  return `${tool.name}: ${tool.description}${paramText}`;
}
