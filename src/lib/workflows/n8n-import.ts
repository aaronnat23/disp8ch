import { nanoid } from "nanoid";

// ─── n8n JSON types ──────────────────────────────────────────────────────────

interface N8nWorkflow {
  name?: string;
  nodes: N8nNode[];
  connections: N8nConnections;
  active?: boolean;
  settings?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  tags?: Array<{ id: string; name: string }>;
  pinData?: Record<string, unknown>;
}

interface N8nNode {
  id?: string;
  name: string;
  type: string;
  typeVersion?: number;
  position: [number, number];
  parameters?: Record<string, unknown>;
  credentials?: Record<string, unknown>;
  disabled?: boolean;
  notes?: string;
  onError?: string;
}

interface N8nConnections {
  [sourceNodeName: string]: {
    main?: Array<Array<{ node: string; type: string; index: number }>>;
    ai_languageModel?: Array<Array<{ node: string; type: string; index: number }>>;
    [key: string]: Array<Array<{ node: string; type: string; index: number }>> | undefined;
  };
}

// ─── disp8ch output types ─────────────────────────────────────────────────────

export interface ImportedWorkflowNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: Record<string, unknown>;
}

export interface ImportedWorkflowEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
}

export interface N8nImportResult {
  name: string;
  description: string;
  nodes: ImportedWorkflowNode[];
  edges: ImportedWorkflowEdge[];
  warnings: string[];
  pinData: Record<string, { dataJson: string; nodeName: string }>;
  notes: Array<{ nodeId: string; text: string }>;
  credentialsPlaceholders: Array<{ nodeName: string; credentialType: string }>;
  stats: { total: number; mapped: number; unsupported: number; skipped: number; };
  compatibilityReport: {
    supportedNodes: Array<{ nodeName: string; n8nType: string; disp8chType: string }>;
    partiallySupportedNodes: Array<{ nodeName: string; n8nType: string; disp8chType: string; warnings: string[] }>;
    unsupportedNodes: Array<{ nodeName: string; n8nType: string; placeholderNodeId: string }>;
    credentialPlaceholders: Array<{ nodeName: string; credentialType: string }>;
    expressionTranslations: Array<{ nodeName: string; field: string; from: string; to: string }>;
    codeTranslations: Array<{ nodeName: string; warning: string }>;
    manualRepairSteps: string[];
  };
}

// ─── Parameter translators ───────────────────────────────────────────────────

function mapHttpRequest(p: Record<string, unknown>): Record<string, unknown> {
  return {
    label: "HTTP Request",
    url: String(p.url || ""),
    method: String(p.method || "GET").toUpperCase(),
    body: p.body ? JSON.stringify(p.body) : "",
    headers: p.headerParameters
      ? JSON.stringify(p.headerParameters)
      : p.headers
        ? JSON.stringify(p.headers)
        : "",
  };
}

function mapCronTrigger(p: Record<string, unknown>): Record<string, unknown> {
  // n8n scheduleTrigger has rule.interval array or cronExpression
  const cronExpr = p.cronExpression as string | undefined;
  if (cronExpr) return { label: "Cron Trigger", expression: cronExpr };

  // Try to convert interval-based schedules
  const rule = p.rule as Record<string, unknown> | undefined;
  if (rule) {
    const interval = (rule.interval as Array<Record<string, unknown>> | undefined)?.[0];
    if (interval) {
      const field1 = interval.field1 as string | undefined;
      // Best-effort mapping of common intervals
      if (field1 === "hours") return { label: "Cron Trigger", expression: "0 * * * *" };
      if (field1 === "days") return { label: "Cron Trigger", expression: "0 9 * * *" };
      if (field1 === "weeks") return { label: "Cron Trigger", expression: "0 9 * * 1" };
    }
  }
  return { label: "Cron Trigger", expression: "0 * * * *" };
}

function mapSetVariables(p: Record<string, unknown>): Record<string, unknown> {
  // n8n set node v3.4 uses assignments.assignments array
  const assignments = (p.assignments as Record<string, unknown> | undefined)?.assignments as
    | Array<{ name: string; value: unknown }>
    | undefined;
  if (assignments) {
    return {
      label: "Set Variables",
      assignments: assignments
        .filter((a) => Boolean(a.name))
        .map((a) => ({
          key: String(a.name),
          value: String(a.value ?? ""),
        })),
    };
  }
  // Legacy format: values.string[] array
  const values = p.values as Record<string, unknown> | undefined;
  if (values) {
    const stringVals = values.string as Array<{ name: string; value: unknown }> | undefined;
    if (stringVals) {
      return {
        label: "Set Variables",
        assignments: stringVals
          .filter((v) => Boolean(v.name))
          .map((v) => ({
            key: String(v.name),
            value: String(v.value ?? ""),
          })),
      };
    }
  }
  return { label: "Set Variables", assignments: [] };
}

function mapIfElse(p: Record<string, unknown>): Record<string, unknown> {
  // Best-effort condition extraction
  const conditions = p.conditions as Record<string, unknown> | undefined;
  if (conditions) {
    const conds = conditions.conditions as Array<{
      leftValue?: unknown;
      rightValue?: unknown;
      operator?: { operation?: string };
    }> | undefined;
    if (conds && conds.length > 0) {
      const c = conds[0];
      const left = normalizeImportedExpression(c.leftValue);
      const right = c.rightValue ?? "";
      const op = c.operator?.operation || "equals";
      const opMap: Record<string, string> = {
        equals: "==",
        notEquals: "!=",
        contains: "contains",
        gt: ">",
        gte: ">=",
        lt: "<",
        lte: "<=",
      };
      return { label: "If / Else", condition: `${left} ${opMap[op] || "=="} ${JSON.stringify(right)}` };
    }
  }
  return { label: "If / Else", condition: "true" };
}

function mapRunCode(p: Record<string, unknown>): Record<string, unknown> {
  const rawCode = String(p.jsCode || p.code || p.pythonCode || "// imported from n8n\n");
  const transpiled = transpileN8nCode(rawCode);
  return { label: "Run Code", code: transpiled };
}

// Transpile common n8n code-node patterns to disp8ch run-code sandbox patterns.
// n8n uses `return items` / `$json` / `$input.item.json`; disp8ch's sandbox
// uses `result = ...` and receives the upstream `input` as the data object.
// Basic transpilation handles the most common patterns; complex code nodes
// are preserved with a warning comment.
function transpileN8nCode(code: string): string {
  let result = code;

  // n8n's $input.item.json → input (the upstream node output)
  result = result.replace(/\$input\.item\.json\b/g, "input");

  // n8n's $json.field → input.field (when used inside a map callback, $json
  // refers to the current item; it's roughly equivalent to our input in most
  // single-node contexts)
  result = result.replace(/\$json\b/g, "input");

  // n8n's $item(0).$node["NodeName"].json → input shorthand
  result = result.replace(/\$item\(0\)\.\$node\["([^"]+)".*?json\b/g, "input");

  // n8n's items[...] → our sandbox gets a single data item, not an array
  // pattern: items.map(item => ({ json: result })) → result = result
  const returnItemsMap = /return\s+items\.map\s*\(\s*(?:\(?\s*(\w+)\s*\)?)\s*=>/;
  if (returnItemsMap.test(result)) {
    const match = result.match(returnItemsMap);
    const itemVar = match?.[1] ?? "item";
    // Replace the whole return pattern
    result = result.replace(
      /return\s+items\.map\s*\(\s*(?:\(?\s*\w+\s*\)?)\s*=>\s*\(\s*\{\s*json:\s*(\{[^}]+\}|[^,}]+)/,
      `result = $1`,
    );
  }

  // n8n's return [{ json: { ... } }] → result = { ... }
  result = result.replace(
    /return\s*\[\s*\{\s*json:\s*(\{[^}]+\}|[^,}]+)/,
    `result = $1`,
  );

  // n8n's return items → result = items (simplest case)
  result = result.replace(/^return\s+items\s*;?\s*$/m, "result = items;");

  // n8n's item.json → (already handled by $json replacement, but catch leftovers)
  result = result.replace(/\bitem\.json\b/g, "input");

  // If the code still has unhandled n8n patterns, add a warning comment
  if (/\b(?:return\s+items|items\.|\.json|\$node)\b/.test(result)) {
    result = [
      "// NOTE: This code was auto-imported from n8n. Key patterns may need",
      "// adaptation (n8n uses `return items`, `$json`, `$node`, etc;",
      "// disp8ch's sandbox uses `result = ...` and receives upstream data as `input`).",
      "// Review before running.",
      "",
      result,
    ].join("\n");
  }

  return result;
}

function mapTelegram(p: Record<string, unknown>): Record<string, unknown> {
  const chatId = String(p.chatId || p.chat_id || "");
  return { label: "Send Telegram", chatId };
}

function mapDiscord(p: Record<string, unknown>): Record<string, unknown> {
  const channelId = String(p.webhookId || p.channel || "");
  return { label: "Send Discord", channelId };
}

function mapSlack(p: Record<string, unknown>): Record<string, unknown> {
  const channelId = String(p.channel || "#general");
  return { label: "Send Slack", channelId };
}

function mapSendEmail(p: Record<string, unknown>): Record<string, unknown> {
  return {
    label: "Send Email",
    host: String(p.host || ""),
    port: Number(p.port || 587),
    subject: String(p.subject || ""),
    to: String(p.toEmail || p.to || ""),
  };
}

function mapSwitch(p: Record<string, unknown>): Record<string, unknown> {
  const rules = p.rules as Record<string, unknown> | undefined;
  const cases: string[] = [];
  if (rules) {
    const ruleArr = rules.rules as Array<{ value1?: unknown; value2?: unknown }> | undefined;
    if (ruleArr) {
      for (const r of ruleArr) {
        cases.push(String(r.value2 ?? ""));
      }
    }
  }
  return {
    label: "Switch",
    expression: normalizeImportedExpression(p.dataPropertyName || p.value || ""),
    cases,
  };
}

function mapDelay(p: Record<string, unknown>): Record<string, unknown> {
  const amount = Number(p.amount || 1);
  const unit = String(p.unit || "seconds");
  const ms = unit === "seconds" ? amount * 1000 : unit === "minutes" ? amount * 60000 : amount;
  return { label: "Delay", duration: ms };
}

function mapWebhookTrigger(p: Record<string, unknown>): Record<string, unknown> {
  return { label: "Webhook Trigger", path: String(p.path || "/webhook") };
}

function mapReadFile(p: Record<string, unknown>): Record<string, unknown> {
  return { label: "Read File", path: String(p.filePath || p.fileName || "") };
}

function mapWriteFile(p: Record<string, unknown>): Record<string, unknown> {
  return { label: "Write File", path: String(p.fileName || p.filePath || "") };
}

function mapFilter(p: Record<string, unknown>): Record<string, unknown> {
  return { label: "Filter", condition: "true" };
}

function mapAggregate(_p: Record<string, unknown>): Record<string, unknown> {
  return { label: "Aggregate" };
}

function mapMerge(_p: Record<string, unknown>): Record<string, unknown> {
  return { label: "Merge" };
}

function mapLoop(p: Record<string, unknown>): Record<string, unknown> {
  return {
    label: "Loop",
    batchSize: Number(p.batchSize || 10),
    sourcePath: String(p.sourcePath || ""),
  };
}

function mapGitOperation(p: Record<string, unknown>): Record<string, unknown> {
  return {
    label: "Git Operation",
    action: String(p.operation || "status"),
    repoPath: String(p.repositoryPath || "."),
  };
}

function mapArchive(p: Record<string, unknown>): Record<string, unknown> {
  const action = String(p.operation || "create");
  return {
    label: "Archive",
    action: action === "compress" ? "create" : action,
  };
}

function mapExecuteCommand(p: Record<string, unknown>): Record<string, unknown> {
  return {
    label: "System Command",
    action: "command",
    command: String(p.command || ""),
  };
}

function mapLangchainAgent(p: Record<string, unknown>): Record<string, unknown> {
  return {
    label: "AI Agent",
    systemPrompt: String(p.systemMessage || "You are a helpful AI assistant."),
    temperature: 0.7,
    maxTokens: 2048,
  };
}

function mapDatabase(p: Record<string, unknown>): Record<string, unknown> {
  return {
    label: "Database Query",
    query: String(p.query || p.operation || "SELECT 1"),
    dbPath: "",
  };
}

function mapGoogleSheets(p: Record<string, unknown>): Record<string, unknown> {
  return {
    label: "Google Sheets",
    action: String(p.operation || p.action || "read").toLowerCase().includes("append") ? "append" : "read",
    spreadsheetId: String(p.documentId || p.spreadsheetId || ""),
    range: String(p.range || "Sheet1!A:Z"),
    valuesJson: JSON.stringify(p.values || []),
  };
}

function mapNotion(p: Record<string, unknown>): Record<string, unknown> {
  return {
    label: "Notion",
    action: String(p.operation || "query-database"),
    databaseId: String(p.databaseId || ""),
    pageId: String(p.pageId || ""),
    queryJson: JSON.stringify(p.filter || {}),
    propertiesJson: JSON.stringify(p.properties || {}),
  };
}

function mapAirtable(p: Record<string, unknown>): Record<string, unknown> {
  return {
    label: "Airtable",
    action: String(p.operation || "list-records"),
    baseId: String(p.baseId || ""),
    table: String(p.table || ""),
    recordId: String(p.id || ""),
    fieldsJson: JSON.stringify(p.fields || {}),
  };
}

// ─── Master mapping table ────────────────────────────────────────────────────

interface NodeMapping {
  disp8chType: string;
  mapParams: (p: Record<string, unknown>) => Record<string, unknown>;
}

const N8N_NODE_MAP: Record<string, NodeMapping> = {
  // Triggers
  "n8n-nodes-base.manualTrigger": {
    disp8chType: "manual-trigger",
    mapParams: () => ({ label: "Manual Trigger" }),
  },
  "n8n-nodes-base.chatTrigger": {
    disp8chType: "message-trigger",
    mapParams: () => ({ label: "Message Trigger", channel: "webchat" }),
  },
  "n8n-nodes-base.webhook": {
    disp8chType: "webhook-trigger",
    mapParams: mapWebhookTrigger,
  },
  "n8n-nodes-base.webhookTrigger": {
    disp8chType: "webhook-trigger",
    mapParams: mapWebhookTrigger,
  },
  "n8n-nodes-base.scheduleTrigger": {
    disp8chType: "cron-trigger",
    mapParams: mapCronTrigger,
  },
  "n8n-nodes-base.cronTrigger": {
    disp8chType: "cron-trigger",
    mapParams: mapCronTrigger,
  },
  "n8n-nodes-base.cron": {
    disp8chType: "cron-trigger",
    mapParams: mapCronTrigger,
  },
  "n8n-nodes-base.executeWorkflowTrigger": {
    disp8chType: "manual-trigger",
    mapParams: () => ({ label: "Called By Workflow" }),
  },
  "n8n-nodes-base.errorTrigger": {
    disp8chType: "error-handler",
    mapParams: () => ({ label: "Error Handler" }),
  },
  "n8n-nodes-base.telegramTrigger": {
    disp8chType: "message-trigger",
    mapParams: () => ({ label: "Telegram Trigger", channel: "telegram" }),
  },
  "n8n-nodes-base.discordTrigger": {
    disp8chType: "message-trigger",
    mapParams: () => ({ label: "Discord Trigger", channel: "discord" }),
  },
  "n8n-nodes-base.slackTrigger": {
    disp8chType: "message-trigger",
    mapParams: () => ({ label: "Slack Trigger", channel: "slack" }),
  },

  // Logic
  "n8n-nodes-base.if": { disp8chType: "if-else", mapParams: mapIfElse },
  "n8n-nodes-base.switch": { disp8chType: "switch", mapParams: mapSwitch },
  "n8n-nodes-base.set": { disp8chType: "set-variables", mapParams: mapSetVariables },
  "n8n-nodes-base.editFields": { disp8chType: "set-variables", mapParams: mapSetVariables },
  "n8n-nodes-base.code": { disp8chType: "run-code", mapParams: mapRunCode },
  "n8n-nodes-base.function": { disp8chType: "run-code", mapParams: mapRunCode },
  "n8n-nodes-base.functionItem": { disp8chType: "run-code", mapParams: mapRunCode },
  "n8n-nodes-base.merge": { disp8chType: "merge", mapParams: mapMerge },
  "n8n-nodes-base.wait": { disp8chType: "delay", mapParams: mapDelay },
  "n8n-nodes-base.filter": { disp8chType: "filter", mapParams: mapFilter },
  "n8n-nodes-base.aggregate": { disp8chType: "aggregate", mapParams: mapAggregate },
  "n8n-nodes-base.splitInBatches": { disp8chType: "loop", mapParams: mapLoop },
  "n8n-nodes-base.executeWorkflow": { disp8chType: "call-workflow", mapParams: () => ({ label: "Call Workflow" }) },
  "n8n-nodes-base.noOp": { disp8chType: "set-variables", mapParams: () => ({ label: "No Operation", variables: "{}" }) },
  "n8n-nodes-base.removeDuplicates": { disp8chType: "filter", mapParams: () => ({ label: "Remove Duplicates", condition: "true" }) },
  "n8n-nodes-base.sort": { disp8chType: "json-transform", mapParams: () => ({ label: "Sort", transform: "sort" }) },
  "n8n-nodes-base.limit": { disp8chType: "filter", mapParams: (p) => ({ label: "Limit", condition: `index < ${p.maxItems || 10}` }) },
  "n8n-nodes-base.itemLists": { disp8chType: "aggregate", mapParams: () => ({ label: "Item Lists" }) },

  // HTTP / API
  "n8n-nodes-base.httpRequest": { disp8chType: "http-request", mapParams: mapHttpRequest },
  "n8n-nodes-base.graphql": { disp8chType: "http-request", mapParams: (p) => ({ label: "GraphQL", url: String(p.endpoint || ""), method: "POST" }) },
  "n8n-nodes-base.rssFeedRead": { disp8chType: "http-request", mapParams: (p) => ({ label: "RSS Feed", url: String(p.url || ""), method: "GET" }) },

  // Data processing
  "n8n-nodes-base.xml": { disp8chType: "json-transform", mapParams: () => ({ label: "XML Transform", transform: "parse" }) },
  "n8n-nodes-base.html": { disp8chType: "split-text", mapParams: () => ({ label: "HTML Extract" }) },
  "n8n-nodes-base.markdown": { disp8chType: "json-transform", mapParams: () => ({ label: "Markdown Convert" }) },
  "n8n-nodes-base.dateTime": { disp8chType: "date-time", mapParams: () => ({ label: "Date & Time" }) },
  "n8n-nodes-base.crypto": { disp8chType: "run-code", mapParams: (p) => ({ label: "Crypto", code: `// crypto operation: ${p.action || "hash"}\nresult = input;` }) },
  "n8n-nodes-base.compression": { disp8chType: "archive", mapParams: mapArchive },

  // Files
  "n8n-nodes-base.readBinaryFile": { disp8chType: "read-file", mapParams: mapReadFile },
  "n8n-nodes-base.writeBinaryFile": { disp8chType: "write-file", mapParams: mapWriteFile },
  "n8n-nodes-base.spreadsheetFile": { disp8chType: "read-file", mapParams: mapReadFile },
  "n8n-nodes-base.extractFromFile": { disp8chType: "read-file", mapParams: mapReadFile },
  "n8n-nodes-base.convertToFile": { disp8chType: "write-file", mapParams: mapWriteFile },
  "n8n-nodes-base.executeCommand": { disp8chType: "system-command", mapParams: mapExecuteCommand },

  // Channels
  "n8n-nodes-base.telegram": { disp8chType: "send-telegram", mapParams: mapTelegram },
  "n8n-nodes-base.discord": { disp8chType: "send-discord", mapParams: mapDiscord },
  "n8n-nodes-base.slack": { disp8chType: "send-slack", mapParams: mapSlack },
  "n8n-nodes-base.microsoftTeams": { disp8chType: "send-teams", mapParams: () => ({ label: "Send Teams" }) },
  "n8n-nodes-base.gmail": { disp8chType: "send-email", mapParams: mapSendEmail },
  "n8n-nodes-base.sendEmail": { disp8chType: "send-email", mapParams: mapSendEmail },
  "n8n-nodes-base.whatsApp": { disp8chType: "send-whatsapp", mapParams: () => ({ label: "Send WhatsApp" }) },
  "n8n-nodes-base.googleSheets": { disp8chType: "google-sheets", mapParams: mapGoogleSheets },
  "n8n-nodes-base.notion": { disp8chType: "notion", mapParams: mapNotion },
  "n8n-nodes-base.airtable": { disp8chType: "airtable", mapParams: mapAirtable },

  // Databases
  "n8n-nodes-base.postgres": { disp8chType: "database-query", mapParams: mapDatabase },
  "n8n-nodes-base.mysql": { disp8chType: "database-query", mapParams: mapDatabase },
  "n8n-nodes-base.sqlite": { disp8chType: "database-query", mapParams: mapDatabase },
  "n8n-nodes-base.mongoDb": { disp8chType: "database-query", mapParams: mapDatabase },

  // DevOps
  "n8n-nodes-base.github": { disp8chType: "git-operation", mapParams: mapGitOperation },
  "n8n-nodes-base.gitlab": { disp8chType: "git-operation", mapParams: mapGitOperation },
  "n8n-nodes-base.ssh": { disp8chType: "system-command", mapParams: (p) => ({ label: "SSH Command", command: String(p.command || "") }) },

  // AI / LangChain
  "@n8n/n8n-nodes-langchain.agent": { disp8chType: "claude-agent", mapParams: mapLangchainAgent },
  "@n8n/n8n-nodes-langchain.chainLlm": { disp8chType: "claude-agent", mapParams: mapLangchainAgent },
  "@n8n/n8n-nodes-langchain.chainSummarization": { disp8chType: "claude-agent", mapParams: () => ({ label: "Summarize Agent", systemPrompt: "Summarize the provided content concisely." }) },
  "@n8n/n8n-nodes-langchain.chainRetrievalQa": { disp8chType: "claude-agent", mapParams: () => ({ label: "QA Agent", systemPrompt: "Answer questions based on the provided context." }) },
  "@n8n/n8n-nodes-langchain.lmChatOpenAi": { disp8chType: "claude-agent", mapParams: mapLangchainAgent },
  "@n8n/n8n-nodes-langchain.lmChatAnthropic": { disp8chType: "claude-agent", mapParams: mapLangchainAgent },
  "@n8n/n8n-nodes-langchain.lmChatGoogleGemini": { disp8chType: "claude-agent", mapParams: mapLangchainAgent },
  "@n8n/n8n-nodes-langchain.lmChatOllama": { disp8chType: "claude-agent", mapParams: mapLangchainAgent },
  "@n8n/n8n-nodes-langchain.toolHttpRequest": { disp8chType: "http-request", mapParams: mapHttpRequest },
  "@n8n/n8n-nodes-langchain.toolCode": { disp8chType: "run-code", mapParams: mapRunCode },
  "@n8n/n8n-nodes-langchain.toolWorkflow": { disp8chType: "call-workflow", mapParams: () => ({ label: "Tool Workflow" }) },
  "@n8n/n8n-nodes-langchain.textSplitterRecursiveCharacterTextSplitter": { disp8chType: "split-text", mapParams: (p) => ({ label: "Split Text", chunkSize: Number(p.chunkSize || 1000) }) },
};

// Nodes to silently skip (canvas annotations, non-executable)
const SKIP_NODE_TYPES = new Set(["n8n-nodes-base.stickyNote", "n8n-nodes-base.noOp"]);

// ─── Expression translator ────────────────────────────────────────────────────

/** Best-effort translate n8n `={{ ... }}` expressions to disp8ch `{{namespace.field}}` */
function translateExpression(value: unknown): unknown {
  if (typeof value !== "string") return value;
  // Match n8n expression syntax
  return value.replace(/=\{\{\s*([\s\S]+?)\s*\}\}/g, (_, expr: string) => {
    // $json.fieldName → {{trigger.fieldName}}
    const jsonField = expr.match(/^\$json\.(\w+)$/);
    if (jsonField) return `{{trigger.${jsonField[1]}}}`;
    // $json["field"] → {{trigger.field}}
    const jsonBracket = expr.match(/^\$json\["(\w+)"\]$/);
    if (jsonBracket) return `{{trigger.${jsonBracket[1]}}}`;
    // $input.item.json.field → {{trigger.field}}
    const inputField = expr.match(/^\$input\.item\.json\.(\w+)$/);
    if (inputField) return `{{trigger.${inputField[1]}}}`;
    // Keep as-is (complex expressions can't be auto-translated)
    return `{{${expr}}}`;
  });
}

function normalizeImportedExpression(value: unknown): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const translated = translateExpression(raw);
  return typeof translated === "string" ? translated : raw;
}

function translateParamValues(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string") {
      out[k] = translateExpression(v);
    } else if (Array.isArray(v)) {
      out[k] = v.map((item) => (typeof item === "string" ? translateExpression(item) : item));
    } else {
      out[k] = v;
    }
  }
  return out;
}

function collectExpressionTranslations(nodeName: string, obj: Record<string, unknown>): Array<{ nodeName: string; field: string; from: string; to: string }> {
  const translations: Array<{ nodeName: string; field: string; from: string; to: string }> = [];
  for (const [field, value] of Object.entries(obj)) {
    if (typeof value !== "string") continue;
    const translated = translateExpression(value);
    if (typeof translated === "string" && translated !== value) {
      translations.push({ nodeName, field, from: value, to: translated });
    }
  }
  return translations;
}

// ─── Main import function ─────────────────────────────────────────────────────

/** Detect if a JSON object looks like an n8n workflow */
export function isN8nWorkflow(obj: unknown): obj is N8nWorkflow {
  if (!obj || typeof obj !== "object") return false;
  const w = obj as Record<string, unknown>;
  return (
    Array.isArray(w.nodes) &&
    w.connections !== null &&
    typeof w.connections === "object" &&
    !Array.isArray(w.connections)
  );
}

/** Detect if a JSON object looks like a disp8ch workflow */
export function isDisp8chWorkflow(obj: unknown): boolean {
  if (!obj || typeof obj !== "object") return false;
  const w = obj as Record<string, unknown>;
  return Array.isArray(w.nodes) && Array.isArray(w.edges);
}

/** Convert an n8n workflow JSON export to disp8ch workflow format */
export function convertN8nToDisp8ch(n8nJson: N8nWorkflow): N8nImportResult {
  const warnings: string[] = [];
  const nodes: ImportedWorkflowNode[] = [];
  const edges: ImportedWorkflowEdge[] = [];

  // Build name→id map for connection resolution
  const nameToId = new Map<string, string>();
  const nameToType = new Map<string, string>();
  let totalNodes = n8nJson.nodes.length;
  let mappedNodes = 0;
  let unsupportedNodes = 0;
  let skippedNodes = 0;
  const supportedReport: N8nImportResult["compatibilityReport"]["supportedNodes"] = [];
  const partialReport: N8nImportResult["compatibilityReport"]["partiallySupportedNodes"] = [];
  const unsupportedReport: N8nImportResult["compatibilityReport"]["unsupportedNodes"] = [];
  const expressionTranslations: N8nImportResult["compatibilityReport"]["expressionTranslations"] = [];
  const codeTranslations: N8nImportResult["compatibilityReport"]["codeTranslations"] = [];

  // First pass: create all node IDs and map names
  for (const n8nNode of n8nJson.nodes) {
    const newId = nanoid(8);
    nameToId.set(n8nNode.name, newId);
    nameToType.set(n8nNode.name, n8nNode.type);
  }

  // Second pass: translate nodes
  for (const n8nNode of n8nJson.nodes) {
    const newId = nameToId.get(n8nNode.name)!;
    const params = (n8nNode.parameters || {}) as Record<string, unknown>;

    // Skip non-executable annotation nodes
    if (SKIP_NODE_TYPES.has(n8nNode.type)) {
      skippedNodes++;
      totalNodes--;
      continue;
    }

    // Skip disabled nodes
    if (n8nNode.disabled) {
      skippedNodes++;
      totalNodes--;
      continue;
    }

    const mapping = N8N_NODE_MAP[n8nNode.type];

    if (!mapping) {
      // Create placeholder node for unsupported types
      unsupportedNodes++;
      warnings.push(`"${n8nNode.name}" (${n8nNode.type}) — no disp8ch equivalent, imported as placeholder`);
      nodes.push({
        id: newId,
        type: "placeholder",
        position: { x: n8nNode.position[0], y: n8nNode.position[1] },
        data: {
          label: n8nNode.name,
          originalType: n8nNode.type,
          originalConfig: params,
          warning: `Unsupported n8n node type: ${n8nNode.type}`,
        },
      });
      unsupportedReport.push({
        nodeName: n8nNode.name,
        n8nType: n8nNode.type,
        placeholderNodeId: newId,
      });
    } else {
      mappedNodes++;
      const mappedParams = mapping.mapParams(params);
      expressionTranslations.push(...collectExpressionTranslations(n8nNode.name, mappedParams));
      const translatedParams = translateParamValues(mappedParams);
      const nodeWarnings: string[] = [];
      if (n8nNode.type === "n8n-nodes-base.code" || n8nNode.type === "n8n-nodes-base.function" || n8nNode.type === "n8n-nodes-base.functionItem") {
        nodeWarnings.push("Code was best-effort translated from n8n item semantics; review before live execution.");
        codeTranslations.push({ nodeName: n8nNode.name, warning: nodeWarnings[0] });
      }
      if (n8nNode.credentials && Object.keys(n8nNode.credentials).length > 0) {
        nodeWarnings.push("Credential placeholder created; connect a saved disp8ch credential before running live.");
      }
      if (nodeWarnings.length > 0) {
        partialReport.push({
          nodeName: n8nNode.name,
          n8nType: n8nNode.type,
          disp8chType: mapping.disp8chType,
          warnings: nodeWarnings,
        });
      } else {
        supportedReport.push({
          nodeName: n8nNode.name,
          n8nType: n8nNode.type,
          disp8chType: mapping.disp8chType,
        });
      }
      nodes.push({
        id: newId,
        type: mapping.disp8chType,
        position: { x: n8nNode.position[0], y: n8nNode.position[1] },
        data: {
          ...translatedParams,
          label: translatedParams.label ?? n8nNode.name,
        },
      });
    }
  }

  // Third pass: translate connections → edges
  for (const [sourceName, sourceConnections] of Object.entries(n8nJson.connections || {})) {
    const sourceId = nameToId.get(sourceName);
    if (!sourceId) continue;
    const sourceType = nameToType.get(sourceName) || "";

    // Process main connections
    const mainOutputs = sourceConnections.main || [];
    for (let outputIndex = 0; outputIndex < mainOutputs.length; outputIndex++) {
      const targets = mainOutputs[outputIndex] || [];
      for (const conn of targets) {
        const targetId = nameToId.get(conn.node);
        if (!targetId) continue;

        const edge: ImportedWorkflowEdge = {
          id: `e-${sourceId}-${targetId}-${outputIndex}`,
          source: sourceId,
          target: targetId,
        };

        // Map output indexes to the executor's branch handles.
        if (sourceType === "n8n-nodes-base.if") {
          edge.sourceHandle = outputIndex === 0 ? "true" : "false";
        } else if (sourceType === "n8n-nodes-base.switch") {
          edge.sourceHandle = `case_${outputIndex}`;
        }

        edges.push(edge);
      }
    }
  }

  // Preserve pinData
  const pinData: Record<string, { dataJson: string; nodeName: string }> = {};
  if (n8nJson.pinData) {
    for (const [nodeName, data] of Object.entries(n8nJson.pinData)) {
      const nodeId = nameToId.get(nodeName);
      if (nodeId) {
        pinData[nodeId] = { dataJson: JSON.stringify(data), nodeName };
      }
    }
  }

  // Extract notes
  const notes: Array<{ nodeId: string; text: string }> = [];
  for (const n8nNode of n8nJson.nodes) {
    if (n8nNode.notes) {
      const nodeId = nameToId.get(n8nNode.name);
      if (nodeId) {
        notes.push({ nodeId, text: n8nNode.notes });
      }
    }
  }

  // Extract credential placeholders
  const credentialsPlaceholders: Array<{ nodeName: string; credentialType: string }> = [];
  for (const n8nNode of n8nJson.nodes) {
    if (n8nNode.credentials) {
      for (const [credType] of Object.entries(n8nNode.credentials)) {
        credentialsPlaceholders.push({ nodeName: n8nNode.name, credentialType: credType });
      }
    }
  }

  const manualRepairSteps: string[] = [];
  if (unsupportedReport.length > 0) {
    manualRepairSteps.push("Replace placeholder nodes with supported disp8ch nodes or ask the agent for a repair plan.");
  }
  if (credentialsPlaceholders.length > 0) {
    manualRepairSteps.push("Create saved workflow credentials and attach them to imported API/channel nodes.");
  }
  if (expressionTranslations.length > 0) {
    manualRepairSteps.push("Review translated expressions, especially n8n $json, $node, $input, binary data, and item-linking references.");
  }
  if (codeTranslations.length > 0) {
    manualRepairSteps.push("Review imported code nodes because n8n uses item arrays while disp8ch run-code receives upstream data as input.");
  }

  return {
    name: n8nJson.name || "Imported Workflow",
    description: `Imported from n8n. ${unsupportedNodes > 0 ? `${unsupportedNodes} unsupported node(s) imported as placeholders.` : ""} ${credentialsPlaceholders.length > 0 ? `${credentialsPlaceholders.length} credential placeholder(s).` : ""}`.trim(),
    nodes,
    edges,
    warnings,
    pinData,
    notes,
    credentialsPlaceholders,
    stats: {
      total: totalNodes,
      mapped: mappedNodes,
      unsupported: unsupportedNodes,
      skipped: skippedNodes,
    },
    compatibilityReport: {
      supportedNodes: supportedReport,
      partiallySupportedNodes: partialReport,
      unsupportedNodes: unsupportedReport,
      credentialPlaceholders: credentialsPlaceholders,
      expressionTranslations,
      codeTranslations,
      manualRepairSteps,
    },
  };
}
