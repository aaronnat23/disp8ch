import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSqlite, initializeDatabase } from "@/lib/db";
import { restartWorkflowCrons, unscheduleCronWorkflow } from "@/lib/cron/manager";
import { CHANNEL_BOARD_LIST_RESPONSE_CODE } from "@/lib/workflows/channel-board";
import { nanoid } from "nanoid";
import { listAgentRoles } from "@/lib/agents/roles";
import { listAgents } from "@/lib/agents/registry";
import {
  getActiveHierarchyOrganization,
  listHierarchyOrganizationMembers,
  resolveHierarchyOrganization,
} from "@/lib/hierarchy/organizations";
import { getHierarchyGoalById, resolveHierarchyGoal } from "@/lib/hierarchy/goals";
import { resolveWorkflowTemplateReference } from "@/lib/workflows/template-catalog";
import {
  buildCompatibleWorkflowImportChecklist,
  convertCompatibleWorkflowToDisp8ch,
  isCompatibleWorkflow,
  isDisp8chWorkflow,
} from "@/lib/workflows/compatible-import";
import { requireOperatorAccess } from "@/lib/security/admin";
import { normalizeWorkflowDefinition } from "@/lib/engine/workflow-normalize";
import { repairImportedWorkflow } from "@/lib/engine/import-repair";

const createWorkflowSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  nodes: z.array(z.any()).optional(),
  edges: z.array(z.any()).optional(),
  template: z.string().optional(),
  templateAgents: z.record(z.string().min(1)).optional(),
  organizationId: z.string().min(1).max(120).optional().nullable(),
  goalId: z.string().min(1).max(120).optional().nullable(),
  sourceType: z.string().min(1).max(120).optional(),
  sourceRef: z.string().min(1).max(240).optional(),
  importSource: z.string().optional(),
  importData: z.any().optional(),
});

const LEGACY_COMPAT_IMPORT_SOURCE = ["n", "8", "n"].join("");

function isCompatibleImportSource(source: string | undefined): boolean {
  return source === "compatible" || source === LEGACY_COMPAT_IMPORT_SOURCE;
}

type TemplateAgentAssignments = Record<string, string>;

function normalizeTemplateAgentAssignments(
  input: Record<string, string> | undefined,
): TemplateAgentAssignments {
  if (!input) return {};
  const out: TemplateAgentAssignments = {};
  for (const [role, agentId] of Object.entries(input)) {
    const cleanedRole = String(role || "").trim();
    const cleanedAgentId = String(agentId || "").trim();
    if (!cleanedRole || !cleanedAgentId) continue;
    out[cleanedRole] = cleanedAgentId;
  }
  return out;
}

function resolveDefaultHierarchyTemplateAgents(
  input: TemplateAgentAssignments,
  organizationId?: string | null,
): TemplateAgentAssignments {
  if (input.orchestrator && input.workerA && input.workerB) {
    return input;
  }

  const scopedMembers = listHierarchyOrganizationMembers(organizationId);
  const activeRoles = organizationId
    ? scopedMembers
        .filter((member) => member.agentActive)
        .map((member) => ({
          agentId: member.agent.id,
          roleType: member.role.roleType,
        }))
    : (() => {
        const roles = listAgentRoles();
        const activeAgentIds = new Set(listAgents().filter((agent) => agent.isActive).map((agent) => agent.id));
        return roles.filter((role) => activeAgentIds.has(role.agentId)).map((role) => ({
          agentId: role.agentId,
          roleType: role.roleType,
        }));
      })();
  const next = { ...input };

  const orchestrator =
    activeRoles.find((role) => role.roleType === "orchestrator") ??
    activeRoles[0] ??
    null;

  const workerPriority = new Map([
    ["worker", 0],
    ["specialist", 1],
    ["operations", 2],
    ["support", 3],
    ["orchestrator", 4],
  ]);
  const workers = activeRoles
    .filter(
      (role) =>
        role.agentId !== orchestrator?.agentId &&
        (role.roleType === "worker" || role.roleType === "specialist" || role.roleType === "operations"),
    )
    .sort((left, right) => {
      const byRole =
        (workerPriority.get(left.roleType) ?? Number.MAX_SAFE_INTEGER) -
        (workerPriority.get(right.roleType) ?? Number.MAX_SAFE_INTEGER);
      if (byRole !== 0) return byRole;
      return left.agentId.localeCompare(right.agentId);
    });
  const pickWorker = (pattern: RegExp, used: Set<string>) =>
    workers.find((role) => !used.has(role.agentId) && pattern.test(role.agentId)) ??
    workers.find((role) => !used.has(role.agentId)) ??
    null;
  const usedWorkerIds = new Set<string>();
  const preferredWorkerA = pickWorker(/market|research/i, usedWorkerIds);
  if (preferredWorkerA) usedWorkerIds.add(preferredWorkerA.agentId);
  const preferredWorkerB = pickWorker(/compet|rival|position/i, usedWorkerIds);
  if (preferredWorkerB) usedWorkerIds.add(preferredWorkerB.agentId);

  if (!next.orchestrator && orchestrator?.agentId) {
    next.orchestrator = orchestrator.agentId;
  }
  if (!next.workerA && preferredWorkerA?.agentId) {
    next.workerA = preferredWorkerA.agentId;
  }
  if (!next.workerB && preferredWorkerB?.agentId) {
    next.workerB = preferredWorkerB.agentId;
  }

  return next;
}

function getSimpleChatTemplate() {
  const manualId = nanoid(8);
  const triggerId = nanoid(8);
  const agentId = nanoid(8);
  const channelId = nanoid(8);

  const nodes = [
    {
      id: manualId,
      type: "manual-trigger",
      position: { x: 100, y: 120 },
      data: { label: "Manual Trigger (Test)" },
    },
    {
      id: triggerId,
      type: "message-trigger",
      position: { x: 100, y: 280 },
      data: { label: "Message Trigger", channel: "webchat" },
    },
    {
      id: agentId,
      type: "claude-agent",
      position: { x: 400, y: 200 },
      data: {
        label: "Agent",
        systemPrompt: "You are a helpful AI assistant. Be concise and helpful.",
        temperature: 0.7,
        maxTokens: 1024,
      },
    },
    {
      id: channelId,
      type: "send-webchat",
      position: { x: 700, y: 200 },
      data: { label: "Send WebChat" },
    },
  ];

  const edges = [
    { id: `e-${manualId}-${agentId}`, source: manualId, target: agentId },
    { id: `e-${triggerId}-${agentId}`, source: triggerId, target: agentId },
    { id: `e-${agentId}-${channelId}`, source: agentId, target: channelId },
  ];

  return { nodes, edges };
}

function getGmailDriveBridgeTemplate() {
  const manualId = nanoid(8);
  const triggerId = nanoid(8);
  const memoryId = nanoid(8);
  const agentId = nanoid(8);
  const channelId = nanoid(8);

  const nodes = [
    {
      id: manualId,
      type: "manual-trigger",
      position: { x: 100, y: 120 },
      data: {
        label: "Manual Trigger (Test)",
      },
    },
    {
      id: triggerId,
      type: "webhook-trigger",
      position: { x: 100, y: 320 },
      data: {
        label: "Google Webhook Trigger",
        path: "/google/workspace",
        method: "POST",
      },
    },
    {
      id: memoryId,
      type: "memory-recall",
      position: { x: 360, y: 220 },
      data: {
        label: "Memory Recall",
        query: "{{trigger.body.subject}} {{trigger.body.message}}",
        limit: 5,
      },
    },
    {
      id: agentId,
      type: "claude-agent",
      position: { x: 620, y: 220 },
      data: {
        label: "Agent",
        systemPrompt:
          "You are a Google Workspace assistant.\n\nIf webhook payload fields are present, summarize what happened, list required actions, and draft a concise reply.\nIf payload is sparse, fetch real data using http_request:\n- Gmail list: GET https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=5\n- Drive files: GET https://www.googleapis.com/drive/v3/files?pageSize=5&fields=files(id,name,mimeType,modifiedTime)\nUse header Authorization: Bearer {{google.accessToken}}.\n\nAlways provide a final user-facing response and do not leave the answer empty.",
        temperature: 0.4,
        maxTokens: 1024,
        enabledTools: ["http_request"],
      },
    },
    {
      id: channelId,
      type: "send-webchat",
      position: { x: 880, y: 220 },
      data: { label: "Send WebChat" },
    },
  ];

  const edges = [
    { id: `e-${manualId}-${memoryId}`, source: manualId, target: memoryId },
    { id: `e-${triggerId}-${memoryId}`, source: triggerId, target: memoryId },
    { id: `e-${memoryId}-${agentId}`, source: memoryId, target: agentId },
    { id: `e-${agentId}-${channelId}`, source: agentId, target: channelId },
  ];

  return { nodes, edges };
}

function getPcSpecsToolTemplate() {
  const manualId = nanoid(8);
  const triggerId = nanoid(8);
  const specsToolId = nanoid(8);
  const filesToolId = nanoid(8);
  const agentId = nanoid(8);
  const channelId = nanoid(8);

  const nodes = [
    {
      id: manualId,
      type: "manual-trigger",
      position: { x: 80, y: 120 },
      data: { label: "Manual Trigger (Test)" },
    },
    {
      id: triggerId,
      type: "message-trigger",
      position: { x: 80, y: 280 },
      data: { label: "Message Trigger", channel: "webchat" },
    },
    {
      id: specsToolId,
      type: "system-command",
      position: { x: 360, y: 180 },
      data: {
        label: "PC Specs Tool",
        action: "pc-specs",
        timeoutMs: 15000,
      },
    },
    {
      id: filesToolId,
      type: "system-command",
      position: { x: 640, y: 180 },
      data: {
        label: "Workspace Files Tool",
        action: "list-files",
        path: ".",
        maxEntries: 20,
        timeoutMs: 15000,
      },
    },
    {
      id: agentId,
      type: "claude-agent",
      position: { x: 920, y: 180 },
      data: {
        label: "Agent",
        systemPrompt:
          "You are a local system assistant. Use the machine tool outputs below to answer accurately.\n\nPC SPECS:\n{{system.pcSpecsText}}\n\nFILE SNAPSHOT:\n{{system.fileListingText}}\n\nIf user asks about RAM/CPU/storage/files, answer directly from these tool results. If user asks something else, say this workflow is focused on local system diagnostics.",
        temperature: 0.2,
        maxTokens: 900,
      },
    },
    {
      id: channelId,
      type: "send-webchat",
      position: { x: 1180, y: 180 },
      data: { label: "Send WebChat" },
    },
  ];

  const edges = [
    { id: `e-${manualId}-${specsToolId}`, source: manualId, target: specsToolId },
    { id: `e-${triggerId}-${specsToolId}`, source: triggerId, target: specsToolId },
    { id: `e-${specsToolId}-${filesToolId}`, source: specsToolId, target: filesToolId },
    { id: `e-${filesToolId}-${agentId}`, source: filesToolId, target: agentId },
    { id: `e-${agentId}-${channelId}`, source: agentId, target: channelId },
  ];

  return { nodes, edges };
}

function getDevopsMonitorTemplate() {
  const manualId = nanoid(8);
  const triggerId = nanoid(8);
  const agentId = nanoid(8);
  const memoryId = nanoid(8);
  const channelId = nanoid(8);

  const nodes = [
    {
      id: manualId,
      type: "manual-trigger",
      position: { x: 100, y: 120 },
      data: { label: "Manual Trigger (Test)" },
    },
    {
      id: triggerId,
      type: "message-trigger",
      position: { x: 100, y: 280 },
      data: { label: "Message Trigger", channel: "webchat" },
    },
    {
      id: agentId,
      type: "claude-agent",
      position: { x: 400, y: 200 },
      data: {
        label: "DevOps Agent",
        systemPrompt:
          "You are a DevOps monitoring assistant. Check system health, disk usage, memory, and running processes. Report any anomalies or warnings clearly. Use the tools available to gather system information.",
        temperature: 0.3,
        maxTokens: 1500,
        enabledTools: ["bash_exec", "system_info", "list_files"],
      },
    },
    {
      id: memoryId,
      type: "memory-store",
      position: { x: 700, y: 200 },
      data: {
        label: "Store Findings",
        extractMode: "auto",
      },
    },
    {
      id: channelId,
      type: "send-webchat",
      position: { x: 1000, y: 200 },
      data: { label: "Send WebChat" },
    },
  ];

  const edges = [
    { id: `e-${manualId}-${agentId}`, source: manualId, target: agentId },
    { id: `e-${triggerId}-${agentId}`, source: triggerId, target: agentId },
    { id: `e-${agentId}-${memoryId}`, source: agentId, target: memoryId },
    { id: `e-${memoryId}-${channelId}`, source: memoryId, target: channelId },
  ];

  return { nodes, edges };
}

function getSmartCommandRunnerTemplate() {
  const manualId = nanoid(8);
  const triggerId = nanoid(8);
  const agentId = nanoid(8);
  const channelId = nanoid(8);

  const nodes = [
    {
      id: manualId,
      type: "manual-trigger",
      position: { x: 100, y: 120 },
      data: { label: "Manual Trigger (Test)" },
    },
    {
      id: triggerId,
      type: "message-trigger",
      position: { x: 100, y: 280 },
      data: { label: "Message Trigger", channel: "webchat" },
    },
    {
      id: agentId,
      type: "claude-agent",
      position: { x: 400, y: 200 },
      data: {
        label: "Command Runner Agent",
        systemPrompt:
          "You are a powerful system automation agent with full access to the local machine. Execute commands, read/write files, run Python scripts, and inspect the system as needed. Always explain what you are about to do before executing potentially destructive operations.",
        temperature: 0.2,
        maxTokens: 2048,
        approvalMode: "model",
        enabledTools: [
          "bash_exec",
          "read_file",
          "write_file",
          "list_files",
          "find_files",
          "system_info",
          "run_python",
        ],
      },
    },
    {
      id: channelId,
      type: "send-webchat",
      position: { x: 750, y: 200 },
      data: { label: "Send WebChat" },
    },
  ];

  const edges = [
    { id: `e-${manualId}-${agentId}`, source: manualId, target: agentId },
    { id: `e-${triggerId}-${agentId}`, source: triggerId, target: agentId },
    { id: `e-${agentId}-${channelId}`, source: agentId, target: channelId },
  ];

  return { nodes, edges };
}

function getScheduledHealthCheckTemplate() {
  const manualId = nanoid(8);
  const cronId = nanoid(8);
  const systemId = nanoid(8);
  const codeId = nanoid(8);
  const ifElseId = nanoid(8);
  const alertId = nanoid(8);
  const delayId = nanoid(8);

  const nodes = [
    {
      id: manualId,
      type: "manual-trigger",
      position: { x: 100, y: 80 },
      data: {
        label: "Manual Trigger",
      },
    },
    {
      id: cronId,
      type: "cron-trigger",
      position: { x: 100, y: 200 },
      data: {
        label: "Every 30 Minutes",
        expression: "*/30 * * * *",
      },
    },
    {
      id: systemId,
      type: "system-command",
      position: { x: 350, y: 200 },
      data: {
        label: "Get PC Specs",
        action: "pc-specs",
        timeoutMs: 15000,
      },
    },
    {
      id: codeId,
      type: "run-code",
      position: { x: 600, y: 200 },
      data: {
        label: "Check Thresholds",
        language: "javascript",
        code: "var warnings = [];\nvar specs = (input && input.pcSpecs) ? input.pcSpecs : {};\nvar disk = specs.disk || {};\nvar freePercent = Number(disk.freePercent || 100);\nif (isFinite(freePercent) && freePercent < 15) {\n  warnings.push('Disk free space below 15% (' + freePercent.toFixed(1) + '% free)');\n}\nvar ramTotal = Number(specs.ramTotalBytes || 0);\nvar ramUsed = Number(specs.ramUsedBytes || 0);\nif (ramTotal > 0) {\n  var ramUsedPercent = (ramUsed / ramTotal) * 100;\n  if (ramUsedPercent > 90) warnings.push('RAM usage above 90% (' + ramUsedPercent.toFixed(1) + '% used)');\n}\nvar hasWarning = warnings.length > 0;\nvar summary = hasWarning ? 'WARNINGS: ' + warnings.join(', ') : 'All systems healthy';\nresult = { hasWarning: hasWarning, summary: summary, warnings: warnings, freePercent: freePercent };",
      },
    },
    {
      id: ifElseId,
      type: "if-else",
      position: { x: 850, y: 200 },
      data: {
        label: "Has Warnings?",
        condition: "result_hasWarning == true",
      },
    },
    {
      id: alertId,
      type: "send-webchat",
      position: { x: 1100, y: 120 },
      data: { label: "Send Alert" },
    },
    {
      id: delayId,
      type: "delay",
      position: { x: 1100, y: 300 },
      data: {
        label: "Skip (No Alert)",
        duration: 1000,
      },
    },
  ];

  const edges = [
    { id: `e-${manualId}-${systemId}`, source: manualId, target: systemId },
    { id: `e-${cronId}-${systemId}`, source: cronId, target: systemId },
    { id: `e-${systemId}-${codeId}`, source: systemId, target: codeId },
    { id: `e-${codeId}-${ifElseId}`, source: codeId, target: ifElseId },
    { id: `e-${ifElseId}-${alertId}`, source: ifElseId, target: alertId, sourceHandle: "true" },
    { id: `e-${ifElseId}-${delayId}`, source: ifElseId, target: delayId, sourceHandle: "false" },
  ];

  return { nodes, edges };
}

function getGoogleApiIntegrationTemplate() {
  const manualId = nanoid(8);
  const triggerId = nanoid(8);
  const varsId = nanoid(8);
  const agentId = nanoid(8);
  const channelId = nanoid(8);

  const nodes = [
    {
      id: manualId,
      type: "manual-trigger",
      position: { x: 100, y: 120 },
      data: { label: "Manual Trigger (Test)" },
    },
    {
      id: triggerId,
      type: "message-trigger",
      position: { x: 100, y: 280 },
      data: { label: "Message Trigger", channel: "webchat" },
    },
    {
      id: varsId,
      type: "set-variables",
      position: { x: 370, y: 200 },
      data: {
        label: "API Config",
        assignments: [
          { key: "gmailUrl", value: "https://gmail.googleapis.com/gmail/v1/users/me/messages" },
          { key: "driveUrl", value: "https://www.googleapis.com/drive/v3/files" },
          { key: "bearerToken", value: "{{google.accessToken}}" },
          { key: "apiNote", value: "Use Authorization: Bearer {{vars.bearerToken}} for every Google API request." },
        ],
      },
    },
    {
      id: agentId,
      type: "claude-agent",
      position: { x: 660, y: 200 },
      data: {
        label: "Google API Agent",
        systemPrompt:
          "You are a Google API assistant. Use the http_request tool to interact with Google APIs.\n\nAvailable endpoints:\n- Gmail: {{vars.gmailUrl}}\n- Drive: {{vars.driveUrl}}\n\nAlways include header Authorization: Bearer {{vars.bearerToken}}.\nIf the user asks for inbox insights, fetch Gmail messages and summarize them.\nIf the user asks for files, fetch Drive files and summarize them.\nAlways return a final user-visible answer. Never leave the response empty.",
        temperature: 0.3,
        maxTokens: 1500,
        enabledTools: ["http_request"],
      },
    },
    {
      id: channelId,
      type: "send-webchat",
      position: { x: 960, y: 200 },
      data: { label: "Send WebChat" },
    },
  ];

  const edges = [
    { id: `e-${manualId}-${varsId}`, source: manualId, target: varsId },
    { id: `e-${triggerId}-${varsId}`, source: triggerId, target: varsId },
    { id: `e-${varsId}-${agentId}`, source: varsId, target: agentId },
    { id: `e-${agentId}-${channelId}`, source: agentId, target: channelId },
  ];

  return { nodes, edges };
}

function getIntegrationAgentBridgeTemplate() {
  const manualId = nanoid(8);
  const triggerId = nanoid(8);
  const agentId = nanoid(8);
  const channelId = nanoid(8);

  const nodes = [
    {
      id: manualId,
      type: "manual-trigger",
      position: { x: 80, y: 120 },
      data: { label: "Manual Trigger (Test)" },
    },
    {
      id: triggerId,
      type: "message-trigger",
      position: { x: 80, y: 280 },
      data: { label: "Message Trigger", channel: "webchat" },
    },
    {
      id: agentId,
      type: "integration-agent",
      position: { x: 400, y: 200 },
      data: {
        label: "Integration Agent",
        serviceName: "Custom API",
        objective:
          "Use the incoming request to decide what API operation to perform. If the user did not provide enough detail, explain what base URL, auth, or endpoint details are missing.",
        baseUrl: "",
        authHeaderName: "Authorization",
        authScheme: "Bearer",
        authToken: "",
        temperature: 0.2,
        maxTokens: 1200,
      },
    },
    {
      id: channelId,
      type: "send-webchat",
      position: { x: 720, y: 200 },
      data: { label: "Send WebChat" },
    },
  ];

  const edges = [
    { id: `e-${manualId}-${agentId}`, source: manualId, target: agentId },
    { id: `e-${triggerId}-${agentId}`, source: triggerId, target: agentId },
    { id: `e-${agentId}-${channelId}`, source: agentId, target: channelId },
  ];

  return { nodes, edges };
}

function getCodeRunnerPipelineTemplate() {
  const manualId = nanoid(8);
  const varsId = nanoid(8);
  const codeId = nanoid(8);
  const ifElseId = nanoid(8);
  const agentId = nanoid(8);
  const alertChannelId = nanoid(8);
  const okChannelId = nanoid(8);

  const nodes = [
    {
      id: manualId,
      type: "manual-trigger",
      position: { x: 100, y: 200 },
      data: { label: "Manual Trigger" },
    },
    {
      id: varsId,
      type: "set-variables",
      position: { x: 330, y: 200 },
      data: {
        label: "Sample Data",
        assignments: [
          { key: "scores", value: "[85, 92, 45, 78, 33, 91, 67]" },
          { key: "passingThreshold", value: "60" },
          { key: "dataLabel", value: "Student test scores" },
        ],
      },
    },
    {
      id: codeId,
      type: "run-code",
      position: { x: 560, y: 200 },
      data: {
        label: "Process Scores",
        language: "javascript",
        code: "var v = input.vars || {};\nvar scores = JSON.parse(v.scores || '[]');\nvar threshold = Number(v.passingThreshold || 60);\nvar failures = scores.filter(function(s) { return s < threshold; });\nvar avg = scores.reduce(function(a, b) { return a + b; }, 0) / scores.length;\nvar hasFailures = failures.length > 0;\nvar label = String(v.dataLabel || 'Data');\nresult = {\n  hasFailures: hasFailures,\n  total: scores.length,\n  passing: scores.length - failures.length,\n  failing: failures.length,\n  average: Math.round(avg * 10) / 10,\n  failedScores: failures,\n  summary: label + ': ' + (scores.length - failures.length) + '/' + scores.length + ' passed (avg: ' + Math.round(avg * 10) / 10 + ')'\n};",
      },
    },
    {
      id: ifElseId,
      type: "if-else",
      position: { x: 790, y: 200 },
      data: {
        label: "Has Failures?",
        condition: "result_hasFailures == true",
      },
    },
    {
      id: agentId,
      type: "claude-agent",
      position: { x: 1020, y: 120 },
      data: {
        label: "Analyze Failures",
        systemPrompt:
          "You are a data analyst. The pipeline detected failing scores below the threshold. Analyze the results and provide recommendations for improvement. Be concise.",
        temperature: 0.5,
        maxTokens: 800,
      },
    },
    {
      id: alertChannelId,
      type: "send-webchat",
      position: { x: 1280, y: 120 },
      data: { label: "Send Analysis" },
    },
    {
      id: okChannelId,
      type: "send-webchat",
      position: { x: 1020, y: 320 },
      data: { label: "All Clear" },
    },
  ];

  const edges = [
    { id: `e-${manualId}-${varsId}`, source: manualId, target: varsId },
    { id: `e-${varsId}-${codeId}`, source: varsId, target: codeId },
    { id: `e-${codeId}-${ifElseId}`, source: codeId, target: ifElseId },
    { id: `e-${ifElseId}-${agentId}`, source: ifElseId, target: agentId, sourceHandle: "true" },
    { id: `e-${agentId}-${alertChannelId}`, source: agentId, target: alertChannelId },
    { id: `e-${ifElseId}-${okChannelId}`, source: ifElseId, target: okChannelId, sourceHandle: "false" },
  ];

  return { nodes, edges };
}

function getFileProcessorTemplate() {
  const manualId = nanoid(8);
  const readId = nanoid(8);
  const codeId = nanoid(8);
  const writeId = nanoid(8);
  const channelId = nanoid(8);

  const nodes = [
    {
      id: manualId,
      type: "manual-trigger",
      position: { x: 100, y: 200 },
      data: { label: "Manual Trigger" },
    },
    {
      id: readId,
      type: "read-file",
      position: { x: 350, y: 200 },
      data: {
        label: "Read Input File",
        path: "data/workspace/MEMORY.md",
      },
    },
    {
      id: codeId,
      type: "run-code",
      position: { x: 600, y: 200 },
      data: {
        label: "Transform Content",
        language: "javascript",
        code: "var content = String(input.content || '');\nvar lines = content.split('\\n');\nvar lineCount = lines.length;\nvar wordCount = content.split(/\\s+/).filter(function(w) { return w.length > 0; }).length;\nvar charCount = content.length;\nvar headings = lines.filter(function(l) { return l.indexOf('#') === 0; });\nvar transformed = '# File Analysis Report\\n\\n';\ntransformed += '- Lines: ' + lineCount + '\\n';\ntransformed += '- Words: ' + wordCount + '\\n';\ntransformed += '- Characters: ' + charCount + '\\n';\ntransformed += '- Headings found: ' + headings.length + '\\n\\n';\ntransformed += '## Headings\\n\\n';\nfor (var i = 0; i < headings.length; i++) {\n  transformed += '- ' + headings[i].replace(/^#+\\s*/, '') + '\\n';\n}\nresult = { transformed: transformed, lines: lineCount, words: wordCount, chars: charCount };",
      },
    },
    {
      id: writeId,
      type: "write-file",
      position: { x: 850, y: 200 },
      data: {
        label: "Write Report",
        path: "data/workspace/file-analysis-report.md",
        content: "{{run.result.transformed}}",
      },
    },
    {
      id: channelId,
      type: "send-webchat",
      position: { x: 1100, y: 200 },
      data: { label: "Send Result" },
    },
  ];

  const edges = [
    { id: `e-${manualId}-${readId}`, source: manualId, target: readId },
    { id: `e-${readId}-${codeId}`, source: readId, target: codeId },
    { id: `e-${codeId}-${writeId}`, source: codeId, target: writeId },
    { id: `e-${writeId}-${channelId}`, source: writeId, target: channelId },
  ];

  return { nodes, edges };
}

function getApiMonitorTemplate() {
  const cronId = nanoid(8);
  const httpId = nanoid(8);
  const codeId = nanoid(8);
  const ifElseId = nanoid(8);
  const memoryId = nanoid(8);
  const alertId = nanoid(8);
  const okId = nanoid(8);

  const nodes = [
    {
      id: cronId,
      type: "cron-trigger",
      position: { x: 100, y: 200 },
      data: {
        label: "Every 15 Minutes",
        expression: "*/15 * * * *",
      },
    },
    {
      id: httpId,
      type: "http-request",
      position: { x: 330, y: 200 },
      data: {
        label: "Check API Health",
        url: "https://httpbin.org/status/200",
        method: "GET",
        timeoutMs: 10000,
      },
    },
    {
      id: codeId,
      type: "run-code",
      position: { x: 560, y: 200 },
      data: {
        label: "Evaluate Response",
        language: "javascript",
        code: "var data = input || {};\nvar needsAlert = false;\nvar status = String(data.status || data.statusCode || 'unknown');\nif (status === 'unknown') {\n  var dataStr = JSON.stringify(data);\n  needsAlert = dataStr.indexOf('error') !== -1 || dataStr.indexOf('Error') !== -1;\n  status = 'parse_error';\n} else {\n  needsAlert = status !== '200' && status !== '204';\n}\nvar timestamp = new Date().toISOString();\nresult = { needsAlert: needsAlert, status: status, timestamp: timestamp, message: needsAlert ? 'API returned status ' + status + ' at ' + timestamp : 'API healthy (status ' + status + ') at ' + timestamp };",
      },
    },
    {
      id: ifElseId,
      type: "if-else",
      position: { x: 790, y: 200 },
      data: {
        label: "Needs Alert?",
        condition: "result_needsAlert == true",
      },
    },
    {
      id: memoryId,
      type: "memory-store",
      position: { x: 1020, y: 120 },
      data: {
        label: "Log Incident",
        extractMode: "auto",
      },
    },
    {
      id: alertId,
      type: "send-webchat",
      position: { x: 1280, y: 120 },
      data: { label: "Send Alert" },
    },
    {
      id: okId,
      type: "send-webchat",
      position: { x: 1020, y: 320 },
      data: { label: "Healthy" },
    },
  ];

  const edges = [
    { id: `e-${cronId}-${httpId}`, source: cronId, target: httpId },
    { id: `e-${httpId}-${codeId}`, source: httpId, target: codeId },
    { id: `e-${codeId}-${ifElseId}`, source: codeId, target: ifElseId },
    { id: `e-${ifElseId}-${memoryId}`, source: ifElseId, target: memoryId, sourceHandle: "true" },
    { id: `e-${memoryId}-${alertId}`, source: memoryId, target: alertId },
    { id: `e-${ifElseId}-${okId}`, source: ifElseId, target: okId, sourceHandle: "false" },
  ];

  return { nodes, edges };
}

function getEmailSummarizerTemplate() {
  const manualId = nanoid(8);
  const triggerId = nanoid(8);
  const varsId = nanoid(8);
  const agentId = nanoid(8);
  const channelId = nanoid(8);

  const nodes = [
    {
      id: manualId,
      type: "manual-trigger",
      position: { x: 100, y: 120 },
      data: { label: "Manual Trigger" },
    },
    {
      id: triggerId,
      type: "message-trigger",
      position: { x: 100, y: 280 },
      data: { label: "Message Trigger", channel: "webchat" },
    },
    {
      id: varsId,
      type: "set-variables",
      position: { x: 370, y: 200 },
      data: {
        label: "Gmail Config",
        assignments: [
          { key: "gmailUrl", value: "https://gmail.googleapis.com/gmail/v1/users/me/messages" },
          { key: "bearerToken", value: "{{google.accessToken}}" },
          { key: "maxResults", value: "5" },
        ],
      },
    },
    {
      id: agentId,
      type: "claude-agent",
      position: { x: 660, y: 200 },
      data: {
        label: "Email Summarizer",
        systemPrompt:
          "You are an email assistant. Your task is to fetch and summarize the user's most recent emails.\n\nStep 1: Call GET {{vars.gmailUrl}}?maxResults={{vars.maxResults}} with header Authorization: Bearer {{vars.bearerToken}}\nStep 2: For each message ID returned, call GET {{vars.gmailUrl}}/{messageId}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date to get the subject, sender, and date.\nStep 3: Summarize all emails in a clear format:\n  - From: ...\n  - Subject: ...\n  - Date: ...\n\nIf the API returns an error, explain what the user needs to configure (enable Gmail API, set OAuth token, etc.).",
        temperature: 0.2,
        maxTokens: 2048,
        enabledTools: ["http_request"],
      },
    },
    {
      id: channelId,
      type: "send-webchat",
      position: { x: 960, y: 200 },
      data: { label: "Send WebChat" },
    },
  ];

  const edges = [
    { id: `e-${manualId}-${varsId}`, source: manualId, target: varsId },
    { id: `e-${triggerId}-${varsId}`, source: triggerId, target: varsId },
    { id: `e-${varsId}-${agentId}`, source: varsId, target: agentId },
    { id: `e-${agentId}-${channelId}`, source: agentId, target: channelId },
  ];

  return { nodes, edges };
}

function getDailyEmailDigestTemplate() {
  const cronId = nanoid(8);
  const varsId = nanoid(8);
  const agentId = nanoid(8);
  const memoryId = nanoid(8);
  const channelId = nanoid(8);

  const nodes = [
    {
      id: cronId,
      type: "cron-trigger",
      position: { x: 100, y: 200 },
      data: {
        label: "Every Day at 8am",
        expression: "0 8 * * *",
      },
    },
    {
      id: varsId,
      type: "set-variables",
      position: { x: 350, y: 200 },
      data: {
        label: "Gmail Config",
        assignments: [
          { key: "gmailUrl", value: "https://gmail.googleapis.com/gmail/v1/users/me/messages" },
          { key: "bearerToken", value: "{{google.accessToken}}" },
        ],
      },
    },
    {
      id: agentId,
      type: "claude-agent",
      position: { x: 620, y: 200 },
      data: {
        label: "Daily Digest Agent",
        systemPrompt:
          "You are a daily email digest assistant. Your job is to summarize yesterday's emails and flag anything important.\n\nStep 1: Search for yesterday's emails by calling GET {{vars.gmailUrl}}?maxResults=20&q=newer_than:1d with header Authorization: Bearer {{vars.bearerToken}}\nStep 2: For each message ID, call GET {{vars.gmailUrl}}/{messageId}?format=full to get the full email content.\nStep 3: Produce a digest report with these sections:\n\n## Daily Email Digest\n**Date:** [yesterday's date]\n**Emails processed:** [count]\n\n### Priority / Action Required\nList any emails that need a reply, contain deadlines, or are from important senders.\n\n### Informational\nBriefly summarize newsletters, notifications, and FYI emails.\n\n### Low Priority / Skippable\nList promotional emails, automated notifications, etc.\n\n### Key Takeaways\nBullet list of the 3 most important things from yesterday's inbox.\n\nIf the API returns an error, explain what the user needs to configure.",
        temperature: 0.3,
        maxTokens: 3000,
        enabledTools: ["http_request"],
      },
    },
    {
      id: memoryId,
      type: "memory-store",
      position: { x: 900, y: 200 },
      data: {
        label: "Store Digest",
        extractMode: "auto",
      },
    },
    {
      id: channelId,
      type: "send-webchat",
      position: { x: 1160, y: 200 },
      data: { label: "Send WebChat" },
    },
  ];

  const edges = [
    { id: `e-${cronId}-${varsId}`, source: cronId, target: varsId },
    { id: `e-${varsId}-${agentId}`, source: varsId, target: agentId },
    { id: `e-${agentId}-${memoryId}`, source: agentId, target: memoryId },
    { id: `e-${memoryId}-${channelId}`, source: memoryId, target: channelId },
  ];

  return { nodes, edges };
}

function getHierarchyOrchestratorTemplate(
  assignments: TemplateAgentAssignments = {},
) {
  const manualId = nanoid(8);
  const triggerId = nanoid(8);
  const orchestratorPlanId = nanoid(8);
  const setPlanId = nanoid(8);
  const parallelWorkersId = nanoid(8);
  const orchestratorFinalId = nanoid(8);
  const channelId = nanoid(8);

  const orchestratorAgentId = assignments.orchestrator ?? "";
  const workerAAgentId = assignments.workerA ?? "";
  const workerBAgentId = assignments.workerB ?? "";

  const nodes = [
    {
      id: manualId,
      type: "manual-trigger",
      position: { x: 100, y: 120 },
      data: { label: "Manual Trigger (Test)" },
    },
    {
      id: triggerId,
      type: "message-trigger",
      position: { x: 100, y: 280 },
      data: { label: "Message Trigger", channel: "webchat" },
    },
    {
      id: orchestratorPlanId,
      type: "claude-agent",
      position: { x: 360, y: 200 },
      data: {
        label: "Orchestrator: Research Plan",
        agentId: orchestratorAgentId,
        systemPrompt:
          "You are the orchestrator agent. Create a short research delegation plan with exactly two parallel tracks:\n\nTASK_A: [source/market research track]\nTASK_B: [competitor/alternative research track]\n\nKeep both subtasks specific and actionable.",
        temperature: 0.3,
        maxTokens: 900,
      },
    },
    {
      id: setPlanId,
      type: "set-variables",
      position: { x: 620, y: 200 },
      data: {
        label: "Store Plan",
        assignments: [
          { key: "plan", value: "{{claude.response}}" },
          { key: "userRequest", value: "{{trigger.message}}{{trigger.prompt}}" },
        ],
      },
    },
    {
      id: parallelWorkersId,
      type: "parallel-agents",
      position: { x: 900, y: 200 },
      data: {
        label: "Parallel Research Workers",
        taskTemplate: "User request: {{vars.userRequest}}\n\nDelegation plan:\n{{vars.plan}}",
        maxParallel: 2,
        workers: [
          {
            roleKey: "workerA",
            label: "Market Signals Researcher",
            agentId: workerAAgentId,
            taskTemplate:
              "User request: {{vars.userRequest}}\n\nDelegation plan:\n{{vars.plan}}\n\nExecute TASK_A only.\nReturn:\n- Sources reviewed\n- Key findings\n- Risks/uncertainty",
            systemPrompt:
              "You are a market signals researcher. Focus on trends, signals, and primary evidence. Be concise and structured.",
            temperature: 0.4,
            maxTokens: 900,
          },
          {
            roleKey: "workerB",
            label: "Competitor Intelligence Researcher",
            agentId: workerBAgentId,
            taskTemplate:
              "User request: {{vars.userRequest}}\n\nDelegation plan:\n{{vars.plan}}\n\nExecute TASK_B only.\nReturn:\n- Competitors/alternatives reviewed\n- Key comparisons\n- Recommended direction",
            systemPrompt:
              "You are a competitor intelligence researcher. Focus on alternatives, positioning, and trade-offs. Be concise and structured.",
            temperature: 0.4,
            maxTokens: 900,
          },
        ],
      },
    },
    {
      id: orchestratorFinalId,
      type: "claude-agent",
      position: { x: 1340, y: 200 },
      data: {
        label: "Orchestrator: Final Response",
        agentId: orchestratorAgentId,
        systemPrompt:
          "You are the orchestrator producing the final answer.\n\nOriginal request:\n{{vars.userRequest}}\n\nPlan:\n{{vars.plan}}\n\nWorker A report:\n{{parallel.workerAReport}}\n\nWorker B report:\n{{parallel.workerBReport}}\n\nSynthesize one final response with:\n1) Final recommendation\n2) Key evidence from each worker\n3) Suggested next actions",
        temperature: 0.3,
        maxTokens: 1400,
      },
    },
    {
      id: channelId,
      type: "send-webchat",
      position: { x: 1600, y: 200 },
      data: { label: "Send WebChat" },
    },
  ];

  const edges = [
    { id: `e-${manualId}-${orchestratorPlanId}`, source: manualId, target: orchestratorPlanId },
    { id: `e-${triggerId}-${orchestratorPlanId}`, source: triggerId, target: orchestratorPlanId },
    { id: `e-${orchestratorPlanId}-${setPlanId}`, source: orchestratorPlanId, target: setPlanId },
    { id: `e-${setPlanId}-${parallelWorkersId}`, source: setPlanId, target: parallelWorkersId },
    { id: `e-${parallelWorkersId}-${orchestratorFinalId}`, source: parallelWorkersId, target: orchestratorFinalId },
    { id: `e-${orchestratorFinalId}-${channelId}`, source: orchestratorFinalId, target: channelId },
  ];

  return { nodes, edges };
}

// ─── New templates (v9) ────────────────────────────────────────────────

function getSmartFileOrganizerTemplate() {
  const t = nanoid(8), a = nanoid(8), m = nanoid(8), c = nanoid(8);
  return {
    nodes: [
      { id: t, type: "manual-trigger", position: { x: 100, y: 200 }, data: { label: "Manual Trigger" } },
      { id: a, type: "claude-agent", position: { x: 400, y: 200 }, data: { label: "File Organizer Agent", systemPrompt: "You are a file organizer assistant. List files in the current directory, categorize them by type (documents, images, code, data, etc.), and suggest how to organize them into folders. Use the available tools to actually move/rename files if the user confirms. Always explain what you're doing.", temperature: 0.5, maxTokens: 2048, enabledTools: ["list_files", "read_file", "write_file", "bash_exec", "find_files"] } },
      { id: m, type: "memory-store", position: { x: 740, y: 200 }, data: { label: "Store Findings", extractMode: "auto" } },
      { id: c, type: "send-webchat", position: { x: 1020, y: 200 }, data: { label: "Send WebChat" } },
    ],
    edges: [
      { id: `e-${t}-${a}`, source: t, target: a },
      { id: `e-${a}-${m}`, source: a, target: m },
      { id: `e-${m}-${c}`, source: m, target: c },
    ],
  };
}

function getCodeReviewerTemplate() {
  const t = nanoid(8), mt = nanoid(8), a = nanoid(8), c = nanoid(8);
  return {
    nodes: [
      { id: t, type: "manual-trigger", position: { x: 100, y: 120 }, data: { label: "Manual Trigger (Test)" } },
      { id: mt, type: "message-trigger", position: { x: 100, y: 280 }, data: { label: "Message Trigger", channel: "webchat" } },
      { id: a, type: "claude-agent", position: { x: 420, y: 200 }, data: { label: "Code Reviewer", systemPrompt: "You are an expert code reviewer. When given a file path or code snippet, read the file, analyze it for:\n- Bugs and potential issues\n- Security vulnerabilities\n- Performance concerns\n- Code style and best practices\n- Missing error handling\n\nProvide a structured review with severity levels (critical/warning/info) and specific line references.", temperature: 0.3, maxTokens: 3000, enabledTools: ["read_file", "find_files", "bash_exec", "list_files"] } },
      { id: c, type: "send-webchat", position: { x: 780, y: 200 }, data: { label: "Send Review" } },
    ],
    edges: [
      { id: `e-${t}-${a}`, source: t, target: a },
      { id: `e-${mt}-${a}`, source: mt, target: a },
      { id: `e-${a}-${c}`, source: a, target: c },
    ],
  };
}

function getResearchAssistantTemplate() {
  const t = nanoid(8), mt = nanoid(8), mr = nanoid(8), a = nanoid(8), ms = nanoid(8), c = nanoid(8);
  return {
    nodes: [
      { id: t, type: "manual-trigger", position: { x: 100, y: 120 }, data: { label: "Manual Trigger" } },
      { id: mt, type: "message-trigger", position: { x: 100, y: 280 }, data: { label: "Message Trigger", channel: "webchat" } },
      { id: mr, type: "memory-recall", position: { x: 380, y: 200 }, data: { label: "Check Memory", query: "{{trigger.input}}{{trigger.message}}", limit: 5 } },
      { id: a, type: "claude-agent", position: { x: 640, y: 200 }, data: { label: "Research Agent", systemPrompt: "You are a research assistant with access to web search and memory. When asked a question:\n1. First check if memory has relevant info\n2. Search the web for current information\n3. Synthesize findings into a clear, sourced answer\n4. Store important findings in memory for future reference\n\nAlways cite your sources.", temperature: 0.5, maxTokens: 2048, enabledTools: ["web_search", "http_request", "memory_search", "memory_get"] } },
      { id: ms, type: "memory-store", position: { x: 940, y: 200 }, data: { label: "Store Findings", extractMode: "auto" } },
      { id: c, type: "send-webchat", position: { x: 1200, y: 200 }, data: { label: "Send WebChat" } },
    ],
    edges: [
      { id: `e-${t}-${mr}`, source: t, target: mr },
      { id: `e-${mt}-${mr}`, source: mt, target: mr },
      { id: `e-${mr}-${a}`, source: mr, target: a },
      { id: `e-${a}-${ms}`, source: a, target: ms },
      { id: `e-${ms}-${c}`, source: ms, target: c },
    ],
  };
}

function getDocsSiteCrawlerSummaryTemplate() {
  const manualId = nanoid(8);
  const messageId = nanoid(8);
  const parseId = nanoid(8);
  const crawlId = nanoid(8);
  const summarizeId = nanoid(8);
  const memoryId = nanoid(8);
  const sendId = nanoid(8);

  return {
    nodes: [
      {
        id: manualId,
        type: "manual-trigger",
        position: { x: 100, y: 120 },
        data: { label: "Manual Trigger" },
      },
      {
        id: messageId,
        type: "message-trigger",
        position: { x: 100, y: 280 },
        data: { label: "Message Trigger", channel: "webchat" },
      },
      {
        id: parseId,
        type: "run-code",
        position: { x: 360, y: 200 },
        data: {
          label: "Plan Crawl Strategy",
          timeout: 5000,
          code: `const raw = String(input.message || input.inputData?.input || input.prompt || "").trim();
const fallbackUrl = "https://docs.python.org/3/";
const urlMatch = raw.match(/https?:\\/\\/[^\\s)]+/i);
const url = urlMatch ? urlMatch[0] : fallbackUrl;
const normalized = raw.toLowerCase();

let strategy = "auto";
if (normalized.includes("dynamic") || normalized.includes("javascript") || normalized.includes("spa")) {
  strategy = "dynamic";
} else if (normalized.includes("static") || normalized.includes("fast crawl")) {
  strategy = "static";
}

let maxDepth = 1;
if (normalized.includes("deep")) maxDepth = 2;
if (normalized.includes("very deep") || normalized.includes("exhaustive")) maxDepth = 3;

let maxPages = 12;
const pagesMatch = raw.match(/\\b(\\d{1,2})\\s+pages?\\b/i);
if (pagesMatch) {
  const parsed = parseInt(pagesMatch[1], 10);
  if (Number.isFinite(parsed)) {
    maxPages = Math.max(1, Math.min(40, parsed));
  }
}

const includeSubdomains = normalized.includes("include subdomain") || normalized.includes("subdomains");
const sameDomainOnly = !normalized.includes("cross domain") && !normalized.includes("external sites");
const summaryPrompt = raw || "Summarize this docs site and give a practical learning path.";

result = {
  requestedText: raw,
  seedUrl: url,
  strategy,
  maxDepth,
  maxPages,
  includeSubdomains,
  sameDomainOnly,
  summaryPrompt
};`,
        },
      },
      {
        id: crawlId,
        type: "http-request",
        position: { x: 620, y: 200 },
        data: {
          label: "Deep Crawl Docs Site",
          method: "POST",
          url: "http://localhost:3100/api/documents",
          headers: "{\"Content-Type\":\"application/json\"}",
          body: "{\"action\":\"scrape\",\"mode\":\"crawl\",\"url\":\"{{run.result.seedUrl}}\",\"strategy\":\"{{run.result.strategy}}\",\"maxPages\":{{run.result.maxPages}},\"maxDepth\":{{run.result.maxDepth}},\"sameDomainOnly\":{{run.result.sameDomainOnly}},\"includeSubdomains\":{{run.result.includeSubdomains}},\"requestDelayMs\":120}",
        },
      },
      {
        id: summarizeId,
        type: "claude-agent",
        position: { x: 900, y: 200 },
        data: {
          label: "Summarize Crawled Docs",
          systemPrompt:
            "You are a docs intelligence summarizer.\n\nCrawl request status:\n- HTTP status: {{http.status}}\n- HTTP ok: {{http.ok}}\n- Raw crawl response: {{http.bodyText}}\n- Candidate document id: {{http.body.data.id}}\n\nSteps:\n1) If http.ok is false, explain crawl failure and how to retry with better strategy/depth/pages.\n2) If http.ok is true, read http.body.data.id.\n3) Use tool document_get with that id.\n4) Produce a practical summary:\n- Scope of the docs site\n- 8 key concepts/APIs/features\n- Quickstart path (first 30-60 minutes)\n- Important caveats/limitations\n- Suggested follow-up prompts\n\nUser request context:\n{{run.result.summaryPrompt}}\n\nCrawl plan used:\n- URL: {{run.result.seedUrl}}\n- Strategy: {{run.result.strategy}}\n- Max pages: {{run.result.maxPages}}\n- Max depth: {{run.result.maxDepth}}",
          temperature: 0.3,
          maxTokens: 2200,
          enabledTools: ["document_get", "documents_search", "documents_list"],
        },
      },
      {
        id: memoryId,
        type: "memory-store",
        position: { x: 1180, y: 200 },
        data: { label: "Store Crawl Summary", extractMode: "auto" },
      },
      {
        id: sendId,
        type: "send-webchat",
        position: { x: 1440, y: 200 },
        data: { label: "Send WebChat" },
      },
    ],
    edges: [
      { id: `e-${manualId}-${parseId}`, source: manualId, target: parseId },
      { id: `e-${messageId}-${parseId}`, source: messageId, target: parseId },
      { id: `e-${parseId}-${crawlId}`, source: parseId, target: crawlId },
      { id: `e-${crawlId}-${summarizeId}`, source: crawlId, target: summarizeId },
      { id: `e-${summarizeId}-${memoryId}`, source: summarizeId, target: memoryId },
      { id: `e-${memoryId}-${sendId}`, source: memoryId, target: sendId },
    ],
  };
}

function getDocumentIntelligenceTemplate() {
  const manualId = nanoid(8);
  const messageId = nanoid(8);
  const agentId = nanoid(8);
  const memoryId = nanoid(8);
  const sendId = nanoid(8);

  return {
    nodes: [
      {
        id: manualId,
        type: "manual-trigger",
        position: { x: 100, y: 120 },
        data: { label: "Manual Trigger" },
      },
      {
        id: messageId,
        type: "message-trigger",
        position: { x: 100, y: 280 },
        data: { label: "Message Trigger", channel: "webchat" },
      },
      {
        id: agentId,
        type: "claude-agent",
        position: { x: 420, y: 200 },
        data: {
          label: "Document Intelligence Agent",
          systemPrompt:
            "You are a document intelligence assistant.\n\nUse the document tools to inspect uploaded PDFs, text files, scraped websites, or connected-source snapshots from the Data Sources tab.\n\nRules:\n1) If the user mentions one or more document ids or exact names, fetch them with document_get.\n2) Otherwise, start with documents_search or documents_list to find the best matches.\n3) Summarize clearly, cite the document ids/names you used, and highlight actionable findings.\n4) If comparing multiple documents, present similarities, differences, and recommended next steps.\n5) Never claim to have read a document unless you actually fetched it with a tool in this run.",
          temperature: 0.3,
          maxTokens: 1800,
          enabledTools: ["documents_list", "documents_search", "document_get"],
        },
      },
      {
        id: memoryId,
        type: "memory-store",
        position: { x: 760, y: 200 },
        data: { label: "Store Findings", extractMode: "auto" },
      },
      {
        id: sendId,
        type: "send-webchat",
        position: { x: 1040, y: 200 },
        data: { label: "Send WebChat" },
      },
    ],
    edges: [
      { id: `e-${manualId}-${agentId}`, source: manualId, target: agentId },
      { id: `e-${messageId}-${agentId}`, source: messageId, target: agentId },
      { id: `e-${agentId}-${memoryId}`, source: agentId, target: memoryId },
      { id: `e-${memoryId}-${sendId}`, source: memoryId, target: sendId },
    ],
  };
}

function getGeneralTaskExecutorTemplate() {
  const manualId = nanoid(8);
  const agentId = nanoid(8);
  const memoryId = nanoid(8);

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
          label: "General Task Executor",
          systemPrompt:
            "You are the execution engine for a board task.\n\n" +
            "Treat the incoming task title and description as the work request.\n" +
            "You may inspect files, call APIs, search memory, work with documents, create board tasks, create workflows from templates, and inspect schedules.\n\n" +
            "Rules:\n" +
            "1) Prefer using tools instead of guessing.\n" +
            "2) If the task implies follow-up work, create board tasks only when useful and say what you created.\n" +
            "3) If the user asks for a workflow, use the workflow template tools instead of describing a workflow abstractly.\n" +
            "4) Return a concise execution summary with: what you did, result, and any next step.\n\n" +
            "Incoming board task:\n" +
            "- Board: {{trigger.boardName}}\n" +
            "- Title: {{trigger.taskTitle}}\n" +
            "- Description: {{trigger.taskDescription}}",
          temperature: 0.3,
          maxTokens: 2200,
          maxToolCalls: 40,
          enabledTools: [
            "read_file",
            "list_files",
            "find_files",
            "system_info",
            "http_request",
            "web_search",
            "memory_search",
            "memory_gpt",
            "memory_get",
            "documents_list",
            "documents_search",
            "document_get",
            "document_ingest",
            "board_tasks",
            "workflow_templates",
            "workflow_create",
            "schedules_list",
            "call_workflow",
            "schedule_task",
          ],
        },
      },
      {
        id: memoryId,
        type: "memory-store",
        position: { x: 720, y: 200 },
        data: { label: "Store Findings", extractMode: "auto" },
      },
    ],
    edges: [
      { id: `e-${manualId}-${agentId}`, source: manualId, target: agentId },
      { id: `e-${agentId}-${memoryId}`, source: agentId, target: memoryId },
    ],
  };
}

function getChannelWorkspaceAssistantTemplate() {
  const telegramId = nanoid(8);
  const discordId = nanoid(8);
  const webchatId = nanoid(8);
  const whatsappId = nanoid(8);
  const googleChatId = nanoid(8);
  const slackId = nanoid(8);
  const bluebubblesId = nanoid(8);
  const teamsId = nanoid(8);
  const manualId = nanoid(8);
  const agentId = nanoid(8);

  const triggerNodes = [
    { id: telegramId, type: "telegram-trigger", position: { x: 100, y: 40 }, data: { label: "Telegram Trigger" } },
    { id: discordId, type: "discord-trigger", position: { x: 100, y: 120 }, data: { label: "Discord Trigger" } },
    { id: webchatId, type: "message-trigger", position: { x: 100, y: 200 }, data: { label: "WebChat Trigger", channel: "webchat" } },
    { id: whatsappId, type: "message-trigger", position: { x: 100, y: 280 }, data: { label: "WhatsApp Trigger", channel: "whatsapp" } },
    { id: googleChatId, type: "message-trigger", position: { x: 100, y: 360 }, data: { label: "Google Chat Trigger", channel: "google-chat" } },
    { id: slackId, type: "message-trigger", position: { x: 100, y: 440 }, data: { label: "Slack Trigger", channel: "slack" } },
    { id: bluebubblesId, type: "message-trigger", position: { x: 100, y: 520 }, data: { label: "BlueBubbles Trigger", channel: "bluebubbles" } },
    { id: teamsId, type: "message-trigger", position: { x: 100, y: 600 }, data: { label: "Teams Trigger", channel: "teams" } },
    { id: manualId, type: "manual-trigger", position: { x: 100, y: 680 }, data: { label: "Manual Trigger" } },
  ];

  return {
    nodes: [
      ...triggerNodes,
      {
        id: agentId,
        type: "claude-agent",
        position: { x: 430, y: 360 },
        data: {
          label: "Workspace Assistant",
          systemPrompt:
            "You are disp8ch's cross-channel workspace assistant.\n\n" +
            "You can handle normal conversation and real work across the product surface: Boards, Data Sources, Workflows, Scheduler, Memory, and local system tools.\n\n" +
            "Operating rules:\n" +
            "1) For general questions, answer normally and use tools when the answer depends on current local state.\n" +
            "2) For task requests, create or manage board tasks with board_tasks.\n" +
            "3) For requests to create a workflow template, use workflow_templates first if needed, then workflow_create with the closest matching built-in template.\n" +
            "4) For docs/site ingestion requests, use document_ingest or the document tools.\n" +
            "5) For scheduler requests, inspect with schedules_list and install schedules with schedule_task when appropriate.\n" +
            "6) Never pretend a workflow or task was created if the tool did not succeed.\n\n" +
            "Be direct, practical, and tool-first.",
          temperature: 0.4,
          maxTokens: 2200,
          maxToolCalls: 45,
          enabledTools: [
            "read_file",
            "list_files",
            "find_files",
            "system_info",
            "http_request",
            "web_search",
            "memory_search",
            "memory_gpt",
            "memory_get",
            "documents_list",
            "documents_search",
            "document_get",
            "document_ingest",
            "board_tasks",
            "workflow_templates",
            "workflow_create",
            "schedules_list",
            "call_workflow",
            "schedule_task",
            "send_message",
          ],
        },
      },
    ],
    edges: [
      { id: `e-${telegramId}-${agentId}`, source: telegramId, target: agentId },
      { id: `e-${discordId}-${agentId}`, source: discordId, target: agentId },
      { id: `e-${webchatId}-${agentId}`, source: webchatId, target: agentId },
      { id: `e-${whatsappId}-${agentId}`, source: whatsappId, target: agentId },
      { id: `e-${googleChatId}-${agentId}`, source: googleChatId, target: agentId },
      { id: `e-${slackId}-${agentId}`, source: slackId, target: agentId },
      { id: `e-${bluebubblesId}-${agentId}`, source: bluebubblesId, target: agentId },
      { id: `e-${teamsId}-${agentId}`, source: teamsId, target: agentId },
      { id: `e-${manualId}-${agentId}`, source: manualId, target: agentId },
    ],
  };
}

function getAutomatedBackupTemplate() {
  const cr = nanoid(8), sc = nanoid(8), ie = nanoid(8), a = nanoid(8), e = nanoid(8), c = nanoid(8);
  return {
    nodes: [
      { id: cr, type: "cron-trigger", position: { x: 100, y: 200 }, data: { label: "Daily at Midnight", expression: "0 0 * * *", timezone: "UTC" } },
      { id: sc, type: "system-command", position: { x: 360, y: 200 }, data: { label: "Check Disk Space", action: "pc-specs" } },
      { id: ie, type: "if-else", position: { x: 600, y: 200 }, data: { label: "Disk > 90% Used?", condition: "pcSpecs.disk.freePercent < 10" } },
      { id: a, type: "claude-agent", position: { x: 880, y: 120 }, data: { label: "Backup Agent", systemPrompt: "WARNING: Disk space is critically low. List the largest files and directories, suggest what to clean up, and create a backup of important files. Be careful not to delete anything without explaining first.", temperature: 0.3, maxTokens: 1500, enabledTools: ["bash_exec", "list_files", "system_info"] } },
      { id: e, type: "send-email", position: { x: 1160, y: 120 }, data: { label: "Alert Email", host: "smtp.gmail.com", port: 587, subject: "disp8ch: Disk Space Alert" } },
      { id: c, type: "send-webchat", position: { x: 1160, y: 300 }, data: { label: "Status Update" } },
    ],
    edges: [
      { id: `e-${cr}-${sc}`, source: cr, target: sc },
      { id: `e-${sc}-${ie}`, source: sc, target: ie },
      { id: `e-${ie}-${a}`, source: ie, sourceHandle: "true", target: a },
      { id: `e-${ie}-${c}`, source: ie, sourceHandle: "false", target: c },
      { id: `e-${a}-${e}`, source: a, target: e },
      { id: `e-${a}-${c}`, source: a, target: c },
    ],
  };
}

function getMultiChannelRouterTemplate() {
  const mt = nanoid(8), ie = nanoid(8), a1 = nanoid(8), a2 = nanoid(8), st = nanoid(8), sc = nanoid(8);
  return {
    nodes: [
      { id: mt, type: "message-trigger", position: { x: 100, y: 200 }, data: { label: "Any Channel Message", channel: "webchat" } },
      { id: ie, type: "if-else", position: { x: 360, y: 200 }, data: { label: "Is Telegram?", condition: "channel == 'telegram'" } },
      { id: a1, type: "claude-agent", position: { x: 640, y: 100 }, data: { label: "Telegram Agent", systemPrompt: "You are a concise assistant for Telegram. Keep replies short and use markdown formatting.", temperature: 0.7, maxTokens: 512 } },
      { id: a2, type: "claude-agent", position: { x: 640, y: 300 }, data: { label: "WebChat Agent", systemPrompt: "You are a helpful assistant for WebChat. You can provide detailed, formatted responses.", temperature: 0.7, maxTokens: 1024 } },
      { id: st, type: "send-telegram", position: { x: 920, y: 100 }, data: { label: "Send Telegram" } },
      { id: sc, type: "send-webchat", position: { x: 920, y: 300 }, data: { label: "Send WebChat" } },
    ],
    edges: [
      { id: `e-${mt}-${ie}`, source: mt, target: ie },
      { id: `e-${ie}-${a1}`, source: ie, sourceHandle: "true", target: a1 },
      { id: `e-${ie}-${a2}`, source: ie, sourceHandle: "false", target: a2 },
      { id: `e-${a1}-${st}`, source: a1, target: st },
      { id: `e-${a2}-${sc}`, source: a2, target: sc },
    ],
  };
}

function getTelegramBoardIntakeTemplate() {
  const tgTriggerId = nanoid(8);
  const discordTriggerId = nanoid(8);
  const webchatTriggerId = nanoid(8);
  const whatsappTriggerId = nanoid(8);
  const googleChatTriggerId = nanoid(8);
  const manualTriggerId = nanoid(8);
  const parseId = nanoid(8);
  const runBranchId = nanoid(8);
  const listBranchId = nanoid(8);
  const runTaskHttpId = nanoid(8);
  const createTaskId = nanoid(8);
  const listTasksId = nanoid(8);
  const formatRunId = nanoid(8);
  const formatCreateId = nanoid(8);
  const formatListId = nanoid(8);
  const sendId = nanoid(8);

  return {
    nodes: [
      {
        id: tgTriggerId,
        type: "telegram-trigger",
        position: { x: 100, y: 80 },
        data: { label: "Telegram Trigger", filter: "task, board, todo, add task, list tasks, run task, please add, inbox" },
      },
      {
        id: discordTriggerId,
        type: "discord-trigger",
        position: { x: 100, y: 170 },
        data: { label: "Discord Trigger", filter: "task, board, todo, add task, list tasks, run task, please add, inbox" },
      },
      {
        id: webchatTriggerId,
        type: "message-trigger",
        position: { x: 100, y: 260 },
        data: { label: "WebChat Trigger", channel: "webchat", filter: "task, board, todo, add task, list tasks, run task, please add, inbox" },
      },
      {
        id: whatsappTriggerId,
        type: "message-trigger",
        position: { x: 100, y: 350 },
        data: { label: "WhatsApp Trigger", channel: "whatsapp", filter: "task, board, todo, add task, list tasks, run task, please add, inbox" },
      },
      {
        id: googleChatTriggerId,
        type: "message-trigger",
        position: { x: 100, y: 440 },
        data: { label: "Google Chat Trigger", channel: "google-chat", filter: "task, board, todo, add task, list tasks, run task, please add, inbox" },
      },
      {
        id: manualTriggerId,
        type: "manual-trigger",
        position: { x: 100, y: 530 },
        data: { label: "Manual Trigger (Test)" },
      },
      {
        id: parseId,
        type: "run-code",
        position: { x: 360, y: 240 },
        data: {
          label: "Parse Channel Command",
          timeout: 5000,
          code: `const raw = String(input.message || input.inputData?.input || input.prompt || "").trim();
const normalized = raw.toLowerCase();
const runMatch =
  raw.match(/(?:^|\\b)(?:run|execute|start|begin|work\\s+on)\\s+task\\s+([A-Za-z0-9_-]{6,})\\b/i) ||
  raw.match(/(?:^|\\b)task\\s+([A-Za-z0-9_-]{6,})\\s+(?:run|execute|start)\\b/i);
const wantsInbox =
  normalized.includes("inbox task") ||
  normalized.includes("tasks in inbox") ||
  normalized === "inbox" ||
  normalized === "show inbox" ||
  normalized === "list inbox" ||
  normalized.includes("what's in my inbox") ||
  normalized.includes("what is in my inbox");
const wantsList =
  normalized.startsWith("list") ||
  normalized.includes("show tasks") ||
  normalized.includes("board tasks") ||
  normalized.includes("task list") ||
  normalized.includes("my tasks") ||
  normalized.includes("what tasks") ||
  normalized.includes("which tasks") ||
  wantsInbox;
const createMatch = raw.match(/^(?:task\\s*:|add\\s+task\\s*:?|create\\s+(?:a\\s+)?task\\s*:?|new\\s+task\\s*:?)\\s*(.+)$/i);
const cleaned = (createMatch ? createMatch[1] : raw)
  .replace(/^task\\s*:\\s*/i, "")
  .replace(/^add\\s+task\\s*:?\\s*/i, "")
  .replace(/^create\\s+(?:a\\s+)?task\\s*:?\\s*/i, "")
  .replace(/^new\\s+task\\s*:?\\s*/i, "")
  .trim();
const titleBase = cleaned || raw || "New channel task";
const title = titleBase.length > 100 ? titleBase.slice(0, 97) + "..." : titleBase;
const action = runMatch ? "run" : (wantsList ? "list" : "create");
const description = [
  "Source: " + (input.channel || "webchat"),
  "Sender: " + (input.sender || "unknown"),
  "Chat ID: " + (input.chatId || "n/a"),
  "",
  raw || "(empty command)"
].join("\\n");

result = {
  action,
  runTaskId: runMatch ? runMatch[1] : "",
  runBody: JSON.stringify({
    id: runMatch ? runMatch[1] : "",
    status: "in_progress"
  }),
  boardBody: JSON.stringify({
    boardId: "main-board",
    title,
    description,
    status: "inbox",
    priority: "medium"
  }),
  listUrl: "http://localhost:3100/api/boards/tasks?boardId=main-board",
  raw,
  helpHint: "Try plain English: 'add task finish invoice sync', 'what's in my inbox?', or 'run task <taskId>'."
};`,
        },
      },
      {
        id: runBranchId,
        type: "if-else",
        position: { x: 620, y: 240 },
        data: {
          label: "Run Task Command?",
          condition: "result_action == 'run'",
        },
      },
      {
        id: listBranchId,
        type: "if-else",
        position: { x: 840, y: 240 },
        data: {
          label: "List Tasks Command?",
          condition: "result_action == 'list'",
        },
      },
      {
        id: runTaskHttpId,
        type: "http-request",
        position: { x: 1120, y: 60 },
        data: {
          label: "Move Task To In Progress",
          url: "http://localhost:3100/api/boards/tasks",
          method: "PATCH",
          body: "{{run.result.runBody}}",
        },
      },
      {
        id: createTaskId,
        type: "http-request",
        position: { x: 1120, y: 180 },
        data: {
          label: "Create Board Task",
          url: "http://localhost:3100/api/boards/tasks",
          method: "POST",
          body: "{{run.result.boardBody}}",
        },
      },
      {
        id: listTasksId,
        type: "http-request",
        position: { x: 1120, y: 340 },
        data: {
          label: "List Board Tasks",
          url: "{{run.result.listUrl}}",
          method: "GET",
        },
      },
      {
        id: formatRunId,
        type: "run-code",
        position: { x: 1380, y: 60 },
        data: {
          label: "Format Run Response",
          timeout: 5000,
          code: `const payload = input.body || {};
const task = payload && payload.data ? payload.data : null;
if (input.ok && payload.success && task && task.id) {
  result = {
    response: "Task **" + task.id + "** moved to **" + task.status + "**. Continue execution from Boards."
  };
} else {
  const errorText = payload.error || input.bodyText || "unknown error";
  result = {
    response: "Run task failed: " + errorText + ". Use 'run task <taskId>' with a valid ID from 'list tasks'."
  };
}`,
        },
      },
      {
        id: formatCreateId,
        type: "run-code",
        position: { x: 1380, y: 180 },
        data: {
          label: "Format Create Response",
          timeout: 5000,
          code: `const payload = input.body || {};
const task = payload && payload.data ? payload.data : null;
if (input.ok && payload.success && task && task.id) {
  result = {
    response: "Task **" + task.id + "** (\\"" + task.title + "\\") added to **" + task.status + "**."
  };
} else {
  const errorText = payload.error || input.bodyText || "unknown error";
  result = {
    response: "Task creation failed: " + errorText + ". Use 'Task: <title>' format and ensure board 'main-board' exists."
  };
}`,
        },
      },
      {
        id: formatListId,
        type: "run-code",
        position: { x: 1380, y: 340 },
        data: {
          label: "Format List Response",
          timeout: 5000,
          code: CHANNEL_BOARD_LIST_RESPONSE_CODE,
        },
      },
      {
        id: sendId,
        type: "send-webchat",
        position: { x: 1650, y: 240 },
        data: { label: "Send Channel Response" },
      },
    ],
    edges: [
      { id: `e-${tgTriggerId}-${parseId}`, source: tgTriggerId, target: parseId },
      { id: `e-${discordTriggerId}-${parseId}`, source: discordTriggerId, target: parseId },
      { id: `e-${webchatTriggerId}-${parseId}`, source: webchatTriggerId, target: parseId },
      { id: `e-${whatsappTriggerId}-${parseId}`, source: whatsappTriggerId, target: parseId },
      { id: `e-${googleChatTriggerId}-${parseId}`, source: googleChatTriggerId, target: parseId },
      { id: `e-${manualTriggerId}-${parseId}`, source: manualTriggerId, target: parseId },
      { id: `e-${parseId}-${runBranchId}`, source: parseId, target: runBranchId },
      { id: `e-${runBranchId}-${runTaskHttpId}`, source: runBranchId, sourceHandle: "true", target: runTaskHttpId },
      { id: `e-${runBranchId}-${listBranchId}`, source: runBranchId, sourceHandle: "false", target: listBranchId },
      { id: `e-${listBranchId}-${listTasksId}`, source: listBranchId, sourceHandle: "true", target: listTasksId },
      { id: `e-${listBranchId}-${createTaskId}`, source: listBranchId, sourceHandle: "false", target: createTaskId },
      { id: `e-${runTaskHttpId}-${formatRunId}`, source: runTaskHttpId, target: formatRunId },
      { id: `e-${createTaskId}-${formatCreateId}`, source: createTaskId, target: formatCreateId },
      { id: `e-${listTasksId}-${formatListId}`, source: listTasksId, target: formatListId },
      { id: `e-${formatRunId}-${sendId}`, source: formatRunId, target: sendId },
      { id: `e-${formatCreateId}-${sendId}`, source: formatCreateId, target: sendId },
      { id: `e-${formatListId}-${sendId}`, source: formatListId, target: sendId },
    ],
  };
}

function getScreenshotAnalyzerTemplate() {
  const t = nanoid(8), a = nanoid(8), c = nanoid(8);
  return {
    nodes: [
      { id: t, type: "manual-trigger", position: { x: 100, y: 200 }, data: { label: "Manual Trigger" } },
      { id: a, type: "claude-agent", position: { x: 420, y: 200 }, data: { label: "Screenshot Analyzer", systemPrompt: "You are a screen analysis assistant. Take a screenshot of the current desktop, then analyze what you see. Describe:\n- What applications are open\n- What the user appears to be working on\n- Any errors or notifications visible\n- Suggestions for the user based on what you see\n\nBe helpful and specific about what you observe.", temperature: 0.5, maxTokens: 2048, enabledTools: ["take_screenshot", "image_view", "browser_action"] } },
      { id: c, type: "send-webchat", position: { x: 780, y: 200 }, data: { label: "Send Analysis" } },
    ],
    edges: [
      { id: `e-${t}-${a}`, source: t, target: a },
      { id: `e-${a}-${c}`, source: a, target: c },
    ],
  };
}

function getGitStatusReporterTemplate() {
  const cr = nanoid(8), g = nanoid(8), ie = nanoid(8), a = nanoid(8), n = nanoid(8), c = nanoid(8);
  return {
    nodes: [
      { id: cr, type: "cron-trigger", position: { x: 100, y: 200 }, data: { label: "Every 2 Hours", expression: "0 */2 * * *", timezone: "UTC" } },
      { id: g, type: "git-operation", position: { x: 360, y: 200 }, data: { label: "Git Status", action: "status", repoPath: "." } },
      { id: ie, type: "if-else", position: { x: 600, y: 200 }, data: { label: "Has Changes?", condition: "output.length > 0" } },
      { id: a, type: "claude-agent", position: { x: 880, y: 120 }, data: { label: "Summarize Changes", systemPrompt: "You are a git status reporter. Summarize the uncommitted changes in a clear format:\n- New files\n- Modified files\n- Deleted files\n\nSuggest whether the user should commit, stash, or review these changes.", temperature: 0.3, maxTokens: 1024 } },
      { id: n, type: "notification", position: { x: 1160, y: 120 }, data: { label: "Desktop Alert", title: "Git: Uncommitted Changes", message: "{{response}}" } },
      { id: c, type: "send-webchat", position: { x: 880, y: 300 }, data: { label: "No Changes" } },
    ],
    edges: [
      { id: `e-${cr}-${g}`, source: cr, target: g },
      { id: `e-${g}-${ie}`, source: g, target: ie },
      { id: `e-${ie}-${a}`, source: ie, sourceHandle: "true", target: a },
      { id: `e-${ie}-${c}`, source: ie, sourceHandle: "false", target: c },
      { id: `e-${a}-${n}`, source: a, target: n },
    ],
  };
}

function getLocalApiTesterTemplate() {
  const t = nanoid(8), v1 = nanoid(8), h = nanoid(8), v2 = nanoid(8), cfg = nanoid(8), v3 = nanoid(8), rc = nanoid(8), c = nanoid(8);
  return {
    nodes: [
      { id: t, type: "manual-trigger", position: { x: 100, y: 200 }, data: { label: "Manual Trigger" } },
      {
        id: v1,
        type: "set-variables",
        position: { x: 340, y: 200 },
        data: {
          label: "API Config",
          assignments: [{ key: "baseUrl", value: "http://127.0.0.1:3100" }],
        },
      },
      {
        id: h,
        type: "http-request",
        position: { x: 600, y: 200 },
        data: { label: "GET /api/health", url: "{{vars.baseUrl}}/api/health", method: "GET" },
      },
      {
        id: v2,
        type: "set-variables",
        position: { x: 860, y: 200 },
        data: {
          label: "Store Health Result",
          assignments: [
            { key: "baseUrl", value: "{{vars.baseUrl}}" },
            { key: "healthStatus", value: "{{http.status}}" },
            { key: "healthOk", value: "{{http.ok}}" },
            { key: "healthBody", value: "{{http.bodyText}}" },
          ],
        },
      },
      {
        id: cfg,
        type: "http-request",
        position: { x: 1120, y: 200 },
        data: { label: "GET /api/config", url: "{{vars.baseUrl}}/api/config", method: "GET" },
      },
      {
        id: v3,
        type: "set-variables",
        position: { x: 1380, y: 200 },
        data: {
          label: "Store Config Result",
          assignments: [
            { key: "baseUrl", value: "{{vars.baseUrl}}" },
            { key: "healthStatus", value: "{{vars.healthStatus}}" },
            { key: "healthOk", value: "{{vars.healthOk}}" },
            { key: "healthBody", value: "{{vars.healthBody}}" },
            { key: "configStatus", value: "{{http.status}}" },
            { key: "configOk", value: "{{http.ok}}" },
            { key: "configBody", value: "{{http.bodyText}}" },
          ],
        },
      },
      {
        id: rc,
        type: "run-code",
        position: { x: 1640, y: 200 },
        data: {
          label: "Format Report",
          code:
            "const vars = input.vars || {};\n" +
            "function parseSummary(raw) {\n" +
            "  const text = String(raw || '');\n" +
            "  if (!text) return 'No body returned';\n" +
            "  try {\n" +
            "    const parsed = JSON.parse(text);\n" +
            "    const payload = parsed && typeof parsed === 'object' && parsed.data ? parsed.data : parsed;\n" +
            "    if (payload && typeof payload === 'object') {\n" +
            "      const keys = Object.keys(payload).slice(0, 8);\n" +
            "      if ('healthy' in payload) {\n" +
            "        const checks = Array.isArray(payload.checks) ? payload.checks.length : 0;\n" +
            "        return `healthy=${String(payload.healthy)}${checks ? `, checks=${checks}` : ''}`;\n" +
            "      }\n" +
            "      if (keys.length > 0) return `keys: ${keys.join(', ')}`;\n" +
            "    }\n" +
            "  } catch {}\n" +
            "  return text.slice(0, 240);\n" +
            "}\n" +
            "function isPass(value) {\n" +
            "  return String(value) === 'true' || String(value) === '1';\n" +
            "}\n" +
            "const healthPass = isPass(vars.healthOk);\n" +
            "const configPass = isPass(vars.configOk);\n" +
            "result = [\n" +
            "  '## API Test Report',\n" +
            "  '',\n" +
            "  `Generated: ${new Date().toISOString()}`,\n" +
            "  `Target Host: ${String(vars.baseUrl || '')}`,\n" +
            "  '',\n" +
            "  '| Endpoint | Result | Status | Summary |',\n" +
            "  '|---|---|---|---|',\n" +
            "  `| /api/health | ${healthPass ? 'PASS' : 'FAIL'} | HTTP ${String(vars.healthStatus || '0')} | ${parseSummary(vars.healthBody)} |`,\n" +
            "  `| /api/config | ${configPass ? 'PASS' : 'FAIL'} | HTTP ${String(vars.configStatus || '0')} | ${parseSummary(vars.configBody)} |`,\n" +
            "  '',\n" +
            "  healthPass && configPass\n" +
            "    ? 'Summary: local API checks completed successfully from the workflow runtime.'\n" +
            "    : 'Summary: one or more local API checks failed from the workflow runtime.',\n" +
            "].join('\\n');",
          timeout: 5000,
        },
      },
      {
        id: c,
        type: "send-webchat",
        position: { x: 1900, y: 200 },
        data: { label: "Send Report", message: "{{run.result}}" },
      },
    ],
    edges: [
      { id: `e-${t}-${v1}`, source: t, target: v1 },
      { id: `e-${v1}-${h}`, source: v1, target: h },
      { id: `e-${h}-${v2}`, source: h, target: v2 },
      { id: `e-${v2}-${cfg}`, source: v2, target: cfg },
      { id: `e-${cfg}-${v3}`, source: cfg, target: v3 },
      { id: `e-${v3}-${rc}`, source: v3, target: rc },
      { id: `e-${rc}-${c}`, source: rc, target: c },
    ],
  };
}

function getClipboardToMemoryTemplate() {
  const t = nanoid(8), cb = nanoid(8), a = nanoid(8), ms = nanoid(8), c = nanoid(8);
  return {
    nodes: [
      { id: t, type: "manual-trigger", position: { x: 100, y: 200 }, data: { label: "Manual Trigger" } },
      { id: cb, type: "clipboard", position: { x: 340, y: 200 }, data: { label: "Read Clipboard", action: "read" } },
      { id: a, type: "claude-agent", position: { x: 580, y: 200 }, data: { label: "Categorize Content", systemPrompt: "You received clipboard content. Categorize it (code snippet, URL, note, contact info, etc.) and produce a clean summary suitable for long-term memory storage. Keep it concise.", temperature: 0.3, maxTokens: 512 } },
      { id: ms, type: "memory-store", position: { x: 860, y: 200 }, data: { label: "Store in Memory", extractMode: "auto" } },
      { id: c, type: "send-webchat", position: { x: 1120, y: 200 }, data: { label: "Confirm Stored" } },
    ],
    edges: [
      { id: `e-${t}-${cb}`, source: t, target: cb },
      { id: `e-${cb}-${a}`, source: cb, target: a },
      { id: `e-${a}-${ms}`, source: a, target: ms },
      { id: `e-${ms}-${c}`, source: ms, target: c },
    ],
  };
}

function getErrorResilientPipelineTemplate() {
  const cr = nanoid(8), hr = nanoid(8), eh = nanoid(8), a = nanoid(8), ms = nanoid(8), em = nanoid(8), c = nanoid(8);
  return {
    nodes: [
      { id: cr, type: "cron-trigger", position: { x: 100, y: 200 }, data: { label: "Every 30 Minutes", expression: "*/30 * * * *", timezone: "UTC" } },
      { id: hr, type: "http-request", position: { x: 360, y: 200 }, data: { label: "Fetch API Data", url: "https://api.example.com/status", method: "GET" } },
      { id: eh, type: "error-handler", position: { x: 620, y: 200 }, data: { label: "Handle Errors" } },
      { id: a, type: "claude-agent", position: { x: 900, y: 120 }, data: { label: "Process Data", systemPrompt: "Analyze the API response and extract key metrics. Summarize the status.", temperature: 0.3, maxTokens: 1024 } },
      { id: ms, type: "memory-store", position: { x: 1160, y: 120 }, data: { label: "Store Results", extractMode: "auto" } },
      { id: em, type: "send-email", position: { x: 900, y: 320 }, data: { label: "Error Alert", host: "smtp.gmail.com", port: 587, subject: "disp8ch: API Fetch Failed" } },
      { id: c, type: "send-webchat", position: { x: 1420, y: 220 }, data: { label: "Send Status" } },
    ],
    edges: [
      { id: `e-${cr}-${hr}`, source: cr, target: hr },
      { id: `e-${hr}-${eh}`, source: hr, target: eh },
      { id: `e-${eh}-${a}`, source: eh, sourceHandle: "success", target: a },
      { id: `e-${eh}-${em}`, source: eh, sourceHandle: "error", target: em },
      { id: `e-${a}-${ms}`, source: a, target: ms },
      { id: `e-${ms}-${c}`, source: ms, target: c },
      { id: `e-${em}-${c}`, source: em, target: c },
    ],
  };
}

function getTextProcessingPipelineTemplate() {
  const t = nanoid(8), rf = nanoid(8), st = nanoid(8), jt = nanoid(8), a = nanoid(8), c = nanoid(8);
  return {
    nodes: [
      { id: t, type: "manual-trigger", position: { x: 100, y: 200 }, data: { label: "Manual Trigger" } },
      { id: rf, type: "read-file", position: { x: 340, y: 200 }, data: { label: "Read Document", path: "./data/input.txt", encoding: "utf-8" } },
      { id: st, type: "split-text", position: { x: 580, y: 200 }, data: { label: "Split into Chunks", mode: "characters", chunkSize: 2000 } },
      { id: jt, type: "json-transform", position: { x: 820, y: 200 }, data: { label: "Format Chunks", expression: "result = { chunks: input.chunks, summary: `${input.totalChunks} chunks of ~2000 chars each` };" } },
      { id: a, type: "claude-agent", position: { x: 1060, y: 200 }, data: { label: "Analyze Document", systemPrompt: "You received a document split into chunks. Analyze the content and provide:\n1. A brief summary\n2. Key topics and themes\n3. Any action items or important dates mentioned\n4. Overall sentiment", temperature: 0.3, maxTokens: 2048 } },
      { id: c, type: "send-webchat", position: { x: 1340, y: 200 }, data: { label: "Send Analysis" } },
    ],
    edges: [
      { id: `e-${t}-${rf}`, source: t, target: rf },
      { id: `e-${rf}-${st}`, source: rf, target: st },
      { id: `e-${st}-${jt}`, source: st, target: jt },
      { id: `e-${jt}-${a}`, source: jt, target: a },
      { id: `e-${a}-${c}`, source: a, target: c },
    ],
  };
}

function getDbQueryDashboardTemplate() {
  const t = nanoid(8), mt = nanoid(8), dq = nanoid(8), rc = nanoid(8), c = nanoid(8);
  return {
    nodes: [
      { id: t, type: "manual-trigger", position: { x: 100, y: 120 }, data: { label: "Manual Trigger" } },
      { id: mt, type: "message-trigger", position: { x: 100, y: 280 }, data: { label: "Message Trigger", channel: "webchat" } },
      {
        id: dq,
        type: "database-query",
        position: { x: 400, y: 200 },
        data: {
          label: "Query disp8ch DB",
          dbPath: "./data/disp8ch.db",
          query:
            "SELECT " +
            "(SELECT COUNT(*) FROM workflows) AS workflows, " +
            "(SELECT COUNT(*) FROM executions) AS executions, " +
            "(SELECT COUNT(*) FROM models) AS models, " +
            "(SELECT COUNT(*) FROM board_tasks) AS board_tasks;",
        },
      },
      {
        id: rc,
        type: "run-code",
        position: { x: 700, y: 200 },
        data: {
          label: "Format Dashboard",
          timeout: 5000,
          code:
            "const row = Array.isArray(input.rows) && input.rows[0] ? input.rows[0] : {};\n" +
            "const workflows = Number(row.workflows || 0);\n" +
            "const executions = Number(row.executions || 0);\n" +
            "const models = Number(row.models || 0);\n" +
            "const boardTasks = Number(row.board_tasks || 0);\n" +
            "const execPerWorkflow = workflows > 0 ? (executions / workflows).toFixed(1) : '0.0';\n" +
            "result = {\n" +
            "  response: [\n" +
            "    '## Database Dashboard',\n" +
            "    '',\n" +
            "    `Generated: ${new Date().toISOString()}`,\n" +
            "    '',\n" +
            "    `- Workflows: ${workflows}`,\n" +
            "    `- Executions: ${executions}`,\n" +
            "    `- Models: ${models}`,\n" +
            "    `- Board tasks: ${boardTasks}`,\n" +
            "    '',\n" +
            "    `- Execution density: ${execPerWorkflow} runs per workflow`,\n" +
            "    models > 0 ? '- Model routing is configured.' : '- No models are configured yet.',\n" +
            "  ].join('\\n')\n" +
            "};",
        },
      },
      {
        id: c,
        type: "send-webchat",
        position: { x: 1000, y: 200 },
        data: { label: "Send Dashboard", message: "{{run.result.response}}" },
      },
    ],
    edges: [
      { id: `e-${t}-${dq}`, source: t, target: dq },
      { id: `e-${mt}-${dq}`, source: mt, target: dq },
      { id: `e-${dq}-${rc}`, source: dq, target: rc },
      { id: `e-${rc}-${c}`, source: rc, target: c },
    ],
  };
}

// ─── Cron Board Task Creator template ────────────────────────────────────────
// Every 2 minutes: build a timestamped task payload → POST to boards API → notify webchat
function getCronBoardTaskCreatorTemplate() {
  const manual = nanoid(8), cron = nanoid(8), code = nanoid(8), http = nanoid(8), fmt = nanoid(8), wc = nanoid(8);
  return {
    nodes: [
      {
        id: manual,
        type: "manual-trigger",
        position: { x: 100, y: 80 },
        data: {
          label: "Manual Trigger",
        },
      },
      {
        id: cron,
        type: "cron-trigger",
        position: { x: 100, y: 200 },
        data: {
          label: "Every 2 Minutes",
          expression: "*/2 * * * *",
          timezone: "UTC",
        },
      },
      {
        id: code,
        type: "run-code",
        position: { x: 400, y: 200 },
        data: {
          label: "Build Task Payload",
          code: [
            "var now = new Date();",
            "var pad = function(n){ return String(n).padStart(2,'0'); };",
            "var stamp = now.getFullYear()+'-'+pad(now.getMonth()+1)+'-'+pad(now.getDate())+' '+pad(now.getHours())+':'+pad(now.getMinutes())+' UTC';",
            "result = JSON.stringify({",
            "  boardId: 'main-board',",
            "  title: 'Scheduled check: ' + stamp,",
            "  description: 'Auto-created by cron workflow. ISO timestamp: ' + now.toISOString(),",
            "  sourceType: 'cron-generated',",
            "  sourceRef: 'cron-board-task-creator',",
            "  status: 'inbox',",
            "  priority: 'medium'",
            "});",
          ].join("\n"),
          timeout: 3000,
        },
      },
      {
        id: http,
        type: "http-request",
        position: { x: 700, y: 200 },
        data: {
          label: "Create Board Task",
          url: "http://127.0.0.1:3100/api/boards/tasks",
          method: "POST",
          body: "{{run.result}}",
        },
      },
      {
        id: fmt,
        type: "run-code",
        position: { x: 960, y: 200 },
        data: {
          label: "Format Created Task",
          timeout: 5000,
          code: [
            "const payload = input.body || {};",
            "const task = payload && payload.data ? payload.data : null;",
            "if (input.ok && payload.success && task && task.id) {",
            "  result = {",
            "    response: [",
            "      '## Cron Board Task Creator',",
            "      '',",
            "      'Created a scheduled board task successfully.',",
            "      '',",
            "      `- Title: ${task.title}`,",
            "      `- Status: ${task.status}`,",
            "      `- Task ID: ${task.id}`,",
            "      `- Board: ${task.boardName || task.boardId || 'main-board'}`,",
            "    ].join('\\n')",
            "  };",
            "} else {",
            "  const errorText = payload.error || input.bodyText || 'unknown error';",
            "  result = { response: 'Cron board task creator failed: ' + errorText };",
            "}",
          ].join("\n"),
        },
      },
      {
        id: wc,
        type: "send-webchat",
        position: { x: 1220, y: 200 },
        data: {
          label: "Notify WebChat",
          message: "{{run.result.response}}",
        },
      },
    ],
    edges: [
      { id: `e-${manual}-${code}`, source: manual, target: code },
      { id: `e-${cron}-${code}`, source: cron, target: code },
      { id: `e-${code}-${http}`, source: code, target: http },
      { id: `e-${http}-${fmt}`,  source: http,  target: fmt },
      { id: `e-${fmt}-${wc}`,  source: fmt,  target: wc },
    ],
  };
}

function getOpsControlTowerTemplate() {
  const manual = nanoid(8);
  const message = nanoid(8);
  const seed = nanoid(8);
  const now = nanoid(8);
  const saveNow = nanoid(8);
  const due = nanoid(8);
  const saveDue = nanoid(8);
  const channels = nanoid(8);
  const saveChannels = nanoid(8);
  const schedules = nanoid(8);
  const saveSchedules = nanoid(8);
  const docs = nanoid(8);
  const saveDocs = nanoid(8);
  const tasks = nanoid(8);
  const saveTasks = nanoid(8);
  const templates = nanoid(8);
  const saveTemplates = nanoid(8);
  const council = nanoid(8);
  const saveCouncil = nanoid(8);
  const db = nanoid(8);
  const saveDb = nanoid(8);
  const report = nanoid(8);
  const saveReport = nanoid(8);
  const write = nanoid(8);
  const memory = nanoid(8);
  const send = nanoid(8);

  return {
    nodes: [
      { id: manual, type: "manual-trigger", position: { x: 100, y: 80 }, data: { label: "Manual Trigger" } },
      { id: message, type: "message-trigger", position: { x: 100, y: 220 }, data: { label: "Message Trigger", channel: "webchat" } },
      {
        id: seed,
        type: "set-variables",
        position: { x: 360, y: 160 },
        data: {
          label: "Seed Brief Context",
          assignments: [
            { key: "briefTopic", value: "{{trigger.input}}{{trigger.message}}" },
            { key: "scopeOrg", value: "{{trigger.organizationId}}" },
            { key: "scopeGoal", value: "{{trigger.goalId}}" },
          ],
        },
      },
      {
        id: now,
        type: "date-time",
        position: { x: 620, y: 160 },
        data: {
          label: "Capture Current Time",
          operation: "now",
          timezone: "UTC",
          locale: "en-US",
          outputStyle: "datetime",
        },
      },
      {
        id: saveNow,
        type: "set-variables",
        position: { x: 860, y: 160 },
        data: {
          label: "Save Timestamp",
          assignments: [
            { key: "generatedAt", value: "{{date.formatted}}" },
            { key: "generatedTs", value: "{{date.unixSeconds}}" },
          ],
        },
      },
      {
        id: due,
        type: "date-time",
        position: { x: 1100, y: 160 },
        data: {
          label: "Compute Follow-up Date",
          operation: "add",
          input: "{{date.iso}}",
          amount: 2,
          unit: "days",
          timezone: "UTC",
          locale: "en-US",
          outputStyle: "date",
        },
      },
      {
        id: saveDue,
        type: "set-variables",
        position: { x: 1340, y: 160 },
        data: {
          label: "Save Follow-up Date",
          assignments: [{ key: "followUpDate", value: "{{date.formatted}}" }],
        },
      },
      {
        id: channels,
        type: "channel-status",
        position: { x: 1580, y: 160 },
        data: {
          label: "Inspect Channels",
          format: "summary",
        },
      },
      {
        id: saveChannels,
        type: "set-variables",
        position: { x: 1820, y: 160 },
        data: {
          label: "Save Channel Status",
          assignments: [{ key: "channelStatus", value: "{{channel.response}}" }],
        },
      },
      {
        id: schedules,
        type: "scheduler-job",
        position: { x: 2060, y: 160 },
        data: {
          label: "List Schedules",
          action: "list",
        },
      },
      {
        id: saveSchedules,
        type: "set-variables",
        position: { x: 2300, y: 160 },
        data: {
          label: "Save Schedule Status",
          assignments: [{ key: "scheduleStatus", value: "{{scheduler.response}}" }],
        },
      },
      {
        id: docs,
        type: "document-tool",
        position: { x: 2540, y: 160 },
        data: {
          label: "List Documents",
          action: "list",
          limit: 5,
        },
      },
      {
        id: saveDocs,
        type: "set-variables",
        position: { x: 2780, y: 160 },
        data: {
          label: "Save Document Summary",
          assignments: [{ key: "documentSummary", value: "{{document.response}}" }],
        },
      },
      {
        id: tasks,
        type: "board-task",
        position: { x: 3020, y: 160 },
        data: {
          label: "List Scoped Tasks",
          action: "list",
          boardId: "main-board",
          organizationId: "{{trigger.organizationId}}",
          goalId: "{{trigger.goalId}}",
          limit: 8,
        },
      },
      {
        id: saveTasks,
        type: "set-variables",
        position: { x: 3260, y: 160 },
        data: {
          label: "Save Board Summary",
          assignments: [{ key: "boardSummary", value: "{{board.response}}" }],
        },
      },
      {
        id: templates,
        type: "workflow-template",
        position: { x: 3500, y: 160 },
        data: {
          label: "List Templates",
          action: "list-templates",
        },
      },
      {
        id: saveTemplates,
        type: "set-variables",
        position: { x: 3740, y: 160 },
        data: {
          label: "Save Template Catalog",
          assignments: [{ key: "templateCatalog", value: "{{workflow.response}}" }],
        },
      },
      {
        id: council,
        type: "council",
        position: { x: 3980, y: 160 },
        data: {
          label: "Run Council",
          topic: "{{vars.briefTopic}}",
          decisionMode: "majority",
          optionsText: "Proceed\nInvestigate\nPause",
        },
      },
      {
        id: saveCouncil,
        type: "set-variables",
        position: { x: 4220, y: 160 },
        data: {
          label: "Save Council Verdict",
          assignments: [{ key: "councilSummary", value: "{{council.response}}" }],
        },
      },
      {
        id: db,
        type: "database-query",
        position: { x: 4460, y: 160 },
        data: {
          label: "Query App Counts",
          dbPath: "./data/disp8ch.db",
          query:
            "SELECT " +
            "(SELECT COUNT(*) FROM workflows) AS workflows, " +
            "(SELECT COUNT(*) FROM executions) AS executions, " +
            "(SELECT COUNT(*) FROM documents) AS documents, " +
            "(SELECT COUNT(*) FROM board_tasks) AS board_tasks, " +
            "(SELECT COUNT(*) FROM models) AS models;",
        },
      },
      {
        id: saveDb,
        type: "set-variables",
        position: { x: 4700, y: 160 },
        data: {
          label: "Save DB Snapshot",
          assignments: [{ key: "dbSummary", value: "{{database.rows}}" }],
        },
      },
      {
        id: report,
        type: "run-code",
        position: { x: 4940, y: 160 },
        data: {
          label: "Build Operations Report",
          timeout: 5000,
          code: [
            "const vars = input.vars || {};",
            "const topic = String(vars.briefTopic || 'Operations review');",
            "const dbRows = Array.isArray(input.rows) ? input.rows : [];",
            "const dbRow = dbRows[0] || {};",
            "const lines = [",
            "  '## Ops Control Tower',",
            "  '',",
            "  `Topic: ${topic}`,",
            "  `Generated: ${vars.generatedAt || 'n/a'}`,",
            "  `Suggested follow-up date: ${vars.followUpDate || 'n/a'}`,",
            "  `Organization ID: ${vars.scopeOrg || '(none)'}`,",
            "  `Goal ID: ${vars.scopeGoal || '(none)'}`,",
            "  '',",
            "  '### Channels',",
            "  String(vars.channelStatus || 'n/a'),",
            "  '',",
            "  '### Schedules',",
            "  String(vars.scheduleStatus || 'n/a'),",
            "  '',",
            "  '### Documents',",
            "  String(vars.documentSummary || 'n/a'),",
            "  '',",
            "  '### Board Scope',",
            "  String(vars.boardSummary || 'n/a'),",
            "  '',",
            "  '### Workflow Templates',",
            "  String(vars.templateCatalog || 'n/a'),",
            "  '',",
            "  '### Council',",
            "  String(vars.councilSummary || 'n/a'),",
            "  '',",
            "  '### Database Snapshot',",
            "  `- workflows: ${Number(dbRow.workflows || 0)}` ,",
            "  `- executions: ${Number(dbRow.executions || 0)}` ,",
            "  `- documents: ${Number(dbRow.documents || 0)}` ,",
            "  `- board tasks: ${Number(dbRow.board_tasks || 0)}` ,",
            "  `- models: ${Number(dbRow.models || 0)}` ,",
            "].join('\\n');",
            "result = {",
            "  response: lines,",
            "  report: lines,",
            "  title: `Ops Control Tower :: ${topic}`,",
            "};",
          ].join("\n"),
        },
      },
      {
        id: saveReport,
        type: "set-variables",
        position: { x: 5180, y: 160 },
        data: {
          label: "Stage Report Vars",
          assignments: [
            { key: "reportBody", value: "{{run.result.report}}" },
            { key: "reportResponse", value: "{{run.result.response}}" },
          ],
        },
      },
      {
        id: write,
        type: "write-file",
        position: { x: 5420, y: 160 },
        data: {
          label: "Persist Report",
          path: "./data/workspace/reports/ops-control-tower-{{vars.generatedTs}}.md",
          mode: "overwrite",
          content: "{{vars.reportBody}}",
        },
      },
      {
        id: memory,
        type: "memory-store",
        position: { x: 5660, y: 160 },
        data: {
          label: "Store Report in Memory",
          extractMode: "manual",
          type: "summary",
          manualContent: "{{vars.reportBody}}",
        },
      },
      {
        id: send,
        type: "send-webchat",
        position: { x: 5900, y: 160 },
        data: {
          label: "Send Report",
          message: "{{vars.reportResponse}}",
        },
      },
    ],
    edges: [
      { id: `e-${manual}-${seed}`, source: manual, target: seed },
      { id: `e-${message}-${seed}`, source: message, target: seed },
      { id: `e-${seed}-${now}`, source: seed, target: now },
      { id: `e-${now}-${saveNow}`, source: now, target: saveNow },
      { id: `e-${saveNow}-${due}`, source: saveNow, target: due },
      { id: `e-${due}-${saveDue}`, source: due, target: saveDue },
      { id: `e-${saveDue}-${channels}`, source: saveDue, target: channels },
      { id: `e-${channels}-${saveChannels}`, source: channels, target: saveChannels },
      { id: `e-${saveChannels}-${schedules}`, source: saveChannels, target: schedules },
      { id: `e-${schedules}-${saveSchedules}`, source: schedules, target: saveSchedules },
      { id: `e-${saveSchedules}-${docs}`, source: saveSchedules, target: docs },
      { id: `e-${docs}-${saveDocs}`, source: docs, target: saveDocs },
      { id: `e-${saveDocs}-${tasks}`, source: saveDocs, target: tasks },
      { id: `e-${tasks}-${saveTasks}`, source: tasks, target: saveTasks },
      { id: `e-${saveTasks}-${templates}`, source: saveTasks, target: templates },
      { id: `e-${templates}-${saveTemplates}`, source: templates, target: saveTemplates },
      { id: `e-${saveTemplates}-${council}`, source: saveTemplates, target: council },
      { id: `e-${council}-${saveCouncil}`, source: council, target: saveCouncil },
      { id: `e-${saveCouncil}-${db}`, source: saveCouncil, target: db },
      { id: `e-${db}-${saveDb}`, source: db, target: saveDb },
      { id: `e-${saveDb}-${report}`, source: saveDb, target: report },
      { id: `e-${report}-${saveReport}`, source: report, target: saveReport },
      { id: `e-${saveReport}-${write}`, source: saveReport, target: write },
      { id: `e-${write}-${memory}`, source: write, target: memory },
      { id: `e-${memory}-${send}`, source: memory, target: send },
    ],
  };
}

function getHierarchyBoardBriefingTemplate() {
  const manual = nanoid(8);
  const message = nanoid(8);
  const seed = nanoid(8);
  const now = nanoid(8);
  const saveNow = nanoid(8);
  const scopedTasks = nanoid(8);
  const saveScopedTasks = nanoid(8);
  const createTask = nanoid(8);
  const saveCreatedTask = nanoid(8);
  const channels = nanoid(8);
  const saveChannels = nanoid(8);
  const schedules = nanoid(8);
  const saveSchedules = nanoid(8);
  const templates = nanoid(8);
  const saveTemplates = nanoid(8);
  const council = nanoid(8);
  const saveCouncil = nanoid(8);
  const db = nanoid(8);
  const saveDb = nanoid(8);
  const report = nanoid(8);
  const saveReport = nanoid(8);
  const write = nanoid(8);
  const memory = nanoid(8);
  const send = nanoid(8);

  return {
    nodes: [
      { id: manual, type: "manual-trigger", position: { x: 100, y: 80 }, data: { label: "Manual Trigger" } },
      { id: message, type: "message-trigger", position: { x: 100, y: 220 }, data: { label: "Message Trigger", channel: "webchat" } },
      {
        id: seed,
        type: "set-variables",
        position: { x: 360, y: 160 },
        data: {
          label: "Seed Hierarchy Scope",
          assignments: [
            { key: "briefTopic", value: "{{trigger.input}}{{trigger.message}}" },
            { key: "scopeOrg", value: "{{trigger.organizationId}}" },
            { key: "scopeGoal", value: "{{trigger.goalId}}" },
            { key: "followUpTitle", value: "Follow up :: {{trigger.taskTitle}}" },
          ],
        },
      },
      {
        id: now,
        type: "date-time",
        position: { x: 620, y: 160 },
        data: {
          label: "Capture Timestamp",
          operation: "now",
          timezone: "UTC",
          locale: "en-US",
          outputStyle: "datetime",
        },
      },
      {
        id: saveNow,
        type: "set-variables",
        position: { x: 860, y: 160 },
        data: {
          label: "Save Timestamp",
          assignments: [
            { key: "generatedAt", value: "{{date.formatted}}" },
            { key: "generatedTs", value: "{{date.unixSeconds}}" },
          ],
        },
      },
      {
        id: scopedTasks,
        type: "board-task",
        position: { x: 1100, y: 160 },
        data: {
          label: "List Scoped Tasks",
          action: "list",
          boardId: "main-board",
          organizationId: "{{trigger.organizationId}}",
          goalId: "{{trigger.goalId}}",
          limit: 8,
        },
      },
      {
        id: saveScopedTasks,
        type: "set-variables",
        position: { x: 1340, y: 160 },
        data: {
          label: "Save Scoped Task List",
          assignments: [
            { key: "scopedTaskSummary", value: "{{board.response}}" },
            { key: "scopedTaskCount", value: "{{board.total}}" },
          ],
        },
      },
      {
        id: createTask,
        type: "board-task",
        position: { x: 1580, y: 160 },
        data: {
          label: "Create Follow-up Task",
          action: "create",
          boardId: "main-board",
          organizationId: "{{trigger.organizationId}}",
          goalId: "{{trigger.goalId}}",
          title: "{{vars.followUpTitle}}",
          description: "Auto-created by hierarchy briefing on {{vars.generatedAt}}.",
          status: "review",
          priority: "medium",
        },
      },
      {
        id: saveCreatedTask,
        type: "set-variables",
        position: { x: 1820, y: 160 },
        data: {
          label: "Save Created Task",
          assignments: [
            { key: "createdTaskSummary", value: "{{board.response}}" },
            { key: "createdTaskId", value: "{{board.task.id}}" },
            { key: "createdTaskTitle", value: "{{board.task.title}}" },
            { key: "createdTaskStatus", value: "{{board.task.status}}" },
          ],
        },
      },
      {
        id: channels,
        type: "channel-status",
        position: { x: 2060, y: 160 },
        data: {
          label: "Inspect Channels",
          format: "summary",
        },
      },
      {
        id: saveChannels,
        type: "set-variables",
        position: { x: 2300, y: 160 },
        data: {
          label: "Save Channel Status",
          assignments: [{ key: "channelStatus", value: "{{channel.response}}" }],
        },
      },
      {
        id: schedules,
        type: "scheduler-job",
        position: { x: 2540, y: 160 },
        data: {
          label: "List Schedules",
          action: "list",
        },
      },
      {
        id: saveSchedules,
        type: "set-variables",
        position: { x: 2780, y: 160 },
        data: {
          label: "Save Schedule Status",
          assignments: [{ key: "scheduleStatus", value: "{{scheduler.response}}" }],
        },
      },
      {
        id: templates,
        type: "workflow-template",
        position: { x: 3020, y: 160 },
        data: {
          label: "List Existing Workflows",
          action: "list-workflows",
        },
      },
      {
        id: saveTemplates,
        type: "set-variables",
        position: { x: 3260, y: 160 },
        data: {
          label: "Save Workflow List",
          assignments: [{ key: "workflowList", value: "{{workflow.response}}" }],
        },
      },
      {
        id: council,
        type: "council",
        position: { x: 3500, y: 160 },
        data: {
          label: "Hierarchy Council",
          topic: "Evaluate hierarchy scope {{trigger.organizationId}} / {{trigger.goalId}} for {{vars.briefTopic}}",
          decisionMode: "majority",
          optionsText: "Escalate\nContinue\nClose",
        },
      },
      {
        id: saveCouncil,
        type: "set-variables",
        position: { x: 3740, y: 160 },
        data: {
          label: "Save Council Verdict",
          assignments: [{ key: "councilSummary", value: "{{council.response}}" }],
        },
      },
      {
        id: db,
        type: "database-query",
        position: { x: 3980, y: 160 },
        data: {
          label: "Scoped Workflow Counts",
          dbPath: "./data/disp8ch.db",
          query:
            "SELECT " +
            "COUNT(*) AS scoped_workflows, " +
            "SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS active_scoped " +
            "FROM workflows " +
            "WHERE organization_id = '{{trigger.organizationId}}';",
        },
      },
      {
        id: saveDb,
        type: "set-variables",
        position: { x: 4220, y: 160 },
        data: {
          label: "Save Scoped Counts",
          assignments: [{ key: "scopedDbSummary", value: "{{database.rows}}" }],
        },
      },
      {
        id: report,
        type: "run-code",
        position: { x: 4460, y: 160 },
        data: {
          label: "Build Hierarchy Brief",
          timeout: 5000,
          code: [
            "const vars = input.vars || {};",
            "const scopedRows = Array.isArray(input.rows) ? input.rows : [];",
            "const scoped = scopedRows[0] || {};",
            "const taskId = String(vars.createdTaskId || '');",
            "const taskTitle = String(vars.createdTaskTitle || vars.followUpTitle || 'n/a');",
            "const taskStatus = String(vars.createdTaskStatus || 'n/a');",
            "const taskCount = vars.scopedTaskCount !== undefined ? String(vars.scopedTaskCount) : 'n/a';",
            "const lines = [",
            "  '## Hierarchy Board Briefing',",
            "  '',",
            "  `Topic: ${String(vars.briefTopic || 'n/a')}`,",
            "  `Generated: ${String(vars.generatedAt || 'n/a')}`,",
            "  `Organization ID: ${String(vars.scopeOrg || '(none)')}`,",
            "  `Goal ID: ${String(vars.scopeGoal || '(none)')}`,",
            "  '',",
            "  '### Scoped Tasks Before Follow-up',",
            "  `Tasks in scope: ${taskCount}`,",
            "  String(vars.scopedTaskSummary || 'n/a'),",
            "  '',",
            "  '### Follow-up Task Created',",
            "  taskId ? `- ID: ${taskId}` : '- ID: (not created)',",
            "  `- Title: ${taskTitle}`,",
            "  `- Status: ${taskStatus}`,",
            "  '',",
            "  '### Channel Status',",
            "  String(vars.channelStatus || 'n/a'),",
            "  '',",
            "  '### Schedules',",
            "  String(vars.scheduleStatus || 'n/a'),",
            "  '',",
            "  '### Workflow List',",
            "  String(vars.workflowList || 'n/a'),",
            "  '',",
            "  '### Council',",
            "  String(vars.councilSummary || 'n/a'),",
            "  '',",
            "  '### Scoped Workflow Counts',",
            "  `- workflows in organization: ${Number(scoped.scoped_workflows || 0)}` ,",
            "  `- active workflows in organization: ${Number(scoped.active_scoped || 0)}` ,",
            "].join('\\n');",
            "result = {",
            "  response: lines,",
            "  report: lines,",
            "  createdTaskId: taskId,",
            "  createdTaskTitle: taskTitle,",
            "  createdTaskStatus: taskStatus,",
            "};",
          ].join("\n"),
        },
      },
      {
        id: saveReport,
        type: "set-variables",
        position: { x: 4700, y: 160 },
        data: {
          label: "Stage Brief Vars",
          assignments: [
            { key: "reportBody", value: "{{run.result.report}}" },
            { key: "reportResponse", value: "{{run.result.response}}" },
          ],
        },
      },
      {
        id: write,
        type: "write-file",
        position: { x: 4940, y: 160 },
        data: {
          label: "Persist Hierarchy Brief",
          path: "./data/workspace/reports/hierarchy-board-briefing-{{vars.generatedTs}}.md",
          mode: "overwrite",
          content: "{{vars.reportBody}}",
        },
      },
      {
        id: memory,
        type: "memory-store",
        position: { x: 5180, y: 160 },
        data: {
          label: "Store Brief in Memory",
          extractMode: "manual",
          type: "summary",
          manualContent: "{{vars.reportBody}}",
        },
      },
      {
        id: send,
        type: "send-webchat",
        position: { x: 5420, y: 160 },
        data: {
          label: "Send Brief",
          message: "{{vars.reportResponse}}",
        },
      },
    ],
    edges: [
      { id: `e-${manual}-${seed}`, source: manual, target: seed },
      { id: `e-${message}-${seed}`, source: message, target: seed },
      { id: `e-${seed}-${now}`, source: seed, target: now },
      { id: `e-${now}-${saveNow}`, source: now, target: saveNow },
      { id: `e-${saveNow}-${scopedTasks}`, source: saveNow, target: scopedTasks },
      { id: `e-${scopedTasks}-${saveScopedTasks}`, source: scopedTasks, target: saveScopedTasks },
      { id: `e-${saveScopedTasks}-${createTask}`, source: saveScopedTasks, target: createTask },
      { id: `e-${createTask}-${saveCreatedTask}`, source: createTask, target: saveCreatedTask },
      { id: `e-${saveCreatedTask}-${channels}`, source: saveCreatedTask, target: channels },
      { id: `e-${channels}-${saveChannels}`, source: channels, target: saveChannels },
      { id: `e-${saveChannels}-${schedules}`, source: saveChannels, target: schedules },
      { id: `e-${schedules}-${saveSchedules}`, source: schedules, target: saveSchedules },
      { id: `e-${saveSchedules}-${templates}`, source: saveSchedules, target: templates },
      { id: `e-${templates}-${saveTemplates}`, source: templates, target: saveTemplates },
      { id: `e-${saveTemplates}-${council}`, source: saveTemplates, target: council },
      { id: `e-${council}-${saveCouncil}`, source: council, target: saveCouncil },
      { id: `e-${saveCouncil}-${db}`, source: saveCouncil, target: db },
      { id: `e-${db}-${saveDb}`, source: db, target: saveDb },
      { id: `e-${saveDb}-${report}`, source: saveDb, target: report },
      { id: `e-${report}-${saveReport}`, source: report, target: saveReport },
      { id: `e-${saveReport}-${write}`, source: saveReport, target: write },
      { id: `e-${write}-${memory}`, source: write, target: memory },
      { id: `e-${memory}-${send}`, source: memory, target: send },
    ],
  };
}

export async function GET(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    initializeDatabase();
    const db = getSqlite();

    const { searchParams } = new URL(request.url);
    const action = searchParams.get("action");

    // ── Export a single workflow as JSON ──────────────────────────────────────
    if (action === "export") {
      const id = searchParams.get("id");
      if (!id) return NextResponse.json({ success: false, error: "Missing id" }, { status: 400 });
      const row = db.prepare("SELECT * FROM workflows WHERE id = ?").get(id) as {
        id: string; name: string; description: string | null; nodes: string; edges: string;
        organization_id: string | null; goal_id: string | null; source_type: string | null;
        source_ref: string | null; is_active: number; created_at: string; updated_at: string;
      } | undefined;
      if (!row) return NextResponse.json({ success: false, error: "Workflow not found" }, { status: 404 });
      const { redactWorkflowExport } = await import("@/lib/workflows/secret-redaction");
      const exportData = redactWorkflowExport({
        _disp8chExport: true,
        version: "1",
        exportedAt: new Date().toISOString(),
        id: row.id,
        name: row.name,
        description: row.description,
        nodes: JSON.parse(row.nodes),
        edges: JSON.parse(row.edges),
        organizationId: row.organization_id,
        goalId: row.goal_id,
        sourceType: row.source_type,
        sourceRef: row.source_ref,
      });
      return new NextResponse(JSON.stringify(exportData, null, 2), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Content-Disposition": `attachment; filename="${row.name.replace(/[^a-z0-9]/gi, "_")}.disp8ch.json"`,
        },
      });
    }

    const rows = db.prepare("SELECT * FROM workflows ORDER BY updated_at DESC").all() as Array<{
      id: string; name: string; description: string | null; nodes: string; edges: string;
      organization_id: string | null; goal_id: string | null; source_type: string | null; source_ref: string | null;
      policy: string | null; is_active: number; created_at: string; updated_at: string;
    }>;
    const lastExecRows = db.prepare(
      "SELECT workflow_id, id, status, trigger_type, trigger_data, started_at, completed_at FROM executions ORDER BY started_at DESC LIMIT 500",
    ).all() as Array<{
      workflow_id: string;
      id: string;
      status: string;
      trigger_type: string;
      trigger_data: string | null;
      started_at: string;
      completed_at: string | null;
    }>;
    const lastExecMap = new Map<string, {
      id: string;
      status: string;
      triggerType: string;
      triggerData: Record<string, unknown> | null;
      startedAt: string;
      completedAt: string | null;
    }>();
    for (const row of lastExecRows) {
      if (lastExecMap.has(row.workflow_id)) continue;
      lastExecMap.set(row.workflow_id, {
        id: row.id,
        status: row.status,
        triggerType: row.trigger_type,
        triggerData: row.trigger_data ? JSON.parse(row.trigger_data) : null,
        startedAt: row.started_at,
        completedAt: row.completed_at,
      });
    }

    const workflows = rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      organizationId: r.organization_id ?? null,
      goalId: r.goal_id ?? null,
      sourceType: r.source_type ?? null,
      sourceRef: r.source_ref ?? null,
      policy: (() => {
        try {
          return r.policy ? JSON.parse(r.policy) : null;
        } catch {
          return null;
        }
      })(),
      nodes: JSON.parse(r.nodes),
      edges: JSON.parse(r.edges),
      isActive: r.is_active === 1,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      lastExecution: lastExecMap.get(r.id) ?? null,
    }));

    return NextResponse.json({ success: true, data: workflows });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

function getAutonomousResearchPipelineTemplate() {
  const manual = nanoid(8);
  const message = nanoid(8);
  const seed = nanoid(8);
  const now = nanoid(8);
  const saveNow = nanoid(8);
  const memCheck = nanoid(8);
  const saveContext = nanoid(8);
  const arxiv = nanoid(8);
  const semantic = nanoid(8);
  const normalize = nanoid(8);
  const saveLit = nanoid(8);
  const council = nanoid(8);
  const saveHyp = nanoid(8);
  const synthesis = nanoid(8);
  const codeGen = nanoid(8);
  const sandbox = nanoid(8);
  const errHandler = nanoid(8);
  const repair = nanoid(8);
  const analysis = nanoid(8);
  const draft = nanoid(8);
  const writeDraft = nanoid(8);
  const lessons = nanoid(8);
  const deliverable = nanoid(8);
  const notify = nanoid(8);

  return {
    nodes: [
      { id: manual, type: "manual-trigger", position: { x: 100, y: 100 }, data: { label: "Manual Trigger" } },
      { id: message, type: "message-trigger", position: { x: 100, y: 240 }, data: { label: "Message Trigger", channel: "webchat" } },
      {
        id: seed,
        type: "set-variables",
        position: { x: 380, y: 170 },
        data: {
          label: "Seed Research Topic",
          assignments: [
            { key: "researchTopic", value: "{{trigger.input}}{{trigger.message}}" },
            { key: "qualityThreshold", value: "0.7" },
            { key: "maxSources", value: "15" },
          ],
        },
      },
      {
        id: now,
        type: "date-time",
        position: { x: 640, y: 170 },
        data: { label: "Capture Timestamp", operation: "now", timezone: "UTC", locale: "en-US", outputStyle: "datetime" },
      },
      {
        id: saveNow,
        type: "set-variables",
        position: { x: 880, y: 170 },
        data: {
          label: "Save Timestamp",
          assignments: [
            { key: "startedAt", value: "{{date.formatted}}" },
            { key: "reportTs", value: "{{date.unixSeconds}}" },
          ],
        },
      },
      {
        id: memCheck,
        type: "memory-recall",
        position: { x: 1120, y: 170 },
        data: { label: "Check Prior Knowledge", query: "{{vars.researchTopic}}", limit: 8 },
      },
      {
        id: saveContext,
        type: "set-variables",
        position: { x: 1360, y: 170 },
        data: {
          label: "Save Prior Context",
          assignments: [{ key: "priorKnowledge", value: "{{memory.results}}" }],
        },
      },
      {
        id: arxiv,
        type: "http-request",
        position: { x: 1600, y: 80 },
        data: {
          label: "arXiv Search",
          url: "https://export.arxiv.org/api/query?search_query={{vars.researchTopic}}&max_results=10&sortBy=relevance",
          method: "GET",
        },
      },
      {
        id: semantic,
        type: "http-request",
        position: { x: 1600, y: 260 },
        data: {
          label: "Semantic Scholar Search",
          url: "https://api.semanticscholar.org/graph/v1/paper/search?query={{vars.researchTopic}}&limit=10&fields=title,abstract,authors,year,citationCount",
          method: "GET",
        },
      },
      {
        id: normalize,
        type: "json-transform",
        position: { x: 1860, y: 170 },
        data: {
          label: "Normalize & Deduplicate",
          expression: `(function(d) {
  const arxivBody = String(d.body || d.text || "");
  const semBody = typeof d.json === "object" && d.json ? JSON.stringify(d.json) : "";
  return { arxivRaw: arxivBody.slice(0, 4000), semanticRaw: semBody.slice(0, 4000), combined: true };
})(data)`,
        },
      },
      {
        id: saveLit,
        type: "memory-store",
        position: { x: 2100, y: 170 },
        data: {
          label: "Store Literature",
          extractMode: "auto",
          type: "fact",
        },
      },
      {
        id: council,
        type: "council",
        position: { x: 2340, y: 170 },
        data: {
          label: "Hypothesis Debate",
          topic: "Based on the research literature for '{{vars.researchTopic}}', what is the most promising hypothesis or research direction to pursue? Consider novelty, feasibility, and impact.",
          options: ["Extend existing methods", "Challenge current assumptions", "Apply to new domain", "Combine approaches", "Validate with empirical study"],
        },
      },
      {
        id: saveHyp,
        type: "set-variables",
        position: { x: 2580, y: 170 },
        data: {
          label: "Save Hypothesis",
          assignments: [
            { key: "hypothesis", value: "{{council.response}}" },
            { key: "chosenDirection", value: "{{council.winner}}" },
          ],
        },
      },
      {
        id: synthesis,
        type: "claude-agent",
        position: { x: 2820, y: 170 },
        data: {
          label: "Synthesis Agent",
          systemPrompt: `You are a research synthesis agent. Given:
- Research topic: {{vars.researchTopic}}
- Prior knowledge: {{vars.priorKnowledge}}
- Chosen hypothesis direction: {{vars.hypothesis}}

Your task:
1. Synthesize the literature into a coherent background (3–5 paragraphs)
2. Explain the knowledge gap this research addresses
3. Propose a concrete experiment or study design to test the hypothesis
4. List 3–5 specific metrics to evaluate success

Output a structured Experiment Design document.`,
          temperature: 0.6,
          maxTokens: 2048,
          enabledTools: ["web_search", "memory_search", "memory_store"],
        },
      },
      {
        id: codeGen,
        type: "claude-agent",
        position: { x: 3060, y: 170 },
        data: {
          label: "Experiment Code Generator",
          systemPrompt: `You are an experiment code generator. Based on the experiment design from the synthesis agent, generate a self-contained Python or JavaScript script that:
1. Implements the proposed experiment or data collection
2. Includes error handling and progress logging
3. Outputs results as JSON to stdout
4. Is runnable in a sandbox environment

Keep the script under 100 lines. Add a brief plan comment at the top.`,
          temperature: 0.3,
          maxTokens: 1500,
          enabledTools: ["write_file"],
        },
      },
      {
        id: sandbox,
        type: "run-code",
        position: { x: 3300, y: 170 },
        data: {
          label: "Sandbox Execution",
          timeout: 15000,
          code: `// Execute lightweight validation — parse the agent's code output
const agentOutput = String(input.response || input.text || "");
const codeMatch = agentOutput.match(/\`\`\`(?:python|js|javascript|typescript)?\\n([\\s\\S]+?)\`\`\`/);
const extractedCode = codeMatch ? codeMatch[1].trim() : "";
output = JSON.stringify({
  hasCode: Boolean(extractedCode),
  codeLength: extractedCode.length,
  preview: extractedCode.slice(0, 200),
  status: extractedCode.length > 10 ? "ready" : "no_code_found",
});`,
        },
      },
      {
        id: errHandler,
        type: "error-handler",
        position: { x: 3540, y: 170 },
        data: { label: "Execution Gate" },
      },
      {
        id: repair,
        type: "claude-agent",
        position: { x: 3780, y: 340 },
        data: {
          label: "Error Repair Agent",
          systemPrompt: "An experiment step failed. Review the error and the prior code/design, then produce a corrected version. Output only the corrected code block.",
          temperature: 0.3,
          maxTokens: 1000,
        },
      },
      {
        id: analysis,
        type: "parallel-agents",
        position: { x: 3780, y: 100 },
        data: {
          label: "Result Analysis (Parallel)",
          systemPrompt: "Analyze the research results from different perspectives: (1) What worked and why, (2) What gaps remain, (3) Practical implications. Be concise and cite specific findings.",
          workerCount: 3,
          temperature: 0.7,
          maxTokens: 800,
        },
      },
      {
        id: draft,
        type: "claude-agent",
        position: { x: 4060, y: 170 },
        data: {
          label: "Paper Draft Agent",
          systemPrompt: `You are a scientific writing agent. Produce a complete research paper draft for the topic: {{vars.researchTopic}}

Structure:
## Abstract (150 words)
## 1. Introduction
## 2. Background & Related Work
## 3. Methodology
## 4. Results & Analysis
## 5. Discussion
## 6. Conclusion
## References

Use the synthesis, experiment design, and analysis results as inputs. Write in clear academic prose. Cite sources inline as [Author, Year]. Target 1500–2500 words total.`,
          temperature: 0.65,
          maxTokens: 3000,
          enabledTools: ["memory_search", "memory_store"],
        },
      },
      {
        id: writeDraft,
        type: "write-file",
        position: { x: 4300, y: 170 },
        data: {
          label: "Save Paper Draft",
          path: "./data/workspace/reports/research-{{vars.reportTs}}.md",
          contentTemplate: "# Research: {{vars.researchTopic}}\n\nStarted: {{vars.startedAt}}\n\n{{agent.response}}",
        },
      },
      {
        id: lessons,
        type: "memory-store",
        position: { x: 4540, y: 170 },
        data: {
          label: "Archive Lessons Learned",
          extractMode: "auto",
          type: "fact",
        },
      },
      {
        id: deliverable,
        type: "board-task",
        position: { x: 4780, y: 170 },
        data: {
          label: "Create Deliverable Task",
          titleTemplate: "Research complete: {{vars.researchTopic}}",
          descriptionTemplate: "Paper draft saved at data/workspace/reports/research-{{vars.reportTs}}.md\n\nHypothesis: {{vars.hypothesis}}",
          status: "review",
          priority: "medium",
        },
      },
      {
        id: notify,
        type: "send-webchat",
        position: { x: 5020, y: 170 },
        data: {
          label: "Notify Completion",
          messageTemplate: "Research pipeline complete for '{{vars.researchTopic}}'. Paper draft saved at data/workspace/reports/research-{{vars.reportTs}}.md. Task created in /boards for review.",
        },
      },
    ],
    edges: [
      { id: `e-${manual}-${seed}`, source: manual, target: seed },
      { id: `e-${message}-${seed}`, source: message, target: seed },
      { id: `e-${seed}-${now}`, source: seed, target: now },
      { id: `e-${now}-${saveNow}`, source: now, target: saveNow },
      { id: `e-${saveNow}-${memCheck}`, source: saveNow, target: memCheck },
      { id: `e-${memCheck}-${saveContext}`, source: memCheck, target: saveContext },
      { id: `e-${saveContext}-${arxiv}`, source: saveContext, target: arxiv },
      { id: `e-${saveContext}-${semantic}`, source: saveContext, target: semantic },
      { id: `e-${arxiv}-${normalize}`, source: arxiv, target: normalize },
      { id: `e-${semantic}-${normalize}`, source: semantic, target: normalize },
      { id: `e-${normalize}-${saveLit}`, source: normalize, target: saveLit },
      { id: `e-${saveLit}-${council}`, source: saveLit, target: council },
      { id: `e-${council}-${saveHyp}`, source: council, target: saveHyp },
      { id: `e-${saveHyp}-${synthesis}`, source: saveHyp, target: synthesis },
      { id: `e-${synthesis}-${codeGen}`, source: synthesis, target: codeGen },
      { id: `e-${codeGen}-${sandbox}`, source: codeGen, target: sandbox },
      { id: `e-${sandbox}-${errHandler}`, source: sandbox, target: errHandler },
      { id: `e-${errHandler}-${analysis}`, source: errHandler, target: analysis, sourceHandle: "success" },
      { id: `e-${errHandler}-${repair}`, source: errHandler, target: repair, sourceHandle: "error" },
      { id: `e-${repair}-${analysis}`, source: repair, target: analysis },
      { id: `e-${analysis}-${draft}`, source: analysis, target: draft },
      { id: `e-${draft}-${writeDraft}`, source: draft, target: writeDraft },
      { id: `e-${writeDraft}-${lessons}`, source: writeDraft, target: lessons },
      { id: `e-${lessons}-${deliverable}`, source: lessons, target: deliverable },
      { id: `e-${deliverable}-${notify}`, source: deliverable, target: notify },
    ],
  };
}

function getExperimentLoopTemplate() {
  const manual   = nanoid(8);
  const seed     = nanoid(8);
  const initExp  = nanoid(8);
  const propose  = nanoid(8);
  const implement = nanoid(8);
  const runExp   = nanoid(8);
  const errGate  = nanoid(8);
  const analyze  = nanoid(8);
  const logKeep  = nanoid(8);
  const logDiscard = nanoid(8);
  const repair   = nanoid(8);
  const loop     = nanoid(8);
  const summary  = nanoid(8);
  const notify   = nanoid(8);

  const base = { position: { x: 0, y: 0 } };
  return {
    nodes: [
      { id: manual,    type: "manual-trigger",  data: { label: "Start Experiment Loop" }, ...base },
      { id: seed,      type: "set-variables",   data: { label: "Seed Config", assignments: [
        { key: "metricName",       value: "test_duration_ms" },
        { key: "metricUnit",       value: "ms" },
        { key: "metricDirection",  value: "minimize" },
        { key: "objective",        value: "{{trigger.input}}" },
        { key: "benchmarkCommand", value: "npm test 2>&1 | grep -E 'Tests:|Time:' | tail -1 | sed 's/.*Time:/METRIC test_duration_ms=/'" },
        { key: "checksCommand",    value: "npm run lint" },
        { key: "maxIterations",    value: "10" },
        { key: "workingDir",       value: "." },
      ] }, ...base },
      { id: initExp,   type: "claude-agent",    data: { label: "Init Experiment Session", systemPrompt: "Initialize an experiment session using the init_experiment tool with the provided metric configuration. Then read autoresearch.ideas.md if it exists to load any queued ideas.\n\nConfig:\n- metric_name: {{vars.metricName}}\n- metric_unit: {{vars.metricUnit}}\n- metric_direction: {{vars.metricDirection}}\n- objective: {{vars.objective}}\n- benchmark_command: {{vars.benchmarkCommand}}\n- checks_command: {{vars.checksCommand}}\n- working_dir: {{vars.workingDir}}" }, ...base },
      { id: loop,      type: "loop",            data: { label: "Experiment Loop", maxIterations: "{{vars.maxIterations}}", stopCondition: "" }, ...base },
      { id: propose,   type: "claude-agent",    data: { label: "Propose Experiment", systemPrompt: "You are an autonomous optimization researcher. Your goal: {{vars.objective}}\n\nRead autoresearch.md and autoresearch.ideas.md to understand current state and queued ideas.\nPropose ONE specific code change that could improve the metric {{vars.metricName}} ({{vars.metricDirection}}).\nOutput only the description of what you will try and why.\nBe specific: name the file, function, and change.\nPrioritize ideas from autoresearch.ideas.md if any exist." }, ...base },
      { id: implement, type: "claude-agent",    data: { label: "Implement Change", systemPrompt: "Implement the proposed change described below using write_file or bash_exec.\nOnly change what is described. Make minimal, reversible edits.\nAfter implementing, confirm the change was made.\n\nProposed change: {{agent.response}}" }, ...base },
      { id: runExp,    type: "claude-agent",    data: { label: "Run Benchmark", systemPrompt: "Run the experiment using the run_experiment tool.\ndescription: {{agent.response}}\nworking_dir: {{vars.workingDir}}\n\nReport the exact metric value returned." }, ...base },
      { id: errGate,   type: "error-handler",   data: { label: "Benchmark Gate" }, ...base },
      { id: analyze,   type: "claude-agent",    data: { label: "Keep or Discard?", systemPrompt: "Analyze the benchmark result from run_experiment.\n\nMetric: {{vars.metricName}} ({{vars.metricDirection}})\nObjective: {{vars.objective}}\n\nDecide: keep (improved metric AND checks passed), discard (regressed or flat), checks_failed (metric improved but checks failed), crash (benchmark crashed).\nCall log_experiment with the correct decision and exact metric_value from the benchmark output.\nAfter logging, append 1-2 deferred ideas to autoresearch.ideas.md.\nReport decision and metric_value." }, ...base },
      { id: logKeep,   type: "set-variables",   data: { label: "Record Decision", assignments: [{ key: "lastDecision", value: "{{agent.response}}" }] }, ...base },
      { id: repair,    type: "claude-agent",    data: { label: "Repair Crashed Run", systemPrompt: "The benchmark crashed. Read the error output, fix the code issue with write_file, then call log_experiment with decision='crash' and metric_value=0.\nAfter fixing, note the root cause in autoresearch.ideas.md." }, ...base },
      { id: summary,   type: "claude-agent",    data: { label: "Summarize Results", systemPrompt: "Read autoresearch.jsonl and autoresearch.md to compile the final experiment report.\nReport:\n- Total runs\n- Kept vs discarded\n- Baseline metric vs final best\n- % improvement\n- Top 3 winning changes (from kept commits)\n- Remaining promising ideas from autoresearch.ideas.md" }, ...base },
      { id: notify,    type: "send-webchat",    data: { label: "Notify Complete", message: "Experiment loop complete.\n{{agent.response}}" }, ...base },
    ],
    edges: [
      { id: `e-${manual}-${seed}`,        source: manual,    target: seed },
      { id: `e-${seed}-${initExp}`,       source: seed,      target: initExp },
      { id: `e-${initExp}-${loop}`,       source: initExp,   target: loop },
      { id: `e-${loop}-${propose}`,       source: loop,      target: propose,   sourceHandle: "loop" },
      { id: `e-${propose}-${implement}`,  source: propose,   target: implement },
      { id: `e-${implement}-${runExp}`,   source: implement, target: runExp },
      { id: `e-${runExp}-${errGate}`,     source: runExp,    target: errGate },
      { id: `e-${errGate}-${analyze}`,    source: errGate,   target: analyze,   sourceHandle: "success" },
      { id: `e-${errGate}-${repair}`,     source: errGate,   target: repair,    sourceHandle: "error" },
      { id: `e-${analyze}-${logKeep}`,    source: analyze,   target: logKeep },
      { id: `e-${repair}-${logKeep}`,     source: repair,    target: logKeep },
      { id: `e-${logKeep}-${loop}`,       source: logKeep,   target: loop,      sourceHandle: "next" },
      { id: `e-${loop}-${summary}`,       source: loop,      target: summary,   sourceHandle: "done" },
      { id: `e-${summary}-${notify}`,     source: summary,   target: notify },
    ],
  };
}

// ── Disp8chTeam: AI Crew Orchestrator ───────────────────────────────────────────
function getAiCrewOrchestratorTemplate() {
  const manual      = nanoid(8);
  const trigger     = nanoid(8);
  const setVars     = nanoid(8);
  const orchestrator = nanoid(8);
  const notify      = nanoid(8);

  const base = { position: { x: 0, y: 0 } };
  return {
    nodes: [
      {
        id: manual, type: "manual-trigger",
        data: { label: "Start Crew Mission" }, ...base,
      },
      {
        id: trigger, type: "message-trigger",
        data: { label: "Message Trigger", channel: "webchat" }, ...base,
      },
      {
        id: setVars, type: "set-variables",
        data: { label: "Define Crew Roles", assignments: [
          { key: "missionObjective", value: "{{trigger.input}}" },
          { key: "roles",            value: "CFO:Write an investment analysis memo | CTO:Rate competitive threats 1-10 | Strategy:Analyze market positioning | Product:Compare feature gaps | CEO:Synthesize executive briefing" },
          { key: "workerTimeout",    value: "120" },
          { key: "outputDir",        value: "./crew-output" },
        ]}, ...base,
      },
      {
        id: orchestrator, type: "claude-agent",
        data: { label: "Orchestrator (Crew Manager)",
          systemPrompt: [
            "You are a CEO-level orchestrator managing a specialized AI crew (Disp8chTeam-style multi-agent pattern).",
            "",
            "Mission objective: {{vars.missionObjective}}",
            "Crew roles: {{vars.roles}}",
            "Output directory: {{vars.outputDir}}",
            "",
            "STEP 1 — Spawn workers in parallel using sessions_spawn (agent=claude, mode=run, worktree=true for isolation).",
            "Assign each role a specific task. Workers should write their output to {{vars.outputDir}}/<role>.md.",
            "Use agent_inbox to broadcast the mission objective to all workers before spawning.",
            "",
            "STEP 2 — After all workers complete, read each output file using read_file.",
            "Use agent_inbox to collect any additional messages workers sent to your inbox.",
            "",
            "STEP 3 — Synthesize a concise executive briefing from all worker outputs.",
            "Save the synthesis to {{vars.outputDir}}/executive-brief.md using write_file.",
            "",
            "Enabled tools: sessions_spawn, agent_inbox, read_file, write_file, bash_exec",
            "Keep each worker task short and focused. Use worktree=true to prevent file conflicts.",
          ].join("\n"),
          enabledTools: ["sessions_spawn", "agent_inbox", "read_file", "write_file", "bash_exec"],
          maxToolCalls: 30,
        }, ...base,
      },
      {
        id: notify, type: "send-webchat",
        data: { label: "Send Brief", message: "{{agent.response}}" }, ...base,
      },
    ],
    edges: [
      { id: `e-${manual}-${setVars}`,       source: manual,       target: setVars },
      { id: `e-${trigger}-${setVars}`,      source: trigger,      target: setVars },
      { id: `e-${setVars}-${orchestrator}`, source: setVars,      target: orchestrator },
      { id: `e-${orchestrator}-${notify}`,  source: orchestrator, target: notify },
    ],
  };
}

// ── Disp8chTeam: Parallel Spawn Crew ─────────────────────────────────────────────
function getParallelSpawnCrewTemplate() {
  const manual      = nanoid(8);
  const setVars     = nanoid(8);
  const parallel    = nanoid(8);
  const aggregate   = nanoid(8);
  const synthesizer = nanoid(8);
  const storeMemory = nanoid(8);
  const notify      = nanoid(8);

  const base = { position: { x: 0, y: 0 } };
  return {
    nodes: [
      {
        id: manual, type: "manual-trigger",
        data: { label: "Start Parallel Crew" }, ...base,
      },
      {
        id: setVars, type: "set-variables",
        data: { label: "Configure Crew Tasks", assignments: [
          { key: "topic",       value: "{{trigger.input}}" },
          { key: "worker1Task", value: "Research background and context for: {{trigger.input}}" },
          { key: "worker2Task", value: "Identify key challenges and risks for: {{trigger.input}}" },
          { key: "worker3Task", value: "Propose 3 actionable recommendations for: {{trigger.input}}" },
        ]}, ...base,
      },
      {
        id: parallel, type: "parallel-agents",
        data: { label: "Parallel Workers (Disp8chTeam Fan-Out)",
          workers: [
            { roleKey: "research",  label: "Research Analyst",      taskTemplate: "{{vars.worker1Task}}", systemPrompt: "You are a Research Analyst. Write a concise research brief (3-5 paragraphs). Be factual.", maxTokens: 600, temperature: 0.4 },
            { roleKey: "risk",      label: "Risk Analyst",          taskTemplate: "{{vars.worker2Task}}", systemPrompt: "You are a Risk Analyst. List top 5 risks with severity ratings (High/Medium/Low). Be specific.", maxTokens: 600, temperature: 0.4 },
            { roleKey: "strategy",  label: "Strategy Consultant",   taskTemplate: "{{vars.worker3Task}}", systemPrompt: "You are a Strategy Consultant. Provide exactly 3 actionable recommendations with rationale. Be concrete.", maxTokens: 600, temperature: 0.4 },
          ],
          mode: "parallel",
        }, ...base,
      },
      {
        id: aggregate, type: "aggregate",
        data: { label: "Collect Worker Outputs", field: "agentResponse" }, ...base,
      },
      {
        id: synthesizer, type: "claude-agent",
        data: { label: "CEO Synthesis Agent",
          systemPrompt: "You are a CEO synthesizing reports from 3 specialist analysts. Topic: {{vars.topic}}\n\nWorker outputs: {{agent.response}}\n\nWrite an executive briefing (300-500 words) that:\n1. Summarizes key findings from Research, Risk, and Strategy\n2. Highlights 2-3 critical decisions needed\n3. Recommends immediate next actions\n\nFormat with clear headings. Be decisive and action-oriented.",
          maxTokens: 1024,
          temperature: 0.4,
        }, ...base,
      },
      {
        id: storeMemory, type: "memory-store",
        data: { label: "Store to Memory", extractMode: "auto", type: "insight" }, ...base,
      },
      {
        id: notify, type: "send-webchat",
        data: { label: "Send Executive Brief", message: "{{agent.response}}" }, ...base,
      },
    ],
    edges: [
      { id: `e-${manual}-${setVars}`,       source: manual,     target: setVars },
      { id: `e-${setVars}-${parallel}`,     source: setVars,    target: parallel },
      { id: `e-${parallel}-${aggregate}`,   source: parallel,   target: aggregate },
      { id: `e-${aggregate}-${synthesizer}`,source: aggregate,  target: synthesizer },
      { id: `e-${synthesizer}-${storeMemory}`, source: synthesizer, target: storeMemory },
      { id: `e-${storeMemory}-${notify}`,   source: storeMemory, target: notify },
    ],
  };
}

// ── Disp8chTeam: Plan-Gated Crew ────────────────────────────────────────────────
function getPlanGatedCrewTemplate() {
  const manual = nanoid(8);
  const trigger = nanoid(8);
  const setVars = nanoid(8);
  const planner = nanoid(8);
  const notify = nanoid(8);

  const base = { position: { x: 0, y: 0 } };
  return {
    nodes: [
      {
        id: manual,
        type: "manual-trigger",
        data: { label: "Start Plan-Gated Crew" },
        ...base,
      },
      {
        id: trigger,
        type: "message-trigger",
        data: { label: "Message Trigger", channel: "webchat" },
        ...base,
      },
      {
        id: setVars,
        type: "set-variables",
        data: {
          label: "Seed Crew Mission",
          assignments: [
            { key: "missionObjective", value: "{{trigger.input}}" },
            { key: "boardId", value: "main-board" },
            { key: "planTitle", value: "Crew Plan :: {{trigger.input}}" },
            { key: "specialists", value: "research,risk,delivery" },
          ],
        },
        ...base,
      },
      {
        id: planner,
        type: "claude-agent",
        data: {
          label: "Crew Lead (Plan Gate)",
          systemPrompt: [
            "You are a crew lead running a plan-gated execution protocol.",
            "",
            "Mission objective: {{vars.missionObjective}}",
            "Board: {{vars.boardId}}",
            "Plan task title: {{vars.planTitle}}",
            "Specialist lanes: {{vars.specialists}}",
            "",
            "Use tools in this order:",
            "1. board_tasks list/create/get/update to find or create the plan task.",
            "2. governance_queue task-approval-gate for the plan task.",
            "3. If the task is not approved yet:",
            "   - Draft a concise execution plan with scope, owners, blockers, and exit criteria.",
            "   - Save that plan into the board task description with board_tasks update.",
            "   - Create a pending task approval with governance_queue create-task-approval.",
            "   - Add a reviewer comment summarizing what needs approval.",
            "   - Enqueue a wakeup for the orchestrator or assignee so the crew knows approval is pending.",
            "   - Stop there and clearly report that execution is waiting for approval.",
            "4. If the task is already approved:",
            "   - Create 2-3 specialist board tasks with clear titles and descriptions.",
            "   - Use blocked_by so synthesis or rollout work waits on specialist outputs when appropriate.",
            "   - Broadcast the mission summary with agent_inbox so the crew has a shared brief.",
            "   - Enqueue wakeups for any assigned agents that should start work.",
            "   - Report the created tasks and next actions.",
            "",
            "Do not resolve approvals yourself unless the user explicitly asked you to do that.",
            "Enabled tools: board_tasks, governance_queue, agent_inbox",
          ].join("\n"),
          enabledTools: ["board_tasks", "governance_queue", "agent_inbox"],
          maxToolCalls: 25,
        },
        ...base,
      },
      {
        id: notify,
        type: "send-webchat",
        data: { label: "Send Crew Status", message: "{{agent.response}}" },
        ...base,
      },
    ],
    edges: [
      { id: `e-${manual}-${setVars}`, source: manual, target: setVars },
      { id: `e-${trigger}-${setVars}`, source: trigger, target: setVars },
      { id: `e-${setVars}-${planner}`, source: setVars, target: planner },
      { id: `e-${planner}-${notify}`, source: planner, target: notify },
    ],
  };
}

function getStrategyHardeningLoopTemplate() {
  const manual = nanoid(8);
  const message = nanoid(8);
  const seed = nanoid(8);
  const memory = nanoid(8);
  const research = nanoid(8);
  const plan = nanoid(8);
  const critique = nanoid(8);
  const revise = nanoid(8);
  const store = nanoid(8);
  const notify = nanoid(8);

  return {
    nodes: [
      { id: manual, type: "manual-trigger", position: { x: 100, y: 110 }, data: { label: "Start Strategy Review" } },
      { id: message, type: "message-trigger", position: { x: 100, y: 250 }, data: { label: "Strategy Request", channel: "webchat" } },
      {
        id: seed,
        type: "set-variables",
        position: { x: 360, y: 180 },
        data: {
          label: "Set Strategy Objective",
          assignments: [
            { key: "objective", value: "{{trigger.input}}{{trigger.message}}" },
            { key: "reviewStandard", value: "evidence, explicit assumptions, risks, measurable success criteria" },
          ],
        },
      },
      {
        id: memory,
        type: "memory-recall",
        position: { x: 620, y: 180 },
        data: { label: "Prior Context", query: "{{vars.objective}}", limit: 8 },
      },
      {
        id: research,
        type: "claude-agent",
        position: { x: 880, y: 180 },
        data: {
          label: "Research Evidence",
          systemPrompt: [
            "You are the evidence researcher in a strategy review loop.",
            "Objective: {{vars.objective}}",
            "Prior context: {{nodes.prior_context.response}}",
            "",
            "Gather only decision-relevant evidence. Separate verified facts, reasonable inferences, and unknowns. Identify constraints, examples, and sources to validate. Do not propose implementation steps yet.",
          ].join("\n"),
          temperature: 0.25,
          maxTokens: 1100,
          enabledTools: ["web_search", "memory_search"],
          model: "",
        },
      },
      {
        id: plan,
        type: "claude-agent",
        position: { x: 1140, y: 180 },
        data: {
          label: "Draft Strategy",
          systemPrompt: [
            "You are the strategy planner in a review loop.",
            "Objective: {{vars.objective}}",
            "Evidence: {{nodes.research_evidence.response}}",
            "",
            "Write a concrete plan with: intended outcome, scope and non-goals, ordered phases, owners or capabilities required, explicit assumptions, risks, success metrics, and validation steps. Keep it implementable but do not execute it.",
          ].join("\n"),
          temperature: 0.35,
          maxTokens: 1300,
          model: "",
        },
      },
      {
        id: critique,
        type: "claude-agent",
        position: { x: 1400, y: 180 },
        data: {
          label: "Adversarial Review",
          systemPrompt: [
            "You are an independent adversarial reviewer. Your job is to make a plan more reliable, not to agree with it.",
            "Objective: {{vars.objective}}",
            "Draft plan: {{nodes.draft_strategy.response}}",
            "",
            "Find unsupported assumptions, missing evidence, failure modes, unsafe sequencing, hidden dependencies, and weak success measures. For each issue, give a specific correction or validation test. Do not execute changes.",
          ].join("\n"),
          temperature: 0.2,
          maxTokens: 1200,
          model: "",
        },
      },
      {
        id: revise,
        type: "claude-agent",
        position: { x: 1660, y: 180 },
        data: {
          label: "Revised Strategy",
          systemPrompt: [
            "You are the final strategy editor. Produce a decision-ready strategy that incorporates valid review findings.",
            "Objective: {{vars.objective}}",
            "Draft plan: {{nodes.draft_strategy.response}}",
            "Review: {{nodes.adversarial_review.response}}",
            "",
            "Return exactly these sections: Recommendation, Evidence, Assumptions, Phased Plan, Risks and Mitigations, Success Metrics, Validation Checklist, and Approval Decision.",
            "Keep the complete response under 900 words: Recommendation at most 90 words; Evidence at most 4 bullets; Assumptions at most 5 bullets; Phased Plan at most 4 concise phases; Risks at most 4 items; Success Metrics at most 4 items; Validation Checklist at most 4 items; Approval Decision one explicit sentence.",
            "Mark unresolved questions explicitly. Never claim this workflow has made changes or received approval.",
          ].join("\n"),
          temperature: 0.25,
          maxTokens: 1600,
          model: "",
        },
      },
      {
        id: store,
        type: "memory-store",
        position: { x: 1920, y: 180 },
        data: { label: "Store Approved-For-Review Strategy", extractMode: "manual", type: "insight", manualContent: "{{nodes.revised_strategy.response}}" },
      },
      {
        id: notify,
        type: "send-webchat",
        position: { x: 2180, y: 180 },
        data: { label: "Send Review Package", message: "{{nodes.revised_strategy.response}}" },
      },
    ],
    edges: [
      { id: `e-${manual}-${seed}`, source: manual, target: seed },
      { id: `e-${message}-${seed}`, source: message, target: seed },
      { id: `e-${seed}-${memory}`, source: seed, target: memory },
      { id: `e-${memory}-${research}`, source: memory, target: research },
      { id: `e-${research}-${plan}`, source: research, target: plan },
      { id: `e-${plan}-${critique}`, source: plan, target: critique },
      { id: `e-${critique}-${revise}`, source: critique, target: revise },
      { id: `e-${revise}-${store}`, source: revise, target: store },
      { id: `e-${store}-${notify}`, source: store, target: notify },
    ],
  };
}

function getSupportSignalTriageTemplate() {
  const manual = nanoid(8);
  const webchat = nanoid(8);
  const telegram = nanoid(8);
  const discord = nanoid(8);
  const seed = nanoid(8);
  const memory = nanoid(8);
  const documents = nanoid(8);
  const triage = nanoid(8);
  const draft = nanoid(8);
  const notify = nanoid(8);

  return {
    nodes: [
      { id: manual, type: "manual-trigger", position: { x: 100, y: 80 }, data: { label: "Test Support Signal" } },
      { id: webchat, type: "message-trigger", position: { x: 100, y: 180 }, data: { label: "WebChat Support Signal", channel: "webchat" } },
      { id: telegram, type: "telegram-trigger", position: { x: 100, y: 280 }, data: { label: "Telegram Support Signal" } },
      { id: discord, type: "discord-trigger", position: { x: 100, y: 380 }, data: { label: "Discord Support Signal" } },
      {
        id: seed,
        type: "set-variables",
        position: { x: 360, y: 220 },
        data: {
          label: "Capture Support Signal",
          assignments: [
            { key: "incomingSignal", value: "{{trigger.input}}{{trigger.message}}" },
            { key: "sourceChannel", value: "{{trigger.channel}}" },
          ],
        },
      },
      {
        id: memory,
        type: "memory-recall",
        position: { x: 620, y: 220 },
        data: { label: "Find Related Memory", query: "{{vars.incomingSignal}}", limit: 6 },
      },
      {
        id: documents,
        type: "document-tool",
        position: { x: 880, y: 220 },
        data: { label: "Find Related Docs", action: "search", query: "{{vars.incomingSignal}}", limit: 5 },
      },
      {
        id: triage,
        type: "claude-agent",
        position: { x: 1140, y: 220 },
        data: {
          label: "Triage Support Signal",
          systemPrompt: [
            "You triage inbound support and community signals for a human operator.",
            "Message: {{vars.incomingSignal}}",
            "Source channel: {{vars.sourceChannel}}",
            "Relevant memory: {{nodes.find_related_memory.response}}",
            "Relevant documents: {{nodes.find_related_docs.response}}",
            "",
            "Return: urgency (low, medium, high, urgent), likely user need, verified context, unknowns, recommended owner, whether approval or escalation is needed, and the facts a reply must not overstate. Do not send messages, make account changes, or claim an issue is fixed.",
          ].join("\n"),
          temperature: 0.2,
          maxTokens: 1050,
          enabledTools: ["memory_search", "documents_search"],
          model: "",
        },
      },
      {
        id: draft,
        type: "claude-agent",
        position: { x: 1400, y: 220 },
        data: {
          label: "Draft Human Review Reply",
          systemPrompt: [
            "Write a concise response draft for a human operator to review before sending.",
            "Original message: {{vars.incomingSignal}}",
            "Triage: {{nodes.triage_support_signal.response}}",
            "",
            "Start with 'Draft - human review required'. Be empathetic, state only verified facts, ask one focused follow-up when needed, and clearly flag any promised action for approval.",
            "Do not say that a ticket was created, a request was flagged, a team will follow up, a refund will happen, or any other external action has occurred. This workflow only prepares text for a human to review and send.",
          ].join("\n"),
          temperature: 0.35,
          maxTokens: 900,
          model: "",
        },
      },
      {
        id: notify,
        type: "send-webchat",
        position: { x: 1660, y: 220 },
        data: { label: "Present Draft For Approval", message: "{{nodes.draft_human_review_reply.response}}" },
      },
    ],
    edges: [
      { id: `e-${manual}-${seed}`, source: manual, target: seed },
      { id: `e-${webchat}-${seed}`, source: webchat, target: seed },
      { id: `e-${telegram}-${seed}`, source: telegram, target: seed },
      { id: `e-${discord}-${seed}`, source: discord, target: seed },
      { id: `e-${seed}-${memory}`, source: seed, target: memory },
      { id: `e-${memory}-${documents}`, source: memory, target: documents },
      { id: `e-${documents}-${triage}`, source: documents, target: triage },
      { id: `e-${triage}-${draft}`, source: triage, target: draft },
      { id: `e-${draft}-${notify}`, source: draft, target: notify },
    ],
  };
}

// ── Local Lead Enrichment ────────────────────────────────────────────────────
function getLocalLeadEnrichmentTemplate() {
  const manual = nanoid(8);
  const message = nanoid(8);
  const seed = nanoid(8);
  const agent = nanoid(8);
  const timestamp = nanoid(8);
  const saveVars = nanoid(8);
  const writeReport = nanoid(8);
  const extractJson = nanoid(8);
  const writeCsv = nanoid(8);
  const task = nanoid(8);
  const store = nanoid(8);
  const notify = nanoid(8);
  return {
    nodes: [
      { id: manual, type: "manual-trigger", position: { x: 100, y: 120 }, data: { label: "Manual Lead Request" } },
      { id: message, type: "message-trigger", position: { x: 100, y: 260 }, data: { label: "Lead Request", channel: "webchat" } },
      {
        id: seed,
        type: "set-variables",
        position: { x: 380, y: 190 },
        data: {
          label: "Capture Lead",
          assignments: [
            { key: "leadQuery", value: "{{trigger.input}}{{message.text}}" },
            { key: "reportSlug", value: "lead-enrichment" },
          ],
        },
      },
      {
        id: agent,
        type: "claude-agent",
        position: { x: 660, y: 190 },
        data: {
          label: "Public-Web Lead Research",
          systemPrompt: [
            "You are a local-first lead enrichment researcher.",
            "Lead/company/person query: {{vars.leadQuery}}",
            "",
            "Use public web search and browser inspection only. Do not assume private CRM access and do not bypass logins.",
            "Produce a concise evidence-backed report with:",
            "1. Identity match and confidence",
            "2. Company/person summary",
            "3. Recent public signals",
            "4. Likely fit/use case",
            "5. Risks or unknowns",
            "6. Recommended next action",
            "Include source URLs in a Sources section.",
            "",
            "Source Quality Scoring (add for each source):",
            "- Credibility: Official/LinkedIn/News = High, Forum/Unknown = Low",
            "- Recency: < 6 months = Recent, > 2 years = Stale",
            "- Relevance: Directly about target = High, Tangentially = Medium",
            "",
            "After the main report, add a structured data block:",
            "```json",
            `{"name":"<company or person name>","domain":"<website or null>","fitScore":<1-10>,"riskScore":<1-10>,"recommendedAction":"<brief string>","topSources":[{"url":"<url>","credibility":"high|medium|low","recency":"recent|current|stale"}]}`,
            "```",
          ].join("\n"),
          temperature: 0.35,
          maxTokens: 2200,
          enabledTools: ["web_search", "browser_action", "memory_search", "memory_store"],
        },
      },
      {
        id: timestamp,
        type: "date-time",
        position: { x: 940, y: 190 },
        data: { label: "Timestamp", operation: "now", timezone: "UTC", locale: "en-US", outputStyle: "datetime" },
      },
      {
        id: saveVars,
        type: "set-variables",
        position: { x: 1220, y: 190 },
        data: {
          label: "Report Metadata",
          assignments: [
            { key: "reportTs", value: "{{date.unixSeconds}}" },
            { key: "startedAt", value: "{{date.formatted}}" },
          ],
        },
      },
      {
        id: writeReport,
        type: "write-file",
        position: { x: 1500, y: 190 },
        data: {
          label: "Save Lead Report",
          path: "data/workspace/reports/lead-enrichment-{{vars.reportTs}}.md",
          contentTemplate: "# Lead Enrichment: {{vars.leadQuery}}\n\nGenerated: {{vars.startedAt}}\n\n{{agent.response}}",
          mode: "overwrite",
        },
      },
      {
        id: extractJson,
        type: "json-transform",
        position: { x: 1780, y: 190 },
        data: {
          label: "Extract Structured Data",
          expression: `(() => {
      const text = input?.output?.content || input?.content || "";
      const match = text.match(/\`\`\`json\\s*([\\s\\S]*?)\`\`\`/);
      if (!match) return { name: "", domain: null, fitScore: 5, riskScore: 5, recommendedAction: "Review manually", topSources: [] };
      try { return JSON.parse(match[1]); } catch { return { name: "", domain: null, fitScore: 5, riskScore: 5, recommendedAction: "Review manually", topSources: [] }; }
    })()`,
        },
      },
      {
        id: writeCsv,
        type: "write-file",
        position: { x: 2060, y: 190 },
        data: {
          label: "Save CSV Summary",
          path: "data/workspace/reports/lead-enrichment-{{vars.reportTs}}.csv",
          contentTemplate: `name,domain,fitScore,riskScore,recommendedAction,query,generatedAt\n"{{json.name}}","{{json.domain}}","{{json.fitScore}}","{{json.riskScore}}","{{json.recommendedAction}}","{{vars.leadQuery}}","{{vars.startedAt}}"`,
          mode: "overwrite",
        },
      },
      {
        id: task,
        type: "board-task",
        position: { x: 2340, y: 190 },
        data: {
          label: "Create Follow-Up",
          titleTemplate: "Follow up: {{vars.leadQuery}}",
          descriptionTemplate: "Lead enrichment report saved at data/workspace/reports/lead-enrichment-{{vars.reportTs}}.md\n\n{{agent.response}}",
          status: "inbox",
          priority: "medium",
        },
      },
      {
        id: store,
        type: "memory-store",
        position: { x: 2620, y: 190 },
        data: { label: "Store Lead Finding", content: "{{agent.response}}", type: "research", extractMode: "manual" },
      },
      {
        id: notify,
        type: "send-webchat",
        position: { x: 2900, y: 190 },
        data: {
          label: "Notify",
          messageTemplate: "Lead enrichment complete for '{{vars.leadQuery}}'. Report saved and a board follow-up was created.",
        },
      },
    ],
    edges: [
      { id: `e-${manual}-${seed}`, source: manual, target: seed },
      { id: `e-${message}-${seed}`, source: message, target: seed },
      { id: `e-${seed}-${agent}`, source: seed, target: agent },
      { id: `e-${agent}-${timestamp}`, source: agent, target: timestamp },
      { id: `e-${timestamp}-${saveVars}`, source: timestamp, target: saveVars },
      { id: `e-${saveVars}-${writeReport}`, source: saveVars, target: writeReport },
      { id: `e-${writeReport}-${extractJson}`, source: writeReport, target: extractJson },
      { id: `e-${extractJson}-${writeCsv}`, source: extractJson, target: writeCsv },
      { id: `e-${writeCsv}-${task}`, source: writeCsv, target: task },
      { id: `e-${task}-${store}`, source: task, target: store },
      { id: `e-${store}-${notify}`, source: store, target: notify },
    ],
  };
}

// ── Live Research Assistant ───────────────────────────────────────────────────
function getLiveResearchAssistantTemplate() {
  const trig = nanoid(8);
  const search = nanoid(8);
  const agent = nanoid(8);
  const store = nanoid(8);
  const reply = nanoid(8);
  const base = { position: { x: 0, y: 0 } };
  return {
    nodes: [
      {
        id: trig,
        type: "message-trigger",
        data: { label: "Research Request", channel: "webchat", filter: "" },
        position: { x: 100, y: 200 },
      },
      {
        id: search,
        type: "http-request",
        data: {
          label: "Web Search",
          url: "/api/execute",
          method: "POST",
          body: JSON.stringify({
            workflowId: "__internal_web_search__",
            triggerType: "manual",
            triggerData: { query: "{{message.text}}" },
          }),
          headers: "",
        },
        position: { x: 350, y: 200 },
      },
      {
        id: agent,
        type: "claude-agent",
        data: {
          label: "Research Agent",
          systemPrompt: [
            "You are a research assistant. The user's question is in {{message.text}}.",
            "Use your web_search tool to find relevant, up-to-date information, then synthesise a clear answer.",
            "Cite your sources at the end.",
          ].join("\n"),
          model: "",
          temperature: 0.4,
          maxTokens: 2000,
          agentId: null,
          enabledTools: ["web_search", "memory_search", "memory_store"],
        },
        position: { x: 600, y: 200 },
      },
      {
        id: store,
        type: "memory-store",
        data: {
          label: "Store Findings",
          content: "{{agent.response}}",
          type: "research",
          extractMode: "manual",
        },
        position: { x: 850, y: 200 },
      },
      {
        id: reply,
        type: "send-webchat",
        data: { label: "Reply", message: "{{agent.response}}" },
        position: { x: 1100, y: 200 },
      },
    ],
    edges: [
      { id: `e-${trig}-${search}`, source: trig, target: search, type: "default" },
      { id: `e-${search}-${agent}`, source: search, target: agent, type: "default" },
      { id: `e-${agent}-${store}`, source: agent, target: store, type: "default" },
      { id: `e-${store}-${reply}`, source: store, target: reply, type: "default" },
    ],
  };
}

// ── Subconscious Loop ─────────────────────────────────────────────────────────
function getSubconsciousLoopTemplate() {
  const trigger    = nanoid(8);
  const seed       = nanoid(8);
  const ideate     = nanoid(8);
  const capture    = nanoid(8);
  const debate     = nanoid(8);
  const synthesize = nanoid(8);
  const writeState = nanoid(8);
  const taskNode   = nanoid(8);
  const store      = nanoid(8);
  const notify     = nanoid(8);

  const STATE_DIR = "data/workspace/subconscious";

  return {
    nodes: [
      {
        id: trigger,
        type: "cron-trigger",
        data: { label: "Subconscious Tick", expression: "0 8 * * *", timezone: "UTC" },
        position: { x: 100, y: 200 },
      },
      {
        id: seed,
        type: "set-variables",
        data: {
          label: "Config",
          assignments: [
            { key: "targetArea", value: "agent output quality and workflow reliability" },
            { key: "agentBrief", value: "You are the subconscious self-improvement loop for an AI agent workspace. Your job is to review what worked, what failed, and what should change next." },
            { key: "stateDir",   value: STATE_DIR },
          ],
        },
        position: { x: 380, y: 200 },
      },
      {
        id: ideate,
        type: "claude-agent",
        data: {
          label: "Ideate: Generate Candidates",
          systemPrompt: [
            "{{vars.agentBrief}}",
            "",
            "TARGET AREA: {{vars.targetArea}}",
            "",
            "STEP 1 — Load previous state (use read_file tool):",
            `  - Read "${STATE_DIR}/winning-concept.md" — contains the previous run's Winning Concept, Improvement Backlog, and Run Summary sections (may not exist on first run, that's fine).`,
            "",
            "STEP 2 — Generate 3-5 candidate improvement directions.",
            "For each candidate write a 2-3 sentence direction: what to improve, why, what evidence suggests it.",
            "Format as a numbered list. Be concrete, not abstract.",
            "Draw from the backlog and any patterns you observe in recent workspace state (MEMORY.md, SOUL.md, etc.).",
          ].join("\n"),
          temperature: 0.7,
          maxTokens: 1200,
          enabledTools: ["read_file", "memory_search"],
        },
        position: { x: 680, y: 200 },
      },
      {
        id: capture,
        type: "set-variables",
        data: {
          label: "Capture Candidates",
          assignments: [{ key: "candidates", value: "{{agent.response}}" }],
        },
        position: { x: 960, y: 200 },
      },
      {
        id: debate,
        type: "council",
        data: {
          label: "Debate: Challenge Candidates",
          topic: [
            "Self-improvement debate for: {{vars.targetArea}}",
            "",
            "Candidates proposed:",
            "{{vars.candidates}}",
            "",
            "For each candidate: identify the strongest objection, the weakest assumption,",
            "and whether it survives scrutiny. End with a clear recommendation on which",
            "one is most actionable and likely to compound.",
          ].join("\n"),
          optionsText: "Strong — ship it, Needs revision, Reject",
          decisionMode: "majority",
        },
        position: { x: 1240, y: 200 },
      },
      {
        id: synthesize,
        type: "claude-agent",
        data: {
          label: "Synthesize: Pick Winner",
          systemPrompt: [
            "{{vars.agentBrief}}",
            "",
            "CANDIDATES:",
            "{{vars.candidates}}",
            "",
            "COUNCIL DEBATE OUTCOME:",
            "{{agent.response}}",
            "",
            "TASK: Synthesize the outcome into three sections.",
            "Write ONLY this — no preamble:",
            "",
            "## Winning Concept",
            "What direction survived the debate and why. 3-5 sentences. Specific, honest.",
            "",
            "## Improvement Backlog",
            "3-5 bullet points of directions worth trying next time.",
            "Include ideas that were rejected this run but may be right later.",
            "",
            "## Run Summary",
            "One paragraph: what was decided, why, what changed from last run.",
          ].join("\n"),
          temperature: 0.3,
          maxTokens: 1000,
        },
        position: { x: 1520, y: 200 },
      },
      {
        id: writeState,
        type: "write-file",
        data: {
          label: "Write winning-concept.md",
          path: `${STATE_DIR}/winning-concept.md`,
          content: "{{agent.response}}",
          mode: "overwrite",
        },
        position: { x: 1800, y: 200 },
      },
      {
        id: taskNode,
        type: "board-task",
        data: {
          label: "Queue Approval Task",
          title: "Review subconscious loop output — {{cron.triggeredAt}}",
          description: "{{agent.response}}",
          priority: "medium",
          status: "inbox",
        },
        position: { x: 2080, y: 200 },
      },
      {
        id: store,
        type: "memory-store",
        data: {
          label: "Persist Winning Concept",
          content: "{{agent.response}}",
          type: "playbook",
          extractMode: "manual",
        },
        position: { x: 2360, y: 200 },
      },
      {
        id: notify,
        type: "send-webchat",
        data: {
          label: "Notify",
          message: "Subconscious loop complete ({{cron.triggeredAt}}).\n\n{{agent.response}}",
        },
        position: { x: 2640, y: 200 },
      },
    ],
    edges: [
      { id: `e-${trigger}-${seed}`,        source: trigger,    target: seed },
      { id: `e-${seed}-${ideate}`,         source: seed,       target: ideate },
      { id: `e-${ideate}-${capture}`,      source: ideate,     target: capture },
      { id: `e-${capture}-${debate}`,      source: capture,    target: debate },
      { id: `e-${debate}-${synthesize}`,   source: debate,     target: synthesize },
      { id: `e-${synthesize}-${writeState}`, source: synthesize, target: writeState },
      { id: `e-${writeState}-${taskNode}`, source: writeState, target: taskNode },
      { id: `e-${taskNode}-${store}`,      source: taskNode,   target: store },
      { id: `e-${store}-${notify}`,        source: store,      target: notify },
    ],
  };
}

// ── Short Video Generator (MoneyPrinterTurbo-inspired) ───────────────────────
function getShortVideoGeneratorTemplate() {
  const trigA        = nanoid(8);
  const trigB        = nanoid(8);
  const jobVars      = nanoid(8);
  const scriptWriter = nanoid(8);
  const saveScript   = nanoid(8);
  const kwExtract    = nanoid(8);
  const pexels       = nanoid(8);
  const clipDl       = nanoid(8);
  const renderer     = nanoid(8);
  const memStore     = nanoid(8);
  const btNode       = nanoid(8);
  const sendOut      = nanoid(8);

  const b = { position: { x: 0, y: 0 } };

  return {
    nodes: [
      {
        id: trigA, type: "manual-trigger",
        data: { label: "Manual Trigger (Test)" }, ...b,
      },
      {
        id: trigB, type: "message-trigger",
        data: { label: "Video Request", channel: "webchat", filter: "video,reel,short,tiktok,youtube,shorts" }, ...b,
      },
      {
        id: jobVars, type: "set-variables",
        data: {
          label: "Job Config",
          assignments: [
            { key: "topic",      value: "{{trigger.input}}{{trigger.message}}" },
            { key: "style",      value: "educational" },
            { key: "duration",   value: "45" },
            { key: "pexelsKey",  value: "YOUR_PEXELS_API_KEY" },
            { key: "jobId",      value: "{{provenance.executionId}}" },
            { key: "jobDir",     value: "data/generated-videos/{{provenance.executionId}}" },
          ],
        }, ...b,
      },
      {
        id: scriptWriter, type: "claude-agent",
        data: {
          label: "Script Writer",
          systemPrompt: [
            "You are writing a short-form video script for TikTok, Instagram Reels, and YouTube Shorts.",
            "",
            "Topic: {{vars.topic}}",
            "Style: {{vars.style}}",
            "Target duration: {{vars.duration}} seconds",
            "Language: English",
            "",
            "Rules:",
            "- Use simple spoken English.",
            "- Hook the viewer in the first 2 seconds with a bold statement or question.",
            "- Use short sentences (8 words or fewer).",
            "- Avoid complex words or jargon.",
            "- No markdown, no scene labels, no hashtags.",
            "- Return ONLY the narration script text.",
            "- Aim for 100–150 words for a 45-second video.",
            "",
            "After writing the script, save it using write_file:",
            "  path: {{vars.jobDir}}/script.txt",
            "  content: the script text",
            "",
            "Return the full script text as your final response.",
          ].join("\n"),
          temperature: 0.7,
          maxTokens: 600,
          enabledTools: ["write_file"],
          execSecurity: "deny",
        }, ...b,
      },
      {
        id: saveScript, type: "set-variables",
        data: {
          label: "Save Script",
          assignments: [
            { key: "script", value: "{{agent.response}}" },
          ],
        }, ...b,
      },
      {
        id: kwExtract, type: "claude-agent",
        data: {
          label: "Keyword Extractor",
          systemPrompt: [
            "Extract 5 short stock video search keywords from this script.",
            "",
            "Script: {{vars.script}}",
            "",
            "Rules:",
            "- English only.",
            "- Each keyword must be 1 to 3 words.",
            "- Use visual terms that can be found in stock footage (people, actions, places).",
            "- Return ONLY a comma-separated list of keywords.",
            "- Example output: focused work, morning routine, coffee desk, writing notes, city walk",
          ].join("\n"),
          temperature: 0.3,
          maxTokens: 100,
          enabledTools: [],
          execSecurity: "deny",
        }, ...b,
      },
      {
        id: pexels, type: "http-request",
        data: {
          label: "Pexels Stock Video Search",
          method: "GET",
          url: "https://api.pexels.com/videos/search?query={{agent.response}}&per_page=5&orientation=portrait&size=medium",
          headers: { Authorization: "{{vars.pexelsKey}}" },
        }, ...b,
      },
      {
        id: clipDl, type: "claude-agent",
        data: {
          label: "Clip Downloader",
          systemPrompt: [
            "You are a video clip downloader. Your job is to download stock footage clips for a short video.",
            "",
            "Pexels API response: {{http.body}}",
            "Job directory: {{vars.jobDir}}",
            "",
            "Steps:",
            "1. Create clips directory: bash_exec: mkdir -p {{vars.jobDir}}/clips",
            "2. Parse the JSON response and extract up to 5 video download URLs (prefer HD portrait links).",
            "3. For each URL, download with: bash_exec: curl -L --max-time 60 -o {{vars.jobDir}}/clips/clip_N.mp4 \"<url>\"",
            "   (replace N with 0, 1, 2, ...)",
            "4. Standardize each valid clip to 1080x1920:",
            "   bash_exec: ffmpeg -i {{vars.jobDir}}/clips/clip_N.mp4 -vf 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920' -c:v libx264 -preset veryfast -an -y {{vars.jobDir}}/clips/clip_N_std.mp4",
            "5. Write a concat list: write_file path={{vars.jobDir}}/clips/clips.txt content with lines: file 'clip_N_std.mp4'",
            "",
            "If Pexels returns no videos or an error, respond: NO_CLIPS_AVAILABLE",
            "If curl or ffmpeg is missing, respond: MISSING_DEPENDENCY: <name>",
            "IMPORTANT: Only write files under {{vars.jobDir}}/. Never write outside that path.",
          ].join("\n"),
          temperature: 0.2,
          maxTokens: 2048,
          enabledTools: ["bash_exec", "write_file"],
          execSecurity: "allowlist",
          execAllowlist: ["curl", "ffmpeg", "ffprobe", "mkdir"],
          execAsk: "off",
        }, ...b,
      },
      {
        id: renderer, type: "claude-agent",
        data: {
          label: "TTS & Renderer",
          systemPrompt: [
            "You are a video renderer. Your job: generate voiceover, create subtitles, and render the final MP4.",
            "",
            "Job directory: {{vars.jobDir}}",
            "Script for narration: {{vars.script}}",
            "",
            "Step 1 — Generate voiceover audio (choose ONE method, in order of preference):",
            "  a) Edge TTS (free, no API key): bash_exec: python3 -m edge_tts --text \"{{vars.script}}\" --voice en-US-AriaNeural --write-media {{vars.jobDir}}/audio/voice.mp3",
            "     Create dir first: bash_exec: mkdir -p {{vars.jobDir}}/audio",
            "  b) If edge-tts not installed: bash_exec: pip install edge-tts --quiet && python3 -m edge_tts --text \"{{vars.script}}\" --voice en-US-AriaNeural --write-media {{vars.jobDir}}/audio/voice.mp3",
            "",
            "Step 2 — Generate subtitles:",
            "  Create dir: bash_exec: mkdir -p {{vars.jobDir}}/subtitles",
            "  a) If whisper is installed: bash_exec: whisper {{vars.jobDir}}/audio/voice.mp3 --output_format srt --output_dir {{vars.jobDir}}/subtitles",
            "     Rename output: bash_exec: mv {{vars.jobDir}}/subtitles/voice.srt {{vars.jobDir}}/subtitles/subtitles.srt",
            "  b) Otherwise: generate a simple SRT file with write_file by estimating ~2s per 10 words.",
            "     Format: 1\\n00:00:00,000 --> 00:00:03,000\\nFirst sentence\\n\\n2\\n00:00:03,000 --> ...\\n...",
            "     Save to: {{vars.jobDir}}/subtitles/subtitles.srt",
            "",
            "Step 3 — Render final video:",
            "  Create dir: bash_exec: mkdir -p {{vars.jobDir}}/final",
            "  bash_exec: ffmpeg -f concat -safe 0 -i {{vars.jobDir}}/clips/clips.txt -i {{vars.jobDir}}/audio/voice.mp3 -vf \"subtitles={{vars.jobDir}}/subtitles/subtitles.srt:force_style='Fontsize=40,PrimaryColour=&HFFFFFF,OutlineColour=&H000000,BorderStyle=1,Outline=3,Alignment=2'\" -c:v libx264 -preset veryfast -crf 22 -r 30 -c:a aac -shortest -y {{vars.jobDir}}/final/final.mp4",
            "  If clips.txt is missing (no stock footage): use a 2s black frame as fallback: bash_exec: ffmpeg -f lavfi -i color=black:s=1080x1920:r=30 -i {{vars.jobDir}}/audio/voice.mp3 -shortest -y {{vars.jobDir}}/final/final.mp4",
            "",
            "Step 4 — Verify output:",
            "  bash_exec: ffprobe -v quiet -print_format json -show_format {{vars.jobDir}}/final/final.mp4",
            "",
            "Step 5 — Return a summary: 'Video ready at {{vars.jobDir}}/final/final.mp4' (or describe any errors).",
            "  Include the artifact URL: /api/generated-videos?id={{vars.jobId}}/final/final.mp4",
            "",
            "IMPORTANT: Only write files under {{vars.jobDir}}/. Never write outside that directory.",
          ].join("\n"),
          temperature: 0.2,
          maxTokens: 3000,
          enabledTools: ["bash_exec", "write_file"],
          execSecurity: "allowlist",
          execAllowlist: ["ffmpeg", "ffprobe", "whisper", "python3", "pip", "mkdir", "mv", "edge_tts"],
          execAsk: "off",
        }, ...b,
      },
      {
        id: memStore, type: "memory-store",
        data: {
          label: "Store Video Record",
          extractMode: "manual",
          manualContent: "Short video generated — topic: {{vars.topic}} | output: {{vars.jobDir}}/final/final.mp4",
          type: "insight",
        }, ...b,
      },
      {
        id: btNode, type: "board-task",
        data: {
          label: "Create Video Ready Task",
          action: "create",
          boardId: "main-board",
          title: "Short video ready: {{vars.topic}}",
          description: "AI-generated short video.\n\nTopic: {{vars.topic}}\nOutput: {{vars.jobDir}}/final/final.mp4\nArtifact: /api/generated-videos?id={{vars.jobId}}/final/final.mp4",
          status: "review",
          priority: "medium",
        }, ...b,
      },
      {
        id: sendOut, type: "send-webchat",
        data: { label: "Deliver Result", message: "{{agent.response}}" }, ...b,
      },
    ],
    edges: [
      { id: `e-${trigA}-${jobVars}`,       source: trigA,       target: jobVars },
      { id: `e-${trigB}-${jobVars}`,       source: trigB,       target: jobVars },
      { id: `e-${jobVars}-${scriptWriter}`, source: jobVars,     target: scriptWriter },
      { id: `e-${scriptWriter}-${saveScript}`, source: scriptWriter, target: saveScript },
      { id: `e-${saveScript}-${kwExtract}`, source: saveScript,  target: kwExtract },
      { id: `e-${kwExtract}-${pexels}`,    source: kwExtract,   target: pexels },
      { id: `e-${pexels}-${clipDl}`,       source: pexels,      target: clipDl },
      { id: `e-${clipDl}-${renderer}`,     source: clipDl,      target: renderer },
      { id: `e-${renderer}-${memStore}`,   source: renderer,    target: memStore },
      { id: `e-${memStore}-${btNode}`,     source: memStore,    target: btNode },
      { id: `e-${btNode}-${sendOut}`,      source: btNode,      target: sendOut },
    ],
  };
}

// ── Trading Research Cycle (AutoHedge + Vibe-Trading daily routine) ───────────
function getTradingResearchCycleTemplate(
  assignments: TemplateAgentAssignments = {},
) {
  const manual      = nanoid(8);
  const cronTrig    = nanoid(8);
  const cycleVars   = nanoid(8);
  const director    = nanoid(8);
  const quant       = nanoid(8);
  const riskMgr     = nanoid(8);
  const parseRisk   = nanoid(8);
  const ifElse      = nanoid(8);
  const execSim     = nanoid(8);
  const btNode      = nanoid(8);
  const sendApproved = nanoid(8);
  const sendNoTrades = nanoid(8);

  const directorAgentId = assignments.director ?? "";
  const quantAgentId    = assignments.quant    ?? "";
  const riskAgentId     = assignments.risk     ?? "";
  const execSimAgentId  = assignments.exec     ?? "";

  const b = { position: { x: 0, y: 0 } };

  return {
    nodes: [
      {
        id: manual, type: "manual-trigger",
        data: { label: "Manual Trigger (Test)" }, ...b,
      },
      {
        id: cronTrig, type: "cron-trigger",
        data: { label: "Daily Market Open", expression: "0 9 * * 1-5", timezone: "UTC" }, ...b,
      },
      {
        id: cycleVars, type: "set-variables",
        data: {
          label: "Cycle Config",
          assignments: [
            { key: "cycleId",   value: "{{provenance.executionId}}" },
            { key: "cycleAt",   value: "{{cron.triggeredAt}}{{manual.triggeredAt}}" },
            { key: "watchlist", value: "SOL,BTC,ETH,SPY,QQQ" },
            { key: "runDir",    value: "data/research/{{provenance.executionId}}" },
          ],
        }, ...b,
      },
      {
        id: director, type: "claude-agent",
        data: {
          label: "Director: Investment Thesis",
          agentId: directorAgentId,
          systemPrompt: [
            "You are the Research Director of a multi-asset trading desk. Today's date: {{vars.cycleAt}}.",
            "Watchlist: {{vars.watchlist}}",
            "",
            "Your job: generate an investment thesis and candidate list for today's research cycle.",
            "",
            "Instructions:",
            "1. Use web_search and fetch_url to gather recent market news, macro events, and sentiment for the watchlist.",
            "2. Check memory_search for relevant prior theses and outcomes.",
            "3. Synthesize a directional thesis.",
            "",
            "Return ONLY valid JSON in this exact schema (no markdown, no prose):",
            "{",
            "  \"thesis\": \"<2–3 sentence market thesis>\",",
            "  \"data_fetched_at\": \"<ISO timestamp>\",",
            "  \"candidates\": [",
            "    { \"symbol\": \"<ticker>\", \"direction\": \"long|short|neutral\", \"rationale\": \"<1–2 sentences>\" }",
            "  ]",
            "}",
            "",
            "Include only symbols from the watchlist. Maximum 5 candidates.",
          ].join("\n"),
          temperature: 0.3,
          maxTokens: 1200,
          enabledTools: ["web_search", "fetch_url", "memory_search"],
          execSecurity: "deny",
        }, ...b,
      },
      {
        id: quant, type: "claude-agent",
        data: {
          label: "Quant: Score Candidates",
          agentId: quantAgentId,
          systemPrompt: [
            "You are the Quant Analyst. Evaluate the Director's candidates with technical and statistical analysis.",
            "",
            "Director output: {{agent.response}}",
            "",
            "Instructions:",
            "1. Use http_request to fetch price data (e.g., Yahoo Finance, CoinGecko) for each candidate.",
            "2. Use run_python_script to compute: 20-day momentum, 14-day RSI, volume ratio (today vs 20d avg).",
            "   Save a summary CSV to {{vars.runDir}}/quant_signals.csv",
            "3. Score each candidate 1–10 based on signal strength.",
            "",
            "Return ONLY valid JSON (no markdown, no prose):",
            "{",
            "  \"data_fetched_at\": \"<ISO timestamp>\",",
            "  \"candidates\": [",
            "    {",
            "      \"symbol\": \"<ticker>\",",
            "      \"score\": <1-10>,",
            "      \"signals\": { \"trend\": \"up|down|flat\", \"momentum\": <float>, \"rsi\": <float>, \"volume_ratio\": <float> }",
            "    }",
            "  ]",
            "}",
          ].join("\n"),
          temperature: 0.2,
          maxTokens: 1500,
          enabledTools: ["http_request", "run_python_script", "write_file"],
          execSecurity: "deny",
        }, ...b,
      },
      {
        id: riskMgr, type: "claude-agent",
        data: {
          label: "Risk Manager: Gate & Size",
          agentId: riskAgentId,
          systemPrompt: [
            "You are the Risk Manager. Apply position sizing and risk gates to the Quant's scored candidates.",
            "",
            "Quant output: {{agent.response}}",
            "",
            "Instructions:",
            "1. Accept only candidates with score >= 6.",
            "2. Use run_python_script to compute simple VaR (95%) for each accepted candidate using recent prices.",
            "   Assume portfolio size $10,000. Max single position: $2,000 (20%). Max total exposure: $6,000.",
            "3. Reject candidates where VaR exceeds 3% of portfolio ($300).",
            "",
            "Return ONLY valid JSON (no markdown, no prose):",
            "{",
            "  \"data_fetched_at\": \"<ISO timestamp>\",",
            "  \"approved\": [",
            "    { \"symbol\": \"<ticker>\", \"direction\": \"long|short\", \"size_usd\": <float>, \"max_loss_usd\": <float>, \"stop_pct\": <float> }",
            "  ],",
            "  \"rejected\": [",
            "    { \"symbol\": \"<ticker>\", \"reason\": \"<why rejected>\" }",
            "  ]",
            "}",
          ].join("\n"),
          temperature: 0.2,
          maxTokens: 1200,
          enabledTools: ["run_python_script"],
          execSecurity: "deny",
        }, ...b,
      },
      {
        id: parseRisk, type: "run-code",
        data: {
          label: "Parse Risk Decision",
          language: "javascript",
          code: [
            "var riskText = (input && input.response) ? input.response : '';",
            "var riskJson;",
            "try { riskJson = JSON.parse(riskText); }",
            "catch (e) {",
            "  var m = riskText.match(/\\{[\\s\\S]*\\}/);",
            "  try { riskJson = m ? JSON.parse(m[0]) : { approved: [], rejected: [] }; }",
            "  catch (e2) { riskJson = { approved: [], rejected: [] }; }",
            "}",
            "var approved = Array.isArray(riskJson.approved) ? riskJson.approved : [];",
            "var rejected = Array.isArray(riskJson.rejected) ? riskJson.rejected : [];",
            "result = {",
            "  hasApproved: approved.length > 0,",
            "  approvedCount: approved.length,",
            "  approvedJson: JSON.stringify(approved),",
            "  rejectedJson: JSON.stringify(rejected),",
            "  riskSummary: JSON.stringify(riskJson)",
            "};",
          ].join("\n"),
        }, ...b,
      },
      {
        id: ifElse, type: "if-else",
        data: { label: "Has Approved Trades?", condition: "result_hasApproved == true" }, ...b,
      },
      {
        id: execSim, type: "claude-agent",
        data: {
          label: "Execution Sim (Write Only)",
          agentId: execSimAgentId,
          systemPrompt: [
            "You are the Execution Sim. Write a proposed_orders.json file — THIS IS SIMULATION ONLY. Do not call any broker, exchange, or API.",
            "",
            "Approved candidates (from Risk Manager): {{run.result.approvedJson}}",
            "Cycle ID: {{vars.cycleId}}",
            "Run directory: {{vars.runDir}}",
            "",
            "Instructions:",
            "1. Use write_file to save the proposed orders to {{vars.runDir}}/proposed_orders.json",
            "2. The JSON content should be:",
            "{",
            "  \"cycle_id\": \"{{vars.cycleId}}\",",
            "  \"generated_at\": \"<ISO timestamp>\",",
            "  \"simulation_only\": true,",
            "  \"orders\": <approved candidates array>",
            "}",
            "3. Return: 'Proposed orders written to {{vars.runDir}}/proposed_orders.json. SIMULATION ONLY — no live orders placed.'",
            "",
            "CRITICAL: You have NO access to any exchange, broker, or trading API. write_file is your only tool.",
          ].join("\n"),
          temperature: 0.1,
          maxTokens: 600,
          enabledTools: ["write_file"],
          execSecurity: "deny",
        }, ...b,
      },
      {
        id: btNode, type: "board-task",
        data: {
          label: "Queue Review Task",
          action: "create",
          boardId: "main-board",
          title: "Review proposed orders — {{vars.cycleId}}",
          description: "Trading Research Cycle completed for {{vars.cycleId}}.\n\nApproved: {{run.result.approvedCount}} trade(s)\nArtifact: {{vars.runDir}}/proposed_orders.json\n\nReview before any manual action. SIMULATION ONLY.",
          status: "review",
          priority: "high",
        }, ...b,
      },
      {
        id: sendApproved, type: "send-webchat",
        data: {
          label: "Notify: Trades Proposed",
          message: "Trading cycle {{vars.cycleId}} complete.\n\n{{agent.response}}\n\nReview task created. SIMULATION ONLY — no live orders placed.",
        }, ...b,
      },
      {
        id: sendNoTrades, type: "send-webchat",
        data: {
          label: "Notify: No Trades Today",
          message: "Trading cycle {{vars.cycleId}}: no trades approved by Risk Manager.\n\nRejected: {{run.result.rejectedJson}}",
        }, ...b,
      },
    ],
    edges: [
      { id: `e-${manual}-${cycleVars}`,      source: manual,       target: cycleVars },
      { id: `e-${cronTrig}-${cycleVars}`,    source: cronTrig,     target: cycleVars },
      { id: `e-${cycleVars}-${director}`,    source: cycleVars,    target: director },
      { id: `e-${director}-${quant}`,        source: director,     target: quant },
      { id: `e-${quant}-${riskMgr}`,         source: quant,        target: riskMgr },
      { id: `e-${riskMgr}-${parseRisk}`,     source: riskMgr,      target: parseRisk },
      { id: `e-${parseRisk}-${ifElse}`,      source: parseRisk,    target: ifElse },
      { id: `e-${ifElse}-${execSim}`,        source: ifElse,       target: execSim,     sourceHandle: "true" },
      { id: `e-${execSim}-${btNode}`,        source: execSim,      target: btNode },
      { id: `e-${btNode}-${sendApproved}`,   source: btNode,       target: sendApproved },
      { id: `e-${ifElse}-${sendNoTrades}`,   source: ifElse,       target: sendNoTrades, sourceHandle: "false" },
    ],
  };
}

// ── Automation recipe pack (generic-named, originally inspired by common ops/dev/research
// automations). Triggers: cron (schedule) / webhook-trigger (event or API call). Agents that
// have "nothing to report" emit `[SILENT]` so the downstream send node suppresses the message.
// ──────────────────────────────────────────────────────────────────────────────────────────

function n(id: string, type: string, x: number, data: Record<string, unknown>) {
  return { id, type, position: { x, y: 200 }, data: { ...data } };
}
function chain(ids: string[]) {
  return ids.slice(0, -1).map((s, i) => ({ id: `e-${s}-${ids[i + 1]}`, source: s, target: ids[i + 1], type: "default" }));
}

function getIssueTriageSchedulerTemplate() {
  const t = nanoid(8), fetchN = nanoid(8), agent = nanoid(8), board = nanoid(8), send = nanoid(8);
  return {
    nodes: [
      n(t, "cron-trigger", 100, { label: "Nightly 9 PM", expression: "0 21 * * *" }),
      n(fetchN, "http-request", 330, { label: "Fetch Open Issues", url: "https://api.github.com/repos/OWNER/REPO/issues?state=open", method: "GET", headers: "{\"Accept\":\"application/vnd.github+json\"}" }),
      n(agent, "claude-agent", 560, { label: "Triage Issues", systemPrompt: "You are a backlog triage assistant. For each issue in {{http-request.body}}: assign a label and a priority (P0/P1/P2/P3), flag likely duplicates, and write a one-line summary. If nothing changed since last run, reply with exactly [SILENT].", enabledTools: ["memory_search", "memory_store"], model: "" }),
      n(board, "board-task", 790, { label: "Create P0/P1 Tasks", title: "Triage follow-up", description: "{{claude-agent.response}}", status: "inbox" }),
      n(send, "send-webchat", 1020, { label: "Post Summary", message: "{{claude-agent.response}}" }),
    ],
    edges: chain([t, fetchN, agent, board, send]),
  };
}

function getPullRequestReviewerTemplate() {
  const hook = nanoid(8), diff = nanoid(8), agent = nanoid(8), comment = nanoid(8);
  return {
    nodes: [
      n(hook, "github-trigger", 100, { label: "PR Opened", events: "pull_request" }),
      n(diff, "http-request", 330, { label: "Fetch Diff", url: "{{github-trigger.diffUrl}}", method: "GET" }),
      n(agent, "claude-agent", 560, { label: "Review PR", systemPrompt: "You are a senior reviewer. Review the diff in {{http-request.body}} for security, performance, and code quality. Output: Summary, Blocking issues, Non-blocking issues, Security concerns, Suggested tests. If the change is trivial and risk-free, reply [SILENT].", model: "" }),
      n(comment, "github-comment", 790, { label: "Post Review Comment", repo: "{{github-trigger.repo}}", issueNumber: "{{github-trigger.number}}", body: "{{claude-agent.response}}", mockMode: true }),
    ],
    edges: chain([hook, diff, agent, comment]),
  };
}

function getDocsDriftDetectorTemplate() {
  const hook = nanoid(8), agent = nanoid(8), send = nanoid(8);
  return {
    nodes: [
      n(hook, "webhook-trigger", 100, { label: "PR Webhook", path: "docs-drift" }),
      n(agent, "claude-agent", 330, { label: "Detect Docs Drift", systemPrompt: "Given the changed files in {{webhook.body}}, decide if source files changed but docs/README/API docs did not. If docs are stale, list the exact docs that likely need updating. If docs were also updated or no docs are affected, reply with exactly [SILENT].", model: "" }),
      n(send, "send-webchat", 560, { label: "Comment Stale Docs", message: "{{claude-agent.response}}" }),
    ],
    edges: chain([hook, agent, send]),
  };
}

function getDependencyVulnerabilityScannerTemplate() {
  const t = nanoid(8), scan = nanoid(8), agent = nanoid(8), board = nanoid(8), file = nanoid(8), send = nanoid(8);
  return {
    nodes: [
      n(t, "cron-trigger", 100, { label: "Daily 6 AM", expression: "0 6 * * *" }),
      n(scan, "system-command", 330, { label: "List Dependencies", command: "list-files", args: "." }),
      n(agent, "claude-agent", 560, { label: "Filter CVSS >= 7", systemPrompt: "Audit the dependency manifests/lockfiles described in {{system-command.output}}. Report only vulnerabilities with CVSS >= 7.0 as: package, version, CVE, CVSS, fix. If none meet the threshold, reply with exactly [SILENT].", enabledTools: ["read_file", "web_search"], model: "" }),
      n(board, "board-task", 790, { label: "Task For Criticals", title: "Critical dependency vulnerabilities", description: "{{claude-agent.response}}", status: "inbox" }),
      n(file, "write-file", 1020, { label: "Save Report", path: "reports/dependency-audit.md", content: "{{claude-agent.response}}" }),
      n(send, "send-webchat", 1250, { label: "Notify", message: "{{claude-agent.response}}" }),
    ],
    edges: chain([t, scan, agent, board, file, send]),
  };
}

function getDeploySmokeVerifierTemplate() {
  const hook = nanoid(8), http = nanoid(8), code = nanoid(8), gate = nanoid(8), alert = nanoid(8), ok = nanoid(8);
  return {
    nodes: [
      n(hook, "webhook-trigger", 100, { label: "Deploy Webhook", path: "deploy-verify" }),
      n(http, "http-request", 330, { label: "Smoke Test Endpoint", url: "https://httpbin.org/status/200", method: "GET", timeoutMs: 10000 }),
      n(code, "run-code", 560, { label: "Compare Baseline", language: "javascript", code: "var s=String((input&&(input.status||input.statusCode))||'unknown');result={failed:s!=='200'&&s!=='204',status:s,message:'Deploy check status '+s};" }),
      n(gate, "if-else", 790, { label: "Failed Or Regressed?", condition: "result_failed == true" }),
      n(alert, "send-discord", 1020, { label: "Alert Discord", message: "Deploy verification failed: {{run-code.result.message}}" }),
      n(ok, "send-webchat", 1020, { label: "Silent OK", message: "[SILENT]" }),
    ],
    edges: [
      ...chain([hook, http, code, gate]),
      { id: `e-${gate}-${alert}`, source: gate, target: alert, sourceHandle: "true" },
      { id: `e-${gate}-${ok}`, source: gate, target: ok, sourceHandle: "false" },
    ],
  };
}

function getIncidentAlertCorrelatorTemplate() {
  const hook = nanoid(8), agent = nanoid(8), gate = nanoid(8), board = nanoid(8), send = nanoid(8);
  return {
    nodes: [
      n(hook, "webhook-trigger", 100, { label: "Alert Webhook", path: "alert-triage" }),
      n(agent, "claude-agent", 330, { label: "Correlate Alert", systemPrompt: "Given the alert JSON {{webhook.body}}, correlate it with recent deploys and commits. State probable cause, confidence, and next action. Do not invent evidence you do not have. End your reply with SEVERITY: high|medium|low.", enabledTools: ["memory_search"], model: "" }),
      n(gate, "if-else", 560, { label: "High Severity?", condition: "claude-agent.response contains SEVERITY: high" }),
      n(board, "board-task", 790, { label: "Create Incident Task", title: "High-severity incident", description: "{{claude-agent.response}}", status: "inbox" }),
      n(send, "send-slack", 1020, { label: "Notify Slack", message: "{{claude-agent.response}}" }),
    ],
    edges: [
      ...chain([hook, agent, gate]),
      { id: `e-${gate}-${board}`, source: gate, target: board, sourceHandle: "true" },
      { id: `e-${board}-${send}`, source: board, target: send, type: "default" },
    ],
  };
}

function getEndpointUptimeWatchTemplate() {
  const t = nanoid(8), http = nanoid(8), code = nanoid(8), gate = nanoid(8), down = nanoid(8), up = nanoid(8);
  return {
    nodes: [
      n(t, "cron-trigger", 100, { label: "Every 30 Minutes", expression: "*/30 * * * *" }),
      n(http, "http-request", 330, { label: "Check Endpoint", url: "https://httpbin.org/status/200", method: "GET", timeoutMs: 10000 }),
      n(code, "run-code", 560, { label: "Evaluate", language: "javascript", code: "var s=String((input&&(input.status||input.statusCode))||'unknown');result={down:s!=='200'&&s!=='204',status:s,message:'Endpoint status '+s+' at '+new Date().toISOString()};" }),
      n(gate, "if-else", 790, { label: "Down?", condition: "result_down == true" }),
      n(down, "send-telegram", 1020, { label: "Alert Telegram", message: "DOWN: {{run-code.result.message}}" }),
      n(up, "send-webchat", 1020, { label: "Silent When Healthy", message: "[SILENT]" }),
    ],
    edges: [
      ...chain([t, http, code, gate]),
      { id: `e-${gate}-${down}`, source: gate, target: down, sourceHandle: "true" },
      { id: `e-${gate}-${up}`, source: gate, target: up, sourceHandle: "false" },
    ],
  };
}

function getCompetitorRepoWatcherTemplate() {
  const t = nanoid(8), http = nanoid(8), agent = nanoid(8), file = nanoid(8), send = nanoid(8);
  return {
    nodes: [
      n(t, "cron-trigger", 100, { label: "Daily 8 AM", expression: "0 8 * * *" }),
      n(http, "http-request", 330, { label: "Fetch Repo Activity", url: "https://api.github.com/repos/OWNER/REPO/events", method: "GET" }),
      n(agent, "claude-agent", 560, { label: "Summarize Relevance", systemPrompt: "Summarize the notable changes in {{http-request.body}} (new PRs, releases, notable commits) and explain why each matters to our product. If nothing meaningful changed, reply [SILENT].", enabledTools: ["memory_store"], model: "" }),
      n(file, "write-file", 790, { label: "Save Dated Report", path: "reports/competitor-watch.md", content: "{{claude-agent.response}}" }),
      n(send, "send-webchat", 1020, { label: "Digest", message: "{{claude-agent.response}}" }),
    ],
    edges: chain([t, http, agent, file, send]),
  };
}

function getWeeklyNewsDigestTemplate() {
  const t = nanoid(8), rss = nanoid(8), agent = nanoid(8), file = nanoid(8), send = nanoid(8);
  return {
    nodes: [
      n(t, "cron-trigger", 100, { label: "Weekly Mon 9 AM", expression: "0 9 * * 1" }),
      n(rss, "rss-read", 330, { label: "Collect Headlines", url: "https://hnrss.org/frontpage", limit: 20 }),
      n(agent, "claude-agent", 560, { label: "Summarize + Cite", systemPrompt: "From the items in {{rss-read.items}}, write a short digest. Separate verified facts from claims, cite source URLs, and keep it concise. End with a one-paragraph TL;DR.", enabledTools: ["web_search"], model: "" }),
      n(file, "write-file", 790, { label: "Save Report", path: "reports/news-digest.md", content: "{{claude-agent.response}}" }),
      n(send, "send-webchat", 1020, { label: "Short Summary", message: "{{claude-agent.response}}" }),
    ],
    edges: chain([t, rss, agent, file, send]),
  };
}

function getResearchPaperScannerTemplate() {
  const t = nanoid(8), rss = nanoid(8), agent = nanoid(8), board = nanoid(8), file = nanoid(8);
  return {
    nodes: [
      n(t, "cron-trigger", 100, { label: "Daily 7 AM", expression: "0 7 * * *" }),
      n(rss, "rss-read", 330, { label: "Fetch arXiv Feed", url: "http://export.arxiv.org/rss/cs.AI", limit: 25 }),
      n(agent, "claude-agent", 560, { label: "Filter Relevant", systemPrompt: "From {{rss-read.items}}, summarize ONLY papers relevant to agentic workflows, local LLMs, tool use, and workflow automation. Keep summaries to two lines each. Reply [SILENT] if none are relevant.", model: "" }),
      n(board, "board-task", 790, { label: "Tasks For Worth-Testing", title: "Papers worth testing", description: "{{claude-agent.response}}", status: "inbox" }),
      n(file, "write-file", 1020, { label: "Save Summaries", path: "reports/paper-scan.md", content: "{{claude-agent.response}}" }),
    ],
    edges: chain([t, rss, agent, board, file]),
  };
}

function getOvernightAutonomyBriefingTemplate() {
  const manual = nanoid(8), cron = nanoid(8), channels = nanoid(8), saveChannels = nanoid(8), schedules = nanoid(8), saveSchedules = nanoid(8), tasks = nanoid(8), saveTasks = nanoid(8), db = nanoid(8);
  const report = nanoid(8), brief = nanoid(8), file = nanoid(8), memory = nanoid(8), board = nanoid(8), webchat = nanoid(8), telegram = nanoid(8);
  return {
    nodes: [
      n(manual, "manual-trigger", 100, { label: "Manual Test Run" }),
      n(cron, "cron-trigger", 100, { label: "Morning Brief 8 AM", expression: "0 8 * * *", timezone: "UTC" }),
      n(channels, "channel-status", 330, { label: "Check Channels", format: "summary" }),
      n(saveChannels, "set-variables", 560, { label: "Save Channel Status", assignments: [{ key: "channelStatus", value: "{{channel.response}}" }] }),
      n(schedules, "scheduler-job", 790, { label: "List Schedules", action: "list" }),
      n(saveSchedules, "set-variables", 1020, { label: "Save Schedule Status", assignments: [{ key: "scheduleStatus", value: "{{scheduler.response}}" }] }),
      n(tasks, "board-task", 1250, { label: "List Board Tasks", action: "list", boardId: "main-board", limit: 12 }),
      n(saveTasks, "set-variables", 1480, { label: "Save Board Status", assignments: [{ key: "boardStatus", value: "{{board.response}}" }] }),
      n(db, "database-query", 1710, {
        label: "Query Overnight State",
        dbPath: "./data/disp8ch.db",
        query:
          "SELECT " +
          "(SELECT COUNT(*) FROM background_jobs WHERE status = 'running') AS running_background_jobs, " +
          "(SELECT COUNT(*) FROM background_jobs WHERE status = 'failed' AND started_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')) AS failed_background_jobs_24h, " +
          "(SELECT COUNT(*) FROM agent_wakeup_requests WHERE status = 'queued') AS queued_wakeups, " +
          "(SELECT COUNT(*) FROM task_approvals WHERE status = 'pending') AS pending_task_approvals, " +
          "(SELECT COUNT(*) FROM standing_goal_runs WHERE updated_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')) AS standing_goal_runs_24h, " +
          "(SELECT COUNT(*) FROM executions WHERE started_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')) AS workflow_runs_24h;",
      }),
      n(report, "run-code", 1940, {
        label: "Build Morning Evidence Pack",
        timeout: 5000,
        code: [
          "const rows = Array.isArray(input.rows) ? input.rows : [];",
          "const row = rows[0] || {};",
          "const vars = input.vars || {};",
          "const lines = [",
          "  '# Overnight Autonomy Morning Pack',",
          "  '',",
          "  `Generated: ${new Date().toISOString()}`,",
          "  '',",
          "  '## Runtime counts',",
          "  `- Workflow runs in last 24h: ${Number(row.workflow_runs_24h || 0)}`,",
          "  `- Standing-goal runs in last 24h: ${Number(row.standing_goal_runs_24h || 0)}`,",
          "  `- Running background jobs: ${Number(row.running_background_jobs || 0)}`,",
          "  `- Failed background jobs in last 24h: ${Number(row.failed_background_jobs_24h || 0)}`,",
          "  `- Queued wakeups: ${Number(row.queued_wakeups || 0)}`,",
          "  `- Pending task approvals: ${Number(row.pending_task_approvals || 0)}`,",
          "  '',",
          "  '## Channels',",
          "  String(vars.channelStatus || 'See channel-status node output.'),",
          "  '',",
          "  '## Schedules',",
          "  String(vars.scheduleStatus || 'See scheduler node output.'),",
          "  '',",
          "  '## Board tasks',",
          "  String(vars.boardStatus || 'See board-task node output.'),",
          "].join('\\n');",
          "result = { report: lines, response: lines, hasRisk: Number(row.failed_background_jobs_24h || 0) > 0 || Number(row.pending_task_approvals || 0) > 0 || Number(row.queued_wakeups || 0) > 0 };",
        ].join("\n"),
      }),
      n(brief, "claude-agent", 2170, {
        label: "Compose 5-Bullet Brief",
        systemPrompt:
          "You are the overnight autonomy briefer. Turn this evidence pack into a concise morning brief for a non-technical operator.\n\nEvidence pack:\n{{run.result.report}}\n\nRules:\n- Maximum 5 bullets.\n- Include risks, pending approvals, queued wakeups, failed jobs, and next actions if present.\n- Include a cost/usage note if the evidence contains run counts.\n- Do not invent external facts.\n- If there is nothing urgent, say that clearly and keep it short.",
        temperature: 0.2,
        maxTokens: 700,
        enabledTools: ["memory_search"],
        execSecurity: "deny",
        model: "",
      }),
      n(file, "write-file", 2400, { label: "Save Report", path: "./data/workspace/reports/overnight-morning-brief.md", mode: "overwrite", content: "{{run.result.report}}\n\n## Brief\n{{claude-agent.response}}" }),
      n(memory, "memory-store", 2630, { label: "Store Brief Memory", extractMode: "manual", type: "summary", manualContent: "{{claude-agent.response}}" }),
      n(board, "board-task", 2860, { label: "Create Review Task", action: "create", boardId: "main-board", title: "Review overnight autonomy brief", description: "{{claude-agent.response}}", status: "review", priority: "medium" }),
      n(webchat, "send-webchat", 3090, { label: "Send WebChat Brief", message: "{{claude-agent.response}}" }),
      n(telegram, "send-telegram", 3320, { label: "Send Telegram Brief", to: "{{trigger.chatId}}", message: "{{claude-agent.response}}" }),
    ],
    edges: [
      { id: `e-${manual}-${channels}`, source: manual, target: channels },
      { id: `e-${cron}-${channels}`, source: cron, target: channels },
      ...chain([channels, saveChannels, schedules, saveSchedules, tasks, saveTasks, db, report, brief, file, memory, board, webchat, telegram]),
    ],
  };
}

export async function POST(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    initializeDatabase();
    const body = await request.json();
    const parsed = createWorkflowSchema.parse(body);
    // Resolve template aliases (e.g. "ai crew" → "ai-crew-orchestrator")
    const resolvedTemplateKey = parsed.template
      ? (resolveWorkflowTemplateReference(parsed.template)?.key ?? parsed.template)
      : parsed.template;
    const db = getSqlite();
    const id = nanoid(12);
    const now = new Date().toISOString();
    const defaultWorkflowPolicy = JSON.stringify({ approval: { mode: "balanced" } });
    const resolvedOrganization = parsed.organizationId
      ? resolveHierarchyOrganization(parsed.organizationId)
      : null;
    if (parsed.organizationId && !resolvedOrganization) {
      return NextResponse.json(
        { success: false, error: `Organization not found: ${parsed.organizationId}` },
        { status: 404 },
      );
    }
    let organizationId =
      resolvedOrganization?.id ??
      (resolvedTemplateKey === "hierarchy-orchestrator-team" || resolvedTemplateKey === "trading-research-cycle"
        ? getActiveHierarchyOrganization()?.id ?? null
        : null);
    let goalId: string | null = null;
    if (parsed.goalId) {
      const resolvedGoal =
        resolveHierarchyGoal(parsed.goalId, organizationId ?? undefined) ??
        getHierarchyGoalById(parsed.goalId);
      if (!resolvedGoal) {
        return NextResponse.json(
          { success: false, error: `Goal not found: ${parsed.goalId}` },
          { status: 404 },
        );
      }
      if (organizationId && resolvedGoal.organizationId && resolvedGoal.organizationId !== organizationId) {
        return NextResponse.json(
          { success: false, error: "Goal does not belong to the selected organization" },
          { status: 400 },
        );
      }
      goalId = resolvedGoal.id;
      organizationId = resolvedGoal.organizationId ?? organizationId;
    }
    let templateAgentAssignments = normalizeTemplateAgentAssignments(parsed.templateAgents);

    let nodes = parsed.nodes || [];
    let edges = parsed.edges || [];

    // ── Workflow import (compatible JSON or disp8ch) ───────────────────────────
    if (parsed.importSource && parsed.importData) {
      if (isCompatibleImportSource(parsed.importSource)) {
        if (!isCompatibleWorkflow(parsed.importData)) {
          return NextResponse.json({ success: false, error: "Invalid compatible workflow format" }, { status: 400 });
        }
        const result = convertCompatibleWorkflowToDisp8ch(parsed.importData);
        const repaired = repairImportedWorkflow({ nodes: result.nodes, edges: result.edges });
        nodes = repaired.nodes;
        edges = repaired.edges;
        // Return import stats alongside the created workflow data
        const importStats = result.stats;
        const importWarnings = [...result.warnings, ...repaired.repairs.map((repair) => repair.message)];
        const importChecklist = buildCompatibleWorkflowImportChecklist(result);
        db.prepare(
          "INSERT INTO workflows (id, name, description, nodes, edges, organization_id, goal_id, source_type, source_ref, policy, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).run(id, parsed.name, parsed.description || result.description || null, JSON.stringify(nodes), JSON.stringify(edges), organizationId, goalId, "compatible-import", null, defaultWorkflowPolicy, 1, now, now);
        restartWorkflowCrons(id);
        return NextResponse.json({ success: true, data: { id, name: parsed.name, description: parsed.description || result.description || null, nodes, edges, isActive: true, createdAt: now, updatedAt: now, importStats, importWarnings, importRepairs: repaired.repairs, importChecklist, compatibilityReport: result.compatibilityReport } });
      } else if (parsed.importSource === "disp8ch") {
        if (!isDisp8chWorkflow(parsed.importData)) {
          return NextResponse.json({ success: false, error: "Invalid disp8ch workflow format" }, { status: 400 });
        }
        const imp = parsed.importData as { nodes?: unknown[]; edges?: unknown[]; description?: string };
        const repaired = repairImportedWorkflow({ nodes: imp.nodes || [], edges: imp.edges || [] });
        nodes = repaired.nodes as typeof nodes;
        edges = repaired.edges as typeof edges;
        db.prepare(
          "INSERT INTO workflows (id, name, description, nodes, edges, organization_id, goal_id, source_type, source_ref, policy, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).run(id, parsed.name, parsed.description || (imp.description as string | null) || null, JSON.stringify(nodes), JSON.stringify(edges), organizationId, goalId, "disp8ch-import", null, defaultWorkflowPolicy, 1, now, now);
        restartWorkflowCrons(id);
        return NextResponse.json({ success: true, data: { id, name: parsed.name, nodes, edges, isActive: true, createdAt: now, updatedAt: now, importRepairs: repaired.repairs } });
      }
    }

    if (resolvedTemplateKey === "simple-chat") {
      const template = getSimpleChatTemplate();
      nodes = template.nodes;
      edges = template.edges;
    } else if (resolvedTemplateKey === "gmail-drive-bridge") {
      const template = getGmailDriveBridgeTemplate();
      nodes = template.nodes;
      edges = template.edges;
    } else if (resolvedTemplateKey === "pc-specs-tool-use") {
      const template = getPcSpecsToolTemplate();
      nodes = template.nodes;
      edges = template.edges;
    } else if (resolvedTemplateKey === "devops-monitor") {
      const template = getDevopsMonitorTemplate();
      nodes = template.nodes;
      edges = template.edges;
    } else if (resolvedTemplateKey === "smart-command-runner") {
      const template = getSmartCommandRunnerTemplate();
      nodes = template.nodes;
      edges = template.edges;
    } else if (resolvedTemplateKey === "scheduled-health-check") {
      const template = getScheduledHealthCheckTemplate();
      nodes = template.nodes;
      edges = template.edges;
    } else if (resolvedTemplateKey === "google-api-integration") {
      const template = getGoogleApiIntegrationTemplate();
      nodes = template.nodes;
      edges = template.edges;
    } else if (resolvedTemplateKey === "integration-agent-bridge") {
      const template = getIntegrationAgentBridgeTemplate();
      nodes = template.nodes;
      edges = template.edges;
    } else if (resolvedTemplateKey === "code-runner-pipeline") {
      const template = getCodeRunnerPipelineTemplate();
      nodes = template.nodes;
      edges = template.edges;
    } else if (resolvedTemplateKey === "file-processor") {
      const template = getFileProcessorTemplate();
      nodes = template.nodes;
      edges = template.edges;
    } else if (resolvedTemplateKey === "api-monitor") {
      const template = getApiMonitorTemplate();
      nodes = template.nodes;
      edges = template.edges;
    } else if (resolvedTemplateKey === "email-summarizer") {
      const template = getEmailSummarizerTemplate();
      nodes = template.nodes;
      edges = template.edges;
    } else if (resolvedTemplateKey === "daily-email-digest") {
      const template = getDailyEmailDigestTemplate();
      nodes = template.nodes;
      edges = template.edges;
    } else if (resolvedTemplateKey === "hierarchy-orchestrator-team") {
      templateAgentAssignments = resolveDefaultHierarchyTemplateAgents(templateAgentAssignments, organizationId);
      const template = getHierarchyOrchestratorTemplate(templateAgentAssignments);
      nodes = template.nodes;
      edges = template.edges;
    } else if (resolvedTemplateKey === "smart-file-organizer") {
      const template = getSmartFileOrganizerTemplate();
      nodes = template.nodes;
      edges = template.edges;
    } else if (resolvedTemplateKey === "code-reviewer") {
      const template = getCodeReviewerTemplate();
      nodes = template.nodes;
      edges = template.edges;
    } else if (resolvedTemplateKey === "research-assistant") {
      const template = getResearchAssistantTemplate();
      nodes = template.nodes;
      edges = template.edges;
    } else if (resolvedTemplateKey === "local-lead-enrichment") {
      const template = getLocalLeadEnrichmentTemplate();
      nodes = template.nodes;
      edges = template.edges;
    } else if (resolvedTemplateKey === "docs-site-crawler-summary") {
      const template = getDocsSiteCrawlerSummaryTemplate();
      nodes = template.nodes;
      edges = template.edges;
    } else if (resolvedTemplateKey === "document-intelligence") {
      const template = getDocumentIntelligenceTemplate();
      nodes = template.nodes;
      edges = template.edges;
    } else if (resolvedTemplateKey === "general-task-executor") {
      const template = getGeneralTaskExecutorTemplate();
      nodes = template.nodes;
      edges = template.edges;
    } else if (resolvedTemplateKey === "channel-workspace-assistant") {
      const template = getChannelWorkspaceAssistantTemplate();
      nodes = template.nodes;
      edges = template.edges;
    } else if (resolvedTemplateKey === "automated-backup") {
      const template = getAutomatedBackupTemplate();
      nodes = template.nodes;
      edges = template.edges;
    } else if (resolvedTemplateKey === "multi-channel-router") {
      const template = getMultiChannelRouterTemplate();
      nodes = template.nodes;
      edges = template.edges;
    } else if (resolvedTemplateKey === "telegram-board-intake") {
      const template = getTelegramBoardIntakeTemplate();
      nodes = template.nodes;
      edges = template.edges;
    } else if (resolvedTemplateKey === "screenshot-analyzer") {
      const template = getScreenshotAnalyzerTemplate();
      nodes = template.nodes;
      edges = template.edges;
    } else if (resolvedTemplateKey === "git-status-reporter") {
      const template = getGitStatusReporterTemplate();
      nodes = template.nodes;
      edges = template.edges;
    } else if (resolvedTemplateKey === "local-api-tester") {
      const template = getLocalApiTesterTemplate();
      nodes = template.nodes;
      edges = template.edges;
    } else if (resolvedTemplateKey === "clipboard-to-memory") {
      const template = getClipboardToMemoryTemplate();
      nodes = template.nodes;
      edges = template.edges;
    } else if (resolvedTemplateKey === "error-resilient-pipeline") {
      const template = getErrorResilientPipelineTemplate();
      nodes = template.nodes;
      edges = template.edges;
    } else if (resolvedTemplateKey === "text-processing-pipeline") {
      const template = getTextProcessingPipelineTemplate();
      nodes = template.nodes;
      edges = template.edges;
    } else if (resolvedTemplateKey === "db-query-dashboard") {
      const template = getDbQueryDashboardTemplate();
      nodes = template.nodes;
      edges = template.edges;
    } else if (resolvedTemplateKey === "ops-control-tower") {
      const template = getOpsControlTowerTemplate();
      nodes = template.nodes;
      edges = template.edges;
    } else if (resolvedTemplateKey === "hierarchy-board-briefing") {
      const template = getHierarchyBoardBriefingTemplate();
      nodes = template.nodes;
      edges = template.edges;
    } else if (resolvedTemplateKey === "cron-board-task-creator") {
      const template = getCronBoardTaskCreatorTemplate();
      nodes = template.nodes;
      edges = template.edges;
    } else if (resolvedTemplateKey === "autonomous-research-pipeline") {
      const template = getAutonomousResearchPipelineTemplate();
      nodes = template.nodes;
      edges = template.edges;
    } else if (resolvedTemplateKey === "experiment-loop") {
      const template = getExperimentLoopTemplate();
      nodes = template.nodes;
      edges = template.edges;
    } else if (resolvedTemplateKey === "ai-crew-orchestrator") {
      const template = getAiCrewOrchestratorTemplate();
      nodes = template.nodes;
      edges = template.edges;
    } else if (resolvedTemplateKey === "parallel-spawn-crew") {
      const template = getParallelSpawnCrewTemplate();
      nodes = template.nodes;
      edges = template.edges;
    } else if (resolvedTemplateKey === "plan-gated-crew") {
      const template = getPlanGatedCrewTemplate();
      nodes = template.nodes;
      edges = template.edges;
    } else if (resolvedTemplateKey === "strategy-hardening-loop") {
      const template = getStrategyHardeningLoopTemplate();
      nodes = template.nodes;
      edges = template.edges;
    } else if (resolvedTemplateKey === "support-signal-triage") {
      const template = getSupportSignalTriageTemplate();
      nodes = template.nodes;
      edges = template.edges;
    } else if (resolvedTemplateKey === "live-research-assistant") {
      const template = getLiveResearchAssistantTemplate();
      nodes = template.nodes;
      edges = template.edges;
    } else if (resolvedTemplateKey === "subconscious-loop") {
      const template = getSubconsciousLoopTemplate();
      nodes = template.nodes;
      edges = template.edges;
    } else if (resolvedTemplateKey === "short-video-generator") {
      const template = getShortVideoGeneratorTemplate();
      nodes = template.nodes;
      edges = template.edges;
    } else if (resolvedTemplateKey === "trading-research-cycle") {
      templateAgentAssignments = resolveDefaultHierarchyTemplateAgents(templateAgentAssignments, organizationId);
      const template = getTradingResearchCycleTemplate(templateAgentAssignments);
      nodes = template.nodes;
      edges = template.edges;
    } else if (resolvedTemplateKey === "issue-triage-scheduler") {
      const template = getIssueTriageSchedulerTemplate();
      nodes = template.nodes;
      edges = template.edges;
    } else if (resolvedTemplateKey === "pull-request-reviewer") {
      const template = getPullRequestReviewerTemplate();
      nodes = template.nodes;
      edges = template.edges;
    } else if (resolvedTemplateKey === "docs-drift-detector") {
      const template = getDocsDriftDetectorTemplate();
      nodes = template.nodes;
      edges = template.edges;
    } else if (resolvedTemplateKey === "dependency-vulnerability-scanner") {
      const template = getDependencyVulnerabilityScannerTemplate();
      nodes = template.nodes;
      edges = template.edges;
    } else if (resolvedTemplateKey === "deploy-smoke-verifier") {
      const template = getDeploySmokeVerifierTemplate();
      nodes = template.nodes;
      edges = template.edges;
    } else if (resolvedTemplateKey === "incident-alert-correlator") {
      const template = getIncidentAlertCorrelatorTemplate();
      nodes = template.nodes;
      edges = template.edges;
    } else if (resolvedTemplateKey === "endpoint-uptime-watch") {
      const template = getEndpointUptimeWatchTemplate();
      nodes = template.nodes;
      edges = template.edges;
    } else if (resolvedTemplateKey === "competitor-repo-watcher") {
      const template = getCompetitorRepoWatcherTemplate();
      nodes = template.nodes;
      edges = template.edges;
    } else if (resolvedTemplateKey === "weekly-news-digest") {
      const template = getWeeklyNewsDigestTemplate();
      nodes = template.nodes;
      edges = template.edges;
    } else if (resolvedTemplateKey === "research-paper-scanner") {
      const template = getResearchPaperScannerTemplate();
      nodes = template.nodes;
      edges = template.edges;
    } else if (resolvedTemplateKey === "overnight-autonomy-briefing") {
      const template = getOvernightAutonomyBriefingTemplate();
      nodes = template.nodes;
      edges = template.edges;
    }

    if (
      parsed.template &&
      !parsed.nodes &&
      !parsed.edges &&
      nodes.length === 0 &&
      edges.length === 0
    ) {
      return NextResponse.json(
        { success: false, error: `Unknown template: ${parsed.template}` },
        { status: 400 }
      );
    }

    // Normalize workflow before save: infer missing messages, ensure labels/positions
    const normalized = normalizeWorkflowDefinition({
      nodes,
      edges,
      source: parsed.template ? `template:${parsed.template}` : "manual",
      applySafeDefaults: true,
    });
    nodes = normalized.nodes;
    edges = normalized.edges;

    db.prepare(
      "INSERT INTO workflows (id, name, description, nodes, edges, organization_id, goal_id, source_type, source_ref, policy, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      id,
      parsed.name,
      parsed.description || null,
      JSON.stringify(nodes),
      JSON.stringify(edges),
      organizationId,
      goalId,
      parsed.sourceType || null,
      parsed.sourceRef || null,
      defaultWorkflowPolicy,
      1,
      now,
      now,
    );
    restartWorkflowCrons(id);

    return NextResponse.json({
      success: true,
      data: {
        id,
        name: parsed.name,
        description: parsed.description || null,
        organizationId,
        goalId,
        nodes,
        edges,
        sourceType: parsed.sourceType || null,
        sourceRef: parsed.sourceRef || null,
        isActive: true,
        createdAt: now,
        updatedAt: now,
        ...(normalized.warnings.length > 0 ? { normalizationWarnings: normalized.warnings } : {}),
      },
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    initializeDatabase();
    const body = await request.json();
    const { id, ...updates } = body;
    const db = getSqlite();
    const now = new Date().toISOString();

    if (!id) {
      return NextResponse.json({ success: false, error: "Missing workflow id" }, { status: 400 });
    }

    const setClauses: string[] = [];
    const values: unknown[] = [];

    if (updates.name !== undefined) { setClauses.push("name = ?"); values.push(updates.name); }
    if (updates.description !== undefined) { setClauses.push("description = ?"); values.push(updates.description); }
    if (updates.nodes !== undefined) { setClauses.push("nodes = ?"); values.push(JSON.stringify(updates.nodes)); }
    if (updates.edges !== undefined) { setClauses.push("edges = ?"); values.push(JSON.stringify(updates.edges)); }
    if (updates.organizationId !== undefined) { setClauses.push("organization_id = ?"); values.push(updates.organizationId || null); }
    if (updates.goalId !== undefined) { setClauses.push("goal_id = ?"); values.push(updates.goalId || null); }
    if (updates.isActive !== undefined) { setClauses.push("is_active = ?"); values.push(updates.isActive ? 1 : 0); }
    if (updates.concurrency !== undefined) {
      const { normalizeWorkflowConcurrency } = await import("@/lib/engine/execution-queue");
      const normalized = normalizeWorkflowConcurrency(updates.concurrency);
      setClauses.push("concurrency = ?");
      values.push(normalized ? JSON.stringify(normalized) : null);
    }
    if (updates.policy !== undefined) {
      const { normalizeWorkflowPolicy } = await import("@/lib/engine/workflow-policy");
      const normalized = normalizeWorkflowPolicy(updates.policy);
      setClauses.push("policy = ?");
      values.push(normalized ? JSON.stringify(normalized) : null);
    }

    setClauses.push("updated_at = ?");
    values.push(now);
    values.push(id);

    db.prepare(`UPDATE workflows SET ${setClauses.join(", ")} WHERE id = ?`).run(...values);

    // Restart cron jobs for this workflow after save
    restartWorkflowCrons(id);

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    initializeDatabase();
    const { searchParams } = new URL(request.url);
    const all = searchParams.get("all");
    const id = searchParams.get("id");
    const db = getSqlite();

    if (all === "1" || all === "true") {
      const rows = db.prepare("SELECT id FROM workflows").all() as Array<{ id: string }>;
      db.prepare("UPDATE board_tasks SET workflow_id = NULL WHERE workflow_id IS NOT NULL").run();
      db.prepare("DELETE FROM workflows").run();
      for (const row of rows) {
        db.prepare("DELETE FROM tag_links WHERE target_type = 'workflow' AND target_id = ?").run(row.id);
        unscheduleCronWorkflow(row.id);
      }
      return NextResponse.json({ success: true, data: { deleted: rows.length } });
    }

    if (!id) {
      return NextResponse.json({ success: false, error: "Missing id" }, { status: 400 });
    }

    db.prepare("UPDATE board_tasks SET workflow_id = NULL WHERE workflow_id = ?").run(id);
    db.prepare("DELETE FROM workflows WHERE id = ?").run(id);
    db.prepare("DELETE FROM tag_links WHERE target_type = 'workflow' AND target_id = ?").run(id);
    unscheduleCronWorkflow(id);
    return NextResponse.json({ success: true, data: { deleted: 1 } });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
