export type NodeSideEffectLevel =
  | "none"
  | "local-read"
  | "external-read"
  | "local-write"
  | "external-write"
  | "message-send";

export type NodeFieldType =
  | "string"
  | "number"
  | "boolean"
  | "select"
  | "json"
  | "code"
  | "template"
  | "secret"
  | "cron"
  | "auth";

export type NodeFieldSchema = {
  key: string;
  label: string;
  type: NodeFieldType;
  required?: boolean;
  defaultValue?: unknown;
  options?: Array<{ label: string; value: string }>;
  placeholder?: string;
  help?: string;
  /** Field appears in the UI panel but has no runtime effect */
  uiOnly?: boolean;
  /** Field is planned but not yet implemented */
  planned?: boolean;
};

export type NodeOutputField = {
  path: string;
  label: string;
  type: "string" | "number" | "boolean" | "object" | "array" | "unknown";
  description?: string;
};

export type NodeOutputSchema = {
  fields: NodeOutputField[];
};

export type NodeContractAdvancedOption = {
  key: string;
  label: string;
  /** true = this option is backed by real runtime logic; false = uiOnly or planned */
  runtimeBacked: boolean;
  /** true = the option is planned but not yet implemented */
  planned?: boolean;
};

export type NodeContractErrorConfig = {
  supportsContinueOnFail: boolean;
  supportsRetry: boolean;
};

export type NodeContract = {
  type: string;
  label: string;
  category: string;
  sideEffect: NodeSideEffectLevel;
  configFields: NodeFieldSchema[];
  inputSchema?: NodeOutputSchema;
  outputSchema: NodeOutputSchema;
  sourceHandles?: Array<{ id: string; label: string; condition?: string }>;
  targetHandles?: Array<{ id?: string; label: string }>;
  testable: boolean;
  credentialHints?: string[];
  advancedOptions?: NodeContractAdvancedOption[];
  errorConfig?: NodeContractErrorConfig;
  examples: Array<{
    name: string;
    config: Record<string, unknown>;
    sampleInput: Record<string, unknown>;
    sampleOutput: Record<string, unknown>;
  }>;
};

// ── Trigger nodes ──

const MANUAL_TRIGGER: NodeContract = {
  type: "manual-trigger",
  label: "Manual Trigger",
  category: "trigger",
  sideEffect: "none",
  configFields: [
    { key: "label", label: "Node Label", type: "string", placeholder: "Trigger name" },
  ],
  outputSchema: {
    fields: [
      { path: "triggeredAt", label: "Triggered At", type: "string", description: "ISO timestamp" },
      { path: "triggerType", label: "Trigger Type", type: "string" },
    ],
  },
  sourceHandles: [{ id: "output", label: "Output" }],
  testable: false,
  examples: [
    {
      name: "Simple manual trigger",
      config: { label: "Start" },
      sampleInput: {},
      sampleOutput: { triggeredAt: "2026-01-01T00:00:00Z", triggerType: "manual" },
    },
  ],
};

const MESSAGE_TRIGGER: NodeContract = {
  type: "message-trigger",
  label: "Message Trigger",
  category: "trigger",
  sideEffect: "none",
  configFields: [
    { key: "channel", label: "Channel", type: "select", options: [
      { label: "WebChat", value: "webchat" },
      { label: "Telegram", value: "telegram" },
      { label: "Discord", value: "discord" },
      { label: "WhatsApp", value: "whatsapp" },
      { label: "Slack", value: "slack" },
    ], required: true },
    { key: "filter", label: "Message Filter (keywords)", type: "string", placeholder: "comma,separated,keywords", help: "Comma-separated keywords; blank = accept all" },
  ],
  outputSchema: {
    fields: [
      { path: "message", label: "Message Text", type: "string" },
      { path: "sender", label: "Sender", type: "string" },
      { path: "channel", label: "Channel", type: "string" },
      { path: "sessionId", label: "Session ID", type: "string" },
    ],
  },
  sourceHandles: [{ id: "output", label: "Output" }],
  testable: false,
  credentialHints: ["TELEGRAM_BOT_TOKEN", "DISCORD_BOT_TOKEN"],
  examples: [
    {
      name: "WebChat message",
      config: { channel: "webchat" },
      sampleInput: {},
      sampleOutput: { message: "Hello", sender: "user", channel: "webchat", sessionId: "webchat:..." },
    },
  ],
};

const CRON_TRIGGER: NodeContract = {
  type: "cron-trigger",
  label: "Cron Trigger",
  category: "trigger",
  sideEffect: "none",
  configFields: [
    { key: "expression", label: "Cron Expression", type: "cron", placeholder: "0 9 * * *", required: true, help: "Standard 5-field cron: minute hour day month weekday" },
    { key: "timezone", label: "Timezone", type: "string", defaultValue: "UTC", placeholder: "America/New_York" },
  ],
  outputSchema: {
    fields: [
      { path: "triggeredAt", label: "Triggered At", type: "string" },
      { path: "expression", label: "Cron Expression", type: "string" },
    ],
  },
  sourceHandles: [{ id: "output", label: "Output" }],
  testable: false,
  examples: [
    {
      name: "Daily 9am",
      config: { expression: "0 9 * * *", timezone: "America/New_York" },
      sampleInput: {},
      sampleOutput: { triggeredAt: "2026-01-01T09:00:00-05:00", expression: "0 9 * * *" },
    },
  ],
};

const WEBHOOK_TRIGGER: NodeContract = {
  type: "webhook-trigger",
  label: "Webhook Trigger",
  category: "trigger",
  sideEffect: "none",
  configFields: [
    { key: "path", label: "Webhook Path", type: "string", placeholder: "/my-webhook" },
    { key: "secret", label: "HMAC Secret", type: "secret", help: "For verifying webhook signatures" },
  ],
  outputSchema: {
    fields: [
      { path: "body", label: "Webhook Body", type: "object" },
      { path: "headers", label: "Headers", type: "object" },
      { path: "method", label: "HTTP Method", type: "string" },
    ],
  },
  sourceHandles: [{ id: "output", label: "Output" }],
  testable: false,
  examples: [
    {
      name: "GitHub webhook",
      config: { path: "/github-webhook" },
      sampleInput: {},
      sampleOutput: { body: { action: "opened" }, headers: { "x-github-event": "issues" }, method: "POST" },
    },
  ],
};

// ── Logic nodes ──

const SET_VARIABLES: NodeContract = {
  type: "set-variables",
  label: "Set Variables",
  category: "logic",
  sideEffect: "none",
  configFields: [
    { key: "assignments", label: "Assignments", type: "json", placeholder: '[{"key":"topic","value":"launch"}]', required: false, help: "Array of key/value assignments. Values support templates." },
    { key: "variables", label: "Variables", type: "json", placeholder: '{"key": "value"}', required: false, help: "Legacy JSON object of key/value pairs" },
  ],
  outputSchema: {
    fields: [
      { path: "vars", label: "Variables", type: "object", description: "All set variables" },
    ],
  },
  sourceHandles: [{ id: "output", label: "Output" }],
  targetHandles: [{ label: "Input" }],
  testable: true,
  examples: [
    {
      name: "Set score",
      config: { variables: { score: 95, name: "test" } },
      sampleInput: { message: "hello" },
      sampleOutput: { variables: { score: 95, name: "test" } },
    },
  ],
};

const IF_ELSE: NodeContract = {
  type: "if-else",
  label: "If / Else",
  category: "logic",
  sideEffect: "none",
  configFields: [
    { key: "condition", label: "Condition", type: "string", placeholder: "score > 50", required: true, help: "expr-eval expression using upstream variables" },
  ],
  outputSchema: {
    fields: [
      { path: "branch", label: "Branch", type: "string", description: '"true" or "false"' },
      { path: "result", label: "Result", type: "unknown" },
    ],
  },
  sourceHandles: [
    { id: "true", label: "True", condition: "branch === 'true'" },
    { id: "false", label: "False", condition: "branch === 'false'" },
  ],
  targetHandles: [{ label: "Input" }],
  testable: true,
  examples: [
    {
      name: "Score check",
      config: { condition: "score > 50" },
      sampleInput: { score: 95 },
      sampleOutput: { branch: "true", result: true },
    },
  ],
};

const SWITCH_NODE: NodeContract = {
  type: "switch",
  label: "Switch",
  category: "logic",
  sideEffect: "none",
  configFields: [
    { key: "expression", label: "Expression", type: "string", placeholder: "status", required: true, help: "Variable to switch on" },
    { key: "cases", label: "Cases", type: "json", placeholder: '["ok","error","pending"]', required: true, help: "JSON array of case values" },
  ],
  outputSchema: {
    fields: [
      { path: "branch", label: "Matched Branch", type: "string" },
      { path: "value", label: "Expression Value", type: "unknown" },
    ],
  },
  sourceHandles: [{ id: "default", label: "Default" }],
  targetHandles: [{ label: "Input" }],
  testable: true,
  examples: [
    {
      name: "Status switch",
      config: { expression: "status", cases: ["ok", "error", "pending"] },
      sampleInput: { status: "ok" },
      sampleOutput: { branch: "ok", value: "ok" },
    },
  ],
};

const FILTER_NODE: NodeContract = {
  type: "filter",
  label: "Filter",
  category: "logic",
  sideEffect: "none",
  configFields: [
    { key: "condition", label: "Condition", type: "string", placeholder: "status == 'ok'", required: true },
  ],
  outputSchema: {
    fields: [
      { path: "stopped", label: "Stopped", type: "boolean" },
      { path: "result", label: "Result", type: "unknown" },
    ],
  },
  sourceHandles: [{ id: "output", label: "Output" }],
  targetHandles: [{ label: "Input" }],
  testable: true,
  examples: [
    {
      name: "Pass filter",
      config: { condition: "status == 'ok'" },
      sampleInput: { status: "ok" },
      sampleOutput: { result: true },
    },
  ],
};

const DELAY_NODE: NodeContract = {
  type: "delay",
  label: "Delay",
  category: "logic",
  sideEffect: "none",
  configFields: [
    { key: "durationMs", label: "Delay (ms)", type: "number", required: true, defaultValue: 1000 },
  ],
  outputSchema: {
    fields: [
      { path: "delayed", label: "Delayed", type: "boolean" },
      { path: "durationMs", label: "Duration", type: "number" },
    ],
  },
  sourceHandles: [{ id: "output", label: "Output" }],
  targetHandles: [{ label: "Input" }],
  testable: true,
  examples: [
    { name: "1 second delay", config: { durationMs: 1000 }, sampleInput: {}, sampleOutput: { delayed: true, durationMs: 1000 } },
  ],
};

const WEBHOOK_RESPONSE: NodeContract = {
  type: "webhook-response",
  label: "Webhook Response",
  category: "channel",
  sideEffect: "none",
  configFields: [
    { key: "statusCode", label: "Status Code", type: "number", defaultValue: 200 },
    { key: "body", label: "Response Body", type: "json", placeholder: '{"ok": true}', help: "JSON or text body. Templates are resolved from upstream data." },
    { key: "headers", label: "Headers", type: "json", placeholder: '{"x-source":"workflow"}', help: "Optional JSON object of response headers." },
  ],
  outputSchema: {
    fields: [
      { path: "webhookResponse.statusCode", label: "Status Code", type: "number" },
      { path: "webhookResponse.headers", label: "Headers", type: "object" },
      { path: "webhookResponse.body", label: "Body", type: "unknown" },
    ],
  },
  sourceHandles: [{ id: "output", label: "Output" }],
  targetHandles: [{ label: "Input" }],
  testable: true,
  examples: [
    {
      name: "Return accepted JSON",
      config: { statusCode: 202, body: '{"accepted": true}' },
      sampleInput: { body: { event: "created" } },
      sampleOutput: { webhookResponse: { statusCode: 202, headers: {}, body: { accepted: true } } },
    },
  ],
};

// ── Tool nodes ──

const RUN_CODE: NodeContract = {
  type: "run-code",
  label: "Run Code",
  category: "tool",
  sideEffect: "local-read",
  configFields: [
    { key: "code", label: "JavaScript Code", type: "code", required: true, help: "Assign to 'result' variable. Use context.get('namespace.path') for upstream data." },
    { key: "timeoutMs", label: "Timeout (ms)", type: "number", defaultValue: 10000 },
  ],
  outputSchema: {
    fields: [
      { path: "result", label: "Result", type: "unknown", description: "Value assigned to 'result' variable" },
    ],
  },
  sourceHandles: [{ id: "output", label: "Output" }],
  targetHandles: [{ label: "Input" }],
  testable: true,
  examples: [
    {
      name: "Build JSON",
      config: { code: "result = JSON.stringify({ title: input.message, status: 'inbox' })" },
      sampleInput: { message: "Fix bug" },
      sampleOutput: { result: '{"title":"Fix bug","status":"inbox"}' },
    },
  ],
};

const RSS_READ: NodeContract = {
  type: "rss-read",
  label: "RSS Read",
  category: "tool",
  sideEffect: "external-read",
  configFields: [
    { key: "url", label: "Feed URL", type: "string", placeholder: "https://example.com/feed.xml", required: true },
    { key: "limit", label: "Max items", type: "number", defaultValue: 10 },
    { key: "sinceHours", label: "Only items newer than (hours)", type: "number", defaultValue: 0, help: "0 = no time filter" },
    { key: "timeoutMs", label: "Timeout (ms)", type: "number", defaultValue: 20000 },
  ],
  outputSchema: {
    fields: [
      { path: "items", label: "Feed Items", type: "array" },
      { path: "count", label: "Item Count", type: "number" },
      { path: "feedTitle", label: "Feed Title", type: "string" },
      { path: "format", label: "Feed Format", type: "string" },
    ],
  },
  sourceHandles: [{ id: "output", label: "Output" }],
  targetHandles: [{ label: "Input" }],
  testable: true,
  examples: [
    {
      name: "Latest 5 items",
      config: { url: "https://example.com/feed.xml", limit: 5 },
      sampleInput: {},
      sampleOutput: { items: [{ title: "Post", link: "https://example.com/post" }], count: 1, feedTitle: "Example", format: "rss" },
    },
  ],
};

const HTTP_REQUEST: NodeContract = {
  type: "http-request",
  label: "HTTP Request",
  category: "tool",
  sideEffect: "external-read",
  configFields: [
    { key: "url", label: "URL", type: "string", placeholder: "https://api.example.com/data", required: true },
    { key: "method", label: "Method", type: "select", options: [
      { label: "GET", value: "GET" }, { label: "POST", value: "POST" },
      { label: "PUT", value: "PUT" }, { label: "PATCH", value: "PATCH" },
      { label: "DELETE", value: "DELETE" },
    ], defaultValue: "GET" },
    { key: "headers", label: "Headers", type: "json", placeholder: '{"Content-Type": "application/json"}', help: "JSON object of header key/values" },
    { key: "body", label: "Body", type: "template", placeholder: '{"key": "{{vars.value}}"}', help: "Supports {{template}} expressions" },
    { key: "auth", label: "Auth", type: "auth", help: "Auth header preset" },
    { key: "timeoutMs", label: "Timeout (ms)", type: "number", defaultValue: 30000 },
  ],
  outputSchema: {
    fields: [
      { path: "body", label: "Response Body", type: "object" },
      { path: "status", label: "HTTP Status", type: "number" },
      { path: "headers", label: "Response Headers", type: "object" },
    ],
  },
  sourceHandles: [{ id: "success", label: "Success" }, { id: "error", label: "Error" }],
  targetHandles: [{ label: "Input" }],
  testable: true,
  examples: [
    {
      name: "GET request",
      config: { url: "https://api.github.com/repos/user/repo", method: "GET" },
      sampleInput: {},
      sampleOutput: { body: { name: "repo" }, status: 200, headers: {} },
    },
  ],
};

// ── Agent nodes ──

const CLAUDE_AGENT: NodeContract = {
  type: "claude-agent",
  label: "AI Agent",
  category: "agent",
  sideEffect: "external-read",
  configFields: [
    { key: "systemPrompt", label: "System Prompt", type: "string", placeholder: "You are a helpful assistant..." },
    { key: "agentId", label: "Agent ID", type: "string", help: "References a configured agent for model/settings" },
    { key: "temperature", label: "Temperature", type: "number", defaultValue: 0.7 },
    { key: "maxTokens", label: "Max Tokens", type: "number" },
    { key: "toolMode", label: "Tool Mode", type: "select", options: [{ label: "Tools On", value: "on" }, { label: "Tools Off", value: "off" }], defaultValue: "on" },
    { key: "approvalMode", label: "Approval Mode", type: "select", options: [{ label: "Off", value: "off" }, { label: "Model", value: "model" }, { label: "Human", value: "human" }], defaultValue: "off" },
  ],
  outputSchema: {
    fields: [
      { path: "response", label: "Agent Response", type: "string" },
      { path: "model", label: "Model Used", type: "string" },
      { path: "costUsd", label: "Cost (USD)", type: "number" },
    ],
  },
  sourceHandles: [{ id: "output", label: "Output" }],
  targetHandles: [{ label: "Input" }],
  testable: false,
  credentialHints: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"],
  examples: [
    {
      name: "Summarize",
      config: { systemPrompt: "You are a helpful assistant." },
      sampleInput: { message: "Summarize this text..." },
      sampleOutput: { response: "Summary here...", model: "sonnet", costUsd: 0.001 },
    },
  ],
};

// ── Channel nodes ──

const SEND_WEBCHAT: NodeContract = {
  type: "send-webchat",
  label: "Send WebChat",
  category: "channel",
  sideEffect: "message-send",
  configFields: [
    { key: "message", label: "Message", type: "template", placeholder: "{{agent.response}}", required: true, help: "Supports {{template}} expressions" },
  ],
  outputSchema: {
    fields: [
      { path: "sent", label: "Sent", type: "boolean" },
      { path: "message", label: "Delivered Message", type: "string" },
    ],
  },
  sourceHandles: [{ id: "output", label: "Output" }],
  targetHandles: [{ label: "Input" }],
  testable: false,
  examples: [
    {
      name: "Send summary",
      config: { message: "{{agent.response}}" },
      sampleInput: { "agent.response": "Workflow completed successfully." },
      sampleOutput: { sent: true, message: "Workflow completed successfully." },
    },
  ],
};

// ── Memory nodes ──

const MEMORY_RECALL: NodeContract = {
  type: "memory-recall",
  label: "Memory Recall",
  category: "memory",
  sideEffect: "local-read",
  configFields: [
    { key: "query", label: "Search Query", type: "template", required: true, help: "Supports {{template}} expressions" },
    { key: "limit", label: "Max Results", type: "number", defaultValue: 5 },
  ],
  outputSchema: {
    fields: [
      { path: "results", label: "Results", type: "array", description: "Array of memory entries" },
      { path: "count", label: "Result Count", type: "number" },
    ],
  },
  sourceHandles: [{ id: "output", label: "Output" }],
  targetHandles: [{ label: "Input" }],
  testable: true,
  examples: [
    { name: "Search memory", config: { query: "project goals" }, sampleInput: {}, sampleOutput: { results: [], count: 0 } },
  ],
};

const MEMORY_STORE: NodeContract = {
  type: "memory-store",
  label: "Memory Store",
  category: "memory",
  sideEffect: "local-write",
  configFields: [
    { key: "extractMode", label: "Extract Mode", type: "select", options: [{ label: "Auto", value: "auto" }, { label: "Manual", value: "manual" }], defaultValue: "auto" },
    { key: "manualContent", label: "Content", type: "template" },
    { key: "type", label: "Type", type: "select", options: [{ label: "Fact", value: "fact" }, { label: "Preference", value: "preference" }, { label: "Note", value: "note" }], defaultValue: "note" },
    { key: "confidence", label: "Confidence", type: "number", defaultValue: 1 },
  ],
  outputSchema: {
    fields: [
      { path: "stored", label: "Stored", type: "boolean" },
      { path: "path", label: "File Path", type: "string" },
    ],
  },
  sourceHandles: [{ id: "output", label: "Output" }],
  targetHandles: [{ label: "Input" }],
  testable: true,
  examples: [
    { name: "Store fact", config: { content: "User prefers dark mode", type: "preference" }, sampleInput: {}, sampleOutput: { stored: true } },
  ],
};

// ── Board/Workflow nodes ──

const BOARD_TASK: NodeContract = {
  type: "board-task",
  label: "Board Task",
  category: "tool",
  sideEffect: "local-write",
  configFields: [
    { key: "title", label: "Title", type: "template", required: true },
    { key: "description", label: "Description", type: "template" },
    { key: "status", label: "Status", type: "select", options: [{ label: "Inbox", value: "inbox" }, { label: "In Progress", value: "in_progress" }, { label: "Review", value: "review" }], defaultValue: "inbox" },
    { key: "priority", label: "Priority", type: "select", options: [{ label: "Low", value: "low" }, { label: "Medium", value: "medium" }, { label: "High", value: "high" }, { label: "Urgent", value: "urgent" }], defaultValue: "medium" },
    { key: "boardId", label: "Board ID", type: "string" },
    { key: "safetyMode", label: "Safety Mode", type: "select", options: [{ label: "Create Only", value: "create" }, { label: "Proposal Only", value: "proposal" }], help: "Proposal stops before persisting" },
  ],
  outputSchema: {
    fields: [
      { path: "task", label: "Created Task", type: "object" },
      { path: "taskId", label: "Task ID", type: "string" },
    ],
  },
  sourceHandles: [{ id: "output", label: "Output" }],
  targetHandles: [{ label: "Input" }],
  testable: false,
  examples: [
    {
      name: "Create task",
      config: { title: "Fix login bug", priority: "high" },
      sampleInput: {},
      sampleOutput: { task: { id: "task_1", title: "Fix login bug" }, taskId: "task_1" },
    },
  ],
};

const SCHEDULER_JOB: NodeContract = {
  type: "scheduler-job",
  label: "Scheduler Job",
  category: "tool",
  sideEffect: "external-read",
  configFields: [
    { key: "workflowRef", label: "Workflow Name/ID", type: "string", required: true },
    { key: "expression", label: "Cron Expression", type: "cron", required: true },
    { key: "timezone", label: "Timezone", type: "string", defaultValue: "UTC" },
  ],
  outputSchema: {
    fields: [
      { path: "scheduled", label: "Scheduled", type: "boolean" },
      { path: "jobId", label: "Job ID", type: "string" },
    ],
  },
  sourceHandles: [{ id: "output", label: "Output" }],
  targetHandles: [{ label: "Input" }],
  testable: false,
  examples: [
    {
      name: "Schedule daily",
      config: { workflowRef: "Daily Digest", expression: "0 9 * * *" },
      sampleInput: {},
      sampleOutput: { scheduled: true, jobId: "job_1" },
    },
  ],
};

// ── Advanced logic nodes ──

const LOOP_NODE: NodeContract = {
  type: "loop",
  label: "Loop",
  category: "advanced_logic",
  sideEffect: "none",
  configFields: [
    { key: "sourcePath", label: "Array Source Path", type: "string", placeholder: "http.body.items", required: true, help: "Path to the array to iterate, e.g. 'http.body.items'" },
    { key: "maxIterations", label: "Max Iterations", type: "number", defaultValue: 100 },
    { key: "concurrency", label: "Concurrency", type: "number", defaultValue: 1, help: "Number of items to process concurrently (1 = serial)" },
    { key: "onItemError", label: "On Item Error", type: "select", options: [
      { label: "Stop loop", value: "stop" },
      { label: "Skip item", value: "skip" },
      { label: "Collect error", value: "collect" },
    ], defaultValue: "stop" },
  ],
  outputSchema: {
    fields: [
      { path: "itemCount", label: "Item Count", type: "number" },
      { path: "successCount", label: "Success Count", type: "number" },
      { path: "failureCount", label: "Failure Count", type: "number" },
      { path: "collected", label: "Collected Outputs", type: "array" },
      { path: "item", label: "Current Item", type: "object", description: "Available during loop body execution" },
      { path: "index", label: "Current Index", type: "number" },
    ],
  },
  sourceHandles: [{ id: "body", label: "Loop Body" }, { id: "output", label: "Done" }],
  targetHandles: [{ label: "Input" }],
  testable: false,
  advancedOptions: [
    { key: "concurrency", label: "Concurrency", runtimeBacked: true },
    { key: "onItemError", label: "On Item Error", runtimeBacked: true },
    { key: "maxIterations", label: "Max Iterations", runtimeBacked: true },
    { key: "loopItemContext", label: "Loop Item Context ({{loop.item}}, {{loop.index}}, {{loop.total}})", runtimeBacked: true },
    { key: "streamingResults", label: "Streaming Results", runtimeBacked: false, planned: true },
  ],
  errorConfig: { supportsContinueOnFail: false, supportsRetry: false },
  examples: [
    {
      name: "Loop over items",
      config: { sourcePath: "http.body.items", maxIterations: 10 },
      sampleInput: { "http.body": { items: [{ id: 1 }, { id: 2 }] } },
      sampleOutput: { itemCount: 2, successCount: 2, failureCount: 0, collected: [] },
    },
  ],
};

const AGGREGATE_NODE: NodeContract = {
  type: "aggregate",
  label: "Aggregate",
  category: "advanced_logic",
  sideEffect: "none",
  configFields: [
    { key: "aggregateBy", label: "Aggregate By", type: "string", help: "Field to group by" },
    { key: "outputField", label: "Output Field", type: "string", defaultValue: "collected" },
  ],
  outputSchema: {
    fields: [
      { path: "collected", label: "Collected", type: "array", description: "Aggregated items" },
      { path: "count", label: "Count", type: "number" },
    ],
  },
  sourceHandles: [{ id: "output", label: "Output" }],
  targetHandles: [{ label: "Input" }],
  testable: false,
  examples: [
    { name: "Aggregate items", config: {}, sampleInput: {}, sampleOutput: { collected: [], count: 0 } },
  ],
};

const MERGE_NODE: NodeContract = {
  type: "merge",
  label: "Merge",
  category: "advanced_logic",
  sideEffect: "none",
  configFields: [
    { key: "mergeMode", label: "Merge Mode", type: "select", options: [
      { label: "Wait for all", value: "wait-all" },
      { label: "First completed", value: "first-complete" },
      { label: "Required branches", value: "wait-required" },
    ], defaultValue: "wait-all", help: "Wait for all: every upstream branch must finish. First completed: proceed after the first branch completes. Required branches: proceed when the listed branches finish." },
    { key: "requiredSources", label: "Required branches", type: "string", placeholder: "node-id-a, Branch B", help: "Only for 'Required branches' mode: comma-separated upstream node ids or labels that must complete before this merge runs." },
    { key: "outputShape", label: "Output Shape", type: "select", options: [
      { label: "Merged Object", value: "merged-object" },
      { label: "Object by Node ID", value: "by-node-id" },
      { label: "Object by Node Label", value: "by-label" },
      { label: "Array of Outputs", value: "array" },
    ], defaultValue: "merged-object", help: "How to combine upstream outputs" },
  ],
  outputSchema: {
    fields: [
      { path: "merged", label: "Merged", type: "boolean" },
      { path: "mergeMode", label: "Merge Mode", type: "string" },
      { path: "outputShape", label: "Output Shape", type: "string" },
      { path: "upstreamCount", label: "Upstream Count", type: "number" },
      { path: "_collisions", label: "Key Collisions", type: "object", description: "Keys that collided during merge" },
    ],
  },
  sourceHandles: [{ id: "output", label: "Output" }],
  targetHandles: [{ label: "Input A" }, { label: "Input B" }],
  testable: false,
  advancedOptions: [
    { key: "mergeMode", label: "Merge Mode", runtimeBacked: true },
    { key: "outputShape", label: "Output Shape", runtimeBacked: true },
    { key: "collisionDetection", label: "Collision Detection", runtimeBacked: true },
    { key: "waitRequired", label: "Wait Required Sources", runtimeBacked: false, planned: true },
  ],
  errorConfig: { supportsContinueOnFail: false, supportsRetry: false },
  examples: [
    { name: "Merge two branches", config: { mergeMode: "wait-all", outputShape: "merged-object" }, sampleInput: {}, sampleOutput: { merged: true, upstreamCount: 2 } },
  ],
};

const ERROR_HANDLER_NODE: NodeContract = {
  type: "error-handler",
  label: "Error Handler",
  category: "advanced_logic",
  sideEffect: "none",
  configFields: [
    { key: "retryCount", label: "Retry Count", type: "number", defaultValue: 0, help: "Number of times to retry the failing upstream node (0 = no retry)" },
    { key: "retryDelayMs", label: "Retry Delay (ms)", type: "number", defaultValue: 1000 },
    { key: "continueOnFail", label: "Continue on Final Failure", type: "boolean", defaultValue: false, help: "If true, workflow continues with error payload instead of stopping" },
    { key: "onFinalError", label: "On Final Error", type: "select", options: [
      { label: "Stop workflow", value: "stop" },
      { label: "Continue with error output", value: "continue" },
    ], defaultValue: "stop" },
  ],
  outputSchema: {
    fields: [
      { path: "error", label: "Has Error", type: "boolean" },
      { path: "message", label: "Error Message", type: "string" },
      { path: "failedNodeId", label: "Failed Node ID", type: "string" },
    ],
  },
  sourceHandles: [{ id: "success", label: "Success" }, { id: "error", label: "Error" }],
  targetHandles: [{ label: "Input" }],
  testable: false,
  advancedOptions: [
    { key: "retryCount", label: "Retry Count", runtimeBacked: true },
    { key: "retryDelayMs", label: "Retry Delay", runtimeBacked: true },
    { key: "continueOnFail", label: "Continue on Final Failure", runtimeBacked: true },
    { key: "exponentialBackoff", label: "Exponential Backoff", runtimeBacked: false, planned: true },
    { key: "perErrorTypeRouting", label: "Per Error Type Routing", runtimeBacked: false, planned: true },
  ],
  errorConfig: { supportsContinueOnFail: true, supportsRetry: true },
  examples: [
    {
      name: "Catch errors",
      config: { retryCount: 1 },
      sampleInput: { error: true, message: "Request failed" },
      sampleOutput: { error: true, message: "Request failed", failedNodeId: "node_1" },
    },
  ],
};

// ── Template/Runtime nodes ──

const WORKFLOW_TEMPLATE: NodeContract = {
  type: "workflow-template",
  label: "Workflow Template",
  category: "tool",
  sideEffect: "local-write",
  configFields: [
    { key: "templateKey", label: "Template Key", type: "select", options: [], required: true },
    { key: "workflowName", label: "Workflow Name", type: "string", required: true },
  ],
  outputSchema: {
    fields: [
      { path: "created", label: "Created", type: "boolean" },
      { path: "workflowId", label: "Workflow ID", type: "string" },
    ],
  },
  sourceHandles: [{ id: "output", label: "Output" }],
  targetHandles: [{ label: "Input" }],
  testable: false,
  examples: [
    { name: "Create from template", config: { templateKey: "research-assistant", workflowName: "My Research" }, sampleInput: {}, sampleOutput: { created: true } },
  ],
};

const READ_FILE: NodeContract = {
  type: "read-file",
  label: "Read File",
  category: "tool",
  sideEffect: "local-read",
  configFields: [
    { key: "path", label: "File Path", type: "template", required: true },
    { key: "encoding", label: "Encoding", type: "select", options: [{ label: "UTF-8", value: "utf-8" }], defaultValue: "utf-8" },
  ],
  outputSchema: {
    fields: [{ path: "content", label: "File Content", type: "string" }, { path: "path", label: "File Path", type: "string" }],
  },
  sourceHandles: [{ id: "output", label: "Output" }],
  targetHandles: [{ label: "Input" }],
  testable: true,
  examples: [{ name: "Read file", config: { path: "/tmp/data.txt" }, sampleInput: {}, sampleOutput: { content: "data", path: "/tmp/data.txt" } }],
};

const WRITE_FILE: NodeContract = {
  type: "write-file",
  label: "Write File",
  category: "tool",
  sideEffect: "local-write",
  configFields: [
    { key: "path", label: "File Path", type: "template", required: true },
    { key: "content", label: "Content", type: "template", required: true },
  ],
  outputSchema: {
    fields: [{ path: "written", label: "Written", type: "boolean" }, { path: "path", label: "File Path", type: "string" }],
  },
  sourceHandles: [{ id: "output", label: "Output" }],
  targetHandles: [{ label: "Input" }],
  testable: false,
  examples: [{ name: "Write file", config: { path: "/tmp/out.txt", content: "data" }, sampleInput: {}, sampleOutput: { written: true } }],
};

const SYSTEM_COMMAND: NodeContract = {
  type: "system-command",
  label: "System Command",
  category: "tool",
  sideEffect: "external-read",
  configFields: [
    { key: "command", label: "Command", type: "select", options: [
      { label: "PC Specs", value: "pc-specs" },
      { label: "List Files", value: "list-files" },
      { label: "Move Files", value: "move-files" },
    ], required: true },
    { key: "args", label: "Arguments", type: "string" },
    { key: "sourcePath", label: "Source Path", type: "template" },
    { key: "targetPath", label: "Target Path", type: "template" },
    { key: "allowedRoot", label: "Allowed Root", type: "template" },
  ],
  outputSchema: {
    fields: [
      { path: "output", label: "Command Output", type: "string" },
      { path: "fileListing", label: "File Listing", type: "array" },
      { path: "movedFiles", label: "Moved Files", type: "array" },
    ],
  },
  sourceHandles: [{ id: "output", label: "Output" }],
  targetHandles: [{ label: "Input" }],
  testable: true,
  examples: [{ name: "List files", config: { command: "list-files", args: "src/" }, sampleInput: {}, sampleOutput: { output: "file1.ts\nfile2.ts" } }],
};

// ── Channel send nodes (side-effecting message delivery) ──
// These all deliver a message to an external channel, so they MUST be classified
// as `message-send` for the dry-run safety preview and linter side-effect notes.

const SEND_EMAIL: NodeContract = {
  type: "send-email",
  label: "Send Email",
  category: "channel",
  sideEffect: "message-send",
  configFields: [
    { key: "to", label: "To", type: "template", required: true, placeholder: "user@example.com", help: "Recipient address. Supports {{template}} expressions." },
    { key: "subject", label: "Subject", type: "template", placeholder: "Message from disp8ch" },
    { key: "body", label: "Body", type: "template", placeholder: "{{agent.response}}", help: "Falls back to upstream response/message when blank." },
    { key: "host", label: "SMTP Host", type: "string", placeholder: "smtp.gmail.com" },
    { key: "port", label: "SMTP Port", type: "number", placeholder: "587" },
    { key: "user", label: "SMTP User", type: "string" },
    { key: "pass", label: "SMTP Password", type: "secret" },
  ],
  outputSchema: { fields: [
    { path: "sent", label: "Sent", type: "boolean" },
    { path: "messageId", label: "Message ID", type: "string" },
  ] },
  sourceHandles: [{ id: "output", label: "Output" }],
  targetHandles: [{ label: "Input" }],
  testable: false,
  credentialHints: ["SMTP host/port + user/password (e.g. a Gmail app password)"],
  examples: [{ name: "Email a summary", config: { to: "me@example.com", subject: "Digest", body: "{{agent.response}}" }, sampleInput: { "agent.response": "Daily digest..." }, sampleOutput: { sent: true, messageId: "<id@smtp>" } }],
};

function channelSendContract(
  type: string,
  label: string,
  fields: NodeFieldSchema[],
  credentialHints: string[],
): NodeContract {
  return {
    type,
    label,
    category: "channel",
    sideEffect: "message-send",
    configFields: [
      { key: "message", label: "Message", type: "template", placeholder: "{{agent.response}}", help: "Falls back to upstream response/message when blank." },
      ...fields,
    ],
    outputSchema: { fields: [
      { path: "sent", label: "Sent", type: "boolean" },
      { path: "message", label: "Delivered Message", type: "string" },
    ] },
    sourceHandles: [{ id: "output", label: "Output" }],
    targetHandles: [{ label: "Input" }],
    testable: false,
    credentialHints,
    examples: [{ name: `Send via ${label}`, config: { message: "{{agent.response}}" }, sampleInput: { "agent.response": "Done." }, sampleOutput: { sent: true, message: "Done." } }],
  };
}

const SEND_TELEGRAM = channelSendContract("send-telegram", "Send Telegram",
  [{ key: "to", label: "Chat ID", type: "template", placeholder: "{{message.chatId}}", help: "Telegram chat/user id. Falls back to the triggering chat." }],
  ["Telegram bot token (configured in Channels/Settings)"]);
const SEND_DISCORD = channelSendContract("send-discord", "Send Discord",
  [{ key: "channelId", label: "Channel ID", type: "string" }, { key: "webhookId", label: "Webhook ID", type: "string" }],
  ["Discord bot token or webhook (configured in Channels/Settings)"]);
const SEND_SLACK = channelSendContract("send-slack", "Send Slack",
  [{ key: "channel", label: "Channel", type: "string", placeholder: "#general" }, { key: "channelId", label: "Channel ID", type: "string" }, { key: "blocksJson", label: "Blocks (JSON)", type: "json" }],
  ["Slack bot token (configured in Channels/Settings)"]);
const SEND_SMS = channelSendContract("send-sms", "Send SMS",
  [{ key: "to", label: "To", type: "template", placeholder: "+15551234567" }, { key: "mockMode", label: "Mock Mode", type: "boolean", help: "When enabled or when Twilio credentials are absent, return a staged delivery result without sending." }],
  ["TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER"]);

const GITHUB_TRIGGER: NodeContract = {
  type: "github-trigger",
  label: "GitHub Trigger",
  category: "trigger",
  sideEffect: "none",
  configFields: [
    { key: "events", label: "Events (filter)", type: "string", placeholder: "pull_request, issues, push", help: "Comma-separated GitHub event names; blank = accept all." },
  ],
  outputSchema: { fields: [
    { path: "event", label: "Event", type: "string" },
    { path: "action", label: "Action", type: "string" },
    { path: "repo", label: "Repository", type: "string" },
    { path: "number", label: "PR/Issue Number", type: "number" },
    { path: "title", label: "Title", type: "string" },
    { path: "author", label: "Author", type: "string" },
    { path: "diffUrl", label: "Diff URL", type: "string" },
    { path: "body", label: "Body", type: "string" },
  ] },
  sourceHandles: [{ id: "output", label: "Output" }],
  testable: false,
  examples: [{ name: "PR opened", config: { events: "pull_request" }, sampleInput: { body: { action: "opened", pull_request: { number: 7, title: "Fix" } } }, sampleOutput: { event: "pull_request", action: "opened", number: 7 } }],
};

const GITHUB_COMMENT: NodeContract = {
  type: "github-comment",
  label: "GitHub Comment",
  category: "channel",
  sideEffect: "external-write",
  configFields: [
    { key: "repo", label: "Repository", type: "template", required: true, placeholder: "owner/name" },
    { key: "issueNumber", label: "Issue / PR Number", type: "template", required: true, placeholder: "{{github-trigger.number}}" },
    { key: "body", label: "Comment Body", type: "template", placeholder: "{{claude-agent.response}}", help: "Supports {{templates}}. [SILENT] or empty suppresses the comment." },
    { key: "mockMode", label: "Mock Mode", type: "boolean", help: "When enabled or when GITHUB_TOKEN is absent, return a staged result without posting." },
  ],
  outputSchema: { fields: [
    { path: "posted", label: "Posted", type: "boolean" },
    { path: "htmlUrl", label: "Comment URL", type: "string" },
    { path: "commentId", label: "Comment ID", type: "string" },
  ] },
  sourceHandles: [{ id: "output", label: "Output" }],
  targetHandles: [{ label: "Input" }],
  testable: false,
  credentialHints: ["GITHUB_TOKEN (repo or pull-request write scope)"],
  examples: [{ name: "Post review", config: { repo: "owner/name", issueNumber: "7", body: "LGTM" }, sampleInput: {}, sampleOutput: { posted: true, mock: true } }],
};
const SEND_TEAMS = channelSendContract("send-teams", "Send Teams",
  [{ key: "serviceUrl", label: "Service URL", type: "string" }, { key: "conversationId", label: "Conversation ID", type: "string" }],
  ["Microsoft Teams bot credentials (configured in Channels/Settings)"]);
const SEND_WHATSAPP = channelSendContract("send-whatsapp", "Send WhatsApp",
  [{ key: "to", label: "To", type: "template", placeholder: "+15551234567" }],
  ["WhatsApp provider credentials (configured in Channels/Settings)"]);
const SEND_BLUEBUBBLES = channelSendContract("send-bluebubbles", "Send iMessage (BlueBubbles)",
  [{ key: "chatGuid", label: "Chat GUID", type: "string" }],
  ["BlueBubbles server URL + password (configured in Channels/Settings)"]);

const NOTIFICATION_NODE: NodeContract = {
  type: "notification",
  label: "Notification",
  category: "channel",
  sideEffect: "message-send",
  configFields: [
    { key: "title", label: "Title", type: "template", placeholder: "Workflow alert" },
    { key: "message", label: "Message", type: "template", placeholder: "{{agent.response}}" },
  ],
  outputSchema: { fields: [{ path: "notified", label: "Notified", type: "boolean" }] },
  sourceHandles: [{ id: "output", label: "Output" }],
  targetHandles: [{ label: "Input" }],
  testable: false,
  examples: [{ name: "Desktop alert", config: { title: "Done", message: "{{agent.response}}" }, sampleInput: {}, sampleOutput: { notified: true } }],
};

const DATABASE_QUERY: NodeContract = {
  type: "database-query",
  label: "Database Query",
  category: "data",
  sideEffect: "local-write",
  configFields: [
    { key: "dbPath", label: "Database Path", type: "string", placeholder: "./data/disp8ch.db", help: "Path to a local SQLite database. Leave blank to use the app database." },
    { key: "query", label: "SQL Query", type: "code", required: true, placeholder: "SELECT * FROM items LIMIT 10", help: "SELECT reads; INSERT/UPDATE/DELETE write." },
  ],
  outputSchema: { fields: [
    { path: "rows", label: "Rows", type: "array" },
    { path: "rowCount", label: "Row Count", type: "number" },
  ] },
  sourceHandles: [{ id: "output", label: "Output" }],
  targetHandles: [{ label: "Input" }],
  testable: true,
  examples: [{ name: "Read rows", config: { dbPath: "./data/app.db", query: "SELECT * FROM items LIMIT 10" }, sampleInput: {}, sampleOutput: { rows: [], rowCount: 0 } }],
};

const GIT_OPERATION: NodeContract = {
  type: "git-operation",
  label: "Git Operation",
  category: "tool",
  sideEffect: "local-write",
  configFields: [
    { key: "operation", label: "Operation", type: "select", options: [
      { label: "Status", value: "status" },
      { label: "Add", value: "add" },
      { label: "Commit", value: "commit" },
      { label: "Pull", value: "pull" },
      { label: "Push", value: "push" },
      { label: "Log", value: "log" },
    ], required: true },
    { key: "repoPath", label: "Repository Path", type: "string", placeholder: ".", help: "Local git repository directory." },
  ],
  outputSchema: { fields: [{ path: "output", label: "Git Output", type: "string" }] },
  sourceHandles: [{ id: "output", label: "Output" }],
  targetHandles: [{ label: "Input" }],
  testable: true,
  examples: [{ name: "Status", config: { operation: "status", repoPath: "." }, sampleInput: {}, sampleOutput: { output: "On branch main" } }],
};

// ── Channel/message triggers (parity with message-trigger) ──

function channelTriggerContract(type: string, label: string, channel: string): NodeContract {
  return {
    type,
    label,
    category: "trigger",
    sideEffect: "none",
    configFields: [
      { key: "filter", label: "Route Keywords (optional)", type: "string", placeholder: "task, board, /start", help: "Comma-separated keywords; blank = match all messages." },
    ],
    outputSchema: { fields: [
      { path: "message", label: "Message Text", type: "string" },
      { path: "sender", label: "Sender", type: "string" },
      { path: "channel", label: "Channel", type: "string", description: channel },
      { path: "chatId", label: "Chat ID", type: "string" },
    ] },
    sourceHandles: [{ id: "output", label: "Output" }],
    testable: false,
    examples: [{ name: `${label} message`, config: { filter: "" }, sampleInput: {}, sampleOutput: { message: "hi", sender: "user", channel } }],
  };
}
const TELEGRAM_TRIGGER = channelTriggerContract("telegram-trigger", "Telegram Trigger", "telegram");
const DISCORD_TRIGGER = channelTriggerContract("discord-trigger", "Discord Trigger", "discord");

// ── Data / transform nodes (pure, no side effects) ──

const DATE_TIME: NodeContract = {
  type: "date-time",
  label: "Date / Time",
  category: "data",
  sideEffect: "none",
  configFields: [
    { key: "operation", label: "Operation", type: "select", required: true, options: [
      { label: "Now", value: "now" }, { label: "Add", value: "add" }, { label: "Subtract", value: "subtract" },
      { label: "Format", value: "format" }, { label: "Difference", value: "diff" },
    ] },
    { key: "input", label: "Input Date", type: "template", placeholder: "{{trigger.timestamp}} or blank for now" },
    { key: "amount", label: "Amount", type: "number", help: "For add/subtract." },
    { key: "unit", label: "Unit", type: "select", options: [
      { label: "Minutes", value: "minutes" }, { label: "Hours", value: "hours" }, { label: "Days", value: "days" },
      { label: "Weeks", value: "weeks" }, { label: "Months", value: "months" },
    ] },
    { key: "outputStyle", label: "Output Style", type: "select", options: [
      { label: "ISO", value: "iso" }, { label: "Date", value: "date" }, { label: "Time", value: "time" }, { label: "Date+Time", value: "datetime" },
    ] },
    { key: "timezone", label: "Timezone", type: "string", placeholder: "UTC" },
    { key: "locale", label: "Locale", type: "string", placeholder: "en-US" },
  ],
  outputSchema: { fields: [{ path: "result", label: "Result", type: "string" }] },
  sourceHandles: [{ id: "output", label: "Output" }],
  targetHandles: [{ label: "Input" }],
  testable: true,
  examples: [{ name: "Now (ISO)", config: { operation: "now", outputStyle: "iso" }, sampleInput: {}, sampleOutput: { result: "2026-01-01T00:00:00Z" } }],
};

const JSON_TRANSFORM: NodeContract = {
  type: "json-transform",
  label: "JSON Transform",
  category: "data",
  sideEffect: "none",
  configFields: [
    { key: "expression", label: "Expression", type: "code", placeholder: "data.items.map(i => i.name)", help: "JS expression over the incoming `data`." },
    { key: "transform", label: "Quick Transform", type: "string", placeholder: "sort | unique | flatten", help: "Optional named transform." },
  ],
  outputSchema: { fields: [{ path: "result", label: "Result", type: "unknown" }] },
  sourceHandles: [{ id: "output", label: "Output" }],
  targetHandles: [{ label: "Input" }],
  testable: true,
  examples: [{ name: "Pluck names", config: { expression: "data.items.map(i => i.name)" }, sampleInput: { items: [{ name: "a" }] }, sampleOutput: { result: ["a"] } }],
};

const SPLIT_TEXT: NodeContract = {
  type: "split-text",
  label: "Split Text",
  category: "data",
  sideEffect: "none",
  configFields: [
    { key: "text", label: "Text", type: "template", placeholder: "{{agent.response}}" },
    { key: "mode", label: "Mode", type: "select", required: true, options: [
      { label: "By Characters", value: "characters" }, { label: "By Words", value: "words" }, { label: "By Separator", value: "separator" },
    ] },
    { key: "chunkSize", label: "Chunk Size", type: "number", help: "For characters/words modes." },
    { key: "separator", label: "Separator", type: "string", placeholder: "\\n\\n", help: "For separator mode." },
  ],
  outputSchema: { fields: [
    { path: "chunks", label: "Chunks", type: "array" },
    { path: "count", label: "Count", type: "number" },
  ] },
  sourceHandles: [{ id: "output", label: "Output" }],
  targetHandles: [{ label: "Input" }],
  testable: true,
  examples: [{ name: "Split paragraphs", config: { mode: "separator", separator: "\n\n" }, sampleInput: { text: "a\n\nb" }, sampleOutput: { chunks: ["a", "b"], count: 2 } }],
};

// ── Tool / knowledge / agent nodes ──

const CHANNEL_STATUS: NodeContract = {
  type: "channel-status",
  label: "Channel Status",
  category: "channel",
  sideEffect: "external-read",
  configFields: [
    { key: "format", label: "Format", type: "select", options: [
      { label: "Summary", value: "summary" }, { label: "JSON", value: "json" },
    ] },
  ],
  outputSchema: { fields: [{ path: "status", label: "Status", type: "object" }] },
  sourceHandles: [{ id: "output", label: "Output" }],
  targetHandles: [{ label: "Input" }],
  testable: true,
  examples: [{ name: "Summary", config: { format: "summary" }, sampleInput: {}, sampleOutput: { status: { webchat: "ready" } } }],
};

const CLIPBOARD_NODE: NodeContract = {
  type: "clipboard",
  label: "Clipboard",
  category: "tool",
  sideEffect: "local-write",
  configFields: [
    { key: "action", label: "Action", type: "select", required: true, options: [
      { label: "Read", value: "read" }, { label: "Write", value: "write" },
    ] },
    { key: "content", label: "Content", type: "template", placeholder: "{{agent.response}}", help: "Text to write (write action)." },
  ],
  outputSchema: { fields: [{ path: "content", label: "Content", type: "string" }] },
  sourceHandles: [{ id: "output", label: "Output" }],
  targetHandles: [{ label: "Input" }],
  testable: false,
  examples: [{ name: "Read clipboard", config: { action: "read" }, sampleInput: {}, sampleOutput: { content: "copied text" } }],
};

const DOCUMENT_TOOL: NodeContract = {
  type: "document-tool",
  label: "Document Tool",
  category: "data",
  sideEffect: "local-write",
  configFields: [
    { key: "action", label: "Action", type: "select", required: true, options: [
      { label: "Search", value: "search" }, { label: "Get", value: "get" }, { label: "List", value: "list" },
      { label: "Scrape URL", value: "scrape" }, { label: "Delete", value: "delete" },
    ] },
    { key: "query", label: "Query", type: "template", placeholder: "search terms", help: "For search." },
    { key: "documentId", label: "Document ID", type: "string", help: "For get/delete." },
    { key: "documentName", label: "Document Name", type: "string" },
    { key: "url", label: "URL", type: "string", placeholder: "https://...", help: "For scrape." },
    { key: "strategy", label: "Scrape Strategy", type: "select", options: [
      { label: "Auto", value: "auto" }, { label: "Static", value: "static" }, { label: "Dynamic", value: "dynamic" },
    ] },
    { key: "limit", label: "Limit", type: "number" },
    { key: "maxDepth", label: "Max Crawl Depth", type: "number" },
    { key: "maxPages", label: "Max Pages", type: "number" },
  ],
  outputSchema: { fields: [
    { path: "results", label: "Results", type: "array" },
    { path: "content", label: "Content", type: "string" },
  ] },
  sourceHandles: [{ id: "output", label: "Output" }],
  targetHandles: [{ label: "Input" }],
  testable: true,
  examples: [{ name: "Search docs", config: { action: "search", query: "pricing" }, sampleInput: {}, sampleOutput: { results: [] } }],
};

const COUNCIL_NODE: NodeContract = {
  type: "council",
  label: "Council",
  category: "agent",
  sideEffect: "external-read",
  configFields: [
    { key: "topic", label: "Topic", type: "template", required: true, placeholder: "Should we ship Friday?" },
    { key: "agentIds", label: "Agent IDs", type: "string", placeholder: "comma-separated agent ids (blank = auto)" },
    { key: "decisionMode", label: "Decision Mode", type: "select", options: [
      { label: "Consensus", value: "consensus" }, { label: "Majority", value: "majority" },
    ] },
    { key: "optionsText", label: "Options", type: "string", placeholder: "Option A, Option B" },
  ],
  outputSchema: { fields: [
    { path: "decision", label: "Decision", type: "string" },
    { path: "transcript", label: "Transcript", type: "string" },
  ] },
  sourceHandles: [{ id: "output", label: "Output" }],
  targetHandles: [{ label: "Input" }],
  testable: false,
  examples: [{ name: "Council vote", config: { topic: "OCR vs manual review", decisionMode: "consensus" }, sampleInput: {}, sampleOutput: { decision: "OCR" } }],
};

const PARALLEL_AGENTS: NodeContract = {
  type: "parallel-agents",
  label: "Parallel Agents",
  category: "agent",
  sideEffect: "external-read",
  configFields: [
    { key: "workers", label: "Workers (JSON)", type: "json", help: "Array of worker definitions, or use a task template." },
    { key: "taskTemplate", label: "Task Template", type: "template", placeholder: "Research {{item}}" },
    { key: "maxParallel", label: "Max Parallel", type: "number", placeholder: "3" },
  ],
  outputSchema: { fields: [{ path: "results", label: "Worker Results", type: "array" }] },
  sourceHandles: [{ id: "output", label: "Output" }],
  targetHandles: [{ label: "Input" }],
  testable: false,
  examples: [{ name: "Fan-out research", config: { taskTemplate: "Research {{item}}", maxParallel: 3 }, sampleInput: {}, sampleOutput: { results: [] } }],
};

const INTEGRATION_AGENT: NodeContract = {
  type: "integration-agent",
  label: "Integration Agent",
  category: "agent",
  sideEffect: "external-write",
  configFields: [
    { key: "serviceName", label: "Service Name", type: "string", required: true, placeholder: "Custom API" },
    { key: "baseUrl", label: "Base URL", type: "string", placeholder: "https://api.example.com" },
    { key: "objective", label: "Objective", type: "template", required: true, placeholder: "Read customer records, then create a ticket" },
    { key: "authScheme", label: "Auth Scheme", type: "select", options: [
      { label: "None", value: "none" }, { label: "Bearer", value: "bearer" }, { label: "Header", value: "header" },
    ] },
    { key: "authHeaderName", label: "Auth Header Name", type: "string", placeholder: "Authorization" },
    { key: "authToken", label: "Auth Token", type: "secret" },
  ],
  outputSchema: { fields: [{ path: "result", label: "Result", type: "unknown" }] },
  sourceHandles: [{ id: "output", label: "Output" }],
  targetHandles: [{ label: "Input" }],
  testable: false,
  credentialHints: ["API base URL + auth token for the target service"],
  examples: [{ name: "Call an API", config: { serviceName: "Tickets", objective: "Create a ticket" }, sampleInput: {}, sampleOutput: { result: { id: 1 } } }],
};

// ── Registry ──

const ALL_CONTRACTS: NodeContract[] = [
  MANUAL_TRIGGER, MESSAGE_TRIGGER, CRON_TRIGGER, WEBHOOK_TRIGGER, TELEGRAM_TRIGGER, DISCORD_TRIGGER, GITHUB_TRIGGER,
  SET_VARIABLES, IF_ELSE, SWITCH_NODE, FILTER_NODE, DELAY_NODE,
  RUN_CODE, HTTP_REQUEST, RSS_READ, READ_FILE, WRITE_FILE, SYSTEM_COMMAND,
  CLAUDE_AGENT, INTEGRATION_AGENT, PARALLEL_AGENTS, COUNCIL_NODE,
  SEND_WEBCHAT, WEBHOOK_RESPONSE,
  SEND_EMAIL, SEND_TELEGRAM, SEND_DISCORD, SEND_SMS, SEND_SLACK, SEND_TEAMS, SEND_WHATSAPP, SEND_BLUEBUBBLES, GITHUB_COMMENT,
  NOTIFICATION_NODE, DATABASE_QUERY, GIT_OPERATION,
  DATE_TIME, JSON_TRANSFORM, SPLIT_TEXT, CHANNEL_STATUS, CLIPBOARD_NODE, DOCUMENT_TOOL,
  MEMORY_RECALL, MEMORY_STORE,
  BOARD_TASK, SCHEDULER_JOB,
  LOOP_NODE, AGGREGATE_NODE, MERGE_NODE, ERROR_HANDLER_NODE,
  WORKFLOW_TEMPLATE,
];

const contractByType = new Map<string, NodeContract>(
  ALL_CONTRACTS.map((c) => [c.type, c]),
);

export function getNodeContract(nodeType: string): NodeContract | undefined {
  return contractByType.get(nodeType);
}

export function getNodeContractOrFallback(nodeType: string): NodeContract {
  return contractByType.get(nodeType) ?? {
    type: nodeType,
    label: nodeType,
    category: "unknown",
    sideEffect: "none",
    configFields: [{ key: "label", label: "Node Label", type: "string" }],
    outputSchema: { fields: [{ path: "output", label: "Output", type: "unknown" }] },
    sourceHandles: [{ id: "output", label: "Output" }],
    targetHandles: [{ label: "Input" }],
    testable: false,
    examples: [],
  };
}

export function getAllNodeContracts(): NodeContract[] {
  return ALL_CONTRACTS;
}

export function isMutatingNode(nodeType: string): boolean {
  const c = contractByType.get(nodeType);
  return c?.sideEffect === "local-write" || c?.sideEffect === "external-write" || c?.sideEffect === "message-send";
}

export function isReadOnlyNode(nodeType: string): boolean {
  const c = contractByType.get(nodeType);
  return !c || c.sideEffect === "none" || c.sideEffect === "local-read" || c.sideEffect === "external-read";
}

export function getNodesRequiringCredentials(): NodeContract[] {
  return ALL_CONTRACTS.filter((c) => c.credentialHints && c.credentialHints.length > 0);
}

/**
 * Returns true if the given node contract has the specified advanced option
 * and that option has runtimeBacked: true.
 *
 * Used by regression scripts to verify contract/runtime parity.
 */
export function assertContractOptionRuntimeBacked(nodeType: string, optionKey: string): boolean {
  const contract = contractByType.get(nodeType);
  if (!contract?.advancedOptions) return false;
  const option = contract.advancedOptions.find((o) => o.key === optionKey);
  return option?.runtimeBacked === true;
}
