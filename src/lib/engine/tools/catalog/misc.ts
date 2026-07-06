import type { ToolDefinition } from "../types";

export const MISC_TOOL_CATALOG: Record<string, ToolDefinition> = {
  bash_exec: {
    name: "bash_exec",
    description:
      "Execute a shell command and return stdout+stderr+exit code. " +
      "When to use: system inspection (uname, date, df, ps), running scripts, package management, git, anything that needs the live system. " +
      "When NOT to use: reading file contents (use read_file); searching code (use search_files); HTTP fetches (use fetch_url). " +
      "Always supply a non-interactive form (`-y`, `--no-pager`). Example: `git status --short && git log -1 --oneline`.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The shell command to execute (bash on Linux/macOS, cmd on Windows)",
        },
        working_dir: {
          type: "string",
          description: "Working directory for the command. Defaults to the app root.",
        },
        timeout_ms: {
          type: "number",
          description: "Timeout in milliseconds. Maximum 60000. Defaults to 15000.",
        },
        background: {
          type: "boolean",
          description: "When true, start the command as a background job and return immediately.",
        },
        notify_on_complete: {
          type: "boolean",
          description: "When used with background=true, trigger a follow-up notification turn when the job exits.",
        },
      },
      required: ["command"],
    },
  },

  design_project_list: {
    name: "design_project_list",
    description: "List Design Studio projects with artifact counts.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  design_project_create: {
    name: "design_project_create",
    description: "Create a Design Studio project for versioned HTML design artifacts.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Project name" },
        description: { type: "string", description: "Optional project description" },
      },
      required: ["name"],
    },
  },
  design_artifact_list: {
    name: "design_artifact_list",
    description: "List artifacts for a Design Studio project.",
    parameters: {
      type: "object",
      properties: { project_id: { type: "string", description: "Design project id" } },
      required: ["project_id"],
    },
  },
  design_artifact_read: {
    name: "design_artifact_read",
    description: "Read a Design Studio artifact's metadata, validation, versions, and current HTML source preview.",
    parameters: {
      type: "object",
      properties: {
        artifact_id: { type: "string", description: "Design artifact id" },
        max_chars: { type: "number", description: "Maximum source characters to return. Default 12000." },
      },
      required: ["artifact_id"],
    },
  },
  design_artifact_create: {
    name: "design_artifact_create",
    description: "Create a versioned Design Studio HTML artifact. Use complete standalone HTML with inline CSS and data-disp8ch-id markers.",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Existing project id. Optional if project_name is supplied." },
        project_name: { type: "string", description: "Project name to create when project_id is omitted." },
        title: { type: "string", description: "Artifact title" },
        html: { type: "string", description: "Complete standalone HTML source" },
        summary: { type: "string", description: "Short version summary" },
      },
      required: ["title", "html"],
    },
  },
  design_artifact_update: {
    name: "design_artifact_update",
    description: "Save a new immutable version for a Design Studio artifact. Read current source first for edits.",
    parameters: {
      type: "object",
      properties: {
        artifact_id: { type: "string", description: "Design artifact id" },
        html: { type: "string", description: "Complete updated standalone HTML source" },
        summary: { type: "string", description: "Short change summary" },
      },
      required: ["artifact_id", "html"],
    },
  },
  design_artifact_versions: {
    name: "design_artifact_versions",
    description: "List immutable versions for a Design Studio artifact.",
    parameters: {
      type: "object",
      properties: { artifact_id: { type: "string", description: "Design artifact id" } },
      required: ["artifact_id"],
    },
  },
  design_artifact_patch: {
    name: "design_artifact_patch",
    description: "Apply a structured patch to a Design Studio artifact and save a new version. Prefer this for small scoped edits.",
    parameters: {
      type: "object",
      properties: {
        artifact_id: { type: "string", description: "Design artifact id" },
        patch_json: { type: "string", description: "JSON patch object, e.g. {\"kind\":\"set-text\",\"id\":\"hero-title\",\"value\":\"New title\"}" },
        summary: { type: "string", description: "Short patch summary" },
      },
      required: ["artifact_id", "patch_json"],
    },
  },
  design_artifact_preview_check: {
    name: "design_artifact_preview_check",
    description: "Run preview/quality checks for a Design Studio artifact, including visual checks when available.",
    parameters: {
      type: "object",
      properties: {
        artifact_id: { type: "string", description: "Design artifact id" },
        visual: { type: "boolean", description: "Run Playwright screenshot checks. Defaults to false inside tool loop for speed." },
      },
      required: ["artifact_id"],
    },
  },
  design_recipe_list: {
    name: "design_recipe_list",
    description: "List compact Design Studio recipes for artifact kinds such as landing page, dashboard, poster, deck, and admin tool.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  design_system_list: {
    name: "design_system_list",
    description: "List imported Design Studio design systems.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  design_system_read: {
    name: "design_system_read",
    description: "Read a compact normalized Design Studio design system package.",
    parameters: {
      type: "object",
      properties: { system_id: { type: "string", description: "Design system id" } },
      required: ["system_id"],
    },
  },
  design_artifact_export: {
    name: "design_artifact_export",
    description: "Prepare a Design Studio artifact export. Returns metadata and URL for html, zip, summary, png, or pdf.",
    parameters: {
      type: "object",
      properties: {
        artifact_id: { type: "string", description: "Design artifact id" },
        format: { type: "string", description: "html, zip, summary, png, or pdf" },
      },
      required: ["artifact_id", "format"],
    },
  },
  design_artifact_rollback: {
    name: "design_artifact_rollback",
    description: "Create a new Design Studio version by rolling back to an older immutable version.",
    parameters: {
      type: "object",
      properties: {
        artifact_id: { type: "string", description: "Design artifact id" },
        version_number: { type: "number", description: "Version number to restore from" },
      },
      required: ["artifact_id", "version_number"],
    },
  },

  backup_create: {
    name: "backup_create",
    description: "Create a verified local backup snapshot of the database, vector store, and key data folders.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },

  backup_list: {
    name: "backup_list",
    description: "List recent local backup snapshots.",
    parameters: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Maximum number of backups to return (default 10).",
        },
      },
      required: [],
    },
  },

  backup_verify: {
    name: "backup_verify",
    description: "Verify checksums for a backup snapshot. Defaults to the latest backup.",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Backup id or 'latest'.",
        },
      },
      required: [],
    },
  },

  backup_restore: {
    name: "backup_restore",
    description: "Build or apply a backup restore plan. Defaults to dry_run=true; stop the server before restoring live data.",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Backup id or 'latest'.",
        },
        target_data_dir: {
          type: "string",
          description: "Optional restore target directory. Defaults to ./data.",
        },
        dry_run: {
          type: "boolean",
          description: "When true, only validate and show the restore plan. Defaults true.",
        },
      },
      required: [],
    },
  },

  backup_status: {
    name: "backup_status",
    description: "Show automated backup policy status, schedule state, latest snapshot, and replication settings.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },

  backup_run_policy: {
    name: "backup_run_policy",
    description: "Run the configured automated backup policy now, including verification, retention pruning, and optional replication.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },

  system_info: {
    name: "system_info",
    description: "Get detailed system information: CPU, RAM, disk, OS, network interfaces, and uptime. No shell commands needed.",
    parameters: {
      type: "object",
      properties: {
        sections: {
          type: "string",
          description: "Comma-separated list of sections to include: cpu,memory,disk,os,network,uptime. Defaults to all.",
        },
      },
      required: [],
    },
  },

  image_view: {
    name: "image_view",
    description: "Read an image file and return its metadata and base64 content for vision analysis.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the image file (jpg, png, gif, webp, etc.)",
        },
      },
      required: ["path"],
    },
  },

  image_generate: {
    name: "image_generate",
    description:
      "Generate or edit an image via a configured provider (FAL.ai / OpenAI / xAI). Returns JSON with imageUrl, imagePath, provider, model. " +
      "When to use: the user explicitly asked for an image to be generated, or to EDIT an existing/attached image with a natural-language instruction. " +
      "For editing, set mode='edit' and pass input_image_ids (controlled asset ids of attached/generated images). Only some providers support editing; an unsupported provider returns a truthful capability error rather than a new unrelated image. " +
      "When NOT to use: when no provider is configured (return the missing-key message instead of guessing); for stickers/emoji (use platform-native sticker syntax). " +
      "After success, surface the artifact in WebChat using `MEDIA:<imagePath>` or `![label](/api/generated-images?id=<basename>)`. Example: `{prompt: 'minimal product hero, dark theme', aspect_ratio: 'square'}`.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "Detailed description of the image to generate, or the edit instruction in edit mode",
        },
        aspect_ratio: {
          type: "string",
          enum: ["landscape", "square", "portrait"],
          description: "Image aspect ratio. Default: square",
        },
        mode: {
          type: "string",
          enum: ["generate", "edit"],
          description: "'generate' (default) or 'edit' an existing image",
        },
        input_image_ids: {
          type: "array",
          items: { type: "string" },
          description: "Controlled asset ids of input images for edit mode (not URLs or paths)",
        },
      },
      required: ["prompt"],
    },
  },

  session_todo: {
    name: "session_todo",
    description: "Manage an in-memory task list for the current conversation turn. Use to track subtasks, plan steps, or break down complex work. Todos are session-scoped and survive context compression but are NOT persisted to the board permanently.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "list", "update", "complete", "clear_completed"], description: "Action to perform on the todo list" },
        id: { type: "string", description: "Todo ID (required for update/complete)" },
        content: { type: "string", description: "Todo content (required for create/update)" },
        status: { type: "string", enum: ["pending", "in_progress", "completed", "cancelled"], description: "New status (for update)" },
      },
      required: ["action"],
    },
  },

  sessions_yield: {
    name: "sessions_yield",
    description:
      "End the current agent turn immediately and store a hidden follow-up payload for the next message in the same chat session.",
    parameters: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "User-facing message to return for the yielded turn.",
        },
        hidden_payload: {
          type: "string",
          description: "Hidden payload injected into the next workflow turn for the same session.",
        },
      },
      required: [],
    },
  },

  run_python: {
    name: "run_python",
    description: "Execute a Python script and return its output. Python 3 must be installed on the system.",
    parameters: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "Python code to execute",
        },
        timeout_ms: {
          type: "number",
          description: "Timeout in milliseconds. Maximum 60000. Defaults to 15000.",
        },
        background: {
          type: "boolean",
          description: "When true, start the Python run as a background job and return immediately.",
        },
        notify_on_complete: {
          type: "boolean",
          description: "When used with background=true, trigger a follow-up notification turn when the job exits.",
        },
      },
      required: ["code"],
    },
  },

  sessions_spawn: {
    name: "sessions_spawn",
    description:
      "Spawn an asynchronous subagent. By default agent='current' reuses the active provider and model, so no separate coding account is required. " +
      "Use agent='claude', 'gemini', or 'codex' only when the user explicitly wants an installed coding CLI. " +
      "Use mode='run' for a one-shot task (waits for result). " +
      "Use mode='session' for a persistent thread-bound session — REQUIRES thread=true. " +
      "Discord: mode='session' + thread=true creates a dedicated thread you can message directly. " +
      "Non-Discord channels (Telegram, WhatsApp, Slack, etc.): always use mode='run' — thread binding is not supported. " +
      "permission_mode: 'approve-reads' (default, safe), 'approve-all' (auto-approve all tool calls), 'deny-all' (read-only). " +
      "Ideal for delegating complex coding, research, or file-system work to a specialist agent.",
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "The task or prompt to give the coding agent",
        },
        agent: {
          type: "string",
          description: "Subagent backend: 'current' (default active provider/model), 'claude' (Claude Code), 'gemini' (Gemini CLI), or 'codex' (Codex CLI)",
          enum: ["current", "claude", "gemini", "codex"],
        },
        agentId: {
          type: "string",
          description: "Named backend identifier (alias for agent). Accepts 'current', 'claude', 'gemini', or 'codex'.",
        },
        mode: {
          type: "string",
          description: "Execution mode: 'run' (one-shot) or 'session' (persistent, requires thread=true). Default: 'run'. Non-Discord channels must use 'run'.",
          enum: ["run", "session"],
        },
        session_id: {
          type: "string",
          description: "Resume an existing session (alias: resumeSessionId). Use session_id returned from a previous mode=session call.",
        },
        resumeSessionId: {
          type: "string",
          description: "Resume an existing session by its ID. Alias for session_id.",
        },
        permission_mode: {
          type: "string",
          description: "Permission mode: 'approve-reads' (default — allow reads, prompt for writes/exec), 'approve-all' (auto-approve everything, equivalent to --dangerously-skip-permissions), 'deny-all' (read-only, deny writes/exec).",
          enum: ["approve-reads", "approve-all", "deny-all"],
        },
        thinking: {
          type: "number",
          description: "Maximum thinking tokens for Claude Code (e.g. 8000, 16000). Only applies to agent=claude. Defaults to 16000.",
        },
        model: {
          type: "string",
          description: "Optional model override. For agent=current, defaults to the active chat model.",
        },
        cwd: {
          type: "string",
          description: "Working directory for the agent process. Defaults to the current project root.",
        },
        runTimeoutSeconds: {
          type: "number",
          description: "Timeout in seconds. Maximum 300. Defaults to 120.",
        },
        timeout_seconds: {
          type: "number",
          description: "Timeout in seconds (back-compat alias for runTimeoutSeconds).",
        },
        timeout_ms: {
          type: "number",
          description: "Timeout in milliseconds (back-compat alias, max 300000).",
        },
        max_budget_usd: {
          type: "number",
          description: "Maximum USD to spend on this task (Claude Code only). Defaults to 0.10.",
        },
        system_prompt: {
          type: "string",
          description: "Role/instruction to append to the agent's system prompt for this session (Claude Code only).",
        },
        sandbox: {
          type: "string",
          description: "'inherit' (default) or 'require'. Note: 'require' is unsupported for direct CLI spawn since the agent runs on the host.",
          enum: ["inherit", "require"],
        },
        stream_to: {
          type: "string",
          description: "Where to deliver the result: 'caller' (return to calling agent, default) or 'parent' (relay result via parent channel).",
          enum: ["caller", "parent"],
        },
        background: {
          type: "boolean",
          description:
            "When true, run the one-shot coding agent in the background and return immediately with a delegation handle. " +
            "The full result re-enters the WebChat/session as a new message when it finishes. Only supported with mode='run'.",
        },
        notify_on_complete: {
          type: "boolean",
          description: "When background=true, inject a completion message into the originating session when the delegated agent finishes. Defaults to true.",
        },
        cleanup: {
          type: "string",
          description: "Session cleanup after completion: 'keep' (retain session registry entry, default) or 'delete' (remove after run).",
          enum: ["keep", "delete"],
        },
        thread: {
          type: "boolean",
          description: "Discord only: auto-create a dedicated thread. Required when mode='session'.",
        },
        label: {
          type: "string",
          description: "Human-readable label shown in thread name and logs.",
        },
        worktree: {
          type: "boolean",
          description: "Disp8chTeam-style workspace isolation: when true, creates a dedicated git worktree for this session so the agent works on an isolated branch (branch: disp8chteam/session/<id>). Prevents file conflicts when multiple agents run in parallel. Requires a git repo in cwd. Cleaned up automatically when cleanup=delete.",
        },
      },
      required: ["task"],
    },
  },

  agent_inbox: {
    name: "agent_inbox",
    description:
      "Disp8chTeam-style point-to-point messaging between agents. " +
      "Agents can send messages to each other by agent ID or name, and receive/peek messages addressed to them. " +
      "action='send': deliver a message to another agent's inbox. " +
      "action='receive': pop the oldest unread message from your inbox. " +
      "action='peek': read the oldest unread message without consuming it. " +
      "action='list': show unread message counts per recipient. " +
      "action='broadcast': send the same message to all agents in the team. " +
      "Messages persist to disk under data/inbox/ and survive restarts.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "Operation to perform: 'send', 'receive', 'peek', 'list', 'broadcast'",
          enum: ["send", "receive", "peek", "list", "broadcast"],
        },
        to: {
          type: "string",
          description: "Recipient agent ID or name (required for send/broadcast).",
        },
        from: {
          type: "string",
          description: "Sender agent ID or name (for send). Defaults to 'orchestrator'.",
        },
        subject: {
          type: "string",
          description: "Short subject line for the message.",
        },
        content: {
          type: "string",
          description: "Message body (required for send/broadcast).",
        },
        recipient: {
          type: "string",
          description: "Agent ID to receive/peek messages for. If omitted for receive/peek, uses 'from'.",
        },
      },
      required: ["action"],
    },
  },

  init_experiment: {
    name: "init_experiment",
    description:
      "Initialize an autonomous experiment optimization session (pi-autoresearch style). " +
      "Creates autoresearch.jsonl (append-only result log), autoresearch.md (living session doc: objective, metric, attempt history), " +
      "and optionally autoresearch.sh (benchmark script). " +
      "Must be called before run_experiment/log_experiment. " +
      "Re-calling starts a new baseline segment without losing prior history — useful when pivoting optimization goals.",
    parameters: {
      type: "object",
      properties: {
        metric_name: { type: "string", description: "Name of the scalar metric to optimize (e.g. 'test_duration_ms', 'accuracy_pct', 'bundle_size_kb')" },
        metric_unit: { type: "string", description: "Unit label for the metric (e.g. 'ms', '%', 'kb')" },
        metric_direction: { type: "string", description: "Optimization direction: 'minimize' or 'maximize'", enum: ["minimize", "maximize"] },
        objective: { type: "string", description: "Human-readable description of what we're trying to achieve" },
        benchmark_command: { type: "string", description: "Shell command to run the benchmark. Must print 'METRIC name=<number>' to stdout." },
        checks_command: { type: "string", description: "Optional correctness validator command (e.g. 'npm test' or 'python -m pytest'). Runs after benchmark as a quality gate." },
        working_dir: { type: "string", description: "Working directory for the experiment. Defaults to process.cwd()." },
      },
      required: ["metric_name", "metric_direction", "objective"],
    },
  },

  run_experiment: {
    name: "run_experiment",
    description:
      "Execute the configured benchmark command and parse METRIC name=number tokens from stdout. " +
      "Returns: primary metric value, exit code, duration_ms, stdout tail (last 80 lines), and checks result. " +
      "Call init_experiment first to configure the session. " +
      "After getting results, call log_experiment with decision='keep' or 'discard'.",
    parameters: {
      type: "object",
      properties: {
        description: { type: "string", description: "What this experiment attempt tries (e.g. 'Cache query results in Redis')" },
        working_dir: { type: "string", description: "Working directory override. Defaults to init_experiment working_dir." },
        timeout_seconds: { type: "number", description: "Max time to allow the benchmark to run (default 120, max 600)." },
      },
      required: ["description"],
    },
  },

  checkpoint_create: {
    name: "checkpoint_create",
    description: "Create a named checkpoint of the current workspace state using shadow git tracking.",
    parameters: {
      type: "object",
      properties: {
        label: { type: "string", description: "Optional label/message for the checkpoint" },
      },
      required: [],
    },
  },

  checkpoint_list: {
    name: "checkpoint_list",
    description: "List recent workspace checkpoints.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max checkpoints to list (default 10, max 50)" },
      },
      required: [],
    },
  },

  checkpoint_diff: {
    name: "checkpoint_diff",
    description: "View changes between a checkpoint and the current workspace state.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The checkpoint ID (short git SHA) to compare against" },
      },
      required: ["id"],
    },
  },

  checkpoint_rollback: {
    name: "checkpoint_rollback",
    description: "Rollback the workspace files, or a single file, to a specific checkpoint. A safety checkpoint of current state is created first.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The checkpoint ID to rollback to" },
        path: { type: "string", description: "Optional file path to restore from the checkpoint instead of rolling back the entire workspace" },
      },
      required: ["id"],
    },
  },

  mcp_list: {
    name: "mcp_list",
    description: "List all currently connected MCP (Model Context Protocol) servers and their available tools.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },

  mcp_call: {
    name: "mcp_call",
    description: "Execute a tool on a connected MCP server.",
    parameters: {
      type: "object",
      properties: {
        server_name: { type: "string", description: "The name of the MCP server (from mcp_list)" },
        tool_name: { type: "string", description: "The name of the tool to execute" },
        arguments: { type: "object", description: "The arguments to pass to the tool" },
      },
      required: ["server_name", "tool_name", "arguments"],
    },
  },

  mcp_list_resources: {
    name: "mcp_list_resources",
    description: "List available MCP resources exposed by a connected server.",
    parameters: {
      type: "object",
      properties: {
        server_name: { type: "string", description: "The name of the MCP server (from mcp_list)" },
      },
      required: ["server_name"],
    },
  },

  mcp_read_resource: {
    name: "mcp_read_resource",
    description: "Read a specific MCP resource by URI from a connected server.",
    parameters: {
      type: "object",
      properties: {
        server_name: { type: "string", description: "The name of the MCP server (from mcp_list)" },
        uri: { type: "string", description: "The MCP resource URI to read" },
      },
      required: ["server_name", "uri"],
    },
  },

  mcp_list_prompts: {
    name: "mcp_list_prompts",
    description: "List prompt templates exposed by a connected MCP server.",
    parameters: {
      type: "object",
      properties: {
        server_name: { type: "string", description: "The name of the MCP server (from mcp_list)" },
      },
      required: ["server_name"],
    },
  },

  mcp_get_prompt: {
    name: "mcp_get_prompt",
    description: "Get a prompt template by name from a connected MCP server.",
    parameters: {
      type: "object",
      properties: {
        server_name: { type: "string", description: "The name of the MCP server (from mcp_list)" },
        prompt_name: { type: "string", description: "The MCP prompt name to retrieve" },
        arguments: { type: "object", description: "Optional prompt arguments" },
      },
      required: ["server_name", "prompt_name"],
    },
  },

  log_experiment: {
    name: "log_experiment",
    description:
      "Record experiment result to autoresearch.jsonl. " +
      "decision='keep': git commits all changes with metric info in the commit message. " +
      "decision='discard': git checkout reverts code changes but preserves autoresearch tracking files. " +
      "decision='crash': same as discard — registers the crash in the log. " +
      "decision='checks_failed': metric may have improved but correctness check failed — reverts and logs. " +
      "After logging, read autoresearch.md and autoresearch.ideas.md to pick the next experiment idea.",
    parameters: {
      type: "object",
      properties: {
        decision: { type: "string", description: "Outcome of the experiment", enum: ["keep", "discard", "crash", "checks_failed"] },
        metric_value: { type: "number", description: "Measured primary metric value from run_experiment output" },
        description: { type: "string", description: "Brief description of what was tried (same as run_experiment description)" },
        notes: { type: "string", description: "Optional notes: why it worked/failed, what to try next" },
        secondary_metrics: { type: "string", description: "JSON string of secondary metrics (e.g. '{\"mem_mb\": 42}')" },
        working_dir: { type: "string", description: "Working directory. Defaults to init_experiment working_dir." },
      },
      required: ["decision", "metric_value", "description"],
    },
  },

  run_python_script: {
    name: "run_python_script",
    description:
      "Write and execute a Python script in a sandboxed subprocess (no network, no secrets, isolated temp dir). " +
      "Use `tool_call(name, args_json)` to chain file operations. " +
      "Available tools: read_file, write_file, list_files, search_files, run_shell (read-only commands only). " +
      "Script output captured from stdout. " +
      "Note: web_search_ptc and http_request are not available in sandboxed PTC mode (they require network).",
    parameters: {
      type: "object",
      properties: {
        script: { type: "string", description: "Python script to execute. Use `result = tool_call('name', '{\"arg\": \"value\"}')` to call Disp8ch tools. Print final results to stdout." },
        timeout_ms: { type: "number", description: "Timeout in milliseconds (max 30000, default 15000)" },
      },
      required: ["script"],
    },
  },

  clarify: {
    name: "clarify",
    description:
      "Ask the user a clarifying question with predefined answer choices. " +
      "Use when you need disambiguation before proceeding, and the answer affects what you should do next. " +
      "The user selects one choice and the conversation continues.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "The clarifying question to ask the user" },
        choices: {
          type: "string",
          description: "2-4 predefined answer choices the user can pick from, separated by |. Each choice should be a concise label (1-5 words). Example: 'Fix all errors|Show error details first|Skip for now'",
        },
        context: { type: "string", description: "Brief explanation of why clarification is needed (shown to the user as context)" },
      },
      required: ["question", "choices"],
    },
  },

  credential_pool: {
    name: "credential_pool",
    description: "Show credential pool status for API key failover. Lists keys, failure counts, and cooldown state per provider.",
    parameters: { type: "object", properties: {}, required: [] },
  },

  moa: {
    name: "moa",
    description: "Mixture of Agents — query multiple AI models in parallel and synthesize their responses into a single verdict. Use for complex analysis, debate, or when you need diverse perspectives on a topic.",
    parameters: {
      type: "object",
      properties: {
        topic: { type: "string", description: "The topic or question to analyze" },
        models: { type: "string", description: "Comma-separated model references (e.g. 'openai:gpt-4o,google:gemini-2.0-flash')" },
      },
      required: ["topic", "models"],
    },
  },
};
