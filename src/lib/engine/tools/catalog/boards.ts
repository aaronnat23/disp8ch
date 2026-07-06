import type { ToolDefinition } from "../types";

export const BOARD_TOOL_CATALOG: Record<string, ToolDefinition> = {
  board_tasks: {
    name: "board_tasks",
    description:
      "List, create, update, or delete real board tasks on the Boards tab. Mutating actions write to the SQLite store. " +
      "When to use: the user asked to add a task, change task status, delete a task, or list current tasks. Always confirm before create/update/delete if scope is ambiguous. " +
      "When NOT to use: when the user asked for a 'task PROPOSAL' or 'draft a task' — return markdown instead; in read-only sessions for any mutating action without explicit confirmation. " +
      "Status values: inbox|in_progress|review|done|blocked. Example: `{action: 'create', boardId: 'main', title: 'Run benchmark', priority: 'high'}`.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "Operation to perform.",
          enum: ["list", "get", "create", "update", "delete", "claim", "release"],
        },
        board_id: {
          type: "string",
          description: "Board id. Defaults to main-board.",
        },
        task_id: {
          type: "string",
          description: "Task id for get/update/delete.",
        },
        title: {
          type: "string",
          description: "Task title or title search text.",
        },
        description: {
          type: "string",
          description: "Task description for create/update.",
        },
        status: {
          type: "string",
          description: "Optional task status filter or update value.",
          enum: ["inbox", "in_progress", "review", "done", "blocked"],
        },
        priority: {
          type: "string",
          description: "Optional task priority for create/update.",
          enum: ["low", "medium", "high"],
        },
        workflow_template: {
          type: "string",
          description: "Optional workflow template key for executable board tasks.",
        },
        goal: {
          type: "string",
          description: "Optional goal id or name for hierarchy-aware tasks.",
        },
        assigned_agent: {
          type: "string",
          description: "Optional agent id for assignment or claim operations.",
        },
        organization: {
          type: "string",
          description: "Optional organization id or name for hierarchy-aware tasks.",
        },
        blocked_by: {
          type: "string",
          description:
            "Optional comma-separated blocker task ids or titles for create/update. When blockers exist the task stays blocked until they are completed.",
        },
        limit: {
          type: "number",
          description: "Maximum tasks to return for list.",
        },
      },
      required: ["action"],
    },
  },

  governance_queue: {
    name: "governance_queue",
    description:
      "Manage crew governance state: task approvals, approval comments, wakeup queue, and runtime snapshots across Approvals, Hierarchy, and Governance tabs.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "Operation to perform.",
          enum: [
            "list-task-approvals",
            "task-approval-gate",
            "create-task-approval",
            "resolve-task-approval",
            "comment-task-approval",
            "list-approval-comments",
            "list-wakeups",
            "enqueue-wakeup",
            "claim-wakeup",
            "finish-wakeup",
            "agent-runtime",
          ],
        },
        task_id: {
          type: "string",
          description: "Board task id or title for approval-related actions.",
        },
        approval_id: {
          type: "string",
          description: "Task approval id for resolution or comments.",
        },
        wakeup_id: {
          type: "string",
          description: "Wakeup request id for claim or finish actions.",
        },
        agent_id: {
          type: "string",
          description: "Agent id for wakeup or runtime actions.",
        },
        agent_ids: {
          type: "string",
          description: "Optional comma-separated list of agent ids for bulk runtime inspection.",
        },
        status: {
          type: "string",
          description: "Optional status filter.",
          enum: ["pending", "approved", "rejected", "revision_requested", "queued", "claimed", "finished"],
        },
        decision: {
          type: "string",
          description: "Decision for resolving task approvals.",
          enum: ["approved", "rejected", "revision_requested"],
        },
        note: {
          type: "string",
          description: "Optional decision note, trigger detail, or comment text depending on action.",
        },
        source: {
          type: "string",
          description: "Wakeup source for enqueue-wakeup. Defaults to 'crew-governance'.",
        },
        approver_type: {
          type: "string",
          description: "Approver type when creating a task approval.",
          enum: ["user", "agent"],
        },
        approver_id: {
          type: "string",
          description: "Optional approver id when creating a task approval.",
        },
        limit: {
          type: "number",
          description: "Maximum records to return for list actions.",
        },
      },
      required: ["action"],
    },
  },

};
