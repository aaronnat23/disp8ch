import type { ModelLedLane } from "@/lib/channels/model-led-context";

const UNIVERSAL_AGENTIC_PLAYBOOK = [
  "Universal agentic operating rules:",
  "- Decide the evidence path from the user's goal, not from a fixed route.",
  "- Use repo, web, app-state, memory, documents, execution, and design tools when each materially improves the answer.",
  "- If a tool is missing or fails, try an adjacent tool or state the blocker.",
  "- Finish with a result grounded in the evidence actually gathered.",
].join("\n");

const REPO_INSPECTION_PLAYBOOK = [
  "Repo inspection operating rules:",
  "- First map the repo enough to know where the relevant code lives.",
  "- Read package, config, and docs files before making stack or dependency claims.",
  "- Search before naming files. Read files before making behavior claims.",
  "- In thorough mode, read at least two relevant implementation files before diagnosing bottlenecks, architecture, or behavior.",
  "- Never name a path as an implementation target unless it exists or you clearly label it as a proposed new file.",
  "- For performance/debugging, identify the exact code path, likely bottleneck, and verification command.",
  "- Cite real file paths from tool results.",
  "- When claiming behavior about a specific file, cite the line range or function name from read_file output.",
  "  Example: \"The classifyContextLane function (model-led-context.ts:140-168) first checks intentKind...\"",
  "  If read_file output includes line numbers, use them. If it only returns content without numbers, cite the file path.",
].join("\n");

const BROAD_RESEARCH_PLAYBOOK = [
  "Broad research operating rules:",
  "- Search for source diversity before synthesizing.",
  "- Fetch source URLs before citing them.",
  "- Cite only URLs or documents actually fetched or read.",
  "- Separate public-web evidence from repo-local evidence.",
  "- If sources disagree, explain the disagreement instead of averaging it away.",
  "- Do not invent article titles, discussion counts, benchmark claims, or source names.",
].join("\n");

const APP_DESIGN_PLAYBOOK = [
  "disp8ch AI app-design operating rules:",
  "- Load app state and available templates/tools before proposing a workflow, board, council, hierarchy, schedule, or channel design.",
  "- Use actual disp8ch AI names: workflow_templates, workflow_create, schedule_task, schedules_list, webhooks_list, board_tasks, governance_queue, channel_status.",
  "- Do not invent generic node names such as run_python or send-webchat unless the app actually exposes them.",
  "- For visual workflow designs, use node types such as cron-trigger, run-code, http-request, board-task, and send-webchat.",
  "- Keep visual workflow node labels, WebChat agent tools, and internal API names separate; preserve user-requested labels as labels, then map them to available disp8ch AI node types/tools/templates.",
  "- Do not put workflow_create, schedule_task, board_tasks, or send_message in a visual workflow node-type column; those are assistant/app-control tools for inspection or confirmed mutations.",
  "- If the user asks for a plan, do not mutate. Gather state, then draft a precise proposal.",
  "- Include concrete roles, node/tool choices, trigger, data flow, success criteria, and user confirmation boundary.",
  "- For a workflow design, cover the full lifecycle the user asked for: trigger, ordered nodes with their config, data flow between nodes, error handling / retry / failure branches, operational risks, and concrete test or validation cases. Do not stop at a node list.",
].join("\n");

const MEMORY_RECALL_PLAYBOOK = [
  "Memory recall operating rules:",
  "- Use exact/session recall first for recent or exact identifiers.",
  "- Use semantic memory search when the user asks about preferences, prior decisions, or older facts.",
  "- Quote or cite the memory source label when available.",
  "- If the user requested an exact-only answer, return only the requested value or acknowledgement.",
].join("\n");

const READ_ONLY_WORKSPACE_PLAYBOOK = [
  "Read-only workspace operating rules:",
  "- Prefer app-status and document tools before generic answers when the user asks about the current app.",
  "- Keep mutation boundaries explicit.",
  "- If a request needs repo evidence, switch behavior to repo-inspection standards.",
].join("\n");

export function buildLanePlaybook(lane: ModelLedLane): string {
  const laneSpecific = (() => {
    switch (lane) {
      case "repo_inspection":
        return REPO_INSPECTION_PLAYBOOK;
      case "broad_research":
        return BROAD_RESEARCH_PLAYBOOK;
      case "app_design":
      case "app_mutation_proposal":
        return APP_DESIGN_PLAYBOOK;
      case "memory_recall":
        return MEMORY_RECALL_PLAYBOOK;
      case "read_only_workspace":
        return READ_ONLY_WORKSPACE_PLAYBOOK;
      default:
        return "";
    }
  })();
  if (!laneSpecific) return UNIVERSAL_AGENTIC_PLAYBOOK;
  return `${UNIVERSAL_AGENTIC_PLAYBOOK}\n\n${laneSpecific}`;
}
