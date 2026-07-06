export function isAutomationLiveStateReadRequest(raw: string): boolean {
  const value = String(raw || "").trim().toLowerCase();
  if (!value) return false;
  const readOnlyValue = value
    .replace(/\bdo\s+not\s+(?:create|add|delete|update|change|run|trigger|execute|schedule|configure)\b[^.!?\n]*/g, " ")
    .replace(/\bdon't\s+(?:create|add|delete|update|change|run|trigger|execute|schedule|configure)\b[^.!?\n]*/g, " ");
  const hasAutomationTerm = /\b(?:webhook|webhooks|cron|schedule|schedules|scheduled|scheduler|automation|automations)\b/.test(readOnlyValue);
  const hasReadIntent = /\b(?:list|show|current|existing|what|which|my|all|any|status|active|enabled|configured|live|separate)\b/.test(readOnlyValue);
  const hasExplicitInventoryIntentForDecisionGuard = /\b(?:list|show|current|existing|which|my|all|any|status|active|enabled|configured|live|inventory|overview|separate)\b/.test(readOnlyValue);
  const hasDecisionAdviceIntent = /\b(?:deciding|decide|decision|prioriti[sz]e|arguments?\s+for|arguments?\s+against|for\s+and\s+against|what\s+would\s+you\s+do|should\s+(?:i|we)|recommend|advice|advisor)\b/.test(readOnlyValue);
  const isCapabilityOrHowTo =
    /\b(?:what\s+can|can\s+this\s+app\s+do|capabilit|implemented|planned|missing|how\s+to|sign|signature|hmac|curl|design|plan)\b/.test(readOnlyValue);
  const isMutation =
    /\b(?:create|add|delete|remove|rotate|toggle|disable|enable|run|trigger|fire|execute|schedule|configure|set\s+up)\b/.test(readOnlyValue);
  if (hasDecisionAdviceIntent && !hasExplicitInventoryIntentForDecisionGuard) return false;
  return hasAutomationTerm && hasReadIntent && !isCapabilityOrHowTo && !isMutation;
}

async function renderScheduledWorkflowState(): Promise<string> {
  const { listScheduledCronJobs } = await import("@/lib/cron/manager");
  const { initializeDatabase, getSqlite } = await import("@/lib/db");
  const { extractCronNodes, parseWorkflowNodes } = await import("@/lib/agents/workflow-insights");
  initializeDatabase();
  const db = getSqlite();
  const rows = db
    .prepare("SELECT id, name, is_active, nodes FROM workflows ORDER BY updated_at DESC")
    .all() as Array<{ id: string; name: string; is_active: number; nodes: string }>;

  const liveJobs = listScheduledCronJobs();
  const liveMap = new Map(liveJobs.map((j) => [`${j.workflowId}:${j.nodeId}`, true]));

  const lines: string[] = [];
  for (const row of rows) {
    const nodes = parseWorkflowNodes(row.nodes);
    const cronNodes = extractCronNodes(nodes);
    if (cronNodes.length === 0) continue;
    const active = Number(row.is_active) === 1;
    for (const cron of cronNodes) {
      const live = liveMap.has(`${row.id}:${cron.nodeId}`);
      lines.push(`- ${row.name} | ${cron.expression} | ${cron.timezone} | ${active ? (live ? "live" : "inactive") : "disabled"}`);
    }
  }
  if (lines.length === 0) {
    return "Scheduled workflows (0):\nCron jobs: none configured yet. Add a cron-trigger node in the workflow editor.";
  }
  return `Scheduled workflows (${lines.length}):\nCron jobs:\n${lines.join("\n")}`;
}

async function renderWebhookAutomationState(): Promise<string> {
  const { initializeDatabase, getSqlite } = await import("@/lib/db");
  initializeDatabase();
  const db = getSqlite();
  const rows = db.prepare(`
    SELECT w.id, w.name, w.is_active, wf.name as workflow_name, wf.is_active as workflow_active
    FROM webhooks w LEFT JOIN workflows wf ON wf.id = w.workflow_id
    ORDER BY w.created_at DESC
  `).all() as Array<{ id: string; name: string; is_active: number; workflow_name: string | null; workflow_active: number | null }>;
  if (rows.length === 0) {
    return "Webhook automations (0):\nNo webhooks configured yet. Create one from the Automations tab (/scheduler) or ask me to create one.";
  }
  const active = rows.filter((r) => r.is_active === 1).length;
  const lines = rows.map((r, i) => {
    const status = r.is_active === 1 ? "active" : "disabled";
    const wfStatus = r.workflow_active === 1 ? "active workflow" : (r.workflow_active === 0 ? "inactive workflow" : "missing workflow");
    return `- [${i + 1}] ${r.name} (${status}) -> ${r.workflow_name ?? "(deleted)"} [${wfStatus}] - URL: /api/webhooks/${r.id}`;
  });
  return `Webhook automations (${rows.length} total, ${active} active):\n${lines.join("\n")}`;
}

export async function renderAutomationLiveStateResponse(raw: string): Promise<string> {
  const wantsCron = /\b(?:cron|schedule|schedules|scheduled|scheduler)\b/i.test(raw);
  const wantsWebhook = /\bwebhooks?\b/i.test(raw);
  const wantsOverview =
    /\b(?:automation|automations)\b/i.test(raw) &&
    (wantsCron || /\bseparate\b/i.test(raw) || !wantsWebhook);

  if (wantsOverview) {
    const [schedules, webhooks] = await Promise.all([
      renderScheduledWorkflowState(),
      renderWebhookAutomationState(),
    ]);
    return ["Automations", "", schedules, "", webhooks].join("\n");
  }

  if (wantsWebhook) {
    return renderWebhookAutomationState();
  }

  return renderScheduledWorkflowState();
}

export function isWebhookSigningHelpRequest(raw: string): boolean {
  return /\bwebhooks?\b/i.test(raw) && /\b(?:sign|signature|hmac|curl|request)\b/i.test(raw) && !hasAutomationLiveStateReadPart(raw);
}

export function hasAutomationLiveStateReadPart(raw: string): boolean {
  const value = String(raw || "").trim().toLowerCase();
  if (!value) return false;
  const readOnlyValue = value
    .replace(/\bdo\s+not\s+(?:create|add|delete|update|change|run|trigger|execute|schedule|configure)\b[^.!?\n]*/g, " ")
    .replace(/\bdon't\s+(?:create|add|delete|update|change|run|trigger|execute|schedule|configure)\b[^.!?\n]*/g, " ");
  return (
    /\b(?:webhook|webhooks|cron|schedule|schedules|scheduled|scheduler|automation|automations)\b/.test(readOnlyValue) &&
    /\b(?:list|show|current|existing|what|which|my|all|any|status|active|enabled|configured|live|inventory|state|overview|separate)\b/.test(readOnlyValue)
  );
}

export function renderWebhookSigningHelpResponse(): string {
  return [
    "Webhook signing for disp8ch AI uses HMAC-SHA256 over the raw JSON body, or over `timestamp.body` when `x-webhook-timestamp` is present.",
    "",
    "Required headers:",
    "- `content-type: application/json`",
    "- `x-webhook-signature: <hex hmac sha256>`",
    "",
    "Replay-protected headers:",
    "- `x-webhook-timestamp: <unix seconds>`",
    "- `x-webhook-nonce: <unique value>`",
    "",
    "Bash example:",
    "```bash",
    "WEBHOOK_URL=\"http://127.0.0.1:3100/api/webhooks/<webhook-id>\"",
    "WEBHOOK_SECRET=\"<secret-shown-on-create-or-rotate>\"",
    "BODY='{\"event\":\"test\"}'",
    "TS=$(date +%s)",
    "NONCE=$(openssl rand -hex 12)",
    "SIG=$(printf '%s.%s' \"$TS\" \"$BODY\" | openssl dgst -sha256 -hmac \"$WEBHOOK_SECRET\" -hex | awk '{print $2}')",
    "curl -X POST \"$WEBHOOK_URL\" \\",
    "  -H 'content-type: application/json' \\",
    "  -H \"x-webhook-timestamp: $TS\" \\",
    "  -H \"x-webhook-nonce: $NONCE\" \\",
    "  -H \"x-webhook-signature: $SIG\" \\",
    "  --data \"$BODY\"",
    "```",
    "",
    "The Automations list never exposes existing secrets. Copy the secret immediately when creating or rotating a webhook.",
  ].join("\n");
}
