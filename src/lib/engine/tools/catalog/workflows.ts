import type { ToolDefinition } from "../types";

export const WORKFLOW_TOOL_CATALOG: Record<string, ToolDefinition> = {
  workflow_templates: {
    name: "workflow_templates",
    description:
      "List the built-in workflow templates available in the Workflows tab, including names and template keys.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },

  workflow_create: {
    name: "workflow_create",
    description:
      "Create a real disp8ch AI workflow from a built-in template — appears immediately in the Workflows and Scheduler tabs. " +
      "When to use: the user explicitly asked to CREATE a workflow, not just to design one. Always confirm with the user before calling — this mutates app state. " +
      "When NOT to use: for designing a workflow on paper (return a markdown plan instead); when the user said 'do not create' or 'plan only'. " +
      "Use workflow_templates first to find a matching template name. Example: `{template: 'simple-chat', name: 'My Chat Test'}`.",
    parameters: {
      type: "object",
      properties: {
        template: {
          type: "string",
          description: "Workflow template key or plain-English template name.",
        },
        name: {
          type: "string",
          description: "Name of the new workflow.",
        },
        description: {
          type: "string",
          description: "Optional description for the new workflow.",
        },
        organization: {
          type: "string",
          description: "Optional organization id or name for hierarchy-aware templates.",
        },
        goal: {
          type: "string",
          description: "Optional goal id or name for hierarchy-aware templates.",
        },
      },
      required: ["template", "name"],
    },
  },

  workflow_list: {
    name: "workflow_list",
    description:
      "List all workflows in the Workflows tab with their IDs, names, isActive state, node count, and organization linkage. " +
      "When to use: BEFORE any workflow_get / workflow_update_node / workflow_run / workflow_delete call — you need the workflow ID first. " +
      "When NOT to use: if the user only mentioned a template name (use workflow_templates for built-ins).",
    parameters: {
      type: "object",
      properties: {
        include_inactive: {
          type: "boolean",
          description: "If true, also list disabled workflows. Default false.",
        },
        organization: {
          type: "string",
          description: "Optional org id or name to filter by.",
        },
      },
      required: [],
    },
  },

  workflow_get: {
    name: "workflow_get",
    description:
      "Get the full configuration of a single workflow including all nodes with their IDs, types, system prompts, URLs, headers, enabled tools, execSecurity policies, and edges. " +
      "Use this BEFORE workflow_update_node so you know the exact node ID and current config to change. " +
      "Example: `{name: 'Trading Research Cycle'}` or `{id: 'abc123'}`.",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Workflow ID. Prefer this over name when known.",
        },
        name: {
          type: "string",
          description: "Workflow name (case-insensitive substring match).",
        },
      },
      required: [],
    },
  },

  workflow_run: {
    name: "workflow_run",
    description:
      "Manually trigger a workflow execution. Runs against the manual-trigger node and follows the normal DAG. " +
      "Use when the user says 'run X now', 'execute X', 'fire X'. " +
      "Cron-scheduled workflows still run on schedule; this is an ad-hoc trigger. " +
      "Confirm with the user before running workflows that have side effects (writes files, sends messages, creates board tasks).",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Workflow ID.",
        },
        name: {
          type: "string",
          description: "Workflow name (resolved by substring if id not given).",
        },
        trigger_input: {
          type: "string",
          description: "Optional payload passed as trigger.input (a topic, ticker, URL, or free-form request).",
        },
      },
      required: [],
    },
  },

  workflow_execution_status: {
    name: "workflow_execution_status",
    description:
      "Check the status and latest output summary for a workflow execution. " +
      "Use after workflow_run when the run is still pending, or when the user asks 'is it done?', 'what happened?', 'show the result'.",
    parameters: {
      type: "object",
      properties: {
        execution_id: {
          type: "string",
          description: "Execution ID returned by workflow_run.",
        },
        workflow_id: {
          type: "string",
          description: "Optional fallback: checks the most recent execution for this workflow.",
        },
        workflow_name: {
          type: "string",
          description: "Optional: resolve workflow by name then check its latest execution.",
        },
      },
      required: [],
    },
  },

  workflow_toggle_active: {
    name: "workflow_toggle_active",
    description:
      "Enable or disable a workflow. Disabling stops cron-trigger nodes from firing and removes the workflow from the Scheduler tab. " +
      "Manual triggers still work when disabled. " +
      "Use for 'turn off X', 'pause X', 'disable the daily cron'.",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Workflow ID.",
        },
        name: {
          type: "string",
          description: "Workflow name (case-insensitive substring match).",
        },
        active: {
          type: "boolean",
          description: "true to enable, false to disable.",
        },
      },
      required: ["active"],
    },
  },

  workflow_duplicate: {
    name: "workflow_duplicate",
    description:
      "Clone an existing workflow into a new copy with a different name. " +
      "The new copy is left DISABLED so it does not accidentally start its cron triggers. " +
      "Use when the user wants a variant: 'make a horizontal version of the short-video workflow', 'clone trading-cycle for paper trading'.",
    parameters: {
      type: "object",
      properties: {
        source_id: {
          type: "string",
          description: "Source workflow ID.",
        },
        source_name: {
          type: "string",
          description: "Source workflow name (substring match).",
        },
        new_name: {
          type: "string",
          description: "Name for the new workflow copy.",
        },
      },
      required: ["new_name"],
    },
  },

  workflow_update_node: {
    name: "workflow_update_node",
    description:
      "Update a single node's configuration inside a workflow. " +
      "Use to change a system prompt, swap a URL, edit headers, change enabledTools, adjust execSecurity allowlist, change temperature/maxTokens, edit set-variables assignments. " +
      "CRITICAL: call workflow_get first to confirm the node_id and current config. Pass ONLY the fields you want to change; everything else is preserved. " +
      "For URL swap: `{workflow_id, node_id, updates: {url: 'https://…'}}`. " +
      "For prompt edit: `{workflow_id, node_label: 'ScriptWriter', updates: {systemPrompt: '…'}}`. " +
      "Confirm with the user before applying if the change affects security-sensitive fields (execAllowlist, enabledTools, headers, url).",
    parameters: {
      type: "object",
      properties: {
        workflow_id: {
          type: "string",
          description: "Workflow ID.",
        },
        workflow_name: {
          type: "string",
          description: "Workflow name (fallback if id not known).",
        },
        node_id: {
          type: "string",
          description: "Node ID from workflow_get.",
        },
        node_label: {
          type: "string",
          description: "Alternative to node_id — case-insensitive substring of node.data.label.",
        },
        updates: {
          type: "object",
          description: "Partial node.data object for simple shallow field updates.",
        },
        patch_ops: {
          type: "array",
          description: "Generic patch operations for arrays, headers, assignments, allowlists: set/unset/append_unique/remove_value/replace_array_item/replace_assignment/set_header/remove_header.",
        },
      },
      required: [],
    },
  },

  workflow_set_model: {
    name: "workflow_set_model",
    description:
      "Set or retarget the model/provider/agent binding used by agent-capable nodes in a workflow. " +
      "Use for 'run X on Claude Sonnet instead of DeepSeek', 'switch trading cycle to GPT-5 for the Quant only'. " +
      "Note: most claude-agent nodes bind through agentId; updating agentId is the supported path unless the node uses direct model fields.",
    parameters: {
      type: "object",
      properties: {
        workflow_id: {
          type: "string",
          description: "Workflow ID.",
        },
        workflow_name: {
          type: "string",
          description: "Workflow name (fallback if id not known).",
        },
        agent_id: {
          type: "string",
          description: "Configured agent id to assign (preferred — sets agentId on matching nodes).",
        },
        model: {
          type: "string",
          description: "Model ref like 'claude-sonnet-4-6', 'gpt-5', 'deepseek-v4-pro', or alias 'sonnet', 'opus'.",
        },
        node_id: {
          type: "string",
          description: "Optional — restrict change to one specific agent-capable node.",
        },
        node_label: {
          type: "string",
          description: "Optional — restrict by node label substring.",
        },
      },
      required: [],
    },
  },

  workflow_create_credential: {
    name: "workflow_create_credential",
    description:
      "Create a saved workflow credential in the encrypted credential store. " +
      "Use when the user explicitly provides a secret/API key/token and asks WebChat to fix a missing workflow credential. " +
      "Never print the secret value back to the user. After creation, use workflow_attach_credential to attach the returned credential_id to a node.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Human-readable credential name.",
        },
        service_type: {
          type: "string",
          description: "Service type such as http, slack, google, notion, airtable, email, telegram, discord.",
        },
        secret_value: {
          type: "string",
          description: "The secret/token/API key supplied by the user. Do not echo it back.",
        },
        metadata_json: {
          type: "string",
          description: "Optional small JSON metadata string. Do not include secret values here.",
        },
      },
      required: ["name", "service_type", "secret_value"],
    },
  },

  workflow_attach_credential: {
    name: "workflow_attach_credential",
    description:
      "Attach an existing saved credential reference to one node in a workflow. " +
      "Use after workflow_get confirms the workflow and node id/label, or after workflow_create_credential returns credential_id. " +
      "This stores only credentialId on the workflow node; it does not write raw secrets into workflow JSON.",
    parameters: {
      type: "object",
      properties: {
        workflow_id: {
          type: "string",
          description: "Workflow ID.",
        },
        workflow_name: {
          type: "string",
          description: "Workflow name (fallback if id not known).",
        },
        node_id: {
          type: "string",
          description: "Node ID from workflow_get.",
        },
        node_label: {
          type: "string",
          description: "Alternative to node_id — case-insensitive substring of node.data.label.",
        },
        credential_id: {
          type: "string",
          description: "Credential ID returned by workflow_create_credential or listed in Workflows credentials.",
        },
        credential_name: {
          type: "string",
          description: "Fallback credential name if credential_id is not known.",
        },
      },
      required: [],
    },
  },

  workflow_update_schedule: {
    name: "workflow_update_schedule",
    description:
      "Change the cron expression and/or timezone on a workflow's cron-trigger node. " +
      "Use for 'trading cycle should run at 8am instead of 9am', 'run short-video weekly on Mondays at 10am'. " +
      "Common expressions: '0 9 * * 1-5' (weekdays 9am), '0 10 * * MON' (Mondays 10am), '*/30 * * * *' (every 30 min). " +
      "Cron manager is resynced automatically after update.",
    parameters: {
      type: "object",
      properties: {
        workflow_id: {
          type: "string",
          description: "Workflow ID.",
        },
        workflow_name: {
          type: "string",
          description: "Workflow name (fallback if id not known).",
        },
        node_id: {
          type: "string",
          description: "Optional — target a specific cron-trigger node when a workflow has more than one.",
        },
        node_label: {
          type: "string",
          description: "Optional — target by node label substring.",
        },
        expression: {
          type: "string",
          description: "New cron expression in standard 5-field format.",
        },
        timezone: {
          type: "string",
          description: "Optional IANA timezone (e.g. 'America/New_York'). Keeps current setting if omitted.",
        },
      },
      required: ["expression"],
    },
  },

  workflow_delete: {
    name: "workflow_delete",
    description:
      "Delete a workflow permanently. The workflow is removed from the Workflows tab, cron schedules are unscheduled, and execution history is preserved in the Activity tab. " +
      "Use ONLY when the user explicitly says 'delete', 'remove', 'trash'. Always confirm with the user before calling.",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Workflow ID.",
        },
        name: {
          type: "string",
          description: "Workflow name (case-insensitive substring match).",
        },
      },
      required: [],
    },
  },

  schedules_list: {
    name: "schedules_list",
    description:
      "List live scheduled workflows and their cron expressions from the Automations tab.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },

  webhooks_list: {
    name: "webhooks_list",
    description:
      "List webhook automations and the webhook signing contract. Returns each webhook's name, URL, linked workflow, active status, last delivery, and exact HMAC header requirements. Does not expose secrets.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },

  webhooks_create: {
    name: "webhooks_create",
    description:
      "Create a webhook automation for an existing workflow from a plain-English WebChat request. " +
      "Use only when the user explicitly asks to create/add/set up/configure a webhook. " +
      "Returns the signing secret exactly once; existing secrets are never readable. " +
      "If the user provides their own signing key/secret, pass it as secret; otherwise omit secret and a secure random secret is generated.",
    parameters: {
      type: "object",
      properties: {
        workflow_id: {
          type: "string",
          description: "Existing workflow ID to attach the webhook to. Prefer workflow_id when known.",
        },
        workflow_name: {
          type: "string",
          description: "Existing workflow name or substring when workflow_id is not known.",
        },
        name: {
          type: "string",
          description: "Human-readable webhook automation name, max 120 characters.",
        },
        is_active: {
          type: "string",
          enum: ["true", "false"],
          description: "Whether the webhook should be active immediately. Defaults to true.",
        },
        secret: {
          type: "string",
          description: "Optional user-provided HMAC signing secret/key. Must be at least 24 characters. Omit to generate a secure secret.",
        },
      },
      required: ["name"],
    },
  },

  webhooks_rotate_secret: {
    name: "webhooks_rotate_secret",
    description:
      "Rotate a webhook automation signing secret. Use only when the user explicitly asks to rotate/regenerate/reset a webhook secret/key. Returns the new secret exactly once.",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Webhook ID.",
        },
        name: {
          type: "string",
          description: "Webhook automation name or substring when id is not known.",
        },
      },
      required: [],
    },
  },

  webhooks_toggle: {
    name: "webhooks_toggle",
    description:
      "Enable or disable a webhook automation. Use only when the user explicitly asks to enable, disable, turn on, turn off, or toggle a webhook.",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Webhook ID.",
        },
        name: {
          type: "string",
          description: "Webhook automation name or substring when id is not known.",
        },
        is_active: {
          type: "string",
          enum: ["true", "false"],
          description: "Set true to enable, false to disable. Omit to toggle current state.",
        },
      },
      required: [],
    },
  },

  webhooks_delete: {
    name: "webhooks_delete",
    description:
      "Delete a webhook automation permanently. Use only when the user explicitly asks to delete/remove a webhook automation.",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Webhook ID.",
        },
        name: {
          type: "string",
          description: "Webhook automation name or substring when id is not known.",
        },
      },
      required: [],
    },
  },

  workflow_node_catalog: {
    name: "workflow_node_catalog",
    description:
      "Returns the complete catalog of available workflow node types with their categories, config fields, and common patterns. " +
      "Use this for workflow design to get exact node types instead of inventing generic names.",
    parameters: {
      type: "object",
      properties: {
        category: {
          type: "string",
          description: "Optional filter: 'trigger', 'action', 'transform', 'condition', 'llm', 'app_tool', 'terminal', 'all' (default: all)",
        },
      },
      required: [],
    },
  },

  call_workflow: {
    name: "call_workflow",
    description: "Trigger another workflow by its name or ID and return its result.",
    parameters: {
      type: "object",
      properties: {
        workflow_name: {
          type: "string",
          description: "Name of the workflow to trigger (case-insensitive)",
        },
        message: {
          type: "string",
          description: "Input message to pass to the workflow",
        },
      },
      required: ["workflow_name", "message"],
    },
  },

  schedule_task: {
    name: "schedule_task",
    description:
      "Schedule a workflow to run later on a cron schedule. The schedule persists until removed. " +
      "Uses standard cron expressions (e.g. '0 9 * * *' for daily at 9am).",
    parameters: {
      type: "object",
      properties: {
        workflow_name: {
          type: "string",
          description: "Name of the workflow to schedule",
        },
        cron_expression: {
          type: "string",
          description: "Cron expression (e.g. '*/5 * * * *' every 5 min, '0 9 * * *' daily 9am, '0 0 * * 1' weekly Monday)",
        },
        timezone: {
          type: "string",
          description: "IANA timezone (e.g. 'America/New_York'). Defaults to UTC.",
        },
      },
      required: ["workflow_name", "cron_expression"],
    },
  },

};
