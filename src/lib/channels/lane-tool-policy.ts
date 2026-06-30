import type { ModelLedLane } from "@/lib/channels/model-led-context";
import { TOOL_PACKS } from "@/lib/channels/model-led-context";

export type ToolPhase = "preflight" | "model" | "repair" | "recovery" | "synthesis";

const WEB_ONLY = [
  "web_search",
  "web_extract",
  "web_crawl",
  "fetch_url",
  "browser_navigate",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_scroll",
  "browser_back",
  "browser_press",
  "browser_get_text",
  "browser_get_links",
  "browser_wait",
  "browser_screenshot",
  "browser_get_images",
  "browser_vision",
  "browser_console",
  "browser_cdp",
  "browser_dialog",
  "browser_action",
  "computer_observe",
  "computer_list_apps",
  "computer_zoom",
  "computer_wait",
  "documents_search",
  "documents_semantic_search",
  "document_get",
  "memory_search",
  "memory_get",
  "pc_specs",
];

const REPO_ONLY = [
  "list_files",
  "search_files",
  "read_file",
  "code_review",
  "memory_search",
  "memory_get",
  "session_recall",
];

const APP_STATE_READ_ONLY = [
  "channel_status",
  "workflow_node_catalog",
  "workflow_templates",
  "workflow_list",
  "workflow_get",
  "workflow_execution_status",
  "schedules_list",
  "webhooks_list",
  "documents_list",
  "documents_search",
  "documents_semantic_search",
  "document_get",
  "memory_search",
  "memory_get",
  "session_recall",
];

/**
 * Broad read-only toolkit that the universal agentic runtime can hand to
 * the model. Lets the model choose evidence sources instead of pre-deciding
 * per regex. Mutation tools are intentionally excluded; write-phase
 * approval is handled separately by the policy layer.
 */
export const UNIVERSAL_READ_ONLY_TOOL_NAMES: string[] = unique([
  ...TOOL_PACKS.read_only_workspace,
  ...WEB_ONLY,
  ...REPO_ONLY,
  ...APP_STATE_READ_ONLY,
]);

function unique(items: string[]): string[] {
  return Array.from(new Set(items));
}

export function getAllowedToolsForLane(input: {
  lane: ModelLedLane;
  phase: ToolPhase;
  forceTools?: boolean;
}): string[] {
  if (input.phase === "synthesis") return [];
  if (input.forceTools && input.lane === "direct") {
    return UNIVERSAL_READ_ONLY_TOOL_NAMES;
  }
  switch (input.lane) {
    case "broad_research":
      return unique([...TOOL_PACKS.read_only_workspace, ...WEB_ONLY, ...APP_STATE_READ_ONLY]);
    case "repo_inspection":
      return unique([...TOOL_PACKS.read_only_workspace, ...REPO_ONLY, ...APP_STATE_READ_ONLY]);
    case "app_design":
    case "app_mutation_proposal":
      return TOOL_PACKS[input.lane] ?? [];
    case "memory_recall":
      return TOOL_PACKS.memory_recall;
    case "read_only_workspace":
      return TOOL_PACKS.read_only_workspace;
    case "direct":
    default:
      return UNIVERSAL_READ_ONLY_TOOL_NAMES;
  }
}
