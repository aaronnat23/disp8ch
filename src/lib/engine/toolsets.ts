export type ToolsetId =
  | "filesystem"
  | "web"
  | "browser"
  | "memory"
  | "messaging"
  | "workflows"
  | "boards"
  | "design_studio"
  | "governance"
  | "experiments"
  | "mcp"
  | "media_generation"
  | "unsafe_exec";

export type ToolsetRiskTier = "low" | "medium" | "high";

export type ToolsetDefinition = {
  id: ToolsetId;
  label: string;
  description: string;
  toolNames: string[];
  riskTier: ToolsetRiskTier;
};

export const TOOLSET_DEFINITIONS: Record<ToolsetId, ToolsetDefinition> = {
  filesystem: {
    id: "filesystem",
    label: "Filesystem",
    description: "Read and inspect files in the workspace.",
    toolNames: ["read_file", "list_files", "find_files", "search_files", "code_review", "image_view"],
    riskTier: "low",
  },
  web: {
    id: "web",
    label: "Web",
    description: "Search the web and call public HTTP endpoints.",
    toolNames: ["web_search", "web_extract", "web_crawl", "fetch_url", "http_request", "tool_docs_search"],
    riskTier: "medium",
  },
  browser: {
    id: "browser",
    label: "Browser",
    description: "Browser automation and screenshots.",
    toolNames: [
      "browser_action",
      "browser_navigate",
      "browser_snapshot",
      "browser_click",
      "browser_type",
      "browser_scroll",
      "browser_back",
      "browser_press",
      "browser_get_text",
      "browser_get_links",
      "browser_get_images",
      "browser_vision",
      "browser_cdp",
      "browser_dialog",
      "browser_wait",
      "browser_screenshot",
      "browser_console",
      "take_screenshot",
      "image_view",
    ],
    riskTier: "medium",
  },
  memory: {
    id: "memory",
    label: "Memory",
    description: "Search session and long-term memory stores.",
    toolNames: ["memory_search", "memory_gpt", "session_recall", "memory_get"],
    riskTier: "low",
  },
  messaging: {
    id: "messaging",
    label: "Messaging",
    description: "Send messages and coordinate across agents or sessions.",
    toolNames: ["send_message", "agent_inbox", "session_todo", "sessions_yield", "channel_directory"],
    riskTier: "medium",
  },
  workflows: {
    id: "workflows",
    label: "Workflows",
    description: "Inspect templates and create, schedule, or expose workflows through automations.",
    toolNames: [
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
      "call_workflow",
      "schedule_task",
      "schedules_list",
      "webhooks_list",
      "webhooks_create",
      "webhooks_rotate_secret",
      "webhooks_toggle",
      "webhooks_delete",
    ],
    riskTier: "medium",
  },
  boards: {
    id: "boards",
    label: "Boards",
    description: "Create and manage board tasks.",
    toolNames: ["board_tasks"],
    riskTier: "medium",
  },
  design_studio: {
    id: "design_studio",
    label: "Design Studio",
    description: "Create, inspect, and revise versioned HTML design artifacts in the Designs tab.",
    toolNames: [
      "design_project_list",
      "design_project_create",
      "design_artifact_list",
      "design_artifact_read",
      "design_artifact_create",
      "design_artifact_update",
      "design_artifact_versions",
      "design_artifact_patch",
      "design_artifact_preview_check",
      "design_recipe_list",
      "design_system_list",
      "design_system_read",
      "design_artifact_export",
      "design_artifact_rollback",
    ],
    riskTier: "medium",
  },
  governance: {
    id: "governance",
    label: "Governance",
    description: "Approvals, checkpoints, and governance controls.",
    toolNames: ["governance_queue", "checkpoint_create", "checkpoint_list", "checkpoint_diff", "checkpoint_rollback"],
    riskTier: "high",
  },
  experiments: {
    id: "experiments",
    label: "Experiments",
    description: "Run metric-driven experiment loops.",
    toolNames: ["init_experiment", "run_experiment", "log_experiment"],
    riskTier: "high",
  },
  mcp: {
    id: "mcp",
    label: "MCP",
    description: "Discover and call Model Context Protocol servers.",
    toolNames: ["mcp_list", "mcp_call", "mcp_list_resources", "mcp_read_resource", "mcp_list_prompts", "mcp_get_prompt"],
    riskTier: "medium",
  },
  media_generation: {
    id: "media_generation",
    label: "Media Generation",
    description: "Generate images and media via configured provider APIs.",
    toolNames: ["image_generate"],
    riskTier: "medium",
  },
  unsafe_exec: {
    id: "unsafe_exec",
    label: "Unsafe Exec",
    description: "Direct code and shell execution with machine-side effects.",
    toolNames: ["bash_exec", "write_file", "run_python", "document_ingest", "sessions_spawn"],
    riskTier: "high",
  },
};

const TOOLSET_IDS = Object.keys(TOOLSET_DEFINITIONS) as ToolsetId[];

export function isToolsetId(value: string): value is ToolsetId {
  return TOOLSET_IDS.includes(value as ToolsetId);
}

export function normalizeToolsetIds(values: string[] | null | undefined): ToolsetId[] {
  const seen = new Set<ToolsetId>();
  const normalized: ToolsetId[] = [];
  for (const raw of values ?? []) {
    const value = String(raw || "").trim().toLowerCase();
    if (!value || !isToolsetId(value) || seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }
  return normalized;
}

export function resolveToolNamesFromToolsets(toolsetIds: string[] | null | undefined): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const toolsetId of normalizeToolsetIds(toolsetIds)) {
    for (const toolName of TOOLSET_DEFINITIONS[toolsetId].toolNames) {
      if (seen.has(toolName)) continue;
      seen.add(toolName);
      names.push(toolName);
    }
  }
  return names;
}

export function resolveToolsetsForTool(toolName: string): ToolsetId[] {
  return TOOLSET_IDS.filter((toolsetId) => TOOLSET_DEFINITIONS[toolsetId].toolNames.includes(toolName));
}
