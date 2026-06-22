import { TOOL_CATALOG } from "@/lib/engine/tools";
import { listWorkflowTemplateCatalog } from "@/lib/workflows/template-catalog";

const CORE_TOOL_NAMES = [
  "channel_status",
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
  "schedule_task",
  "board_tasks",
  "governance_queue",
  "documents_list",
  "documents_search",
  "documents_semantic_search",
  "document_get",
  "memory_search",
  "memory_get",
  "session_recall",
  "list_files",
  "search_files",
  "read_file",
  "code_review",
  "web_search",
  "web_extract",
  "web_crawl",
  "fetch_url",
  "browser_action",
  "browser_navigate",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_get_text",
  "browser_get_links",
  "browser_get_images",
  "browser_vision",
  "browser_cdp",
  "browser_dialog",
  "browser_wait",
  "browser_console",
  "browser_back",
  "pc_specs",
];

export function buildDisp8chSystemMap(): string {
  const tools = CORE_TOOL_NAMES
    .filter((name) => TOOL_CATALOG[name])
    .map((name) => {
      const tool = TOOL_CATALOG[name];
      return `- ${name}: ${tool.description}`;
    })
    .join("\n");

  const templates = listWorkflowTemplateCatalog()
    .map((entry) => `- ${entry.key}: ${entry.name}`)
    .join("\n");

  return [
    "disp8ch AI system map:",
    "Primary app surfaces:",
    "- WebChat: conversational command and analysis surface.",
    "- Agents: model/provider/system-prompt/tool configuration.",
    "- Workflows: node/template-based automation.",
    "- Scheduler: cron-backed workflow execution.",
    "- Boards: durable tasks, assignments, executable task metadata.",
    "- Hierarchy: organizations, goals, crew/runtime coordination.",
    "- Council: debate sessions and multi-agent opinions.",
    "- Memory: durable user/project facts plus session recall.",
    "- Data Sources: uploaded/scraped documents.",
    "",
    "Visual workflow node vocabulary:",
    "- Common node types: cron-trigger, message-trigger, webhook-trigger, run-code, http-request, board-task, send-webchat, send-telegram, send-discord, if-else, switch, filter, loop, aggregate, merge, delay, memory-recall, memory-store, claude-agent, parallel-agents, council.",
    "- Use these node types when drafting a visual workflow canvas.",
    "",
    "Important tool vocabulary:",
    tools,
    "",
    "Workflow template vocabulary:",
    templates,
    "",
    "Precision rules:",
    "- Use the exact tool and template names above.",
    "- If a requested capability maps to an app surface, name that surface.",
    "- Workflow node labels are user-facing design labels; WebChat tools are execution/query capabilities; API route names are implementation details. Do not merge those vocabularies.",
    "- If a capability is unavailable, say so instead of inventing a node/tool.",
  ].join("\n");
}
