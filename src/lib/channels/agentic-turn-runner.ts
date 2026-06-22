import type { AgenticMode } from "@/lib/channels/agentic-routing-policy";
import { TOOL_CATALOG, type ToolDefinition } from "@/lib/engine/tools";
import type { ModelLedLane } from "@/lib/channels/model-led-context";
import { buildDesignStudioSystemPromptSuffix } from "@/lib/channels/design-studio-system-prompt";
import { MUTATION_TOOL_NAMES, classifySideEffectPolicy } from "@/lib/channels/side-effect-policy";
import { buildContextualUserMessage, loadRecentWebChatContext } from "@/lib/channels/webchat-context";
import { streamModel } from "@/lib/agents/multi-provider";
import type { ModelProvider } from "@/types/model";

export type AgenticTurnResult = {
  answer: string;
  toolsUsed: string[];
  tokensUsed: number;
  repairAttempts: number;
  metadata: Record<string, unknown>;
};

type EmitFn = (event: string, data: unknown) => void;

const MODE_CONFIGS: Record<AgenticMode, {
  maxToolCalls: number;
  maxTokens: number;
  turnDeadlineMs: number;
  systemPromptSuffix: string;
} | null> = {
  none: null,
  web_research: {
    maxToolCalls: 36,
    maxTokens: 6000,
    turnDeadlineMs: 300_000,
    systemPromptSuffix: "Tool hint: current public facts may need web_search, web_extract, fetch_url, or browser text. Prefer primary sources when they materially affect correctness.",
  },
  repo_inspection: {
    maxToolCalls: 48,
    maxTokens: 7000,
    turnDeadlineMs: 300_000,
    systemPromptSuffix: "Tool hint: repository facts should come from search_files/read_file/list_files. Cite file paths and line numbers when useful.",
  },
  code_edit: {
    maxToolCalls: 14,
    maxTokens: 4000,
    turnDeadlineMs: 150_000,
    systemPromptSuffix: [
      "Tool hint: the user requested a code edit or patch. Read only the directly relevant files first, keep edits scoped, and avoid broad repo audits unless the first evidence shows they are necessary.",
      "For implementation tasks, verify behavior with focused checks before finalizing when shell is available.",
      "Derive edge cases from the user's stated rules, especially overlap/conflict cases where two rules could both apply.",
      "For string normalization, parsing, validation, or formatting tasks, include at least one verification case that changes the casing/shape of exception terms and proves the intended rule precedence.",
      "Prefer inline/non-persistent verification commands over creating temporary helper files. If you create any helper/test file, include it in the changed-files summary or remove it before finalizing.",
      "Do not claim verification passed unless the command output proves it. If verification failed or was not run, say that plainly and explain the remaining risk.",
    ].join("\n"),
  },
  capability_audit: {
    maxToolCalls: 36,
    maxTokens: 6000,
    turnDeadlineMs: 300_000,
    systemPromptSuffix: "Tool hint: app/system status claims should be verified from current repo, channel_status runtime readiness, or configuration evidence. Use channel_status before claiming configured/callable now. Do not infer configured/callable status from implementation alone.",
  },
  app_design: {
    maxToolCalls: 40,
    maxTokens: 7000,
    turnDeadlineMs: 300_000,
    systemPromptSuffix: "Tool hint: app/workflow designs should use available app primitives, node contracts, templates, and safety boundaries when those tools are available.",
  },
  design_studio: {
    maxToolCalls: 40,
    maxTokens: 7000,
    turnDeadlineMs: 360_000,
    systemPromptSuffix: buildDesignStudioSystemPromptSuffix(),
  },
  mixed: {
    maxToolCalls: 44,
    maxTokens: 7000,
    turnDeadlineMs: 300_000,
    systemPromptSuffix: "Tool hint: mixed tasks may need repo, web, runtime, or app tools. Choose the evidence source that best resolves each claim.",
  },
};

function getToolsForMode(mode: AgenticMode): ToolDefinition[] {
  const searchFiles: ToolDefinition = {
    name: "search_files",
    description: "Search file contents using regex. Returns matching lines with file paths and line numbers.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex pattern to search for" },
        path: { type: "string", description: "Directory to search in (default: src)" },
        maxResults: { type: "string", description: "Maximum results (default: 30)" },
      },
      required: ["pattern"],
    },
  };

  const readFile: ToolDefinition = {
    name: "read_file",
    description: "Read a file's contents with line numbers. Use after search_files to read full context.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to project root" },
        startLine: { type: "string", description: "Start line (1-indexed, optional)" },
        endLine: { type: "string", description: "End line (1-indexed, optional)" },
      },
      required: ["path"],
    },
  };

  const listFiles: ToolDefinition = {
    name: "list_files",
    description: "List files in a directory.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path" },
        recursive: { type: "string", description: "true/false" },
      },
      required: ["path"],
    },
  };

  const writeFile: ToolDefinition = {
    name: "write_file",
    description: "Create or edit a file in the selected workspace. Use mode 'patch' for targeted search-and-replace edits; use 'overwrite' for small files you fully control; use 'append' only when adding content.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to write, relative to the selected workspace when possible." },
        content: { type: "string", description: "Content to write for overwrite/append modes." },
        mode: { type: "string", enum: ["overwrite", "append", "patch"], description: "Write mode. Defaults to overwrite." },
        search: { type: "string", description: "Patch mode only: exact block to replace." },
        replace: { type: "string", description: "Patch mode only: replacement block." },
      },
      required: ["path"],
    },
  };

  const bashExec: ToolDefinition = {
    name: "bash_exec",
    description: "Run a short, non-interactive verification command inside the selected workspace. Use only after editing, for focused checks such as typecheck/test commands or a tiny script that exercises the changed function.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Command to execute. On Windows this runs through cmd; keep it non-interactive and scoped to verification." },
        working_dir: { type: "string", description: "Optional working directory relative to the selected workspace. Defaults to the selected workspace." },
        timeout_ms: { type: "number", description: "Timeout in milliseconds, max 60000." },
      },
      required: ["command"],
    },
  };

  const webSearch: ToolDefinition = {
    name: "web_search",
    description: "Search the web for current information. Returns search results with URLs and snippets.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        max_results: { type: "number", description: "Max results (default: 5, max 10)" },
      },
      required: ["query"],
    },
  };

  const webExtract: ToolDefinition = {
    name: "web_extract",
    description: "Fetch and extract readable content from one or more URLs. Use this after web_search before citing claims.",
    parameters: {
      type: "object",
      properties: {
        urls: {
          type: "array",
          description: "Array of URLs to extract. Max 5 per call.",
        },
        max_chars_per_url: { type: "number", description: "Maximum characters per URL. Default 5000." },
        format: { type: "string", enum: ["text", "markdown", "json"], description: "Output format." },
      },
      required: ["urls"],
    },
  };

  const channelStatus: ToolDefinition = {
    name: "channel_status",
    description: "Read current channel/model/voice/media readiness without exposing secret values. Use before claiming a capability is configured or callable now.",
    parameters: { type: "object", properties: {}, required: [] },
  };

  const workflowTemplates: ToolDefinition = {
    name: "workflow_templates",
    description: "List built-in workflow templates for app/workflow design.",
    parameters: { type: "object", properties: {}, required: [] },
  };

  const workflowList: ToolDefinition = {
    name: "workflow_list",
    description: "List existing workflows with IDs, names, active state, and node counts.",
    parameters: { type: "object", properties: {}, required: [] },
  };

  const workflowGet: ToolDefinition = {
    name: "workflow_get",
    description: "Read a workflow's full JSON configuration by workflow id.",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "Workflow ID from workflow_list." } },
      required: ["id"],
    },
  };

  const schedulesList: ToolDefinition = {
    name: "schedules_list",
    description: "List scheduled workflows/jobs from the Automations tab. Safe and read-only.",
    parameters: { type: "object", properties: {}, required: [] },
  };

  const webhooksList: ToolDefinition = {
    name: "webhooks_list",
    description: "List webhook automations: name, URL, linked workflow, active status, last delivery. Never exposes secrets. Safe and read-only.",
    parameters: { type: "object", properties: {}, required: [] },
  };

  const workflowNodeCatalog: ToolDefinition = {
    name: "workflow_node_catalog",
    description: "Returns the complete catalog of available workflow node types with categories, config fields, and common patterns. Use for workflow design to get exact node types.",
    parameters: {
      type: "object",
      properties: {
        category: { type: "string", description: "Optional filter: 'trigger', 'action', 'transform', 'condition', 'llm', 'app_tool', 'terminal', 'all' (default: all)" },
      },
      required: [],
    },
  };

  const fetchUrl: ToolDefinition = {
    name: "fetch_url",
    description: "Fetch content from a URL. Use as fallback when web_extract fails.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to fetch" },
      },
      required: ["url"],
    },
  };

  const browserGetText: ToolDefinition = {
    name: "browser_get_text",
    description: "Get text content from the current browser page. Use as last resort when other fetch methods fail.",
    parameters: { type: "object", properties: {}, required: [] },
  };

  const browserNavigate: ToolDefinition = {
    name: "browser_navigate",
    description: "Navigate browser to a URL. Use before browser_get_text for pages that need JavaScript rendering.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to navigate to" },
      },
      required: ["url"],
    },
  };

  const designProjectList: ToolDefinition = {
    name: "design_project_list",
    description: "List Design Studio projects with artifact counts.",
    parameters: { type: "object", properties: {}, required: [] },
  };
  const designProjectCreate: ToolDefinition = {
    name: "design_project_create",
    description: "Create a Design Studio project.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Project name" },
        description: { type: "string", description: "Optional project description" },
      },
      required: ["name"],
    },
  };
  const designArtifactList: ToolDefinition = {
    name: "design_artifact_list",
    description: "List artifacts for a Design Studio project.",
    parameters: {
      type: "object",
      properties: { project_id: { type: "string", description: "Design project id" } },
      required: ["project_id"],
    },
  };
  const designArtifactRead: ToolDefinition = {
    name: "design_artifact_read",
    description: "Read current source and validation for a Design Studio artifact.",
    parameters: {
      type: "object",
      properties: {
        artifact_id: { type: "string", description: "Design artifact id" },
        max_chars: { type: "number", description: "Maximum source chars" },
      },
      required: ["artifact_id"],
    },
  };
  const designArtifactCreate: ToolDefinition = {
    name: "design_artifact_create",
    description: "Create a complete versioned HTML artifact in Design Studio.",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Existing project id" },
        project_name: { type: "string", description: "Project name to create when project_id is omitted" },
        title: { type: "string", description: "Artifact title" },
        html: { type: "string", description: "Complete standalone HTML" },
        summary: { type: "string", description: "Short version summary" },
      },
      required: ["title", "html"],
    },
  };
  const designArtifactUpdate: ToolDefinition = {
    name: "design_artifact_update",
    description: "Save a new immutable version for a Design Studio artifact.",
    parameters: {
      type: "object",
      properties: {
        artifact_id: { type: "string", description: "Design artifact id" },
        html: { type: "string", description: "Complete updated standalone HTML" },
        summary: { type: "string", description: "Short change summary" },
      },
      required: ["artifact_id", "html"],
    },
  };
  const designArtifactVersions: ToolDefinition = {
    name: "design_artifact_versions",
    description: "List version history for a Design Studio artifact.",
    parameters: {
      type: "object",
      properties: { artifact_id: { type: "string", description: "Design artifact id" } },
      required: ["artifact_id"],
    },
  };
  const designArtifactPatch: ToolDefinition = {
    name: "design_artifact_patch",
    description: "Apply a structured patch to a Design Studio artifact and save a new version. Prefer this for small scoped edits.",
    parameters: {
      type: "object",
      properties: {
        artifact_id: { type: "string", description: "Design artifact id" },
        patch_json: { type: "string", description: "JSON patch object" },
        summary: { type: "string", description: "Short patch summary" },
      },
      required: ["artifact_id", "patch_json"],
    },
  };
  const designArtifactPreviewCheck: ToolDefinition = {
    name: "design_artifact_preview_check",
    description: "Run preview/quality checks for a Design Studio artifact.",
    parameters: {
      type: "object",
      properties: {
        artifact_id: { type: "string", description: "Design artifact id" },
        visual: { type: "boolean", description: "Run Playwright visual screenshot checks; use only when budget allows." },
      },
      required: ["artifact_id"],
    },
  };
  const designRecipeList: ToolDefinition = {
    name: "design_recipe_list",
    description: "List compact Design Studio recipes for landing pages, dashboards, posters, decks, and admin tools.",
    parameters: { type: "object", properties: {}, required: [] },
  };
  const designSystemList: ToolDefinition = {
    name: "design_system_list",
    description: "List imported Design Studio design systems.",
    parameters: { type: "object", properties: {}, required: [] },
  };
  const designSystemRead: ToolDefinition = {
    name: "design_system_read",
    description: "Read a compact normalized Design Studio design system package.",
    parameters: {
      type: "object",
      properties: { system_id: { type: "string", description: "Design system id" } },
      required: ["system_id"],
    },
  };
  const designArtifactExport: ToolDefinition = {
    name: "design_artifact_export",
    description: "Prepare a Design Studio export URL for html, zip, summary, png, or pdf.",
    parameters: {
      type: "object",
      properties: {
        artifact_id: { type: "string", description: "Design artifact id" },
        format: { type: "string", description: "html, zip, summary, png, or pdf" },
      },
      required: ["artifact_id", "format"],
    },
  };
  const designArtifactRollback: ToolDefinition = {
    name: "design_artifact_rollback",
    description: "Create a new version by rolling a Design Studio artifact back to an older version.",
    parameters: {
      type: "object",
      properties: {
        artifact_id: { type: "string", description: "Design artifact id" },
        version_number: { type: "number", description: "Version number to restore" },
      },
      required: ["artifact_id", "version_number"],
    },
  };
  const designTools = [
    designProjectList,
    designProjectCreate,
    designArtifactList,
    designArtifactRead,
    designArtifactCreate,
    designArtifactUpdate,
    designArtifactVersions,
    designArtifactPatch,
    designArtifactPreviewCheck,
    designRecipeList,
    designSystemList,
    designSystemRead,
    designArtifactExport,
    designArtifactRollback,
  ];
  const designReadTools = [
    designProjectList,
    designArtifactList,
    designArtifactRead,
    designArtifactVersions,
    designRecipeList,
    designSystemList,
    designSystemRead,
    designArtifactExport,
  ];

  switch (mode) {
    case "repo_inspection":
      return [searchFiles, readFile, listFiles];
    case "code_edit":
      return [searchFiles, readFile, listFiles, writeFile, bashExec];
    case "capability_audit":
      return [channelStatus, searchFiles, readFile, listFiles];
    case "web_research":
      return [webSearch, webExtract, fetchUrl, browserNavigate, browserGetText, searchFiles, readFile, listFiles];
    case "app_design":
      return [channelStatus, workflowNodeCatalog, workflowTemplates, workflowList, workflowGet, schedulesList, webhooksList, searchFiles, readFile, listFiles, webSearch, webExtract];
    case "design_studio":
      return designTools;
    case "mixed":
      return [
        channelStatus,
        workflowNodeCatalog,
        workflowTemplates,
        workflowList,
        workflowGet,
        schedulesList,
        webhooksList,
        searchFiles,
        readFile,
        listFiles,
        webSearch,
        webExtract,
        fetchUrl,
        browserNavigate,
        browserGetText,
        ...designReadTools,
      ];
    default:
      return [searchFiles, readFile, listFiles];
  }
}

function laneForMode(mode: AgenticMode): ModelLedLane {
  switch (mode) {
    case "web_research":
    case "mixed":
      return "broad_research";
    case "repo_inspection":
    case "code_edit":
    case "capability_audit":
      return "repo_inspection";
    case "app_design":
    case "design_studio":
      return "app_design";
    default:
      return "read_only_workspace";
  }
}

function requiresToolEvidence(mode: AgenticMode): boolean {
  return mode === "web_research" ||
    mode === "repo_inspection" ||
    mode === "code_edit" ||
    mode === "capability_audit" ||
    mode === "design_studio" ||
    mode === "app_design" ||
    mode === "mixed";
}

function allowsFileMutation(mode: AgenticMode): boolean {
  return mode === "code_edit" || mode === "design_studio";
}

function isProposalOnlyBoundary(taskHints?: Record<string, unknown>): boolean {
  return taskHints?.safetyBoundary === "proposal_only";
}

function isConfirmedAppMutationBoundary(taskHints?: Record<string, unknown>): boolean {
  return taskHints?.safetyBoundary === "confirmed_mutation";
}

function isExplicitAsyncDelegationRequest(message: string): boolean {
  const text = String(message || "");
  const namesDelegationTool = /\bsessions_spawn\b/i.test(text);
  const asksForBackgroundAgent =
    /\b(?:async|background|non[-\s]?blocking)\b/i.test(text) &&
    /\b(?:delegate|delegation|sub-?agent|spawn|worker|coding agent|codex|claude code|gemini cli)\b/i.test(text);
  const directAction =
    /\b(?:use|run|invoke|call|spawn|delegate|dispatch|test)\b/i.test(text) &&
    /\b(?:background=true|notify_on_complete|delegation id|delegation handle|sub-?agent|coding agent)\b/i.test(text);
  return namesDelegationTool || asksForBackgroundAgent || directAction;
}

export function shouldUseConversationContinuationFastPath(params: {
  message: string;
  hasConversationContext: boolean;
  toolPolicy?: "forbidden" | "optional" | "required";
  taskHints?: Record<string, unknown>;
}): boolean {
  if (!params.hasConversationContext || params.toolPolicy === "required") return false;
  const text = String(params.message || "").trim();
  if (!text) return false;

  const requestsConversationTransformation =
    /\b(?:summari[sz]e|condense|rewrite|rephrase|shorten|expand|organize|format|turn|convert)\b/i.test(text) ||
    /\b(?:produce|give|make|create)\b.{0,50}\b(?:summary|table|checklist|outline|recommendation|answer|response|version)\b/i.test(text) ||
    /\bcontinue\b.{0,60}\b(?:previous|prior|answer|response|discussion|table|summary|checklist)\b/i.test(text);
  if (!requestsConversationTransformation) return false;

  const requestsFreshActionOrEvidence =
    /\b(?:inspect|investigate|verify|re-?verify|check\s+(?:the\s+)?(?:repo|repository|code|files?|implementation|current|latest)|search|browse|look\s+up|research|benchmark|measure|profile)\b/i.test(text) ||
    /\b(?:implement|fix|patch|edit|modify|update|add|remove|delete|deploy|publish|commit|push|execute|launch|restart)\b/i.test(text) ||
    /\binstall\b(?!\s+tests?\b)/i.test(text) ||
    /\b(?:run|rerun|re-run)\b.{0,30}\b(?:test|command|script|app|server|benchmark|comparison)\b/i.test(text) ||
    /\b(?:current|latest|live|up[- ]to[- ]date)\b.{0,40}\b(?:state|status|data|result|documentation|docs|version|release|web|repo|repository)\b/i.test(text);
  if (requestsFreshActionOrEvidence) return false;

  return true;
}

function withoutMutationTools(tools: ToolDefinition[]): { tools: ToolDefinition[]; withheldTools: string[] } {
  const withheldTools: string[] = [];
  const filtered = tools.filter((tool) => {
    if (!MUTATION_TOOL_NAMES.has(tool.name)) return true;
    withheldTools.push(tool.name);
    return false;
  });
  return { tools: filtered, withheldTools };
}

function isAutomationOperationMessage(message: string): boolean {
  return (
    /\b(?:webhook|webhooks|cron|schedule|schedules|scheduled|scheduler|automation|automations)\b/i.test(message) &&
    /\b(?:list|show|current|existing|status|active|enabled|configured|live|inventory|state|overview|sign|signature|hmac|curl|create|add|configure|set\s+up|rotate|regenerate|reset|toggle|enable|disable|delete|remove)\b/i.test(message)
  );
}

function withAppMutationTools(baseTools: ToolDefinition[]): ToolDefinition[] {
  const names = [
    "workflow_templates",
    "workflow_create",
    "workflow_list",
    "workflow_get",
    "workflow_run",
    "workflow_execution_status",
    "workflow_toggle_active",
    "workflow_duplicate",
    "workflow_update_node",
    "workflow_set_model",
    "workflow_create_credential",
    "workflow_attach_credential",
    "workflow_update_schedule",
    "workflow_delete",
    "schedules_list",
    "webhooks_list",
    "webhooks_create",
    "webhooks_rotate_secret",
    "webhooks_toggle",
    "webhooks_delete",
    "board_tasks",
    "governance_queue",
  ];
  const byName = new Map(baseTools.map((tool) => [tool.name, tool]));
  for (const name of names) {
    const tool = TOOL_CATALOG[name];
    if (tool) byName.set(name, tool);
  }
  return Array.from(byName.values());
}

function withAutomationTools(baseTools: ToolDefinition[], includeMutationTools: boolean): ToolDefinition[] {
  const preservedLocalTools = new Set(["channel_status", "workflow_node_catalog"]);
  const byName = new Map(
    baseTools
      .filter((tool) => preservedLocalTools.has(tool.name))
      .map((tool) => [tool.name, tool]),
  );
  const names = [
    "workflow_templates",
    "workflow_create",
    "workflow_list",
    "workflow_get",
    "workflow_execution_status",
    "workflow_update_schedule",
    "schedules_list",
    "webhooks_list",
    ...(includeMutationTools ? [
      "webhooks_create",
      "webhooks_rotate_secret",
      "webhooks_toggle",
      "webhooks_delete",
    ] : []),
  ];
  for (const name of names) {
    const tool = TOOL_CATALOG[name];
    if (tool) byName.set(name, tool);
  }
  return Array.from(byName.values());
}

function withAsyncDelegationTools(baseTools: ToolDefinition[]): ToolDefinition[] {
  const byName = new Map(baseTools.map((tool) => [tool.name, tool]));
  const spawnTool = TOOL_CATALOG.sessions_spawn;
  if (spawnTool) byName.set("sessions_spawn", spawnTool);
  return Array.from(byName.values());
}

function parseAsyncDelegationDispatch(output: string): {
  status?: string;
  delegation_id?: string;
  backgroundJobId?: string;
  agent?: string;
  mode?: string;
  notify_on_complete?: boolean;
  async_delegation_running?: number;
  async_delegation_max_concurrent?: number;
  note?: string;
} | null {
  try {
    const parsed = JSON.parse(String(output || "")) as Record<string, unknown>;
    if (parsed.status === "dispatched" && typeof parsed.delegation_id === "string") {
      return parsed as ReturnType<typeof parseAsyncDelegationDispatch>;
    }
  } catch {
    // Non-JSON tool result.
  }
  return null;
}

function extractKeyValue(text: string, key: string): string | null {
  const match = text.match(new RegExp(`\\b${key}\\s*=\\s*([^,\\n]+)`, "i"));
  const raw = match?.[1]?.trim();
  if (!raw) return null;
  const quoted = /^["']/.test(raw);
  const value = raw.replace(/^["']|["']$/g, "");
  return (quoted ? value : value.replace(/[.;]+$/, "")) || null;
}

function parseStructuredAsyncDelegationRequest(message: string, workspacePath?: string | null): Record<string, unknown> | null {
  const text = String(message || "");
  if (!/\bsessions_spawn\b/i.test(text)) return null;

  const taskMatch =
    text.match(/\bTask\s+for\s+the\s+background\s+agent\s*:\s*([\s\S]+?)(?:\n(?:Your immediate answer|If you cannot|$)|$)/i) ||
    text.match(/\btask\s*=\s*([\s\S]+?)(?:\n|$)/i);
  const task = taskMatch?.[1]?.trim();
  if (!task) return null;

  const agent = extractKeyValue(text, "agent") || "current";
  const mode = extractKeyValue(text, "mode") || "run";
  const permissionMode = extractKeyValue(text, "permission_mode") || "deny-all";
  const cwd = extractKeyValue(text, "cwd") || workspacePath || undefined;
  const notify = !/\bnotify_on_complete\s*=\s*false\b/i.test(text);
  const background = !/\bbackground\s*=\s*false\b/i.test(text);
  if (!background) return null;

  const timeoutSeconds = extractKeyValue(text, "timeout_seconds");
  const model = extractKeyValue(text, "model");
  const label = task.slice(0, 50);

  return {
    agent,
    mode,
    background: true,
    notify_on_complete: notify,
    permission_mode: permissionMode,
    cwd,
    task,
    label,
    ...(timeoutSeconds ? { timeout_seconds: Number(timeoutSeconds) } : {}),
    ...(model ? { model } : {}),
  };
}

async function buildAsyncDelegationStatusAnswer(dispatch: NonNullable<ReturnType<typeof parseAsyncDelegationDispatch>>): Promise<string> {
  let status = "running";
  let completedAt = "";
  let result = "";
  const jobId = dispatch.backgroundJobId || dispatch.delegation_id || "";
  if (jobId) {
    try {
      const { getBackgroundJob } = await import("@/lib/runtime/background-jobs");
      const job = getBackgroundJob(jobId);
      if (job) {
        status = job.status;
        completedAt = job.completedAt || "";
        if (job.stdout.trim()) result = job.stdout.trim();
      }
    } catch {
      // Best-effort status enrichment only.
    }
  }
  return [
    status === "completed" ? "Async delegation completed." : "Async delegation dispatched.",
    `- Delegation ID: ${jobId || dispatch.delegation_id}`,
    `- Agent: ${dispatch.agent || "coding-agent"}`,
    `- Mode: ${dispatch.mode || "background"}`,
    `- Status: ${status}`,
    typeof dispatch.async_delegation_running === "number" && typeof dispatch.async_delegation_max_concurrent === "number"
      ? `- Capacity: ${dispatch.async_delegation_running}/${dispatch.async_delegation_max_concurrent} running at dispatch`
      : "",
    completedAt ? `- Completed: ${completedAt}` : "",
    result ? `\nResult:\n${result}` : "",
    dispatch.notify_on_complete !== false
      ? "\nThe full result is also recorded back into this WebChat/session when the background job finishes."
      : "",
  ].filter(Boolean).join("\n");
}

/**
 * Run an agentic turn: the model decides tool strategy, gathers evidence,
 * and answers with citations. Evidence plan, coverage verification, and
 * continuation loop ensure completeness before finalizing.
 */
export async function runAgenticTurn(params: {
  message: string;
  sessionId: string;
  agentId: string;
  provider: string;
  modelId: string;
  apiKey: string;
  baseUrl?: string;
  mode: AgenticMode;
  toolPolicy?: "forbidden" | "optional" | "required";
  taskHints?: Record<string, unknown>;
  workspacePath?: string | null;
  onToken?: EmitFn;
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  onToolResult?: (name: string, ok: boolean, output: string) => void;
}): Promise<AgenticTurnResult> {
  const config = MODE_CONFIGS[params.mode];
  if (!config) {
    return {
      answer: "",
      toolsUsed: [],
      tokensUsed: 0,
      repairAttempts: 0,
      metadata: { error: "Invalid agentic mode" },
    };
  }

  const sideEffectPolicy = classifySideEffectPolicy(params.message);
  const selectedToolMode = typeof params.taskHints?.selectedToolMode === "string"
    ? String(params.taskHints.selectedToolMode)
    : "default";
  const explicitAsyncDelegation = isExplicitAsyncDelegationRequest(params.message);
  const asyncDelegationAllowed =
    explicitAsyncDelegation &&
    selectedToolMode !== "restricted" &&
    params.toolPolicy !== "forbidden";

  const directAsyncArgs = asyncDelegationAllowed
    ? parseStructuredAsyncDelegationRequest(params.message, params.workspacePath)
    : null;
  if (directAsyncArgs) {
    const { executeTool } = await import("@/lib/engine/tools");
    params.onToolCall?.("sessions_spawn", directAsyncArgs);
    const output = await executeTool(
      "sessions_spawn",
      directAsyncArgs,
      {
        channelSessionId: params.sessionId,
        agentId: params.agentId,
        workspacePath: params.workspacePath ?? undefined,
        readOnly: false,
        modelProvider: params.provider,
        modelId: params.modelId,
        modelApiKey: params.apiKey,
        modelBaseUrl: params.baseUrl,
      },
      { approvalMode: "off", execSecurity: "full", execAsk: "off" },
    );
    const dispatch = parseAsyncDelegationDispatch(output);
    params.onToolResult?.("sessions_spawn", Boolean(dispatch), output);
    return {
      answer: dispatch
        ? await buildAsyncDelegationStatusAnswer(dispatch)
        : `Async delegation failed.\n\n${output}`,
      toolsUsed: ["sessions_spawn"],
      tokensUsed: 0,
      repairAttempts: 0,
      metadata: {
        explicitAsyncDelegation,
        asyncDelegationAllowed,
        asyncDelegationFastPath: true,
      },
    };
  }

  const proposalOnly = (isProposalOnlyBoundary(params.taskHints) || sideEffectPolicy.mode === "plan_only") && !asyncDelegationAllowed;
  const confirmedAppMutation = isConfirmedAppMutationBoundary(params.taskHints) && params.mode === "app_design" && !proposalOnly;
  const automationOperation = params.mode === "app_design" && isAutomationOperationMessage(params.message);
  const baseTools = getToolsForMode(params.mode);
  const baseCandidateTools = automationOperation
    ? withAutomationTools(baseTools, confirmedAppMutation)
    : confirmedAppMutation
      ? withAppMutationTools(baseTools)
      : baseTools;
  const candidateTools = asyncDelegationAllowed ? withAsyncDelegationTools(baseCandidateTools) : baseCandidateTools;
  const filtered = proposalOnly ? withoutMutationTools(candidateTools) : { tools: candidateTools, withheldTools: [] };
  const toolsForbidden = params.toolPolicy === "forbidden";
  const tools = toolsForbidden ? [] : filtered.tools;
  const planOnlySystemNote = filtered.withheldTools.length > 0
    ? "\n\nNote: I treated this as a plan-only request and made no app changes."
    : "";
  const modelLedLane: ModelLedLane = confirmedAppMutation ? "app_mutation_proposal" : laneForMode(params.mode);
  const requireToolUse = !toolsForbidden && requiresToolEvidence(params.mode);
  const allowFileWrites = allowsFileMutation(params.mode) && !proposalOnly;
  const readOnly = !(allowFileWrites || confirmedAppMutation || asyncDelegationAllowed);
  const { runUniversalAgenticRuntime } = await import("@/lib/channels/universal-agentic-runtime");
  const runtimeGroundingHint = [
    `Runtime model in use for this turn: ${params.provider}:${params.modelId}.`,
    "When discussing current or effective model/profile setup, use this runtime value unless a tool result proves a different agent/session override.",
    "Do not use Claude, GPT, Gemini, or local model names as current configuration examples unless verified by runtime/config evidence; label unverified model names as examples.",
    asyncDelegationAllowed
      ? "Async delegation boundary: the user explicitly requested background delegation. You may use sessions_spawn once with background=true. Prefer read-only child permissions such as permission_mode=deny-all unless the user clearly asked the child to edit."
      : "",
    proposalOnly
      ? "Side-effect boundary: plan-only. Do not create, save, schedule, send, publish, or mutate app state. If relevant, state that no changes were made."
      : "Side-effect boundary: mutation tools are available only when exposed and appropriate for the user's explicit request.",
    toolsForbidden
      ? "Tool boundary: the user requested a response-only turn. Do not inspect files, call tools, or gather new evidence; use only the prompt and conversation history."
      : "Tool boundary: use available tools only when they materially improve the requested answer.",
  ].join("\n");
  const recentConversation = loadRecentWebChatContext({
    sessionId: params.sessionId,
    limitMessages: 10,
    maxChars: 12_000,
    currentMessage: params.message,
  });
  const conversationContext = recentConversation.length > 0
    ? buildContextualUserMessage({
        recent: recentConversation,
        currentMessage: params.message,
        instructions: [
          "Treat the final untagged text as the current request and the tagged messages as conversation context.",
          "Preserve constraints and evidence established in prior turns unless the current request explicitly changes them.",
          "Do not claim prior assistant statements are newly verified; use them for continuity and call tools when current verification is required.",
        ],
      })
    : undefined;

  const continuationFastPath = shouldUseConversationContinuationFastPath({
    message: params.message,
    hasConversationContext: Boolean(conversationContext),
    toolPolicy: params.toolPolicy,
    taskHints: params.taskHints,
  });
  if (continuationFastPath && conversationContext) {
    const result = await streamModel(
      {
        provider: params.provider as ModelProvider,
        modelId: params.modelId,
        apiKey: params.apiKey,
        baseUrl: params.baseUrl,
        systemPrompt: [
          "You are continuing an existing conversation.",
          "Answer the current request directly from the supplied recent conversation.",
          "Preserve established constraints and distinctions.",
          "Treat user-provided assumptions as assumptions, not as newly verified facts.",
          "Do not imply that prior claims were newly inspected or verified in this turn.",
          "Do not invent URLs, commands, installer formats, provider requirements, or product behavior that the conversation did not establish.",
          "Include every output section or format explicitly requested by the current message.",
          "When the current request says to preserve named constraints, restate every listed constraint explicitly using the same terms.",
          "Omit inherited operational details that are not necessary for the current output; label any retained prior-turn detail as a prior claim unless the user supplied it.",
          "Repeat named unknowns and evidence constraints when they affect the requested result.",
          "Do not call tools or introduce unrelated research.",
          "Be concise unless the requested output requires detail.",
        ].join("\n"),
        userMessage: conversationContext,
        maxTokens: Math.min(config.maxTokens, 4000),
        temperature: 0.2,
      },
      (token) => params.onToken?.("stream:token", { token }),
    );
    return {
      answer: result.response,
      toolsUsed: [],
      tokensUsed: result.tokensUsed,
      repairAttempts: 0,
      metadata: {
        continuationFastPath: true,
        provider: result.provider ?? params.provider,
        modelId: result.modelId ?? params.modelId,
        routeLabel: result.routeLabel ?? null,
      },
    };
  }

  const asyncDelegationDispatches: NonNullable<ReturnType<typeof parseAsyncDelegationDispatch>>[] = [];
  const universalResult = await runUniversalAgenticRuntime({
    message: params.message,
    conversationContext,
    sessionId: params.sessionId,
    agentId: params.agentId,
    provider: params.provider,
    modelId: params.modelId,
    apiKey: params.apiKey,
    baseUrl: params.baseUrl,
    workspacePath: params.workspacePath,
    safety: {
      readOnly,
      allowFileWrites,
      allowShell: params.mode === "code_edit" && !proposalOnly,
      allowNetwork: !toolsForbidden && (params.mode === "web_research" || params.mode === "app_design" || params.mode === "mixed"),
      requiresConfirmationForSideEffects: !asyncDelegationAllowed && (proposalOnly || (!confirmedAppMutation && params.mode !== "code_edit" && params.mode !== "design_studio")),
      workspacePath: params.workspacePath ?? undefined,
    },
    taskHints: {
      ...(params.taskHints ?? {}),
      originalMode: params.mode,
      modelLedLane,
      sideEffectPolicy: sideEffectPolicy.mode,
      sideEffectPolicyReason: sideEffectPolicy.reason,
      withheldTools: filtered.withheldTools,
      explicitAsyncDelegation,
      asyncDelegationAllowed,
      toolPolicy: params.toolPolicy ?? "optional",
    },
    modeSystemHint: `${config.systemPromptSuffix}\n${runtimeGroundingHint}${planOnlySystemNote}`,
    tools,
    modelLedLane,
    requireToolUse,
    deadlineMs: config.turnDeadlineMs,
    maxToolCalls: config.maxToolCalls,
    maxTokens: config.maxTokens,
    onToken: params.onToken,
    onToolCall: params.onToolCall,
    onToolResult: (name, ok, output) => {
      if (name === "sessions_spawn" && ok) {
        const dispatch = parseAsyncDelegationDispatch(output);
        if (dispatch) asyncDelegationDispatches.push(dispatch);
      }
      params.onToolResult?.(name, ok, output);
    },
  });

  let answer = universalResult.answer;
  if (asyncDelegationAllowed && asyncDelegationDispatches.length > 0) {
    const latest = asyncDelegationDispatches[asyncDelegationDispatches.length - 1];
    const modelContradictedDispatch =
      /\b(?:cannot|can't|unable to|not able to)\b.{0,80}\b(?:dispatch|spawn|delegate|use sessions_spawn)\b/i.test(answer) ||
      /\bsessions_spawn\b.{0,80}\b(?:not available|not callable|missing|unavailable)\b/i.test(answer) ||
      !answer.includes(latest.delegation_id || "");
    if (modelContradictedDispatch) {
      answer = await buildAsyncDelegationStatusAnswer(latest);
    }
  }

  return {
    answer,
    toolsUsed: universalResult.toolsUsed,
    tokensUsed: universalResult.tokensUsed,
    repairAttempts: universalResult.repairAttempts,
    metadata: {
      ...universalResult.metadata,
      sideEffectPolicy: sideEffectPolicy.mode,
      sideEffectPolicyReason: sideEffectPolicy.reason,
      withheldTools: filtered.withheldTools,
    },
  };
}
