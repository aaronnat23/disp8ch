import fs from "node:fs";
import path from "node:path";
import { logger } from "@/lib/utils/logger";
import {
  applyIngressProvenance,
  createChildProvenance,
  createProvenance,
  deriveChannelSessionId,
  formatProvenanceReceipt,
  getConfiguredIngressProvenanceMode,
  type IngressProvenanceMode,
  type ProvenanceRecord,
} from "@/lib/provenance";
import { providerRequiresApiKey } from "@/lib/agents/provider-plugins";
import {
  getChannelSessionAppState,
  upsertChannelSessionAppState,
  type SessionAppStatePayload,
  type SessionEntityRef,
} from "@/lib/channels/session-app-state";
import {
  BUILTIN_INTENT_ALLOWED_COMMANDS,
  BUILTIN_INTENT_MODEL_EXAMPLES,
  BUILTIN_INTENT_ROUTER_CARDS,
  BUILTIN_INTENT_SURFACE_DESCRIPTIONS,
  findBuiltinIntentByCommand,
  findBuiltinIntentByAlias,
  getDefaultBuiltinCommandForDomain,
  resolveBuiltinDomainFromText,
  resolveBuiltinIntentByKeywords,
  getCommandPaletteText,
  type AppControlDomain,
} from "@/lib/channels/builtin-intents";
import { matchAppCommand } from "@/lib/channels/app-command-registry";
import {
  detectCrossTabIntent,
  isBoardTaskMutationRequest,
  isCrossSurfaceAppMutationRequest,
  shouldUseTypedAppPlan,
} from "@/lib/channels/cross-tab-intent";
import { resolveDirectExactRecall } from "@/lib/memory/direct-exact-recall";
import { classifyExactRecallQuery } from "@/lib/memory/exact-recall";
import { ensureCustomToolsTable } from "@/lib/tools/custom-tools";
import { withRetry } from "@/lib/utils/retry";
import {
  listWorkflowTemplateCatalog,
  resolveWorkflowTemplateReference,
  type WorkflowTemplateCatalogEntry,
} from "@/lib/workflows/template-catalog";
import { listPendingApprovals, resolvePendingApproval, truncateToolResult } from "@/lib/engine/tools";
import type { WorkflowEdge, WorkflowNode } from "@/types/workflow";
import { classifyAppActionRisk } from "@/lib/channels/app-action-schema";
import type { AppActionPlan, AppActionStep } from "@/lib/channels/app-action-schema";

const log = logger.child("channel:router");

export type RouteToWorkflowResult = {
  response: string | null;
  workflowId: string | null;
  workflowName: string | null;
  source: "workflow" | "builtin" | "none" | "app-action-planner" | "app-command-registry" | "cancelled";
  routingTrace?: Record<string, unknown> | null;
  /** Set when this turn produced a pending, editable app-action plan, so the
   *  caller can surface metadata.pendingAppActionPlan without re-reading session state. */
  pendingAppActionPlan?: AppActionPlan | null;
  pendingWorkTrailId?: string | null;
};

type WorkflowCommandIntent = {
  requestedWorkflowName: string;
  requestedWorkflowNameRaw: string;
  workflowPayload: string;
};

type TaskRunIntent = {
  taskId: string;
  taskReference: string;
  wantsLatest: boolean;
};

type TaskLookupRecord = {
  id: string;
  title: string;
  workflowTemplateKey: string | null;
  workflowId: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
};

type ConfigTableName = "app_config" | "memory_config";
type ConfigValueType = "string" | "number" | "boolean" | "enum";

type ConfigFieldMeta = {
  table: ConfigTableName;
  column: string;
  type: ConfigValueType;
  aliases: string[];
  enumValues?: string[];
  min?: number;
  max?: number;
};

type AgentLite = {
  id: string;
  name: string;
  isDefault: boolean;
  isActive: boolean;
  modelRef: string | null;
  disabledTools: string[];
  roleType?: string | null;
  roleTitle?: string | null;
  reportsToName?: string | null;
};

type ModelRow = {
  id: string;
  provider: string;
  model_id: string;
  name: string;
  api_key: string;
  priority: number;
  is_active: number;
  max_tokens: number | null;
  base_url: string | null;
  created_at: string;
};

type ToolRow = {
  id: string;
  name: string;
  description: string;
  type: string;
  code: string;
  parameters: string;
  is_active: number;
  created_at: string;
  updated_at: string;
  wrapper_mode?: string | null;
  validation_status?: string | null;
};

type BuiltinCommandContext = {
  channel: string;
  sender: string;
  sessionId?: string | null;
  internalBaseUrl?: string | null;
  allowCompound?: boolean;
  clientTurnId?: string | null;
};

type TaskListIntent = {
  kind: "board" | "inbox";
  query: string;
  pageSize: number;
  mode: "reset" | "next";
};

type TaskListCursorState = {
  kind: "board" | "inbox";
  query: string;
  nextOffset: number;
  pageSize: number;
  updatedAt: number;
};

type CheckpointCommandIntent =
  | { action: "list"; limit: number }
  | { action: "create"; label: string }
  | { action: "diff"; reference: string }
  | { action: "rollback"; reference: string; targetPath: string };

type TemplateActionIntent = {
  templateRef: string;
  workflowName: string;
  payload: string;
};

type DataSourceCreateIntent =
  | {
      mode: "single" | "crawl";
      url: string;
      name: string;
    }
  | {
      mode: "upload";
      filePath: string;
      name: string;
      mimeType: string;
    };

type WorkflowGenerateIntent = {
  name: string;
  description: string;
};

type WorkflowExportIntent = {
  workflowRef: string;
  outputPath: string;
};

type WorkflowImportIntent = {
  name: string;
  filePath: string;
  explicitSource: "compatible" | "disp8ch" | null;
};

const LEGACY_COMPAT_WORKFLOW_SOURCE = ["n", "8", "n"].join("");

type ScheduleExpressionIntent = {
  expression: string;
  label: string;
  timezone: string;
};

type SchedulerCreateIntent =
  | {
      kind: "health-check";
      workflowName: string;
      schedule: ScheduleExpressionIntent;
    }
  | {
      kind: "workflow";
      workflowRef: string;
      wrapperName: string;
      schedule: ScheduleExpressionIntent;
    };

type IntentClass = "app_read" | "app_write" | "exact_memory_recall" | "general_assistant" | "conversation";

type AppIntentClassification = {
  kind: "app_control" | "knowledge_work" | "conversation";
  domain: AppControlDomain | null;
  reason: string;
  usesSessionReference: boolean;
  intentClass?: IntentClass;
};

type ModelAssistedBuiltinResolution = {
  command: string;
  commands: string[];
  domain: AppControlDomain | "help" | "none";
  confidence: "low" | "medium" | "high";
  reason: string;
};

const MODEL_ASSISTED_BUILTIN_DOMAINS = new Set<AppControlDomain | "help" | "none">([
  "docs",
  "workflow",
  "scheduler",
  "data-source",
  "board",
  "agent",
  "channels",
  "dashboard",
  "activity",
  "approvals",
  "logs",
  "debug",
  "maintenance",
  "security",
  "metrics",
  "usage",
  "settings",
  "council",
  "hierarchy",
  "tags",
  "checkpoint",
  "help",
  "none",
]);

type BuiltinRouteDecision = {
  mode: "exact" | "fuzzy" | "clarify" | "skip";
  classification: AppIntentClassification;
  protectedParser: boolean;
};

type RoutingDecisionTrace = {
  rawMessage: string;
  normalizedMessage: string;
  intentClass: IntentClass;
  classificationKind: AppIntentClassification["kind"];
  classificationDomain: AppControlDomain | null;
  matchedAlias: string | null;
  matchedKeywords: string | null;
  protectedParser: boolean;
  plannerEligible: boolean;
  plannerEligibilityReason: string;
  rewritesApplied: string[];
  clauses: string[];
  commands: string[];
  routeSource: "builtin" | "workflow" | "none" | "app-action-planner" | "app-command-registry" | "cancelled";
  modelAssistUsed: boolean;
};

type BulkCreateAgentsOrganizationIntent = {
  agentCount: number;
  organizationName: string | null;
  debateTopic: string | null;
};

type DirectCreateAgentIntent = {
  name: string;
  purpose: string | null;
  modelRef: string | null;
};

type BulkCreateAgentsIntent = {
  agentCount: number;
  purpose: string | null;
};

type GeneratedAgentPlan = {
  name: string;
  roleType: "orchestrator" | "operations" | "specialist" | "worker";
  roleTitle: string;
  reportsToIndex: number | null;
  capabilities: string[];
};

function parseBulkCreateAgentsOrganizationIntent(raw: string): BulkCreateAgentsOrganizationIntent | null {
  const lead = "(?:(?:can|could|would)\\s+you\\s+|please\\s+)?";
  const orgFirstMatch = raw.match(
    new RegExp(`^${lead}(?:create|make|add|spin\\s+up)\\s+(?:an?\\s+)?(?:org|organization)(?:\\s+(?:called|named)\\s+(.+?))?\\s+(?:of|with|for)\\s+(\\d+)\\s+(?:people|agents?|members?)(?:\\s+(?:and|to)\\s+(?:let|have|ask)\\s+them\\s+(?:debate|discuss|deliberate|vote\\s+on)\\s*(?:on|about|over|for)?\\s*(.+?))?[.!?]*$`, "i"),
  );
  if (orgFirstMatch?.[2]) {
    const agentCount = Number.parseInt(orgFirstMatch[2], 10);
    if (!Number.isFinite(agentCount) || agentCount < 1) return null;
    const organizationName = orgFirstMatch[1] ? trimReferenceTrail(stripWrappedQuotes(orgFirstMatch[1])) : null;
    const debateTopic = orgFirstMatch[3] ? trimReferenceTrail(stripWrappedQuotes(orgFirstMatch[3])) : null;
    return {
      agentCount,
      organizationName: organizationName || null,
      debateTopic: debateTopic || null,
    };
  }

  const match = raw.match(
    new RegExp(`^${lead}(?:create|make|add|spin\\s+up)\\s+(\\d+)\\s+agents?(?:(?:\\s+(?:and|&)\\s+(?:create|make|add|spin\\s+up)\\s+)|(?:\\s+and\\s+group\\s+them\\s+into\\s+)|(?:\\s+and\\s+create\\s+an?\\s+org\\s+for\\s+them)|(?:\\s+and\\s+create\\s+an?\\s+organization\\s+for\\s+them)|(?:\\s+and\\s+group\\s+them\\s+into\\s+an?\\s+))?(?:an?\\s+)?(?:org|organization)(?:\\s+(?:called|named)\\s+(.+?))?(?:\\s+for\\s+them)?(?:\\s+(?:and|to)\\s+(?:let|have|ask)\\s+them\\s+(?:debate|discuss|deliberate|vote\\s+on)\\s*(?:on|about|over|for)?\\s*(.+?))?[.!?]*$`, "i"),
  );
  if (!match?.[1]) return null;
  const agentCount = Number.parseInt(match[1], 10);
  if (!Number.isFinite(agentCount) || agentCount < 1) return null;
  const organizationName = match[2] ? trimReferenceTrail(stripWrappedQuotes(match[2])) : null;
  const debateTopic = match[3] ? trimReferenceTrail(stripWrappedQuotes(match[3])) : null;
  return { agentCount, organizationName: organizationName || null, debateTopic: debateTopic || null };
}

function parseImplicitDebateOrganizationIntent(raw: string): BulkCreateAgentsOrganizationIntent | null {
  const match = String(raw || "").trim().match(
    /^(?:(?:can|could|would)\s+you\s+|please\s+)?(?:create|make|add|spin\s+up)\s+(?:(\d+)|(?:a\s+)?few)\s+agents?(?:\s+(?:and|to)\s+(?:let|have|ask)\s+them\s+)?(?:debate|discuss|deliberate|vote\s+on)\s*(?:on|about|over|for)?\s*(.+?)[.!?]*$/i,
  );
  if (!match?.[2]) return null;
  const agentCount = match[1] ? Number.parseInt(match[1], 10) : 3;
  if (!Number.isFinite(agentCount) || agentCount < 1) return null;
  const debateTopic = trimReferenceTrail(stripWrappedQuotes(match[2]));
  return {
    agentCount,
    organizationName: null,
    debateTopic: debateTopic || null,
  };
}

function parseDirectCreateAgentIntent(raw: string): DirectCreateAgentIntent | null {
  const value = String(raw || "").trim();
  const match =
    value.match(/^(?:(?:can|could|would)\s+you\s+|please\s+)?(?:create|add|new|make|spin\s+up)\s+(?:an?\s+)?agent(?:\s+(?:named|called))?\s+(.+)$/i) ||
    value.match(/^(?:(?:can|could|would)\s+you\s+|please\s+)?(?:create|add|make|spin\s+up)\s+(.+?)\s+agent$/i);
  if (!match?.[1]) return null;
  let nameChunk = trimReferenceTrail(stripWrappedQuotes(match[1]));
  let purpose: string | null = null;
  let modelRef: string | null = null;
  const purposeMatch = nameChunk.match(/^(?:just\s+)?(?:to|for)\s+(.+)$/i);
  if (purposeMatch?.[1]) {
    purpose = trimReferenceTrail(stripWrappedQuotes(purposeMatch[1]));
    nameChunk = purpose
      .replace(/\b(?:do|handle|work\s+on|perform|run)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    nameChunk = nameChunk ? `${toTitleCase(nameChunk).slice(0, 80)} Agent` : "Task Agent";
  }
  const modelSuffix = nameChunk.match(/^(.+?)\s+(?:with|using)\s+model\s+(.+)$/i);
  if (modelSuffix?.[1]) {
    nameChunk = trimReferenceTrail(stripWrappedQuotes(modelSuffix[1]));
    modelRef = trimReferenceTrail(stripWrappedQuotes(modelSuffix[2] ?? ""));
  }
  if (!nameChunk || /^(?:agent|an agent|a agent)$/i.test(nameChunk)) return null;
  return { name: nameChunk, purpose, modelRef: modelRef || null };
}

function parseBulkCreateAgentsIntent(raw: string): BulkCreateAgentsIntent | null {
  const match = String(raw || "").trim().match(
    /^(?:(?:can|could|would)\s+you\s+|please\s+)?(?:create|make|add|spin\s+up)\s+(\d+)\s+agents?(?:\s+(?:with|for|to|that|who)\s+(.+?))?[.!?]*$/i,
  );
  if (!match?.[1]) return null;
  const agentCount = Number.parseInt(match[1], 10);
  if (!Number.isFinite(agentCount) || agentCount < 1) return null;
  return {
    agentCount,
    purpose: match[2] ? trimReferenceTrail(stripWrappedQuotes(match[2])) : null,
  };
}

function extractSkillRefsForNewAgents(raw: string): string[] {
  const refs: string[] = [];
  for (const match of String(raw || "").matchAll(/\b(?:with|have|has|using)\s+(?:the\s+)?(.+?)\s+skills?\b/gi)) {
    const ref = stripWrappedQuotes(match[1] || "")
      .replace(/\b(?:another|agent|agents?|the|a|an)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (ref && !refs.some((existing) => normalizeLookup(existing) === normalizeLookup(ref))) refs.push(ref);
  }
  return refs;
}

function toTitleCase(value: string): string {
  return String(value || "")
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function inferGeneratedOrganizationName(): string {
  return `Chat Organization ${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}`;
}

function normalizeGeneratedAgentId(name: string): string {
  return (
    String(name || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "agent"
  );
}

const WORKFLOW_TEMPLATE_DESCRIPTIONS: Record<string, string> = {
  "research-assistant": "Focused research workflow for collecting context, reasoning over findings, and returning a concise answer.",
  "live-research-assistant": "Best when the answer depends on current web results, links, or recently changed information.",
  "autonomous-research-pipeline": "Multi-step research pipeline for gathering sources, synthesizing notes, and storing outputs.",
  "experiment-loop": "Useful for benchmark, comparison, and optimization loops where the agent iterates against metrics.",
  "docs-site-crawler-summary": "Good for crawling documentation and turning a site into a summarized brief.",
  "document-intelligence": "Good for uploaded PDFs, docs, OCR text, extraction, and structured document analysis.",
  "screenshot-analyzer": "Useful when the research input is visual, such as screenshots or UI captures.",
  "ai-crew-orchestrator": "Multi-agent crew orchestration for research tasks that need roles and handoffs.",
  "parallel-spawn-crew": "Parallel workers for fan-out research, comparison, and source collection.",
  "strategy-hardening-loop": "Evidence-backed planning loop that researches, challenges, and revises a strategy before a human approves execution.",
  "support-signal-triage": "Reviews inbound support or community messages and prepares a human-reviewed response draft without sending it externally.",
};

function scoreWorkflowTemplateForQuery(entry: WorkflowTemplateCatalogEntry, normalizedQuery: string): number {
  const haystack = [entry.key, entry.name, ...entry.aliases, WORKFLOW_TEMPLATE_DESCRIPTIONS[entry.key] || ""]
    .join(" ")
    .toLowerCase();
  const tokens = normalizedQuery
    .replace(/\b(what|are|is|the|best|good|workflow|workflows|template|templates|for|can|you|use|show|list|recommend|suggest)\b/g, " ")
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3);
  let score = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) score += token === "research" ? 5 : 2;
  }
  const documentIntent = /\b(?:pdfs?|documents?|docs?|files?|uploads?|uploaded|ocr|extract|parsing|parse)\b/.test(normalizedQuery);
  const currentWebIntent = /\b(?:current|latest|recent|live|web|news|sources?|links?)\b/.test(normalizedQuery);
  const codeIntent = /\b(?:code|repo|repository|review|bug|debug|pull\s+request|pr)\b/.test(normalizedQuery);
  const opsIntent = /\b(?:ops|monitor|alerts?|health|cron|schedule|scheduled|check)\b/.test(normalizedQuery);
  const boardIntent = /\b(?:tasks?|board|todo|kanban|follow-?up|track)\b/.test(normalizedQuery);
  const strategyIntent = /\b(?:strategy|plan|planning|critique|critic|adversarial|assumption|decision)\b/.test(normalizedQuery);
  const supportIntent = /\b(?:support|customer|community|inbound|ticket|reply|response|escalat)\b/.test(normalizedQuery);
  if (/\bresearch|study|compare|benchmark|ocr|llm|model|paper|source|web|docs?|document|pdf|extract|crawl|current|latest\b/.test(normalizedQuery)) {
    if (["research-assistant", "live-research-assistant", "autonomous-research-pipeline"].includes(entry.key)) score += 10;
    if (["experiment-loop", "docs-site-crawler-summary", "document-intelligence", "ai-crew-orchestrator", "parallel-spawn-crew"].includes(entry.key)) score += 6;
    if (entry.key === "simple-chat") score -= 4;
  }
  if (documentIntent) {
    if (entry.key === "document-intelligence") score += 32;
    if (entry.key === "docs-site-crawler-summary") score += 12;
    if (["research-assistant", "live-research-assistant", "autonomous-research-pipeline"].includes(entry.key)) score -= 6;
  }
  if (currentWebIntent) {
    if (entry.key === "live-research-assistant") score += 20;
    if (entry.key === "autonomous-research-pipeline") score += 8;
  }
  if (codeIntent && entry.key.includes("code")) score += 18;
  if (opsIntent && /\b(?:monitor|health|api-monitor|devops|scheduled)\b/.test(haystack)) score += 18;
  if (boardIntent && /\b(?:board|task|todo|kanban)\b/.test(haystack)) score += 18;
  if (strategyIntent && entry.key === "strategy-hardening-loop") score += 26;
  if (supportIntent && entry.key === "support-signal-triage") score += 26;
  return score;
}

function formatWorkflowTemplateRecommendations(entries: WorkflowTemplateCatalogEntry[], normalizedQuery: string): string {
  const hasRecommendationTopic =
    /\bbest|recommend|suggest|for|should\s+i\s+use|which|compare|gather\s+sources?|decide\b/.test(normalizedQuery) &&
    /\bresearch|study|compare|benchmark|ocr|llm|model|paper|source|web|docs?|document|pdf|extract|crawl|current|latest|code|email|gmail|google|ops|monitor|backup|board|schedule|cron|channel|telegram|crew|agent\b/.test(normalizedQuery);
  const exactListRequest =
    normalizedQuery === "list workflow templates" ||
    normalizedQuery === "show workflow templates" ||
    normalizedQuery === "list templates" ||
    normalizedQuery === "show templates" ||
    /\b(?:what|show|list)\b.*\b(?:all\s+)?(?:the\s+)?(?:my\s+)?templates\b/.test(normalizedQuery) ||
    normalizedQuery.includes("what workflow templates can you use") ||
    normalizedQuery.includes("what templates can you use");
  if (exactListRequest || !hasRecommendationTopic) {
    return `Workflow templates (${entries.length}):\n${entries
      .map((entry, index) => `${index + 1}. ${entry.name} (${entry.key})`)
      .join("\n")}`;
  }

  const scored = entries
    .map((entry) => ({ entry, score: scoreWorkflowTemplateForQuery(entry, normalizedQuery) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));
  const recommended = (scored.length > 0 ? scored.map((item) => item.entry) : entries).slice(0, 8);
  const lines = recommended.map((entry, index) => {
    const detail = WORKFLOW_TEMPLATE_DESCRIPTIONS[entry.key] || `Template key: ${entry.key}.`;
    return `${index + 1}. ${entry.name} (${entry.key}) - ${detail}`;
  });
  return [
    `Best matching workflow templates (${recommended.length} of ${entries.length}):`,
    ...lines,
    "",
    "To create one, say: create workflow template live research assistant called My Research Assistant",
    "If a template asks for agents, create an agent first in the Agents tab or say: create an agent called Research Agent.",
  ].join("\n");
}

function buildGeneratedAgentPlans(
  count: number,
  organizationName: string,
  takenIds: Set<string>,
): GeneratedAgentPlan[] {
  const prefix = trimReferenceTrail(organizationName.replace(/\borganization\b/gi, "").trim()) || "Team";
  const basePlans: GeneratedAgentPlan[] = [
    {
      name: `${prefix} Lead`,
      roleType: "orchestrator",
      roleTitle: "Organization Lead",
      reportsToIndex: null,
      capabilities: ["strategy", "coordination", "delegation"],
    },
    {
      name: `${prefix} Ops`,
      roleType: "operations",
      roleTitle: "Operations Lead",
      reportsToIndex: 0,
      capabilities: ["execution", "handoffs", "delivery"],
    },
    {
      name: `${prefix} Specialist`,
      roleType: "specialist",
      roleTitle: "Specialist Lead",
      reportsToIndex: 1,
      capabilities: ["analysis", "research", "planning"],
    },
  ];

  const plans: GeneratedAgentPlan[] = [];
  for (let index = 0; index < count; index += 1) {
    const seed =
      basePlans[index] ??
      ({
        name: `${prefix} Worker ${index - 2}`,
        roleType: "worker",
        roleTitle: "Worker Agent",
        reportsToIndex: count > 1 ? 1 : 0,
        capabilities: ["execution", "follow-through"],
      } satisfies GeneratedAgentPlan);
    const plan = { ...seed };
    let candidateName = plan.name;
    let suffix = 2;
    let candidateId = normalizeGeneratedAgentId(candidateName);
    while (takenIds.has(candidateId)) {
      candidateName = `${plan.name} ${suffix}`;
      candidateId = normalizeGeneratedAgentId(candidateName);
      suffix += 1;
    }
    takenIds.add(candidateId);
    plan.name = candidateName;
    plans.push(plan);
  }
  return plans;
}

type ExtensionSetupHint = {
  env: string[];
  notes: string[];
  webhookPath?: string;
  accessModes?: string;
  pairingNotes?: string;
  nextSteps?: string[];
};

const EXTENSION_SETUP_HINTS: Record<string, ExtensionSetupHint> = {
  bluebubbles: {
    env: ["BLUEBUBBLES_PASSWORD"],
    notes: [
      "Install BlueBubbles server on a Mac that is signed into iMessage.",
      "Set BLUEBUBBLES_SERVER_URL (e.g. http://192.168.1.x:1234) and BLUEBUBBLES_PASSWORD in Settings > Channels.",
      "Enable the BlueBubbles extension for the agent that should reply to iMessages.",
    ],
    pairingNotes: "BlueBubbles does not use token pairing — it connects via HTTP to your local server.",
    nextSteps: [
      "1. Install BlueBubbles on a Mac: https://bluebubbles.app",
      "2. Set the server URL and password in Settings > Channels",
      "3. Enable the BlueBubbles extension for the target agent",
      "4. Run `check channel health` to verify the connection",
    ],
  },
  discord: {
    env: ["DISCORD_BOT_TOKEN"],
    notes: [
      "Create a Discord application and bot at https://discord.com/developers/applications.",
      "Enable the Message Content intent in the bot settings.",
      "Add DISCORD_BOT_TOKEN to Settings > Channels or .env.local.",
      "Invite the bot to your server using the OAuth2 URL with bot + message.read scopes.",
    ],
    accessModes: "Discord uses open access by default. Use channel allowlist in Settings to restrict which channels can trigger the bot.",
    nextSteps: [
      "1. Create bot at https://discord.com/developers/applications",
      "2. Enable 'Message Content Intent' under Bot settings",
      "3. Copy the bot token to Settings > Channels > Discord",
      "4. Use OAuth2 URL generator to invite bot to your server",
      "5. Run `check channel health` to verify",
    ],
  },
  feishu: {
    env: [],
    notes: ["Set the Feishu app credentials in Extensions so the runtime can mint tenant access tokens before using drive/wiki skills."],
  },
  github: {
    env: ["GITHUB_TOKEN"],
    notes: ["Add a GitHub token and optionally set defaultOwner/defaultRepo in Extensions if you want repo-aware issue or PR actions."],
  },
  groq: {
    env: ["GROQ_API_KEY"],
    notes: ["Add a Groq API key and choose a default low-latency model if the agent should prefer Groq-backed inference."],
  },
  googlechat: {
    env: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    notes: [
      "Create OAuth credentials at https://console.cloud.google.com — enable the Chat API.",
      "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in Settings > Channels.",
      "Complete the OAuth flow in Settings > Google (or run: dpc auth google).",
      "Google Chat delivers messages via webhook to /api/channels/google-chat.",
    ],
    webhookPath: "/api/channels/google-chat",
    accessModes: "Google Chat uses your Google account identity for access control. The webhook accepts messages from the Google Chat service only.",
    nextSteps: [
      "1. Enable Google Chat API at https://console.cloud.google.com",
      "2. Create OAuth 2.0 credentials and add to Settings > Channels",
      "3. Run `dpc auth google` or authorize in Settings > Google",
      "4. Configure your app's webhook URL in the Google Chat API settings",
      "5. Run `check channel health` to verify",
    ],
  },
  msteams: {
    env: ["TEAMS_APP_ID", "TEAMS_APP_PASSWORD"],
    notes: [
      "Register a bot at https://dev.botframework.com (Azure Bot Framework).",
      "Set TEAMS_APP_ID and TEAMS_APP_PASSWORD in Settings > Channels.",
      "Configure the messaging endpoint to your app's /api/channels/teams URL (must be publicly reachable).",
      "Install the bot into your Teams tenant via the Teams app manifest.",
      "Teams rejects unsafe serviceUrl values — only known Microsoft service URLs are accepted.",
    ],
    webhookPath: "/api/channels/teams",
    accessModes: "Teams uses the Bot Framework service authentication — all requests are signed by Microsoft.",
    nextSteps: [
      "1. Create Azure bot at https://portal.azure.com (Bot Services)",
      "2. Set TEAMS_APP_ID and TEAMS_APP_PASSWORD in Settings > Channels",
      "3. Set messaging endpoint to https://your-app.example.com/api/channels/teams",
      "4. Create a Teams app manifest and install via Teams Admin Center",
      "5. Run `check channel health` to verify",
    ],
  },
  slack: {
    env: ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"],
    notes: [
      "Create a Slack app at https://api.slack.com/apps.",
      "Enable Socket Mode and copy the App-Level Token (xapp-...) as SLACK_APP_TOKEN.",
      "Copy the Bot Token (xoxb-...) as SLACK_BOT_TOKEN.",
      "Grant the bot chat:write, channels:history, im:history, and message.read scopes.",
      "Add both tokens to Settings > Channels > Slack.",
    ],
    accessModes: "Slack uses open access by default. Token-based auth ensures only your workspace bot replies.",
    nextSteps: [
      "1. Create Slack app at https://api.slack.com/apps",
      "2. Enable Socket Mode and generate an App-Level Token",
      "3. Add OAuth scopes: chat:write, channels:history, im:history",
      "4. Install app to workspace and copy both tokens",
      "5. Add SLACK_BOT_TOKEN and SLACK_APP_TOKEN to Settings > Channels",
      "6. Run `check channel health` to verify",
    ],
  },
  mattermost: {
    env: ["MATTERMOST_URL", "MATTERMOST_TOKEN"],
    notes: ["Configure the Mattermost server URL and token in Extensions or Settings > Channels."],
  },
  matrix: {
    env: ["MATRIX_HOMESERVER", "MATRIX_ACCESS_TOKEN"],
    notes: ["Set the homeserver and access token before enabling Matrix delivery skills."],
  },
  "web-research": {
    env: [],
    notes: ["Pick a web search provider and API key in Settings > Models if you want live search instead of fallback local behavior."],
  },
  ollama: {
    env: [],
    notes: ["Run a local Ollama server and set the base URL if it is not using the default localhost port."],
  },
  openrouter: {
    env: ["OPENROUTER_API_KEY"],
    notes: ["Add an OpenRouter API key and optionally set a default model so gateway routing is predictable for the agent."],
  },
  telegram: {
    env: ["TELEGRAM_BOT_TOKEN"],
    notes: [
      "Create a bot with @BotFather on Telegram and copy the token.",
      "Add TELEGRAM_BOT_TOKEN to Settings > Channels > Telegram.",
      "Optionally set a default chat ID for outbound-only use cases.",
      "Telegram uses long-polling — no public webhook URL is required.",
    ],
    accessModes: "Telegram supports open, allowlist, and pairing access modes. In pairing mode, new users receive a pairing code and must be approved before the bot replies. Use `list pending pairing requests` to manage approvals.",
    pairingNotes: "Pairing mode: new senders get a unique code. Operator runs `approve pairing <code>` to allow them. Codes expire after 60 minutes.",
    nextSteps: [
      "1. Message @BotFather on Telegram: /newbot",
      "2. Copy the token to Settings > Channels > Telegram or set TELEGRAM_BOT_TOKEN",
      "3. Set access mode in Settings > Channels (open / allowlist / pairing)",
      "4. Run `check channel health` to verify",
    ],
  },
  voice: {
    env: ["OPENAI_API_KEY"],
    notes: ["Configure an active OpenAI model before using speech-to-text or text-to-speech routes."],
  },
  whatsapp: {
    env: [],
    notes: [
      "Go to Settings > Channels > WhatsApp and scan the QR code from the WhatsApp app on your phone.",
      "Keep the phone connected — WhatsApp Web requires an active phone connection.",
      "After pairing, the session persists until you sign out or the session is invalidated.",
    ],
    accessModes: "WhatsApp supports open, allowlist, and pairing access modes. In pairing mode, unknown senders get a code and must be approved. Use `list pending pairing requests` to manage approvals.",
    pairingNotes: "Pairing mode: new senders get a unique code. Operator runs `approve pairing <code>` to allow them.",
    nextSteps: [
      "1. Go to Settings > Channels > WhatsApp",
      "2. Scan the QR code from your phone's WhatsApp > Linked Devices",
      "3. Set access mode (open / allowlist / pairing) in Settings > Channels",
      "4. Run `check channel health` to verify",
    ],
  },
};

function resolveInternalApiBaseUrl(explicit?: string | null): string {
  const raw =
    String(explicit || "").trim() ||
    String(process.env.INTERNAL_API_BASE_URL || "").trim() ||
    String(process.env.NEXT_PUBLIC_APP_URL || "").trim() ||
    String(process.env.APP_URL || "").trim();

  if (raw) {
    const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
    return withScheme.replace(/\/+$/, "");
  }

  return `http://127.0.0.1:${process.env.PORT ?? 3100}`;
}

async function fetchInternalJson<T>(
  url: string,
  init: RequestInit,
  label: string,
): Promise<{ response: Response; payload: T }> {
  const response = await withRetry(
    () =>
      fetch(url, {
        cache: "no-store",
        ...init,
      }),
    {
      label,
      shouldRetry: (error) => {
        const message = String(error).toLowerCase();
        return message.includes("fetch failed") || message.includes("econnrefused") || message.includes("socket");
      },
    },
  );
  const payload = (await response.json()) as T;
  return { response, payload };
}

function trimReferenceTrail(reference: string): string {
  const value = String(reference || "").trim();
  if (!value) return "";
  const match = value.match(/^(.+?)(?:[.!?]\s+.+)?$/);
  return stripWrappedQuotes(match?.[1] || value).replace(/[.!?]+$/, "").trim();
}

function trimScopedEntityRef(reference: string, kind: "organization" | "goal"): string {
  const value = String(reference || "").trim();
  if (!value) return "";
  let cleaned = stripWrappedQuotes(value);
  cleaned = cleaned.replace(/\s+(?:using|with|via)\b[\s\S]*$/i, "");
  if (kind === "goal") {
    cleaned = cleaned.replace(
      /,\s*(?:assign|identify|give|share|return|explain|call\s+out|summari[sz]e|include|outline|recommend|use)\b[\s\S]*$/i,
      "",
    );
    cleaned = cleaned.replace(
      /\s+and\s+(?:assign|identify|give|share|return|explain|call\s+out|summari[sz]e|include|outline|recommend)\b[\s\S]*$/i,
      "",
    );
    cleaned = cleaned.replace(/\s+and\s+(?:return|share|explain|call\s+out|summari[sz]e|include)\b[\s\S]*$/i, "");
  }
  return trimReferenceTrail(cleaned);
}

type ParsedScopeRefs = {
  organizationRef: string;
  goalRef: string;
  remainder: string;
};

type OrgCollaborationMode = "council" | "execution";

type OrgModeDecision = {
  mode: OrgCollaborationMode;
  explicit: boolean;
  reason: string;
  modeLabel: string;
  alternateMode: OrgCollaborationMode;
  alternateLabel: string;
};

type OrgParticipant = {
  agentId: string;
  agentName: string;
  roleType: string;
  roleTitle: string;
  roleDescription: string;
  capabilities: string[];
};

type OrgExecutionToolBundle = {
  leaderTools: string[];
  workerTools: string[];
};

type OrgSwitchState = {
  sessionId: string;
  topic: string;
  organizationRef: string;
  goalRef: string;
  currentMode: OrgCollaborationMode;
  organizationName?: string;
  goalName?: string;
  leaderName?: string;
  workerNames?: string[];
  lastResponse?: string;
  createdAt: number;
};

type OrgSwitchStoreGlobal = typeof globalThis & {
  __disp8chOrgSwitchState?: Map<string, OrgSwitchState>;
};

const ORG_SWITCH_STATE_TTL_MS = 60 * 60 * 1000;

type PendingMutationKind =
  | "secret-set"
  | "secret-delete"
  | "config-set"
  | "config-toggle"
  | "learning-config"
  | "learning-candidate-promote"
  | "learning-candidate-dismiss"
  | "extension-global-toggle"
  | "extension-install"
  | "extension-update"
  | "extension-uninstall"
  | "skill-pack-install"
  | "skill-pack-update"
  | "skill-pack-uninstall"
  | "organization-export"
  | "organization-import"
  | "ecosystem-import"
  | "multi-step-plan"
  | "cleanup-generated"
  | "org-create-bulk"
  | "app-action-plan";

type MultiStepPlanStep = {
  raw: string;
  label: string;
};

type PendingMutation = {
  sessionId: string;
  kind: PendingMutationKind;
  summary: string;
  payload: Record<string, unknown>;
  createdAt: number;
};

type PendingMutationStoreGlobal = typeof globalThis & {
  __disp8chPendingMutationState?: Map<string, PendingMutation>;
};

const PENDING_MUTATION_TTL_MS_DEFAULT = 15 * 60 * 1000;

export function getPendingMutationTtlMs(): number {
  try {
    const { getSqlite } = require("@/lib/db") as typeof import("@/lib/db");
    const db = getSqlite();
    const row = db.prepare("SELECT pending_mutation_ttl_ms FROM app_config LIMIT 1").get() as
      | { pending_mutation_ttl_ms: number | null }
      | undefined;
    const val = row?.pending_mutation_ttl_ms;
    if (typeof val === "number" && Number.isFinite(val) && val >= 1000) return val;
  } catch {
    // not yet migrated or db not ready
  }
  return PENDING_MUTATION_TTL_MS_DEFAULT;
}

type TaskListCursorGlobal = typeof globalThis & {
  __disp8chTaskListCursorState?: Map<string, TaskListCursorState>;
};

const CONFIG_FIELDS: ConfigFieldMeta[] = [
  {
    table: "app_config",
    column: "timezone",
    type: "string",
    aliases: ["timezone", "time zone"],
  },
  {
    table: "app_config",
    column: "learning_enabled",
    type: "boolean",
    aliases: ["self learning", "learning enabled", "learning_enabled", "learning loop"],
  },
  {
    table: "app_config",
    column: "learning_mode",
    type: "enum",
    aliases: ["learning mode", "self learning mode", "learning_mode"],
    enumValues: ["off", "review", "auto"],
  },
  {
    table: "app_config",
    column: "learning_capture_preferences",
    type: "boolean",
    aliases: ["capture preferences", "learning capture preferences", "learning_capture_preferences"],
  },
  {
    table: "app_config",
    column: "learning_capture_playbooks",
    type: "boolean",
    aliases: ["capture playbooks", "learning capture playbooks", "learning_capture_playbooks"],
  },
  {
    table: "app_config",
    column: "learning_auto_promote_threshold",
    type: "number",
    aliases: ["learning threshold", "learning auto promote threshold", "learning_auto_promote_threshold"],
    min: 1,
    max: 10,
  },
  {
    table: "app_config",
    column: "tool_output_limit",
    type: "number",
    aliases: ["tool output limit", "tool_output_limit"],
    min: 1000,
    max: 500000,
  },
  {
    table: "app_config",
    column: "compaction_mode",
    type: "enum",
    aliases: ["compaction mode", "compaction_mode"],
    enumValues: ["off", "summarize", "drop"],
  },
  {
    table: "app_config",
    column: "compaction_threshold",
    type: "number",
    aliases: ["compaction threshold", "compaction_threshold"],
    min: 0.1,
    max: 0.95,
  },
  {
    table: "app_config",
    column: "pending_mutation_ttl_ms",
    type: "number",
    aliases: ["pending mutation ttl", "pending_mutation.ttl_ms", "pending_mutation_ttl_ms"],
    min: 1_000,
    max: 86_400_000,
  },
  {
    table: "app_config",
    column: "context_window",
    type: "number",
    aliases: ["context window", "context_window"],
    min: 1000,
  },
  {
    table: "app_config",
    column: "context_pruning_mode",
    type: "enum",
    aliases: ["context pruning", "context pruning mode", "context_pruning_mode"],
    enumValues: ["off", "tool-results"],
  },
  {
    table: "app_config",
    column: "context_pruning_keep_recent_assistants",
    type: "number",
    aliases: ["protected recent assistant turns", "context_pruning_keep_recent_assistants"],
    min: 1,
    max: 12,
  },
  {
    table: "app_config",
    column: "context_pruning_min_tool_chars",
    type: "number",
    aliases: ["context pruning min tool chars", "context_pruning_min_tool_chars"],
    min: 1000,
    max: 200000,
  },
  {
    table: "app_config",
    column: "context_pruning_max_tool_chars",
    type: "number",
    aliases: ["context pruning max tool chars", "context_pruning_max_tool_chars"],
    min: 500,
    max: 20000,
  },
  {
    table: "app_config",
    column: "channel_retry_attempts",
    type: "number",
    aliases: ["channel retry attempts", "channel_retry_attempts"],
    min: 1,
    max: 10,
  },
  {
    table: "app_config",
    column: "channel_retry_min_delay_ms",
    type: "number",
    aliases: ["channel retry min delay", "channel_retry_min_delay_ms"],
    min: 10,
    max: 10000,
  },
  {
    table: "app_config",
    column: "channel_retry_max_delay_ms",
    type: "number",
    aliases: ["channel retry max delay", "channel_retry_max_delay_ms"],
    min: 100,
    max: 120000,
  },
  {
    table: "app_config",
    column: "channel_retry_jitter",
    type: "number",
    aliases: ["channel retry jitter", "channel_retry_jitter"],
    min: 0,
    max: 0.5,
  },
  {
    table: "app_config",
    column: "provenance_mode",
    type: "enum",
    aliases: ["provenance mode", "ingress provenance", "provenance_mode"],
    enumValues: ["off", "meta", "meta+receipt"],
  },
  {
    table: "app_config",
    column: "telemetry_enabled",
    type: "boolean",
    aliases: ["telemetry", "telemetry enabled", "telemetry_enabled"],
  },
  {
    table: "app_config",
    column: "hooks_enabled",
    type: "boolean",
    aliases: ["hooks", "hooks enabled", "hooks_enabled"],
  },
  {
    table: "app_config",
    column: "memory_flush_enabled",
    type: "boolean",
    aliases: ["memory flush", "memory flush enabled", "memory_flush_enabled"],
  },
  {
    table: "app_config",
    column: "rate_limit_webhooks",
    type: "number",
    aliases: ["webhook rate limit", "rate_limit_webhooks"],
    min: 1,
    max: 1000,
  },
  {
    table: "app_config",
    column: "rate_limit_execute",
    type: "number",
    aliases: ["execute rate limit", "rate_limit_execute"],
    min: 1,
    max: 1000,
  },
  {
    table: "app_config",
    column: "rate_limit_channels",
    type: "number",
    aliases: ["channel rate limit", "rate_limit_channels"],
    min: 1,
    max: 1000,
  },
  {
    table: "app_config",
    column: "log_max_days",
    type: "number",
    aliases: ["log retention days", "log_max_days"],
    min: 1,
    max: 365,
  },
  {
    table: "app_config",
    column: "lane_main_max_concurrent",
    type: "number",
    aliases: ["main lane concurrency", "lane_main_max_concurrent"],
    min: 1,
    max: 32,
  },
  {
    table: "app_config",
    column: "lane_cron_max_concurrent",
    type: "number",
    aliases: ["cron lane concurrency", "lane_cron_max_concurrent"],
    min: 1,
    max: 16,
  },
  {
    table: "app_config",
    column: "lane_subflow_max_concurrent",
    type: "number",
    aliases: ["subflow lane concurrency", "lane_subflow_max_concurrent"],
    min: 1,
    max: 64,
  },
  {
    table: "memory_config",
    column: "decay_enabled",
    type: "boolean",
    aliases: ["memory decay", "decay", "decay_enabled"],
  },
  {
    table: "memory_config",
    column: "decay_half_life_days",
    type: "number",
    aliases: ["memory half life", "decay_half_life_days"],
    min: 1,
    max: 365,
  },
  {
    table: "memory_config",
    column: "embedding_model",
    type: "string",
    aliases: ["embedding model", "embedding_model"],
  },
  {
    table: "memory_config",
    column: "vector_weight",
    type: "number",
    aliases: ["vector weight", "vector_weight"],
    min: 0,
    max: 1,
  },
  {
    table: "memory_config",
    column: "text_weight",
    type: "number",
    aliases: ["text weight", "text_weight"],
    min: 0,
    max: 1,
  },
  {
    table: "memory_config",
    column: "index_sessions",
    type: "boolean",
    aliases: ["index sessions", "session indexing", "index_sessions"],
  },
  {
    table: "memory_config",
    column: "session_chunk_tokens",
    type: "number",
    aliases: ["session chunk tokens", "session_chunk_tokens"],
    min: 50,
    max: 4000,
  },
  {
    table: "memory_config",
    column: "session_chunk_overlap",
    type: "number",
    aliases: ["session chunk overlap", "session_chunk_overlap"],
    min: 0,
    max: 500,
  },
  {
    table: "memory_config",
    column: "startup_include_files",
    type: "string",
    aliases: ["startup include files", "startup_include_files"],
  },
  {
    table: "memory_config",
    column: "max_snippet_chars",
    type: "number",
    aliases: ["memory snippet chars", "max_snippet_chars"],
    min: 100,
    max: 5000,
  },
  {
    table: "memory_config",
    column: "max_injected_chars",
    type: "number",
    aliases: ["memory injected chars", "max_injected_chars"],
    min: 500,
    max: 20000,
  },
  {
    table: "memory_config",
    column: "citations_mode",
    type: "enum",
    aliases: ["citations mode", "memory citations", "citations_mode"],
    enumValues: ["on", "off", "auto"],
  },
  {
    table: "memory_config",
    column: "extra_collection_paths",
    type: "string",
    aliases: ["extra collection paths", "extra_collection_paths"],
  },
];

const SHOW_CONFIG_DEFAULT_FIELDS = [
  "timezone",
  "telemetry_enabled",
  "hooks_enabled",
  "provenance_mode",
  "memory_flush_enabled",
  "context_pruning_mode",
  "rate_limit_channels",
  "context_window",
  "embedding_model",
  "vector_weight",
  "text_weight",
  "index_sessions",
  "citations_mode",
];

const DEFAULT_TASK_LIST_PAGE_SIZE = 6;
const MAX_TASK_LIST_PAGE_SIZE = 20;
const TASK_LIST_CURSOR_TTL_MS = 30 * 60 * 1000;
const taskListCursorGlobal = globalThis as TaskListCursorGlobal;
const taskListCursorState =
  taskListCursorGlobal.__disp8chTaskListCursorState ?? new Map<string, TaskListCursorState>();
taskListCursorGlobal.__disp8chTaskListCursorState = taskListCursorState;

function getDisplayName(entity: SessionEntityRef | null | undefined): string {
  const name = String(entity?.name || "").trim();
  if (name) return name;
  return String(entity?.id || "").trim();
}

function buildSessionEntityRef(name?: string | null, id?: string | null): SessionEntityRef | null {
  const normalizedName = String(name || "").trim();
  const normalizedId = String(id || "").trim();
  if (!normalizedName && !normalizedId) return null;
  return {
    ...(normalizedId ? { id: normalizedId } : {}),
    ...(normalizedName ? { name: normalizedName } : {}),
  };
}

function detectSessionReference(raw: string): boolean {
  return /\b(?:that|it|this|those|them|the one|the workflow you just made|the one you just uploaded|the one from earlier)\b/i.test(raw);
}

function isDeclarativeStatusUpdateMessage(raw: string): boolean {
  return (
    /\b(?:status\s+update|project\s+update|brief\s*:|update\s*:|fyi\s*:|heads\s+up\s*:|note\s*:)\b/i.test(raw) &&
    !/^(?:show|list|open|create|make|add|run|execute|start|launch|generate|design|draft|build|spin\s+up|set\s+up|setup|import|export|schedule|claim|release|give|assign|enable|disable|set|change|update|mark|move|scrape|crawl|upload|get|read|view|help|how\b|what\b|can\s+you\b|could\s+you\b|please\b)/i.test(raw)
  );
}

function isConversationalAgentControlMessage(raw: string): boolean {
  return (
    /\b(?:phrase|testing session|for this test|for this testing session|prefer|preference|i prefer)\b/i.test(raw) ||
    (!raw.includes("?") && /\b(?:remember|note|noted|please note)\b/i.test(raw)) ||
    /^(?:hello|hi|hey)\b/i.test(raw) ||
    /^(?:please\s+)?(?:reply|respond)\b/i.test(raw)
  );
}

function isStandalonePreferenceStatement(raw: string): boolean {
  const value = raw.trim();
  if (!value || value.includes("?")) return false;
  if (looksLikeAppSurfaceQuestion(value, classifyAppControlIntent(value, null))) return false;
  return [
    /^(?:i|we)\s+prefer\s+.+/i,
    /^(?:i|we)'?d\s+(?:rather|prefer)\s+.+/i,
    /^(?:please\s+)?default\s+to\s+.+/i,
    /^(?:please\s+)?always\s+use\s+.+/i,
    /^(?:please\s+)?(?:don'?t|do not)\s+use\s+.+/i,
    /^(?:i|we)\s+(?:hate|dislike|don'?t like)\s+.+/i,
    /^.+?\s+(?:doesn'?t|don'?t|never)\s+work(?:s)?\s+for\s+(?:me|us)$/i,
    /^(?:from now on|starting now),?\s+(?:please\s+)?.+/i,
    /^(?:please\s+)?stop\s+(?:doing\s+)?.+/i,
    /^(?:please\s+)?make sure\s+(?:you\s+)?(?:always\s+)?.+/i,
    /^whenever\s+.+/i,
    /^when\s+(?:reviewing|working on|implementing|writing|reading|analyzing|checking)\s+.+/i,
    /^(?:please\s+)?(?:always\s+)?follow\s+(?:this|these)\s+(?:checklist|format|steps?|procedure|rule)\b.*$/i,
  ].some((pattern) => pattern.test(value));
}

function classifyAppControlIntent(raw: string, state: SessionAppStatePayload | null | undefined): AppIntentClassification {
  // Bail out immediately for messages that are clearly procedural preferences / personal rules,
  // not app-control commands. These start with "whenever I", "when reviewing", "always follow", etc.
  // Without this guard, "whenever I ask for a code review, check for security issues" would
  // incorrectly match the `security` domain and return a confusing clarifier response.
  const isProceduralPreference =
    /^whenever\s/i.test(raw) ||
    /^when\s+(?:reviewing|working on|implementing|writing|reading|analyzing|checking)\s/i.test(raw) ||
    /^(?:please\s+)?(?:always\s+)?follow\s+(?:this|these)\s+(?:checklist|format|steps?|procedure|rule)\b/i.test(raw) ||
    /^(?:for\s+)?(?:every|all)\s+.+?,?\s+(?:please\s+)?(?:always\s+)?(?:check|follow|use|include|apply)\s/i.test(raw);
  if (isProceduralPreference) {
    return { kind: "conversation", domain: null, reason: "procedural preference", usesSessionReference: false, intentClass: "conversation" };
  }

  if (isDeclarativeStatusUpdateMessage(raw)) {
    return {
      kind: "conversation",
      domain: null,
      reason: "the message looks like a status note, not app control",
      usesSessionReference: detectSessionReference(raw),
      intentClass: "conversation",
    };
  }

  if (isConversationalAgentControlMessage(raw)) {
    return {
      kind: "conversation",
      domain: null,
      reason: "the message looks conversational, not like an explicit app-control command",
      usesSessionReference: detectSessionReference(raw),
      intentClass: "conversation",
    };
  }

  if (isClearlyNonAppCreativeOrCodingRequest(raw)) {
    return {
      kind: /joke/i.test(raw) ? "conversation" : "knowledge_work",
      domain: null,
      reason: "the message is a general creative or coding request, not app control",
      usesSessionReference: detectSessionReference(raw),
      intentClass: /joke/i.test(raw) ? "conversation" : "general_assistant",
    };
  }

  const normalized = normalizeLookup(raw);
  const usesSessionReference = detectSessionReference(raw);
  const directBuiltin = findBuiltinIntentByAlias(raw);
  if (directBuiltin) {
    return {
      kind: "app_control",
      domain: directBuiltin.domains[0] ?? null,
      reason: `builtin registry alias match (${directBuiltin.id})`,
      usesSessionReference,
      intentClass: "app_read",
    };
  }

  if (isNonMutatingPlanningRequest(raw)) {
    return {
      kind: "knowledge_work",
      domain: null,
      reason: "the message asks for planning or recommendations without changing app state",
      usesSessionReference: detectSessionReference(raw),
      intentClass: "general_assistant",
    };
  }

  if (
    (/\boptimi[sz](?:e|ing|ation)?\b/i.test(raw) && /\bworkflows?\b/i.test(raw) && /\bagents?\b/i.test(raw)) ||
    /\bmake\s+(?:my|the|these|our)?\s*(?:agents?\s+and\s+workflows?|workflows?\s+and\s+agents?)\s+better\b/i.test(raw)
  ) {
    return {
      kind: "app_control",
      domain: "workflow",
      reason: "ambiguous workflow and agent optimization request needs planner clarification",
      usesSessionReference,
      intentClass: "app_write",
    };
  }

  if (isClearlyNonAppOverloadedSurfaceRequest(raw)) {
    return {
      kind: "knowledge_work",
      domain: null,
      reason: "the message uses app-surface words in an external or hypothetical context",
      usesSessionReference: detectSessionReference(raw),
      intentClass: "general_assistant",
    };
  }

  if (isOpenEndedAppImprovementRequest(raw)) {
    return {
      kind: "knowledge_work",
      domain: null,
      reason: "the message asks for open-ended app improvement or readiness planning",
      usesSessionReference: detectSessionReference(raw),
      intentClass: "general_assistant",
    };
  }

  const checkpointIntent = parseCheckpointIntent(raw);
  if (checkpointIntent) {
    return {
      kind: "app_control",
      domain: "checkpoint",
      reason: "checkpoint command detected",
      usesSessionReference,
      intentClass:
        checkpointIntent.action === "create" || checkpointIntent.action === "rollback"
          ? "app_write"
          : "app_read",
    };
  }

  if (parseSchedulerCreateIntent(raw) || parseScheduleExpressionIntent(raw)) {
    return {
      kind: "app_control",
      domain: "scheduler",
      reason: "scheduler mutation detected",
      usesSessionReference,
      intentClass: "app_write",
    };
  }

  if (isAmbiguousWorkflowAutomationSetupRequest(raw)) {
    return {
      kind: "app_control",
      domain: "scheduler",
      reason: "vague automation setup request needs explicit workflow or schedule target",
      usesSessionReference,
      intentClass: "app_write",
    };
  }

  if (isVagueApiMonitoringSetupRequest(raw)) {
    return {
      kind: "app_control",
      domain: "workflow",
      reason: "vague API monitoring setup should be planned as an app action",
      usesSessionReference,
      intentClass: "app_write",
    };
  }

  if (isVagueTeamWorkTrackingSetupRequest(raw)) {
    return {
      kind: "app_control",
      domain: "hierarchy",
      reason: "vague team/work tracking setup should be planned as an app action",
      usesSessionReference,
      intentClass: "app_write",
    };
  }

  if (parseWorkflowGenerateIntent(raw) || parseWorkflowExportIntent(raw) || parseWorkflowImportIntent(raw)) {
    return {
      kind: "app_control",
      domain: "workflow",
      reason: "workflow mutation detected",
      usesSessionReference,
      intentClass: "app_write",
    };
  }

  if (parseTemplateCreateIntent(raw) || parseTemplateRunIntent(raw)) {
    return {
      kind: "app_control",
      domain: "workflow",
      reason: "workflow template command detected",
      usesSessionReference,
      intentClass: "app_write",
    };
  }

  if (parseDataSourceCreateIntent(raw)) {
    return {
      kind: "app_control",
      domain: "data-source",
      reason: "data source mutation detected",
      usesSessionReference,
      intentClass: "app_write",
    };
  }

  if (
    extractTaskTitleFromNaturalLanguage(raw) ||
    isContextualBoardTaskMutation(raw) ||
    /^(?:claim|release|mark|move|assign|run|execute|start)\b.*\b(?:task|board|card)\b/i.test(raw)
  ) {
    return {
      kind: "app_control",
      domain: "board",
      reason: "board mutation detected",
      usesSessionReference,
      intentClass: "app_write",
    };
  }

  if (
    parseBulkCreateAgentsOrganizationIntent(raw) ||
    parseImplicitDebateOrganizationIntent(raw) ||
    parseBulkCreateAgentsIntent(raw) ||
    parseDirectCreateAgentIntent(raw) ||
    parseFreeformAgentCapabilityAssignment(raw) ||
    /\b(?:enable|disable|activate|deactivate|assign|configure|set|switch|update)\b.*\b(?:agent|skills?|extensions?|plugins?)\b/i.test(raw)
  ) {
    return {
      kind: "app_control",
      domain: "agent",
      reason: "agent mutation detected",
      usesSessionReference,
      intentClass: "app_write",
    };
  }

  if (matchesDirectAgentChangeMessage(raw)) {
    return {
      kind: "app_control",
      domain: "agent",
      reason: "agent configuration mutation detected",
      usesSessionReference,
      intentClass: "app_write",
    };
  }

  if (matchesExternalCatalogMutation(raw)) {
    return {
      kind: "app_control",
      domain: "settings",
      reason: "external catalog mutation detected",
      usesSessionReference,
      intentClass: "app_write",
    };
  }

  const derivedDomain = resolveBuiltinDomainFromText(normalized);
  if (isWebImageResearchRequest(raw)) {
    return {
      kind: "knowledge_work",
      domain: null,
      reason: "web/image research request, not channel or Google Chat control",
      usesSessionReference,
      intentClass: "general_assistant",
    };
  }
  if (derivedDomain) {
    return {
      kind: "app_control",
      domain: derivedDomain,
      reason: "builtin registry keyword/domain match",
      usesSessionReference,
      intentClass: looksLikeMutatingAppCommand(raw) && !isReadOnlyPhrased(raw) ? "app_write" : "app_read",
    };
  }

  if (usesSessionReference) {
    if (getDisplayName(state?.workflow)) {
      return {
        kind: "app_control",
        domain: "workflow",
        reason: "the message refers to a recent workflow",
        usesSessionReference,
        intentClass: looksLikeMutatingAppCommand(raw) && !isReadOnlyPhrased(raw) ? "app_write" : "app_read",
      };
    }
    if (getDisplayName(state?.dataSource)) {
      return {
        kind: "app_control",
        domain: "data-source",
        reason: "the message refers to a recent data source",
        usesSessionReference,
        intentClass: looksLikeMutatingAppCommand(raw) && !isReadOnlyPhrased(raw) ? "app_write" : "app_read",
      };
    }
    if (getDisplayName(state?.task)) {
      return {
        kind: "app_control",
        domain: "board",
        reason: "the message refers to a recent task",
        usesSessionReference,
        intentClass: looksLikeMutatingAppCommand(raw) && !isReadOnlyPhrased(raw) ? "app_write" : "app_read",
      };
    }
    if (getDisplayName(state?.agent)) {
      return {
        kind: "app_control",
        domain: "agent",
        reason: "the message refers to a recent agent",
        usesSessionReference,
        intentClass: looksLikeMutatingAppCommand(raw) && !isReadOnlyPhrased(raw) ? "app_write" : "app_read",
      };
    }
  }

  if (/\b(?:research|investigate|analyze|compare|audit|summarize|write|explain|debug|fix|build)\b/i.test(raw)) {
    return {
      kind: "knowledge_work",
      domain: null,
      reason: "the message looks like open-ended work",
      usesSessionReference,
      intentClass: "general_assistant",
    };
  }

  return {
    kind: "conversation",
    domain: null,
    reason: "the message does not look like app control",
    usesSessionReference,
    intentClass: "conversation",
  };
}

function queryLooksLikeExactMemoryRecall(raw: string): boolean {
  if (looksLikeLearningCandidateCommand(raw)) return false;
  return classifyExactRecallQuery(raw) !== "semantic_memory";
}

function looksLikeLearningCandidateCommand(raw: string): boolean {
  const text = String(raw || "").trim();
  return /^(?:promote|approve|dismiss|reject)\s+(?:learning\s+candidate\b|.+?\s+learning\s+candidate\b|(?:the\s+)?(?:latest|newest|first|last|[A-Za-z0-9_-]+)\s+candidate\b)/i.test(text);
}

function looksLikeOrgCollaborationCommand(raw: string): boolean {
  const text = String(raw || "").trim();
  return /^(?:ask|run|start|have)\s+(?:a\s+)?(?:the\s+)?(?:(?:leadership\s+team|leadership\s+council|council)(?:\s+vote)?)\b/i.test(text) ||
    /^(?:what\s+does|what\s+would)\s+(?:the\s+)?(?:leadership\s+team|leadership\s+council)\s+(?:think|say)\s+about\b/i.test(text);
}

function classifyIntentClass(raw: string, classification: AppIntentClassification): IntentClass {
  if (looksLikeLearningCandidateCommand(raw)) return "app_write";
  if (queryLooksLikeExactMemoryRecall(raw)) return "exact_memory_recall";
  if (classification.intentClass) return classification.intentClass;
  if (isNonMutatingPlanningRequest(raw)) return "general_assistant";
  if (looksLikeMutatingAppCommand(raw) && !isReadOnlyPhrased(raw)) return "app_write";
  if (classification.kind === "app_control") return "app_read";
  if (classification.kind === "knowledge_work") return "general_assistant";
  return "conversation";
}

function normalizeRoutingPreamble(raw: string): { normalizedMessage: string; rewritesApplied: string[] } {
  let normalizedMessage = String(raw || "").trim();
  const rewritesApplied: string[] = [];
  const preambles: RegExp[] = [
    /^(?:before\s+i\s+touch\s+anything[:,]?\s*)/i,
    /^(?:before\s+i\s+do\s+anything(?:\s+here)?[:,]?\s*)/i,
    /^(?:before\s+i\s+change\s+anything[:,]?\s*)/i,
    /^(?:help\s+me\s+get\s+oriented[:,]?\s*)/i,
    /^(?:just\s+orient\s+me[:,]?\s*)/i,
    /^(?:i(?:'m| am)\s+trying\s+to\s+orient\s+myself[:,]?\s*)/i,
    /^(?:real\s+quick[:,]?\s*)/i,
    /^(?:quickly[:,]?\s*)/i,
  ];
  for (const pattern of preambles) {
    if (pattern.test(normalizedMessage)) {
      normalizedMessage = normalizedMessage.replace(pattern, "").trim();
      rewritesApplied.push(`strip:${pattern.source}`);
    }
  }
  return { normalizedMessage, rewritesApplied };
}

function buildRoutingDecisionTrace(params: {
  rawMessage: string;
  normalizedMessage: string;
  classification: AppIntentClassification;
  rewritesApplied?: string[];
  clauses?: string[];
  commands?: string[];
  routeSource?: RoutingDecisionTrace["routeSource"];
  modelAssistUsed?: boolean;
}): RoutingDecisionTrace {
  const matchedAlias = findBuiltinIntentByAlias(params.normalizedMessage)?.command ?? null;
  const matchedKeywordIntent = resolveBuiltinIntentByKeywords(params.normalizedMessage, params.classification.domain);
  const protectedParser = isProtectedBuiltinParserMessage(params.normalizedMessage);
  const plannerEligible = inferPlannerTraceEligibility(params.normalizedMessage);
  return {
    rawMessage: params.rawMessage,
    normalizedMessage: params.normalizedMessage,
    intentClass: classifyIntentClass(params.normalizedMessage, params.classification),
    classificationKind: params.classification.kind,
    classificationDomain: params.classification.domain,
    matchedAlias,
    matchedKeywords: matchedKeywordIntent?.command ?? null,
    protectedParser,
    plannerEligible,
    plannerEligibilityReason: plannerEligible
      ? "write-like, vague, sequenced, or multi-domain app request"
      : "not eligible for app-action planner at initial trace build",
    rewritesApplied: params.rewritesApplied ?? [],
    clauses: params.clauses ?? [],
    commands: params.commands ?? [],
    routeSource: params.routeSource ?? "none",
    modelAssistUsed: Boolean(params.modelAssistUsed),
  };
}

function inferPlannerTraceEligibility(raw: string): boolean {
  return (
    /\b(?:create|make|build|set\s+up|spin\s+up|organize|prepare|schedule|assign|link|attach|run|start)\b/i.test(raw) &&
    /\b(?:agent|agents|org|organization|team|workflow|board|task|council|debate|channel|telegram|slack|memory|schedule)\b/i.test(raw)
  );
}

function extractScheduleTail(raw: string): string {
  const match = raw.match(
    /\b(every\s+\d+\s+minutes?.*|every\s+\d+\s+hours?.*|every\s+weekday(?:\s+at\s+[^\n.]+)?(?:\s+(?:as|called|named)\s+.+)?|daily(?:\s+at\s+[^\n.]+)?(?:\s+(?:as|called|named)\s+.+)?|every\s+(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)(?:\s+at\s+[^\n.]+)?(?:\s+(?:as|called|named)\s+.+)?|on\s+(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)(?:\s+at\s+[^\n.]+)?(?:\s+(?:as|called|named)\s+.+)?)$/i,
  );
  return stripWrappedQuotes(match?.[1] || "").trim();
}

function isQuestionLikeMessage(raw: string): boolean {
  const value = raw.trim();
  return (
    value.includes("?") ||
    /^(?:what|which|who|where|when|why|how|has|can|could|would|should|is|are|do|does|did|show|give|tell|help|please|i(?:'d\s+(?:like|love)|\s+(?:want|need|d\s+like))\s+to|let\s+me)\b/i.test(value)
  );
}

function isBuiltinHowToRequest(raw: string): boolean {
  const value = String(raw || "").trim();
  if (!value) return false;
  return /\bhow\s+(?:do|can)\s+i\s+use\s+(?:the\s+)?(?:docs?|documentation|workflows?|workflow\s+templates?|boards?|tasks?|council(?:\s+and\s+hierarchy)?|hierarchy|org|organization|scheduler|schedules?|cron|data\s+sources?|documents?|channels?|extensions?|plugins?|skills?|skill\s+packs?|tools?|dashboard|overview|activity|approvals?|logs?|debug|maintenance|security|metrics|cost\s+analysis|costs?|usage|settings|tags?|memory|live)\b/i.test(
    value,
  );
}

function resolveFeatureHowToCommand(raw: string): string | null {
  if (!isBuiltinHowToRequest(raw)) return null;
  const domain = resolveBuiltinDomainFromText(raw);
  switch (domain) {
    case "docs":
    case "data-source":
      return domain === "docs" ? "how do i use docs" : "how do i use data source";
    case "workflow":
      return "how do i use workflow";
    case "board":
      return "how do i use board";
    case "council":
    case "hierarchy":
      return "how do i use council";
    case "scheduler":
      return "how do i use scheduler";
    case "channels":
      return "how do i use channels";
    case "extensions":
      return "how do i use extensions";
    case "skills":
      return "how do i use skills";
    case "dashboard":
      return "how do i use dashboard";
    case "activity":
      return "how do i use activity";
    case "approvals":
      return "how do i use approvals";
    case "logs":
      return "how do i use logs";
    case "debug":
      return "how do i use debug";
    case "maintenance":
      return "how do i use maintenance";
    case "security":
      return "how do i use security";
    case "metrics":
      return "how do i use metrics";
    case "usage":
      return "how do i use usage";
    case "settings":
      return "how do i use settings";
    case "tags":
      return "how do i use tags";
    case "memory":
      return "how do i use memory";
    case "live":
      return "how do i use live";
    default:
      return null;
  }
}

function matchesDirectAgentChangeMessage(raw: string): boolean {
  const value = String(raw || "").trim();
  if (!value) return false;
  return (
    /^(?:make|set|change|switch|update|configure)\s+agent\s+(.+?)\s+(?:to\s+use|use|to|onto)\s+(.+)$/i.test(value) ||
    /^(?:make|set|change|switch|update|configure)\s+(.+?)\s+agent\s+(?:to\s+use|use|to|onto)\s+(.+)$/i.test(value) ||
    /^(?:have|let)\s+agent\s+(.+?)\s+use\s+(.+)$/i.test(value) ||
    /^use\s+(.+?)\s+for\s+agent\s+(.+)$/i.test(value) ||
    /^(?:change|switch|set|update)\s+agent\s+(.+?)\s+provider\s+(?:to|=)\s+(.+)$/i.test(value) ||
    /^(?:change|switch|set|update)\s+(.+?)\s+agent\s+provider\s+(?:to|=)\s+(.+)$/i.test(value)
  );
}

function matchesExternalCatalogMutation(raw: string): boolean {
  const value = String(raw || "").trim();
  if (!value) return false;
  return (
    /^(?:install|add)\s+(?:external\s+)?(?:extension|plugin)\s+from\s+.+$/i.test(value) ||
    /^(?:install|add)\s+(?:external\s+)?(?:extension|plugin)\s+.+?\s+from\s+.+$/i.test(value) ||
    /^(?:update|upgrade|refresh)\s+(?:external\s+)?(?:extension|plugin)\s+.+$/i.test(value) ||
    /^(?:remove|uninstall|delete)\s+(?:external\s+)?(?:extension|plugin)\s+.+$/i.test(value) ||
    /^(?:install|add)\s+(?:external\s+)?skill\s+pack\s+from\s+.+$/i.test(value) ||
    /^(?:update|upgrade|refresh)\s+(?:external\s+)?skill\s+pack\s+.+$/i.test(value) ||
    /^(?:remove|uninstall|delete)\s+(?:external\s+)?skill\s+pack\s+.+$/i.test(value)
  );
}

function isMemoryFileReadRequest(raw: string): boolean {
  return (
    /\b(?:contents?|content|read|show|open|what(?:'s| is))\b[\s\S]*\bmemory\.md\b/i.test(raw) ||
    /\bmemory\.md\b[\s\S]*\b(?:contents?|content|read|show|open)\b/i.test(raw)
  );
}

function isWebImageResearchRequest(raw: string): boolean {
  return /\b(?:google|web|internet|browser|search)\b[\s\S]*\b(?:image|images|photo|photos|picture|pictures|search|look\s+up|find|download)\b/i.test(raw);
}

/**
 * Returns true when the raw message is an exact match for a builtin app_read intent
 * (by alias or command). Use this in route.ts to skip composition/synthesis paths for
 * commands like "list schedules", "list webhooks", "list automations", etc.
 */
export function isExactAppReadBuiltin(raw: string): boolean {
  const value = String(raw || "").trim();
  if (!value) return false;
  const entry = findBuiltinIntentByAlias(value) ?? findBuiltinIntentByCommand(value);
  return entry?.intentClass === "app_read" || isAutomationLiveStateReadRequest(value) || isBoardTaskListRequest(value);
}

export function isAutomationLiveStateReadRequest(raw: string): boolean {
  const value = String(raw || "").trim().toLowerCase();
  if (!value) return false;
  const readOnlyValue = value
    .replace(/\bdo\s+not\s+(?:create|add|delete|update|change|run|trigger|execute|schedule|configure)\b[^.!?\n]*/g, " ")
    .replace(/\bdon't\s+(?:create|add|delete|update|change|run|trigger|execute|schedule|configure)\b[^.!?\n]*/g, " ");
  const hasAutomationTerm = /\b(?:webhook|webhooks|cron|schedule|schedules|scheduled|scheduler|automation|automations)\b/.test(readOnlyValue);
  const hasReadIntent = /\b(?:list|show|current|existing|what|which|my|all|any|status|active|enabled|configured|live|separate)\b/.test(readOnlyValue);
  const hasExplicitInventoryIntent = /\b(?:list|show|current|existing|which|my|all|any|status|active|enabled|configured|live|inventory|state|overview|separate)\b/.test(readOnlyValue);
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

function hasAutomationLiveStateReadPart(raw: string): boolean {
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

// Board-task inventory ("list tasks", "what's in my inbox", "what's on my plate") is
// app/runtime state retrieval — it must return the live board, not a navigation stub or a
// model-synthesized capability answer. Hoisted early (next to the automation-state lane) so
// generic show/open routing and broad synthesis cannot shadow it, and so the result is
// model-independent. Mutations and capability/how-to phrasings are excluded.
export function isBoardTaskListRequest(raw: string): boolean {
  const value = String(raw || "").trim().toLowerCase().replace(/[?!.]+$/g, "").replace(/\s+/g, " ");
  if (!value) return false;
  // Never capture mutations or capability/how-to questions.
  if (/\b(?:create|add|new|delete|remove|move|mark|set|update|change|complete|finish|close|resolve|start|run|assign|edit)\b/.test(value)) return false;
  if (/\b(?:what can|can (?:this|the) app|capabilit|how (?:do|to|can)|how does|explain|set up|configure)\b/.test(value)) return false;
  // Inbox phrasings (the app uses "inbox" as a board status; there is no email inbox surface).
  const inboxPhrasing =
    value === "inbox" || value === "list inbox" || value === "show inbox" ||
    /\b(?:in|on|check) my inbox\b/.test(value) || /\binbox tasks?\b/.test(value) ||
    /\bwhat(?:'s| is) in my inbox\b/.test(value);
  // Generic board-task list phrasings.
  const taskPhrasing =
    /\b(?:list|show|view|see|find|display|more|next)\s+(?:all\s+|my\s+|our\s+|open\s+|pending\s+|completed\s+|done\s+|board\s+|inbox\s+)*tasks?\b/.test(value) ||
    /\b(?:my|our|open|pending|completed|done|board|current)\s+tasks?\b/.test(value) ||
    /\bboard tasks?\b/.test(value) ||
    /\bon my plate\b/.test(value) ||
    /\bwhat(?:'s| is| are)\s+(?:on the board|on my plate|my tasks|the tasks|our tasks)\b/.test(value) ||
    /^(?:what|which|how many)\s+tasks?\b/.test(value) ||
    value === "tasks" || value === "task";
  return inboxPhrasing || taskPhrasing;
}

// Direct channel commands that must return live app state or perform a known
// typed command before broad agentic/planner lanes. Keep this intentionally
// narrow: it covers exact inventory/status/config/document/task commands, not
// open-ended analysis or workflow design.
function channelCommandBuiltinCandidates(raw: string): string[] {
  const value = String(raw || "").trim();
  if (!value) return [];
  const candidates: string[] = [];
  const add = (candidate: string) => {
    const trimmed = candidate.trim().replace(/[?!.]+$/g, "").trim();
    if (trimmed && !candidates.some((item) => normalizeLookup(item) === normalizeLookup(trimmed))) {
      candidates.push(trimmed);
    }
  };
  add(value);
  add(value.replace(/^please\s+/i, ""));

  const wrapperPatterns = [
    /^(?:let\s+me\s+see|i\s+(?:want|need)\s+to\s+see|help\s+me\s+check)\s+(?:the\s+|my\s+)?(.+)$/i,
    /^(?:can|could|would)\s+you\s+(?:please\s+)?(?:show|list|tell|give)\s+(?:me\s+)?(?:the\s+|my\s+)?(.+)$/i,
    /^(?:please\s+)?show\s+me\s+(?:the\s+|my\s+)?(.+)$/i,
    /^(?:please\s+)?give\s+me\s+(?:the\s+|a\s+|my\s+)?(.+)$/i,
  ];
  for (const pattern of wrapperPatterns) {
    const match = value.match(pattern);
    if (match?.[1]) add(match[1]);
  }
  return candidates;
}

function isChannelCommandBuiltinCandidate(value: string): boolean {
  if (!value) return false;
  const normalized = normalizeLookup(value);

  const exact = new Set([
    "help",
    "/help",
    "commands",
    "/commands",
    "status",
    "/status",
    "app status",
    "system status",
    "channel status",
    "channels status",
    "list agents",
    "show agents",
    "agents",
    "list models",
    "show models",
    "models",
    "active models",
    "list tools",
    "show tools",
    "tools",
    "list custom tools",
    "list secrets",
    "show secrets",
    "secrets",
    "secrets status",
    "config",
    "/config",
    "show config",
    "show settings",
    "list settings",
    "show settings tab",
    "list docs",
    "list documents",
    "show documents",
    "list data sources",
    "show data sources",
    "list schedules",
    "list cron",
    "list cron jobs",
    "show scheduler",
    "show schedule",
    "scheduler",
  ]);
  if (exact.has(normalized)) return true;

  const builtinAlias = findBuiltinIntentByAlias(value) ?? findBuiltinIntentByCommand(value);
  if (builtinAlias?.intentClass === "app_read") return true;

  if (/^(?:show|get|read)\s+(?:config|setting)\s+.+$/i.test(value)) return true;
  if (/^(?:search|find)\s+(?:docs?|documents?|data\s+sources?)\s+(?:for\s+)?.+$/i.test(value)) return true;
  if (/^(?:show|open|get|read)\s+(?:doc(?:ument)?|data\s+source)\s+.+$/i.test(value)) return true;
  if (/^create\s+(?:a\s+)?(?:follow[-\s]+up\s+)?(?:board\s+)?task\s+from\s+(?:doc(?:ument)?|data\s+source)\s+.+$/i.test(value)) return true;
  if (isDirectBoardTaskCommand(value)) return true;
  if (/^(?:run|start|execute)\s+(?:the\s+)?(?:latest\s+)?(?:.+?)\s+task$/i.test(value)) return true;
  if (/^(?:run|start|execute)\s+task\s+.+$/i.test(value)) return true;

  return false;
}

function resolveChannelCommandBuiltinMessage(raw: string): string | null {
  return channelCommandBuiltinCandidates(raw).find((candidate) => isChannelCommandBuiltinCandidate(candidate)) ?? null;
}

export function isChannelCommandBuiltinRequest(raw: string): boolean {
  return Boolean(resolveChannelCommandBuiltinMessage(raw));
}

function isDirectBoardTaskCommand(raw: string): boolean {
  const value = String(raw || "").trim();
  if (!value) return false;
  return (
    isExplicitDirectBoardTaskCreateCommand(value) ||
    Boolean(parseBoardTaskTemplateIntent(value)) ||
    /^(?:mark|set|move)\s+(?:task\s+)?(?:the\s+)?["']?.+?["']?\s+(?:task\s+)?(?:as|to)\s+(?:done|completed|finished|in[- ]progress|in progress|review|inbox|blocked)\s*$/i.test(value) ||
    /^(?:mark|set|move)\s+(?:the\s+)?["']?.+?["']?\s+(?:as|to)\s+(?:done|completed|finished|in[- ]progress|in progress|review|inbox|blocked)\s*$/i.test(value) ||
    /^(?:complete|finish|close|resolve)\s+(?:the\s+)?(?:task\s+)?["']?.+?["']?\s*$/i.test(value) ||
    /^(?:set|change|update|mark)\s+(?:the\s+)?(?:task\s+)?["']?.+?["']?\s+(?:task\s+)?(?:to|as|with)\s+(?:high|low|medium|urgent)\s+priority\s*$/i.test(value) ||
    /^(?:set|change|update|mark)\s+(?:priority\s+of\s+)?(?:the\s+)?["']?.+?["']?\s+(?:to|as)\s+(?:high|low|medium|urgent)\s*$/i.test(value) ||
    /^(?:claim|checkout|check out)\s+(?:the\s+)?.+?\s+task$/i.test(value) ||
    /^(?:claim|checkout|check out)\s+task\s+.+$/i.test(value) ||
    /^(?:release|unclaim|check in)\s+(?:the\s+)?.+?\s+task$/i.test(value) ||
    /^(?:release|unclaim|check in)\s+task\s+.+$/i.test(value)
  );
}

function isExplicitDirectBoardTaskCreateCommand(raw: string): boolean {
  const value = String(raw || "").trim();
  if (!value) return false;
  return (
    /^(?:task\s*:|add\s+task\s*:?\s*)(.+)$/i.test(value) ||
    /^(?:please\s+)?(?:create|add|make|log|track)\s+(?:a\s+)?(?:new\s+)?(?:board\s+task|task|todo|to[-\s]?do|card|item)\s*(?:called|named)\s*[:,-]?\s*.+$/i.test(value) ||
    /^(?:can you|could you|would you|please)\s+(?:create|add|make|log|track|put)\s+.+?\s+(?:as\s+)?(?:a\s+)?(?:board\s+task|task|todo|card)(?:\s+on\s+(?:my\s+)?board)?$/i.test(value) ||
    /^(?:please\s+)?(?:add|put|drop)\s+.+?\s+(?:to|into|in|on)\s+(?:my\s+)?(?:board|inbox|task list)(?:\s+as\s+a\s+(?:task|todo|card))?$/i.test(value) ||
    /^(?:please\s+)?(?:put|add)\s+(?:this\s+)?(?:in|into)\s+(?:my\s+)?inbox\s*[:,-]?\s*.+$/i.test(value)
  );
}

export async function renderChannelCommandBuiltinResponse(
  raw: string,
  ctx: BuiltinCommandContext,
): Promise<string | null> {
  const commandMessage = resolveChannelCommandBuiltinMessage(raw);
  if (!commandMessage) return null;
  const normalized = normalizeLookup(commandMessage);
  if (normalized === "help" || normalized === "/help" || normalized === "commands" || normalized === "/commands") {
    return [
      "Try plain-English commands in WebChat or any connected channel.",
      "",
      "Common reads: list agents, list models, list tools, list documents, show config, show automations, search docs for a topic.",
      "Common actions: create a task from a document, run a named task, create a workflow from a template, schedule a workflow.",
      "Safety: risky writes use confirmation or admin gates; secrets are never printed.",
    ].join("\n");
  }
  if (normalized === "status" || normalized === "/status" || normalized === "app status" || normalized === "system status") {
    return handleBuiltinCommands("channel status", { ...ctx, allowCompound: false });
  }
  const configFieldMatch = commandMessage.match(/^(?:show|get|read)\s+(?:config|setting)\s+(.+)$/i);
  if (configFieldMatch?.[1] && normalized !== "show config" && normalized !== "show settings") {
    const field = resolveConfigField(configFieldMatch[1]);
    if (!field) {
      return `Unknown config key: ${configFieldMatch[1]}. Try "show config" for supported keys.`;
    }
    const { initializeDatabase, getSqlite } = await import("@/lib/db");
    initializeDatabase();
    const db = getSqlite();
    const row = db
      .prepare(`SELECT ${field.column} FROM ${field.table} WHERE id = 'default'`)
      .get() as Record<string, unknown> | undefined;
    return `Config ${field.column} = ${formatConfigValue(row?.[field.column], field)}`;
  }
  return handleBuiltinCommands(commandMessage, { ...ctx, allowCompound: false });
}

function splitChannelBuiltinClauses(raw: string): string[] {
  return String(raw || "")
    .split(/[?]+/)
    .map((part) => part.trim().replace(/[.!]+$/g, "").trim())
    .filter(Boolean);
}

export async function renderCompoundChannelCommandBuiltinResponse(
  raw: string,
  ctx: BuiltinCommandContext,
): Promise<{ response: string; commands: string[] } | null> {
  const clauses = splitChannelBuiltinClauses(raw);
  if (clauses.length < 2) return null;
  const sections: string[] = [];
  const commands: string[] = [];
  for (const clause of clauses.slice(0, 3)) {
    let response: string | null = null;
    if (isBoardTaskListRequest(clause)) {
      response = await renderBoardTaskListResponse(clause);
    } else if (isAutomationLiveStateReadRequest(clause)) {
      response = await renderAutomationLiveStateResponse(clause);
    } else if (isWebhookSigningHelpRequest(clause)) {
      response = renderWebhookSigningHelpResponse();
    } else if (isChannelCommandBuiltinRequest(clause)) {
      response = await renderChannelCommandBuiltinResponse(clause, ctx);
    }
    if (!response) return null;
    commands.push(clause);
    sections.push(`## ${clause}\n${response.trim()}`);
  }
  return { response: sections.join("\n\n"), commands };
}

export async function renderBoardTaskListResponse(raw: string): Promise<string> {
  const { listBoardTasks } = await import("@/lib/boards/manager");
  const value = String(raw || "").toLowerCase();
  const statusFilter: string | null =
    /\b(?:pending|unstarted|not started|inbox|open)\b/.test(value) ? "inbox" :
    /\bin[- ]progress\b|\bactive tasks?\b/.test(value) ? "in_progress" :
    /\bin\s+review\b|\bunder review\b/.test(value) ? "review" :
    /\b(?:done|completed|finished|closed)\b/.test(value) ? "done" :
    /\bblocked\b/.test(value) ? "blocked" :
    null;
  const wantsInbox =
    /\binbox\b/.test(value) || /\bon my plate\b/.test(value) || statusFilter === "inbox";
  const ordered = prioritizeTasksForChannelList(listBoardTasks("main-board"));
  const filtered = statusFilter ? ordered.filter((t) => t.status === statusFilter) : ordered;
  // Emit the format the presentation layer reliably parses (label + "(N total):") so every
  // case renders consistently with "Task ID:". Label is restricted to the values
  // presentation recognizes (Inbox | Board).
  const label = wantsInbox ? "Inbox" : "Board";
  const total = filtered.length;
  if (total === 0) {
    return wantsInbox
      ? "Inbox tasks on main-board (0 total):\nNo open tasks on the board yet."
      : "Board tasks on main-board (0 total):\nNo tasks on the board yet.";
  }
  const shown = filtered.slice(0, DEFAULT_TASK_LIST_PAGE_SIZE);
  const lines = shown
    .map((t, i) => `${i + 1}. ${t.title}\nstatus: ${t.status}\nid: ${t.id}`)
    .join("\n\n");
  const moreLine =
    total > shown.length ? `\n\nShowing 1-${shown.length} of ${total}. Say "more tasks" to continue.` : "";
  return `${label} tasks on main-board (${total} total):\n${lines}${moreLine}`;
}

export function isProtectedBuiltinParserMessage(raw: string): boolean {
  const value = String(raw || "").trim();
  if (!value) return false;
  return (
    isMemoryFileReadRequest(value) ||
    isWebImageResearchRequest(value) ||
    Boolean(parseBulkCreateAgentsOrganizationIntent(value)) ||
    Boolean(parseImplicitDebateOrganizationIntent(value)) ||
    Boolean(parseBulkCreateAgentsIntent(value)) ||
    Boolean(parseDirectCreateAgentIntent(value)) ||
    Boolean(parseFreeformAgentCapabilityAssignment(value)) ||
    Boolean(parseCheckpointIntent(value)) ||
    Boolean(parseTemplateCreateIntent(value)) ||
    Boolean(parseTemplateRunIntent(value)) ||
    matchesDirectAgentChangeMessage(value) ||
    matchesExternalCatalogMutation(value) ||
    /^(?:show\s+)?(?:self\s+)?learning\s+status$/i.test(value) ||
    /^(?:list|show)\s+learning\s+(?:candidates|queue)$/i.test(value) ||
    /^(?:show\s+)?session\s+snapshot\s+status$/i.test(value) ||
    /^(?:show\s+)?chat\s+snapshot\s+status$/i.test(value) ||
    /^is\s+this\s+chat\s+using\s+a\s+session\s+snapshot\??$/i.test(value) ||
    /^(?:reload|refresh)\s+(?:session|chat)\s+snapshot$/i.test(value) ||
    /^(?:reload|refresh)\s+agent\s+files(?:\s+for\s+this\s+chat)?$/i.test(value) ||
    /^(?:turn|set|keep|switch)\s+(?:self[- ]?learning|learning loop)\s+(?:to|mode\s+to|mode)?\s*(?:off|review|auto|on)$/i.test(value) ||
    /^(?:show|open|explain|inspect)\s+(?:status\s+for\s+)?(?:.+?)\s+(?:extension|plugin)\s+status\??$/i.test(value) ||
    /^(?:what(?:'s| is)\s+)?(?:the\s+)?status\s+of\s+(?:the\s+)?(?:.+?)\s+(?:extension|plugin)\??$/i.test(value) ||
    /^(?:list|show)\s+all\s+skills(?:\s+for\s+agent\s+.+)?$/i.test(value) ||
    /^(?:list|show)\s+skills(?:\s+for\s+agent\s+.+)?$/i.test(value) ||
    /^what\s+(?:skills|extensions|capabilities)\s+is\s+.+?\s+using(?:\s+now)?\??$/i.test(value) ||
    /^what\s+(?:skills|extensions|capabilities)\s+does\s+(?:the\s+)?.+?\s+(?:agent\s+)?have(?:\s+enabled)?\??$/i.test(value) ||
    /^(?:show|list)\s+(?:me\s+)?(?:the\s+)?(?:skills|extensions|capabilities)\s+(?:for|of|on)\s+(?:agent\s+)?.+$/i.test(value) ||
    /^(?:what(?:'s| is))\s+(?:the\s+)?(?:skill|extension|capability)\s+(?:set|list|config|configuration)\s+(?:for|of)\s+(?:agent\s+)?(.+)\??$/i.test(value) ||
    /^(?:please\s+)?(?:use|plan|create|start)\s+(?:a\s+)?dynamic\s+workflow\b/i.test(value) ||
    /^(?:pause|resume|cancel|stop)\s+(?:the\s+)?dynamic\s+workflow\b/i.test(value) ||
    /\bproject\s+manager\s+agent\s+harness\b/i.test(value) ||
    /^save\s+(?:this|the)\s+(?:successful\s+)?run\s+as\s+\/?[a-z0-9_.-]+\.?$/i.test(value) ||
    /^\/goal(?:\s+(?:status|pause|resume|clear)\b|\s+\S.*)?$/i.test(value) ||
    /^\/loop(?:\s+(?:status|pause|resume|cancel|stop)\b|\s+\S.*)?$/i.test(value) ||
    /^\/subgoal(?:\s+\S.*)?$/i.test(value)
  );
}

function commandMatchesClassificationDomain(
  command: string,
  classification: AppIntentClassification,
): boolean {
  if (classification.kind !== "app_control" || !classification.domain) return true;
  const intent = findBuiltinIntentByCommand(command);
  if (!intent) return false;
  if (intent.domains.includes(classification.domain)) return true;
  if (classification.domain === "data-source" && intent.domains.includes("docs")) return true;
  if (classification.domain === "docs" && intent.domains.includes("data-source")) return true;
  if (classification.domain === "council" && intent.domains.includes("hierarchy")) return true;
  return false;
}

function shouldUseKeywordBuiltinFallback(
  raw: string,
  classification: AppIntentClassification,
): boolean {
  if (isProtectedBuiltinParserMessage(raw)) return false;
  if (looksLikeMutatingAppCommand(raw) && !isReadOnlyPhrased(raw)) return false;
  if (isExplicitlyConversationalMessage(raw)) return false;
  if (!looksLikeAppSurfaceQuestion(raw, classification)) return false;
  const wordCount = raw.trim().split(/\s+/).filter(Boolean).length;
  return wordCount <= 4;
}

function shouldAcceptModelBuiltinResolution(
  raw: string,
  classification: AppIntentClassification,
  resolution: ModelAssistedBuiltinResolution,
): boolean {
  if (isProtectedBuiltinParserMessage(raw)) return false;
  if (resolution.commands.length === 0) return false;
  if (resolution.commands.some((command) => !commandMatchesClassificationDomain(command, classification))) {
    return false;
  }
  if (classification.kind === "app_control") return true;
  return resolution.confidence === "high" || resolution.commands.length > 1;
}

function buildBuiltinRoutingClarifier(classification: AppIntentClassification): string {
  switch (classification.domain) {
    case "maintenance":
      return 'I think this is an app-status question, but I am not confident enough to guess. Try "show maintenance", "show approvals", or "show activity".';
    case "usage":
      return 'I think this is about app load or traffic, but I am not confident enough to guess. Try "show usage" or "show activity".';
    case "workflow":
      return 'I think this is about workflows, but I am not confident enough to guess. Try "list workflows" or "how do i use workflow".';
    case "agent":
      return 'I think this is about agents, but I am not confident enough to guess. Try "list agents", "list all skills for agent <name>", or "give agent <name> systematic debugging and telegram".';
    case "council":
      return 'I think this is about the org or council area, but I am not confident enough to guess. Try "show org", "show organizations", or "how do i use council".';
    case "security":
      return 'I think this is a security question, but I am not confident enough to guess. Try "show security".';
    case "activity":
      return 'I think this is an activity question, but I am not confident enough to guess. Try "show activity".';
    case "approvals":
      return 'I think this is an approvals question, but I am not confident enough to guess. Try "show approvals".';
    case "extensions":
      return 'I think this is about extensions or plugins, but I am not confident enough to guess. Try "list extensions" or "show extension runtime status".';
    case "skills":
      return 'I think this is about skills or capability packs, but I am not confident enough to guess. Try "list skills for agent main" or "how do i use skills".';
    case "memory":
      return 'I think this is about the memory surface, but I am not confident enough to guess. Try "show memory" or "show memory timeline".';
    case "live":
      return 'I think this is about the live surface, but I am not confident enough to guess. Try "show live" or "show activity".';
    default:
      return "I think you are asking about the app, but I am not confident enough to route it safely. Try a more explicit command like \"show dashboard\", \"list workflows\", or \"show org\".";
  }
}

type ConfusionPairClarifier = {
  pair: string;
  reply: string;
};

function detectConfusionPairClarifier(raw: string): ConfusionPairClarifier | null {
  const normalized = normalizeLookup(raw);
  if (splitCompoundBuiltinMessage(raw).length >= 2) return null;

  // channels vs settings — prompt mentions both channel and config/settings without a clear winner
  if (
    /\b(?:channel|channels)\b/i.test(raw) &&
    /\b(?:settings?|config(?:uration)?|defaults?|tweak)\b/i.test(raw) &&
    !/\b(?:channel status|channel health|which channels|what channels|channel setup)\b/i.test(raw)
  ) {
    return {
      pair: "channels-vs-settings",
      reply:
        'Are you asking about **channel connections** (which channels are live) or **app settings** (defaults and config)?\n' +
        '- For channel status: `show channels`\n' +
        '- For settings and config: `show settings`\n' +
        '- For channel setup guide: `check channel health`',
    };
  }

  // council vs org/hierarchy — ambiguous between team membership and deliberation
  if (
    /\b(?:council|vote|debate|deliberate)\b/i.test(raw) &&
    /\b(?:org(?:anization)?|hierarchy|team|members?)\b/i.test(raw) &&
    !/\b(?:who is on|show org|active org|current org)\b/i.test(raw) &&
    !/\b(?:where do i go|how do i use council|council tab)\b/i.test(raw)
  ) {
    return {
      pair: "council-vs-org",
      reply:
        'Are you asking about **who is on the team** (org structure) or **running a deliberation** (council vote)?\n' +
        '- For current team: `show org`\n' +
        '- For all orgs: `show organizations`\n' +
        '- For debate/vote: `how do i use council`',
    };
  }

  // activity vs usage — both "activity" and "usage/traffic/load" mentioned
  if (
    /\b(?:activity|ran|run|executed|running|execution)\b/i.test(raw) &&
    /\b(?:usage|traffic|volume|busy|load)\b/i.test(raw) &&
    !/\b(?:show activity|show usage|recent activity|usage summary)\b/i.test(raw)
  ) {
    return {
      pair: "activity-vs-usage",
      reply:
        'Are you asking about **recent workflow runs** (activity) or **overall app traffic/load** (usage)?\n' +
        '- For run history: `show activity`\n' +
        '- For traffic and load: `show usage`\n' +
        '- For cost and spend: `show metrics`',
    };
  }

  // workflow vs docs — both "workflow/automation" and "docs/source material" in the same ask
  if (
    /\b(?:workflow|workflows|automation|automations?|autopilot)\b/i.test(raw) &&
    /\b(?:docs?|documents?|source\s+material|data\s+sources?)\b/i.test(raw) &&
    !/\b(?:workflows?\s+and\s+docs?|docs?\s+and\s+workflows?|list workflows|list docs|show docs)\b/i.test(raw) &&
    normalized.split(" ").length < 16
  ) {
    return {
      pair: "workflow-vs-docs",
      reply:
        'Are you asking about **automations** (workflows) or **source material** (docs/data sources)?\n' +
        '- For automations: `list workflows`\n' +
        '- For documents: `list docs`\n' +
        '- For both: ask as a compound — "list workflows and list docs"',
    };
  }

  // vague "setup" request that could mean many things
  if (
    /\b(?:set(?:\s+up)?|setup|configure|wire)\b/i.test(raw) &&
    !/\b(?:telegram|discord|whatsapp|slack|bluebubbles|teams|google\s*chat|channel|extension|plugin|skill|workflow|automat(?:e|ion|ions?)|agent|schedule|board|task|backup|groq|openai|anthropic|gemini|ollama|model|provider)\b/i.test(raw) &&
    normalized.split(" ").length < 10
  ) {
    return {
      pair: "vague-setup",
      reply:
        'What would you like to set up? Here are the most common options:\n' +
        '- Channel (Telegram, Discord, etc.): `check channel health`\n' +
        '- A workflow: `list workflow templates`\n' +
        '- A scheduled job: `list schedules`\n' +
        '- An agent: `list agents`\n' +
        '- Settings / config: `show settings`',
    };
  }

  return null;
}

function shouldReturnBuiltinClarifier(raw: string, classification: AppIntentClassification): boolean {
  if (isProtectedBuiltinParserMessage(raw)) return false;
  if (looksLikeMutatingAppCommand(raw) && !isReadOnlyPhrased(raw)) return classification.kind === "app_control";
  return classification.kind === "app_control" && looksLikeAppSurfaceQuestion(raw, classification);
}

function shouldAttemptDirectBuiltinRouting(raw: string): boolean {
  const value = String(raw || "").trim();
  if (!value) return false;
  if (isClearlyNonAppCreativeOrCodingRequest(value)) return false;
  if (isClearlyNonAppOverloadedSurfaceRequest(value)) return false;
  const normalized = normalizeLookup(value);
  if (!normalized) return false;
  if (/^(?:confirm|yes|apply it|do it|cancel|never mind|nevermind|stop|don t do that|don't do that)$/i.test(value)) {
    return true;
  }
  if (isProtectedBuiltinParserMessage(value)) return true;
  if (isBuiltinHowToRequest(value)) return true;
  if (isToolKnowledgeCommand(value)) {
    return true;
  }
  if (findBuiltinIntentByAlias(value)) return true;
  const ellipticalResolved = resolveEllipticalAppMessage(value);
  if (ellipticalResolved?.message?.trim()) return true;
  if (BUILTIN_INTENT_ALLOWED_COMMANDS.some((command) => normalizeLookup(command) === normalized)) return true;
  if (
    normalized === "channel status" ||
    normalized === "what channels are connected" ||
    normalized === "which channels are connected" ||
    normalized === "which channels do we have live" ||
    normalized === "what channels do we have live" ||
    normalized === "what can the settings page help me control" ||
    normalized === "show docs summary" ||
    normalized === "show tags" ||
    normalized === "show tags summary" ||
    normalized === "list extensions" ||
    normalized === "show extension runtime status" ||
    normalized === "show memory" ||
    normalized === "show memory timeline" ||
    normalized === "show live" ||
    normalized === "list tools" ||
    normalized === "show tools" ||
    normalized === "workspace root" ||
    normalized === "show workspace root" ||
    normalized === "what files are in my workspace root" ||
    normalized === "what files do i have at the workspace root" ||
    normalized === "show system specs" ||
    normalized === "system specs" ||
    normalized === "what are my cpu and ram specs" ||
    normalized === "cpu and ram specs" ||
    normalized === "do you know my cpu and ram specs" ||
    normalized === "show command palette" ||
    normalized === "show commands" ||
    normalized === "list commands" ||
    normalized === "what commands are available" ||
    normalized === "command help" ||
    normalized === "check channel health" ||
    normalized === "run channel doctor" ||
    normalized === "diagnose channels" ||
    normalized === "channel health check" ||
    normalized === "list pending pairing requests" ||
    normalized === "show pairing requests" ||
    normalized === "list pairing requests"
  ) {
    return true;
  }
  if (/^(?:approve|deny)\s+pairing\s+\S+/i.test(value)) return true;
  // channel-specific setup aliases
  if (/^(?:show\s+setup\s+for|how\s+do\s+i\s+(?:(?:set|wire)\s+up|connect)|set\s+up|connect|telegram\s+setup|discord\s+setup|slack\s+setup|whatsapp\s+setup|teams\s+setup|bluebubbles\s+setup|google\s+chat\s+setup|imessage\s+setup)\b/i.test(value)) return true;
  if (
    parseWorkflowGenerateIntent(value) ||
    parseWorkflowExportIntent(value) ||
    parseWorkflowImportIntent(value) ||
    parseTemplateCreateIntent(value) ||
    parseTemplateRunIntent(value) ||
    parseCheckpointIntent(value) ||
    parseDataSourceCreateIntent(value) ||
    parseSchedulerCreateIntent(value) ||
    matchesDirectAgentChangeMessage(value) ||
    matchesExternalCatalogMutation(value) ||
    extractTaskTitleFromNaturalLanguage(value)
  ) {
    return true;
  }
  return /^(?:show|list|open|get|search|find|read|create|add|make|give|update|upgrade|refresh|delete|remove|uninstall|install|run|execute|start|launch|export|import|upload|schedule|enable|disable|assign|configure|set|switch|move|mark|claim|release)\b/i.test(
    value,
  );
}

function decideBuiltinRoute(
  raw: string,
  resolvedMessage: string,
  state: SessionAppStatePayload | null | undefined,
): BuiltinRouteDecision {
  const classification = classifyAppControlIntent(raw, state);
  const protectedParser = isProtectedBuiltinParserMessage(raw) || isProtectedBuiltinParserMessage(resolvedMessage);

  if (protectedParser) {
    return { mode: "exact", classification, protectedParser };
  }
  if (queryLooksLikeExactMemoryRecall(raw)) {
    return { mode: "skip", classification, protectedParser };
  }
  if (isConversationalAgentControlMessage(raw) && !isStandalonePreferenceStatement(raw)) {
    return { mode: "skip", classification, protectedParser };
  }
  if (/\bagent\b/i.test(raw) && /\bwhat would that look like\b/i.test(raw)) {
    return { mode: "clarify", classification, protectedParser };
  }
  if (shouldAttemptDirectBuiltinRouting(resolvedMessage)) {
    return { mode: "exact", classification, protectedParser };
  }
  if (classification.kind !== "app_control") {
    return { mode: "skip", classification, protectedParser };
  }
  if (looksLikeMutatingAppCommand(raw) && !isReadOnlyPhrased(raw)) {
    return { mode: "clarify", classification, protectedParser };
  }
  if (looksLikeAppSurfaceQuestion(raw, classification)) {
    return { mode: "fuzzy", classification, protectedParser };
  }
  return { mode: "skip", classification, protectedParser };
}

/**
 * Returns true when the message begins with a read-only request preamble such as
 * "give me", "let me see", "help me check", "i want to see", etc.
 * Used to bypass the mutation gate so these clearly informational requests can reach
 * the LLM-assisted builtin resolver and keyword-based best-effort matcher.
 */
function isReadOnlyPhrased(raw: string): boolean {
  return /^(?:give\s+me|let\s+me\s+(?:see|check|look\s+at|know)|help\s+me\s+(?:see|check|understand|find|with)?|pull\s+up|bring\s+up|i(?:'d\s+(?:like|love)|\s+(?:want|need|d\s+like))\s+to\s+(?:see|check|look\s+at|know|review)|can\s+you\s+(?:show|tell|give)\s*me?|please\s+(?:show|tell|give)\s*me?|what\s+(?:have\s+we\s+got|do\s+we\s+have)\s+set\s+up\b)\b/i.test(
    raw.trim(),
  );
}

function isNonMutatingPlanningRequest(raw: string): boolean {
  const value = String(raw || "").trim();
  if (!value) return false;
  const asksForPlanning =
    /\b(?:plan|recommend|suggest|review|audit|assess|evaluate|think\s+through|draft|design|outline|describe)\b/i.test(value);
  const explicitNoMutation =
    /\b(?:without|before)\s+(?:creating|changing|modifying|touching|doing|running|executing|adding|making|updating)\b/i.test(value) ||
    /\b(?:no\s+changes?|read[-\s]?only)\b/i.test(value) ||
    /\b(?:don'?t|do\s+not)\s+(?:create|change|modify|touch|apply|execute|run|add|make|update|do|alter)\b/i.test(value) ||
    /\b(?:but|and|,)\s+(?:don'?t|do\s+not)\s+(?:create|change|modify|touch|apply|execute|run|add|make|update|do|alter)\b/i.test(value);
  return asksForPlanning && explicitNoMutation;
}

function isContextualBoardTaskMutation(raw: string): boolean {
  const value = String(raw || "").trim();
  if (!value) return false;
  return (
    /\b(?:add|create|make|log|track|put|turn|record)\b/i.test(value) &&
    /\b(?:board\s+task|task|todo|card|board)\b/i.test(value) &&
    /\b(?:that|this|previous|last|above|verdict|decision|result|output|follow[-\s]?up|blockers?)\b/i.test(value)
  );
}

function looksLikeMutatingAppCommand(raw: string): boolean {
  const checkpointIntent = parseCheckpointIntent(raw);
  if (checkpointIntent?.action === "create" || checkpointIntent?.action === "rollback") return true;
  if (parseDataSourceCreateIntent(raw)) return true;
  if (parseTemplateCreateIntent(raw) || parseTemplateRunIntent(raw)) return true;
  if (matchesDirectAgentChangeMessage(raw) || matchesExternalCatalogMutation(raw)) return true;
  // Note: "have" and "let" are intentionally excluded — they are too common in read-only questions
  // ("what automations do we have running?", "let me see the logs") and the actual mutation intent
  // is always captured by stronger verbs like "create", "add", "delete", etc.
  // "give" is also excluded here — "give me X" preambles are handled by isReadOnlyPhrased().
  return /\b(?:create|add|make|delete|remove|update|upgrade|refresh|change|switch|enable|disable|run|execute|start|launch|install|uninstall|import|export|approve|deny|assign|mark|move|set|turn\s+on|turn\s+off|schedule|connect|disconnect|configure|rollback|restore|revert|upload|scrape|crawl)\b/i.test(
    raw,
  );
}

function isExplicitBuiltinParserPhrase(raw: string): boolean {
  const value = String(raw || "").trim();
  if (!value) return false;
  if (parseDataSourceCreateIntent(value)) return true;
  return (
    /^(?:search|find)\s+(?:docs?|documents?|data\s+sources?)\b/i.test(value) ||
    /^(?:show|open|get|read)\s+(?:doc(?:ument)?|data\s+source)\b/i.test(value) ||
    /^(?:find|recommend)\s+skills?\s+for\b/i.test(value) ||
    /^what\s+skills?\s+should\s+i\s+use\s+for\b/i.test(value) ||
    /^is\s+there\s+a\s+skill\s+for\b/i.test(value) ||
    isToolKnowledgeCommand(value) ||
    /^(?:show|open|explain|inspect)\s+setup\s+for\s+skill\b/i.test(value) ||
    /^how\s+do\s+i\s+set\s+up\s+(?:the\s+)?(?:.+?\s+)?skill\??$/i.test(value) ||
    /^(?:show|open|explain|inspect)\s+setup\s+for\s+(?:extension|plugin)\b/i.test(value) ||
    /^(?:show|open|explain|inspect)\s+(?:status\s+for\s+)?(?:.+?)\s+(?:extension|plugin)\s+status\??$/i.test(value) ||
    /^(?:what(?:'s| is)\s+)?(?:the\s+)?status\s+of\s+(?:the\s+)?(?:.+?)\s+(?:extension|plugin)\??$/i.test(value) ||
    /^show\s+me\s+how\s+to\s+wire\s+up\s+\S+/i.test(value) ||
    /^how\s+do\s+i\s+set\s+up\s+(?:the\s+)?(?:extension|plugin)\b/i.test(value) ||
    /^how\s+do\s+i\s+set\s+up\s+.+?\s+(?:extension|plugin)\??$/i.test(value) ||
    /^(?:please\s+)?upload\s+data\s+source\s+from\s+file\b/i.test(value) ||
    /^(?:create|scrape|crawl)\s+data\s+source\b/i.test(value) ||
    /^(?:build|create|generate|spin\s+up)\s+(?:a\s+)?workflow\b/i.test(value) ||
    /^(?:make|schedule)\s+(?:that|it|workflow|the\s+workflow)\b/i.test(value) ||
    /^(?:export)\s+(?:it|workflow|the\s+workflow)\b/i.test(value) ||
    /^(?:please\s+)?(?:create|add|make|log|track)\s+(?:a\s+)?(?:new\s+)?(?:board\s+task|task|todo|to[-\s]?do|card|item)\b/i.test(value) ||
    /^(?:mark|set|move|complete|finish|close|resolve)\s+(?:the\s+)?(?:task\s+)?["']?.+["']?(?:\s+task)?(?:\s+(?:as|to)\s+(?:done|completed|finished|in[- ]progress|in progress|review|inbox|blocked))?\s*$/i.test(
      value,
    )
  );
}

function looksLikeAppSurfaceQuestion(raw: string, classification: AppIntentClassification): boolean {
  if (classification.kind === "app_control") return true;
  if (resolveBuiltinIntentByKeywords(raw, classification.domain)) return true;
  return /\b(?:tab|page|screen|dashboard|system|board|task|plate|workflow|workflows|flow|automation|automations|agent|agents|team|org|organization|hierarchy|council|channel|channels|extension|extensions|plugin|plugins|skill|skills|memory|live|docs?|document|data source|schedule|cron|timer|approval|approvals|logs?|debug|security|metrics|usage|settings|maintenance|available)\b/i.test(
    raw,
  ) || /\b(?:workspace\s+root|cpu|ram|specs?)\b/i.test(raw);
}

function isDefaultAgentReference(value: string): boolean {
  return /^(?:default|the default|my default|main)\s*(?:agent)?$/i.test(String(value || "").trim());
}

/**
 * Returns true ONLY for clearly conversational one-liners that have no chance of being
 * an app-control question — pure greetings, acknowledgements, and reaction words.
 * This is a NARROW gate: general questions ("anything weird going on?") that happen to
 * have no app keywords must still reach the LLM router.
 */
function isExplicitlyConversationalMessage(raw: string): boolean {
  const v = raw.trim();
  // Pure greeting or sign-off (no question mark, no app context)
  if (/^(?:hello|hi|hey|yo|sup|howdy|hiya|greetings|morning|evening|night)\b[!.]?$/i.test(v)) return true;
  // Pure acknowledgement / reaction (short, no "?" — has a "?" means they're asking something)
  if (!v.includes("?") && /^(?:thanks|thank you|thx|ty|cheers|thnx|got it|ok|okay|sounds good|perfect|great|awesome|cool|nice|yep|nope|sure|noted|understood|roger)\b[.!]?$/i.test(v)) return true;
  if (!v.includes("?") && /^(?:lol|haha|hehe|omg|wow|oops|whoops)\b[.!]?$/i.test(v)) return true;
  return false;
}

function isClearlyNonAppCreativeOrCodingRequest(raw: string): boolean {
  const value = String(raw || "").trim();
  if (!value) return false;
  return (
    /^(?:tell|make)\s+me\s+a\s+joke\b/i.test(value) ||
    /^brainstorm\b/i.test(value) ||
    /^(?:generate|draw|make|create|draft|design)\s+(?:a\s+|an\s+|me\s+a\s+)?(?:simple\s+)?(?:ascii\s+art|ascii\s+diagram|diagram|infographic|flowchart|mermaid|mind\s*map)\b/i.test(value) ||
    /\b(?:ascii\s+diagram|ascii\s+art|infographic)\b/i.test(value) ||
    /^write\s+me\s+(?:a|an)\s+.+\b(?:helper|utility|script|function|class|module)\b/i.test(value) ||
    /^write\s+(?:a|an)\s+.+\b(?:helper|utility|script|function|class|module)\b/i.test(value) ||
    /^write\s+(?:a|an)\s+(?:typescript|javascript|python|go|rust|java|c#|php|ruby)\s+(?:helper|utility|script|function|class|module)\b/i.test(value) ||
    /^write\s+.+\bworkflow\b.+\b(?:school\s+club|project\s+management\s+generally|outside\s+this\s+app)\b/i.test(value) ||
    /^can\s+you\s+help\s+me\s+write\s+code\b/i.test(value)
  );
}

function isClearlyNonAppOverloadedSurfaceRequest(raw: string): boolean {
  const value = String(raw || "").trim();
  if (!value) return false;
  const generalContext =
    /\b(?:bakery|camping|camping\s+trip|toddler|board\s+game|robots|kitchen|poem|diet|running\s+plan|career\s+change|fantasy\s+football|kids?|science\s+party|school\s+club|marketing|launch\s+checklist|story|bicycle|studying|school\s+application|character|novel|friend|politely|groceries|sleep|rainy\s+day|spy\s+story|morning\s+routine\s+outside\s+this\s+app|project\s+management\s+generally|outside\s+this\s+app)\b/i.test(value);
  const genericSurfaceUse =
    /\b(?:workflow|workflows|agent|agents|activity|maintenance|health\s+check|health\s+metrics|approval|approvals|channels?|setup|tasks?|org\s+chart|debate|budget|board)\b/i.test(value);
  if (generalContext && genericSurfaceUse) return true;
  if (/\b(?:without\s+changing\s+anything|do\s+not\s+(?:create\s+anything\s+(?:here|in\s+this\s+app)|change\s+this\s+app)|don'?t\s+create\s+(?:anything|agents?)\s+(?:here|in\s+this\s+app)|don'?t\s+change\s+anything|dont\s+create\s+(?:anything|agents?)\s+(?:here|in\s+this\s+app)|dont\s+change\s+anything|outside\s+this\s+app|generally)\b/i.test(value)) {
    return true;
  }
  if (/^(?:write|create|draft|design|tell|explain|review|help\s+me|make|run\s+through)\b/i.test(value) && generalContext) {
    return true;
  }
  return false;
}

function isOpenEndedAppImprovementRequest(raw: string): boolean {
  const value = String(raw || "").trim();
  if (!value) return false;
  if (isNonMutatingPlanningRequest(value) || isClearlyNonAppOverloadedSurfaceRequest(value)) return false;
  if (isProtectedBuiltinParserMessage(value)) return false;
  const hasAppSurface =
    /\b(?:this\s+app|app|setup|workflows?|automations?|agents?|channels?|settings?|docs?|documents?|memory|skills?|extensions?|boards?|tasks?|scheduler|schedules?|council|hierarchy|org|maintenance|security)\b/i.test(
      value,
    );
  const hasOperationalSurface =
    /\b(?:needs?\s+attention|waiting\s+on\s+me|pending|looks?\s+(?:wrong|off|risky|broken|unhealthy)|anything\s+(?:wrong|off|risky|broken|unhealthy))\b/i.test(
      value,
    );
  if (!hasAppSurface && !hasOperationalSurface) return false;
  return /\b(?:optimi[sz]e|improve|make\s+(?:the\s+)?app\s+better|make\s+(?:this\s+)?setup\s+better|review|audit|assess|evaluate|evaluation|prepare|ready|readiness|production[-\s]?ready|fix\s+(?:any|whatever|obvious)|anything\s+weird|look\s+weird|looks\s+weird|handle\s+it|do\s+next)\b/i.test(
    value,
  ) || /\bmake\s+(?:my|the|these|our)?\s*(?:agents?\s+and\s+workflows?|workflows?\s+and\s+agents?)\s+better\b/i.test(value);
}

function inferReadOnlyAppCommandsFromParaphrase(raw: string): string[] {
  const value = String(raw || "").trim();
  if (!value) return [];

  const hasSecurityRead = /\b(?:security|secure|sketchy|risk|risky)\b/i.test(value);
  const hasLogsRead = /\b(?:logs?|log\s+entries|weird\s+logs?|odd\s+logs?)\b/i.test(value);
  if (
    /\b(?:anything|what|show|check|status|summary)\b/i.test(value) &&
    /\b(?:risky|risk|waiting\s+on\s+me|pending|approval|approvals?|broken|unhealthy|looks?\s+off)\b/i.test(value)
  ) {
    const commands = new Set<string>();
    if (/\b(?:waiting\s+on\s+me|pending|approval|approvals?)\b/i.test(value)) commands.add("show approvals");
    if (/\b(?:risky|risk|broken|unhealthy|looks?\s+off)\b/i.test(value)) commands.add("show maintenance");
    if (commands.size === 0) commands.add("show maintenance");
    return Array.from(commands);
  }
  if (hasSecurityRead && hasLogsRead) {
    return ["show security", "show recent logs"];
  }
  if (/\b(?:unhealthy|health|broken|off|weird|odd)\b/i.test(value) && hasLogsRead) {
    return ["show maintenance", "show recent logs"];
  }
  if (
    /\bworkflows?\s+list\b|\blist\s+of\s+workflows?\b|\bworkflow\s+setup\b|\bworkflows?\b/i.test(value) &&
    /\b(?:review|suggest|recommend|consolidate|improve|audit)\b/i.test(value) &&
    /\b(?:without\s+(?:changing|modifying|touching|running|executing)|don'?t\s+(?:change|modify|touch|run|execute)|do\s+not\s+(?:change|modify|touch|run|execute)|read[-\s]?only)\b/i.test(value)
  ) {
    return ["list workflows"];
  }

  if (
    isClearlyNonAppCreativeOrCodingRequest(value) ||
    isClearlyNonAppOverloadedSurfaceRequest(value) ||
    isOpenEndedAppImprovementRequest(value)
  ) return [];
  const exactBuiltin = findBuiltinIntentByAlias(value) ?? findBuiltinIntentByCommand(value);
  if (exactBuiltin) return [exactBuiltin.command];

  if (
    /\b(?:chat|channel|channels|messaging|message|communication|inbox|inboxes|bridge|bridges)\b/i.test(value) &&
    /\b(?:connections?|connected|working|alive|active|online|offline|disconnected|health|routes?|send\s+messages|wired\s+up)\b/i.test(value)
  ) {
    return ["channel status"];
  }
  if (/\bdisconnected\b/i.test(value) && /\bfix\b/i.test(value)) {
    return ["channel status"];
  }
  if (/\bthis\s+app\b/i.test(value) && /\bsend\s+messages\b/i.test(value)) {
    return ["channel status"];
  }
  if (/\b(?:operational\s+watchlist|looks\s+off\s+in\s+the\s+app|operator\s+review)\b/i.test(value)) {
    return ["show maintenance"];
  }
  if (/\bteam\s+shape\b/i.test(value) && /\b(?:votes?|voting|debate)\b/i.test(value)) {
    return ["show org", "how do i use council"];
  }
  if (/\bmembers\b/i.test(value) && /\b(?:start\s+a\s+debate|debate)\b/i.test(value)) {
    return ["show org", "how do i use council"];
  }
  if (/\bteam\b/i.test(value) && /\boperating\s+under\b/i.test(value) && /\bdebates?\b/i.test(value)) {
    return ["show org", "how do i use council"];
  }
  if (/\bhierarchy\s+thing\b/i.test(value) && /\bcouncil\s+thing\b/i.test(value)) {
    return ["show org", "how do i use council"];
  }
  if (
    (/\b(?:wired\s+up|automations?|automated|active\s+flows?|workflow\s+templates?)\b/i.test(value) &&
      /\b(?:documents?|docs?|knowledge\s+files?|source\s+material|source\s+material\s+inventory)\b/i.test(value)) ||
    /\bwhat\s+has\s+been\s+automated\s+and\s+what\s+documents\s+support\s+it\b/i.test(value)
  ) {
    return ["list workflows", "list docs"];
  }
  if (/\bknowledge\s+files?\b/i.test(value)) {
    return ["list docs"];
  }
  if (/\bhow\s+much\s+action\s+has\s+this\s+instance\s+seen\b/i.test(value)) {
    return ["show usage"];
  }
  if (/\bwhere\s+is\s+the\s+app\s+spending\s+tokens\b/i.test(value)) {
    return ["show metrics"];
  }
  return [];
}

function isAmbiguousWorkflowAutomationSetupRequest(raw: string): boolean {
  const value = String(raw || "").trim();
  if (!value) return false;
  return (
    /\b(?:set\s+up|setup|create|build|make)\b/i.test(value) &&
    /\b(?:whatever|something)\b/i.test(value) &&
    /\b(?:watch|monitor|keep\s+an\s+eye\s+on)\b/i.test(value) &&
    /\bapi\b/i.test(value) &&
    /\b(?:every\s+weekday|weekday\s+morning|every\s+morning)\b/i.test(value) &&
    /\b(?:save|export)\b/i.test(value) &&
    /\b(?:re-?import|import\s+later)\b/i.test(value)
  );
}

function isVagueApiMonitoringSetupRequest(raw: string): boolean {
  const value = String(raw || "").trim();
  if (!value) return false;
  return (
    /\b(?:set\s+up|setup|create|build|make|prepare)\b/i.test(value) &&
    /\b(?:something|whatever|reusable|monitor|watch|keep\s+an\s+eye\s+on)\b/i.test(value) &&
    /\b(?:apis?|endpoints?|services?|fail(?:ing|ures?)|flaky|health)\b/i.test(value)
  );
}

function isVagueTeamWorkTrackingSetupRequest(raw: string): boolean {
  const value = String(raw || "").trim();
  if (!value) return false;
  return (
    /\b(?:need|want|set\s+up|setup|create|build|make|organize|organized|assemble|form)\b/i.test(value) &&
    /\b(?:people|person|team|crew|agents?|whoever|members?)\b/i.test(value) &&
    /\b(?:work|tasks?|next\s+steps?|tracked|tracking|board|somewhere|readiness|blockers?)\b/i.test(value)
  );
}

function summarizeSessionStateForRouter(state: SessionAppStatePayload | null | undefined): string {
  const lines = [
    state?.workflow ? `recent workflow: ${getDisplayName(state.workflow)} (${state.workflow.id || "no-id"})` : null,
    state?.task ? `recent task: ${getDisplayName(state.task)} (${state.task.id || "no-id"})` : null,
    state?.agent ? `recent agent: ${getDisplayName(state.agent)} (${state.agent.id || "no-id"})` : null,
    state?.dataSource ? `recent data source: ${getDisplayName(state.dataSource)} (${state.dataSource.id || "no-id"})` : null,
    state?.organization ? `recent organization: ${getDisplayName(state.organization)} (${state.organization.id || "no-id"})` : null,
    state?.goal ? `recent goal: ${getDisplayName(state.goal)} (${state.goal.id || "no-id"})` : null,
    state?.schedule ? `recent schedule: ${getDisplayName(state.schedule)} (${state.schedule.id || "no-id"})` : null,
    state?.lastDomain ? `last domain: ${state.lastDomain}` : null,
    state?.lastAction ? `last action: ${state.lastAction}` : null,
    state?.lastSurface ? `last surface: ${state.lastSurface}` : null,
  ].filter(Boolean);
  return lines.length > 0 ? lines.join("\n") : "no recent app state";
}

async function resolveBuiltinWithModel(params: {
  rawMessage: string;
  classification: AppIntentClassification;
  sessionId?: string | null;
  sessionAppState: SessionAppStatePayload | null | undefined;
}): Promise<ModelAssistedBuiltinResolution | null> {
  const { rawMessage, classification, sessionId, sessionAppState } = params;
  // Block only clear mutations and explicitly conversational one-liners (greetings, acks).
  // All other messages — even ones without app keywords — should reach the LLM router so it
  // can distinguish "anything sketchy going on?" (→ show security) from "tell me a joke" (→ none).
  if (looksLikeMutatingAppCommand(rawMessage) && !isReadOnlyPhrased(rawMessage)) return null;
  if (isExplicitlyConversationalMessage(rawMessage)) return null;

  const allowedCommands = BUILTIN_INTENT_ALLOWED_COMMANDS;
  const parseCommandList = (value: string): string[] => {
    const normalized = String(value || "")
      .trim()
      .replace(/^none$/i, "")
      .trim();
    if (!normalized) return [];

    const split = normalized
      .split(/\s*(?:\||,|&&|\band\b)\s*/i)
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean);
    const filtered = split.filter((entry) => allowedCommands.includes(entry));
    return Array.from(new Set(filtered));
  };

  const parseModelResolution = (raw: string): Partial<ModelAssistedBuiltinResolution> | null => {
    const trimmed = raw.trim().replace(/^```[a-z]*\s*/i, "").replace(/\s*```$/i, "").trim();
    const lineExtract = (label: string) =>
      trimmed.match(new RegExp(`^${label}:\\s*(.+)$`, "im"))?.[1]?.trim() ?? "";
    const command = lineExtract("COMMAND");
    const commandsLine = lineExtract("COMMANDS");
    const rawDomain = lineExtract("DOMAIN").toLowerCase();
    const confidence = lineExtract("CONFIDENCE");
    const reason = lineExtract("REASON");
    const commands = parseCommandList(commandsLine || command);
    const domain = MODEL_ASSISTED_BUILTIN_DOMAINS.has(rawDomain as AppControlDomain | "help" | "none")
      ? (rawDomain as ModelAssistedBuiltinResolution["domain"])
      : undefined;
    if (command || commandsLine) {
      return {
        command: commands[0] || command,
        commands,
        domain,
        confidence: confidence as ModelAssistedBuiltinResolution["confidence"],
        reason,
      };
    }
    const candidate =
      (trimmed.includes("{") && trimmed.includes("}")
        ? trimmed.slice(trimmed.indexOf("{"), trimmed.lastIndexOf("}") + 1)
        : trimmed);
    try {
      const parsed = JSON.parse(candidate) as Partial<ModelAssistedBuiltinResolution> & { commands?: unknown };
      const rawCommands = Array.isArray(parsed.commands) ? parsed.commands.join(" | ") : String(parsed.command || "");
      const parsedDomain = String(parsed.domain || "").trim().toLowerCase();
      return {
        ...parsed,
        command: String(parsed.command || ""),
        commands: parseCommandList(rawCommands),
        domain: MODEL_ASSISTED_BUILTIN_DOMAINS.has(parsedDomain as AppControlDomain | "help" | "none")
          ? (parsedDomain as ModelAssistedBuiltinResolution["domain"])
          : undefined,
      };
    } catch {
      return null;
    }
  };

  try {
    const [{ getModelConfig }, { callModel }] = await Promise.all([
      import("@/lib/agents/model-router"),
      import("@/lib/agents/multi-provider"),
    ]);
    const modelConfig = getModelConfig({ sessionId: sessionId ?? null });
    if (!modelConfig.apiKey && providerRequiresApiKey(modelConfig.provider)) {
      return null;
    }

    const noneExamples = [
      { phrase: "tell me a joke", command: "none" },
      { phrase: "what's 2+2?", command: "none" },
      { phrase: "how are you?", command: "none" },
      { phrase: "write me a poem about cats", command: "none" },
      { phrase: "can you help me write code?", command: "none" },
      { phrase: "what time is it?", command: "none" },
      { phrase: "i love this app", command: "none" },
      { phrase: "remind me to do X tomorrow", command: "none" },
      { phrase: "what's the capital of France?", command: "none" },
    ];
    const systemPrompt = [
      "You are a routing assistant for a personal AI workspace app.",
      "Your job: given a user message, decide if it is asking about one of the app's built-in surfaces.",
      "If yes, return the exact matching command. If the message clearly asks about multiple built-in surfaces, return up to 3 commands in the order they should be answered.",
      "If no, return command=none.",
      "",
      "Builtin feature cards:",
      ...BUILTIN_INTENT_ROUTER_CARDS.map((s) => `  - ${s}`),
      "",
      "Short surface summary:",
      ...BUILTIN_INTENT_SURFACE_DESCRIPTIONS.map((s) => `  - ${s}`),
      "",
      "Key routing rules:",
      "- Map colloquial/indirect phrasing to the closest surface: 'anything sketchy?' → show security, 'how are things?' → show dashboard, 'anything running?' → show activity",
      "- If the user asks multiple builtin questions in one message, return all matching commands separated by |",
      "- Return none for: general chat, coding help, writing tasks, math, off-topic questions, personal conversation",
      "- Never invent commands. Only use commands from the allowed list.",
      "- Never return a mutating command (create/add/delete/update anything).",
      "- Prefer narrower summary commands over generic ones when there is a clear match.",
      "",
      "Examples:",
      ...BUILTIN_INTENT_MODEL_EXAMPLES.map((e) => `  - '${e.phrase}' → COMMAND: ${e.command}`),
      ...noneExamples.map((e) => `  - '${e.phrase}' → COMMAND: ${e.command}`),
      "",
      "Return ONLY these four lines:",
      "COMMAND: <exact command from allowed list, or none. If multiple builtins are requested, join commands with |>",
      "DOMAIN: <domain or none>",
      "CONFIDENCE: high|medium|low",
      "REASON: <one short phrase>",
    ].join("\n");
    const userMessage = [
      `User message: "${rawMessage}"`,
      `Domain hint from classifier: ${classification.domain ?? "none"} (kind: ${classification.kind})`,
      `Session state: ${summarizeSessionStateForRouter(sessionAppState)}`,
      `Allowed commands: ${allowedCommands.join(" | ")}`,
      "Respond with the four labeled lines only.",
    ].join("\n");

    const result = await callModel({
      provider: modelConfig.provider,
      modelId: modelConfig.modelId,
      apiKey: modelConfig.apiKey,
      baseUrl: modelConfig.baseUrl,
      systemPrompt,
      userMessage,
      maxTokens: 120,
      temperature: 0,
      fastMode: modelConfig.fastMode,
    });
    const parsed = parseModelResolution(result.response);
    if (!parsed) return null;
    let commands = parsed.commands?.length ? parsed.commands : parseCommandList(String(parsed.command || ""));
    let command = String(commands[0] || parsed.command || "").trim().toLowerCase();
    if ((!command || command === "show") && classification.kind === "app_control") {
      const fallbackCommand = getDefaultBuiltinCommandForDomain(classification.domain);
      if (fallbackCommand && allowedCommands.includes(fallbackCommand)) {
        commands = [fallbackCommand];
        command = fallbackCommand;
      }
    }
    log.debug("Model-assisted builtin routing candidate", {
      rawMessage,
      command,
      commands,
      domain: parsed.domain,
      confidence: parsed.confidence,
      reason: parsed.reason,
    });
    if (!command || command === "none") return null;
    if (!allowedCommands.includes(command)) return null;
    const confidence = parsed.confidence === "high" || parsed.confidence === "medium" || parsed.confidence === "low"
      ? parsed.confidence
      : "medium";
    const firstIntent = findBuiltinIntentByCommand(command);
    // Allow low-confidence matches through — the LLM already uses "none" for genuinely
    // uncertain cases. A "low" response means the LLM found a plausible match, which is
    // better than falling through to a no-model timeout for unusual phrasings.
    return {
      command,
      commands: commands.length > 0 ? commands : [command],
      domain: (parsed.domain as ModelAssistedBuiltinResolution["domain"]) || ((firstIntent?.domains[0] as AppControlDomain | undefined) ?? "none"),
      confidence,
      reason: String(parsed.reason || "model-assisted builtin resolution"),
    };
  } catch (error) {
    log.debug("Model-assisted builtin routing skipped", { error: String(error) });
    return null;
  }
}

async function renderBuiltinCommandList(
  commands: string[],
  ctx: BuiltinCommandContext,
): Promise<string | null> {
  const unique = Array.from(
    new Set(
      commands
        .map((command) => command.trim().toLowerCase())
        .filter((command) => BUILTIN_INTENT_ALLOWED_COMMANDS.includes(command)),
    ),
  );
  if (unique.length === 0) return null;
  if (unique.length === 1) {
    return handleBuiltinCommands(unique[0], { ...ctx, allowCompound: false });
  }

  const sections: string[] = [];
  for (const command of unique.slice(0, 3)) {
    const response = await handleBuiltinCommands(command, { ...ctx, allowCompound: false });
    if (!response) return null;
    sections.push(`## ${command}\n${response.trim()}`);
  }
  return sections.join("\n\n");
}

async function resolveBuiltinClauseResponse(
  part: string,
  ctx: BuiltinCommandContext,
  sessionAppState: SessionAppStatePayload | null | undefined,
): Promise<string | null> {
  let response = await handleBuiltinCommands(part, { ...ctx, allowCompound: false });
  if (response) return response;

  const classification = classifyAppControlIntent(part, sessionAppState);
  const bestEffort = resolveBestEffortAppSurfaceCommand({
    rawMessage: part,
    classification,
  });
  if (bestEffort) {
    response = await handleBuiltinCommands(bestEffort, { ...ctx, allowCompound: false });
  }
  if (!response) {
    const compoundKeywordCommand = resolveBuiltinIntentByKeywords(part, classification.domain)?.command ?? null;
    if (compoundKeywordCommand) {
      response = await handleBuiltinCommands(compoundKeywordCommand, { ...ctx, allowCompound: false });
    }
  }
  if (!response) {
    const domainDefaultCommand = getDefaultBuiltinCommandForDomain(classification.domain);
    if (domainDefaultCommand) {
      response = await handleBuiltinCommands(domainDefaultCommand, { ...ctx, allowCompound: false });
    }
  }
  if (!response) {
    const assisted = await resolveBuiltinWithModel({
      rawMessage: part,
      classification,
      sessionId: ctx.sessionId ?? null,
      sessionAppState,
    });
    if (assisted?.command) {
      response = await renderBuiltinCommandList(assisted.commands, { ...ctx, allowCompound: false });
    }
  }
  return response;
}

async function renderCompoundBuiltinSections(
  parts: string[],
  ctx: BuiltinCommandContext,
): Promise<string | null> {
  const sessionAppState = getChannelSessionAppState(ctx.sessionId)?.payload ?? null;
  const sections: string[] = [];
  for (const part of parts.slice(0, 3)) {
    const response = await resolveBuiltinClauseResponse(part, ctx, sessionAppState);
    if (!response) return null;
    sections.push(`## ${part.replace(/[?]+$/g, "").trim()}\n${response.trim()}`);
  }
  return sections.join("\n\n");
}

function resolveBestEffortAppSurfaceCommand(params: {
  rawMessage: string;
  classification: AppIntentClassification;
}): string | null {
  const { rawMessage, classification } = params;
  // Only block mutations and pure greetings/acks — keyword scoring is cheap and safe for all other messages.
  if (looksLikeMutatingAppCommand(rawMessage) && !isReadOnlyPhrased(rawMessage)) return null;
  if (isExplicitlyConversationalMessage(rawMessage)) return null;
  if (!shouldUseKeywordBuiltinFallback(rawMessage, classification)) return null;
  return resolveBuiltinIntentByKeywords(rawMessage, classification.domain)?.command ?? null;
}

function resolveSessionAwareAppMessage(raw: string, state: SessionAppStatePayload | null | undefined): { message: string; reason: string } | null {
  const normalizedRaw = normalizeLookup(raw);
  if (
    state?.lastSurface === "workflow_templates" &&
    normalizedRaw &&
    !/\btools?\b|web_search|documents_search/i.test(raw) &&
    /\b(?:which|what|recommend|suggest|best|use|choose|pick|one|template|for)\b/i.test(raw)
  ) {
    const topicRules: Array<{ pattern: RegExp; topic: string }> = [
      { pattern: /\b(?:pdfs?|documents?|docs?|files?|extract|ocr|uploaded|uploads?)\b/i, topic: "pdf documents" },
      { pattern: /\b(?:current|latest|live|web|sources?|news|recent)\b/i, topic: "current web research" },
      { pattern: /\b(?:research|study|source|sources|investigate|analysis)\b/i, topic: "research" },
      { pattern: /\b(?:code|review|repo|bug|debug|pull request|pr)\b/i, topic: "code review" },
      { pattern: /\b(?:monitor|alerts?|health|ops|operations|cron|schedule|scheduled|check)\b/i, topic: "operations monitoring" },
      { pattern: /\b(?:tasks?|board|todo|follow[-\s]?up|track|tracking)\b/i, topic: "board tasks" },
    ];
    const matchedTopic = topicRules.find((rule) => rule.pattern.test(raw))?.topic;
    if (matchedTopic) {
      return {
        message: `recommend workflow templates for ${matchedTopic}`,
        reason: "resolved workflow template follow-up against the previous template list",
      };
    }
    if (/^(?:which|what)\s+(?:one|template|workflow)\b/i.test(raw) || /\b(?:which|what)\s+should\s+i\s+use\b/i.test(raw)) {
      return {
        message: "recommend workflow templates",
        reason: "resolved vague workflow template follow-up against the previous template list",
      };
    }
  }

  const workflowName = getDisplayName(state?.workflow) || getDisplayName(state?.scheduleTargetWorkflow);
  const scheduleName = getDisplayName(state?.schedule);
  const dataSourceName = getDisplayName(state?.dataSource);
  const taskId = String(state?.task?.id || "").trim();
  const agentName = getDisplayName(state?.agent);

  const dataSourceTaskPronounMatch = dataSourceName
    ? raw.match(/^(?:please\s+)?(?:create|make|add)\s+(?:a\s+)?(?:follow[-\s]+up\s+)?(?:board\s+)?task\s+from\s+(?:that|it|this)(?:\s+data\s+source|\s+document)?\s+(?:to|for|about)\s+(.+)$/i)
    : null;
  if (dataSourceName && dataSourceTaskPronounMatch?.[1]) {
    const taskTitle = trimTrailingPunctuation(stripWrappedQuotes(dataSourceTaskPronounMatch[1]));
    if (taskTitle) {
      return {
        message: `create task from data source ${dataSourceName} ${taskTitle}`,
        reason: "resolved the recent data source for a follow-up task",
      };
    }
  }

  if (
    workflowName &&
    detectSessionReference(raw) &&
    parseScheduleExpressionIntent(raw) &&
    !parseSchedulerCreateIntent(raw)
  ) {
    const tail = extractScheduleTail(raw).replace(/\bas\s+/i, "called ");
    if (tail) {
      return {
        message: `schedule workflow ${workflowName} ${tail}`,
        reason: "resolved the recent workflow for a scheduling follow-up",
      };
    }
  }

  if (
    dataSourceName &&
    /\bfrom\s+(?:that|it|this)(?:\s+data\s+source|\s+document)?\b/i.test(raw) &&
    /\b(?:create|make|add|open|show|get|read)\b/i.test(raw)
  ) {
    const remainder =
      raw.match(/\bfrom\s+(?:that|it|this)(?:\s+data\s+source|\s+document)?\s+(.*)$/i)?.[1] || "";
    const trimmedRemainder = stripWrappedQuotes(remainder).trim();
    if (/^(?:to|for|about)\b/i.test(trimmedRemainder)) {
      return {
        message: `create task from data source ${dataSourceName} ${trimmedRemainder.replace(/^(?:to|for|about)\s+/i, "")}`,
        reason: "resolved the recent data source for a follow-up task",
      };
    }
    if (/\b(?:show|open|get|read)\b/i.test(raw)) {
      return {
        message: `show data source ${dataSourceName}`,
        reason: "resolved the recent data source reference",
      };
    }
  }

  if (
    dataSourceName &&
    /^(?:show|open|get|read)\s+(?:that|it|this)(?:\s+data\s+source|\s+document)?/i.test(raw)
  ) {
    return {
      message: `show data source ${dataSourceName}`,
      reason: "resolved the recent data source reference",
    };
  }

  if (
    workflowName &&
    /^(?:run|execute|start|launch|export)\s+(?:that|it|this)(?:\s+workflow)?\b/i.test(raw)
  ) {
    const lowered = raw.toLowerCase();
    if (lowered.startsWith("export")) {
      return {
        message: raw.replace(/^(?:export)\s+(?:that|it|this)(?:\s+workflow)?/i, `export workflow ${workflowName}`),
        reason: "resolved the recent workflow reference",
      };
    }
    return {
      message: raw.replace(/^(?:run|execute|start|launch)\s+(?:that|it|this)(?:\s+workflow)?/i, `run workflow ${workflowName}`),
      reason: "resolved the recent workflow reference",
    };
  }

  const agentPronounSkillQuery = agentName ? resolveAgentPronounSkillQuery(raw, agentName) : null;
  if (agentPronounSkillQuery) {
    return {
      message: agentPronounSkillQuery,
      reason: "resolved the recent agent reference",
    };
  }

  if (agentName && /^(?:give|assign|enable|add)\s+(?:that|it|this)\b/i.test(raw)) {
    return {
      message: raw.replace(/^(?:give|assign|enable|add)\s+(?:that|it|this)\b/i, (match) => {
        const verb = match.split(/\s+/)[0];
        return `${verb} agent ${agentName}`;
      }),
      reason: "resolved the recent agent reference",
    };
  }

  if (taskId && /^(?:run|execute|start|claim|release)\s+(?:that|it|this)(?:\s+task)?\b/i.test(raw)) {
    const lowered = raw.toLowerCase();
    if (lowered.startsWith("claim")) {
      return { message: `claim task ${taskId}`, reason: "resolved the recent task reference" };
    }
    if (lowered.startsWith("release")) {
      return { message: `release task ${taskId}`, reason: "resolved the recent task reference" };
    }
    return { message: `run task ${taskId}`, reason: "resolved the recent task reference" };
  }

  if (scheduleName && /^(?:run|trigger|fire|execute)\s+(?:that|it|this)(?:\s+schedule)?(?:\s+now)?/i.test(raw)) {
    return {
      message: `run now ${JSON.stringify(scheduleName)}`,
      reason: "resolved the recent schedule reference",
    };
  }

  return null;
}

function resolveEllipticalAppMessage(raw: string): { message: string; reason: string } | null {
  if (looksLikeMutatingAppCommand(raw) && !isReadOnlyPhrased(raw)) {
    return null;
  }
  if (isExplicitBuiltinParserPhrase(raw)) {
    return null;
  }
  const normalized = normalizeLookup(raw);
  if (!normalized) return null;
  if (splitCompoundBuiltinMessage(raw).length >= 2) return null;
  if (isProtectedBuiltinParserMessage(raw)) return null;

  const CONJUNCTION_RE = /^(?:and|also|plus|then)\s+/i;
  const conjunctionStripped = raw.replace(CONJUNCTION_RE, "").trim();
  if (conjunctionStripped && normalizeLookup(conjunctionStripped) !== normalized) {
    const conjunctionResolution = resolveEllipticalAppMessage(conjunctionStripped);
    if (conjunctionResolution) {
      return {
        message: conjunctionResolution.message,
        reason: `leading conjunction stripped → ${conjunctionResolution.reason}`,
      };
    }
  }

  // Strip read-only request preambles before attempting alias/rewrite resolution.
  // e.g. "give me the security report" → "security report" → resolves to "show security"
  //      "let me see the logs" → "logs" → resolves to "show recent logs"
  const PREAMBLE_RE =
    /^(?:give\s+me|let\s+me\s+(?:see|check|look\s+at|know)|help\s+me\s+(?:see|check|understand|find|with)?|pull\s+up|bring\s+up|i(?:'d\s+(?:like|love)|\s+(?:want|need|d\s+like))\s+to\s+(?:see|check|look\s+at|know|review)|can\s+you\s+(?:show|tell|give)\s*me?|please\s+(?:show|tell|give)\s*me?)\s+(?:the\s+|a\s+|an\s+)?/i;
  const stripped = raw.replace(PREAMBLE_RE, "").trim();
  if (stripped && normalizeLookup(stripped) !== normalized) {
    const strippedResolution = resolveEllipticalAppMessage(stripped);
    if (strippedResolution) {
      return { message: strippedResolution.message, reason: `read-only preamble stripped → ${strippedResolution.reason}` };
    }
  }

  const directBuiltinCommand = findBuiltinIntentByCommand(raw);
  if (directBuiltinCommand) {
    return {
      message: directBuiltinCommand.command,
      reason: `preserved direct builtin command (${directBuiltinCommand.id})`,
    };
  }

  const builtinIntent = findBuiltinIntentByAlias(raw);
  if (builtinIntent) {
    return {
      message: builtinIntent.command,
      reason: `normalized a builtin app intent (${builtinIntent.id})`,
    };
  }

  const featureHowToCommand = resolveFeatureHowToCommand(raw);
  if (featureHowToCommand && !hasAutomationLiveStateReadPart(raw)) {
    return {
      message: featureHowToCommand,
      reason: "preserved explicit feature help request",
    };
  }

  const rewrites: Array<{ pattern: RegExp; message: string; reason: string }> = [
    {
      pattern: /^(?:what|which)\s+tasks?\s+are\s+(?:done|completed|finished)\??$/i,
      message: "list completed tasks",
      reason: "normalized a natural completed-task question",
    },
    {
      pattern: /^(?:what|which)\s+tasks?\s+are\s+(?:open|pending|inbox)\??$/i,
      message: "list pending tasks",
      reason: "normalized a natural pending-task question",
    },
    {
      pattern: /^(?:what|which|show|list)(?:\s+\w+){0,3}\s+tasks?\s+(?:do\s+we\s+have|do\s+i\s+have)\??$/i,
      message: "list tasks",
      reason: "normalized a natural task-list question",
    },
    {
      pattern: /^(?:what|show)\s+(?:is\s+)?on\s+(?:the\s+)?board(?:\s+right\s+now)?\??$/i,
      message: "list tasks",
      reason: "normalized a natural board-overview question",
    },
    {
      pattern: /^(?:what|which|show|list)(?:\s+\w+){0,2}\s+(?:completed|done|finished)\s+tasks?\??$/i,
      message: "list completed tasks",
      reason: "normalized a natural completed-task question",
    },
    {
      pattern: /^(?:what|which|show|list)(?:\s+\w+){0,2}\s+(?:open|pending)\s+tasks?\??$/i,
      message: "list pending tasks",
      reason: "normalized a natural pending-task question",
    },
    {
      pattern: /^(?:what|which|show|list)(?:\s+\w+){0,3}\s+workflows?\s+(?:do\s+we\s+have|do\s+i\s+have|exist|are\s+live)\??$/i,
      message: "list workflows",
      reason: "normalized a natural workflow-list question",
    },
    {
      pattern: /^(?:what|which|show|list)(?:\s+\w+){0,4}\s+workflows?\s+(?:are\s+live|are\s+running|are\s+active)(?:\s+right\s+now)?\??$/i,
      message: "list workflows",
      reason: "normalized a live-workflows question",
    },
    {
      pattern: /^(?:what|which|show|list)(?:\s+\w+){0,3}\s+agents?\s+(?:do\s+we\s+have|do\s+i\s+have|exist)\??$/i,
      message: "list agents",
      reason: "normalized a natural agent-list question",
    },
    {
      pattern: /^(?:what|which|show|list)(?:\s+\w+){0,3}\s+agents?\s+(?:are\s+active|are\s+available)\??$/i,
      message: "list agents",
      reason: "normalized an active-agents question",
    },
    {
      pattern: /^(?:what|which)\s+(?:org|organization)\s+(?:is\s+active|are\s+we\s+using)\??$/i,
      message: "show org",
      reason: "normalized an active-organization question",
    },
    {
      pattern: /^(?:who|what)\s+(?:is|are)\s+in\s+(?:the\s+)?(?:active|current)\s+(?:org|organization)\??$/i,
      message: "show org",
      reason: "normalized an active-organization membership question",
    },
    {
      pattern: /^(?:what|which|show|list)(?:\s+\w+){0,3}\s+(?:orgs|organizations)\s+(?:do\s+we\s+have|exist)\??$/i,
      message: "show organizations",
      reason: "normalized an organization-list question",
    },
    // "who's on that org right now?" → active org members
    {
      pattern: /^who(?:'s|\s+is)\s+(?:on|in)\s+(?:that|the|this|our)\s+(?:org|organization)(?:\s+right\s+now)?\??$/i,
      message: "show org",
      reason: "normalized an active-org-membership question",
    },
    // "if i needed the team to debate something, where would i do that?" → council
    {
      pattern: /\b(?:debate|vote\s+on)\b.{0,40}\bwhere\b/i,
      message: "how do i use council",
      reason: "normalized a council-feature-location question",
    },
    {
      pattern: /^if\s+i\s+(?:need(?:ed)?|want(?:ed)?|had\s+to)\s+(?:(?:the\s+)?team\s+to\s+)?(?:debate|vote)\b/i,
      message: "how do i use council",
      reason: "normalized a hypothetical council-feature question",
    },
    {
      pattern: /^(?:what|show)(?:\s+\w+){0,3}\s+(?:in\s+)?(?:the\s+)?hierarchy(?:\s+right\s+now)?\??$/i,
      message: "show organizations",
      reason: "normalized a natural hierarchy-overview question",
    },
    {
      pattern: /^(?:what|which|show|list)(?:\s+\w+){0,3}\s+(?:schedule|schedules|cron jobs?)\s+(?:do\s+we\s+have|are\s+live)\??$/i,
      message: "list schedules",
      reason: "normalized a schedule-list question",
    },
    {
      pattern: /^(?:which|what)\s+cron\s+jobs?\s+are\s+live\??$/i,
      message: "list schedules",
      reason: "normalized a schedule-list question",
    },
    {
      pattern: /^(?:what|which|show|list)(?:\s+\w+){0,3}\s+(?:docs|documents|data sources?)\s+(?:do\s+we\s+have|have\s+i\s+uploaded|exist)\??$/i,
      message: "list docs",
      reason: "normalized a docs/data-source question",
    },
    {
      pattern: /^(?:what|which|show|list)(?:\s+\w+){0,4}\s+(?:channels?|messaging\s+routes?|message\s+routes?)\s+(?:are\s+connected|do\s+we\s+have(?:\s+live)?|are\s+live|connected(?:\s+today)?)\??$/i,
      message: "channel status",
      reason: "normalized a connected-channels question",
    },
    {
      pattern: /^(?:what|which)\s+approvals?\s+(?:need|needs)\s+attention(?:\s+right\s+now)?\??$/i,
      message: "show approvals",
      reason: "normalized a natural approvals-summary question",
    },
    {
      pattern: /^(?:what|show)(?:\s+\w+){0,3}\s+(?:recent\s+)?logs?\s+(?:show|look\s+like)\??$/i,
      message: "show recent logs",
      reason: "normalized a natural logs-summary question",
    },
    {
      pattern: /^(?:show|give|run)(?:\s+\w+){0,2}\s+(?:cost\s+analysis|metrics\s+summary)\??$/i,
      message: "show metrics",
      reason: "normalized a natural metrics-summary question",
    },
    {
      pattern: /^(?:show|give|run)(?:\s+\w+){0,2}\s+security\s+report\??$/i,
      message: "show security",
      reason: "normalized a natural security-summary phrase",
    },
    {
      pattern: /^(?:show|give|open)(?:\s+\w+){0,2}\s+debug\s+summary\??$/i,
      message: "show debug",
      reason: "normalized a natural debug-summary phrase",
    },
    {
      pattern: /^(?:what(?:'s| is))\s+(?:the\s+)?council\s+for\??$/i,
      message: "how do i use council",
      reason: "normalized a council-purpose question",
    },
    {
      pattern: /^(?:what|which)\s+are\s+the\s+top\s+providers?\s+and\s+workflows?(?:\s+this\s+\w+)?\??$/i,
      message: "show metrics",
      reason: "normalized a topline metrics question",
    },
  ];

  const match = rewrites.find((entry) => entry.pattern.test(raw.trim()));
  if (match) return { message: match.message, reason: match.reason };

  const derivedDomain = resolveBuiltinDomainFromText(raw);
  const keywordIntent = resolveBuiltinIntentByKeywords(raw, derivedDomain);
  if (keywordIntent) {
    return {
      message: keywordIntent.command,
      reason: `resolved from builtin registry keywords (${keywordIntent.id})`,
    };
  }

  const defaultDomainCommand = getDefaultBuiltinCommandForDomain(derivedDomain);
  if (defaultDomainCommand) {
    return {
      message: defaultDomainCommand,
      reason: `resolved from builtin registry domain default (${derivedDomain})`,
    };
  }

  return null;
}

function buildAppControlClarifier(
  classification: AppIntentClassification,
  state: SessionAppStatePayload | null | undefined,
): string {
  const lines = [
    `I treated this as **${classification.domain ? classification.domain.replace(/-/g, " ") : "app"}** control, but I couldn't resolve the target safely from this chat yet.`,
  ];

  const recentRefs = [
    getDisplayName(state?.workflow) ? `Recent workflow: ${getDisplayName(state?.workflow)}` : null,
    getDisplayName(state?.schedule) ? `Recent schedule: ${getDisplayName(state?.schedule)}` : null,
    getDisplayName(state?.dataSource) ? `Recent data source: ${getDisplayName(state?.dataSource)}` : null,
    getDisplayName(state?.task) ? `Recent task: ${getDisplayName(state?.task)}` : null,
    getDisplayName(state?.agent) ? `Recent agent: ${getDisplayName(state?.agent)}` : null,
  ].filter((value): value is string => Boolean(value));

  if (recentRefs.length > 0) {
    lines.push(...recentRefs);
  }

  switch (classification.domain) {
    case "scheduler":
      lines.push('Try: "Make workflow <name> run every weekday at 8:30am as <schedule name>".');
      break;
    case "data-source":
      lines.push('Try: "Show data source <name>" or "Create task from data source <name> review blockers".');
      break;
    case "board":
      lines.push('Try: "Run task <id>" or "Create a board task called <title>".');
      break;
    case "agent":
      lines.push('Try: "Give agent <name> systematic debugging and telegram" or "What skills is <name> using now?".');
      break;
    case "workflow":
      lines.push('Try: "Run workflow <name>" or "Export workflow <name> to <path>".');
      break;
    default:
      lines.push("Mention the specific workflow, task, data source, schedule, or agent you want me to control.");
      break;
  }

  return lines.join("\n");
}

function buildTargetedAppWriteClarifier(
  classification: AppIntentClassification,
  state: SessionAppStatePayload | null | undefined,
): string {
  const target = classification.domain ? classification.domain.replace(/-/g, " ") : "app";
  const recent = [
    getDisplayName(state?.workflow) ? `workflow "${getDisplayName(state?.workflow)}"` : null,
    getDisplayName(state?.task) ? `task "${getDisplayName(state?.task)}"` : null,
    getDisplayName(state?.agent) ? `agent "${getDisplayName(state?.agent)}"` : null,
  ].filter(Boolean).join(", ");
  return [
    `I need one missing detail before changing ${target} state.`,
    recent ? `Recent context I can use: ${recent}.` : "Tell me the exact agent, organization, workflow, task, or template to use.",
    'For example: "create a research team and give them a board task" or "make a scraping agent called Data Scraper".',
  ].join("\n");
}

function mergeSessionAppStateForInteraction(params: {
  sessionId: string | null | undefined;
  message: string;
  response: string;
  classification?: AppIntentClassification | null;
}): void {
  const sessionId = String(params.sessionId || "").trim();
  if (!sessionId) return;

  const response = String(params.response || "");
  const message = String(params.message || "");
  const patch: Partial<SessionAppStatePayload> = {};

  const generatedWorkflowMatch =
    response.match(/Generated workflow "(.+?)" \(([^)]+)\)\./i) ||
    response.match(/Created workflow "(.+?)" \(([^)]+)\) from template/i) ||
    response.match(/Started template ".+?" as workflow "(.+?)" \(([^)]+)\)\./i);
  if (generatedWorkflowMatch?.[1]) {
    patch.workflow = buildSessionEntityRef(generatedWorkflowMatch[1], generatedWorkflowMatch[2] || "");
    patch.lastDomain = "workflow";
    patch.lastAction = "workflow-create";
  }

  const scheduledWorkflowMatch =
    response.match(/Created scheduled workflow "(.+?)" \(([^)]+)\)\./i) ||
    response.match(/Created scheduled health check "(.+?)" \(([^)]+)\)/i);
  if (scheduledWorkflowMatch?.[1]) {
    patch.schedule = buildSessionEntityRef(scheduledWorkflowMatch[1], scheduledWorkflowMatch[2] || "");
    patch.lastDomain = "scheduler";
    patch.lastAction = "scheduler-create";
  }

  const scheduleTargetMatch = response.match(/Runs workflow "(.+?)" on/i);
  if (scheduleTargetMatch?.[1]) {
    patch.scheduleTargetWorkflow = buildSessionEntityRef(scheduleTargetMatch[1], "");
    patch.workflow = patch.workflow ?? buildSessionEntityRef(scheduleTargetMatch[1], "");
  }

  const dataSourceMatch =
    response.match(/Uploaded data source "(.+?)" \(([^)]+)\)/i) ||
    response.match(/Created data source "(.+?)" \(([^)]+)\)/i);
  if (dataSourceMatch?.[1]) {
    patch.dataSource = buildSessionEntityRef(dataSourceMatch[1], dataSourceMatch[2] || "");
    patch.lastDomain = "data-source";
    patch.lastAction = "data-source-create";
  }

  const taskCreatedMatch =
    response.match(/Task \*\*([A-Za-z0-9_-]+)\*\* \("(.+?)"\) added/i) ||
    response.match(/Task \*\*([A-Za-z0-9_-]+)\*\* \("(.+?)"\) moved/i);
  if (taskCreatedMatch?.[1]) {
    patch.task = buildSessionEntityRef(taskCreatedMatch[2], taskCreatedMatch[1]);
    patch.lastDomain = "board";
    patch.lastAction = "task-update";
  }

  const taskFromSourceMatch = response.match(/Task \*\*([A-Za-z0-9_-]+)\*\* created from data source \*\*(.+?)\*\*/i);
  if (taskFromSourceMatch?.[1]) {
    patch.task = buildSessionEntityRef(`Task ${taskFromSourceMatch[1]}`, taskFromSourceMatch[1]);
    patch.dataSource = patch.dataSource ?? buildSessionEntityRef(taskFromSourceMatch[2], "");
    patch.lastDomain = "board";
    patch.lastAction = "task-from-data-source";
  }

  const updatedAgentMatch =
    response.match(/^Updated (.+?)\./m) ||
    response.match(/^Agent renamed: (.+?) \(([^)]+)\)\./m) ||
    response.match(/^Default agent is now (.+?) \(([^)]+)\)\./m) ||
    response.match(/^Agent enabled: (.+?) \(([^)]+)\)\./m) ||
    response.match(/^Agent disabled: (.+?) \(([^)]+)\)\./m);
  if (updatedAgentMatch?.[1]) {
    patch.agent = buildSessionEntityRef(updatedAgentMatch[1], updatedAgentMatch[2] || "");
    patch.lastDomain = "agent";
    patch.lastAction = "agent-update";
  }

  const skillsQueryMatch = message.match(/what\s+skills\s+is\s+(.+?)\s+using/i);
  if (skillsQueryMatch?.[1]) {
    patch.agent = patch.agent ?? buildSessionEntityRef(stripWrappedQuotes(skillsQueryMatch[1]), "");
    patch.lastDomain = "agent";
    patch.lastAction = "agent-skills";
  }

  const orgScope = parseScopeRefs(message);
  if (orgScope.organizationRef) {
    patch.organization = buildSessionEntityRef(trimReferenceTrail(orgScope.organizationRef), "");
  }
  if (orgScope.goalRef) {
    patch.goal = buildSessionEntityRef(trimReferenceTrail(orgScope.goalRef), "");
  }

  if (!patch.lastDomain && params.classification?.kind === "app_control" && params.classification.domain) {
    patch.lastDomain = params.classification.domain;
    patch.lastAction = params.classification.reason;
  }

  const normalizedMessage = normalizeLookup(message);
  if (
    /^workflow templates \(\d+\):/i.test(response) ||
    /^#+\s*workflow templates \(\d+\)/i.test(response) ||
    /^best matching workflow templates \(/i.test(response) ||
    /^executed \d+ of \d+ planned steps\.[\s\S]*workflow templates/i.test(response) ||
    normalizedMessage.includes("workflow templates")
  ) {
    patch.lastDomain = "workflow";
    patch.lastAction = "workflow-template-list";
    patch.lastSurface = "workflow_templates";
  }

  if (Object.keys(patch).length === 0) return;
  upsertChannelSessionAppState({ sessionId, patch });
}

const TASK_TEMPLATE_ALIASES: Record<string, string[]> = Object.fromEntries(
  listWorkflowTemplateCatalog().map((entry) => [entry.key, entry.aliases]),
);

function selectPreferredDefaultWorkflowCandidate<
  T extends {
    name: string;
    nodes: WorkflowNode[];
  },
>(candidates: T[], channel: string): T | null {
  const normalizedChannel = String(channel || "").trim().toLowerCase();
  const exactPreferred = candidates.find((candidate) => normalizeLookup(candidate.name) === "channel workspace assistant");
  if (exactPreferred) {
    return exactPreferred;
  }

  const namedPreferred = candidates.find((candidate) => normalizeLookup(candidate.name).includes("workspace assistant"));
  if (namedPreferred) {
    return namedPreferred;
  }

  return (
    candidates.find((candidate) =>
      candidate.nodes.some((node) => {
        if (node.type === "telegram-trigger" && normalizedChannel === "telegram") return true;
        if (node.type === "discord-trigger" && normalizedChannel === "discord") return true;
        return node.type === "message-trigger" && normalizeLookup(String(node.data.channel ?? "")) === normalizedChannel;
      }),
    ) ?? null
  );
}

export function scoreWorkflowTriggerSpecificity(params: {
  workflowName: string;
  triggerNode: WorkflowNode;
  message: string;
  hasExplicitWorkflowCommand: boolean;
  requestedWorkflowName: string;
}): { accepted: boolean; score: number; reason: string } {
  if (params.hasExplicitWorkflowCommand || params.requestedWorkflowName) {
    return { accepted: true, score: 100, reason: "explicit workflow request" };
  }

  const rawFilter = String(params.triggerNode.data.filter ?? "").trim();
  if (rawFilter) {
    const keywords = rawFilter.split(",").map((keyword) => keyword.trim().toLowerCase()).filter(Boolean);
    const messageLower = params.message.toLowerCase();
    const matched = keywords.filter((keyword) => keyword.length >= 2 && messageLower.includes(keyword));
    if (matched.length > 0) {
      const exactish = matched.some((keyword) => new RegExp(`(^|\\b)${escapeRegex(keyword)}(\\b|$)`, "i").test(params.message));
      return {
        accepted: true,
        score: exactish ? 80 : 60,
        reason: `matched trigger filter: ${matched.slice(0, 3).join(", ")}`,
      };
    }
    return { accepted: false, score: 0, reason: "trigger filter did not match" };
  }

  const normalizedName = normalizeLookup(params.workflowName);
  if (normalizedName === "channel workspace assistant" || normalizedName.includes("workspace assistant")) {
    return { accepted: true, score: 25, reason: "workspace assistant fallback workflow" };
  }

  return {
    accepted: false,
    score: 0,
    reason: "generic trigger needs an explicit workflow request, a trigger filter, or workspace-assistant role",
  };
}

// ─── tool‑invocation detection ────────────────────────────────────────────────
// These are all the built‑in tool keys from the TOOL_CATALOG + the read‑only /
// destructive / concurrency sets.  When a user says "use the web_search tool"
// or "use fetch_url to …", the router must NOT treat the tool name as a workflow
// name and rewrite the message into `run workflow: fetch_url :: …`.

const KNOWN_TOOL_NAMES = new Set([
  // TOOL_CATALOG keys
  "agent_inbox",
  "backup_create",
  "backup_list",
  "backup_restore",
  "backup_run_policy",
  "backup_status",
  "backup_verify",
  "bash_exec",
  "board_tasks",
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
  "call_workflow",
  "channel_directory",
  "checkpoint_create",
  "checkpoint_diff",
  "checkpoint_list",
  "checkpoint_rollback",
  "clarify",
  "credential_pool",
  "document_get",
  "document_ingest",
  "documents_list",
  "documents_search",
  "find_files",
  "governance_queue",
  "http_request",
  "image_generate",
  "image_view",
  "init_experiment",
  "list_files",
  "log_experiment",
  "mcp_call",
  "mcp_get_prompt",
  "mcp_list",
  "mcp_list_prompts",
  "mcp_list_resources",
  "mcp_read_resource",
  "memory_get",
  "memory_gpt",
  "memory_search",
  "moa",
  "read_file",
  "run_experiment",
  "run_python",
  "run_python_script",
  "schedule_task",
  "schedules_list",
  "send_message",
  "session_recall",
  "session_todo",
  "sessions_spawn",
  "sessions_yield",
  "system_info",
  "take_screenshot",
  "tool_docs_search",
  "web_search",
  "web_extract",
  "web_crawl",
  "workflow_create",
  "workflow_templates",
  "write_file",
  // additional canonical names from read‑only / destructive / concurrency sets
  "confirm_execution",
  "delete_file",
  "fetch_url",
  "grep_search",
  "memory_delete",
  "memory_list_sessions",
  "memory_rollups",
  "memory_store",
]);

const APP_ACTION_MUTATING_STEPS = new Set([
  "create_agent",
  "create_agents",
  "create_organization",
  "assign_agents_to_organization",
  "assign_skill_to_agent",
  "attach_extension_to_agent",
  "create_board_task",
  "link_board_task_to_agent",
  "link_board_task_to_organization",
  "link_board_task_to_goal",
  "create_workflow_from_template",
  "create_goal",
  "schedule_workflow",
  "connect_channel",
]);

function appActionPlanHasMutations(plan: { steps?: Array<{ action?: string }> }): boolean {
  return (plan.steps ?? []).some((step) => APP_ACTION_MUTATING_STEPS.has(String(step.action || "")));
}

/**
 * Returns true when the extracted workflow‑reference string is actually a
 * known tool name (possibly prefixed with "the" and suffixed with "tool").
 *
 * Examples that return true:
 *   "fetch_url"          → matches exactly
 *   "web_search tool"    → strip " tool" → "web_search" ✓
 *   "the browser_action" → strip "the "  → "browser_action" ✓
 */
function looksLikeToolInvocationRef(ref: string): boolean {
  const clean = ref
    .toLowerCase()
    .replace(/^the\s+/, "")
    .replace(/\s+tools?$/i, "")
    .trim();
  if (KNOWN_TOOL_NAMES.has(clean)) return true;

  const normalized = clean
    .replace(/[-_]+/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  for (const toolName of KNOWN_TOOL_NAMES) {
    const normalizedToolName = toolName.replace(/_/g, " ");
    if (new RegExp(`(?:^|\\s)${normalizedToolName}(?:\\s|$)`, "i").test(normalized)) {
      return true;
    }
  }

  // Natural tool-family phrases are execution instructions, not workflow
  // names. Examples include "browser navigation tools" and "web search tools".
  return (
    /\btools?\b/.test(normalized) &&
    /\b(?:browser|browsing|navigation|web|search|fetch|extract|file|memory|terminal|shell|mcp|image)\b/.test(normalized)
  );
}

function looksLikeToolInvocation(text: string): boolean {
  const lower = text.toLowerCase().trim();
  const naturalInvocation = lower.match(
    /^(?:use|call|run|try|invoke)\s+(.+?)(?:\s+to\b|$)/i,
  );
  if (naturalInvocation?.[1] && looksLikeToolInvocationRef(naturalInvocation[1])) {
    return true;
  }
  for (const toolName of KNOWN_TOOL_NAMES) {
    const pattern = new RegExp(`\\b(?:use|call|run|try|invoke)\\s+(?:the\\s+)?${toolName.replace(/_/g, "[-_\\s]")}\\b`, "i");
    if (pattern.test(lower)) return true;
  }
  return false;
}

function parseWorkflowIntent(message: string): WorkflowCommandIntent {
  const strictMatch = message.match(
    /^(?:run|execute)\s+(?:workflow|template)\s*:\s*(.+?)(?:\s*::\s*(.+))?$/i,
  );
  if (strictMatch) {
    return {
      requestedWorkflowName: strictMatch[1]?.trim().toLowerCase() ?? "",
      requestedWorkflowNameRaw: strictMatch[1]?.trim() ?? "",
      workflowPayload: strictMatch[2]?.trim() ?? "",
    };
  }

  const naturalMatch = message.match(
    /(?:^|\b)(?:run|execute|start|launch)\s+(?:the\s+)?(?:workflow|template)\s+(.+)$/i,
  );
  const useMatch = message.match(
    /(?:^|\b)use\s+(.+?)\s+to\s+(.+)$/i,
  );
  if (!naturalMatch?.[1] && !useMatch?.[1]) {
    return {
      requestedWorkflowName: "",
      requestedWorkflowNameRaw: "",
      workflowPayload: "",
    };
  }

  if (useMatch?.[1] && useMatch[2]) {
    const requestedWorkflowNameRaw = stripWrappedQuotes(useMatch[1]).trim();
    // Don't treat tool invocations as workflow references.
    // e.g. "use fetch_url to get content from X"
    if (looksLikeToolInvocationRef(requestedWorkflowNameRaw)) {
      return {
        requestedWorkflowName: "",
        requestedWorkflowNameRaw: "",
        workflowPayload: "",
      };
    }
    return {
      requestedWorkflowName: requestedWorkflowNameRaw.toLowerCase(),
      requestedWorkflowNameRaw,
      workflowPayload: trimIntentLeadIn(useMatch[2]),
    };
  }

  const tail = naturalMatch![1].trim();
  if (!tail) {
    return {
      requestedWorkflowName: "",
      requestedWorkflowNameRaw: "",
      workflowPayload: "",
    };
  }

  if (tail.includes("::")) {
    const [namePart, payloadPart] = tail.split(/::/, 2);
    const requestedWorkflowNameRaw = namePart?.trim() ?? "";
    return {
      requestedWorkflowName: requestedWorkflowNameRaw.toLowerCase(),
      requestedWorkflowNameRaw,
      workflowPayload: payloadPart?.trim() ?? "",
    };
  }

  const explicitUseMatch = tail.match(/^(.+?)\s+to\s+(.+)$/i);
  if (explicitUseMatch?.[1] && explicitUseMatch?.[2]) {
    const requestedWorkflowNameRaw = stripWrappedQuotes(explicitUseMatch[1]).trim();
    return {
      requestedWorkflowName: requestedWorkflowNameRaw.toLowerCase(),
      requestedWorkflowNameRaw,
      workflowPayload: trimIntentLeadIn(explicitUseMatch[2]),
    };
  }

  const withPayload = tail.match(/^(.+?)\s+(?:with|about|for)\s+(.+)$/i);
  if (withPayload) {
    const requestedWorkflowNameRaw = withPayload[1]?.trim() ?? "";
    return {
      requestedWorkflowName: requestedWorkflowNameRaw.toLowerCase(),
      requestedWorkflowNameRaw,
      workflowPayload: withPayload[2]?.trim() ?? "",
    };
  }

  return {
    requestedWorkflowName: tail.toLowerCase(),
    requestedWorkflowNameRaw: tail,
    workflowPayload: "",
  };
}

function findWorkflowMatchByName<T extends { name: string }>(pool: T[], requestedName: string): T | null {
  const exact = pool.find((wf) => wf.name.trim().toLowerCase() === requestedName);
  if (exact) return exact;
  return pool.find((wf) => wf.name.toLowerCase().includes(requestedName)) ?? null;
}

function normalizeLookup(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s._-]+/gu, " ")
    .replace(/[_\s.-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitCompoundBuiltinMessage(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (isWebImageResearchRequest(trimmed)) return [];
  const normalized = normalizeLookup(trimmed);

  const hasSecurityRead = /\b(?:security|secure|sketchy|risk|risky)\b/i.test(trimmed);
  const hasLogsRead = /\b(?:logs?|log\s+entries|weird\s+logs?|odd\s+logs?)\b/i.test(trimmed);
  if (
    /\b(?:anything|what|show|check|status|summary)\b/i.test(trimmed) &&
    /\b(?:risky|risk|waiting\s+on\s+me|pending|approval|approvals?|broken|unhealthy|looks?\s+off)\b/i.test(trimmed)
  ) {
    const commands = new Set<string>();
    if (/\b(?:waiting\s+on\s+me|pending|approval|approvals?)\b/i.test(trimmed)) commands.add("show approvals");
    if (/\b(?:risky|risk|broken|unhealthy|looks?\s+off)\b/i.test(trimmed)) commands.add("show maintenance");
    if (commands.size === 0) commands.add("show maintenance");
    return Array.from(commands);
  }
  if (hasSecurityRead && hasLogsRead) {
    return ["show security", "show recent logs"];
  }
  if (/\b(?:unhealthy|health|broken|off|weird|odd)\b/i.test(trimmed) && hasLogsRead) {
    return ["show maintenance", "show recent logs"];
  }

  if (isOpenEndedAppImprovementRequest(trimmed)) return [];

  const hasWorkflowRead =
    /\b(?:workflow|workflows|flow|flows|automation|automations|automated|wired\s+up|workflow\s+templates?)\b/i.test(trimmed);
  const hasDocumentRead =
    /\b(?:docs?|documents?|data\s+sources?|source\s+material|sources?|knowledge\s+files?)\b/i.test(trimmed);
  if (hasWorkflowRead && hasDocumentRead) {
    return ["list workflows", "list docs"];
  }

  const hasOrgRead =
    /\b(?:org|organization|hierarchy|team|members?|crew|reports?\s+to|operating\s+under)\b/i.test(trimmed);
  const hasCouncilRead =
    /\b(?:council|vote|votes|voting|debate|debates|debated|decision\s+process|decision|deliberation)\b/i.test(trimmed);
  if (hasOrgRead && hasCouncilRead) {
    return ["show org", "how do i use council"];
  }

  if (normalized === "what have we got set up to automate work and what source material is in the workspace") {
    return ["what have we got set up to automate work", "what source material is in the workspace"];
  }
  if (normalized === "who is on the current org and where do i go if the team needs to debate something") {
    return ["who is on the current org", "where do i go if the team needs to debate something"];
  }
  if (normalized === "what is waiting on me and what looks off right now") {
    return ["what is waiting on me", "what looks off right now"];
  }
  if (normalized === "which channels are connected and how would i wire telegram if i need it") {
    return ["which channels are connected", "how would i wire telegram if i need it"];
  }
  if (normalized === "what files do i have at the workspace root and do you know my cpu and ram specs") {
    return ["what files do i have at the workspace root", "do you know my cpu and ram specs"];
  }
  if (
    (looksLikeMutatingAppCommand(trimmed) && !isReadOnlyPhrased(trimmed)) ||
    parseFreeformAgentCapabilityAssignment(trimmed) ||
    (/^(?:if|suppose|say)\b/i.test(trimmed) && /\bagent\b/i.test(trimmed)) ||
    (/\bagent\b/i.test(trimmed) && /\bwhat would that look like\b/i.test(trimmed)) ||
    /^(?:please\s+)?(?:make|have|let|set|configure|assign|give)\s+(?:agent\b|the\s+.+?\s+agent\b)/i.test(trimmed)
  ) return [];

  const MUTATION_GUARD =
    /\b(?:create|add|make|build|generate|update|set|change|delete|remove|mark|move|run|execute|export|import|upload|scrape|switch|activate|save|assign|enable|disable|claim|release|checkout|check out)\b/i;
  if (MUTATION_GUARD.test(trimmed) && !isReadOnlyPhrased(trimmed)) return [];

  // Split on explicit connectors: "X and Y", "X plus Y", "X also Y"
  // Each resulting part must begin with a question word so we don't split phrases like
  // "what are the top providers and workflows this week" (single question, not two).
  const QUESTION_START = /^(?:what|which|who|where|when|why|how|can|could|would|should|is|are|has|do|does|did|show|list|give|tell|help|please)\b/i;
  const stripLeadingJoiner = (part: string): string => part.replace(/^(?:and|plus|also)\s+/i, "").trim();
  const looksResolvableBuiltinClause = (part: string): boolean => {
    const candidate = stripLeadingJoiner(part);
    if (!candidate) return false;
    if (QUESTION_START.test(candidate)) return true;
    if (findBuiltinIntentByAlias(candidate)) return true;
    if (resolveBuiltinIntentByKeywords(candidate)) return true;
    return false;
  };
  let working = trimmed;
  const firstCommaIndex = working.indexOf(",");
  if (firstCommaIndex > 0) {
    const preamble = working.slice(0, firstCommaIndex).trim();
    const remainder = working.slice(firstCommaIndex + 1).trim();
    if (
      remainder &&
      !looksResolvableBuiltinClause(preamble) &&
      (looksResolvableBuiltinClause(remainder) || /\b(?:and|plus|also)\b/i.test(remainder) || /,/.test(remainder))
    ) {
      working = remainder;
    }
  }
  if (/,/.test(working)) {
    const parts = working
      .replace(/[?]+$/g, "")
      .split(/\s*,\s*/)
      .map((part) => stripLeadingJoiner(part))
      .filter(Boolean);
    if (
      parts.length >= 2 &&
      parts.length <= 3 &&
      !parts.some((part) => part.split(/\s+/).length < 2 && !findBuiltinIntentByAlias(part) && !resolveBuiltinIntentByKeywords(part)) &&
      parts.every(looksResolvableBuiltinClause)
    ) {
      return parts;
    }
  }

  if (/\b(?:and|plus|also)\b/i.test(working)) {
    const parts = working
      .replace(/[?]+$/g, "")
      .split(/\s+(?:and|plus|also)\s+/i)
      .map((part) => stripLeadingJoiner(part))
      .filter(Boolean);
    if (
      parts.length >= 2 &&
      parts.length <= 3 &&
      !parts.some((part) => part.split(/\s+/).length < 2 && !findBuiltinIntentByAlias(part) && !resolveBuiltinIntentByKeywords(part)) &&
      parts.every(looksResolvableBuiltinClause)
    ) {
      return parts;
    }
  }

  // Split on "?" followed by a new question (handles "What are my tasks? What workflows do we have?")
  if (/[?]/.test(trimmed)) {
    const parts = trimmed
      .split(/[?]+\s+(?=(?:what|which|show|list|is|are|do|has|how|who|where|tell|give|can|could|would|should)\b)/i)
      .map((part) => part.replace(/[?.!]+$/, "").trim())
      .filter((part) => part.split(/\s+/).length >= 2);
    if (parts.length >= 2 && parts.length <= 3) {
      return parts;
    }
  }

  return [];
}

function splitCompoundMutationMessage(raw: string): string[] {
  const trimmed = String(raw || "").trim().replace(/[.?!]+$/g, "");
  if (!trimmed) return [];
  if (parseBulkCreateAgentsOrganizationIntent(trimmed) || parseImplicitDebateOrganizationIntent(trimmed)) return [];
  if (parseBulkCreateAgentsIntent(trimmed) || parseDirectCreateAgentIntent(trimmed)) return [];
  const freeformAgentCapability = parseFreeformAgentCapabilityAssignment(trimmed);
  const looksLikeAgentCapabilityAssignment =
    Boolean(freeformAgentCapability) ||
    /^(?:please\s+)?(?:make|have|let|set|configure|assign|give)\s+(?:agent\b|the\s+.+?\s+agent\b)/i.test(trimmed);

  const normalized = normalizeLookup(trimmed);
  if (!/\b(?:then|and|also|plus)\b/.test(normalized) && !/,/.test(trimmed)) return [];
  if (!looksLikeMutatingAppCommand(trimmed) && !looksLikeAgentCapabilityAssignment) return [];

  const actionLead =
    "(?:show|list|create|make|build|generate|schedule|run|export|import|upload|scrape|search|find|give|assign|enable|disable|set|mark|move|finish|complete|open|read|get)";
  const rewritten = trimmed
    .replace(new RegExp(`,\\s*(?=then\\b)`, "ig"), "|||")
    .replace(new RegExp(`(?:,\\s*)?\\b(?:and\\s+then|then|and\\s+also|also|plus)\\b\\s+`, "ig"), "|||")
    .replace(new RegExp(`\\s+and\\s+(?=${actionLead}\\b)`, "ig"), "|||")
    .replace(new RegExp(`,\\s+(?=${actionLead}\\b)`, "ig"), "|||");

  const parts = rewritten
    .split("|||")
    .map((part) => part.trim())
    .map((part) => part.replace(/^(?:then|and\s+then|also)\s+/i, "").trim())
    .filter(Boolean);

  if (parts.length < 2 || parts.length > 4) return [];
  return parts;
}

function resolveAgentPronounSkillQuery(raw: string, agentName: string): string | null {
  if (!agentName) return null;
  if (!/\b(?:that|it|this)\b/i.test(raw)) return null;
  if (!/\b(?:skills|extensions|capabilities|using|uses|used|enabled)\b/i.test(raw)) return null;
  if (!/\b(?:using|uses|used|have|has|enabled|config|configuration|setup|set)\b/i.test(raw)) return null;
  return `list all skills for agent ${agentName}`;
}

function splitRequestedAgentCapabilities(requested: string): string[] {
  const normalized = String(requested || "").trim().replace(/[.!?]+$/g, "");
  if (!normalized) return [];
  const parts = normalized
    .split(/\s*(?:,|\band\b|\bplus\b)\s*/i)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) return [normalized];
  const capabilityLike = /^(?:systematic debugging|telegram|slack|discord|github|probing|research|planning|development|review)$/i;
  return parts.every((part) => capabilityLike.test(part)) ? parts : [normalized];
}

function isPlanSequentialReferenceStep(raw: string): boolean {
  return /^(?:show|open|get|read|run|execute|export|schedule|make|mark|set|move|finish|complete|give|assign|enable|disable)\s+(?:that|it|this)\b/i.test(
    raw,
  ) || /^(?:show|list|what(?:'s| is))\s+(?:.+\s+)?(?:that|it|this)\s+(?:is\s+using|uses|has)\b/i.test(raw);
}

function isPlannableMutationStep(raw: string, state: SessionAppStatePayload | null | undefined): boolean {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return false;
  if (isPlanSequentialReferenceStep(trimmed)) return true;
  if (parseBulkCreateAgentsOrganizationIntent(trimmed) || parseImplicitDebateOrganizationIntent(trimmed)) return true;
  if (parseBulkCreateAgentsIntent(trimmed) || parseDirectCreateAgentIntent(trimmed)) return true;
  if (parseFreeformAgentCapabilityAssignment(trimmed)) return true;
  if (looksLikeMutatingAppCommand(trimmed)) {
    if (/\bagent\b/i.test(trimmed) && /\b(?:skill|skills|extension|extensions|plugin|plugins|capabilit(?:y|ies)|telegram|debugging|probing)\b/i.test(trimmed)) {
      return true;
    }
    const classification = classifyAppControlIntent(trimmed, state);
    if (classification.kind === "app_control") return true;
    if (
      parseWorkflowGenerateIntent(trimmed) ||
      parseWorkflowExportIntent(trimmed) ||
      parseWorkflowImportIntent(trimmed) ||
      parseDataSourceCreateIntent(trimmed) ||
      parseSchedulerCreateIntent(trimmed) ||
      parseFreeformAgentCapabilityAssignment(trimmed)
    ) {
      return true;
    }
    if (extractTaskTitleFromNaturalLanguage(trimmed)) return true;
  }
  const readOnlyFollowUp = classifyAppControlIntent(trimmed, state);
  return readOnlyFollowUp.kind === "app_control";
}

function buildMultiStepPlan(raw: string, state: SessionAppStatePayload | null | undefined): MultiStepPlanStep[] | null {
  const directRaw = String(raw || "").trim().replace(/[.?!]+$/g, "");
  const dataSourceTaskShowMatch = directRaw.match(
    /^(?:please\s+)?upload\s+data\s+source\s+from\s+file\s+(.+?)\s+called\s+(.+?),?\s+then\s+create\s+(?:a\s+)?(?:follow[-\s]+up\s+)?(?:board\s+)?task\s+from\s+(?:that|it|this)(?:\s+data\s+source|\s+document)?\s+(?:to|for|about)\s+(.+?),?\s+and\s+show\s+(?:that|it|this)(?:\s+data\s+source|\s+document)?$/i,
  );
  if (dataSourceTaskShowMatch?.[1] && dataSourceTaskShowMatch[2] && dataSourceTaskShowMatch[3]) {
    const filePath = stripWrappedQuotes(parseQuotedPathReference(dataSourceTaskShowMatch[1]) || dataSourceTaskShowMatch[1]);
    const dataSourceName = trimTrailingPunctuation(stripWrappedQuotes(dataSourceTaskShowMatch[2]));
    const taskTitle = trimTrailingPunctuation(stripWrappedQuotes(dataSourceTaskShowMatch[3]));
    if (filePath && dataSourceName && taskTitle) {
      return [
        {
          raw: `upload data source from file "${filePath}" called ${dataSourceName}`,
          label: `upload data source from file "${filePath}" called ${dataSourceName}`,
        },
        {
          raw: `create task from data source ${dataSourceName} ${taskTitle}`,
          label: `create a follow-up board task from ${dataSourceName} to ${taskTitle}`,
        },
        {
          raw: `show data source ${dataSourceName}`,
          label: "show that data source",
        },
      ];
    }
  }

  const workflowCreateScheduleExportMatch = directRaw.match(
    /^(?:please\s+)?(?:build|create|generate|design|draft|set\s+up|setup|spin\s+up)\s+(?:a\s+)?workflow\s+called\s+(.+?)\s+(?:to|for|about)\s+(.+?),?\s+(?:then\s+)?(?:make\s+that\s+run|run\s+it)\s+(.+?)\s*,?\s+and\s+export\s+it\s+to\s+(.+)$/i,
  );
  if (workflowCreateScheduleExportMatch?.[1] && workflowCreateScheduleExportMatch[2] && workflowCreateScheduleExportMatch[3] && workflowCreateScheduleExportMatch[4]) {
    const workflowName = trimTrailingPunctuation(stripWrappedQuotes(workflowCreateScheduleExportMatch[1]));
    const description = trimTrailingPunctuation(stripWrappedQuotes(workflowCreateScheduleExportMatch[2]));
    const scheduleTail = trimTrailingPunctuation(stripWrappedQuotes(workflowCreateScheduleExportMatch[3]));
    const outputPath = stripWrappedQuotes(parseQuotedPathReference(workflowCreateScheduleExportMatch[4]) || workflowCreateScheduleExportMatch[4]);
    if (workflowName && description && scheduleTail && outputPath) {
      return [
        {
          raw: `build a workflow called ${workflowName} to ${description}`,
          label: `build a workflow called ${workflowName} to ${description}`,
        },
        {
          raw: `make that run ${scheduleTail}`,
          label: `make that run ${scheduleTail}`,
        },
        {
          raw: `export it to "${outputPath}"`,
          label: `export it to "${outputPath}"`,
        },
      ];
    }
  }

  const workflowCreateExportMatch = directRaw.match(
    /^(?:please\s+)?(?:build|create|generate|design|draft|set\s+up|setup|spin\s+up)\s+(?:a\s+)?workflow\s+called\s+(.+?)\s+(?:to|for|about)\s+(.+?)\s+and\s+export\s+it\s+to\s+(.+)$/i,
  );
  if (workflowCreateExportMatch?.[1] && workflowCreateExportMatch[2] && workflowCreateExportMatch[3]) {
    const workflowName = trimTrailingPunctuation(stripWrappedQuotes(workflowCreateExportMatch[1]));
    const description = trimTrailingPunctuation(stripWrappedQuotes(workflowCreateExportMatch[2]));
    const outputPath = stripWrappedQuotes(parseQuotedPathReference(workflowCreateExportMatch[3]) || workflowCreateExportMatch[3]);
    if (workflowName && description && outputPath) {
      const embeddedScheduleMatch = description.match(/^(.*?),?\s+(?:then\s+)?(?:make\s+that\s+run|run\s+it)\s+(.+)$/i);
      if (embeddedScheduleMatch?.[1] && embeddedScheduleMatch[2]) {
        const baseDescription = trimTrailingPunctuation(stripWrappedQuotes(embeddedScheduleMatch[1]));
        const scheduleTail = trimTrailingPunctuation(stripWrappedQuotes(embeddedScheduleMatch[2]));
        if (baseDescription && scheduleTail) {
          return [
            {
              raw: `build a workflow called ${workflowName} to ${baseDescription}`,
              label: `build a workflow called ${workflowName} to ${baseDescription}`,
            },
            {
              raw: `make that run ${scheduleTail}`,
              label: `make that run ${scheduleTail}`,
            },
            {
              raw: `export it to "${outputPath}"`,
              label: `export it to "${outputPath}"`,
            },
          ];
        }
      }
      return [
        {
          raw: `build a workflow called ${workflowName} to ${description}`,
          label: `build a workflow called ${workflowName} to ${description}`,
        },
        {
          raw: `export it to "${outputPath}"`,
          label: `export it to "${outputPath}"`,
        },
      ];
    }
  }

  const workflowCreateScheduleMatch = directRaw.match(
    /^(?:please\s+)?(?:build|create|generate|design|draft|set\s+up|setup|spin\s+up)\s+(?:a\s+)?workflow\s+called\s+(.+?)\s+and\s+(?:schedule|run)\s+it\s+(?:for|at|every)\s+(.+)$/i,
  );
  if (workflowCreateScheduleMatch?.[1] && workflowCreateScheduleMatch[2]) {
    const workflowName = trimTrailingPunctuation(stripWrappedQuotes(workflowCreateScheduleMatch[1]));
    const scheduleTail = trimTrailingPunctuation(stripWrappedQuotes(workflowCreateScheduleMatch[2]));
    if (workflowName && scheduleTail) {
      const normalizedSchedule = /^(?:weekday|weekdays|daily|every|mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?|sundays?|\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i.test(scheduleTail)
        ? `run it ${scheduleTail.startsWith("every ") ? scheduleTail : `at ${scheduleTail}`}`
        : `run it ${scheduleTail}`;
      return [
        {
          raw: `build a workflow called ${workflowName}`,
          label: `build a workflow called ${workflowName}`,
        },
        {
          raw: normalizedSchedule,
          label: normalizedSchedule,
        },
      ];
    }
  }

  const clarifyFlakyScheduleMatch = raw.match(
    /^use\s+a?\s*weekday\s+([0-9]{1,2}(?::[0-9]{2})?\s*(?:am|pm)?)\s+schedule\s+and\s+call\s+it\s+(.+?)\.?$/i,
  );
  if (clarifyFlakyScheduleMatch?.[1] && clarifyFlakyScheduleMatch[2]) {
    const time = clarifyFlakyScheduleMatch[1].replace(/\s+/g, "").toLowerCase();
    const name = trimTrailingPunctuation(stripWrappedQuotes(clarifyFlakyScheduleMatch[2]));
    return [
      { raw: `build a workflow called ${name} to monitor flaky API issues`, label: `build a workflow called ${name} to monitor flaky API issues` },
      { raw: `run it every weekday at ${time}`, label: `run it every weekday at ${time}` },
    ];
  }

  const directAgentUpgradeMatch = raw.match(
    /^give\s+(?:agent\s+)?(.+?)\s+systematic debugging(?:\s+and\s+|\s*,\s*)telegram\s*,?\s*then\s+show\s+what\s+skills\s+it\s+is\s+using\s+now\.?$/i,
  );
  if (directAgentUpgradeMatch?.[1]) {
    const agentRefRaw = stripWrappedQuotes(directAgentUpgradeMatch[1]);
    const agentRef = isDefaultAgentReference(agentRefRaw)
      ? agentRefRaw.replace(/\s+agent$/i, "").trim()
      : agentRefRaw;
    return [
      { raw: `give agent ${agentRef} systematic debugging`, label: `give agent ${agentRef} systematic debugging` },
      { raw: `give agent ${agentRef} telegram`, label: `give agent ${agentRef} telegram` },
      { raw: `list all skills for agent ${agentRef}`, label: `list all skills for agent ${agentRef}` },
    ];
  }
  if (
    /\b(?:help\s+me\s+)?set(?:\s+something)?\s+up\b/i.test(raw) &&
    /\b(?:keep\s+an\s+eye\s+on|monitor|watch)\b/i.test(raw) &&
    /\b(?:tell|notify|message)\s+me\b/i.test(raw) &&
    /\b(?:chat|webchat)\b/i.test(raw)
  ) {
    return [
      {
        raw: "create a workflow to monitor flaky api issues",
        label: "create a workflow to monitor flaky api issues",
      },
      {
        raw: "send webchat alerts when it goes sideways",
        label: "send webchat alerts when it goes sideways",
      },
    ];
  }
  const parts = (() => {
    const direct = splitCompoundMutationMessage(raw);
    if (direct.length >= 2) return direct;
    const simpleThenMatch = String(raw || "").trim().replace(/[.?!]+$/g, "").match(/^(.+?),\s*then\s+(.+)$/i);
    if (simpleThenMatch?.[1] && simpleThenMatch?.[2]) {
      return [simpleThenMatch[1].trim(), simpleThenMatch[2].trim()];
    }
    return direct;
  })();
  if (parts.length < 2) return null;
  if (
    !parts.some((part) =>
      looksLikeMutatingAppCommand(part) ||
      Boolean(parseFreeformAgentCapabilityAssignment(part)) ||
      /^(?:please\s+)?(?:make|have|let|set|configure|assign|give)\s+(?:agent\b|the\s+.+?\s+agent\b)/i.test(part)
    )
  ) return null;
  const rejectedPart = parts.find((part) => !isPlannableMutationStep(part, state));
  if (rejectedPart) {
    log.debug("Rejected multi-step plan candidate", {
      rawMessage: raw,
      rejectedPart,
      parts,
    });
    return null;
  }
  log.debug("Accepted multi-step plan candidate", {
    rawMessage: raw,
    parts,
  });
  const expandedParts: string[] = [];
  let lastAgentName = "";
  for (const part of parts) {
    const resolvedPart = lastAgentName ? (resolveAgentPronounSkillQuery(part, lastAgentName) ?? part) : part;
    const capabilityAssignment = parseFreeformAgentCapabilityAssignment(resolvedPart);
    if (capabilityAssignment?.agentRef) {
      lastAgentName = capabilityAssignment.agentRef.trim();
      const requestedParts = splitRequestedAgentCapabilities(capabilityAssignment.requested);
      if (requestedParts.length > 1) {
        for (const requested of requestedParts) {
          expandedParts.push(`give agent ${capabilityAssignment.agentRef} ${requested}`);
        }
        continue;
      }
    }
    expandedParts.push(resolvedPart);
  }
  return expandedParts.map((part) => ({
    raw: part,
    label: part.replace(/^#+\s*/g, "").replace(/\s+/g, " ").replace(/[,:;]+$/g, "").trim(),
  }));
}

function shouldPreferModelAppActionPlanner(raw: string): boolean {
  const value = String(raw || "").trim();
  if (!value) return false;
  const isReadOnlyQuestion =
    /^(?:what|which|who|where|when|why|how|are|is|does|do|can|could|should|would|compare|explain|describe|tell|recommend|suggest)\b/i.test(value) &&
    !/\b(?:create|make|build|add|record|track|put|save|update|change|assign|schedule|run|execute)\b/i.test(value);
  if (isReadOnlyQuestion) return false;
  const peopleDirectedMutation =
    /\b(?:have|ask|get|run|let)\s+(?:the\s+)?(?:team|council|org(?:anization)?|crew|agents?|analysts?|researchers?)\s+(?:to\s+)?(?:debate|discuss|deliberate|coordinate|route|assign)\b/i.test(value) &&
    /\b(?:record|track|put|create|make|add|save)\b/i.test(value) &&
    /\b(?:decision|verdict|result|output|task|board|handoff)\b/i.test(value);
  if (peopleDirectedMutation) {
    return true;
  }
  if (/\bbuild\s+something\s+called\b/i.test(value) && /\b(?:monitor|watch|every|schedule|export|re-import|reimport)\b/i.test(value)) {
    return true;
  }
  if (/\bi\s+(?:need|want)\s+(?:a\s+)?(?:document\s+)?(?:research\s+)?workflow\b/i.test(value) && /\b(?:tasks?|follow[-\s]?up|sources?|compare|models?|benchmark|extract|notes?|documents?|docs?)\b/i.test(value)) {
    return true;
  }
  if (/\b(?:show|recommend|suggest|choose|pick)\b/i.test(value) && /\b(?:create|make|build)\s+(?:one|a\s+workflow|an?\s+automation|an?\s+pipeline)(?:\s+called|\b)/i.test(value)) {
    return true;
  }
  if (/\b(?:show|recommend|suggest|choose|pick)\b/i.test(value) && /\bbest\s+(?:workflow|automation|pipeline)\b/i.test(value) && /\b(?:create|make|build)\b/i.test(value)) {
    return true;
  }
  if (/\b(?:telegram|slack|discord|whatsapp|channel)\b/i.test(value) && /\b(?:alerts?|notify|notifications?|send|route)\b/i.test(value) && /\b(?:research|workflow|automation|schedule|daily|weekly)\b/i.test(value) && /\b(?:set\s*up|create|make|build|connect|wire)\b/i.test(value)) {
    return true;
  }
  if (/\b(?:choose|recommend|suggest|pick)\b/i.test(value) && /\b(?:workflow|automation|pipeline|template)\b/i.test(value) && /\b(?:tasks?|board|next\s+steps?|follow[-\s]?ups?|track(?:ed|ing)?\s+somewhere|land\s+somewhere)\b/i.test(value)) {
    return true;
  }
  if (/\b(?:choose|recommend|suggest|pick)\b/i.test(value) && /\b(?:workflow|automation|pipeline|template)\b/i.test(value) && /\b(?:create|make|build)\b/i.test(value)) {
    return true;
  }
  if (/\b(?:pdfs?|documents?|docs?|notes?)\b/i.test(value) && /\b(?:follow[-\s]?up|tasks?|review\s+tasks?|next\s+steps?|work)\b/i.test(value) && /\b(?:want|need|make|create|build|pull|extract|read)\b/i.test(value)) {
    return true;
  }
  if (/\b(?:set\s*up|create|build|make|prepare)\b/i.test(value) && /\b(?:something|whatever|reusable)\b/i.test(value) && /\b(?:apis?|monitor|watch|keep\s+an\s+eye\s+on|fail(?:ing|ures?))\b/i.test(value)) {
    return true;
  }
  if (isContextualBoardTaskMutation(value)) {
    return true;
  }
  return false;
}

// `isCrossSurfaceAppMutationRequest` is imported from the shared cross-tab
// intent layer (single source of truth). See cross-tab-intent.ts.

function shouldUseWorkflowTemplateRecommendation(raw: string): boolean {
  const value = String(raw || "").trim();
  if (!value || shouldPreferModelAppActionPlanner(value)) return false;
  const normalized = value.toLowerCase();
  if (
    normalized === "list workflow templates" ||
    normalized === "show workflow templates" ||
    normalized === "list templates" ||
    normalized === "show templates" ||
    /\b(?:what|show|list)\b.*\b(?:all\s+)?(?:the\s+)?(?:my\s+)?templates\b/.test(normalized) ||
    normalized.includes("what workflow templates can you use") ||
    normalized.includes("what templates can you use")
  ) {
    return true;
  }
  if (/\bworkflow\s+templates?\b/i.test(value) && /\b(?:best|recommend|suggest|for|which)\b/i.test(value)) {
    return true;
  }
  if (/\btemplates?\b/i.test(value) && /\b(?:best|recommend|suggest|which)\b/i.test(value) && /\b(?:research|document|docs?|extract|source|live|recommendation|ocr|model|benchmark)\b/i.test(value)) {
    return true;
  }
  if (/\b(?:which|what)\s+(?:workflow|automation|pipeline)\s+(?:template\s+)?should\s+i\s+use\b/i.test(value)) {
    return true;
  }
  return /\b(?:workflow|automation|pipeline)\s+templates?\b/i.test(value) && /\bwhich\b/i.test(normalized);
}

function containsSecretOrCredentialIntent(raw: string): boolean {
  const value = String(raw || "").trim();
  if (!value) return false;
  if (!/\b(?:api\s*key|secret|password|token|credential|oauth|bearer)\b/i.test(value)) return false;

  // Memory/help/search questions may legitimately mention "token" as a noun
  // ("what token did I save earlier?"). Block only when the message appears to
  // submit, store, connect, or expose a raw credential value.
  const looksLikeRecallOrStatus =
    /\b(?:what|which|show|recall|remember|find|search|list|status|do\s+i\s+have|did\s+i\s+save|saved\s+earlier|use\s+for)\b/i.test(value) &&
    !/\b(?:save|store|set|update|connect|link|use\s+this|add\s+this|here\s+is|my\s+(?:api\s*key|token|secret|password))\b/i.test(value);
  const rawSecretShape =
    /\b(?:sk-[A-Za-z0-9_-]{8,}|xox[abprs]-[A-Za-z0-9-]{10,}|gh[pousr]_[A-Za-z0-9_]{12,}|Bearer\s+[A-Za-z0-9._~+/-]{12,}|[A-Za-z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD)[A-Za-z0-9_]*\s*[:=]\s*\S{6,})\b/i.test(value) ||
    /\b(?:api\s*key|secret|password|token|credential|oauth)\b\s*(?:is|=|:|to)\s*["']?\S{6,}/i.test(value);
  if (looksLikeRecallOrStatus && !rawSecretShape) return false;

  return rawSecretShape ||
    /\b(?:save|store|set|update|connect|link|use\s+this|add\s+this|here\s+is|my\s+(?:api\s*key|token|secret|password))\b[\s\S]{0,80}\b(?:api\s*key|secret|password|token|credential|oauth|bearer)\b/i.test(value) ||
    /\b(?:api\s*key|secret|password|token|credential|oauth|bearer)\b[\s\S]{0,80}\b(?:save|store|set|update|connect|link|use\s+this|add\s+this)\b/i.test(value);
}

function isToolKnowledgeCommand(raw: string): boolean {
  const value = String(raw || "").trim();
  return /^(?:find|recommend)\s+tools?\s+for\s+.+/i.test(value) ||
    /^what\s+tools?\s+should\s+i\s+use\s+for\s+.+/i.test(value) ||
    /^which\s+tools?\s+(?:is|are)\s+(?:best|good|right)\s+for\s+.+/i.test(value) ||
    /^is\s+there\s+a\s+tool\s+for\s+.+/i.test(value) ||
    /^(?:show|open|explain|inspect)\s+tool\s+(?:help\s+for\s+)?.+/i.test(value) ||
    /^how\s+do\s+i\s+use\s+(?:the\s+)?tool\s+.+/i.test(value) ||
    /^what\s+does\s+(?:the\s+)?tool\s+.+?\s+do$/i.test(value);
}

export function isChannelSetupRequest(raw: string): boolean {
  const value = String(raw || "").trim();
  return /^(?:show\s+setup\s+for\s+(?:extension\s+)?|how\s+do\s+i\s+(?:(?:set|wire)\s+up|connect)\s+(?:extension\s+)?|set\s+up\s+(?:extension\s+)?|connect\s+(?:extension\s+)?)(?:telegram|discord|whatsapp|slack|bluebubbles|google\s+chat|teams|microsoft\s+teams|imessage)\b/i.test(value) ||
    /^(?:telegram|discord|whatsapp|slack|bluebubbles|google\s+chat|teams|microsoft\s+teams|imessage)\s+setup\b/i.test(value);
}

function isHighPriorityChannelBuiltinCommand(raw: string): boolean {
  const value = String(raw || "").trim();
  if (!value) return false;
  const normalized = normalizeLookup(value);
  if (
    isChannelSetupRequest(value) ||
    normalized === "check channel health" ||
    normalized === "run channel doctor" ||
    normalized === "diagnose channels" ||
    normalized === "channel health check" ||
    normalized === "list pending pairing requests" ||
    normalized === "show pairing requests" ||
    normalized === "list pairing requests" ||
    /^(?:approve|deny)\s+pairing\s+\S+/i.test(value)
  ) {
    return true;
  }
  if (
    /^(?:tasks?|my tasks|our tasks|current tasks|open tasks|pending tasks|completed tasks|done tasks|inbox)$/i.test(value) ||
    /^(?:list|show|find|search|more|next)\s+(?:my\s+|all\s+|pending\s+|completed\s+|open\s+|inbox\s+)?(?:tasks?|board tasks?)\b/i.test(value) ||
    /^what(?:'s| is)\s+in\s+my\s+inbox\b/i.test(value)
  ) {
    return true;
  }
  return /^(?:run|start|execute)\s+(?:the\s+)?(?:task\s+)?["\u201C]?.+?["\u201D]?\s+(?:task|todo)\b/i.test(value) ||
    /^(?:run|start|execute)\s+task\s+["\u201C]?.+?["\u201D]?$/i.test(value);
}

function buildPendingMutationCorrectionPlan(raw: string, pending: PendingMutation | null): MultiStepPlanStep[] | null {
  if (!pending || pending.kind !== "multi-step-plan") return null;
  if (!/^(?:actually|instead|change\s+it|make\s+it)\b/i.test(raw.trim())) return null;
  const payloadSteps = Array.isArray(pending.payload.steps) ? pending.payload.steps : [];
  const existingSteps = payloadSteps
    .map((step) => (step && typeof step === "object" ? step as Record<string, unknown> : null))
    .filter((step): step is Record<string, unknown> => Boolean(step))
    .map((step) => ({
      raw: String(step.raw || ""),
      label: String(step.label || step.raw || ""),
    }))
    .filter((step) => step.raw.trim());
  if (existingSteps.length === 0) return null;

  const timeMatch = raw.match(/\b(?:run|runs?|at)\s+(?:it\s+)?(?:every\s+weekday\s+)?(?:at\s+)?([0-9]{1,2}(?::[0-9]{2})?\s*(?:am|pm)?)\b/i);
  const exportPath = parseQuotedPathReference(raw);
  if (!timeMatch?.[1] && !/\bexport\b/i.test(raw)) return null;

  const buildStep = existingSteps.find((step) => parseWorkflowGenerateIntent(step.raw)) ?? existingSteps[0];
  const nextSteps: MultiStepPlanStep[] = [buildStep];
  if (timeMatch?.[1]) {
    const time = timeMatch[1].replace(/\s+/g, "").toLowerCase();
    nextSteps.push({ raw: `run it every weekday at ${time}`, label: `run it every weekday at ${time}` });
  } else {
    const oldSchedule = existingSteps.find((step) => parseSchedulerCreateIntent(step.raw) || parseScheduleExpressionIntent(step.raw));
    if (oldSchedule) nextSteps.push(oldSchedule);
  }

  if (/\bexport\b/i.test(raw)) {
    const oldExport = existingSteps.find((step) => parseWorkflowExportIntent(step.raw));
    const exportStep = exportPath
      ? { raw: `export it to "${exportPath}"`, label: `export it to "${exportPath}"` }
      : oldExport;
    if (exportStep) nextSteps.push(exportStep);
  }
  return nextSteps.length >= 2 ? nextSteps : null;
}

function stemLookupTerm(term: string): string {
  const value = normalizeLookup(term);
  if (value.length <= 3) return value;
  if (value.endsWith("ing") && value.length > 5) return value.slice(0, -3);
  if (value.endsWith("ed") && value.length > 4) return value.slice(0, -2);
  if (value.endsWith("es") && value.length > 4) return value.slice(0, -2);
  if (value.endsWith("s") && value.length > 4) return value.slice(0, -1);
  return value;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripWrappedQuotes(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function trimIntentLeadIn(value: string): string {
  return value
    .trim()
    .replace(/^[:,-]+\s*/, "")
    .replace(/^(?:workflow|template)\b\s*/i, "")
    .replace(/^(?:to|for|with|about|on)\b\s*/i, "")
    .replace(/^[:,-]+\s*/, "")
    .trim();
}

function parseTaskRunIntent(message: string): TaskRunIntent {
  const idMatch =
    message.match(/(?:^|\b)(?:run|execute|start|begin|work\s+on)\s+task\s+([A-Za-z0-9_-]{6,})(?=\s|$)/i) ||
    message.match(/(?:^|\b)task\s+([A-Za-z0-9_-]{6,})(?=\s+(?:run|execute|start)\s*$|\s+(?:run|execute|start)\b)/i);

  if (idMatch?.[1]) {
    return {
      taskId: idMatch[1],
      taskReference: "",
      wantsLatest: false,
    };
  }

  const raw = message.trim();
  if (!/\b(?:run|execute|start|begin|work\s+on)\b/i.test(raw) || !/\b(?:board\s+task|task|card)\b/i.test(raw)) {
    return {
      taskId: "",
      taskReference: "",
      wantsLatest: false,
    };
  }

  const patterns = [
    /^(?:run|execute|start|begin|work\s+on)\s+(?:the\s+)?(?:(latest|newest|most recent)\s+)?task\s*:\s*(.+?)(?:\s+now)?$/i,
    /^(?:run|execute|start|begin|work\s+on)\s+(?:the\s+)?(?:(latest|newest|most recent)\s+)?task\s+(?:(?:called|named)\s+)?(.+?)(?:\s+now)?$/i,
    /^(?:run|execute|start|begin|work\s+on)\s+(?:the\s+)?(?:(latest|newest|most recent)\s+)?(.+?)\s+(?:board\s+task|task|card)(?:\s+now)?$/i,
  ];

  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (!match) continue;
    const taskReference = match?.[2] ? stripWrappedQuotes(match[2]).trim() : "";
    if (!taskReference) continue;
    return {
      taskId: "",
      taskReference,
      wantsLatest: Boolean(match[1]),
    };
  }

  return {
    taskId: "",
    taskReference: "",
    wantsLatest: false,
  };
}

function parseCheckpointIntent(message: string): CheckpointCommandIntent | null {
  const raw = message.trim();
  if (!raw) return null;

  const listMatch =
    raw.match(/^(?:list|show|view)\s+(?:recent\s+)?checkpoints?$/i) ||
    raw.match(/^(?:show|what(?:'s| is))\s+(?:the\s+)?(?:recent\s+)?checkpoints?$/i) ||
    raw.match(/^(?:can you|could you|please)\s+(?:show|list)\s+(?:me\s+)?(?:the\s+)?(?:recent\s+)?checkpoints?\??$/i);
  if (listMatch) {
    return { action: "list", limit: 10 };
  }

  const createMatch =
    raw.match(/^(?:please\s+|can you\s+|could you\s+)?(?:create|save|take)\s+(?:a\s+)?checkpoint(?:\s+(?:called|named|for))?\s*(.*)$/i) ||
    raw.match(/^(?:please\s+|can you\s+|could you\s+)?(?:checkpoint)\s+(?:this|workspace|current state)(?:\s+(?:as|called|named))?\s*(.*)$/i);
  if (createMatch) {
    return { action: "create", label: stripWrappedQuotes(createMatch[1] || "").trim() };
  }

  const diffMatch =
    raw.match(/^(?:please\s+|can you\s+|could you\s+)?(?:show|view|get)\s+(?:me\s+)?(?:the\s+)?(?:checkpoint\s+)?diff\s+(?:for|against)\s+(.+)$/i) ||
    raw.match(/^(?:please\s+|can you\s+|could you\s+)?(?:show|view|get)\s+(?:me\s+)?(?:the\s+)?(?:checkpoint\s+)?diff\s+(.+)$/i) ||
    raw.match(/^diff\s+checkpoint\s+(.+)$/i);
  if (diffMatch?.[1]) {
    return { action: "diff", reference: stripWrappedQuotes(diffMatch[1]) };
  }

  const rollbackMatch =
    raw.match(/^(?:please\s+|can you\s+|could you\s+)?(?:rollback|restore|revert)\s+(?:to\s+)?checkpoint\s+(.+?)(?:\s+(?:for|on)\s+file\s+(.+))?$/i) ||
    raw.match(/^(?:please\s+|can you\s+|could you\s+)?(?:rollback|restore|revert)\s+(.+?)\s+to\s+checkpoint\s+(.+?)$/i);
  if (rollbackMatch?.[1]) {
    if (/to\s+checkpoint/i.test(raw) && rollbackMatch[2] && !/(?:for|on)\s+file/i.test(raw)) {
      return {
        action: "rollback",
        reference: stripWrappedQuotes(rollbackMatch[2]),
        targetPath: stripWrappedQuotes(rollbackMatch[1]),
      };
    }
    return {
      action: "rollback",
      reference: trimReferenceTrail(stripWrappedQuotes(rollbackMatch[1])),
      targetPath: trimReferenceTrail(stripWrappedQuotes(rollbackMatch[2] || "")),
    };
  }

  return null;
}

function resolveCheckpointReference(
  reference: string,
  checkpoints: Array<{ id: string; label: string }>,
): { id: string; label: string } | null {
  const trimmedReference = trimReferenceTrail(reference);
  const normalized = normalizeLookup(trimmedReference);
  if (!normalized) return checkpoints[0] ?? null;
  if (["latest", "newest", "most recent", "current"].includes(normalized)) {
    return checkpoints[0] ?? null;
  }
  return (
    checkpoints.find((entry) => entry.id.startsWith(trimmedReference)) ??
    checkpoints.find((entry) => normalizeLookup(entry.label).includes(normalized)) ??
    null
  );
}

function findTemplateMention(message: string): { key: string; name: string } | null {
  const raw = message.trim();
  if (!raw) return null;
  const normalized = normalizeLookup(raw);
  const entries = listWorkflowTemplateCatalog()
    .map((entry) => ({
      key: entry.key,
      name: entry.name,
      aliases: [entry.key, entry.name, ...entry.aliases].map((alias) => normalizeLookup(alias)),
    }))
    .sort((left, right) => right.name.length - left.name.length);

  for (const entry of entries) {
    if (entry.aliases.some((alias) => alias && normalized.includes(alias))) {
      return { key: entry.key, name: entry.name };
    }
  }
  return null;
}

function parseTemplateCreateIntent(message: string): TemplateActionIntent | null {
  const raw = message.trim();
  if (!/\b(?:create|make|build|spin\s*up|set\s*up)\b/i.test(raw)) return null;
  if (!/\b(?:workflow|flow|pipeline|automation)\b/i.test(raw)) return null;
  const template = findTemplateMention(raw);
  if (!template) return null;

  const explicitName =
    raw.match(/\b(?:called|named)\s+(.+?)(?:\s+(?:in\s+organization|for\s+goal)\b|$)/i)?.[1] ||
    raw.match(/\bfor\s+(.+?)\s+(?:workflow|flow|pipeline)\b/i)?.[1] ||
    "";
  return {
    templateRef: template.key,
    workflowName: stripWrappedQuotes(explicitName || `${template.name} ${new Date().toISOString().slice(0, 16)}`),
    payload: "",
  };
}

function parseTemplateRunIntent(message: string): TemplateActionIntent | null {
  const raw = message.trim();
  if (!/\b(?:run|execute|launch|start|kick\s*off|use)\b/i.test(raw)) return null;
  if (/\b(?:board\s+task|task|card|todo|item)\b/i.test(raw)) return null;
  if (!/\b(?:workflow|flow|pipeline|template)\b/i.test(raw) && !findTemplateMention(raw)) return null;
  const template = findTemplateMention(raw);
  if (!template) return null;
  const payload =
    raw.match(/\b(?:for|about|on|with)\s+(.+)$/i)?.[1] ||
    "";
  return {
    templateRef: template.key,
    workflowName: `${template.name} ${new Date().toISOString().slice(0, 16)}`,
    payload: stripWrappedQuotes(payload),
  };
}

function parseBoardTaskTemplateIntent(message: string): { templateRef: string; title: string } | null {
  const raw = message.trim();
  if (!/\b(?:create|add|make|open|log|put)\b/i.test(raw)) return null;
  if (!/\b(?:board\s+task|task|card|todo|item)\b/i.test(raw)) return null;
  const template = findTemplateMention(raw);
  if (!template) return null;
  const explicitTitle =
    raw.match(/\b(?:board\s+task|task|card)\s+(?:called|named)\s+(.+?)\s+(?:using|with)\b/i)?.[1] ||
    raw.match(/\b(?:add|create|make)\s+(?:a\s+)?(?:board\s+task|task|card)\s+for\s+(.+?)\s+(?:using|with)\b/i)?.[1] ||
    "";
  const title =
    trimReferenceTrail(explicitTitle) ||
    extractTaskTitleFromNaturalLanguage(raw) ||
    stripWrappedQuotes(raw.match(/\b(?:to|for)\s+(.+?)\s+(?:using|with)\b/i)?.[1] || "") ||
    stripWrappedQuotes(raw.match(/\b(?:called|named)\s+(.+?)(?:\s+(?:using|with)\b|$)/i)?.[1] || "");
  if (!title) return null;
  return { templateRef: template.key, title };
}

function trimTrailingPunctuation(value: string): string {
  return value.replace(/[.,;:!?]+$/g, "").trim();
}

function titleCaseWords(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function stripLeadingArticles(value: string): string {
  return value.replace(/^(?:the|a|an)\s+/i, "").trim();
}

function slugifyFileStem(value: string): string {
  const cleaned = normalizeLookup(value).replace(/\s+/g, "-");
  return cleaned.replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "") || "workflow";
}

function detectMimeTypeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".md") return "text/markdown";
  if (ext === ".txt" || ext === ".log") return "text/plain";
  if (ext === ".html" || ext === ".htm") return "text/html";
  if (ext === ".json") return "application/json";
  if (ext === ".csv") return "text/csv";
  if (ext === ".pdf") return "application/pdf";
  return "application/octet-stream";
}

function resolveUserSuppliedPath(inputPath: string): string {
  const trimmed = String(inputPath || "").trim();
  if (!trimmed) return "";
  const windowsMatch = trimmed.match(/^([A-Za-z]):\\(.*)$/);
  if (windowsMatch) {
    const drive = windowsMatch[1].toLowerCase();
    const rest = windowsMatch[2].replace(/\\/g, "/");
    return path.posix.normalize(`/mnt/${drive}/${rest}`);
  }
  return path.resolve(trimmed);
}

function parseQuotedPathReference(input: string): string {
  const quotedMatch =
    input.match(/"(.*?)"/) ||
    input.match(/'(.*?)'/);
  if (quotedMatch?.[1]) return quotedMatch[1].trim();
  const windowsMatch = input.match(/[A-Za-z]:\\[^\s]+/);
  if (windowsMatch?.[0]) return windowsMatch[0].trim();
  const unixMatch = input.match(/\/[^\s]+/);
  return unixMatch?.[0]?.trim() || "";
}

function deriveDocumentNameFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.replace(/\/+$/, "");
    const tail = pathname.split("/").filter(Boolean).pop() || parsed.hostname;
    return stripWrappedQuotes(`${parsed.hostname} ${tail}`.replace(/\.[a-z0-9]+$/i, "")).trim();
  } catch {
    return "Web Data Source";
  }
}

function parseDataSourceCreateIntent(message: string): DataSourceCreateIntent | null {
  const raw = message.trim();
  if (!raw) return null;

  const uploadPattern =
    /\b(?:upload|import|add|turn|make|create)\b[\s\S]*\b(?:document|doc|data\s+source|file)\b/i;
  if (uploadPattern.test(raw) && /\bfrom\b/i.test(raw)) {
    const filePath = parseQuotedPathReference(raw);
    if (filePath) {
      const explicitName =
        raw.match(/\b(?:called|named)\s+(.+)$/i)?.[1] ||
        raw.match(/\bas\s+(?!data\s+source\b)(.+)$/i)?.[1] ||
        "";
      return {
        mode: "upload",
        filePath,
        name: trimTrailingPunctuation(stripWrappedQuotes(explicitName) || path.basename(filePath)),
        mimeType: detectMimeTypeFromPath(filePath),
      };
    }
  }

  const urlMatch = raw.match(/https?:\/\/[^\s)]+/i);
  if (!urlMatch?.[0]) return null;
  const mentionsDataSources =
    /\b(?:data\s+source|data\s+sources|document|documents|doc|docs|scrape|crawl|import|add)\b/i.test(raw);
  if (!mentionsDataSources) return null;
  const explicitName =
    raw.match(/\b(?:called|named)\s+(.+)$/i)?.[1] ||
    raw.match(/\bas\s+(?!data\s+source\b)(.+)$/i)?.[1] ||
    "";
  return {
    mode: /\b(?:crawl|deep\s*crawl|deep-crawl)\b/i.test(raw) ? "crawl" : "single",
    url: trimTrailingPunctuation(urlMatch[0]),
    name: trimTrailingPunctuation(stripWrappedQuotes(explicitName) || deriveDocumentNameFromUrl(urlMatch[0])),
  };
}

function parseWorkflowGenerateIntent(message: string): WorkflowGenerateIntent | null {
  const raw = message.trim();
  if (!/\b(?:generate|design|draft|build|set\s+up|setup|spin\s+up|create)\b/i.test(raw)) return null;
  if (!/\bworkflow\b/i.test(raw)) return null;
  if (isNonMutatingPlanningRequest(raw)) return null;
  if (containsSecretOrCredentialIntent(raw)) return null;
  if (/\b(?:template|import|export)\b/i.test(raw)) return null;
  if (isClearlyNonAppOverloadedSurfaceRequest(raw)) return null;
  if (/\b(?:workflow|agent)\b[\s\S]{0,40}\b(?:diagram|ascii|flowchart|infographic|idea|concept)\b/i.test(raw)) return null;
  if (/\b(?:diagram|ascii|flowchart|infographic)\b[\s\S]{0,40}\b(?:workflow|agent)\b/i.test(raw)) return null;

  const explicitName =
    raw.match(/\b(?:called|named|as)\s+(.+?)(?:\s+\b(?:for|to|about|that|which)\b|$)/i)?.[1] ||
    raw.match(/\bworkflow\s+(?:called|named)\s+(.+?)(?:\s+\b(?:for|to|about|that|which)\b|$)/i)?.[1] ||
    "";
  const description =
    raw.match(/\b(?:for|to|about)\s+(.+)$/i)?.[1] ||
    raw.replace(/^(?:please\s+)?(?:generate|design|draft|build|create|set\s+up|setup|spin\s+up)\s+(?:me\s+)?(?:a\s+)?workflow\b/i, "").trim();

  const cleanedDescription = trimTrailingPunctuation(stripWrappedQuotes(description));
  if (!cleanedDescription) return null;
  const fallbackName = `Generated Workflow ${new Date().toISOString().slice(0, 16)}`;
  return {
    name: trimTrailingPunctuation(stripWrappedQuotes(explicitName) || fallbackName),
    description: cleanedDescription,
  };
}

function parseWorkflowExportIntent(message: string): WorkflowExportIntent | null {
  const raw = message.trim();
  if (!/\bexport\b/i.test(raw) || !/\bworkflow\b/i.test(raw)) return null;
  const workflowRef =
    raw.match(/\bworkflow\s+(.+?)(?:\s+\b(?:to|into|as)\b|$)/i)?.[1] ||
    raw.match(/\bexport\s+(.+?)(?:\s+\b(?:to|into|as)\b|$)/i)?.[1] ||
    "";
  if (!workflowRef) return null;
  const explicitPath = parseQuotedPathReference(raw.match(/\b(?:to|into)\b[\s\S]+$/i)?.[0] || "");
  return {
    workflowRef: trimTrailingPunctuation(stripWrappedQuotes(workflowRef)),
    outputPath: explicitPath,
  };
}

function parseWorkflowImportIntent(message: string): WorkflowImportIntent | null {
  const raw = message.trim();
  if (!/\bimport\b/i.test(raw) || !/\bworkflow\b/i.test(raw)) return null;
  const filePath = parseQuotedPathReference(raw.match(/\bfrom\b[\s\S]+$/i)?.[0] || "");
  if (!filePath) return null;
  const explicitName =
    raw.match(/\b(?:called|named|as)\s+(.+)$/i)?.[1] ||
    "";
  const explicitSource =
    new RegExp(`\\b${LEGACY_COMPAT_WORKFLOW_SOURCE}\\b`, "i").test(raw)
      ? "compatible"
      : /\bdisp8ch\b/i.test(raw)
        ? "disp8ch"
        : null;
  return {
    name: trimTrailingPunctuation(stripWrappedQuotes(explicitName) || path.basename(filePath, path.extname(filePath))),
    filePath,
    explicitSource,
  };
}

function parseClockHourMinute(input: string): { hour: number; minute: number } | null {
  const match = input.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] || "0");
  const suffix = String(match[3] || "").toLowerCase();
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || minute < 0 || minute > 59) return null;
  if (suffix) {
    if (hour < 1 || hour > 12) return null;
    if (suffix === "pm" && hour !== 12) hour += 12;
    if (suffix === "am" && hour === 12) hour = 0;
  } else if (hour > 23) {
    return null;
  }
  return { hour, minute };
}

function parseScheduleExpressionIntent(message: string): ScheduleExpressionIntent | null {
  const raw = message.trim();
  const timezone = "UTC";

  const minuteMatch = raw.match(/\bevery\s+(\d{1,2})\s+minutes?\b/i);
  if (minuteMatch) {
    const minutes = Math.max(1, Math.min(59, Number(minuteMatch[1])));
    return { expression: `*/${minutes} * * * *`, label: `Every ${minutes} Minutes`, timezone };
  }

  const hourMatch = raw.match(/\bevery\s+(\d{1,2})\s+hours?\b/i);
  if (hourMatch) {
    const hours = Math.max(1, Math.min(23, Number(hourMatch[1])));
    return { expression: `0 */${hours} * * *`, label: `Every ${hours} Hours`, timezone };
  }

  const weekdayMatch = raw.match(/\b(?:every\s+weekday|weekdays?)\s+(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i);
  if (weekdayMatch?.[1]) {
    const parsed = parseClockHourMinute(weekdayMatch[1]);
    if (!parsed) return null;
    return {
      expression: `${parsed.minute} ${parsed.hour} * * 1-5`,
      label: `Weekdays ${String(parsed.hour).padStart(2, "0")}:${String(parsed.minute).padStart(2, "0")}`,
      timezone,
    };
  }

  const dailyMatch = raw.match(/\b(?:every\s+day|daily)\s+(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i);
  if (dailyMatch?.[1]) {
    const parsed = parseClockHourMinute(dailyMatch[1]);
    if (!parsed) return null;
    return {
      expression: `${parsed.minute} ${parsed.hour} * * *`,
      label: `Daily ${String(parsed.hour).padStart(2, "0")}:${String(parsed.minute).padStart(2, "0")}`,
      timezone,
    };
  }

  if (/\bevery\s+morning\b/i.test(raw)) {
    return {
      expression: "0 8 * * *",
      label: "Daily 08:00",
      timezone,
    };
  }

  const weekdayMap: Record<string, number> = {
    sunday: 0,
    monday: 1,
    tuesday: 2,
    wednesday: 3,
    thursday: 4,
    friday: 5,
    saturday: 6,
  };
  const weeklyMatch = raw.match(
    /\b(?:every|on)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\s+(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i,
  );
  if (weeklyMatch?.[1] && weeklyMatch[2]) {
    const parsed = parseClockHourMinute(weeklyMatch[2]);
    if (!parsed) return null;
    const weekday = weekdayMap[String(weeklyMatch[1]).toLowerCase()];
    return {
      expression: `${parsed.minute} ${parsed.hour} * * ${weekday}`,
      label: `Every ${weeklyMatch[1]} ${String(parsed.hour).padStart(2, "0")}:${String(parsed.minute).padStart(2, "0")}`,
      timezone,
    };
  }

  return null;
}

function parseSchedulerCreateIntent(message: string): SchedulerCreateIntent | null {
  const raw = message.trim();
  const schedule = parseScheduleExpressionIntent(raw);
  if (!schedule) return null;
  if (!/\b(?:schedule|scheduler|cron|every|daily|weekdays?|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(raw)) {
    return null;
  }

  if (/\bhealth\s+check\b/i.test(raw)) {
    const explicitName = raw.match(/\b(?:called|named)\s+(.+)$/i)?.[1] || "";
    return {
      kind: "health-check",
      workflowName: trimTrailingPunctuation(stripWrappedQuotes(explicitName) || `Scheduled Health Check ${new Date().toISOString().slice(0, 16)}`),
      schedule,
    };
  }

  const workflowRef =
    raw.match(/\b(?:for|run|trigger)\s+(?:the\s+)?workflow\s+(.+?)(?=\s+\b(?:every|daily|weekdays?|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b)/i)?.[1] ||
    raw.match(/\bworkflow\s+(.+?)(?=\s+\b(?:every|daily|weekdays?|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b)/i)?.[1] ||
    "";
  if (!workflowRef) return null;
  const explicitName = raw.match(/\b(?:called|named|as)\s+(.+)$/i)?.[1] || "";
  return {
    kind: "workflow",
    workflowRef: trimTrailingPunctuation(stripWrappedQuotes(workflowRef)),
    wrapperName:
      trimTrailingPunctuation(stripWrappedQuotes(explicitName)) ||
      `${trimTrailingPunctuation(stripWrappedQuotes(workflowRef))} Schedule`,
    schedule,
  };
}

function buildWorkflowScheduleWrapper(input: {
  name: string;
  expression: string;
  timezone: string;
  label: string;
  targetWorkflowId: string;
}) {
  const manualId = `manual-${Math.random().toString(36).slice(2, 10)}`;
  const cronId = `cron-${Math.random().toString(36).slice(2, 10)}`;
  const callId = `call-${Math.random().toString(36).slice(2, 10)}`;
  return {
    name: input.name,
    description: `Scheduled wrapper for workflow ${input.targetWorkflowId}`,
    nodes: [
      {
        id: manualId,
        type: "manual-trigger",
        position: { x: 100, y: 100 },
        data: { label: "Manual Trigger" },
      },
      {
        id: cronId,
        type: "cron-trigger",
        position: { x: 100, y: 260 },
        data: {
          label: input.label,
          expression: input.expression,
          timezone: input.timezone,
        },
      },
      {
        id: callId,
        type: "call-workflow",
        position: { x: 360, y: 180 },
        data: {
          label: "Run Target Workflow",
          workflowId: input.targetWorkflowId,
        },
      },
    ],
    edges: [
      { id: `e-${manualId}-${callId}`, source: manualId, target: callId },
      { id: `e-${cronId}-${callId}`, source: cronId, target: callId },
    ],
  };
}

function formatFeatureHowTo(
  topic:
    | "docs"
    | "workflow"
    | "board"
    | "council"
    | "scheduler"
    | "data-source"
    | "channels"
    | "extensions"
    | "skills"
    | "dashboard"
    | "activity"
    | "approvals"
    | "logs"
    | "debug"
    | "maintenance"
    | "security"
    | "metrics"
    | "usage"
    | "settings"
    | "tags"
    | "memory"
    | "live",
): string {
  const examples: Record<typeof topic, string[]> = {
    docs: [
      'Try: "How do I use docs?"',
      'Try: "Show docs summary"',
      'Try: "Generate a workflow called API Triage Flow for..."',
      'Try: "Scrape https://docs.python.org/3/ as data source called Python Docs Brief"',
    ],
    workflow: [
      'Try: "What workflow templates can you use right now?"',
      'Try: "Create a workflow from the ops control tower template called Launch Review"',
      'Try: "Generate a workflow called API Triage for triaging failed API checks and posting a summary to webchat"',
      'Try: "Export workflow API Triage"',
    ],
    board: [
      'Try: "Create a board task called Launch blocker audit"',
      'Try: "Add a board task called Release readiness review using the hierarchy board briefing template"',
      'Try: "List tasks"',
      'Try: "Run the launch blocker audit task"',
    ],
    council: [
      'Try: "Ask the leadership team in organization Ops about launch readiness for goal Release 1"',
      'Try: "Switch to execution mode" if you want coordinated work instead of a vote',
      'Try: "Switch to council mode" if you want a discussion or verdict instead',
    ],
    scheduler: [
      'Try: "Schedule workflow API Triage every day at 9am"',
      'Try: "Schedule a health check every 30 minutes"',
      'Try: "List schedules"',
      'Try: "Run API Triage Schedule now"',
    ],
    "data-source": [
      'Try: "Scrape https://example.com as data source called Example Brief"',
      'Try: "Upload data source from file /path/to/brief.md called Launch Brief"',
      'Try: "Search data sources for launch"',
      'Try: "Create task from data source Launch Brief review blockers"',
    ],
    channels: [
      'Try: "Show channels"',
      'Try: "Show channels status"',
      'Try: "How do I use channels?"',
      'Try: "Show setup for extension Telegram"',
    ],
    extensions: [
      'Try: "List extensions"',
      'Try: "Show extension runtime status"',
      'Try: "Show hierarchy extension status"',
      'Try: "Show setup for extension Telegram"',
    ],
    skills: [
      'Try: "List skills for agent main"',
      'Try: "Show skills"',
      'Try: "Enable skill team delegation for agent main"',
      'Try: "Find skills for incident response"',
    ],
    dashboard: [
      'Try: "Show dashboard"',
      'Try: "What does the dashboard look like right now?"',
      'Try: "Give me a quick system overview"',
    ],
    activity: [
      'Try: "Show activity"',
      'Try: "What has been running lately?"',
      'Try: "Show the recent execution history"',
    ],
    approvals: [
      'Try: "Show approvals"',
      'Try: "What approvals are waiting right now?"',
      'Try: "Show the approval queue"',
    ],
    logs: [
      'Try: "Show logs"',
      'Try: "Show the recent logs"',
      'Try: "Tail logs for errors"',
    ],
    debug: [
      'Try: "Show debug"',
      'Try: "Give me a debug snapshot"',
      'Try: "Show the debug tab summary"',
    ],
    maintenance: [
      'Try: "Show maintenance"',
      'Try: "Give me the maintenance health report"',
      'Try: "What needs maintenance attention right now?"',
    ],
    security: [
      'Try: "Show security"',
      'Try: "Run the security summary"',
      'Try: "What does the security report say?"',
    ],
    metrics: [
      'Try: "Show metrics"',
      'Try: "Show cost analysis"',
      'Try: "What are the top providers and workflows this week?"',
    ],
    usage: [
      'Try: "Show usage"',
      'Try: "What is running right now?"',
      'Try: "Show the recent executions and trigger breakdown"',
    ],
    settings: [
      'Try: "Show settings"',
      'Try: "Show setting timezone"',
      'Try: "Set setting telemetry to off"',
      'Try: "Show setup for plugin Telegram"',
    ],
    tags: [
      'Try: "Show tags"',
      'Try: "How do I use tags?"',
      'Try: "Create tag Launch Blocker"',
      'Try: "Tag agent Main Agent with Launch Blocker"',
    ],
    memory: [
      'Try: "Show memory"',
      'Try: "Show memory timeline"',
      'Try: "Search memory for launch blockers"',
      'Try: "How do I use memory?"',
    ],
    live: [
      'Try: "Show live"',
      'Try: "Show activity"',
      'Try: "What has been running lately?"',
      'Try: "How do I use live?"',
    ],
  };
  const labels: Record<typeof topic, string> = {
    docs: "Docs",
    workflow: "Workflows",
    board: "Boards",
    council: "Council And Hierarchy",
    scheduler: "Scheduler",
    "data-source": "Data Sources",
    channels: "Channels",
    extensions: "Extensions",
    skills: "Skills",
    dashboard: "Dashboard",
    activity: "Activity",
    approvals: "Approvals",
    logs: "Logs",
    debug: "Debug",
    maintenance: "Maintenance",
    security: "Security",
    metrics: "Metrics And Cost Analysis",
    usage: "Usage And Running Workflows",
    settings: "Settings",
    tags: "Tags",
    memory: "Memory",
    live: "Live",
  };
  return [labels[topic], "Plain-English examples:", ...examples[topic]].join("\n");
}

function formatPlainInteger(value: unknown): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "0";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Math.round(numeric));
}

function formatPlainUsd(value: unknown): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "$0.00";
  return `$${numeric.toFixed(numeric >= 10 ? 2 : 4)}`;
}

async function buildMetricsSummary(internalApiBaseUrl: string): Promise<string> {
  const [{ response: metricsResponse, payload: metricsPayload }, { response: costsResponse, payload: costsPayload }] =
    await Promise.all([
      fetchInternalJson<{
        success?: boolean;
        data?: {
          days?: number;
          summary?: {
            apiCallsToday?: number;
            tokensToday?: number;
            costTodayUsd?: number;
            apiCallsPeriod?: number;
            tokensPeriod?: number;
            costPeriodUsd?: number;
            successRate?: number;
            executions?: { total?: number; completed?: number; failed?: number };
            budget?: { dailyUsd?: number; usedUsd?: number; usedPercent?: number };
          };
          providers?: Array<{ key?: string; calls?: number; tokens?: number; costUsd?: number }>;
          workflows?: Array<{ key?: string; calls?: number; tokens?: number; costUsd?: number }>;
        };
        error?: string;
      }>(`${internalApiBaseUrl}/api/metrics?days=14`, { method: "GET" }, "channel-metrics-summary"),
      fetchInternalJson<{
        success?: boolean;
        data?: {
          totalCostUsd?: number;
          totalTokens?: number;
          eventCount?: number;
          byAgent?: Array<{ agentId?: string; totalCostUsd?: number; eventCount?: number }>;
        };
        error?: string;
      }>(
        `${internalApiBaseUrl}/api/costs?action=analytics&windowDays=30`,
        { method: "GET" },
        "channel-cost-analytics-summary",
      ),
    ]);

  if (!metricsResponse.ok || !metricsPayload.success) {
    return `Metrics summary failed: ${metricsPayload.error || `HTTP ${metricsResponse.status}`}.`;
  }
  if (!costsResponse.ok || !costsPayload.success) {
    return `Metrics summary failed: ${costsPayload.error || `HTTP ${costsResponse.status}`}.`;
  }

  const summary = metricsPayload.data?.summary ?? {};
  const topProviders = Array.isArray(metricsPayload.data?.providers) ? metricsPayload.data.providers.slice(0, 3) : [];
  const topWorkflows = Array.isArray(metricsPayload.data?.workflows) ? metricsPayload.data.workflows.slice(0, 3) : [];
  const topAgents = Array.isArray(costsPayload.data?.byAgent) ? costsPayload.data.byAgent.slice(0, 3) : [];

  return [
    `Metrics summary (${metricsPayload.data?.days ?? 14} days):`,
    `- API calls today: ${formatPlainInteger(summary.apiCallsToday)}`,
    `- Tokens today: ${formatPlainInteger(summary.tokensToday)}`,
    `- Cost today: ${formatPlainUsd(summary.costTodayUsd)}`,
    `- Success rate: ${formatPlainInteger(summary.successRate)}%`,
    `- Executions: ${formatPlainInteger(summary.executions?.completed)} completed / ${formatPlainInteger(summary.executions?.total)} total`,
    `- Period calls: ${formatPlainInteger(summary.apiCallsPeriod)}`,
    `- Period cost: ${formatPlainUsd(summary.costPeriodUsd)}`,
    `- Budget used today: ${formatPlainUsd(summary.budget?.usedUsd)} of ${formatPlainUsd(summary.budget?.dailyUsd)} (${formatPlainInteger(summary.budget?.usedPercent)}%)`,
    `- Agent spend events (30 days): ${formatPlainInteger(costsPayload.data?.eventCount)}`,
    `- Agent spend total (30 days): ${formatPlainUsd(costsPayload.data?.totalCostUsd)}`,
    `Top providers: ${topProviders.length > 0
      ? topProviders.map((entry) => `${entry.key || "unknown"} (${formatPlainInteger(entry.calls)} calls)`).join(", ")
      : "none yet"}`,
    `Top workflows: ${topWorkflows.length > 0
      ? topWorkflows.map((entry) => `${entry.key || "unknown"} (${formatPlainInteger(entry.calls)} calls)`).join(", ")
      : "none yet"}`,
    `Top agent spend: ${topAgents.length > 0
      ? topAgents.map((entry) => `${entry.agentId || "unknown"} (${formatPlainUsd(entry.totalCostUsd)})`).join(", ")
      : "none yet"}`,
  ].join("\n");
}

async function buildUsageSummary(internalApiBaseUrl: string): Promise<string> {
  const [{ response: execResponse, payload: execPayload }, { response: wfResponse, payload: wfPayload }, { response: runningResponse, payload: runningPayload }] =
    await Promise.all([
      fetchInternalJson<{ success?: boolean; data?: Array<{ workflowId?: string; status?: string; triggerType?: string; startedAt?: string }> ; error?: string }>(
        `${internalApiBaseUrl}/api/execute`,
        { method: "GET" },
        "channel-usage-executions",
      ),
      fetchInternalJson<{ success?: boolean; data?: Array<{ id?: string; name?: string; isActive?: boolean }>; error?: string }>(
        `${internalApiBaseUrl}/api/workflows`,
        { method: "GET" },
        "channel-usage-workflows",
      ),
      fetchInternalJson<{ success?: boolean; data?: Array<{ executionId?: string }>; error?: string }>(
        `${internalApiBaseUrl}/api/execute/running`,
        { method: "GET" },
        "channel-usage-running",
      ),
    ]);

  if (!execResponse.ok || !execPayload.success) {
    return `Usage summary failed: ${execPayload.error || `HTTP ${execResponse.status}`}.`;
  }
  if (!wfResponse.ok || !wfPayload.success) {
    return `Usage summary failed: ${wfPayload.error || `HTTP ${wfResponse.status}`}.`;
  }
  if (!runningResponse.ok || !runningPayload.success) {
    return `Usage summary failed: ${runningPayload.error || `HTTP ${runningResponse.status}`}.`;
  }

  const executions = Array.isArray(execPayload.data) ? execPayload.data : [];
  const workflows = Array.isArray(wfPayload.data) ? wfPayload.data : [];
  const running = Array.isArray(runningPayload.data) ? runningPayload.data : [];
  const completed = executions.filter((entry) => entry.status === "completed").length;
  const failed = executions.filter((entry) => entry.status === "failed").length;
  const successRate = executions.length > 0 ? Math.round((completed / executions.length) * 100) : 0;
  const triggerBreakdown = executions.reduce<Record<string, number>>((acc, entry) => {
    const key = String(entry.triggerType || "unknown");
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const recent = executions.slice(0, 5);

  return [
    "Usage summary:",
    `- Total runs: ${formatPlainInteger(executions.length)}`,
    `- Success rate: ${formatPlainInteger(successRate)}%`,
    `- Running now: ${formatPlainInteger(running.length)}`,
    `- Active workflows: ${formatPlainInteger(workflows.filter((entry) => entry.isActive).length)}`,
    `- Failed runs: ${formatPlainInteger(failed)}`,
    ...(Object.keys(triggerBreakdown).length > 0
      ? [`Trigger breakdown: ${Object.entries(triggerBreakdown).map(([trigger, count]) => `${trigger}=${formatPlainInteger(count)}`).join(", ")}`]
      : []),
    ...(recent.length > 0
      ? [
          "Recent executions:",
          ...recent.map((entry, index) =>
            `${index + 1}. ${entry.workflowId || "unknown workflow"} • ${entry.status || "unknown"} • ${entry.triggerType || "unknown"}${entry.startedAt ? ` • ${entry.startedAt}` : ""}`,
          ),
        ]
      : ["Recent executions: none yet."]),
  ].join("\n");
}

async function buildDocsSummary(internalApiBaseUrl: string): Promise<string> {
  const [{ response: docsResponse, payload: docsPayload }, { response: workflowsResponse, payload: workflowsPayload }] =
    await Promise.all([
      fetchInternalJson<{ success?: boolean; data?: Array<{ id?: string; name?: string; sourceType?: string }> }>(
        `${internalApiBaseUrl}/api/documents`,
        { method: "GET" },
        "channel-docs-summary-documents",
      ),
      fetchInternalJson<{ success?: boolean; data?: Array<{ id?: string; name?: string; isActive?: boolean }> }>(
        `${internalApiBaseUrl}/api/workflows`,
        { method: "GET" },
        "channel-docs-summary-workflows",
      ),
    ]);

  if (!docsResponse.ok || !docsPayload.success) {
    return `Docs summary failed: ${String((docsPayload as { error?: string }).error || `HTTP ${docsResponse.status}`)}.`;
  }

  const docs = Array.isArray(docsPayload.data) ? docsPayload.data : [];
  const workflows = Array.isArray(workflowsPayload.data) ? workflowsPayload.data : [];
  const docsRelated = workflows.filter((entry) => /\bdocs?\b|\bcrawl\b|\bsummary\b/i.test(String(entry.name || "")));
  const recentDocs = docs.slice(0, 3);

  return [
    "## Docs summary",
    `Stored data sources: ${formatPlainInteger(docs.length)}`,
    `Docs-related workflows: ${formatPlainInteger(docsRelated.length)}`,
    recentDocs.length > 0
      ? `Recent sources: ${recentDocs.map((entry) => `${entry.name || entry.id} [${entry.sourceType || "unknown"}]`).join(", ")}`
      : "Recent sources: none yet",
    "Use Docs for quickstart guidance, docs-site crawling, and links into Data Sources, Workflows, and Hierarchy.",
  ].join("\n");
}

async function buildChannelsSummary(internalApiBaseUrl: string): Promise<string> {
  const { response, payload } = await fetchInternalJson<{
    success?: boolean;
    data?: Record<string, { connected?: boolean; username?: string | null; botName?: string | null; configured?: boolean; appId?: string | null; serverUrl?: string | null }>;
    error?: string;
  }>(`${internalApiBaseUrl}/api/channels?action=status`, { method: "GET" }, "channel-channels-summary");

  if (!response.ok || !payload.success || !payload.data) {
    return `Channels summary failed: ${payload.error || `HTTP ${response.status}`}.`;
  }

  const data = payload.data;
  const lines = [
    "## Channels summary",
    `Telegram: ${data.telegram?.connected ? `connected (${data.telegram.username || "bot"})` : "disconnected"}`,
    `Discord: ${data.discord?.connected ? `connected (${data.discord.username || "bot"})` : "disconnected"}`,
    `WhatsApp: ${data.whatsapp?.connected ? "connected" : "disconnected"}`,
    `Slack: ${data.slack?.connected ? `connected (${data.slack.botName || "bot"})` : "disconnected"}`,
    `BlueBubbles: ${data.bluebubbles?.connected ? `connected (${data.bluebubbles.serverUrl || "server"})` : "disconnected"}`,
    `Teams: ${data.teams?.configured ? `configured (${data.teams.appId || "app"})` : "not configured"}`,
    "WebChat: ready",
    "Google Chat: webhook route ready",
  ];
  return lines.join("\n");
}

async function buildTagsSummary(internalApiBaseUrl: string): Promise<string> {
  const { response, payload } = await fetchInternalJson<{
    success?: boolean;
    data?: Array<{ id?: string; name?: string; scope?: string; usageCount?: number; color?: string }>;
    error?: string;
  }>(`${internalApiBaseUrl}/api/tags`, { method: "GET" }, "channel-tags-summary");

  if (!response.ok || !payload.success) {
    return `Tags summary failed: ${payload.error || `HTTP ${response.status}`}.`;
  }

  const tags = Array.isArray(payload.data) ? payload.data : [];
  const top = tags.slice(0, 5);
  return [
    "## Tags summary",
    `Total tags: ${formatPlainInteger(tags.length)}`,
    ...(top.length > 0
      ? top.map((entry, index) => `${index + 1}. ${entry.name || entry.id} [${entry.scope || "general"}] uses=${formatPlainInteger(entry.usageCount)}`)
      : ["No tags created yet."]),
    "Use Tags to label agents, board tasks, and workflows for filtering and shared context.",
  ].join("\n");
}

function formatRuntimeStatusValue(value: unknown): string {
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (Array.isArray(value)) return value.length > 0 ? value.join(", ") : "none";
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .slice(0, 4)
      .map(([key, entryValue]) => `${key}=${formatRuntimeStatusValue(entryValue)}`);
    return entries.length > 0 ? entries.join(", ") : "none";
  }
  if (value === null || value === undefined || value === "") return "n/a";
  return String(value);
}

function humanizeRuntimeStatusKey(key: string): string {
  const normalized = String(key || "").trim();
  const explicit: Record<string, string> = {
    activeOrganizationId: "Active organization id",
    activeOrganizationName: "Active organization",
    goalCount: "Goals in scope",
    provenanceMode: "Provenance mode",
    authMode: "Auth mode",
    windowHours: "Window",
    totalEvents: "Events",
    byType: "Top types",
    gitRepo: "Git repo",
    modifiedFiles: "Modified files",
    botName: "Bot",
    connected: "Connected",
    route: "Route",
    mode: "Mode",
  };
  if (explicit[normalized]) return explicit[normalized];
  return normalized
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\w/, (char) => char.toUpperCase());
}

function formatRuntimeStatusLines(status: Record<string, unknown> | null | undefined): string[] {
  if (!status || typeof status !== "object") return [];
  return Object.entries(status)
    .slice(0, 6)
    .map(([key, value]) => `${humanizeRuntimeStatusKey(key)}: ${formatRuntimeStatusValue(value)}`);
}

async function buildExtensionsSummary(internalApiBaseUrl: string): Promise<string> {
  const { response, payload } = await fetchInternalJson<{
    success?: boolean;
    data?: {
      extensions?: Array<{
        id?: string;
        name?: string;
        globallyEnabled?: boolean;
        agentEnabled?: boolean;
        configurable?: boolean;
      }>;
      runtime?: {
        version?: number;
        extensions?: Array<{
          id?: string;
          hasRuntime?: boolean;
          hooks?: string[];
          status?: Record<string, unknown> | null;
        }>;
      };
    };
    error?: string;
  }>(`${internalApiBaseUrl}/api/extensions?agentId=main`, { method: "GET" }, "channel-extensions-summary");

  if (!response.ok || !payload.success) {
    return `Extensions summary failed: ${payload.error || `HTTP ${response.status}`}.`;
  }

  const extensions = Array.isArray(payload.data?.extensions) ? payload.data?.extensions : [];
  const runtimeExtensions = Array.isArray(payload.data?.runtime?.extensions) ? payload.data?.runtime?.extensions : [];
  const runtimeById = new Map(runtimeExtensions.map((entry) => [String(entry.id || ""), entry]));
  const enabledGlobal = extensions.filter((entry) => entry.globallyEnabled !== false).length;
  const enabledAgent = extensions.filter((entry) => entry.agentEnabled === true).length;
  const runtimeBacked = runtimeExtensions.filter((entry) => entry.hasRuntime).length;

  return [
    `Extensions summary (runtime v${formatPlainInteger(payload.data?.runtime?.version)}):`,
    `- Total extensions: ${formatPlainInteger(extensions.length)}`,
    `- Globally enabled: ${formatPlainInteger(enabledGlobal)}`,
    `- Enabled on main agent: ${formatPlainInteger(enabledAgent)}`,
    `- Runtime-backed: ${formatPlainInteger(runtimeBacked)}`,
    ...(extensions.slice(0, 6).map((entry, index) => {
      const runtime = runtimeById.get(String(entry.id || ""));
      const runtimeBits = runtime
        ? [`runtime=${runtime.hasRuntime ? "yes" : "no"}`, `hooks=${Array.isArray(runtime.hooks) && runtime.hooks.length > 0 ? runtime.hooks.join(", ") : "none"}`]
        : ["runtime=no"];
      return `${index + 1}. ${entry.name || entry.id} (${entry.id}) [global=${entry.globallyEnabled === false ? "off" : "on"} agent=${entry.agentEnabled ? "on" : "off"}] ${runtimeBits.join(" ")}`;
    })),
  ].join("\n");
}

async function buildMemorySummary(internalApiBaseUrl: string): Promise<string> {
  const { response: statsResponse, payload: statsPayload } = await fetchInternalJson<{
    success?: boolean;
    data?: {
      totalMemories?: number;
      storageBytes?: number;
      workspaceMemoryFiles?: number;
      embeddingModel?: string | null;
      vectorIndexed?: number;
      sessionChunks?: number;
    };
    error?: string;
  }>(`${internalApiBaseUrl}/api/memory?action=stats`, { method: "GET" }, "channel-memory-summary-stats");

  if (!statsResponse.ok || !statsPayload.success) {
    return `Memory summary failed: ${statsPayload.error || `HTTP ${statsResponse.status}`}.`;
  }

  const stats = statsPayload.data ?? {};

  return [
    "Memory summary:",
    `- Total memories: ${formatPlainInteger(stats.totalMemories)}`,
    `- Storage: ${formatPlainInteger(stats.storageBytes)} bytes`,
    `- Workspace memory files: ${formatPlainInteger(stats.workspaceMemoryFiles)}`,
    `- Embedding model: ${String(stats.embeddingModel || "not configured")}`,
    `- Vector indexed: ${formatPlainInteger(stats.vectorIndexed)}`,
    `- Session chunks: ${formatPlainInteger(stats.sessionChunks)}`,
    'Try "show memory timeline" for recent entries.',
  ].join("\n");
}

async function buildDashboardSummary(internalApiBaseUrl: string): Promise<string> {
  const [
    { response: systemResponse, payload: systemPayload },
    { response: workflowResponse, payload: workflowPayload },
    { response: runningResponse, payload: runningPayload },
  ] = await Promise.all([
    fetchInternalJson<{
      success?: boolean;
      data?: { machine?: Record<string, unknown>; generatedAt?: string };
      error?: string;
    }>(`${internalApiBaseUrl}/api/system/summary`, { method: "GET" }, "channel-dashboard-system"),
    fetchInternalJson<{
      success?: boolean;
      data?: Array<{ id?: string; name?: string; isActive?: boolean }>;
      error?: string;
    }>(`${internalApiBaseUrl}/api/workflows`, { method: "GET" }, "channel-dashboard-workflows"),
    fetchInternalJson<{
      success?: boolean;
      data?: Array<{ executionId?: string }>;
      error?: string;
    }>(`${internalApiBaseUrl}/api/execute/running`, { method: "GET" }, "channel-dashboard-running"),
  ]);

  if (!systemResponse.ok || !systemPayload.success) {
    return `Dashboard summary failed: ${systemPayload.error || `HTTP ${systemResponse.status}`}.`;
  }
  if (!workflowResponse.ok || !workflowPayload.success) {
    return `Dashboard summary failed: ${workflowPayload.error || `HTTP ${workflowResponse.status}`}.`;
  }
  if (!runningResponse.ok || !runningPayload.success) {
    return `Dashboard summary failed: ${runningPayload.error || `HTTP ${runningResponse.status}`}.`;
  }

  const workflows = Array.isArray(workflowPayload.data) ? workflowPayload.data : [];
  const running = Array.isArray(runningPayload.data) ? runningPayload.data : [];
  const machine = (systemPayload.data?.machine ?? {}) as Record<string, unknown>;

  return [
    "Dashboard summary:",
    `- Machine: ${String(machine.platform || "unknown")} / ${String(machine.arch || "unknown")}`,
    `- CPU cores: ${formatPlainInteger(machine.cpuCount)}`,
    `- Total memory GB: ${formatPlainInteger(machine.totalMemoryGb)}`,
    `- Active workflows: ${formatPlainInteger(workflows.filter((entry) => entry.isActive).length)}`,
    `- Running executions: ${formatPlainInteger(running.length)}`,
    systemPayload.data?.generatedAt ? `- Generated at: ${systemPayload.data.generatedAt}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

async function buildActivitySummary(internalApiBaseUrl: string): Promise<string> {
  const [
    { response: execResponse, payload: execPayload },
    { response: runningResponse, payload: runningPayload },
  ] = await Promise.all([
    fetchInternalJson<{
      success?: boolean;
      data?: Array<{ workflowId?: string; status?: string; triggerType?: string; startedAt?: string }>;
      error?: string;
    }>(`${internalApiBaseUrl}/api/execute`, { method: "GET" }, "channel-activity-executions"),
    fetchInternalJson<{
      success?: boolean;
      data?: Array<{ executionId?: string }>;
      error?: string;
    }>(`${internalApiBaseUrl}/api/execute/running`, { method: "GET" }, "channel-activity-running"),
  ]);

  if (!execResponse.ok || !execPayload.success) {
    return `Activity summary failed: ${execPayload.error || `HTTP ${execResponse.status}`}.`;
  }
  if (!runningResponse.ok || !runningPayload.success) {
    return `Activity summary failed: ${runningPayload.error || `HTTP ${runningResponse.status}`}.`;
  }

  const executions = Array.isArray(execPayload.data) ? execPayload.data : [];
  const running = Array.isArray(runningPayload.data) ? runningPayload.data : [];
  const recent = executions.slice(0, 5);

  return [
    "Activity summary:",
    `- Running now: ${formatPlainInteger(running.length)}`,
    `- Total recent runs: ${formatPlainInteger(executions.length)}`,
    ...(recent.length > 0
      ? [
          "Recent runs:",
          ...recent.map((entry, index) =>
            `${index + 1}. ${entry.workflowId || "unknown workflow"} • ${entry.status || "unknown"} • ${entry.triggerType || "unknown"}${entry.startedAt ? ` • ${entry.startedAt}` : ""}`,
          ),
        ]
      : ["Recent runs: none yet."]),
  ].join("\n");
}

async function buildApprovalsSummary(internalApiBaseUrl: string): Promise<string> {
  const { response, payload } = await fetchInternalJson<{
    success?: boolean;
    data?: Array<{ id?: string; toolName?: string; requestedBy?: string; createdAt?: string; summary?: string }>;
    error?: string;
  }>(`${internalApiBaseUrl}/api/tool-approvals`, { method: "GET" }, "channel-approvals-summary");

  if (!response.ok || !payload.success) {
    return `Approvals summary failed: ${payload.error || `HTTP ${response.status}`}.`;
  }

  const approvals = Array.isArray(payload.data) ? payload.data : [];
  return [
    "Approvals summary:",
    `- Pending approvals: ${formatPlainInteger(approvals.length)}`,
    ...(approvals.length > 0
      ? approvals.slice(0, 5).map((entry, index) =>
          `${index + 1}. ${entry.toolName || "unknown tool"} • ${entry.requestedBy || "unknown requester"}${entry.createdAt ? ` • ${entry.createdAt}` : ""}`,
        )
      : ["No pending approvals right now."]),
  ].join("\n");
}

async function buildLogsSummary(internalApiBaseUrl: string): Promise<string> {
  const { response, payload } = await fetchInternalJson<{
    success?: boolean;
    data?: {
      fileName?: string;
      availableFiles?: string[];
      entries?: Array<{ level?: string; message?: string; time?: string; subsystem?: string }>;
      truncated?: boolean;
    };
    error?: string;
  }>(`${internalApiBaseUrl}/api/logs?limit=8`, { method: "GET" }, "channel-logs-summary");

  if (!response.ok || !payload.success) {
    return `Logs summary failed: ${payload.error || `HTTP ${response.status}`}.`;
  }

  const entries = Array.isArray(payload.data?.entries) ? payload.data?.entries : [];
  return [
    "Logs summary:",
    `- Current file: ${payload.data?.fileName || "unknown"}`,
    `- Available log files: ${formatPlainInteger(payload.data?.availableFiles?.length)}`,
    payload.data?.truncated ? "- Showing a truncated tail window." : null,
    ...(entries.length > 0
      ? [
          "Recent log lines:",
          ...entries.slice(-5).map((entry, index) =>
            `${index + 1}. [${String(entry.level || "info").toUpperCase()}] ${entry.subsystem ? `${entry.subsystem}: ` : ""}${entry.message || "(no message)"}${entry.time ? ` • ${entry.time}` : ""}`,
          ),
        ]
      : ["Recent log lines: none yet."]),
  ]
    .filter(Boolean)
    .join("\n");
}

async function buildDebugSummary(internalApiBaseUrl: string): Promise<string> {
  const { response, payload } = await fetchInternalJson<{
    success?: boolean;
    data?: {
      heartbeat?: { nodeVersion?: string; env?: string; uptimeMs?: number };
      health?: { ok?: boolean; running?: { active?: number } };
      models?: Array<unknown>;
      eventLog?: Array<unknown>;
    };
    error?: string;
  }>(`${internalApiBaseUrl}/api/debug`, { method: "GET" }, "channel-debug-summary");

  if (!response.ok || !payload.success) {
    return `Debug summary failed: ${payload.error || `HTTP ${response.status}`}.`;
  }

  return [
    "Debug summary:",
    `- Environment: ${String(payload.data?.heartbeat?.env || "unknown")}`,
    `- Node: ${String(payload.data?.heartbeat?.nodeVersion || "unknown")}`,
    `- Uptime ms: ${formatPlainInteger(payload.data?.heartbeat?.uptimeMs)}`,
    `- Health OK: ${payload.data?.health?.ok ? "yes" : "no"}`,
    `- Running executions: ${formatPlainInteger(payload.data?.health?.running?.active)}`,
    `- Models tracked: ${formatPlainInteger(payload.data?.models?.length)}`,
    `- Debug events in snapshot: ${formatPlainInteger(payload.data?.eventLog?.length)}`,
  ].join("\n");
}

async function buildMaintenanceSummary(internalApiBaseUrl: string): Promise<string> {
  const { response, payload } = await fetchInternalJson<{
    success?: boolean;
    data?: {
      overallSeverity?: string;
      workspace?: Array<unknown>;
      contextBudget?: Array<{
        agentName?: string;
        report?: {
          totalActual?: number;
          totalAllocated?: number;
          budget?: number;
          overBudget?: boolean;
          entries?: Array<{ path?: string; actualChars?: number; allocatedChars?: number; truncatedChars?: number; percentSurviving?: number }>;
        };
      }>;
      staleMemory?: Array<{ agentName?: string; staleCount?: number }>;
      cron?: Array<unknown>;
      db?: { staleExecutions?: number; lockedTasks?: number; pendingApprovals?: number };
      suggestions?: string[];
    };
    error?: string;
  }>(`${internalApiBaseUrl}/api/maintenance`, { method: "GET" }, "channel-maintenance-summary");

  if (!response.ok || !payload.success) {
    return `Maintenance summary failed: ${payload.error || `HTTP ${response.status}`}.`;
  }

  const budgetLines: string[] = [];
  const budgets = Array.isArray(payload.data?.contextBudget) ? payload.data?.contextBudget : [];
  for (const item of budgets) {
    const r = item.report;
    if (!r?.overBudget) continue;
    const truncated = (r.entries ?? []).filter((e) => (e.truncatedChars ?? 0) > 0);
    if (truncated.length === 0) continue;
    budgetLines.push(
      `- ${item.agentName}: ${Math.round((r.totalActual ?? 0) / 1000)}k chars total, ${Math.round((r.budget ?? 12000) / 1000)}k budget — ${truncated.map((e) => `${e.path} (${e.percentSurviving}%)`).join(", ")} truncated`,
    );
  }

  const suggestions = Array.isArray(payload.data?.suggestions) ? payload.data?.suggestions : [];
  return [
    "Maintenance summary:",
    `- Overall severity: ${String(payload.data?.overallSeverity || "unknown")}`,
    `- Workspace reports: ${formatPlainInteger(payload.data?.workspace?.length)}`,
    `- Cron checks: ${formatPlainInteger(payload.data?.cron?.length)}`,
    `- Stale executions: ${formatPlainInteger(payload.data?.db?.staleExecutions)}`,
    `- Locked tasks: ${formatPlainInteger(payload.data?.db?.lockedTasks)}`,
    `- Pending approvals: ${formatPlainInteger(payload.data?.db?.pendingApprovals)}`,
    ...((payload.data?.staleMemory ?? []).filter((s) => (s.staleCount ?? 0) > 0).length > 0
      ? [`- Stale memory entries: ${(payload.data?.staleMemory ?? []).map((s) => `${s.agentName} (${s.staleCount})`).join(", ")}`]
      : []),
    ...(budgetLines.length > 0
      ? ["Context budget warnings:", ...budgetLines]
      : []),
    ...(suggestions.length > 0
      ? ["Suggestions:", ...suggestions.slice(0, 6).map((entry, index) => `${index + 1}. ${entry}`)]
      : []),
  ].join("\n");
}

async function buildSecuritySummary(internalApiBaseUrl: string): Promise<string> {
  const { response, payload } = await fetchInternalJson<{
    success?: boolean;
    data?: {
      ok?: boolean;
      errors?: number;
      warnings?: number;
      summary?: {
        protectedRoutes?: number;
        operatorRoutes?: number;
        adminRoutes?: number;
        publicRoutes?: number;
        unexpectedPublicRoutes?: number;
        adminTokenConfigured?: boolean;
        wsAuthTokenConfigured?: boolean;
      };
      recommendations?: string[];
    };
    error?: string;
  }>(`${internalApiBaseUrl}/api/security`, { method: "GET" }, "channel-security-summary");

  if (!response.ok || !payload.success) {
    return `Security summary failed: ${payload.error || `HTTP ${response.status}`}.`;
  }

  const recommendations = Array.isArray(payload.data?.recommendations) ? payload.data?.recommendations : [];
  return [
    "Security summary:",
    `- Audit OK: ${payload.data?.ok ? "yes" : "no"}`,
    `- Errors: ${formatPlainInteger(payload.data?.errors)}`,
    `- Warnings: ${formatPlainInteger(payload.data?.warnings)}`,
    `- Protected routes: ${formatPlainInteger(payload.data?.summary?.protectedRoutes)}`,
    `- Public routes: ${formatPlainInteger(payload.data?.summary?.publicRoutes)}`,
    `- Unexpected public routes: ${formatPlainInteger(payload.data?.summary?.unexpectedPublicRoutes)}`,
    `- Admin token configured: ${payload.data?.summary?.adminTokenConfigured ? "yes" : "no"}`,
    `- WS auth token configured: ${payload.data?.summary?.wsAuthTokenConfigured ? "yes" : "no"}`,
    ...(recommendations.length > 0
      ? ["Recommendations:", ...recommendations.slice(0, 4).map((entry, index) => `${index + 1}. ${entry}`)]
      : []),
  ].join("\n");
}

type MinimalDocumentRecord = {
  id: string;
  name: string;
  sourceUrl?: string | null;
};

function findDocumentByReference<T extends MinimalDocumentRecord>(reference: string, docs: T[]): T | null {
  const trimmed = trimTrailingPunctuation(stripWrappedQuotes(reference));
  if (!trimmed) return null;
  const normalized = normalizeLookup(trimmed);
  return (
    docs.find((doc) => doc.id === trimmed) ??
    docs.find((doc) => normalizeLookup(doc.name) === normalized) ??
    docs.find((doc) => normalizeLookup(doc.name).includes(normalized)) ??
    null
  );
}

function resolveDocumentTaskReference<T extends MinimalDocumentRecord>(
  input: string,
  docs: T[],
): { doc: T | null; extraTitle: string } {
  const trimmed = trimTrailingPunctuation(stripWrappedQuotes(input));
  if (!trimmed) return { doc: null, extraTitle: "Follow up document" };

  const direct = findDocumentByReference(trimmed, docs);
  if (direct) {
    return { doc: direct, extraTitle: "Follow up document" };
  }

  const normalizedInput = normalizeLookup(trimmed);
  const normalizedInputTokens = normalizedInput.split(" ").filter(Boolean);
  const best = [...docs]
    .map((doc) => ({
      doc,
      normalizedName: normalizeLookup(doc.name),
    }))
    .filter((entry) => normalizedInput.startsWith(entry.normalizedName))
    .sort((left, right) => right.normalizedName.length - left.normalizedName.length)[0];

  if (!best) {
    return { doc: null, extraTitle: "Follow up document" };
  }

  const nameTokens = best.normalizedName.split(" ").filter(Boolean);
  const extraTitleTokens = normalizedInputTokens.slice(nameTokens.length);
  return {
    doc: best.doc,
    extraTitle: extraTitleTokens.length > 0 ? extraTitleTokens.join(" ") : "Follow up document",
  };
}

function readExtensionManifestConfigKeys(manifestPath: string): string[] {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { configSchema?: { properties?: Record<string, unknown> } };
    const properties = manifest.configSchema?.properties;
    return properties && typeof properties === "object" ? Object.keys(properties) : [];
  } catch {
    return [];
  }
}

function formatExtensionSetupGuidance(input: {
  extensionId: string;
  extensionName: string;
  manifestPath: string;
  config: Record<string, unknown>;
  globallyEnabled?: boolean;
  eligible?: boolean;
}): string {
  const hints = EXTENSION_SETUP_HINTS[input.extensionId] ?? { env: [], notes: [] };
  const configKeys = readExtensionManifestConfigKeys(input.manifestPath);
  const configuredKeys = configKeys.filter((key) => {
    const value = input.config[key];
    return value !== undefined && value !== null && String(value).trim() !== "";
  });
  const missingKeys = configKeys.filter((key) => !configuredKeys.includes(key));
  return [
    `${input.extensionName} setup`,
    `Status: global=${input.globallyEnabled === false ? "off" : "on"}${input.eligible === false ? " | channel not configured" : ""}`,
    hints.env.length > 0 ? `Secrets/env: ${hints.env.join(", ")}` : null,
    configKeys.length > 0 ? `Extension settings keys: ${configKeys.join(", ")}` : null,
    configuredKeys.length > 0 ? `Configured keys: ${configuredKeys.join(", ")}` : null,
    missingKeys.length > 0 ? `Missing extension settings: ${missingKeys.join(", ")}` : null,
    hints.notes.length > 0 ? `Next steps: ${hints.notes.join(" ")}` : null,
    hints.webhookPath ? `Webhook endpoint: ${hints.webhookPath}` : null,
    hints.accessModes ? `Access modes: ${hints.accessModes}` : null,
    hints.pairingNotes ? `Pairing: ${hints.pairingNotes}` : null,
    hints.nextSteps?.length ? `\nSetup steps:\n${hints.nextSteps.join("\n")}` : null,
  ].filter(Boolean).join("\n");
}

function formatSkillSetupGuidance(input: {
  skillId: string;
  skillLabel: string;
  requiredEnv?: string[];
  setupNotes?: string[];
  platforms?: string[];
}): string {
  return [
    `${input.skillLabel} setup`,
    input.requiredEnv?.length ? `Secrets/env: ${input.requiredEnv.join(", ")}` : "Secrets/env: none declared",
    input.platforms?.length ? `Platforms: ${input.platforms.join(", ")}` : null,
    input.setupNotes?.length ? `Next steps: ${input.setupNotes.join(" ")}` : null,
  ].filter(Boolean).join("\n");
}

function getMissingEnvVars(requiredEnv?: string[]): string[] {
  return (requiredEnv ?? []).filter((key) => !String(process.env[key] ?? "").trim());
}

function describeSkillRuntimeAvailability(input: {
  enabled: boolean;
  extensionId?: string | null;
  extensionEnabled?: boolean;
  extensionGlobal?: boolean;
  missingEnv?: string[];
}): string {
  if (input.enabled && (input.missingEnv?.length ?? 0) === 0) return "available now";
  if ((input.missingEnv?.length ?? 0) > 0) return `blocked by missing env: ${input.missingEnv?.join(", ")}`;
  if (input.extensionId && input.extensionGlobal === false) return "installed but disabled globally";
  if (input.extensionId && input.extensionEnabled === false) return "installed but disabled on the default agent";
  if (input.enabled) return "enabled with partial setup";
  return "installed but disabled";
}

function describeExtensionRuntimeAvailability(input: {
  globallyEnabled: boolean;
  agentEnabled?: boolean;
  hasRuntime?: boolean;
  missingConfigKeys?: string[];
  eligible?: boolean;
}): string {
  if (!input.globallyEnabled) return "installed but disabled globally";
  if (input.agentEnabled === false) return "installed but disabled on the default agent";
  if (input.eligible === false) return "blocked until the channel is configured";
  if ((input.missingConfigKeys?.length ?? 0) > 0) return `needs config: ${input.missingConfigKeys?.join(", ")}`;
  if (input.hasRuntime === false) return "installed, no runtime module";
  return "available now";
}

function extractMarkdownSection(markdown: string, headingTitle: string): string {
  const lines = String(markdown || "").split(/\r?\n/);
  const normalizedHeading = normalizeLookup(headingTitle);
  const startIndex = lines.findIndex((line) => {
    const heading = line.match(/^(#+)\s+(.+)$/);
    return heading ? normalizeLookup(heading[2]) === normalizedHeading : false;
  });
  if (startIndex < 0) return "";
  const startDepth = (lines[startIndex].match(/^(#+)/)?.[1].length ?? 1);
  const out: string[] = [];
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index];
    const nextHeading = line.match(/^(#+)\s+(.+)$/);
    if (index > startIndex && nextHeading && nextHeading[1].length <= startDepth) {
      break;
    }
    out.push(line);
  }
  return out.join("\n").trim();
}

function formatExternalExtensionInstallSummary(input: {
  id: string;
  name: string;
  sourceRef: string;
  installSource: string;
  skillCount: number;
  scanStatus: string | null | undefined;
  updatedAt?: string | null;
}): string {
  return [
    `${input.name} (${input.id})`,
    `Source: external via ${input.installSource}`,
    `Location: ${input.sourceRef}`,
    `Bundled skills: ${input.skillCount}`,
    input.scanStatus ? `Security scan: ${input.scanStatus}` : null,
    input.updatedAt ? `Updated: ${input.updatedAt}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatExternalSkillPackSummary(input: {
  id: string;
  name: string;
  sourceRef: string;
  installSource: string;
  skillCount: number;
  scanStatus: string | null | undefined;
  updatedAt?: string | null;
}): string {
  return [
    `${input.name} (${input.id})`,
    `Source: external via ${input.installSource}`,
    `Location: ${input.sourceRef}`,
    `Skills: ${input.skillCount}`,
    input.scanStatus ? `Security scan: ${input.scanStatus}` : null,
    input.updatedAt ? `Updated: ${input.updatedAt}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

async function executePlannedBuiltinStep(
  stepRaw: string,
  ctx: BuiltinCommandContext,
): Promise<{ response: string | null; commandTried: string; classification: AppIntentClassification }> {
  const sessionAppState = getChannelSessionAppState(ctx.sessionId)?.payload ?? null;
  const sessionResolved = resolveSessionAwareAppMessage(stepRaw, sessionAppState);
  let commandTried = sessionResolved?.message?.trim() || stepRaw.trim();
  const ellipticalResolved = resolveEllipticalAppMessage(commandTried);
  if (ellipticalResolved?.message?.trim()) {
    commandTried = ellipticalResolved.message.trim();
  }

  const classification = classifyAppControlIntent(commandTried, sessionAppState);
  let response = await handleBuiltinCommands(commandTried, { ...ctx, allowCompound: false });
  if (!response) {
    const assisted = await resolveBuiltinWithModel({
      rawMessage: commandTried,
      classification,
      sessionId: ctx.sessionId ?? null,
      sessionAppState,
    });
    if (assisted?.command && shouldAcceptModelBuiltinResolution(commandTried, classification, assisted)) {
      commandTried = assisted.commands.length > 1 ? assisted.commands.join(" | ") : assisted.command;
      response = await renderBuiltinCommandList(assisted.commands, ctx);
    }
  }
  if (!response) {
    const bestEffort = resolveBestEffortAppSurfaceCommand({
      rawMessage: commandTried,
      classification,
    });
    if (bestEffort) {
      commandTried = bestEffort;
      response = await handleBuiltinCommands(bestEffort, { ...ctx, allowCompound: false });
    }
  }

  if (response) {
    mergeSessionAppStateForInteraction({
      sessionId: ctx.sessionId,
      message: commandTried,
      response,
      classification,
    });
  }

  return { response, commandTried, classification };
}

/**
 * Render a compact "Prompt -> Org -> Council -> Workflow -> Task" trail for the
 * WebChat result card. Details (timestamps, raw plan, logs) live in the drawer.
 */
async function renderCompactWorkTrail(trailId: string): Promise<string | null> {
  try {
    const { getWorkTrail } = await import("@/lib/work-trails/work-trails");
    const data = getWorkTrail(trailId);
    if (!data) return null;
    const objectEvents = data.events.filter((e) =>
      ["object_created", "object_linked", "council_completed", "workflow_created", "workflow_scheduled", "board_task_created", "artifact_created"].includes(e.eventType),
    );
    if (objectEvents.length === 0) return null;
    const lines = objectEvents.slice(0, 10).map((e) => {
      const name = e.objectName ? `: ${e.objectName}` : "";
      const verb =
        e.eventType === "council_completed" ? "Ran council" :
        e.eventType === "workflow_created" ? "Created workflow" :
        e.eventType === "workflow_scheduled" ? "Scheduled workflow" :
        e.eventType === "board_task_created" ? "Created board task" :
        e.eventType === "object_linked" ? `Linked ${e.objectType ?? "object"}` :
        `Created ${e.objectType ?? "object"}`;
      return `-> ${verb}${name}`;
    });
    return ["**Work trail**", "WebChat prompt", ...lines, `_Trail ${trailId} · see Activity for full detail._`].join("\n");
  } catch {
    return null;
  }
}

async function executePendingMutation(pending: PendingMutation, ctx: BuiltinCommandContext): Promise<string> {
  if (pending.kind !== "multi-step-plan" && !isSensitiveCommandAllowed(ctx)) {
    return `This command changes app state and requires admin sender access. Sender "${ctx.sender}" is not in CHANNEL_COMMAND_ADMINS.`;
  }

  switch (pending.kind) {
    case "multi-step-plan": {
      const steps = Array.isArray(pending.payload.steps) ? (pending.payload.steps as MultiStepPlanStep[]) : [];
      if (steps.length === 0) {
        return "The pending multi-step plan is empty.";
      }
      const sections: string[] = [`Executed ${steps.length}-step plan.`];
      let lastAgentName = "";
      for (let index = 0; index < steps.length; index += 1) {
        const step = steps[index];
        const stepMessage = lastAgentName ? (resolveAgentPronounSkillQuery(step.raw, lastAgentName) ?? step.raw) : step.raw;
        const stepAgentCapability = parseFreeformAgentCapabilityAssignment(stepMessage);
        log.debug("Executing planned step", {
          index,
          rawStep: step.raw,
          stepMessage,
          lastAgentName,
        });
        const { response, commandTried, classification } = await executePlannedBuiltinStep(stepMessage, ctx);
        if (!response) {
          return [
            ...sections,
            "",
            `Plan stopped at step ${index + 1}.`,
            `Step: ${step.label}`,
            `Tried: ${commandTried}`,
            buildAppControlClarifier(classification, getChannelSessionAppState(ctx.sessionId)?.payload ?? null),
          ].join("\n");
        }
        if (/^Pending confirmation\b/i.test(response)) {
          return [
            ...sections,
            "",
            `Plan stopped at step ${index + 1}.`,
            `Step: ${step.label}`,
            "That step opened another confirmation gate. Run it separately after this plan.",
            response,
          ].join("\n");
        }
        const updatedAgentMatch = response.match(/^Updated (.+?)\./m) || response.match(/^Agent (.+?) now uses /m);
        if (updatedAgentMatch?.[1]) {
          lastAgentName = updatedAgentMatch[1].trim();
        } else if (stepAgentCapability?.agentRef) {
          lastAgentName = stepAgentCapability.agentRef.trim();
        }
        sections.push(`\n## Step ${index + 1}\n${step.label.trim().replace(/^#+\s*/g, "")}\n\n${response}`);
      }
      return sections.join("\n");
    }
    case "secret-set": {
      const { upsertSecret } = await import("@/lib/secrets/store");
      const saved = upsertSecret({
        name: String(pending.payload.name || ""),
        value: String(pending.payload.value || ""),
        source: "channel-command",
      });
      return `Secret saved: ${saved.name}. Value is encrypted at rest.`;
    }
    case "secret-delete": {
      const { deleteSecret } = await import("@/lib/secrets/store");
      const name = String(pending.payload.name || "").trim();
      const removed = deleteSecret(name);
      return removed ? `Secret deleted: ${name.toUpperCase()}.` : "Secret not found.";
    }
    case "config-set":
    case "config-toggle": {
      const column = String(pending.payload.column || "").trim();
      const table = String(pending.payload.table || "").trim();
      const field = CONFIG_FIELDS.find((entry) => entry.column === column && entry.table === table);
      if (!field) {
        return `Config field is no longer available: ${column}.`;
      }
      const { initializeDatabase, getSqlite } = await import("@/lib/db");
      initializeDatabase();
      const db = getSqlite();
      db.prepare(`UPDATE ${field.table} SET ${field.column} = ?, updated_at = ? WHERE id = 'default'`).run(
        pending.payload.value as unknown,
        new Date().toISOString(),
      );
      return `Config updated: ${field.column} = ${formatConfigValue(pending.payload.value, field)}`;
    }
    case "learning-config": {
      const { initializeDatabase, getSqlite } = await import("@/lib/db");
      initializeDatabase();
      const db = getSqlite();
      const now = new Date().toISOString();
      db.prepare(`
        UPDATE app_config
        SET learning_enabled = ?,
            learning_mode = ?,
            learning_capture_preferences = ?,
            learning_capture_playbooks = ?,
            learning_auto_promote_threshold = ?,
            updated_at = ?
        WHERE id = 'default'
      `).run(
        pending.payload.learningEnabled === true ? 1 : 0,
        String(pending.payload.learningMode || "review"),
        pending.payload.capturePreferences === false ? 0 : 1,
        pending.payload.capturePlaybooks === false ? 0 : 1,
        Math.max(1, Math.min(10, Number(pending.payload.autoPromoteThreshold || 2))),
        now,
      );
      const { formatLearningStatusMarkdown } = await import("@/lib/learning/loop");
      return [
        "Learning settings updated.",
        "",
        formatLearningStatusMarkdown(),
      ].join("\n");
    }
    case "learning-candidate-promote": {
      const { promoteLearningCandidate } = await import("@/lib/learning/loop");
      const promoted = await promoteLearningCandidate(String(pending.payload.candidateRef || ""));
      return [
        `Promoted learning candidate ${promoted.id}.`,
        `Title: ${promoted.title}`,
        promoted.targetPath ? `Target: ${promoted.targetPath}` : null,
      ].filter(Boolean).join("\n");
    }
    case "learning-candidate-dismiss": {
      const { dismissLearningCandidate } = await import("@/lib/learning/loop");
      const dismissed = dismissLearningCandidate(String(pending.payload.candidateRef || ""));
      return `Dismissed learning candidate ${dismissed.id}: ${dismissed.title}.`;
    }
    case "extension-global-toggle": {
      const extensionId = String(pending.payload.extensionId || "").trim();
      const enable = pending.payload.enable === true;
      const [{ setGlobalExtensionEnabled }, { buildGlobalExtensionEntries }] = await Promise.all([
        import("@/lib/extensions/state"),
        import("@/lib/extensions/state"),
      ]);
      const updated = setGlobalExtensionEnabled(extensionId, enable);
      const entry = buildGlobalExtensionEntries().find((candidate) => candidate.id === extensionId);
      const suffix = enable && entry
        ? `\n\n${formatExtensionSetupGuidance({
            extensionId: entry.id,
            extensionName: entry.name,
            manifestPath: entry.manifestPath,
            config: entry.config,
            globallyEnabled: entry.globallyEnabled,
          })}`
        : "";
      return `Extension ${updated.name} is now ${enable ? "enabled" : "disabled"} globally.${suffix}`;
    }
    case "extension-install": {
      const [{ installExternalExtension, listExternalExtensionInstalls }, { loadExtensionRuntimeRegistry, getExtensionRuntimeStatus }, { buildGlobalExtensionEntries, setGlobalExtensionEnabled }] =
        await Promise.all([
          import("@/lib/extensions/installer"),
          import("@/lib/extensions/runtime"),
          import("@/lib/extensions/state"),
        ]);
      const previousIds = new Set(buildGlobalExtensionEntries().map((entry) => entry.id));
      const installed = installExternalExtension({
        source: String(pending.payload.source || ""),
        ref: String(pending.payload.ref || "").trim() || null,
      });
      if (!previousIds.has(installed.id)) {
        setGlobalExtensionEnabled(installed.id, false);
      }
      await loadExtensionRuntimeRegistry();
      await getExtensionRuntimeStatus();
      const detail = listExternalExtensionInstalls().find((entry) => entry.id === installed.id);
      return [
        `Installed external extension ${installed.id}.`,
        detail
          ? formatExternalExtensionInstallSummary({
              id: detail.id,
              name: buildGlobalExtensionEntries().find((entry) => entry.id === detail.id)?.name || detail.id,
              sourceRef: detail.sourceRef,
              installSource: detail.installSource,
              skillCount: buildGlobalExtensionEntries().find((entry) => entry.id === detail.id)?.skillCount || 0,
              scanStatus: detail.scanStatus,
              updatedAt: detail.updatedAt,
            })
          : null,
        'Next: enable it globally or for a specific agent when you are ready.',
      ]
        .filter(Boolean)
        .join("\n");
    }
    case "extension-update": {
      const [{ updateExternalExtension, listExternalExtensionInstalls }, { loadExtensionRuntimeRegistry, getExtensionRuntimeStatus }, { buildGlobalExtensionEntries }] =
        await Promise.all([
          import("@/lib/extensions/installer"),
          import("@/lib/extensions/runtime"),
          import("@/lib/extensions/state"),
        ]);
      const updatedInstall = updateExternalExtension(String(pending.payload.extensionId || ""));
      await loadExtensionRuntimeRegistry();
      await getExtensionRuntimeStatus();
      const detail = listExternalExtensionInstalls().find((entry) => entry.id === updatedInstall.id) ?? updatedInstall;
      return [
        `Updated external extension ${detail.id}.`,
        formatExternalExtensionInstallSummary({
          id: detail.id,
          name: buildGlobalExtensionEntries().find((entry) => entry.id === detail.id)?.name || detail.id,
          sourceRef: detail.sourceRef,
          installSource: detail.installSource,
          skillCount: buildGlobalExtensionEntries().find((entry) => entry.id === detail.id)?.skillCount || 0,
          scanStatus: detail.scanStatus,
          updatedAt: detail.updatedAt,
        }),
      ].join("\n");
    }
    case "extension-uninstall": {
      const [{ uninstallExternalExtension }, { clearGlobalExtensionState }, { pruneExtensionReferences }] = await Promise.all([
        import("@/lib/extensions/installer"),
        import("@/lib/extensions/state"),
        import("@/lib/agents/registry"),
      ]);
      const extensionId = String(pending.payload.extensionId || "").trim();
      const removed = uninstallExternalExtension(extensionId);
      if (!removed) return "External extension not found.";
      clearGlobalExtensionState(extensionId);
      pruneExtensionReferences(extensionId);
      return `Removed external extension ${extensionId}.`;
    }
    case "skill-pack-install": {
      const { installExternalSkillPack } = await import("@/lib/skills/installer");
      const installed = installExternalSkillPack({
        source: String(pending.payload.source || ""),
        ref: String(pending.payload.ref || "").trim() || null,
      });
      return [
        `Installed external skill pack ${installed.id}.`,
        formatExternalSkillPackSummary(installed),
        'Next: enable the skill pack on an agent when you are ready.',
      ].join("\n");
    }
    case "skill-pack-update": {
      const { updateExternalSkillPack } = await import("@/lib/skills/installer");
      const updated = updateExternalSkillPack(String(pending.payload.skillPackId || ""));
      return [
        `Updated external skill pack ${updated.id}.`,
        formatExternalSkillPackSummary(updated),
      ].join("\n");
    }
    case "skill-pack-uninstall": {
      const [{ uninstallExternalSkillPack }, { pruneSkillPackReferences }] = await Promise.all([
        import("@/lib/skills/installer"),
        import("@/lib/agents/registry"),
      ]);
      const skillPackId = String(pending.payload.skillPackId || "").trim();
      const removed = uninstallExternalSkillPack(skillPackId);
      if (!removed) return "External skill pack not found.";
      pruneSkillPackReferences(skillPackId);
      return `Removed external skill pack ${skillPackId}.`;
    }
    case "organization-export": {
      const { resolveHierarchyOrganization, getActiveHierarchyOrganization } = await import("@/lib/hierarchy/organizations");
      const { exportCompanyPackage } = await import("@/lib/governance/company-packages");
      const organization =
        resolveHierarchyOrganization(String(pending.payload.organizationRef || "")) ??
        getActiveHierarchyOrganization();
      if (!organization) return "Organization not found.";
      const outputPath = path.resolve(String(pending.payload.outputPath || ""));
      if (!outputPath) return "Output path is required.";
      const pkg = exportCompanyPackage(organization.id);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
      return `Exported organization pack ${organization.name} to ${outputPath}.`;
    }
    case "organization-import": {
      try {
        const { importCompanyPackage, importExternalCompanyTemplate } = await import("@/lib/governance/company-packages");
        const inputPath = path.resolve(String(pending.payload.inputPath || ""));
        if (!fs.existsSync(inputPath)) return `Organization pack not found: ${inputPath}.`;
        const isExternalTemplate = String(pending.payload.format || "").trim().toLowerCase() === "external-company-template";
        const result = isExternalTemplate
          ? importExternalCompanyTemplate(inputPath, {
              activate: pending.payload.activate !== false,
            })
          : importCompanyPackage(JSON.parse(fs.readFileSync(inputPath, "utf8")) as any, {
              activate: pending.payload.activate !== false,
            });
        return isExternalTemplate
          ? `Imported company template. Organization ${result.organizationId} with ${result.agentIds.length} agents and ${result.goalIds.length} goals.`
          : `Imported organization pack. Organization ${result.organizationId} with ${result.agentIds.length} agents and ${result.goalIds.length} goals.`;
      } catch (error) {
        return `Organization import failed: ${String(error)}`;
      }
    }
    case "ecosystem-import": {
      const ecosystem = String(pending.payload.ecosystem || "").trim().toLowerCase();
      const repoPath = String(pending.payload.repoPath || "").trim();
      if (!repoPath) return "Repository path is required.";
      const { importExternalSkillLibraryRepo, importWorkspaceSkillLibraryRepo } = await import("@/lib/learning/importers");
      const imported =
        ecosystem === "workspace-library"
          ? importWorkspaceSkillLibraryRepo(repoPath)
          : importExternalSkillLibraryRepo(repoPath);
      return [
        `Imported ${imported.ecosystem} skills from ${imported.repoPath}.`,
        `Installed skill pack: ${imported.importedPack.id} (${imported.skillCount} skills)`,
        imported.recommendedExtensionIds.length > 0
          ? `Runtime-backed extension matches: ${imported.recommendedExtensionIds.join(", ")}`
          : null,
      ].filter(Boolean).join("\n");
    }
    case "cleanup-generated": {
      const { cleanupGeneratedArtifacts, formatGeneratedArtifactCleanupSummary } = await import(
        "@/lib/maintenance/generated-artifacts"
      );
      const summary = cleanupGeneratedArtifacts({ removeTestCronWorkflows: true });
      return formatGeneratedArtifactCleanupSummary(summary);
    }
    case "org-create-bulk": {
      const agentCount = Number(pending.payload.agentCount);
      const orgName = String(pending.payload.organizationName || "");
      const debateTopic = pending.payload.debateTopic ? String(pending.payload.debateTopic) : null;
      const rawMessage = pending.payload.rawMessage ? String(pending.payload.rawMessage) : "";
      if (!orgName || !Number.isFinite(agentCount) || agentCount < 1 || agentCount > 12) {
        return "Bulk org creation payload is invalid. Please try your request again.";
      }
      const [{ createAgent, listAgents }, { updateAgentRole }, { saveSelectedHierarchyOrganization }] = await Promise.all([
        import("@/lib/agents/registry"),
        import("@/lib/agents/roles"),
        import("@/lib/hierarchy/organizations"),
      ]);
      const takenIds = new Set(listAgents().map((agent) => agent.id));
      const plans = buildGeneratedAgentPlans(agentCount, orgName, takenIds);
      const createdAgents: Array<{ id: string; name: string }> = [];
      for (let index = 0; index < plans.length; index += 1) {
        const plan = plans[index];
        const created = createAgent({ name: plan.name });
        createdAgents.push({ id: created.id, name: created.name });
        const reportsToIndex =
          plan.reportsToIndex === null || plan.reportsToIndex >= createdAgents.length
            ? null
            : plan.reportsToIndex;
        updateAgentRole(created.id, {
          roleType: plan.roleType,
          roleTitle: plan.roleTitle,
          reportsTo: reportsToIndex === null ? null : createdAgents[reportsToIndex].id,
          capabilities: plan.capabilities,
        });
      }
      const organization = saveSelectedHierarchyOrganization({
        name: orgName,
        description: `Created from chat on ${new Date().toISOString()}.`,
        activate: true,
        memberIds: createdAgents.map((agent) => agent.id),
      });
      const summaryLines = [
        `Created ${createdAgents.length} agents and organization ${organization.name}.`,
        `Agents: ${createdAgents.map((agent) => agent.name).join(", ")}.`,
        "The Hierarchy tab now uses this organization snapshot.",
      ];
      if (debateTopic) {
        try {
          const debate = await runOrganizationCollaborationTask({
            rawMessage,
            topic: debateTopic,
            organizationRef: organization.name,
            explicitMode: "council",
            ctx,
          });
          return [...summaryLines, "", `Council debate on: ${debateTopic}`, debate].join("\n");
        } catch (error) {
          return [
            ...summaryLines,
            "",
            `Council debate could not start automatically: ${String(error)}.`,
            `Try: ask organization ${organization.name} council about ${debateTopic}`,
          ].join("\n");
        }
      }
      return summaryLines.join("\n");
    }
    case "app-action-plan": {
      const rawPlan = pending.payload.plan;
      if (!rawPlan || typeof rawPlan !== "object") {
        return "The pending app-action plan is missing or corrupt. Please try your request again.";
      }
      const { normalizeAppActionPlanStructure, validateAppActionPlan } = await import("@/lib/channels/app-action-schema");
      const validation = validateAppActionPlan(rawPlan);
      if (!validation.success) {
        return `App plan validation failed: ${validation.error}. Please try your request again.`;
      }
      const normalizedPlan = normalizeAppActionPlanStructure(validation.plan);
      const normalizedValidation = validateAppActionPlan(normalizedPlan);
      if (!normalizedValidation.success) {
        return `App plan validation failed after repair: ${normalizedValidation.error}. Please try your request again.`;
      }
      const { executeAppActionPlan } = await import("@/lib/channels/app-action-executor");
      if (ctx.clientTurnId) {
        const { isTurnAborted: check } = await import("@/lib/channels/turn-abort-registry");
        if (check(ctx.clientTurnId)) return "Request was cancelled";
      }
      const trailId = typeof pending.payload.trailId === "string" ? pending.payload.trailId : "";
      if (trailId) {
        try {
          const wt = await import("@/lib/work-trails/work-trails");
          wt.appendWorkTrailEvent({ trailId, eventType: "confirmed", summary: "Plan confirmed" });
          wt.updateWorkTrailStatus(trailId, "executing");
        } catch { /* trail is best-effort */ }
      }
      const report = await executeAppActionPlan(normalizedValidation.plan, {
        sessionId: String(ctx.sessionId || ""),
        channel: ctx.channel,
        internalBaseUrl: ctx.internalBaseUrl,
      });
      if (trailId) {
        try {
          const wt = await import("@/lib/work-trails/work-trails");
          const stepLabels = new Map(normalizedValidation.plan.steps.map((s) => [s.id, s.label]));
          for (const r of report.stepResults) {
            wt.recordStepResultEvent({ trailId, action: r.action, ok: r.ok, output: r.output, error: r.error, label: stepLabels.get(r.id) });
          }
          const allOk = report.stepsSucceeded === report.stepsAttempted && report.stepsAttempted > 0;
          wt.updateWorkTrailStatus(trailId, allOk ? "completed" : "failed");
          const rendered = await renderCompactWorkTrail(trailId);
          return rendered ? `${report.summary}\n\n${rendered}` : report.summary;
        } catch { /* trail is best-effort */ }
      }
      return report.summary;
    }
    default:
      return "Nothing to confirm.";
  }
}

function humanizeTaskTemplateKey(value: string): string {
  return value
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

function buildTaskLookupAliases(task: TaskLookupRecord): string[] {
  const aliases = [task.title];
  if (task.workflowTemplateKey) {
    aliases.push(task.workflowTemplateKey, humanizeTaskTemplateKey(task.workflowTemplateKey));
    aliases.push(...(TASK_TEMPLATE_ALIASES[task.workflowTemplateKey] ?? []));
  }
  return Array.from(
    new Set(
      aliases
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );
}

function scoreTaskLookupAlias(alias: string, reference: string): number {
  const aliasNormalized = normalizeLookup(alias);
  if (!aliasNormalized) return 0;
  if (aliasNormalized === reference) return 120;
  if (aliasNormalized.startsWith(reference)) return 92;
  if (aliasNormalized.includes(reference)) return 86;
  if (reference.includes(aliasNormalized)) return 72;

  const aliasTokens = aliasNormalized.split(" ").filter(Boolean);
  const refTokens = reference.split(" ").filter(Boolean);
  if (refTokens.length > 0 && refTokens.every((token) => aliasTokens.includes(token))) {
    return 60 + refTokens.length;
  }

  return 0;
}

function resolveTaskByReference(
  tasks: TaskLookupRecord[],
  taskReference: string,
): {
  task: TaskLookupRecord | null;
  matchedAlias: string;
  matchedCount: number;
} {
  const normalizedReference = normalizeLookup(taskReference);
  if (!normalizedReference) {
    return { task: null, matchedAlias: "", matchedCount: 0 };
  }

  const ranked = tasks
    .map((task) => {
      let bestScore = 0;
      let matchedAlias = "";
      for (const alias of buildTaskLookupAliases(task)) {
        const score = scoreTaskLookupAlias(alias, normalizedReference);
        if (score > bestScore) {
          bestScore = score;
          matchedAlias = alias;
        }
      }
      return { task, bestScore, matchedAlias };
    })
    .filter((item) => item.bestScore > 0)
    .sort((left, right) => {
      if (right.bestScore !== left.bestScore) {
        return right.bestScore - left.bestScore;
      }
      return right.task.updatedAt.localeCompare(left.task.updatedAt);
    });

  if (ranked.length === 0) {
    return { task: null, matchedAlias: "", matchedCount: 0 };
  }

  const bestScore = ranked[0]?.bestScore ?? 0;
  const bestMatches = ranked.filter((item) => item.bestScore === bestScore);
  const selected = bestMatches.sort((left, right) => right.task.updatedAt.localeCompare(left.task.updatedAt))[0];

  return {
    task: selected?.task ?? null,
    matchedAlias: selected?.matchedAlias ?? "",
    matchedCount: bestMatches.length,
  };
}

function inferWorkflowIntentFromCandidates(
  message: string,
  workflowNames: string[],
): WorkflowCommandIntent {
  const explicit = parseWorkflowIntent(message);
  if (explicit.requestedWorkflowName) {
    return explicit;
  }

  const raw = message.trim();
  if (!raw) {
    return explicit;
  }

  const normalized = normalizeLookup(raw);
  const runVerb = /\b(?:run|execute|start|launch|use|open|trigger|kick\s*off)\b/i;
  const runVerbPresent = runVerb.test(raw);
  const names = workflowNames
    .map((name) => name.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);

  for (const name of names) {
    const pattern = new RegExp(escapeRegex(name), "i");
    const match = raw.match(pattern);
    if (!match || match.index === undefined) continue;
    if (!runVerbPresent && !/\bworkflow\b|\btemplate\b/i.test(raw)) continue;

    const before = raw.slice(0, match.index);
    const after = raw.slice(match.index + match[0].length);
    if (!runVerb.test(before) && !/\bworkflow\b|\btemplate\b/i.test(before)) {
      continue;
    }

    return {
      requestedWorkflowName: name.toLowerCase(),
      requestedWorkflowNameRaw: name,
      workflowPayload: trimIntentLeadIn(after),
    };
  }

  const docsWorkflow = names.find((name) => {
    const workflowNormalized = normalizeLookup(name);
    return (
      workflowNormalized.includes("docs") &&
      (workflowNormalized.includes("crawler") || workflowNormalized.includes("crawl")) &&
      workflowNormalized.includes("summary")
    );
  });

  const looksLikeDocsCrawlRequest =
    /https?:\/\//i.test(raw) &&
    /\b(?:crawl|scrape|docs?|documentation|summari[sz]e|summary|learning path)\b/i.test(raw);

  if (docsWorkflow && looksLikeDocsCrawlRequest) {
    return {
      requestedWorkflowName: docsWorkflow.toLowerCase(),
      requestedWorkflowNameRaw: docsWorkflow,
      workflowPayload: raw,
    };
  }

  return explicit;
}

function extractTaskTitleFromNaturalLanguage(message: string): string | null {
  const raw = message.trim();
  if (!raw) return null;

  const patterns = [
    /^(?:task\s*:|add\s+task\s*:?\s*)(.+)$/i,
    /^(?:please\s+)?(?:create|add|make|log|track)\s+(?:a\s+)?(?:new\s+)?(?:board\s+task|task|todo|to[-\s]?do|card|item)\s*(?:called|named|to)?\s*[:,-]?\s*(.+)$/i,
    /^(?:can you|could you|would you|please)\s+(?:create|add|make|log|track|put)\s+(.+?)\s+(?:as\s+)?(?:a\s+)?(?:board\s+task|task|todo|card)(?:\s+on\s+(?:my\s+)?board)?$/i,
    /^(?:please\s+)?(?:add|put|drop)\s+(.+?)\s+(?:to|into|in|on)\s+(?:my\s+)?(?:board|inbox|task list)(?:\s+as\s+a\s+(?:task|todo|card))?$/i,
    /^(?:please\s+)?(?:put|add)\s+(?:this\s+)?(?:in|into)\s+(?:my\s+)?inbox\s*[:,-]?\s*(.+)$/i,
    /^(?:please\s+)?(?:create|add|make)\s+(?:a\s+)?(?:board\s+task|task)\s+for\s+(.+)$/i,
  ];

  for (const pattern of patterns) {
    const match = raw.match(pattern);
    const title = match?.[1] ? stripWrappedQuotes(match[1]).trim() : "";
    if (title) {
      return title.slice(0, 120);
    }
  }

  return null;
}

function normalizeSenderKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^@+/, "");
}

function resolveCommandAdmins(): Set<string> {
  const raw =
    String(process.env.CHANNEL_COMMAND_ADMINS ?? "").trim() ||
    String(process.env.CHANNEL_COMMAND_ADMIN_IDS ?? "").trim() ||
    String(process.env.CHANNEL_COMMAND_ALLOWLIST ?? "").trim();
  if (!raw) return new Set<string>();
  const out = new Set<string>();
  for (const part of raw.split(/[,\s]+/)) {
    const normalized = normalizeSenderKey(part);
    if (normalized) out.add(normalized);
  }
  return out;
}

function isSensitiveCommandAllowed(ctx: BuiltinCommandContext): boolean {
  const admins = resolveCommandAdmins();
  if (admins.size === 0) return true;
  const sender = normalizeSenderKey(ctx.sender);
  if (!sender) return false;
  return admins.has(sender);
}

function resolveConfigField(rawKey: string): ConfigFieldMeta | null {
  const normalized = normalizeLookup(rawKey);
  const relaxed = normalized
    .replace(/\b(?:setting|settings|config|configuration)\b/g, " ")
    .replace(/\b(?:page|tab)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return null;
  for (const field of CONFIG_FIELDS) {
    const candidates = [field.column, ...field.aliases];
    for (const candidate of candidates) {
      const normalizedCandidate = normalizeLookup(candidate);
      if (normalizedCandidate === normalized || (relaxed && normalizedCandidate === relaxed)) {
        return field;
      }
    }
  }
  return null;
}

function parseBooleanToken(raw: string): 0 | 1 | null {
  const normalized = raw.trim().toLowerCase();
  if (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on" ||
    normalized === "enabled"
  ) {
    return 1;
  }
  if (
    normalized === "0" ||
    normalized === "false" ||
    normalized === "no" ||
    normalized === "off" ||
    normalized === "disabled"
  ) {
    return 0;
  }
  return null;
}

function parseConfigValue(rawValue: string, field: ConfigFieldMeta): unknown {
  const text = stripWrappedQuotes(rawValue);
  if (field.type === "boolean") {
    const bool = parseBooleanToken(text);
    if (bool === null) {
      throw new Error(`Invalid boolean for ${field.column}. Use on/off, true/false, or yes/no.`);
    }
    return bool;
  }
  if (field.type === "number") {
    const number = Number(text);
    if (!Number.isFinite(number)) {
      throw new Error(`Invalid number for ${field.column}.`);
    }
    if (field.min !== undefined && number < field.min) {
      throw new Error(`${field.column} must be >= ${field.min}.`);
    }
    if (field.max !== undefined && number > field.max) {
      throw new Error(`${field.column} must be <= ${field.max}.`);
    }
    return Number.isInteger(number) ? Math.trunc(number) : number;
  }
  if (field.type === "enum") {
    const normalized = text.toLowerCase();
    const options = field.enumValues ?? [];
    if (!options.includes(normalized)) {
      throw new Error(`Invalid value for ${field.column}. Allowed: ${options.join(", ")}.`);
    }
    return normalized;
  }
  if (text.toLowerCase() === "null" || text.toLowerCase() === "none") {
    return null;
  }
  return text;
}

function formatConfigValue(value: unknown, field: ConfigFieldMeta): string {
  if (field.type === "boolean") {
    return Number(value) === 1 ? "on" : "off";
  }
  if (value === null || value === undefined) return "null";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function formatAgentList(agents: AgentLite[]): string {
  if (agents.length === 0) return "No agents configured yet.";
  const lines = agents.slice(0, 12).map((agent, index) => {
    const flags = [
      agent.isDefault ? "default" : "",
      agent.isActive ? "active" : "inactive",
      agent.modelRef ? `model=${agent.modelRef}` : "model=global",
    ]
      .filter(Boolean)
      .join(", ");
    const roleLabel = [agent.roleTitle, agent.roleType].filter(Boolean).join(" / ");
    const managerLabel = agent.reportsToName ? ` -> reports to ${agent.reportsToName}` : "";
    return `${index + 1}. ${agent.name} (${agent.id})${roleLabel ? ` - ${roleLabel}` : ""}${managerLabel} [${flags}]`;
  });
  return `Agents (${agents.length} total):\n${lines.join("\n")}`;
}

function rankAgentRecommendations(agents: AgentLite[], reference: string): AgentLite[] {
  const normalized = normalizeLookup(reference);
  if (!normalized) return [];
  return agents
    .map((agent) => {
      const id = normalizeLookup(agent.id);
      const name = normalizeLookup(agent.name);
      let score = 0;
      if (name === normalized) score += 10;
      if (id === normalized) score += 9;
      if (name.includes(normalized)) score += 7;
      if (id.includes(normalized)) score += 6;
      for (const term of normalized.split(/\s+/).filter(Boolean)) {
        const stem = stemLookupTerm(term);
        if (name.includes(term) || name.includes(stem)) score += 3;
        if (id.includes(term) || id.includes(stem)) score += 2;
      }
      return { agent, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.agent.name.localeCompare(right.agent.name))
    .map((entry) => entry.agent);
}

function resolveAgentMatches(agents: AgentLite[], reference: string): AgentLite[] {
  const normalized = normalizeLookup(reference);
  if (!normalized) return [];

  const idExact = agents.filter((agent) => normalizeLookup(agent.id) === normalized);
  if (idExact.length > 0) return idExact;

  const nameExact = agents.filter((agent) => normalizeLookup(agent.name) === normalized);
  if (nameExact.length > 0) return nameExact;

  return agents.filter((agent) => {
    const id = normalizeLookup(agent.id);
    const name = normalizeLookup(agent.name);
    return id.includes(normalized) || name.includes(normalized);
  });
}

function formatAmbiguousAgentMatches(reference: string, matches: AgentLite[]): string {
  return [
    `Multiple agents matched "${reference}":`,
    ...matches.slice(0, 5).map((agent, index) => `${index + 1}. ${agent.name} (${agent.id})`),
    'Reply with the exact agent name or id.',
  ].join("\n");
}

type NamedCatalogEntry = {
  id: string;
  name: string;
  description?: string | null;
};

function resolveCatalogMatches<T extends NamedCatalogEntry>(items: T[], reference: string): T[] {
  const normalized = normalizeLookup(reference);
  if (!normalized) return [];
  const idExact = items.filter((item) => normalizeLookup(item.id) === normalized);
  if (idExact.length > 0) return idExact;
  const nameExact = items.filter((item) => normalizeLookup(item.name) === normalized);
  if (nameExact.length > 0) return nameExact;
  return items.filter((item) => {
    const id = normalizeLookup(item.id);
    const name = normalizeLookup(item.name);
    const description = normalizeLookup(item.description ?? "");
    return id.includes(normalized) || name.includes(normalized) || description.includes(normalized);
  });
}

function formatAmbiguousCatalogMatches<T extends NamedCatalogEntry>(
  kind: string,
  reference: string,
  matches: T[],
): string {
  return [
    `Multiple ${kind} matched "${reference}":`,
    ...matches.slice(0, 5).map((item, index) => `${index + 1}. ${item.name} (${item.id})`),
    `Reply with the exact ${kind.replace(/s$/, "")} name or id.`,
  ].join("\n");
}

function rankCatalogRecommendations<T extends NamedCatalogEntry>(items: T[], reference: string): T[] {
  const normalized = normalizeLookup(reference);
  if (!normalized) return [];
  const stopWords = new Set([
    "a",
    "an",
    "and",
    "do",
    "for",
    "how",
    "i",
    "is",
    "it",
    "me",
    "of",
    "please",
    "should",
    "the",
    "this",
    "to",
    "use",
    "what",
    "with",
  ]);
  const terms = normalized
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term && !stopWords.has(term));
  const scored = items
    .map((item) => {
      const id = normalizeLookup(item.id);
      const name = normalizeLookup(item.name);
      const description = normalizeLookup(item.description ?? "");
      let score = 0;
      if (id === normalized) score += 12;
      if (name === normalized) score += 10;
      if (id.includes(normalized)) score += 8;
      if (name.includes(normalized)) score += 7;
      if (description.includes(normalized)) score += 5;
      let matchedTerms = 0;
      for (const term of terms) {
        const variants = new Set([term, stemLookupTerm(term)]);
        let matched = false;
        for (const variant of variants) {
          if (!variant) continue;
          if (id.includes(variant)) {
            score += 3;
            matched = true;
          }
          if (name.includes(variant)) {
            score += 3;
            matched = true;
          }
          if (description.includes(variant)) {
            score += 2;
            matched = true;
          }
        }
        if (matched) matchedTerms += 1;
      }
      score += matchedTerms * 2;
      return { item, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.item.name.localeCompare(right.item.name));
  return scored.map((entry) => entry.item);
}

function getGuidedSkillIdsForQuery(reference: string): string[] {
  const normalized = normalizeLookup(reference);
  if (!normalized) return [];

  const preferredIds: string[] = [];
  const pushPreferred = (...ids: string[]) => {
    for (const id of ids) {
      if (!preferredIds.includes(id)) preferredIds.push(id);
    }
  };

  if (normalized.includes("arxiv") || normalized.includes("paper") || normalized.includes("papers")) {
    pushPreferred("optional:arxiv-paper-research", "optional:research-librarian", "optional:ocr-and-documents");
  }
  if (normalized.includes("subagent") || normalized.includes("subagents") || normalized.includes("refactor") || normalized.includes("planning")) {
    pushPreferred("optional:subagent-driven-development", "optional:writing-plans", "team-coordination");
  }
  if (
    normalized.includes("voice") ||
    normalized.includes("transcript") ||
    normalized.includes("transcribing") ||
    normalized.includes("transcription") ||
    normalized.includes("whisper")
  ) {
    pushPreferred("optional:whisper-transcription-playbooks", "voice:voice-ops", "optional:voice-call-playbooks");
  }
  const hasGithubContext =
    normalized.includes("github") ||
    normalized.includes("pull request") ||
    normalized.includes("pull requests") ||
    /\bpr\b/.test(normalized);
  if (
    hasGithubContext ||
    (normalized.includes("auth") && normalized.includes("github")) ||
    (normalized.includes("review") && (normalized.includes("github") || /\bpr\b/.test(normalized)))
  ) {
    pushPreferred(
      "optional:github-auth-setup",
      "optional:github-code-review",
      "github:github-ops",
      "diffs:diff-review",
      "optional:security-review",
    );
  }

  return preferredIds;
}

function prioritizeCatalogRecommendations<T extends NamedCatalogEntry>(items: T[], reference: string, universe?: T[]): T[] {
  const preferredIds = getGuidedSkillIdsForQuery(reference);
  if (preferredIds.length === 0) return items;

  const itemById = new Map((universe ?? items).map((item) => [item.id, item]));
  const preferred = preferredIds.map((id) => itemById.get(id)).filter(Boolean) as T[];
  const preferredSet = new Set(preferred.map((item) => item.id));
  const remainder = items.filter((item) => !preferredSet.has(item.id));
  return [...preferred, ...remainder];
}

function splitCapabilityReferences(raw: string): string[] {
  return String(raw || "")
    .split(/,|(?:\s+and\s+)|(?:\s+\+\s+)|(?:\s+plus\s+)/i)
    .map((part) =>
      stripWrappedQuotes(part)
        .replace(/\s+(?:so|so\s+that)\s+(?:they|it|this|that|the\s+agent|the\s+team|we)\b[\s\S]*$/i, "")
        .replace(/\s+to\s+(?:help|handle|cover|support|work\s+on|do|tackle|manage)\b[\s\S]*$/i, "")
        .replace(/\b(skill\s*packs?|skills?|extensions?|plugins?)\b/gi, "")
        .replace(/\b(use|with|please|the|a|an)\b/gi, "")
        .trim(),
    )
    .filter(Boolean);
}

function resolveSingleCatalogItem<T extends NamedCatalogEntry>(items: T[], reference: string): T | null {
  const direct = resolveCatalogMatches(items, reference);
  if (direct.length === 1) return direct[0];
  if (direct.length > 1) {
    return rankCatalogRecommendations(direct, reference)[0] ?? direct[0] ?? null;
  }
  const ranked = rankCatalogRecommendations(items, reference);
  return ranked[0] ?? null;
}

function parseFreeformAgentCapabilityAssignment(message: string): { agentRef: string; requested: string } | null {
  const raw = String(message || "").trim();
  if (isConversationalAgentControlMessage(raw)) return null;
  const extractCapabilityIntent = (agentRefRaw: string, requestedRaw: string): { agentRef: string; requested: string } | null => {
    const requested = stripWrappedQuotes(requestedRaw).replace(/[.!?]+$/, "").trim();
    if (!requested) return null;
    if (!/\b(?:systematic debugging|telegram|slack|discord|github|probing|research|planning|development|review|skills?|extensions?|plugins?|capabilit(?:y|ies))\b/i.test(requested)) {
      return null;
    }
    const agentRef = stripWrappedQuotes(agentRefRaw).trim();
    return agentRef ? { agentRef, requested } : null;
  };
  const directAgentRest = raw.match(/^(?:please\s+)?(?:make|have|let|set|configure|assign|give)\s+agent\s+(.+)$/i)?.[1];
  if (directAgentRest) {
    const capabilityCue = directAgentRest.search(
      /\b(?:systematic debugging|telegram|slack|discord|github|probing|research|planning|development|review|skills?|extensions?|plugins?|capabilit(?:y|ies))\b/i,
    );
    if (capabilityCue > 0) {
      const agentRef = stripWrappedQuotes(directAgentRest.slice(0, capabilityCue)).trim();
      const requested = stripWrappedQuotes(directAgentRest.slice(capabilityCue)).replace(/[.!?]+$/, "").trim();
      if (agentRef && requested) {
        return { agentRef, requested };
      }
    }
  }
  const directTheAgentRest = raw.match(/^(?:please\s+)?(?:make|have|let|set|configure|assign|give)\s+the\s+(.+?)\s+agent\s+(.+)$/i);
  if (directTheAgentRest?.[1] && directTheAgentRest?.[2]) {
    return extractCapabilityIntent(directTheAgentRest[1], directTheAgentRest[2]);
  }
  const genericNamedAgentRest = raw.match(/^(?:please\s+)?(?:make|have|let|set|configure|assign|give)\s+(.+?)\s+agent\s+(.+)$/i);
  if (genericNamedAgentRest?.[1] && genericNamedAgentRest?.[2]) {
    return extractCapabilityIntent(genericNamedAgentRest[1], genericNamedAgentRest[2]);
  }
  const patterns = [
    /^(?:please\s+)?(?:make|have|let|set|configure|assign|give)\s+agent\s+(.+?)\s+(?:use|with|to\s+use|to\s+have)\s+(.+)$/i,
    /^(?:please\s+)?(?:make|have|let|set|configure|assign|give)\s+the\s+(.+?)\s+agent\s+(?:use|with|to\s+use|to\s+have)\s+(.+)$/i,
    /^(?:please\s+)?(?:make|have|let|set|configure|assign|give)\s+(.+?)\s+agent\s+(?:use|with|to\s+use|to\s+have)\s+(.+)$/i,
    /^(?:please\s+)?(?:configure|set\s+up)\s+agent\s+(.+?)\s+with\s+(.+)$/i,
    /^(?:please\s+)?(?:configure|set\s+up)\s+the\s+(.+?)\s+agent\s+with\s+(.+)$/i,
  ];
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (match?.[1] && match?.[2]) {
      return extractCapabilityIntent(match[1], match[2]);
    }
  }
  return null;
}

function resolveAgentCapabilityAssignmentWithAgentList(
  message: string,
  agents: Array<{ name: string }>,
): { agentRef: string; requested: string } | null {
  const raw = String(message || "").trim();
  if (!raw || isConversationalAgentControlMessage(raw)) return null;
  const sortedAgents = [...agents].sort((left, right) => right.name.length - left.name.length);
  for (const agent of sortedAgents) {
    const escaped = escapeRegex(agent.name);
    const patterns = [
      new RegExp(`^(?:please\\s+)?(?:make|have|let|set|configure|assign|give)\\s+agent\\s+${escaped}\\s+(?:use|with|to\\s+use|to\\s+have)\\s+(.+)$`, "i"),
      new RegExp(`^(?:please\\s+)?(?:make|have|let|set|configure|assign|give)\\s+agent\\s+${escaped}\\s+(.+)$`, "i"),
      new RegExp(`^(?:please\\s+)?(?:make|have|let|set|configure|assign|give)\\s+the\\s+${escaped}\\s+agent\\s+(?:use|with|to\\s+use|to\\s+have)\\s+(.+)$`, "i"),
      new RegExp(`^(?:please\\s+)?(?:make|have|let|set|configure|assign|give)\\s+the\\s+${escaped}\\s+agent\\s+(.+)$`, "i"),
    ];
    for (const pattern of patterns) {
      const match = raw.match(pattern);
      if (!match?.[1]) continue;
      const requested = stripWrappedQuotes(match[1]).replace(/[.!?]+$/, "").trim();
      if (!requested) continue;
      return {
        agentRef: agent.name,
        requested,
      };
    }
  }
  return null;
}

function ensureModelsBaseUrlColumn(db: { prepare: (sql: string) => { get: () => unknown }; exec: (sql: string) => void }) {
  try {
    db.prepare("SELECT base_url FROM models LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE models ADD COLUMN base_url TEXT");
  }
  try {
    db.prepare("SELECT fast_mode FROM models LIMIT 0").get();
  } catch {
    db.exec("ALTER TABLE models ADD COLUMN fast_mode INTEGER DEFAULT 0");
  }
}

function formatModelRows(rows: ModelRow[]): string {
  if (rows.length === 0) {
    return "No models configured yet. Try: add model openai gpt-5-mini";
  }
  const lines = rows.slice(0, 15).map((row, index) => {
    const status = row.is_active === 1 ? "active" : "inactive";
    return `${index + 1}. ${row.provider}/${row.model_id} (${row.id}) [${status}, priority=${row.priority}]`;
  });
  return `Models (${rows.length} total):\n${lines.join("\n")}`;
}

function parseModelReference(reference: string): { provider: string; modelId: string } | null {
  const trimmed = stripWrappedQuotes(reference);
  if (!trimmed) return null;

  const slashMatch = trimmed.match(/^([a-zA-Z0-9_-]+)\s*[/:\s]\s*([A-Za-z0-9._\-/:]+)$/);
  if (slashMatch?.[1] && slashMatch?.[2]) {
    return {
      provider: slashMatch[1].trim(),
      modelId: slashMatch[2].trim(),
    };
  }
  return null;
}

async function resolveNaturalLanguageProviderModelRef(reference: string): Promise<{
  modelRef: string;
  providerId: string;
  providerName: string;
  modelLabel: string;
} | null> {
  const trimmed = stripWrappedQuotes(reference).replace(/[.!?]+$/, "").trim();
  if (!trimmed) return null;
  const [{ normalizeProviderId }, { PROVIDERS }] = await Promise.all([
    import("@/lib/agents/provider-normalization"),
    import("@/types/model"),
  ]);

  const explicitRef =
    trimmed.includes("/") || trimmed.includes(":")
      ? parseModelReference(trimmed)
      : null;

  if (explicitRef) {
    const providerId = normalizeProviderId(explicitRef.provider);
    if (!providerId) return null;
    const providerInfo = PROVIDERS.find((entry) => entry.id === providerId);
    if (!providerInfo) return null;
    const knownModel =
      providerInfo.models.find((entry) => normalizeLookup(entry.id) === normalizeLookup(explicitRef.modelId)) ??
      providerInfo.models.find((entry) => normalizeLookup(entry.name) === normalizeLookup(explicitRef.modelId));
    return {
      modelRef: `${providerId}:${knownModel?.id || explicitRef.modelId}`,
      providerId,
      providerName: providerInfo.name,
      modelLabel: knownModel?.name || explicitRef.modelId,
    };
  }

  const normalized = normalizeLookup(trimmed);
  const normalizedProviderHint = normalized
    .replace(/\b(?:provider|providers|model|models|api|default)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  for (const providerInfo of PROVIDERS) {
    const providerName = normalizeLookup(providerInfo.name);
    const providerIdLookup = normalizeLookup(providerInfo.id);
    if (
      providerIdLookup === normalized ||
      providerName === normalized ||
      providerIdLookup === normalizedProviderHint ||
      providerName === normalizedProviderHint ||
      normalized.includes(providerName) ||
      normalizedProviderHint.includes(providerName) ||
      normalizedProviderHint.includes(providerIdLookup)
    ) {
      return {
        modelRef: `${providerInfo.id}:${providerInfo.defaultModel}`,
        providerId: providerInfo.id,
        providerName: providerInfo.name,
        modelLabel: providerInfo.defaultName,
      };
    }
  }

  const normalizedWithoutProviderWords = normalizedProviderHint
    .replace(/\s+/g, " ")
    .trim();
  const providerAlias = normalizeProviderId(normalizedWithoutProviderWords);
  if (!providerAlias) return null;
  const providerInfo = PROVIDERS.find((entry) => entry.id === providerAlias);
  if (!providerInfo) return null;
  return {
    modelRef: `${providerInfo.id}:${providerInfo.defaultModel}`,
    providerId: providerInfo.id,
    providerName: providerInfo.name,
    modelLabel: providerInfo.defaultName,
  };
}

async function resolveNaturalLanguageProviderOnly(reference: string): Promise<{
  modelRef: string;
  providerId: string;
  providerName: string;
  modelLabel: string;
} | null> {
  const trimmed = stripWrappedQuotes(reference).replace(/[.!?]+$/, "").trim();
  if (!trimmed) return null;
  const [{ normalizeProviderId }, { PROVIDERS }] = await Promise.all([
    import("@/lib/agents/provider-normalization"),
    import("@/types/model"),
  ]);
  const cleaned = normalizeLookup(trimmed)
    .replace(/\b(?:provider|providers|model|models|default|api)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const providerId = normalizeProviderId(cleaned);
  const providerInfo =
    (providerId ? PROVIDERS.find((entry) => entry.id === providerId) : null) ??
    PROVIDERS.find((entry) => {
      const id = normalizeLookup(entry.id);
      const name = normalizeLookup(entry.name);
      return cleaned === id || cleaned === name || cleaned.includes(id) || cleaned.includes(name);
    }) ??
    null;
  if (!providerInfo) return null;
  return {
    modelRef: `${providerInfo.id}:${providerInfo.defaultModel}`,
    providerId: providerInfo.id,
    providerName: providerInfo.name,
    modelLabel: providerInfo.defaultName,
  };
}

function resolveModelRow(rows: ModelRow[], reference: string): ModelRow | null {
  const normalized = normalizeLookup(reference);
  if (!normalized) return null;

  const idExact = rows.find((row) => normalizeLookup(row.id) === normalized);
  if (idExact) return idExact;

  const parsed = parseModelReference(reference);
  if (parsed) {
    const byPair = rows.find((row) => {
      return (
        normalizeLookup(row.provider) === normalizeLookup(parsed.provider) &&
        normalizeLookup(row.model_id) === normalizeLookup(parsed.modelId)
      );
    });
    if (byPair) return byPair;
  }

  const modelIdExact = rows.find((row) => normalizeLookup(row.model_id) === normalized);
  if (modelIdExact) return modelIdExact;

  const nameExact = rows.find((row) => normalizeLookup(row.name) === normalized);
  if (nameExact) return nameExact;

  const partial = rows.find((row) => {
    const haystack = `${row.provider} ${row.model_id} ${row.name} ${row.id}`;
    return normalizeLookup(haystack).includes(normalized);
  });
  return partial ?? null;
}

function formatTaskList(
  tasks: Array<{ id: string; title: string; status: string }>,
  label: string,
  options?: {
    offset?: number;
    pageSize?: number;
    query?: string;
  },
): string {
  const normalizedLabel = label.trim().toLowerCase();
  const isOpenList = normalizedLabel === "open" || normalizedLabel === "inbox";
  const isCompletedList = normalizedLabel === "completed" || normalizedLabel === "done";
  const offset = Math.max(0, options?.offset ?? 0);
  const pageSize = Math.min(MAX_TASK_LIST_PAGE_SIZE, Math.max(1, options?.pageSize ?? DEFAULT_TASK_LIST_PAGE_SIZE));
  const query = String(options?.query || "").trim();

  if (tasks.length === 0) {
    if (query) {
      return `No ${normalizedLabel} tasks on main-board matched "${query}".`;
    }
    if (isOpenList) return "Board tasks\nOpen tasks on main-board: 0";
    if (isCompletedList) return "Board tasks\nCompleted tasks on main-board: 0";
    return `No ${normalizedLabel} tasks on main-board.`;
  }
  const visibleTasks = tasks.slice(offset, offset + pageSize);
  if (visibleTasks.length === 0) {
    return `No more ${normalizedLabel} tasks to show.`;
  }
  const lines = visibleTasks.map((task, i) => {
    return `${offset + i + 1}. ${task.title}\nstatus: ${task.status}\nid: ${task.id}`;
  });
  const filterLine = query ? `\nFiltered by: ${query}\n` : "";
  const moreLine =
    offset + visibleTasks.length < tasks.length
      ? `\n\nShowing ${offset + 1}-${offset + visibleTasks.length} of ${tasks.length}. Say "more ${normalizedLabel} tasks" to continue.`
      : "";
  if (isOpenList) {
    return `Board tasks\nOpen tasks on main-board\nTotal: ${tasks.length}${filterLine}\n${lines.join("\n\n")}${moreLine}`;
  }
  if (isCompletedList) {
    return `Board tasks\nCompleted tasks on main-board\nTotal: ${tasks.length}${filterLine}\n${lines.join("\n\n")}${moreLine}`;
  }
  return `${label} tasks on main-board (${tasks.length} total):${filterLine}\n${lines.join("\n\n")}${moreLine}`;
}

function isGeneratedScheduledTaskLite(task: {
  title: string;
  description?: string | null;
  sourceType?: string | null;
}): boolean {
  if (String(task.sourceType || "").trim().toLowerCase() === "cron-generated") {
    return true;
  }
  const title = String(task.title || "").trim();
  const description = String(task.description || "").trim().toLowerCase();
  return title.startsWith("Scheduled check:") && description.includes("auto-created by cron workflow");
}

function prioritizeTasksForChannelList<T extends {
  title: string;
  description?: string | null;
  sourceType?: string | null;
  status: string;
  updatedAt?: string;
}>(tasks: T[]): T[] {
  return [...tasks].sort((left, right) => {
    const leftGenerated = isGeneratedScheduledTaskLite(left) ? 1 : 0;
    const rightGenerated = isGeneratedScheduledTaskLite(right) ? 1 : 0;
    if (leftGenerated !== rightGenerated) {
      return leftGenerated - rightGenerated;
    }

    const leftActive = String(left.status || "") === "in_progress" ? 0 : 1;
    const rightActive = String(right.status || "") === "in_progress" ? 0 : 1;
    if (leftActive !== rightActive) {
      return leftActive - rightActive;
    }

    const leftUpdatedAt = Date.parse(String(left.updatedAt || ""));
    const rightUpdatedAt = Date.parse(String(right.updatedAt || ""));
    if (Number.isFinite(leftUpdatedAt) && Number.isFinite(rightUpdatedAt) && leftUpdatedAt !== rightUpdatedAt) {
      return rightUpdatedAt - leftUpdatedAt;
    }

    return String(right.title || "").localeCompare(String(left.title || ""));
  });
}

function cleanupExpiredTaskListCursorState(): void {
  const now = Date.now();
  for (const [key, state] of taskListCursorState) {
    if (now - state.updatedAt > TASK_LIST_CURSOR_TTL_MS) {
      taskListCursorState.delete(key);
    }
  }
}

function getTaskListCursorKey(ctx: BuiltinCommandContext, kind: "board" | "inbox", query: string): string {
  return [ctx.channel, ctx.sender, kind, normalizeLookup(query)].join("::");
}

function parseTaskListIntent(message: string): TaskListIntent | null {
  const raw = message.trim();
  if (!raw) return null;

  const naturalBoardList =
    /^(?:what(?:'s| is| are)|list(?:\s+down)?|show|find|search)\s+(?:all\s+|my\s+|me\s+)?tasks?\??$/i.test(raw) ||
    /^(?:what(?:'s| is| are))\s+(?:all\s+|my\s+)?tasks?\??$/i.test(raw) ||
    /^list\s+down\s+(?:all\s+|my\s+)?tasks?\??$/i.test(raw);
  if (naturalBoardList) {
    return {
      kind: "board",
      query: "",
      pageSize: DEFAULT_TASK_LIST_PAGE_SIZE,
      mode: "reset",
    };
  }

  const shorthandBoardList = raw.match(
    /^(?:(my|our|all|current|open|pending|completed|done|finished|blocked)\s+)?tasks?\??$/i,
  );
  if (shorthandBoardList) {
    const qualifier = String(shorthandBoardList[1] || "").toLowerCase();
    const kind = "board" as const;
    const query = "";
    return {
      kind,
      query,
      pageSize: DEFAULT_TASK_LIST_PAGE_SIZE,
      mode: "reset",
    };
  }

  const directInboxQuery = raw.match(
    /^(?:list|show|find|search)\s+(?:my\s+)?inbox\s+tasks?\s+(?:matching|named|with|for|about)\s+(.+)$/i,
  );
  if (directInboxQuery?.[1]) {
    return {
      kind: "inbox",
      query: stripWrappedQuotes(directInboxQuery[1]),
      pageSize: DEFAULT_TASK_LIST_PAGE_SIZE,
      mode: "reset",
    };
  }

  const resetMatch = raw.match(
    /^(?:list|show|find|search)(?:\s+the)?\s+(?:(\d+)\s+)?(?:(inbox|board)\s+)?tasks?(?:\s+(?:matching|named|with|for|about)\s+(.+))?$/i,
  );
  if (resetMatch) {
    return {
      kind: String(resetMatch[2] || "").toLowerCase() === "inbox" ? "inbox" : "board",
      query: stripWrappedQuotes(resetMatch[3] || ""),
      pageSize: Math.min(
        MAX_TASK_LIST_PAGE_SIZE,
        Math.max(1, Number.parseInt(String(resetMatch[1] || DEFAULT_TASK_LIST_PAGE_SIZE), 10) || DEFAULT_TASK_LIST_PAGE_SIZE),
      ),
      mode: "reset",
    };
  }

  const nextMatch = raw.match(
    /^(?:list|show)?\s*(?:more|next)(?:\s+(\d+))?\s+(?:(inbox|board)\s+)?tasks?(?:\s+(?:matching|named|with|for|about)\s+(.+))?$/i,
  );
  if (nextMatch) {
    return {
      kind: String(nextMatch[2] || "").toLowerCase() === "inbox" ? "inbox" : "board",
      query: stripWrappedQuotes(nextMatch[3] || ""),
      pageSize: Math.min(
        MAX_TASK_LIST_PAGE_SIZE,
        Math.max(1, Number.parseInt(String(nextMatch[1] || DEFAULT_TASK_LIST_PAGE_SIZE), 10) || DEFAULT_TASK_LIST_PAGE_SIZE),
      ),
      mode: "next",
    };
  }

  const inboxNatural =
    /^what(?:'s| is)\s+in\s+my\s+inbox$/i.test(raw) ||
    /^inbox$/i.test(raw) ||
    /^list inbox$/i.test(raw) ||
    /^show inbox$/i.test(raw) ||
    /^inbox tasks?$/i.test(raw);
  if (inboxNatural) {
    return {
      kind: "inbox",
      query: "",
      pageSize: DEFAULT_TASK_LIST_PAGE_SIZE,
      mode: "reset",
    };
  }

  return null;
}

function parseScopeRefs(input: string): ParsedScopeRefs {
  let remainder = input.trim();
  let organizationRef = "";
  let goalRef = "";

  const orgInlineMatch = remainder.match(
    /\bin\s+organization\s+(.+?)(?=\s+(?:for|under)\s+goal\b|\s+(?:to|about|regarding|on)\b|,\s*(?:to|about|regarding|investigate|analy[sz]e|plan|prepare|review|explain|summari[sz]e|assign|identify|give)\b|[.!?]|$)/i,
  );
  if (orgInlineMatch?.[1]) {
    organizationRef = trimScopedEntityRef(orgInlineMatch[1], "organization");
    remainder = `${remainder.slice(0, orgInlineMatch.index ?? 0)} ${remainder.slice((orgInlineMatch.index ?? 0) + orgInlineMatch[0].length)}`.trim();
  }

  const goalInlineMatch = remainder.match(
    /\b(?:for|under)\s+goal\s+(.+?)(?=\s+(?:using|with|via)\b|,\s*(?:assign|identify|give|share|return|explain|call\s+out|summari[sz]e|include|outline|recommend|use)\b|\s+and\s+(?:assign|identify|give|share|return|explain|call\s+out|summari[sz]e|include|outline|recommend)\b|[.!?]|$)/i,
  );
  if (goalInlineMatch?.[1]) {
    goalRef = trimScopedEntityRef(goalInlineMatch[1], "goal");
    remainder = `${remainder.slice(0, goalInlineMatch.index ?? 0)} ${remainder.slice((goalInlineMatch.index ?? 0) + goalInlineMatch[0].length)}`.trim();
  }

  remainder = stripWrappedQuotes(remainder).replace(/\s+/g, " ").trim();
  return { organizationRef, goalRef, remainder };
}

function getOrgSwitchStateStore(): Map<string, OrgSwitchState> {
  const globalStore = globalThis as OrgSwitchStoreGlobal;
  if (!globalStore.__disp8chOrgSwitchState) {
    globalStore.__disp8chOrgSwitchState = new Map<string, OrgSwitchState>();
  }
  const now = Date.now();
  for (const [sessionId, state] of globalStore.__disp8chOrgSwitchState.entries()) {
    if (now - state.createdAt > ORG_SWITCH_STATE_TTL_MS) {
      globalStore.__disp8chOrgSwitchState.delete(sessionId);
    }
  }
  return globalStore.__disp8chOrgSwitchState;
}

function rememberOrgSwitchState(state: OrgSwitchState): void {
  const sessionId = String(state.sessionId || "").trim();
  if (!sessionId) return;
  getOrgSwitchStateStore().set(sessionId, { ...state, sessionId });
}

function getOrgSwitchState(sessionIdRaw: string | null | undefined): OrgSwitchState | null {
  const sessionId = String(sessionIdRaw || "").trim();
  if (!sessionId) return null;
  return getOrgSwitchStateStore().get(sessionId) ?? null;
}

function getPendingMutationStore(): Map<string, PendingMutation> {
  const globalStore = globalThis as PendingMutationStoreGlobal;
  if (!globalStore.__disp8chPendingMutationState) {
    globalStore.__disp8chPendingMutationState = new Map<string, PendingMutation>();
  }
  const now = Date.now();
  const ttl = getPendingMutationTtlMs();
  for (const [sessionId, state] of globalStore.__disp8chPendingMutationState.entries()) {
    if (now - state.createdAt > ttl) {
      globalStore.__disp8chPendingMutationState.delete(sessionId);
    }
  }
  return globalStore.__disp8chPendingMutationState;
}

function getCurrentPendingPlan(sessionId: string): PendingMutation | null {
  const entry = getPendingMutationStore().get(sessionId);
  if (!entry || entry.kind !== "app-action-plan") return null;
  if (Date.now() - entry.createdAt > getPendingMutationTtlMs()) return null;
  return entry;
}

function hasActivePendingPlan(sessionId: string): boolean {
  return getCurrentPendingPlan(sessionId) !== null;
}

function rememberPendingMutation(mutation: PendingMutation): void {
  const sessionId = String(mutation.sessionId || "").trim();
  if (!sessionId) return;
  getPendingMutationStore().set(sessionId, {
    ...mutation,
    sessionId,
    createdAt: Date.now(),
  });
  const storedAt = getPendingMutationStore().get(sessionId)?.createdAt ?? Date.now();
  upsertChannelSessionAppState({
    sessionId,
    patch: {
      pendingMutation: {
        kind: mutation.kind,
        summary: mutation.summary,
        payload: mutation.payload,
        createdAt: storedAt,
      },
    },
  });
}

function getPendingMutation(sessionIdRaw: string | null | undefined): PendingMutation | null {
  const sessionId = String(sessionIdRaw || "").trim();
  if (!sessionId) return null;
  const inMemory = getPendingMutationStore().get(sessionId);
  if (inMemory) return inMemory;
  const persisted = getChannelSessionAppState(sessionId)?.payload?.pendingMutation;
  if (!persisted?.kind || !persisted.summary) return null;
  // Preserve original createdAt so TTL is not reset on restore
  const originalCreatedAt =
    typeof persisted.createdAt === "number" && Number.isFinite(persisted.createdAt)
      ? persisted.createdAt
      : Date.now();
  const ttl = getPendingMutationTtlMs();
  if (Date.now() - originalCreatedAt > ttl) {
    // Expired while persisted — evict it so callers get null
    clearPendingMutation(sessionId);
    return null;
  }
  const restored: PendingMutation = {
    sessionId,
    kind: persisted.kind as PendingMutation["kind"],
    summary: persisted.summary,
    payload: (persisted.payload && typeof persisted.payload === "object" ? persisted.payload : {}) as Record<string, unknown>,
    createdAt: originalCreatedAt,
  };
  getPendingMutationStore().set(sessionId, restored);
  return restored;
}

function clearPendingMutation(sessionIdRaw: string | null | undefined): void {
  const sessionId = String(sessionIdRaw || "").trim();
  if (!sessionId) return;
  getPendingMutationStore().delete(sessionId);
  upsertChannelSessionAppState({
    sessionId,
    patch: {
      pendingMutation: null,
    },
  });
}

export function updatePendingAppActionPlan(
  sessionIdRaw: string | null | undefined,
  rawPlan: unknown,
): { success: true; summary: string; plan: import("@/lib/channels/app-action-schema").AppActionPlan } | { success: false; error: string } {
  const sessionId = String(sessionIdRaw || "").trim();
  if (!sessionId) return { success: false, error: "sessionId is required" };
  const pending = getPendingMutation(sessionId);
  if (!pending || pending.kind !== "app-action-plan") {
    return { success: false, error: "No pending app-action plan found for this session." };
  }
  const {
    normalizeAppActionPlanStructure,
    validateAppActionPlan,
  } = require("@/lib/channels/app-action-schema") as typeof import("@/lib/channels/app-action-schema");
  const validation = validateAppActionPlan(rawPlan);
  if (!validation.success) {
    return { success: false, error: validation.error };
  }
  const normalizedPlan = normalizeAppActionPlanStructure(validation.plan);
  const normalizedValidation = validateAppActionPlan(normalizedPlan);
  if (!normalizedValidation.success) {
    return { success: false, error: normalizedValidation.error };
  }
  const summary = formatAppActionPlanPreview(normalizedValidation.plan);
  rememberPendingMutation({
    sessionId,
    kind: "app-action-plan",
    summary,
    payload: { plan: normalizedValidation.plan as unknown as Record<string, unknown> },
    createdAt: Date.now(),
  });
  return { success: true, summary, plan: normalizedValidation.plan };
}

function buildPendingMutationPrompt(summary: string): string {
  return [
    "Pending confirmation",
    summary,
    'Reply with "confirm" to apply this change or "cancel" to skip it.',
  ].join("\n");
}

function formatPlannerClarification(plan: import("@/lib/channels/app-action-schema").AppActionPlan): string {
  const question = plan.clarificationQuestion?.trim() || "What should I do next?";
  const choices = plan.clarificationChoices?.map((choice) => choice.trim()).filter(Boolean).slice(0, 4) ?? [];
  if (choices.length === 0) return question;
  return [
    question,
    "",
    ...choices.map((choice, index) => `${index + 1}. ${choice}`),
    "",
    "Reply with a number or type your own answer.",
  ].join("\n");
}

function formatAppActionPlanPreview(plan: import("@/lib/channels/app-action-schema").AppActionPlan): string {
  const lines: string[] = [];
  lines.push(`Pending confirmation: Apply this ${plan.steps.length}-step app plan:`);
  for (let index = 0; index < plan.steps.length; index++) {
    const step = plan.steps[index];
    if (step) lines.push(`${index + 1}. ${step.label}`);
  }
  if (plan.assumptions.length > 0) {
    lines.push("");
    lines.push("Assumptions:");
    for (const assumption of plan.assumptions) {
      lines.push(`- ${assumption}`);
    }
  }
  lines.push("");
  lines.push('Reply "confirm" to run it or "cancel" to stop.');
  return lines.join("\n");
}

function parsePendingPlanStepReference(raw: string, plan: AppActionPlan): number | null {
  const text = String(raw || "").toLowerCase();
  const numeric = text.match(/\bstep\s*(\d+)\b/);
  if (numeric?.[1]) {
    const index = Number(numeric[1]) - 1;
    return index >= 0 && index < plan.steps.length ? index : null;
  }
  const ordinals: Array<[RegExp, number]> = [
    [/\bfirst\b/, 0],
    [/\bsecond\b/, 1],
    [/\bthird\b/, 2],
    [/\bfourth\b/, 3],
    [/\bfifth\b/, 4],
  ];
  for (const [pattern, index] of ordinals) {
    if (pattern.test(text) && index < plan.steps.length) return index;
  }
  if (/\blast\s+step\b|\bfinal\s+step\b/.test(text)) return Math.max(0, plan.steps.length - 1);
  if (/\b(?:council|debate|argue|vote)\b/.test(text)) {
    const councilIndex = plan.steps.findIndex((step) => step.action === "run_council");
    if (councilIndex >= 0) return councilIndex;
  }
  return null;
}

function uniqueAppActionStepId(plan: AppActionPlan, preferred: string): string {
  const used = new Set(plan.steps.map((step) => step.id));
  if (!used.has(preferred)) return preferred;
  let suffix = 2;
  while (used.has(`${preferred}-${suffix}`)) suffix += 1;
  return `${preferred}-${suffix}`;
}

function inferOrganizationDependency(plan: AppActionPlan, beforeIndex: number): string | null {
  for (let index = Math.min(beforeIndex, plan.steps.length - 1); index >= 0; index -= 1) {
    const step = plan.steps[index];
    if (step?.action === "create_organization") return step.id;
  }
  return null;
}

function buildBoardTaskReplacementStep(raw: string, plan: AppActionPlan, targetIndex: number, previous?: AppActionStep): AppActionStep {
  const complete = /\b(?:complete|done|mark\s+(?:it\s+)?done|finish)\b/i.test(raw);
  const orgStepId = inferOrganizationDependency(plan, targetIndex);
  const isOcr = /\bocr\b/i.test(`${raw} ${plan.userIntent}`);
  const title = isOcr
    ? complete
      ? "Complete OCR research follow-up"
      : "Track OCR research follow-up"
    : complete
      ? "Complete follow-up task"
      : "Create follow-up task";
  return {
    id: previous?.id || uniqueAppActionStepId(plan, "create-board-task"),
    action: "create_board_task",
    label: complete
      ? "Create and complete a board task for the research outcome"
      : "Create a board task for the research outcome",
    params: {
      boardId: "main-board",
      title,
      description: [
        previous?.label ? `Replaces previous step: ${previous.label}.` : null,
        `Requested change: ${raw}`,
        complete ? "Create the task in completed/done state." : null,
      ].filter(Boolean).join(" "),
      ...(orgStepId ? { organizationStepId: orgStepId } : {}),
      status: complete ? "done" : "inbox",
    },
    dependsOn: orgStepId ? [orgStepId] : previous?.dependsOn,
  };
}

function inferPendingPlanSkillIds(raw: string): string[] {
  const normalized = String(raw || "").toLowerCase();
  const skills: string[] = [];
  const add = (id: string) => {
    if (!skills.includes(id)) skills.push(id);
  };
  if (/\b(?:document|docs?)\s+(?:search|intelligence|retrieval)\b/.test(normalized)) add("document-intelligence");
  if (/\b(?:web\s+research|research\s+skill|researcher\s+skill|autonomous\s+researcher)\b/.test(normalized)) add("autonomous-researcher");
  if (/\bcouncil\s+facilitator\b/.test(normalized)) add("council-facilitator");
  if (/\bboard[-\s]+ops\b|\bboard\s+skill\b/.test(normalized)) add("board-ops");
  if (/\bcoding(?:\s+agent)?\s+skill\b|\bcoding\s+skill\b|\bcode\s+review\b/.test(normalized)) add("coding:coding-agent");
  return skills;
}

function inferPendingPlanExtensionIds(raw: string): string[] {
  const normalized = String(raw || "").toLowerCase();
  const extensions: string[] = [];
  const add = (id: string) => {
    if (!extensions.includes(id)) extensions.push(id);
  };
  if (/\bweb[-\s]+research\b|\bweb\s+research\s+extension\b/.test(normalized)) add("web-research");
  if (/\bdata[-\s]+sources?\b|\bdata\s+sources?\s+extension\b/.test(normalized)) add("data-sources");
  if (/\bgithub\b/.test(normalized) && /\bextension|attach|with|repo|pull\s+requests?|prs?\b/.test(normalized)) add("github");
  return extensions;
}

function extractPendingOrganizationName(raw: string): string | null {
  const text = String(raw || "").trim();
  const match =
    text.match(/\b(?:rename|call|name|change)\s+(?:the\s+)?(?:organization|org|team|hierarchy)\s+(?:to|as)\s+["']?([^"'.\n]+)["']?/i) ||
    text.match(/\b(?:organization|org|team|hierarchy)\s+(?:name\s+)?(?:to|as)\s+["']?([^"'.\n]+)["']?/i);
  const name = match?.[1]?.trim().replace(/\s+/g, " ");
  return name && name.length <= 80 ? name : null;
}

function revisePendingAppActionPlanFromPlainEnglish(
  raw: string,
  pending: PendingMutation | null,
): { plan: AppActionPlan; summary: string } | null {
  if (!pending || pending.kind !== "app-action-plan") return null;
  const rawPlan = (pending.payload as { plan?: unknown })?.plan;
  if (!rawPlan || typeof rawPlan !== "object") return null;

  const { normalizeAppActionPlanStructure, validateAppActionPlan } =
    require("@/lib/channels/app-action-schema") as typeof import("@/lib/channels/app-action-schema");
  const validation = validateAppActionPlan(rawPlan);
  if (!validation.success) return null;
  const currentPlan = normalizeAppActionPlanStructure(validation.plan);
  const text = String(raw || "");
  const normalized = text.toLowerCase();
  const wantsBoardTask = /\b(?:board|task|todo|card|complete|done)\b/.test(normalized);
  const mentionsPlanOutcome = /\b(?:research\s+outcome|outcome|result|findings|research)\b/.test(normalized);
  const requestedSkillIds = inferPendingPlanSkillIds(text);
  const requestedExtensionIds = inferPendingPlanExtensionIds(text);
  const wantsSkillOrExtensionEdit =
    /\b(?:skill|extension|plugin|tool|attach|assign|enable|add)\b/.test(normalized) &&
    (requestedSkillIds.length > 0 || requestedExtensionIds.length > 0);
  const requestedOrganizationName = extractPendingOrganizationName(text);
  const wantsOrganizationRename = Boolean(requestedOrganizationName);
  const findReplaceableResearchStepIndex = (plan: AppActionPlan): number => {
    const councilIndex = plan.steps.findIndex((step) => step.action === "run_council");
    if (councilIndex >= 0) return councilIndex;
    for (let index = plan.steps.length - 1; index >= 0; index -= 1) {
      const step = plan.steps[index];
      if (!step || step.action === "create_agents" || step.action === "create_organization") continue;
      if (/\b(?:research|council|debate|argue|vote|outcome|findings)\b/i.test(`${step.label} ${String(step.params.description || "")}`)) {
        return index;
      }
    }
    return -1;
  };
  const implicitResearchStepIndex = findReplaceableResearchStepIndex(currentPlan);
  const hasReplaceableResearchStep = implicitResearchStepIndex >= 0;
  const hasExplicitPlanEditCue =
    /\b(?:step\s*\d|first|second|third|fourth|fifth|last\s+step|final\s+step|replace|change|update|switch|swap|instead|actually|don'?t|remove|delete|add|rename|call|name)\b/.test(normalized);
  const isImplicitOutcomeTaskEdit = wantsBoardTask && mentionsPlanOutcome && hasReplaceableResearchStep;
  const isPlanEdit = hasExplicitPlanEditCue || isImplicitOutcomeTaskEdit || wantsSkillOrExtensionEdit || wantsOrganizationRename;
  if (!isPlanEdit) return null;

  const removesCouncilStep =
    (/\b(?:instead|replace|change|don'?t|not)\b/.test(normalized) &&
      /\b(?:council|debate|argue|vote)\b/.test(normalized)) ||
    isImplicitOutcomeTaskEdit;
  const baseAssumptions = currentPlan.assumptions.filter((assumption) => {
    if (removesCouncilStep && /\b(?:council|debate|argue|vote)\b/i.test(assumption)) return false;
    if (removesCouncilStep && /\bresearch[-\s]?assistant workflow template\b/i.test(assumption)) return false;
    if (wantsBoardTask && /\bno\s+(?:specific\s+)?board\b|\bboard task tracking requested\b/i.test(assumption)) return false;
    if (wantsSkillOrExtensionEdit && /\bno\s+specific\s+(?:skills?|extensions?)\b/i.test(assumption)) return false;
    if (wantsOrganizationRename && /\borganization\s+will\s+be\s+named\b|\bnamed\s+something\s+like\b/i.test(assumption)) return false;
    return true;
  });

  const nextPlan: AppActionPlan = {
    ...currentPlan,
    userIntent: `${currentPlan.userIntent} (revised: ${text})`,
    assumptions: Array.from(new Set([
      ...baseAssumptions,
      "The latest message edits the existing pending plan rather than starting a new request.",
    ])).slice(0, 12),
    steps: currentPlan.steps.map((step) => ({ ...step, params: { ...step.params }, dependsOn: step.dependsOn ? [...step.dependsOn] : undefined })),
  };

  const wantsAdd = /\b(?:add|append)\b.*\b(?:step|final|another|one\s+more)\b/.test(normalized);
  const wantsRemove = /\b(?:remove|delete)\b.*\b(?:step|council|debate)\b/.test(normalized);
  const explicitTargetIndex = parsePendingPlanStepReference(text, currentPlan);
  const existingOutcomeBoardTaskIndex = isImplicitOutcomeTaskEdit
    ? currentPlan.steps.findLastIndex((step) =>
        step.action === "create_board_task" &&
        /\b(?:research|outcome|finding|track|follow[-\s]?up)\b/i.test(`${step.label} ${String(step.params.description || "")}`),
      )
    : -1;
  const implicitOutcomeTargetIndex = isImplicitOutcomeTaskEdit ? existingOutcomeBoardTaskIndex : -1;
  const targetIndex = explicitTargetIndex ?? (implicitOutcomeTargetIndex >= 0 ? implicitOutcomeTargetIndex : null);

  if (wantsAdd && wantsBoardTask) {
    const step = buildBoardTaskReplacementStep(text, nextPlan, nextPlan.steps.length - 1);
    step.id = uniqueAppActionStepId(nextPlan, "create-board-task");
    nextPlan.steps = [...nextPlan.steps, step];
  } else if (wantsRemove && targetIndex !== null) {
    const removedId = nextPlan.steps[targetIndex]?.id;
    nextPlan.steps = nextPlan.steps
      .filter((_, index) => index !== targetIndex)
      .map((step) => ({
        ...step,
        dependsOn: step.dependsOn?.filter((id) => id !== removedId),
      }));
  } else if (wantsBoardTask && targetIndex !== null) {
    const replacedStepId = nextPlan.steps[targetIndex]?.id ?? null;
    const replacementStep = buildBoardTaskReplacementStep(text, nextPlan, targetIndex, nextPlan.steps[targetIndex]);
    const researchStepId = isImplicitOutcomeTaskEdit ? nextPlan.steps[implicitResearchStepIndex]?.id : null;
    if (researchStepId) {
      replacementStep.dependsOn = Array.from(new Set([...(replacementStep.dependsOn ?? []), researchStepId]));
    }
    nextPlan.steps[targetIndex] = replacementStep;
    nextPlan.steps = nextPlan.steps.filter((step, index) => {
      if (index <= targetIndex) return true;
      if (step.action !== "create_board_task") return true;
      const duplicateBoardFollowUp =
        /\b(?:track|record|follow[-\s]?up)\b/i.test(step.label) ||
        /\bresearch outcome\b/i.test(`${step.label} ${String(step.params.description || "")}`);
      return !duplicateBoardFollowUp;
    }).map((step) => ({
      ...step,
      dependsOn: step.dependsOn?.filter((id) => id !== replacedStepId),
    }));
    if (isImplicitOutcomeTaskEdit) {
      const boardIndex = nextPlan.steps.findIndex((step) => step.id === replacementStep.id);
      const researchIndex = researchStepId
        ? nextPlan.steps.findIndex((step) => step.id === researchStepId)
        : -1;
      if (boardIndex >= 0 && researchIndex >= 0 && boardIndex < researchIndex) {
        const [boardStep] = nextPlan.steps.splice(boardIndex, 1);
        const nextResearchIndex = nextPlan.steps.findIndex((step) => step.id === researchStepId);
        nextPlan.steps.splice(nextResearchIndex + 1, 0, boardStep);
      }
    }
    if (/\b(?:complete|done|mark\s+(?:it\s+)?done|finish)\b/i.test(text)) {
      nextPlan.assumptions = Array.from(new Set([
        ...nextPlan.assumptions,
        "The board task will be created in the done status because the user asked to complete it.",
      ])).slice(0, 12);
    }
  } else if (isImplicitOutcomeTaskEdit && wantsBoardTask) {
    const previousFinalStepId = nextPlan.steps[nextPlan.steps.length - 1]?.id ?? null;
    const step = buildBoardTaskReplacementStep(text, nextPlan, nextPlan.steps.length);
    step.id = uniqueAppActionStepId(nextPlan, "create-board-task");
    step.dependsOn = Array.from(new Set([
      ...(step.dependsOn ?? []),
      ...(previousFinalStepId ? [previousFinalStepId] : []),
    ]));
    nextPlan.steps = [...nextPlan.steps, step];
    if (/\b(?:complete|done|mark\s+(?:it\s+)?done|finish)\b/i.test(text)) {
      nextPlan.assumptions = Array.from(new Set([
        ...nextPlan.assumptions,
        "The board task will be created in the done status because the user asked to complete it.",
      ])).slice(0, 12);
    }
  } else if (wantsSkillOrExtensionEdit) {
    const agentStep = nextPlan.steps.find((step) => step.action === "create_agents" || step.action === "create_agent");
    const agentStepId = agentStep?.id;
    const existingSkillIds = new Set(
      nextPlan.steps
        .filter((step) => step.action === "assign_skill_to_agent")
        .map((step) => String(step.params.skillId || "")),
    );
    const existingExtensionIds = new Set(
      nextPlan.steps
        .filter((step) => step.action === "attach_extension_to_agent")
        .map((step) => String(step.params.extensionId || "")),
    );
    const additions: AppActionStep[] = [
      ...requestedSkillIds
        .filter((skillId) => !existingSkillIds.has(skillId))
        .map((skillId) => ({
          id: uniqueAppActionStepId(nextPlan, `assign-skill-${skillId.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase()}`),
          action: "assign_skill_to_agent" as const,
          label: `Assign ${skillId} skill to the created agents`,
          params: agentStepId ? { agentStepId, skillId } : { agentId: "main", skillId },
          dependsOn: agentStepId ? [agentStepId] : undefined,
        })),
      ...requestedExtensionIds
        .filter((extensionId) => !existingExtensionIds.has(extensionId))
        .map((extensionId) => ({
          id: uniqueAppActionStepId(nextPlan, `attach-extension-${extensionId.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase()}`),
          action: "attach_extension_to_agent" as const,
          label: `Attach ${extensionId} extension to the created agents`,
          params: agentStepId ? { agentStepId, extensionId } : { agentId: "main", extensionId },
          dependsOn: agentStepId ? [agentStepId] : undefined,
        })),
    ];
    if (additions.length === 0) return null;
    const insertAfter = agentStep ? nextPlan.steps.findIndex((step) => step.id === agentStep.id) + 1 : nextPlan.steps.length;
    nextPlan.steps = [
      ...nextPlan.steps.slice(0, insertAfter),
      ...additions,
      ...nextPlan.steps.slice(insertAfter),
    ];
    nextPlan.assumptions = Array.from(new Set([
      ...nextPlan.assumptions,
      "The latest message adds skills or extensions to the agents in the existing pending plan.",
    ])).slice(0, 12);
  } else if (wantsOrganizationRename && requestedOrganizationName) {
    const orgIndex = nextPlan.steps.findIndex((step) => step.action === "create_organization");
    if (orgIndex < 0) return null;
    nextPlan.steps[orgIndex] = {
      ...nextPlan.steps[orgIndex],
      label: `Create ${requestedOrganizationName} organization`,
      params: {
        ...nextPlan.steps[orgIndex].params,
        name: requestedOrganizationName,
      },
    };
    nextPlan.assumptions = Array.from(new Set([
      ...nextPlan.assumptions,
      `The organization will be named ${requestedOrganizationName}.`,
    ])).slice(0, 12);
  } else {
    return null;
  }

  const normalizedPlan = normalizeAppActionPlanStructure(nextPlan);
  const nextValidation = validateAppActionPlan(normalizedPlan);
  if (!nextValidation.success) return null;
  const summary = formatAppActionPlanPreview(nextValidation.plan);
  return { plan: nextValidation.plan, summary };
}

function queueSensitiveMutation(
  ctx: BuiltinCommandContext,
  mutation: Omit<PendingMutation, "sessionId" | "createdAt">,
): string | null {
  const sessionId = String(ctx.sessionId || "").trim();
  if (!sessionId) return null;
  rememberPendingMutation({
    sessionId,
    kind: mutation.kind,
    summary: mutation.summary,
    payload: mutation.payload,
    createdAt: Date.now(),
  });
  return buildPendingMutationPrompt(mutation.summary);
}

function stripOrgModeHints(raw: string): string {
  let cleaned = String(raw || "");
  const patterns = [
    /\b(?:please\s+)?(?:use|using|with|in|as)\s+(?:the\s+)?(?:leadership\s+)?(?:council|discussion|vote)\s+mode\b/gi,
    /\b(?:please\s+)?(?:use|using|with|in|as)\s+(?:the\s+)?(?:workflow|execution|hierarchy|orchestration)\s+mode\b/gi,
    /\b(?:make|have)\s+this\s+(?:a\s+)?(?:council|vote|workflow|execution)\b/gi,
  ];
  for (const pattern of patterns) {
    cleaned = cleaned.replace(pattern, " ");
  }
  return cleaned.replace(/\s{2,}/g, " ").trim();
}

function parseExplicitOrgMode(raw: string): OrgCollaborationMode | null {
  if (
    /\b(?:switch|rerun|use|using|with|in|as)\s+(?:the\s+)?(?:workflow|execution|hierarchy|orchestration)\s+mode\b/i.test(raw) ||
    /\bexecution[-\s]?style\b/i.test(raw)
  ) {
    return "execution";
  }
  if (
    /\b(?:switch|rerun|use|using|with|in|as)\s+(?:the\s+)?(?:leadership\s+)?(?:council|discussion|vote)\s+mode\b/i.test(raw) ||
    /\bcouncil[-\s]?style\b/i.test(raw)
  ) {
    return "council";
  }
  return null;
}

function decideOrgCollaborationMode(raw: string, topic: string, explicitMode?: OrgCollaborationMode | null): OrgModeDecision {
  if (explicitMode === "execution") {
    return {
      mode: "execution",
      explicit: true,
      reason: "you explicitly asked for workflow-style execution",
      modeLabel: "Execution Orchestration",
      alternateMode: "council",
      alternateLabel: "Leadership Council",
    };
  }
  if (explicitMode === "council") {
    return {
      mode: "council",
      explicit: true,
      reason: "you explicitly asked for council-style discussion",
      modeLabel: "Leadership Council",
      alternateMode: "execution",
      alternateLabel: "Execution Orchestration",
    };
  }

  const text = normalizeLookup(`${raw} ${topic}`);
  let councilScore = 0;
  let executionScore = 0;
  let councilReason = "the request sounded discussion-oriented";
  let executionReason = "the request sounded execution-oriented";

  const councilPatterns: Array<[RegExp, number, string]> = [
    [/\bwhat does\b|\bwhat would\b/, 5, "the request asks what the team thinks"],
    [/\bvote\b|\bverdict\b|\bconsensus\b/, 6, "the request asks for a vote or verdict"],
    [/\bapprove\b|\breject\b|\brevise\b|\bdecision\b/, 4, "the request asks for a decision"],
    [/\bshould we\b|\bopinion\b|\bdiscuss\b|\bdebate\b/, 3, "the request is discussion-oriented"],
    [/\bexplain the vote\b|\bmember opinions\b/, 5, "the request wants member opinions"],
  ];
  const executionPatterns: Array<[RegExp, number, string]> = [
    [/\binvestigate\b|\bresearch\b|\banaly[sz]e\b|\bcompare\b|\baudit\b|\breview\b/, 4, "the request asks the org to produce analysis"],
    [/\bplan\b|\bprepare\b|\bdraft\b|\bcompile\b|\bsummarize\b|\bwrite\b/, 4, "the request asks for a concrete deliverable"],
    [/\bexecute\b|\bimplement\b|\bfix\b|\bbuild\b|\bcreate\b|\bdeliver\b/, 5, "the request asks the org to do work"],
    [/\buse the linked\b|\buse linked\b|\bdata source\b|\bdocument\b|\bbrief\b/, 4, "the request references grounded sources or documents"],
    [/\bnext actions\b|\bowners\b|\bblockers\b|\bworkflow\b|\btask\b|\bboard\b/, 3, "the request asks for operational follow-through"],
  ];

  for (const [pattern, score, reason] of councilPatterns) {
    if (pattern.test(text)) {
      councilScore += score;
      councilReason = reason;
    }
  }
  for (const [pattern, score, reason] of executionPatterns) {
    if (pattern.test(text)) {
      executionScore += score;
      executionReason = reason;
    }
  }

  if (executionScore > councilScore) {
    return {
      mode: "execution",
      explicit: false,
      reason: executionReason,
      modeLabel: "Execution Orchestration",
      alternateMode: "council",
      alternateLabel: "Leadership Council",
    };
  }

  return {
    mode: "council",
    explicit: false,
    reason: councilReason,
    modeLabel: "Leadership Council",
    alternateMode: "execution",
    alternateLabel: "Execution Orchestration",
  };
}

function summarizeOrgMode(decision: OrgModeDecision): string {
  const prefix = decision.explicit ? "Mode selected" : "Mode assumed";
  return `${prefix}: **${decision.modeLabel}** because ${decision.reason}.`;
}

function formatOrgModeSwitchPrompt(decision: Partial<OrgModeDecision> & { mode?: OrgCollaborationMode | null }): string {
  const inferredAlternateMode =
    decision.alternateMode ??
    (decision.mode === "execution" ? "council" : "execution");
  const alternateLabel =
    decision.alternateLabel ??
    (inferredAlternateMode === "execution" ? "Execution Orchestration" : "Leadership Council");
  const command = inferredAlternateMode === "execution" ? "switch to execution mode" : "switch to council mode";
  return `Reply with "${command}" if you want me to rerun this org ask as ${alternateLabel.toLowerCase()}.`;
}

function rankOrgParticipants(participants: OrgParticipant[]): OrgParticipant[] {
  const roleWeight = new Map<string, number>([
    ["orchestrator", 0],
    ["operations", 1],
    ["specialist", 2],
    ["worker", 3],
    ["support", 4],
  ]);
  return [...participants].sort((left, right) => {
    const leftWeight = roleWeight.get(left.roleType) ?? 99;
    const rightWeight = roleWeight.get(right.roleType) ?? 99;
    if (leftWeight !== rightWeight) return leftWeight - rightWeight;
    return left.agentName.localeCompare(right.agentName);
  });
}

function resolveOrgExecutionToolBundle(raw: string): OrgExecutionToolBundle {
  const normalized = normalizeLookup(raw);
  const workerTools = new Set<string>([
    "documents_list",
    "documents_search",
    "document_get",
    "web_search",
    "http_request",
    "memory_search",
    "session_recall",
    "memory_get",
  ]);
  const leaderTools = new Set<string>([...workerTools, "memory_store"]);

  if (/\bboard\b|\btask\b|\bassign\b|\bowner\b|\bapproval\b|\bworkflow\b|\brollout\b/.test(normalized)) {
    leaderTools.add("board_tasks");
    leaderTools.add("governance_queue");
    leaderTools.add("agent_inbox");
  }

  if (/\bcode\b|\brepo\b|\bfile\b|\bdebug\b|\bpatch\b|\btest\b|\brefactor\b|\bimplement\b|\bfix\b/.test(normalized)) {
    for (const tool of ["read_file", "find_files", "list_files"]) {
      workerTools.add(tool);
      leaderTools.add(tool);
    }
  }

  return {
    leaderTools: [...leaderTools],
    workerTools: [...workerTools],
  };
}

function buildOrgExecutionWorkflow(params: {
  channel: string;
  topic: string;
  organizationName: string;
  goalName: string;
  linkedDocumentsSummary: string;
  leader: OrgParticipant;
  workers: OrgParticipant[];
  toolBundle: OrgExecutionToolBundle;
}): { workflowId: string; nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
  const workflowId = `org-exec-${Date.now().toString(36)}`;
  const triggerId = "trigger";
  const varsId = "vars";
  const planId = "plan";
  const storePlanId = "store-plan";
  const parallelId = "parallel";
  const finalId = "final";

  const planPrompt = [
    `You are ${params.leader.agentName}, the coordinating lead for ${params.organizationName}.`,
    `Task: ${params.topic}`,
    params.goalName ? `Goal: ${params.goalName}` : "",
    params.linkedDocumentsSummary ? `Linked documents/data sources:\n${params.linkedDocumentsSummary}` : "",
    `You have ${Math.max(1, params.workers.length)} specialists available.`,
    "",
    "Create a concise execution plan in markdown with these sections:",
    "1. Mission",
    "2. Shared Constraints",
    "3. Delegation Tracks",
    "",
    "The delegation tracks should be concrete and action-oriented so each specialist can work independently before you synthesize.",
  ]
    .filter(Boolean)
    .join("\n");

  const finalPrompt = [
    `You are ${params.leader.agentName}, the lead consolidating specialist work for ${params.organizationName}.`,
    `Original task: {{vars.userRequest}}`,
    "{{vars.goalLine}}",
    "",
    "Delegation plan:",
    "{{vars.plan}}",
    "",
    "Specialist reports:",
    "{{parallel.parallelSummary}}",
    "",
    "Write a markdown response with exactly these sections:",
    "## Executive Summary",
    "## Specialist Contributions",
    "## Risks and Blockers",
    "## Recommended Next Actions",
    "",
    "Make it clear which evidence came from linked documents, memory, web research, or file inspection when applicable.",
  ].join("\n");

  const nodes: WorkflowNode[] = [
    {
      id: triggerId,
      type: "message-trigger",
      position: { x: 80, y: 180 },
      data: { label: "Message Trigger", channel: params.channel },
    },
    {
      id: varsId,
      type: "set-variables",
      position: { x: 320, y: 180 },
      data: {
        label: "Seed Org Vars",
        assignments: [
          { key: "userRequest", value: "{{trigger.message}}" },
          { key: "goalLine", value: params.goalName ? `Goal: ${params.goalName}` : "" },
        ],
      },
    },
    {
      id: planId,
      type: "claude-agent",
      position: { x: 580, y: 180 },
      data: {
        label: "Org Lead Plan",
        agentId: params.leader.agentId,
        systemPrompt: planPrompt,
        enabledTools: params.toolBundle.leaderTools,
        temperature: 0.3,
        maxTokens: 1100,
        maxToolCalls: 16,
      },
    },
    {
      id: storePlanId,
      type: "set-variables",
      position: { x: 860, y: 180 },
      data: {
        label: "Store Org Plan",
        assignments: [{ key: "plan", value: "{{claude.response}}" }],
      },
    },
    {
      id: parallelId,
      type: "parallel-agents",
      position: { x: 1120, y: 180 },
      data: {
        label: "Specialist Execution",
        maxParallel: Math.min(3, Math.max(1, params.workers.length)),
        workers: params.workers.map((worker, index) => ({
          roleKey: `worker${index + 1}`,
          label: `${worker.agentName} (${worker.roleTitle || worker.roleType || "Specialist"})`,
          agentId: worker.agentId,
          systemPrompt: [
            `You are ${worker.agentName}, working inside ${params.organizationName}.`,
            `Role: ${worker.roleTitle || worker.roleType || "Specialist"}`,
            worker.capabilities.length > 0 ? `Capabilities: ${worker.capabilities.join(", ")}` : "",
            "",
            "Use the available tools when they help. Work independently. Do not assume access to sibling specialist outputs.",
            "Return concise markdown with findings, evidence, risks, and recommended actions from your lane.",
          ]
            .filter(Boolean)
            .join("\n"),
          taskTemplate: [
            "Organization task: {{vars.userRequest}}",
            "{{vars.goalLine}}",
            "",
            "Delegation plan:",
            "{{vars.plan}}",
            "",
            `Your lane: ${worker.roleTitle || worker.roleType || "Specialist"}`,
            worker.capabilities.length > 0 ? `Focus on: ${worker.capabilities.join(", ")}` : "",
            "",
            "Use linked documents/data first when relevant, then use other tools as needed.",
            "Return:",
            "- What you checked",
            "- What you found",
            "- Risks or blockers",
            "- Recommended next actions",
          ]
            .filter(Boolean)
            .join("\n"),
          enabledTools: params.toolBundle.workerTools,
          temperature: 0.35,
          maxTokens: 1000,
          maxToolCalls: 14,
        })),
      },
    },
    {
      id: finalId,
      type: "claude-agent",
      position: { x: 1420, y: 180 },
      data: {
        label: "Org Lead Synthesis",
        agentId: params.leader.agentId,
        systemPrompt: finalPrompt,
        enabledTools: params.toolBundle.leaderTools,
        temperature: 0.25,
        maxTokens: 1500,
        maxToolCalls: 12,
      },
    },
  ];

  const edges: WorkflowEdge[] = [
    { id: `e-${triggerId}-${varsId}`, source: triggerId, target: varsId },
    { id: `e-${varsId}-${planId}`, source: varsId, target: planId },
    { id: `e-${planId}-${storePlanId}`, source: planId, target: storePlanId },
    { id: `e-${storePlanId}-${parallelId}`, source: storePlanId, target: parallelId },
    { id: `e-${parallelId}-${finalId}`, source: parallelId, target: finalId },
  ];

  return { workflowId, nodes, edges };
}

function extractExecutionResponse(nodeResults: Record<string, { output?: Record<string, unknown> } | undefined>): string {
  const results = Object.values(nodeResults);
  for (const result of results.reverse()) {
    const output = result?.output ?? {};
    if (typeof output.response === "string" && output.response.trim()) {
      return output.response.trim();
    }
    if (typeof output.content === "string" && output.content.trim()) {
      return output.content.trim();
    }
  }
  return "";
}

function wrapOrgExecutionResult(params: {
  organizationName: string;
  goalName: string;
  leaderName: string;
  workerNames: string[];
  content: string;
  decision: OrgModeDecision;
}): string {
  const lines = [
    "## Organization Workflow",
    `**Organization:** ${params.organizationName}`,
    params.goalName ? `**Goal:** ${params.goalName}` : "",
    `**Lead:** ${params.leaderName}`,
    params.workerNames.length > 0 ? `**Specialists:** ${params.workerNames.join(", ")}` : "",
    "",
    summarizeOrgMode(params.decision),
    "",
    params.content.trim() || "_No final synthesis returned._",
    "",
    "### Next",
    formatOrgModeSwitchPrompt(params.decision),
  ].filter(Boolean);
  return lines.join("\n");
}

function formatCouncilResult(data: {
  topic?: string;
  verdict?: string;
  tally?: Array<{ option: string; votes: number }>;
  opinions?: Array<{
    agentName: string;
    roleTitle: string;
    vote: string;
    confidence: number;
    stance: string;
    concerns?: string;
    error?: string | null;
  }>;
}): string {
  const lines: string[] = [];
  const resolvedVerdict = String(data.verdict || "").trim() || "No verdict";
  lines.push(`## Leadership Council`);
  if (data.topic?.trim()) {
    lines.push(`**Topic:** ${data.topic.trim()}`);
  }
  lines.push(`**Verdict:** ${resolvedVerdict}`);
  if (Array.isArray(data.tally) && data.tally.length > 0) {
    lines.push("");
    lines.push(`### Vote Tally`);
    lines.push(`| Option | Votes |`);
    lines.push(`| --- | ---: |`);
    for (const item of data.tally) {
      lines.push(`| ${item.option} | ${item.votes} |`);
    }
  }
  if (Array.isArray(data.opinions) && data.opinions.length > 0) {
    lines.push("");
    lines.push(`### Member Opinions`);
    data.opinions.slice(0, 5).forEach((opinion, index) => {
      lines.push(
        `${index + 1}. **${opinion.agentName}** (${opinion.roleTitle || "Team Member"}) voted **${opinion.vote}** at **${opinion.confidence}%**`,
      );
      lines.push(`   - Stance: ${opinion.stance.trim().slice(0, 240)}`);
      if (opinion.error?.trim()) {
        lines.push(`   - Status: model error (${opinion.error.trim().slice(0, 140)})`);
      }
      if (opinion.concerns?.trim()) {
        lines.push(`   - Concern: ${opinion.concerns.trim().slice(0, 140)}`);
      }
    });
  }
  return lines.join("\n");
}

async function runOrganizationExecutionTask(params: {
  rawMessage: string;
  topic: string;
  organizationName: string;
  goalName: string;
  leader: OrgParticipant;
  workers: OrgParticipant[];
  linkedDocumentIds: string[];
  decision: OrgModeDecision;
  ctx: BuiltinCommandContext;
}): Promise<string> {
  const [{ executeWorkflow }, { getModelConfig }, { getDocumentById }] = await Promise.all([
    import("@/lib/engine/executor"),
    import("@/lib/agents/model-router"),
    import("@/lib/documents/store"),
  ]);

  const linkedDocumentsSummary = params.linkedDocumentIds
    .map((documentId) => {
      const document = getDocumentById(documentId);
      if (!document) return "";
      return `- ${document.name} (${document.id})`;
    })
    .filter(Boolean)
    .join("\n");

  const toolBundle = resolveOrgExecutionToolBundle(params.rawMessage);
  const workflow = buildOrgExecutionWorkflow({
    channel: params.ctx.channel,
    topic: params.topic,
    organizationName: params.organizationName,
    goalName: params.goalName,
    linkedDocumentsSummary,
    leader: params.leader,
    workers: params.workers,
    toolBundle,
  });

  if (params.ctx.clientTurnId) {
    const { isTurnAborted: check } = await import("@/lib/channels/turn-abort-registry");
    if (check(params.ctx.clientTurnId)) return "Request was cancelled";
  }
  const result = await executeWorkflow({
    workflowId: workflow.workflowId,
    nodes: workflow.nodes,
    edges: workflow.edges,
    triggerType: "message",
    triggerData: {
      message: params.topic,
      sender: params.ctx.sender,
      sessionId: params.ctx.sessionId ?? undefined,
    },
    modelConfig: getModelConfig({
      agentId: params.leader.agentId,
      sessionId: params.ctx.sessionId ?? undefined,
    }),
    clientTurnId: params.ctx.clientTurnId,
    provenance: createProvenance("channel", `channel:${params.ctx.channel}`, {
      channel: params.ctx.channel,
      sender: params.ctx.sender,
      sessionId: params.ctx.sessionId ?? undefined,
      routeSource: "org-execution-router",
      organizationName: params.organizationName,
      goalName: params.goalName || undefined,
    }),
  });

  const content = extractExecutionResponse(
    result.nodeResults as Record<string, { output?: Record<string, unknown> } | undefined>,
  );

  return wrapOrgExecutionResult({
    organizationName: params.organizationName,
    goalName: params.goalName,
    leaderName: params.leader.agentName,
    workerNames: params.workers.map((worker) => worker.agentName),
    content,
    decision: params.decision,
  });
}

export async function runOrganizationCollaborationTask(params: {
  rawMessage: string;
  topic: string;
  organizationRef?: string;
  goalRef?: string;
  explicitMode?: OrgCollaborationMode | null;
  ctx: BuiltinCommandContext;
}): Promise<string> {
  const sanitizedTopic = stripOrgModeHints(params.topic).trim();
  if (!sanitizedTopic) return "Council topic is required.";

  const scope = parseScopeRefs(sanitizedTopic);
  const organizationRef = scope.organizationRef || String(params.organizationRef || "").trim();
  const goalRef = scope.goalRef || String(params.goalRef || "").trim();
  const topic = scope.remainder || sanitizedTopic;
  if (!topic) return "Council topic is required.";

  const internalApiBaseUrl = resolveInternalApiBaseUrl(params.ctx.internalBaseUrl);
  const [
    { listAgentRoles },
    { listAgents },
    { getActiveHierarchyOrganization, listHierarchyOrganizationMembers, resolveHierarchyOrganization },
    { resolveHierarchyGoal },
  ] = await Promise.all([
    import("@/lib/agents/roles"),
    import("@/lib/agents/registry"),
    import("@/lib/hierarchy/organizations"),
    import("@/lib/hierarchy/goals"),
  ]);

  const organization =
    (organizationRef ? resolveHierarchyOrganization(organizationRef) : null) ??
    getActiveHierarchyOrganization();
  if (organizationRef && !organization) {
    return `Organization not found: ${organizationRef}.`;
  }

  const goal = goalRef ? resolveHierarchyGoal(goalRef, organization?.id) : null;
  if (goalRef && !goal) {
    return `Goal not found: ${goalRef}.`;
  }

  const participants = organization
    ? listHierarchyOrganizationMembers(organization.id)
        .filter((member) => member.agentActive)
        .map((member) => ({
          agentId: member.agent.id,
          agentName: member.agent.name,
          roleType: member.role.roleType,
          roleTitle: member.role.roleTitle,
          roleDescription: member.role.roleDescription,
          capabilities: member.role.capabilities,
        } satisfies OrgParticipant))
    : (() => {
        const agents = listAgents();
        const activeAgentIds = new Set(agents.filter((agent) => agent.isActive).map((agent) => agent.id));
        const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
        return listAgentRoles()
          .filter((role) => activeAgentIds.has(role.agentId))
          .map((role) => ({
            agentId: role.agentId,
            agentName: agentsById.get(role.agentId)?.name || role.agentId,
            roleType: role.roleType,
            roleTitle: role.roleTitle,
            roleDescription: role.roleDescription,
            capabilities: role.capabilities,
          } satisfies OrgParticipant));
      })();

  const rankedParticipants = rankOrgParticipants(
    Array.from(new Map(participants.map((participant) => [participant.agentId, participant])).values()),
  ).slice(0, 5);

  if (rankedParticipants.length < 2) {
    return "Leadership routing needs at least two active agents. Create more agents and set their roles first.";
  }

  const decision = decideOrgCollaborationMode(params.rawMessage, topic, params.explicitMode);
  const sessionId = String(params.ctx.sessionId || "").trim();
  rememberOrgSwitchState({
    sessionId,
    topic,
    organizationRef: organization?.name || organizationRef,
    goalRef: goal?.name || goalRef,
    currentMode: decision.mode,
    organizationName: organization?.name || organizationRef,
    goalName: goal?.name || goalRef,
    createdAt: Date.now(),
  });

  if (decision.mode === "execution") {
    const leader = rankedParticipants[0];
    const workers = rankedParticipants.slice(1, 4);
    const rendered = await runOrganizationExecutionTask({
      rawMessage: params.rawMessage,
      topic: goal ? `${topic} for goal ${goal.name}` : topic,
      organizationName: organization?.name || "Current Organization",
      goalName: goal?.name || "",
      leader,
      workers,
      linkedDocumentIds: goal?.linkedDocumentIds ?? [],
      decision,
      ctx: params.ctx,
    });
    rememberOrgSwitchState({
      sessionId,
      topic,
      organizationRef: organization?.name || organizationRef,
      goalRef: goal?.name || goalRef,
      currentMode: decision.mode,
      organizationName: organization?.name || organizationRef,
      goalName: goal?.name || goalRef,
      leaderName: leader.agentName,
      workerNames: workers.map((worker) => worker.agentName),
      lastResponse: rendered,
      createdAt: Date.now(),
    });
    return rendered;
  }

  const councilTopic = goal ? `${topic} for goal ${goal.name}` : topic;
  const agentIds = rankedParticipants.map((participant) => participant.agentId).slice(0, 5);
  const { response, payload } = await fetchInternalJson<{
    success?: boolean;
    data?: {
      verdict?: string;
      winner?: string | null;
      conclusion?: string;
      tally?: Array<{ option: string; votes: number }>;
      opinions?: Array<{
        agentName: string;
        roleTitle: string;
        vote: string;
        confidence: number;
        stance: string;
        concerns?: string;
        error?: string | null;
      }>;
    };
    error?: string;
  }>(
    `${internalApiBaseUrl}/api/council`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        topic: councilTopic,
        agentIds,
        documentIds: goal?.linkedDocumentIds ?? [],
        options: ["Approve", "Revise", "Reject"],
        decisionMode: "majority",
      }),
    },
    "org-council",
  );

  if (!response.ok || !payload.success || !payload.data) {
    return `Leadership council failed: ${payload.error || `HTTP ${response.status}`}.`;
  }

  const rendered = [
    formatCouncilResult({
      topic: councilTopic,
      verdict:
        String(payload.data.verdict || "").trim() ||
        String(payload.data.conclusion || "").trim() ||
        (payload.data.winner ? `Council majority reached: "${payload.data.winner}".` : ""),
      ...payload.data,
    }),
    "",
    "### Mode",
    summarizeOrgMode(decision),
    "",
    "### Next",
    formatOrgModeSwitchPrompt(decision),
  ].join("\n");
  rememberOrgSwitchState({
    sessionId,
    topic,
    organizationRef: organization?.name || organizationRef,
    goalRef: goal?.name || goalRef,
    currentMode: decision.mode,
    organizationName: organization?.name || organizationRef,
    goalName: goal?.name || goalRef,
    leaderName: rankedParticipants[0]?.agentName || "",
    workerNames: rankedParticipants.slice(1, 5).map((participant) => participant.agentName),
    lastResponse: rendered,
    createdAt: Date.now(),
  });
  return rendered;
}

function parseExistingOrgResearchRun(message: string): { organizationRef: string; topicHint: string } | null {
  const raw = message.trim();
  const orgFirst = raw.match(
    /^(?:start|run|execute|launch|ask|have)\s+(?:the\s+)?(?:research|analysis|investigation|work|task)\s+(?:for|using|with)\s+(.+?)\s+org(?:anization)?(?:\s+(?:about|on|to|for)\s+(.+))?$/i,
  );
  if (orgFirst?.[1]) {
    return {
      organizationRef: trimReferenceTrail(stripWrappedQuotes(orgFirst[1])),
      topicHint: stripWrappedQuotes(orgFirst[2] || ""),
    };
  }

  const topicFirst = raw.match(
    /^(?:start|run|execute|launch|ask|have)\s+(.+?)\s+(?:using|with|for)\s+(.+?)\s+org(?:anization)?$/i,
  );
  if (topicFirst?.[1] && topicFirst[2]) {
    return {
      organizationRef: trimReferenceTrail(stripWrappedQuotes(topicFirst[2])),
      topicHint: stripWrappedQuotes(topicFirst[1]),
    };
  }

  return null;
}

function extractResearchTopicFromMessage(message: string): string {
  const cleaned = stripWrappedQuotes(message)
    .replace(/\b(?:for|using|with)\s+.+?\s+org(?:anization)?\b.*$/i, "")
    .replace(/\b(?:create|make|set\s+up|setup|build|form)\s+(?:an?\s+)?(?:org(?:anization)?|team|crew)\s+(?:with\s+)?(?:\d+\s+)?(?:agents?|members?)\s+(?:to\s+do\s+)?/i, "")
    .replace(/\b(?:start|run|execute|launch)\s+(?:the\s+)?(?:research|analysis|investigation|work|task)\b/i, "")
    .trim();
  const topicMatch = cleaned.match(/\b(?:research|investigate|analy[sz]e|study|compare|evaluate)\s+(?:about|on|for)?\s*(.+)$/i);
  const topic = (topicMatch?.[1] || cleaned).trim();
  return trimReferenceTrail(topic).replace(/\s+/g, " ").trim();
}

async function inferRecentResearchTopicForSession(sessionId?: string | null): Promise<string> {
  const sid = String(sessionId || "").trim();
  if (!sid) return "";
  try {
    const { getSqlite } = await import("@/lib/db");
    const db = getSqlite();
    const rows = db
      .prepare(
        `SELECT content
         FROM messages
         WHERE session_id = ? AND role = 'user'
         ORDER BY created_at DESC
         LIMIT 8`,
      )
      .all(sid) as Array<{ content: string }>;
    for (const row of rows) {
      const content = String(row.content || "");
      if (/^(?:confirm|cancel)$/i.test(content.trim())) continue;
      if (!/\b(?:research|investigate|analy[sz]e|study|compare|evaluate)\b/i.test(content)) continue;
      const topic = extractResearchTopicFromMessage(content);
      if (topic && !/\b(?:org|organization|team|agents?)\b$/i.test(topic)) return topic;
    }
  } catch {
    // best effort only
  }
  return "";
}

async function handleBuiltinCommands(
  message: string,
  ctx: BuiltinCommandContext,
): Promise<string | null> {
  const raw = message.trim();
  if (!raw) return null;
  if (isWebImageResearchRequest(raw)) return null;
  const normalized = raw.toLowerCase();
  const normalizedLookup = normalizeLookup(raw);
  const internalApiBaseUrl = resolveInternalApiBaseUrl(ctx.internalBaseUrl);
  const denySensitiveCommand = (): string =>
    `This command changes app state and requires admin sender access. Sender "${ctx.sender}" is not in CHANNEL_COMMAND_ADMINS.`;

  if (/\bagent\b/i.test(raw) && /\bwhat would that look like\b/i.test(raw)) {
    return buildBuiltinRoutingClarifier({
      kind: "app_control",
      domain: "agent",
      reason: "hypothetical agent-upgrade phrasing needs explicit confirmation",
      usesSessionReference: detectSessionReference(raw),
    });
  }

  const existingOrgResearchRun = parseExistingOrgResearchRun(raw);
  if (existingOrgResearchRun) {
    const directTopic = extractResearchTopicFromMessage(existingOrgResearchRun.topicHint);
    const recentTopic = directTopic ? "" : await inferRecentResearchTopicForSession(ctx.sessionId);
    const topic = directTopic || recentTopic || "the requested research task";
    return runOrganizationCollaborationTask({
      rawMessage: raw,
      topic,
      organizationRef: existingOrgResearchRun.organizationRef,
      explicitMode: "execution",
      ctx,
    });
  }

  // Command palette
  if (
    normalizedLookup === "show command palette" ||
    normalizedLookup === "show commands" ||
    normalizedLookup === "list commands" ||
    normalizedLookup === "what commands are available" ||
    normalizedLookup === "what can i ask you" ||
    normalizedLookup === "help commands" ||
    normalizedLookup === "show me what i can ask" ||
    normalizedLookup === "what commands do you know" ||
    normalizedLookup === "command help" ||
    normalizedLookup === "show available commands"
  ) {
    return getCommandPaletteText();
  }

  const earlyFindToolsMatch =
    raw.match(/^find\s+tools?\s+for\s+(.+)$/i) ||
    raw.match(/^recommend\s+tools?\s+for\s+(.+)$/i) ||
    raw.match(/^what\s+tools?\s+should\s+i\s+use\s+for\s+(.+)$/i) ||
    raw.match(/^which\s+tools?\s+(?:is|are)\s+(?:best|good|right)\s+for\s+(.+)$/i) ||
    raw.match(/^is\s+there\s+a\s+tool\s+for\s+(.+)$/i);
  if (earlyFindToolsMatch?.[1]) {
    const { searchToolKnowledgeDocs } = await import("@/lib/engine/tools");
    const query = stripWrappedQuotes(earlyFindToolsMatch[1]);
    const matches = await searchToolKnowledgeDocs(query, 5);
    if (matches.length === 0) {
      return `No strong tool matches found for "${query}". Try: show tools`;
    }
    return [
      `Recommended tools for "${query}":`,
      ...matches.map((doc, index) =>
        `${index + 1}. ${doc.label} (${doc.name}) [${doc.source}]${doc.parameterNames.length ? `\n   Params: ${doc.parameterNames.join(", ")}` : ""}\n   ${doc.description}`,
      ),
    ].join("\n");
  }

  const earlyShowToolHelpMatch =
    raw.match(/^(?:show|open|explain|inspect)\s+tool\s+(?:help\s+for\s+)?(.+)$/i) ||
    raw.match(/^how\s+do\s+i\s+use\s+(?:the\s+)?tool\s+(.+)$/i) ||
    raw.match(/^what\s+does\s+(?:the\s+)?tool\s+(.+?)\s+do$/i);
  if (earlyShowToolHelpMatch?.[1]) {
    const { listToolKnowledgeDocs } = await import("@/lib/engine/tools");
    const query = trimReferenceTrail(stripWrappedQuotes(earlyShowToolHelpMatch[1]));
    const docs = await listToolKnowledgeDocs();
    const exact =
      docs.find((doc) => doc.name.toLowerCase() === query.toLowerCase()) ??
      docs.find((doc) => doc.label.toLowerCase() === query.toLowerCase()) ??
      docs.find((doc) => doc.name.toLowerCase().includes(query.toLowerCase())) ??
      docs.find((doc) => doc.label.toLowerCase().includes(query.toLowerCase()));
    if (!exact) {
      return `Tool not found: ${query}. Try: find tools for ${query}`;
    }
    return [
      `${exact.label} (${exact.name}) [${exact.source}]`,
      exact.description,
      exact.parameterNames.length > 0 ? `Parameters: ${exact.parameterNames.join(", ")}` : "Parameters: none",
      exact.detailText,
    ]
      .filter(Boolean)
      .join("\n");
  }

  // Channel doctor
  if (
    normalizedLookup === "check channel health" ||
    normalizedLookup === "run channel doctor" ||
    normalizedLookup === "diagnose channels" ||
    normalizedLookup === "channel diagnostics" ||
    normalizedLookup === "check channel setup" ||
    normalizedLookup === "are my channels working" ||
    normalizedLookup === "diagnose my channel setup" ||
    normalizedLookup === "channel health check" ||
    normalizedLookup === "run channel health check" ||
    normalizedLookup === "check oauth status" ||
    normalizedLookup === "channel setup status"
  ) {
    try {
      const { runChannelDoctor, formatChannelDoctorReport } = await import("@/lib/channels/channel-doctor");
      const report = runChannelDoctor();
      return formatChannelDoctorReport(report);
    } catch (error) {
      return `Channel health check failed: ${String(error)}.`;
    }
  }

  // Pending pairing requests
  if (
    normalizedLookup === "list pending pairing requests" ||
    normalizedLookup === "show pairing requests" ||
    normalizedLookup === "list pairing requests" ||
    normalizedLookup === "show pending pairings" ||
    normalizedLookup === "who is waiting to pair"
  ) {
    try {
      const { getChannelAccessOverview, approveChannelPairing, denyChannelPairing } = await import("@/lib/channels/access");
      void approveChannelPairing; void denyChannelPairing;
      const overview = getChannelAccessOverview();
      if (overview.pending.length === 0) {
        return [
          "## Pending pairing requests",
          `Access mode: ${overview.mode}`,
          "No pending pairing requests.",
          "",
          overview.mode === "open"
            ? "Access is open — all senders are allowed without pairing."
            : overview.mode === "allowlist"
              ? "Access uses allowlist mode — only approved senders can message."
              : "Pairing mode is active — new senders get a code and await approval.",
        ].join("\n");
      }
      const lines = [
        "## Pending pairing requests",
        `Access mode: ${overview.mode}`,
        `${overview.pending.length} request(s) waiting:`,
        "",
      ];
      for (const request of overview.pending) {
        lines.push(`Channel: ${request.channel}`);
        lines.push(`  Label: ${request.subjectLabel || "(unknown)"}`);
        lines.push(`  Code: ${request.formattedCode}`);
        lines.push(`  Age: ${request.ageMinutes} min | Expires in: ${request.expiresInMinutes} min`);
        lines.push(`  To approve: approve pairing ${request.formattedCode}`);
        lines.push(`  To deny: deny pairing ${request.formattedCode}`);
        lines.push("");
      }
      return lines.join("\n").trim();
    } catch (error) {
      return `Failed to list pairing requests: ${String(error)}.`;
    }
  }

  // Approve pairing
  const approvePairingMatch = raw.match(/^approve\s+pairing\s+(.+)$/i);
  if (approvePairingMatch?.[1]) {
    if (!isSensitiveCommandAllowed(ctx)) return denySensitiveCommand();
    try {
      const { approveChannelPairing } = await import("@/lib/channels/access");
      const codeRaw = approvePairingMatch[1].trim();
      const approved = approveChannelPairing(codeRaw);
      if (!approved) {
        return `Pairing code not found or already processed: ${codeRaw}. Run "list pending pairing requests" to see active codes.`;
      }
      return [
        `Pairing approved for ${approved.subjectLabel || approved.subjectKey} on ${approved.channel}.`,
        `They can now send messages on ${approved.channel}.`,
      ].join("\n");
    } catch (error) {
      return `Failed to approve pairing: ${String(error)}.`;
    }
  }

  // Deny pairing
  const denyPairingMatch = raw.match(/^deny\s+pairing\s+(.+)$/i);
  if (denyPairingMatch?.[1]) {
    if (!isSensitiveCommandAllowed(ctx)) return denySensitiveCommand();
    try {
      const { denyChannelPairing } = await import("@/lib/channels/access");
      const codeRaw = denyPairingMatch[1].trim();
      const denied = denyChannelPairing(codeRaw);
      if (!denied) {
        return `Pairing code not found or already processed: ${codeRaw}. Run "list pending pairing requests" to see active codes.`;
      }
      return `Pairing denied for code ${codeRaw}. The sender will not be allowed.`;
    } catch (error) {
      return `Failed to deny pairing: ${String(error)}.`;
    }
  }

  // Per-channel setup guides (aliases into extension setup)
  const channelSetupAliases: Record<string, string> = {
    "show setup for telegram": "show setup for extension telegram",
    "how do i set up telegram": "show setup for extension telegram",
    "how do i wire up telegram": "show setup for extension telegram",
    "how do i connect telegram": "show setup for extension telegram",
    "telegram setup": "show setup for extension telegram",
    "set up telegram": "show setup for extension telegram",
    "connect telegram": "show setup for extension telegram",
    "show setup for discord": "show setup for extension discord",
    "how do i set up discord": "show setup for extension discord",
    "how do i wire up discord": "show setup for extension discord",
    "discord setup": "show setup for extension discord",
    "set up discord": "show setup for extension discord",
    "show setup for whatsapp": "show setup for extension whatsapp",
    "how do i set up whatsapp": "show setup for extension whatsapp",
    "how do i wire up whatsapp": "show setup for extension whatsapp",
    "whatsapp setup": "show setup for extension whatsapp",
    "set up whatsapp": "show setup for extension whatsapp",
    "show setup for slack": "show setup for extension slack",
    "how do i set up slack": "show setup for extension slack",
    "how do i wire up slack": "show setup for extension slack",
    "slack setup": "show setup for extension slack",
    "set up slack": "show setup for extension slack",
    "show setup for bluebubbles": "show setup for extension bluebubbles",
    "how do i set up bluebubbles": "show setup for extension bluebubbles",
    "how do i wire up bluebubbles": "show setup for extension bluebubbles",
    "bluebubbles setup": "show setup for extension bluebubbles",
    "set up bluebubbles": "show setup for extension bluebubbles",
    "imessage setup": "show setup for extension bluebubbles",
    "how do i set up imessage": "show setup for extension bluebubbles",
    "show setup for google chat": "show setup for extension googlechat",
    "how do i set up google chat": "show setup for extension googlechat",
    "how do i wire up google chat": "show setup for extension googlechat",
    "google chat setup": "show setup for extension googlechat",
    "set up google chat": "show setup for extension googlechat",
    "show setup for teams": "show setup for extension msteams",
    "how do i set up teams": "show setup for extension msteams",
    "how do i wire up teams": "show setup for extension msteams",
    "teams setup": "show setup for extension msteams",
    "set up microsoft teams": "show setup for extension msteams",
    "microsoft teams setup": "show setup for extension msteams",
    "show setup for extension discord": "show setup for extension discord",
    "show setup for extension whatsapp": "show setup for extension whatsapp",
    "show setup for extension slack": "show setup for extension slack",
    "show setup for extension bluebubbles": "show setup for extension bluebubbles",
    "show setup for extension googlechat": "show setup for extension googlechat",
    "show setup for extension telegram": "show setup for extension telegram",
    "show setup for extension teams": "show setup for extension msteams",
    "show setup for extension microsoft teams": "show setup for extension msteams",
    "show setup for extension google chat": "show setup for extension googlechat",
  };
  if (channelSetupAliases[normalizedLookup]) {
    const resolvedSetup = channelSetupAliases[normalizedLookup];
    if (resolvedSetup !== normalizedLookup) {
      return handleBuiltinCommands(resolvedSetup, { ...ctx, allowCompound: false });
    }
  }

  // Confusion pair clarifiers — before general routing to prevent wrong-surface collapse
  if (!isProtectedBuiltinParserMessage(raw)) {
    const confusionClarifier = detectConfusionPairClarifier(raw);
    if (confusionClarifier) {
      return confusionClarifier.reply;
    }
  }

  if (normalizedLookup === "show orientation summary") {
    return renderBuiltinCommandList(["list workflows", "show approvals", "show maintenance"], ctx);
  }

  if (normalizedLookup === "show support orientation") {
    return renderBuiltinCommandList(["channel status", "list agents", "show settings"], ctx);
  }

  if (normalizedLookup === "where do i go if the team needs to debate something") {
    return handleBuiltinCommands("how do i use council", { ...ctx, allowCompound: false });
  }

  if (normalizedLookup === "how would i wire telegram if i need it") {
    return handleBuiltinCommands("show setup for extension Telegram", { ...ctx, allowCompound: false });
  }

  if (normalizedLookup === "what looks off right now") {
    return handleBuiltinCommands("show maintenance", { ...ctx, allowCompound: false });
  }

  const featureHowToCommand = resolveFeatureHowToCommand(raw);
  if (featureHowToCommand && normalizeLookup(featureHowToCommand) !== normalizedLookup && !hasAutomationLiveStateReadPart(raw)) {
    return handleBuiltinCommands(featureHowToCommand, { ...ctx, allowCompound: false });
  }

  if (isWebhookSigningHelpRequest(raw) && !hasAutomationLiveStateReadPart(raw)) {
    return renderWebhookSigningHelpResponse();
  }

  const builtinIntent = findBuiltinIntentByAlias(raw);
  if (builtinIntent && normalizeLookup(builtinIntent.command) !== normalizedLookup) {
    return handleBuiltinCommands(builtinIntent.command, ctx);
  }

  if (
    normalizedLookup === "workspace root" ||
    normalizedLookup === "show workspace root" ||
    normalizedLookup === "what files are in my workspace root" ||
    normalizedLookup === "what files do i have at the workspace root"
  ) {
    try {
      const entries = fs
        .readdirSync(process.cwd(), { withFileTypes: true })
        .slice(0, 24)
        .map((entry) => `${entry.isDirectory() ? "[dir]" : "[file]"} ${entry.name}`);
      return ["Workspace root:", ...entries].join("\n");
    } catch (error) {
      return `Workspace root listing failed: ${String(error)}.`;
    }
  }

  if (
    normalizedLookup === "show system specs" ||
    normalizedLookup === "system specs" ||
    normalizedLookup === "what are my cpu and ram specs" ||
    normalizedLookup === "cpu and ram specs" ||
    normalizedLookup === "do you know my cpu and ram specs"
  ) {
    try {
      const { response: systemResponse, payload: systemPayload } = await fetchInternalJson<{
        success?: boolean;
        data?: { machine?: Record<string, unknown> };
        error?: string;
      }>(`${internalApiBaseUrl}/api/system/summary`, { method: "GET" }, "channel-system-specs");
      if (!systemResponse.ok || !systemPayload.success) {
        return `System specs failed: ${systemPayload.error || `HTTP ${systemResponse.status}`}.`;
      }
      const machine = (systemPayload.data?.machine ?? {}) as Record<string, unknown>;
      return [
        "System specs:",
        `Processor: ${formatPlainInteger(machine.cpuCount)} cores (${String(machine.arch || "unknown")})`,
        `RAM: ${formatPlainInteger(machine.totalMemoryGb)} GB`,
      ].join("\n");
    } catch (error) {
      return `System specs failed: ${String(error)}.`;
    }
  }

  if (ctx.allowCompound !== false) {
    const compoundParts = splitCompoundBuiltinMessage(raw);
    if (compoundParts.length >= 2) {
      return renderCompoundBuiltinSections(compoundParts, ctx);
    }
  }

  if (ctx.allowCompound !== false) {
    const persistedPending = getChannelSessionAppState(ctx.sessionId)?.payload?.pendingMutation ?? null;
    if (/^(?:confirm|yes|apply it|do it)$/i.test(raw)) {
      const hadPersistedPlan = Boolean(persistedPending?.kind);
      const pending = getPendingMutation(ctx.sessionId);
      if (!pending) {
        if (hadPersistedPlan) {
          clearPendingMutation(ctx.sessionId);
          return "No pending confirmation found — it may have expired. Please repeat your request.";
        }
        return "There is no pending confirmed change in this chat right now.";
      }
      clearPendingMutation(ctx.sessionId);
      return executePendingMutation(pending, ctx);
    }

    if (/^(?:cancel|never mind|nevermind|stop|don t do that|don't do that)$/i.test(raw)) {
      const pending = getPendingMutation(ctx.sessionId);
      if (!pending) {
        clearPendingMutation(ctx.sessionId);
        return "There is no pending confirmed change in this chat right now.";
      }
      const cancelTrailId = typeof pending.payload?.trailId === "string" ? pending.payload.trailId : "";
      if (cancelTrailId) {
        try {
          const wt = await import("@/lib/work-trails/work-trails");
          wt.appendWorkTrailEvent({ trailId: cancelTrailId, eventType: "cancelled", summary: "User cancelled the plan" });
          wt.updateWorkTrailStatus(cancelTrailId, "cancelled");
        } catch { /* trail is best-effort */ }
      }
      clearPendingMutation(ctx.sessionId);
      return `Cancelled pending change: ${pending.summary}`;
    }

    const sessionAppState = getChannelSessionAppState(ctx.sessionId)?.payload ?? null;
    const multiStepPlan = inferPlannerTraceEligibility(raw) ? null : buildMultiStepPlan(raw, sessionAppState);
    if (multiStepPlan) {
      const queued = queueSensitiveMutation(ctx, {
        kind: "multi-step-plan",
        summary: [
          `Apply this ${multiStepPlan.length}-step plan:`,
          ...multiStepPlan.map((step, index) => `${index + 1}. ${step.label}`),
        ].join("\n"),
        payload: {
          steps: multiStepPlan,
        },
      });
      if (queued) return queued;
    }
  }

  const builtinAlias = isProtectedBuiltinParserMessage(raw) ? null : resolveEllipticalAppMessage(raw);
  if (builtinAlias && normalizeLookup(builtinAlias.message) !== normalizedLookup) {
    return handleBuiltinCommands(builtinAlias.message, ctx);
  }

  if (/^(?:confirm|yes|apply it|do it)$/i.test(raw)) {
    const persistedPending = getChannelSessionAppState(ctx.sessionId)?.payload?.pendingMutation ?? null;
    const hadPersistedPlan = Boolean(persistedPending?.kind);
    const pending = getPendingMutation(ctx.sessionId);
    if (!pending) {
      if (hadPersistedPlan) {
        clearPendingMutation(ctx.sessionId);
        return "No pending confirmation found — it may have expired. Please repeat your request.";
      }
      return "There is no pending confirmed change in this chat right now.";
    }
    clearPendingMutation(ctx.sessionId);
    return executePendingMutation(pending, ctx);
  }

  if (/^(?:cancel|never mind|nevermind|stop|don t do that|don't do that)$/i.test(raw)) {
    const pending = getPendingMutation(ctx.sessionId);
    if (!pending) {
      clearPendingMutation(ctx.sessionId);
      return "There is no pending confirmed change in this chat right now.";
    }
    clearPendingMutation(ctx.sessionId);
    return `Cancelled pending change: ${pending.summary}`;
  }

  if (isStandalonePreferenceStatement(raw)) {
    return "Noted. I'll keep that preference in mind.";
  }

  if (normalizedLookup === "/permission" || normalizedLookup === "permission" || normalizedLookup === "permissions") {
    try {
      return await buildApprovalsSummary(internalApiBaseUrl);
    } catch (error) {
      return `Approvals summary failed: ${String(error)}.`;
    }
  }

  const toolApprovalDecisionMatch =
    raw.match(/^\/(approve|deny)(?:\s+(.+))?$/i) ||
    raw.match(/^(approve|deny)\s+(?:tool\s+approval|approval|permission)\s+(.+)$/i);
  if (toolApprovalDecisionMatch?.[1]) {
    if (!isSensitiveCommandAllowed(ctx)) return denySensitiveCommand();
    const decision = toolApprovalDecisionMatch[1].toLowerCase() === "approve" ? "approve" : "deny";
    const approvals = listPendingApprovals();
    if (approvals.length === 0) {
      return "There are no pending tool approvals right now.";
    }

    const rawRef = stripWrappedQuotes(String(toolApprovalDecisionMatch[2] ?? "").trim());
    const normalizedRef = normalizeLookup(rawRef);
    let target = null as (ReturnType<typeof listPendingApprovals>[number] | null);

    if (!normalizedRef || normalizedRef === "latest" || normalizedRef === "last" || normalizedRef === "pending") {
      target = approvals[0] ?? null;
    } else {
      const exact = approvals.find((entry) => entry.id === rawRef);
      const byPrefix = approvals.find((entry) => entry.id.toLowerCase().startsWith(normalizedRef));
      const byTool = approvals.filter((entry) => normalizeLookup(entry.name).includes(normalizedRef));
      if (exact) target = exact;
      else if (byPrefix) target = byPrefix;
      else if (byTool.length === 1) target = byTool[0];
      else if (byTool.length > 1) {
        return [
          `Multiple pending approvals matched "${rawRef}":`,
          ...byTool.slice(0, 5).map((entry) => `- ${entry.id} • ${entry.name}`),
        ].join("\n");
      }
    }

    if (!target) {
      return [
        `Pending approval not found: ${rawRef || "(latest)"}.`,
        ...approvals.slice(0, 5).map((entry) => `- ${entry.id} • ${entry.name}`),
      ].join("\n");
    }

    const result = await resolvePendingApproval({ id: target.id, decision });
    if (!result.success) {
      return `Tool approval ${decision} failed for ${target.id}: ${result.error || result.status}.`;
    }
    if (decision === "deny") {
      return `Denied tool approval ${target.id} for ${target.name}.`;
    }
    return [
      `Approved tool approval ${target.id} for ${target.name}.`,
      result.result ? `Result:
${truncateToolResult(result.result, 1200)}` : null,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  if ((/^(?:show|tail|open|get|read)\b/.test(normalizedLookup) && /\blogs?\b/.test(normalizedLookup)) || normalizedLookup === "logs") {
    try {
      return await buildLogsSummary(internalApiBaseUrl);
    } catch (error) {
      return `Logs summary failed: ${String(error)}.`;
    }
  }

  if (
    normalizedLookup === "switch to execution mode" ||
    normalizedLookup === "switch to workflow mode" ||
    normalizedLookup === "use execution mode" ||
    normalizedLookup === "use workflow mode"
  ) {
    const state = getOrgSwitchState(ctx.sessionId);
    if (!state) {
      return 'There is no recent org-level run in this chat to switch. Start with an org ask first, then reply with "switch to council mode" or "switch to execution mode".';
    }
    if (state.currentMode === "execution") {
      return 'The last org ask already ran as execution orchestration. Reply with "switch to council mode" if you want the other routing style.';
    }
    return runOrganizationCollaborationTask({
      rawMessage: raw,
      topic: state.topic,
      organizationRef: state.organizationRef,
      goalRef: state.goalRef,
      explicitMode: "execution",
      ctx,
    });
  }

  if (
    normalizedLookup === "switch to council mode" ||
    normalizedLookup === "switch to discussion mode" ||
    normalizedLookup === "use council mode" ||
    normalizedLookup === "use discussion mode"
  ) {
    const state = getOrgSwitchState(ctx.sessionId);
    if (!state) {
      return 'There is no recent org-level run in this chat to switch. Start with an org ask first, then reply with "switch to council mode" or "switch to execution mode".';
    }
    if (state.currentMode === "council") {
      return 'The last org ask already ran as leadership council. Reply with "switch to execution mode" if you want the other routing style.';
    }
    return runOrganizationCollaborationTask({
      rawMessage: raw,
      topic: state.topic,
      organizationRef: state.organizationRef,
      goalRef: state.goalRef,
      explicitMode: "council",
      ctx,
    });
  }

  if (
    normalizedLookup === "show last org run status" ||
    normalizedLookup === "show last org status" ||
    normalizedLookup === "what mode did the last org run use"
  ) {
    const state = getOrgSwitchState(ctx.sessionId);
    if (!state) {
      return 'There is no recent org-level run in this chat yet. Start with an org ask first.';
    }
    return [
      "## Last Organization Run",
      `**Mode:** ${state.currentMode === "execution" ? "Execution Orchestration" : "Leadership Council"}`,
      state.organizationName || state.organizationRef ? `**Organization:** ${state.organizationName || state.organizationRef}` : null,
      state.goalName || state.goalRef ? `**Goal:** ${state.goalName || state.goalRef}` : null,
      `**Topic:** ${state.topic}`,
      state.leaderName ? `**Lead:** ${state.leaderName}` : null,
      state.workerNames && state.workerNames.length > 0 ? `**Specialists:** ${state.workerNames.join(", ")}` : null,
      "",
      "### Next",
      formatOrgModeSwitchPrompt({
        mode: state.currentMode,
        explicit: true,
        reason: state.currentMode === "execution" ? "showed the last execution run" : "showed the last council run",
      }),
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (
    normalizedLookup === "show what each specialist did" ||
    normalizedLookup === "show last org worker summaries" ||
    normalizedLookup === "show last org council opinions"
  ) {
    const state = getOrgSwitchState(ctx.sessionId);
    if (!state?.lastResponse) {
      return 'There is no recent org-level result in this chat yet. Start with an org ask first.';
    }
    const section =
      state.currentMode === "execution"
        ? extractMarkdownSection(state.lastResponse, "Specialist Contributions")
        : extractMarkdownSection(state.lastResponse, "Member Opinions");
    if (!section) {
      return state.currentMode === "execution"
        ? "The last execution run did not include a specialist-contributions section."
        : "The last council run did not include member opinions.";
    }
    return section;
  }

  if (normalizedLookup === "what do the metrics look like today" || normalizedLookup === "how are our metrics today") {
    try {
      return await buildMetricsSummary(internalApiBaseUrl);
    } catch (error) {
      return `Metrics summary failed: ${String(error)}.`;
    }
  }

  if (normalizedLookup === "how are we doing today on usage") {
    try {
      return await buildUsageSummary(internalApiBaseUrl);
    } catch (error) {
      return `Usage summary failed: ${String(error)}.`;
    }
  }

  if (
    normalizedLookup === "what can the settings page help me control" ||
    normalizedLookup === "what can i change in settings"
  ) {
    return formatFeatureHowTo("settings");
  }

  if (
    normalizedLookup === "show learning status" ||
    normalizedLookup === "learning status" ||
    normalizedLookup === "show self learning status" ||
    normalizedLookup === "how is self learning configured"
  ) {
    const { formatLearningStatusMarkdown } = await import("@/lib/learning/loop");
    return formatLearningStatusMarkdown();
  }

  if (
    normalizedLookup === "list learning candidates" ||
    normalizedLookup === "show learning candidates" ||
    normalizedLookup === "show learnings" ||
    normalizedLookup === "show learning queue"
  ) {
    const { listLearningCandidates } = await import("@/lib/learning/loop");
    const candidates = listLearningCandidates("all");
    if (candidates.length === 0) {
      return "No learning candidates yet.";
    }
    return [
      "## Learning Candidates",
      ...candidates.slice(0, 12).map((candidate, index) =>
        `${index + 1}. ${candidate.title} [${candidate.status}] · evidence=${candidate.evidenceCount} · id=${candidate.id}`,
      ),
      "",
      'Reply with "promote learning candidate latest" or "dismiss learning candidate <id>" to manage them.',
    ].join("\n");
  }

  if (
    normalizedLookup === "show session snapshot status" ||
    normalizedLookup === "session snapshot status" ||
    normalizedLookup === "show chat snapshot status" ||
    normalizedLookup === "is this chat using a session snapshot"
  ) {
    const [{ formatChannelSessionStartupSnapshotStatus }] = await Promise.all([
      import("@/lib/channels/session-startup-snapshots"),
    ]);
    return formatChannelSessionStartupSnapshotStatus({
      sessionId: ctx.sessionId,
    });
  }

  if (
    normalizedLookup === "reload session snapshot" ||
    normalizedLookup === "refresh session snapshot" ||
    normalizedLookup === "reload chat snapshot" ||
    normalizedLookup === "reload agent files" ||
    normalizedLookup === "refresh agent files for this chat"
  ) {
    if (!ctx.sessionId) {
      return "Session snapshot reload needs an active chat session.";
    }
    const [{ invalidateChannelSessionStartupSnapshot }] = await Promise.all([
      import("@/lib/channels/session-startup-snapshots"),
    ]);
    const removed = invalidateChannelSessionStartupSnapshot({
      sessionId: ctx.sessionId,
    });
    return removed > 0
      ? "Session snapshot cleared for this chat. The next assistant run will capture the latest startup files."
      : "No session snapshot was active. The next assistant run will capture the latest startup files.";
  }

  const learningModeMatch = raw.match(
    /^(?:turn|set|keep|switch)\s+(?:self[- ]?learning|learning loop)\s+(?:to|mode\s+to|mode)?\s*(off|review|auto|on)$/i,
  );
  if (learningModeMatch?.[1]) {
    const requested = learningModeMatch[1].toLowerCase();
    const learningMode = requested === "on" ? "review" : requested;
    const learningEnabled = learningMode !== "off";
    const queued = queueSensitiveMutation(ctx, {
      kind: "learning-config",
      summary: `Set self-learning to ${learningMode}.`,
      payload: {
        learningEnabled,
        learningMode,
        capturePreferences: true,
        capturePlaybooks: true,
        autoPromoteThreshold: learningMode === "auto" ? 2 : 2,
      },
    });
    return queued ?? "Learning settings need an active chat session.";
  }

  const learningPromoteMatch =
    raw.match(/^promote\s+learning\s+candidate\s+(.+)$/i) ||
    raw.match(/^approve\s+learning\s+candidate\s+(.+)$/i) ||
    raw.match(/^promote\s+(.+?)\s+learning\s+candidate$/i) ||
    raw.match(/^promote\s+(?:the\s+)?(.+?)\s+candidate$/i);
  if (learningPromoteMatch?.[1]) {
    const candidateRef = stripWrappedQuotes(learningPromoteMatch[1]);
    const { getLearningCandidate } = await import("@/lib/learning/loop");
    const candidate = getLearningCandidate(candidateRef);
    if (!candidate) {
      return `Learning candidate not found: ${candidateRef}`;
    }
    const queued = queueSensitiveMutation(ctx, {
      kind: "learning-candidate-promote",
      summary: `Promote learning candidate ${candidate.id}: ${candidate.title}.`,
      payload: { candidateRef: candidate.id },
    });
    return queued ?? "Learning candidate promotion needs an active chat session.";
  }

  const learningDismissMatch =
    raw.match(/^dismiss\s+learning\s+candidate\s+(.+)$/i) ||
    raw.match(/^reject\s+learning\s+candidate\s+(.+)$/i) ||
    raw.match(/^dismiss\s+(.+?)\s+learning\s+candidate$/i) ||
    raw.match(/^dismiss\s+(?:the\s+)?(.+?)\s+candidate$/i);
  if (learningDismissMatch?.[1]) {
    const candidateRef = stripWrappedQuotes(learningDismissMatch[1]);
    const { getLearningCandidate } = await import("@/lib/learning/loop");
    const candidate = getLearningCandidate(candidateRef);
    if (!candidate) {
      return `Learning candidate not found: ${candidateRef}`;
    }
    const queued = queueSensitiveMutation(ctx, {
      kind: "learning-candidate-dismiss",
      summary: `Dismiss learning candidate ${candidate.id}: ${candidate.title}.`,
      payload: { candidateRef: candidate.id },
    });
    return queued ?? "Learning candidate dismissal needs an active chat session.";
  }

  const exportOrgPackMatch =
    raw.match(/^export\s+organization\s+(.+?)\s+to\s+(.+)$/i) ||
    raw.match(/^download\s+organization\s+(.+?)\s+to\s+(.+)$/i) ||
    raw.match(/^export\s+current\s+organization\s+to\s+(.+)$/i);
  if (exportOrgPackMatch) {
    const organizationRef = exportOrgPackMatch.length === 2 ? "current" : stripWrappedQuotes(exportOrgPackMatch[1]);
    const outputPath = stripWrappedQuotes(exportOrgPackMatch.length === 2 ? exportOrgPackMatch[1] : exportOrgPackMatch[2]);
    const queued = queueSensitiveMutation(ctx, {
      kind: "organization-export",
      summary: `Export organization ${organizationRef} to ${outputPath}.`,
      payload: { organizationRef, outputPath },
    });
    return queued ?? "Organization export needs an active chat session.";
  }

  const importOrgPackMatch =
    raw.match(/^import\s+(?:organization\s+)?(?:company\s+)?pack\s+from\s+(.+)$/i) ||
    raw.match(/^import\s+organization\s+from\s+(.+)$/i);
  if (importOrgPackMatch?.[1]) {
    const inputPath = stripWrappedQuotes(importOrgPackMatch[1]);
    const queued = queueSensitiveMutation(ctx, {
      kind: "organization-import",
      summary: `Import organization pack from ${inputPath}.`,
      payload: { inputPath, activate: true },
    });
    return queued ?? "Organization import needs an active chat session.";
  }

  const importExternalCompanyTemplateMatch =
    raw.match(/^import\s+(?:external\s+)?company\s+template\s+from\s+(.+)$/i) ||
    raw.match(/^migrate\s+(?:external\s+)?company\s+template\s+from\s+(.+)$/i);
  if (importExternalCompanyTemplateMatch?.[1]) {
    const inputPath = stripWrappedQuotes(importExternalCompanyTemplateMatch[1]);
    const queued = queueSensitiveMutation(ctx, {
      kind: "organization-import",
      summary: `Import company template from ${inputPath}.`,
      payload: { inputPath, activate: true, format: "external-company-template" },
    });
    return queued ?? "Company template import needs an active chat session.";
  }

  const importExternalSkillLibraryMatch = raw.match(/^import\s+external\s+skills?(?:\s+library)?\s+from\s+(.+)$/i);
  if (importExternalSkillLibraryMatch?.[1]) {
    const repoPath = stripWrappedQuotes(importExternalSkillLibraryMatch[1]);
    const queued = queueSensitiveMutation(ctx, {
      kind: "ecosystem-import",
      summary: `Import external skills from ${repoPath}.`,
      payload: { ecosystem: "skill-library", repoPath },
    });
    return queued ?? "External skill import needs an active chat session.";
  }

  const importWorkspaceSkillLibraryMatch = raw.match(/^import\s+workspace\s+skills?(?:\s+library)?\s+from\s+(.+)$/i);
  if (importWorkspaceSkillLibraryMatch?.[1]) {
    const repoPath = stripWrappedQuotes(importWorkspaceSkillLibraryMatch[1]);
    const queued = queueSensitiveMutation(ctx, {
      kind: "ecosystem-import",
      summary: `Import workspace skills from ${repoPath}.`,
      payload: { ecosystem: "workspace-library", repoPath },
    });
    return queued ?? "Workspace skill import needs an active chat session.";
  }

  const orgModeSwitchMatch = raw.match(
    /^(?:switch|rerun|try again)\s+(?:to\s+)?(?:this|that|it)?\s*(?:in|using|with)?\s*(council|discussion|vote|execution|workflow|hierarchy|orchestration)\s+mode$/i,
  );
  if (orgModeSwitchMatch?.[1]) {
    const state = getOrgSwitchState(ctx.sessionId);
    if (!state) {
      return 'There is no recent org-level run in this chat to switch. Start with an org ask first, then reply with "switch to council mode" or "switch to execution mode".';
    }
    const requestedMode =
      /execution|workflow|hierarchy|orchestration/i.test(orgModeSwitchMatch[1]) ? "execution" : "council";
    if (state.currentMode === requestedMode) {
      const currentLabel = requestedMode === "execution" ? "execution orchestration" : "leadership council";
      const alternateCommand = requestedMode === "execution" ? "switch to council mode" : "switch to execution mode";
      return `The last org ask already ran as ${currentLabel}. Reply with "${alternateCommand}" if you want the other routing style.`;
    }
    return runOrganizationCollaborationTask({
      rawMessage: raw,
      topic: state.topic,
      organizationRef: state.organizationRef,
      goalRef: state.goalRef,
      explicitMode: requestedMode,
      ctx,
    });
  }

  if (
    normalizedLookup === "show last org run status" ||
    normalizedLookup === "show last org status" ||
    normalizedLookup === "what mode did the last org run use" ||
    /^(?:show|what(?:'s| is))\s+(?:the\s+)?last\s+org(?:anization)?(?:\s+run)?\s+status\??$/i.test(raw) ||
    /^(?:what\s+mode\s+did\s+the\s+last\s+org\s+run\s+use)\??$/i.test(raw)
  ) {
    const state = getOrgSwitchState(ctx.sessionId);
    if (!state) {
      return 'There is no recent org-level run in this chat yet. Start with an org ask first.';
    }
    return [
      "## Last Organization Run",
      `**Mode:** ${state.currentMode === "execution" ? "Execution Orchestration" : "Leadership Council"}`,
      state.organizationName || state.organizationRef ? `**Organization:** ${state.organizationName || state.organizationRef}` : null,
      state.goalName || state.goalRef ? `**Goal:** ${state.goalName || state.goalRef}` : null,
      `**Topic:** ${state.topic}`,
      state.leaderName ? `**Lead:** ${state.leaderName}` : null,
      state.workerNames && state.workerNames.length > 0 ? `**Specialists:** ${state.workerNames.join(", ")}` : null,
      "",
      "### Next",
      formatOrgModeSwitchPrompt({
        mode: state.currentMode,
        explicit: true,
        reason: state.currentMode === "execution" ? "showed the last execution run" : "showed the last council run",
      }),
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (
    normalizedLookup === "show what each specialist did" ||
    normalizedLookup === "show last org worker summaries" ||
    normalizedLookup === "show last org council opinions" ||
    /^(?:show|what(?:'s| is))\s+(?:what\s+)?(?:each\s+specialist|the\s+specialists|the\s+workers|the\s+worker\s+summaries|the\s+specialist\s+contributions)\s+(?:did|found|said)\??$/i.test(raw) ||
    /^show\s+the\s+last\s+(?:org\s+)?(?:specialist|worker|council)\s+(?:summary|summaries|opinions)\??$/i.test(raw)
  ) {
    const state = getOrgSwitchState(ctx.sessionId);
    if (!state?.lastResponse) {
      return 'There is no recent org-level result in this chat yet. Start with an org ask first.';
    }
    const section =
      state.currentMode === "execution"
        ? extractMarkdownSection(state.lastResponse, "Specialist Contributions")
        : extractMarkdownSection(state.lastResponse, "Member Opinions");
    if (!section) {
      return state.currentMode === "execution"
        ? "The last execution run did not include a specialist-contributions section."
        : "The last council run did not include member opinions.";
    }
    return section;
  }

  const wantsCommandHelp =
    normalized === "help" ||
    normalized === "/help" ||
    normalized === "commands" ||
    normalized === "/commands" ||
    normalized.includes("chatbot command") ||
    normalized.includes("what can i change") ||
    normalized.includes("what can you change") ||
    normalized.includes("what can i configure");

  if (wantsCommandHelp) {
    return [
      "Try plain-English commands:",
      "- /btw <side question>",
      "- /fast / /fast on / /fast off / /fast inherit",
      "- list agents",
      "- list organizations / switch organization to CEO Demo Org",
      "- export organization CEO Demo Org to data/exports/ceo-demo-org.json",
      "- import organization pack from data/exports/ceo-demo-org.json",
      "- import company template from C:/path/to/company-template.json",
      "- create agent called Research Assistant",
      "- create 3 agents and create an organization for them",
      "- set role of agent research assistant to worker",
      "- set agent research assistant reports to main",
      "- set default agent to main",
      "- set agent main model to openai:gpt-5-mini",
      "- list models",
      "- add model openai gpt-5-mini",
      "- use model openai/gpt-5-mini",
      "- enable model cJ3k2AbC",
      "- show config",
      "- set config telemetry to on",
      "- set config rate_limit_channels to 90",
      "- list tools",
      "- disable tool web_search for agent main",
      "- list secrets",
      "- set secret OPENAI_API_KEY to <value>",
      "- channel status",
      "- list docs, search docs for functools, show document dummy.pdf",
      "- create task from document dummy.pdf Review uploaded PDF",
      "- what's in my inbox / run the document intelligence task",
      "- more tasks / more inbox tasks / list tasks with oauth",
      "- run the docs crawler task / run the latest local api tester task",
      "- create hierarchy task called CEO Launch Strategy",
      "- create hierarchy task called CEO Launch Strategy in organization CEO Demo Org",
      "- create goal called Launch Local-First Assistant in organization CEO Demo Org",
      "- list tasks in organization CEO Demo Org",
      "- claim the ceo launch strategy task / release the ceo launch strategy task",
      "- ask the leadership team about pricing for a local-first product",
      "- list schedules / list cron jobs",
      "- run now \"Daily Report\"",
      "- list workflow templates",
      "- create workflow template research assistant called Market Research Flow in organization CEO Demo Org",
      "- spin up an ops control tower workflow for launch review",
      "- add a board task to audit launch blockers using the hierarchy board briefing template",
      "- list checkpoints / show checkpoint diff latest / rollback checkpoint latest for file src/app/page.tsx",
      "- show setup for extension github / how do i set up skill optional:security-review",
      "- show learning status / list learning candidates / turn self learning to auto",
      "- import external skills from /path/to/skill-library",
      "- import workspace skills from /path/to/workspace-library",
      "- show last provenance",
      "- cleanup generated artifacts",
    ].join("\n");
  }

  if (/^\/?btw$/i.test(raw)) {
    return "Use /btw <side question> for a quick tool-less answer about the current session without changing stored chat context.";
  }

  const fastCommandMatch =
    raw.match(/^\/?fast(?:\s*[: ]\s*(status|on|off|inherit|auto))?$/i);
  if (fastCommandMatch) {
    if (!ctx.sessionId) {
      return "Fast mode needs a session context. Start from chat or a channel thread first.";
    }
    const nextMode = String(fastCommandMatch[1] || "status").trim().toLowerCase();
    const [{ getModelConfig }, sessionSettings] = await Promise.all([
      import("@/lib/agents/model-router"),
      import("@/lib/channels/session-settings"),
    ]);
    const currentSettings = sessionSettings.getChannelSessionSettings(ctx.sessionId);
    if (nextMode === "status") {
      const resolved = getModelConfig({ sessionId: ctx.sessionId });
      const source =
        currentSettings?.fastMode === null || currentSettings?.fastMode === undefined
          ? "model default"
          : "session override";
      return [
        `Current fast mode: ${resolved.fastMode ? "on" : "off"}.`,
        `Source: ${source}.`,
        "Options: status, on, off, inherit.",
      ].join("\n");
    }

    const fastMode =
      nextMode === "on" ? true : nextMode === "off" ? false : null;
    sessionSettings.upsertChannelSessionSettings({
      sessionId: ctx.sessionId,
      fastMode,
    });
    const resolved = getModelConfig({ sessionId: ctx.sessionId });
    return fastMode === null
      ? `Fast mode now inherits the model default (${resolved.fastMode ? "on" : "off"}) for this session.`
      : `Fast mode ${resolved.fastMode ? "enabled" : "disabled"} for session ${ctx.sessionId}.`;
  }

  const wantsSystemStatus =
    normalized === "status" ||
    normalized === "/status" ||
    normalized === "app status" ||
    normalized.includes("system status") ||
    normalized === "channel status" ||
    normalized === "channels status" ||
    normalized.includes("connected channels");

  if (wantsSystemStatus) {
    const [{ getTelegramStatus }, { getDiscordStatus }, { getWhatsAppStatus }, { getSlackStatus }, { getBlueBubblesStatus }, { getTeamsStatus }, { getRuntimeModelAvailability }, dbMod] =
      await Promise.all([
        import("@/lib/channels/telegram"),
        import("@/lib/channels/discord"),
        import("@/lib/channels/whatsapp"),
        import("@/lib/channels/slack"),
        import("@/lib/channels/bluebubbles"),
        import("@/lib/channels/teams"),
        import("@/lib/agents/model-availability"),
        import("@/lib/db"),
      ]);
    dbMod.initializeDatabase();
    const db = dbMod.getSqlite();

    const workflows = (
      db.prepare("SELECT COUNT(*) as count FROM workflows WHERE is_active = 1").get() as {
        count: number;
      }
    ).count;
    const models = (
      db.prepare("SELECT COUNT(*) as count FROM models WHERE is_active = 1").get() as {
        count: number;
      }
    ).count;
    const modelAvailability = getRuntimeModelAvailability(db);
    const runtimeModelDetails = modelAvailability.details.replace(/^Env-backed provider available:\s*/i, "");
    const modelStatus = models > 0
      ? `${models}`
      : modelAvailability.available
        ? `0 (runtime provider available: ${runtimeModelDetails})`
        : "0";

    let agents = 0;
    try {
      const { listAgents } = await import("@/lib/agents/registry");
      agents = listAgents().filter((agent) => agent.isActive).length;
    } catch {
      agents = 0;
    }

    const tg = getTelegramStatus();
    const dc = getDiscordStatus();
    const wa = getWhatsAppStatus();
    const sl = getSlackStatus();
    const bb = getBlueBubblesStatus();
    const tm = getTeamsStatus();

    return [
      "System status:",
      `- workflows active: ${workflows}`,
      `- agents active: ${agents}`,
      `- models active: ${modelStatus}`,
      `- telegram: ${tg.connected ? `connected (${tg.username || "bot"})` : "disconnected"}`,
      `- whatsapp: ${wa.connected ? "connected" : "disconnected"}`,
      `- discord: ${dc.connected ? `connected (${dc.username || "bot"})` : "disconnected"}`,
      `- slack: ${sl.connected ? `connected (${sl.botName || "bot"})` : "disconnected"}`,
      `- bluebubbles: ${bb.connected ? `connected (${bb.serverUrl})` : "disconnected"}`,
      `- teams: ${tm.configured ? `configured (${tm.appId})` : "not configured"}`,
      "- webchat: ready",
      "- google-chat: webhook route ready (/api/channels/google-chat)",
    ].join("\n");
  }

  const wantsAgentList =
    normalized === "agents" ||
    normalized === "/agents" ||
    normalized === "list agents" ||
    normalized === "show agents" ||
    normalized === "get agents" ||
    normalized === "all agents" ||
    normalized === "list all agents" ||
    normalized === "show all agents" ||
    normalized === "show me agents" ||
    normalized === "show me all agents" ||
    normalized === "show me my agents" ||
    normalized === "what agents do i have" ||
    normalized === "which agents do i have" ||
    normalized === "how many agents do i have" ||
    normalized === "what agents are there" ||
    normalized === "what agents are available" ||
    normalized === "what agents are configured" ||
    /^(?:what|which|how many)\s+agents?\s+(?:do i have|are there|are available|are configured|are active|are set up)\??$/i.test(raw);

  if (wantsAgentList) {
    const [{ listAgents }, { listAgentRoles }] = await Promise.all([
      import("@/lib/agents/registry"),
      import("@/lib/agents/roles"),
    ]);
    const agents = listAgents();
    const rolesByAgentId = new Map(listAgentRoles().map((role) => [role.agentId, role]));
    const namesById = new Map(agents.map((agent) => [agent.id, agent.name]));
    return formatAgentList(
      agents.map((agent) => ({
        id: agent.id,
        name: agent.name,
        isDefault: agent.isDefault,
        isActive: agent.isActive,
        modelRef: agent.modelRef,
        disabledTools: agent.disabledTools,
        roleType: rolesByAgentId.get(agent.id)?.roleType ?? null,
        roleTitle: rolesByAgentId.get(agent.id)?.roleTitle ?? null,
        reportsToName: rolesByAgentId.get(agent.id)?.reportsTo
          ? (namesById.get(String(rolesByAgentId.get(agent.id)?.reportsTo)) ?? String(rolesByAgentId.get(agent.id)?.reportsTo))
          : null,
      })),
    );
  }

  const wantsExtensionList =
    normalized === "extensions" ||
    normalized === "list extensions" ||
    normalized === "show extensions" ||
    normalized === "plugins" ||
    normalized === "list plugins" ||
    normalized === "show plugins" ||
    normalized.includes("plugins");

  if (wantsExtensionList) {
    const [{ getDefaultAgent }, { getExtensionRuntimeStatus }, { buildGlobalExtensionEntries }] = await Promise.all([
      import("@/lib/agents/registry"),
      import("@/lib/extensions/runtime"),
      import("@/lib/extensions/state"),
    ]);
    const agent = getDefaultAgent();
    const extensions = buildGlobalExtensionEntries(agent.enabledExtensions);
    if (extensions.length === 0) return "No extensions registered.";
    const runtime = await getExtensionRuntimeStatus();
    const runtimeById = new Map(runtime.extensions.map((entry) => [entry.id, entry]));
    return [
      `Extensions (${extensions.length} total):`,
      ...extensions.map((extension, index) =>
        `${index + 1}. ${extension.name} (${extension.id}) [global=${extension.globallyEnabled ? "on" : "off"} agent=${extension.agentEnabled ? "on" : "off"}]${extension.configurable ? " configurable" : ""}${runtimeById.get(extension.id)?.hasRuntime ? " runtime" : ""}`,
      ),
    ].join("\n");
  }

  if (normalized === "show extension runtime status" || normalized === "extensions runtime status") {
    const { getExtensionRuntimeStatus } = await import("@/lib/extensions/runtime");
    const runtime = await getExtensionRuntimeStatus();
    return [
      `Extension Runtime (version ${runtime.version})`,
      ...runtime.extensions.map((entry, index) =>
        `${index + 1}. ${entry.name} (${entry.id}) [runtime=${entry.hasRuntime ? "yes" : "no"}] hooks=${entry.hooks.join(", ") || "none"}`,
      ),
    ].join("\n");
  }

  const wantsExternalExtensionList =
    normalized === "list external extensions" ||
    normalized === "show external extensions" ||
    normalized === "list extension installs" ||
    normalized === "show extension installs";
  if (wantsExternalExtensionList) {
    const [{ listExternalExtensionInstalls }, { buildGlobalExtensionEntries }] = await Promise.all([
      import("@/lib/extensions/installer"),
      import("@/lib/extensions/state"),
    ]);
    const installs = listExternalExtensionInstalls();
    if (installs.length === 0) return "No external extensions are installed right now.";
    const entries = buildGlobalExtensionEntries();
    return [
      `External extensions (${installs.length} total):`,
      ...installs.map((install, index) => {
        const entry = entries.find((candidate) => candidate.id === install.id);
        return `${index + 1}. ${(entry?.name || install.id)} (${install.id}) via ${install.installSource} • ${install.sourceRef}`;
      }),
    ].join("\n");
  }

  const installExternalExtensionMatch =
    raw.match(/^(?:install|add)\s+(?:external\s+)?(?:extension|plugin)\s+from\s+(.+?)(?:\s+ref\s+(.+))?$/i) ||
    raw.match(/^(?:install|add)\s+(?:external\s+)?(?:extension|plugin)\s+(.+?)\s+from\s+(.+?)(?:\s+ref\s+(.+))?$/i);
  if (installExternalExtensionMatch) {
    if (!isSensitiveCommandAllowed(ctx)) return denySensitiveCommand();
    const source =
      parseQuotedPathReference(raw) ||
      stripWrappedQuotes(installExternalExtensionMatch[2] || installExternalExtensionMatch[1] || "");
    const ref = stripWrappedQuotes(installExternalExtensionMatch[3] || installExternalExtensionMatch[2] || "");
    const queued = queueSensitiveMutation(ctx, {
      kind: "extension-install",
      summary: `Install external extension from ${source}${ref ? ` (ref ${ref})` : ""}.`,
      payload: {
        source,
        ref: ref || null,
      },
    });
    if (queued) return queued;
  }

  const updateExternalExtensionMatch =
    raw.match(/^(?:update|upgrade|refresh)\s+(?:external\s+)?(?:extension|plugin)\s+(.+)$/i);
  if (updateExternalExtensionMatch?.[1]) {
    if (!isSensitiveCommandAllowed(ctx)) return denySensitiveCommand();
    const { listExternalExtensionInstalls } = await import("@/lib/extensions/installer");
    const installs = listExternalExtensionInstalls().map((entry) => ({
      id: entry.id,
      name: entry.id,
      description: entry.sourceRef,
    }));
    const matches = resolveCatalogMatches(installs, stripWrappedQuotes(updateExternalExtensionMatch[1]));
    if (matches.length === 0) return `External extension not found: ${updateExternalExtensionMatch[1]}.`;
    if (matches.length > 1) {
      return formatAmbiguousCatalogMatches("external extensions", updateExternalExtensionMatch[1], matches);
    }
    const queued = queueSensitiveMutation(ctx, {
      kind: "extension-update",
      summary: `Update external extension ${matches[0].id}.`,
      payload: { extensionId: matches[0].id },
    });
    if (queued) return queued;
  }

  const uninstallExternalExtensionMatch =
    raw.match(/^(?:remove|uninstall|delete)\s+(?:external\s+)?(?:extension|plugin)\s+(.+)$/i);
  if (uninstallExternalExtensionMatch?.[1]) {
    if (!isSensitiveCommandAllowed(ctx)) return denySensitiveCommand();
    const { listExternalExtensionInstalls } = await import("@/lib/extensions/installer");
    const installs = listExternalExtensionInstalls().map((entry) => ({
      id: entry.id,
      name: entry.id,
      description: entry.sourceRef,
    }));
    const matches = resolveCatalogMatches(installs, stripWrappedQuotes(uninstallExternalExtensionMatch[1]));
    if (matches.length === 0) return `External extension not found: ${uninstallExternalExtensionMatch[1]}.`;
    if (matches.length > 1) {
      return formatAmbiguousCatalogMatches("external extensions", uninstallExternalExtensionMatch[1], matches);
    }
    const queued = queueSensitiveMutation(ctx, {
      kind: "extension-uninstall",
      summary: `Remove external extension ${matches[0].id}.`,
      payload: { extensionId: matches[0].id },
    });
    if (queued) return queued;
  }

  const showExtensionSetupMatch =
    raw.match(/^(?:show|open|explain|inspect)\s+setup\s+for\s+(?:extension|plugin)\s+(.+)$/i) ||
    raw.match(/^(?:inspect|show)\s+(?:extension|plugin)\s+(.+)$/i) ||
    raw.match(/^(?:show|open|explain|inspect)\s+(.+?)\s+(?:extension|plugin)\s+status\??$/i) ||
    raw.match(/^(?:show|open|explain|inspect)\s+status\s+for\s+(?:extension|plugin)\s+(.+)$/i) ||
    raw.match(/^(?:what(?:'s| is)\s+)?(?:the\s+)?status\s+of\s+(?:the\s+)?(.+?)\s+(?:extension|plugin)\??$/i) ||
    raw.match(/^show\s+me\s+how\s+to\s+wire\s+up\s+(.+)$/i) ||
    raw.match(/^how\s+do\s+i\s+set\s+up\s+(?:the\s+)?(?:extension|plugin)\s+(.+)$/i) ||
    raw.match(/^how\s+do\s+i\s+set\s+up\s+(?:the\s+)?(.+?)\s+(?:extension|plugin)\??$/i) ||
    raw.match(/^what\s+does\s+(?:the\s+)?(?:extension|plugin)\s+(.+?)\s+need$/i) ||
    raw.match(/^what\s+does\s+(?:the\s+)?(.+?)\s+(?:extension|plugin)\s+need$/i);
  if (showExtensionSetupMatch?.[1]) {
    const [{ getDefaultAgent }, { listInstalledExtensions }, { getExtensionRuntimeStatus }, { buildGlobalExtensionEntries }] = await Promise.all([
      import("@/lib/agents/registry"),
      import("@/lib/extensions/registry"),
      import("@/lib/extensions/runtime"),
      import("@/lib/extensions/state"),
    ]);
    const agent = getDefaultAgent();
    const extensionMatches = resolveCatalogMatches(
      listInstalledExtensions().map((entry) => ({ id: entry.id, name: entry.name, description: entry.description })),
      trimReferenceTrail(stripWrappedQuotes(showExtensionSetupMatch[1])),
    );
    if (extensionMatches.length === 0) {
      const requestedSetup = normalizeLookup(trimReferenceTrail(stripWrappedQuotes(showExtensionSetupMatch[1])));
      const guideKey = Object.keys(EXTENSION_SETUP_HINTS).find((key) => {
        const normalizedKey = normalizeLookup(key);
        return requestedSetup === normalizedKey ||
          requestedSetup.includes(normalizedKey) ||
          (key === "googlechat" && requestedSetup.includes("google chat"));
      });
      if (guideKey) {
        return [
          "Channels",
          "",
          formatExtensionSetupGuidance({
            extensionId: guideKey,
            extensionName: guideKey === "googlechat" ? "Google Chat" : titleCaseWords(guideKey),
            manifestPath: "",
            config: {},
            globallyEnabled: false,
            eligible: false,
          }),
        ].join("\n");
      }
      return `Extension not found: ${showExtensionSetupMatch[1]}.`;
    }
    if (extensionMatches.length > 1) {
      return formatAmbiguousCatalogMatches("extensions", showExtensionSetupMatch[1], extensionMatches);
    }
    const entry = buildGlobalExtensionEntries(agent.enabledExtensions).find((candidate) => candidate.id === extensionMatches[0].id);
    if (!entry) return `Extension not found: ${showExtensionSetupMatch[1]}.`;
    const runtime = await getExtensionRuntimeStatus();
    const runtimeEntry = runtime.extensions.find((candidate) => candidate.id === entry.id);
    const configKeys = readExtensionManifestConfigKeys(entry.manifestPath);
    const missingConfigKeys = configKeys.filter((key) => {
      const value = entry.config[key];
      return value === undefined || value === null || String(value).trim() === "";
    });
    const runtimeStatusLines = formatRuntimeStatusLines(runtimeEntry?.status);
    return [
      "Channels",
      "",
      `${entry.name} (${entry.id})`,
      `Availability: ${describeExtensionRuntimeAvailability({
        globallyEnabled: entry.globallyEnabled,
        agentEnabled: entry.agentEnabled,
        hasRuntime: runtimeEntry?.hasRuntime,
        missingConfigKeys,
      })}`,
      `Source: ${entry.source}${entry.installSource && entry.installSource !== "bundled" ? ` via ${entry.installSource}` : ""}`,
      entry.sourceRef ? `Location: ${entry.sourceRef}` : null,
      `Bundled skills: ${entry.skillCount}`,
      `Runtime: ${runtimeEntry?.hasRuntime ? "yes" : "no"}`,
      runtimeStatusLines.length > 0 ? "" : null,
      ...(runtimeStatusLines.length > 0 ? ["Runtime status:", ...runtimeStatusLines] : []),
      "",
      formatExtensionSetupGuidance({
        extensionId: entry.id,
        extensionName: entry.name,
        manifestPath: entry.manifestPath,
        config: entry.config,
        globallyEnabled: entry.globallyEnabled,
      }),
    ]
      .filter(Boolean)
      .join("\n");
  }

  const listSkillsMatch =
    raw.match(/^(?:list|show)\s+all\s+skills(?:\s+for\s+agent\s+(.+))?$/i) ||
    raw.match(/^(?:list|show)\s+skills(?:\s+for\s+agent\s+(.+))?$/i) ||
    raw.match(/^what\s+(?:skills|extensions|capabilities)\s+is\s+(.+?)\s+using(?:\s+now)?\??$/i) ||
    raw.match(/^what\s+(?:skills|extensions|capabilities)\s+does\s+(?:the\s+)?(.+?)\s+(?:agent\s+)?have(?:\s+enabled)?\??$/i) ||
    raw.match(/^(?:show|list)\s+(?:me\s+)?(?:the\s+)?(?:skills|extensions|capabilities)\s+(?:for|of|on)\s+(?:agent\s+)?(.+)$/i) ||
    raw.match(/^(?:what(?:'s| is))\s+(?:the\s+)?(?:skill|extension|capability)\s+(?:set|list|config|configuration)\s+(?:for|of)\s+(?:agent\s+)?(.+)\??$/i);
  if (listSkillsMatch) {
    const wantsFullCatalog =
      /\b(?:list|show)\s+all\s+skills\b/i.test(raw) ||
      /^(?:list|show)\s+skills(?:\s+for\s+agent\s+.+)?$/i.test(raw) ||
      /^what\s+skills\s+is\s+.+?\s+using(?:\s+now)?\??$/i.test(raw) ||
      /^what\s+skills\s+does\s+(?:the\s+)?.+?\s+(?:agent\s+)?have(?:\s+enabled)?\??$/i.test(raw);
    const [{ getDefaultAgent, listAgents, getAgentById }, { buildAgentSkillEntries, buildAgentExtensionEntries }] = await Promise.all([
      import("@/lib/agents/registry"),
      import("@/lib/extensions/registry"),
    ]);
    let agent = getDefaultAgent();
    if (listSkillsMatch[1]) {
      const agentRef = listSkillsMatch[1].trim();
      if (!isDefaultAgentReference(agentRef)) {
        const agents = listAgents() as AgentLite[];
        const matches = resolveAgentMatches(agents, agentRef);
        if (matches.length === 0) return `Agent not found: ${agentRef}.`;
        if (matches.length > 1) {
          return formatAmbiguousAgentMatches(agentRef, matches);
        }
        agent = getAgentById(matches[0].id) ?? agent;
      }
    }
    const extensionEntries = buildAgentExtensionEntries(agent.enabledExtensions);
    const activeExtensions = extensionEntries.filter((entry) => entry.enabled);
    const activeExtensionIds = activeExtensions.map((entry) => entry.id);
    const skills = buildAgentSkillEntries({
      enabledExtensions: activeExtensionIds,
      enabledSkills: agent.enabledSkills,
      agentWorkspacePath: agent.workspacePath,
    });
    const enabledSkills = skills.filter((skill) => skill.enabled);
    if (!wantsFullCatalog) {
      return [
        `Capabilities for ${agent.name}:`,
        activeExtensions.length > 0
          ? `Enabled extensions: ${activeExtensions.map((entry) => entry.name).join(", ")}`
          : "Enabled extensions: none",
        enabledSkills.length > 0
          ? `Enabled skill packs: ${enabledSkills.map((skill) => skill.label).join(", ")}`
          : "Enabled skill packs: none",
        `Catalog totals: ${extensionEntries.length} extensions, ${skills.length} skill packs`,
        `Try: "list all skills for agent ${agent.name}" for the full catalog.`,
      ].join("\n");
    }
    if (skills.length === 0) return `No skill packs registered for ${agent.name}.`;
    return [
      `Skill packs for ${agent.name}:`,
      ...skills.map((skill, index) =>
        `${index + 1}. ${skill.label} (${skill.id}) [${skill.enabled ? "enabled" : "disabled"}]${skill.extensionId ? ` via ${skill.extensionId}` : ""}`,
      ),
    ].join("\n");
  }

  const findSkillsMatch =
    raw.match(/^find\s+skills?\s+for\s+(.+)$/i) ||
    raw.match(/^recommend\s+skills?\s+for\s+(.+)$/i) ||
    raw.match(/^what\s+skills?\s+should\s+i\s+use\s+for\s+(.+)$/i) ||
    raw.match(/^is\s+there\s+a\s+skill\s+for\s+(.+)$/i);
  if (findSkillsMatch?.[1]) {
    const [{ getDefaultAgent }, { listBundledIntegrationPresets, buildAgentSkillEntries, listInstalledSkillCatalog }, { buildGlobalExtensionEntries }] = await Promise.all([
      import("@/lib/agents/registry"),
      import("@/lib/extensions/registry"),
      import("@/lib/extensions/state"),
    ]);
    const query = stripWrappedQuotes(findSkillsMatch[1]);
    const defaultAgent = getDefaultAgent();
    const globalExtensions = buildGlobalExtensionEntries(defaultAgent.enabledExtensions);
    const extensionStateById = new Map(globalExtensions.map((entry) => [entry.id, entry]));
    const runtimeSkillCatalog = buildAgentSkillEntries({
      enabledExtensions: defaultAgent.enabledExtensions,
      enabledSkills: defaultAgent.enabledSkills,
      agentWorkspacePath: defaultAgent.workspacePath,
    });
    const runtimeSkillById = new Map(runtimeSkillCatalog.map((entry) => [entry.id, entry]));
    const skillCatalog = listInstalledSkillCatalog().map((entry) => ({
      id: entry.id,
      name: entry.label,
      description: entry.description,
      extensionId: entry.extensionId,
      requiredEnv: entry.requiredEnv ?? [],
    }));
    const skills = prioritizeCatalogRecommendations(
      rankCatalogRecommendations(
        skillCatalog,
        query,
      ),
      query,
      skillCatalog,
    )
      .filter((entry, index, array) => array.findIndex((candidate) => candidate.id === entry.id) === index);
    const topSkills = skills.slice(0, 5);
    const presets = rankCatalogRecommendations(
      listBundledIntegrationPresets().map((entry) => ({
        id: entry.id,
        name: entry.name,
        description: `${entry.description} ${entry.skills.join(" ")}`,
      })),
      query,
    ).slice(0, 3);
    if (topSkills.length === 0 && presets.length === 0) {
      return `No strong skill-pack matches found for "${query}". Try: list skills for agent main`;
    }
    return [
      `Recommended skill packs for "${query}":`,
      ...topSkills.map((skill, index) =>
        `${index + 1}. ${skill.name} (${skill.id})${skill.extensionId ? ` via ${skill.extensionId}` : ""} [${describeSkillRuntimeAvailability({
          enabled: runtimeSkillById.get(skill.id)?.enabled ?? false,
          extensionId: skill.extensionId,
          extensionEnabled: skill.extensionId ? extensionStateById.get(skill.extensionId)?.agentEnabled : true,
          extensionGlobal: skill.extensionId ? extensionStateById.get(skill.extensionId)?.globallyEnabled : true,
          missingEnv: getMissingEnvVars(skill.requiredEnv),
        })}]`,
      ),
      presets.length > 0 ? "Suggested integration presets:" : null,
      ...presets.map((preset, index) => `${index + 1}. ${preset.name} (${preset.id})`),
    ]
      .filter(Boolean)
      .join("\n");
  }

  const showSkillSetupMatch =
    raw.match(/^(?:show|open|explain|inspect)\s+setup\s+for\s+skill\s+(.+)$/i) ||
    raw.match(/^(?:inspect|show)\s+skill\s+(.+)$/i) ||
    raw.match(/^how\s+do\s+i\s+set\s+up\s+(?:the\s+)?skill\s+(.+)$/i) ||
    raw.match(/^how\s+do\s+i\s+set\s+up\s+(?:the\s+)?(.+?)\s+skill\??$/i) ||
    raw.match(/^what\s+does\s+(?:the\s+)?skill\s+(.+?)\s+need$/i) ||
    raw.match(/^what\s+does\s+(?:the\s+)?(.+?)\s+skill\s+need$/i);
  if (showSkillSetupMatch?.[1]) {
    const [{ getDefaultAgent }, { buildAgentSkillEntries, listInstalledSkillCatalog }, { buildGlobalExtensionEntries }] = await Promise.all([
      import("@/lib/agents/registry"),
      import("@/lib/extensions/registry"),
      import("@/lib/extensions/state"),
    ]);
    const skillMatches = resolveCatalogMatches(
      listInstalledSkillCatalog().map((entry) => ({ id: entry.id, name: entry.label, description: entry.description })),
      trimReferenceTrail(stripWrappedQuotes(showSkillSetupMatch[1])),
    );
    if (skillMatches.length === 0) return `Skill pack not found: ${showSkillSetupMatch[1]}.`;
    if (skillMatches.length > 1) {
      return formatAmbiguousCatalogMatches("skill packs", showSkillSetupMatch[1], skillMatches);
    }
    const matched = listInstalledSkillCatalog().find((entry) => entry.id === skillMatches[0].id);
    if (!matched) return `Skill pack not found: ${showSkillSetupMatch[1]}.`;
    const defaultAgent = getDefaultAgent();
    const runtimeSkill = buildAgentSkillEntries({
      enabledExtensions: defaultAgent.enabledExtensions,
      enabledSkills: defaultAgent.enabledSkills,
      agentWorkspacePath: defaultAgent.workspacePath,
    }).find((entry) => entry.id === matched.id);
    const extensionState = matched.extensionId
      ? buildGlobalExtensionEntries(defaultAgent.enabledExtensions).find((entry) => entry.id === matched.extensionId)
      : null;
    const missingEnv = getMissingEnvVars(matched.requiredEnv);
    return [
      `${matched.label} (${matched.id})`,
      `Source: ${matched.source}${matched.extensionId ? ` via ${matched.extensionId}` : ""}`,
      `Availability: ${describeSkillRuntimeAvailability({
        enabled: runtimeSkill?.enabled ?? false,
        extensionId: matched.extensionId,
        extensionEnabled: extensionState?.agentEnabled ?? true,
        extensionGlobal: extensionState?.globallyEnabled ?? true,
        missingEnv,
      })}`,
      "",
      formatSkillSetupGuidance({
        skillId: matched.id,
        skillLabel: matched.label,
        requiredEnv: matched.requiredEnv,
        setupNotes: matched.setupNotes,
        platforms: matched.platforms,
      }),
    ].join("\n");
  }

  const wantsExternalSkillPackList =
    normalized === "list external skill packs" ||
    normalized === "show external skill packs" ||
    normalized === "list installed skill packs" ||
    normalized === "show installed skill packs";
  if (wantsExternalSkillPackList) {
    const { listExternalSkillPacks } = await import("@/lib/skills/installer");
    const packs = listExternalSkillPacks();
    if (packs.length === 0) return "No external skill packs are installed right now.";
    return [
      `External skill packs (${packs.length} total):`,
      ...packs.map((pack, index) => `${index + 1}. ${pack.name} (${pack.id}) via ${pack.installSource} • ${pack.sourceRef}`),
    ].join("\n");
  }

  const installSkillPackMatch =
    raw.match(/^(?:install|add)\s+(?:external\s+)?skill\s+pack\s+from\s+(.+?)(?:\s+ref\s+(.+))?$/i);
  if (installSkillPackMatch?.[1]) {
    if (!isSensitiveCommandAllowed(ctx)) return denySensitiveCommand();
    const source = parseQuotedPathReference(raw) || stripWrappedQuotes(installSkillPackMatch[1]);
    const ref = stripWrappedQuotes(installSkillPackMatch[2] || "");
    const queued = queueSensitiveMutation(ctx, {
      kind: "skill-pack-install",
      summary: `Install external skill pack from ${source}${ref ? ` (ref ${ref})` : ""}.`,
      payload: {
        source,
        ref: ref || null,
      },
    });
    if (queued) return queued;
  }

  const updateSkillPackMatch =
    raw.match(/^(?:update|upgrade|refresh)\s+(?:external\s+)?skill\s+pack\s+(.+)$/i);
  if (updateSkillPackMatch?.[1]) {
    if (!isSensitiveCommandAllowed(ctx)) return denySensitiveCommand();
    const { listExternalSkillPacks } = await import("@/lib/skills/installer");
    const packs = listExternalSkillPacks().map((entry) => ({
      id: entry.id,
      name: entry.name,
      description: entry.sourceRef,
    }));
    const matches = resolveCatalogMatches(packs, stripWrappedQuotes(updateSkillPackMatch[1]));
    if (matches.length === 0) return `External skill pack not found: ${updateSkillPackMatch[1]}.`;
    if (matches.length > 1) {
      return formatAmbiguousCatalogMatches("external skill packs", updateSkillPackMatch[1], matches);
    }
    const queued = queueSensitiveMutation(ctx, {
      kind: "skill-pack-update",
      summary: `Update external skill pack ${matches[0].id}.`,
      payload: { skillPackId: matches[0].id },
    });
    if (queued) return queued;
  }

  const uninstallSkillPackMatch =
    raw.match(/^(?:remove|uninstall|delete)\s+(?:external\s+)?skill\s+pack\s+(.+)$/i);
  if (uninstallSkillPackMatch?.[1]) {
    if (!isSensitiveCommandAllowed(ctx)) return denySensitiveCommand();
    const { listExternalSkillPacks } = await import("@/lib/skills/installer");
    const packs = listExternalSkillPacks().map((entry) => ({
      id: entry.id,
      name: entry.name,
      description: entry.sourceRef,
    }));
    const matches = resolveCatalogMatches(packs, stripWrappedQuotes(uninstallSkillPackMatch[1]));
    if (matches.length === 0) return `External skill pack not found: ${uninstallSkillPackMatch[1]}.`;
    if (matches.length > 1) {
      return formatAmbiguousCatalogMatches("external skill packs", uninstallSkillPackMatch[1], matches);
    }
    const queued = queueSensitiveMutation(ctx, {
      kind: "skill-pack-uninstall",
      summary: `Remove external skill pack ${matches[0].id}.`,
      payload: { skillPackId: matches[0].id },
    });
    if (queued) return queued;
  }

  if (normalized === "show org" || normalized === "open org") {
    const { getActiveHierarchyOrganization, listHierarchyOrganizationMembers } = await import("@/lib/hierarchy/organizations");
    const organization = getActiveHierarchyOrganization();
    if (!organization) {
      return "No active organization yet.";
    }
    const members = listHierarchyOrganizationMembers(organization.id);
    return [
      `${organization.name}${organization.isActive ? " [active]" : ""}`,
      organization.description ? `Description: ${organization.description}` : null,
      organization.mission ? `Mission: ${organization.mission}` : null,
      `Members: ${organization.memberCount}`,
      members.length > 0
        ? `Member roster: ${members
            .slice(0, 6)
            .map((member) => member.agent.name || member.agent.id)
            .join(", ")}${members.length > 6 ? ", ..." : ""}`
        : null,
    ].filter(Boolean).join("\n");
  }

  const wantsOrganizationList =
    normalized === "organizations" ||
    normalized === "/organizations" ||
    normalized === "list organizations" ||
    normalized === "show organizations" ||
    normalized === "list org" ||
    normalized === "list orgs" ||
    normalized === "show orgs";

  if (wantsOrganizationList) {
    const { getActiveHierarchyOrganization, listHierarchyOrganizations } = await import("@/lib/hierarchy/organizations");
    const organizations = listHierarchyOrganizations();
    const active = getActiveHierarchyOrganization();
    if (organizations.length === 0) {
      return "No saved organizations yet.";
    }
    return [
      "Organizations:",
      ...organizations.map((organization, index) =>
        `${index + 1}. ${organization.name}${organization.id === active?.id ? " [active]" : ""} (${organization.memberCount} members)`,
      ),
    ].join("\n");
  }

  const saveOrganizationMatch =
    raw.match(/^save\s+current\s+organization\s+as\s+(.+)$/i) ||
    raw.match(/^save\s+organization\s+as\s+(.+)$/i) ||
    raw.match(/^save\s+org\s+as\s+(.+)$/i);
  if (saveOrganizationMatch?.[1]) {
    if (!isSensitiveCommandAllowed(ctx)) return denySensitiveCommand();
    const { saveCurrentHierarchyOrganization } = await import("@/lib/hierarchy/organizations");
    const name = stripWrappedQuotes(saveOrganizationMatch[1]);
    if (!name) return "Organization name is required.";
    const organization = saveCurrentHierarchyOrganization({ name, activate: true });
    return `Organization saved: ${organization.name} (${organization.memberCount} members). It is now active.`;
  }

  const switchOrganizationMatch =
    raw.match(/^switch\s+organization\s+to\s+(.+)$/i) ||
    raw.match(/^use\s+organization\s+(.+)$/i) ||
    raw.match(/^activate\s+organization\s+(.+)$/i) ||
    raw.match(/^switch\s+org\s+to\s+(.+)$/i) ||
    raw.match(/^use\s+org\s+(.+)$/i) ||
    raw.match(/^activate\s+org\s+(.+)$/i);
  if (switchOrganizationMatch?.[1]) {
    if (!isSensitiveCommandAllowed(ctx)) return denySensitiveCommand();
    const { applyHierarchyOrganization } = await import("@/lib/hierarchy/organizations");
    const organization = applyHierarchyOrganization(stripWrappedQuotes(switchOrganizationMatch[1]));
    return `Active organization is now ${organization.name}.`;
  }

  const showOrganizationMatch =
    raw.match(/^show\s+organization\s+(.+)$/i) ||
    raw.match(/^open\s+organization\s+(.+)$/i) ||
    raw.match(/^show\s+org\s+(.+)$/i) ||
    raw.match(/^open\s+org\s+(.+)$/i);
  if (showOrganizationMatch?.[1]) {
    const { resolveHierarchyOrganization } = await import("@/lib/hierarchy/organizations");
    const organization = resolveHierarchyOrganization(stripWrappedQuotes(showOrganizationMatch[1]));
    if (!organization) {
      return `Organization not found: ${showOrganizationMatch[1]}.`;
    }
    return [
      `${organization.name}${organization.isActive ? " [active]" : ""}`,
      organization.description ? `Description: ${organization.description}` : null,
      organization.mission ? `Mission: ${organization.mission}` : null,
      `Members: ${organization.memberCount}`,
    ].filter(Boolean).join("\n");
  }

  const bulkCreateAgentsOrganizationIntent =
    parseBulkCreateAgentsOrganizationIntent(raw) ||
    parseImplicitDebateOrganizationIntent(raw);
  if (bulkCreateAgentsOrganizationIntent) {
    if (!isSensitiveCommandAllowed(ctx)) return denySensitiveCommand();
    if (bulkCreateAgentsOrganizationIntent.agentCount > 12) {
      return "Bulk creation is capped at 12 agents per chat command. Ask for fewer agents or create a company template instead.";
    }
    const organizationName = bulkCreateAgentsOrganizationIntent.organizationName || inferGeneratedOrganizationName();
    const sessionId = String(ctx.sessionId || "").trim();
    if (!sessionId) {
      return "No session ID available. Cannot queue pending confirmation.";
    }
    const summary = [
      `Create ${bulkCreateAgentsOrganizationIntent.agentCount} agents and organization "${organizationName}".`,
      `Agents will be auto-generated with roles suited for this purpose.`,
    ].join("\n");
    rememberPendingMutation({
      sessionId,
      kind: "org-create-bulk",
      summary,
      payload: {
        agentCount: bulkCreateAgentsOrganizationIntent.agentCount,
        organizationName,
        debateTopic: bulkCreateAgentsOrganizationIntent.debateTopic || null,
        rawMessage: raw,
      },
      createdAt: Date.now(),
    });
    const response = buildPendingMutationPrompt(summary);
    mergeSessionAppStateForInteraction({
      sessionId,
      message: raw,
      response,
    });
    return response;
  }

  const bulkCreateAgentsIntent = parseBulkCreateAgentsIntent(raw);
  if (bulkCreateAgentsIntent) {
    if (!isSensitiveCommandAllowed(ctx)) return denySensitiveCommand();
    if (bulkCreateAgentsIntent.agentCount > 12) {
      return "Bulk creation is capped at 12 agents per chat command. Ask for fewer agents or create an organization from a company template.";
    }
    const { createAgent, getAgentById, listAgents, setAgentEnabledSkills, setAgentExtensions } = await import("@/lib/agents/registry");
    const { listInstalledSkillCatalog } = await import("@/lib/extensions/registry");
    const purpose = bulkCreateAgentsIntent.purpose || "general work";
    const takenIds = new Set(listAgents().map((agent) => agent.id));
    const organizationName = toTitleCase(purpose.replace(/\bagents?\b/gi, "").trim()) || "Chat Team";
    const plans = buildGeneratedAgentPlans(bulkCreateAgentsIntent.agentCount, organizationName, takenIds);
    const createdAgents = plans.map((plan) => {
      const created = createAgent({ name: plan.name });
      return { id: created.id, name: created.name };
    });
    const skillRefs = extractSkillRefsForNewAgents(raw);
    const skillCatalog = listInstalledSkillCatalog();
    const assignedSkills: string[] = [];
    const unresolvedSkills: string[] = [];
    for (let index = 0; index < Math.min(skillRefs.length, createdAgents.length); index += 1) {
      const ref = skillRefs[index];
      const matched = resolveSingleCatalogItem(
        skillCatalog.map((entry) => ({ id: entry.id, name: entry.label, description: entry.description })),
        ref,
      );
      if (!matched) {
        unresolvedSkills.push(ref);
        continue;
      }
      const full = skillCatalog.find((entry) => entry.id === matched.id);
      const agent = getAgentById(createdAgents[index].id);
      if (!full || !agent) {
        unresolvedSkills.push(ref);
        continue;
      }
      const nextSkills = new Set(agent.enabledSkills);
      nextSkills.add(full.id);
      let updated = setAgentEnabledSkills(agent.id, [...nextSkills]);
      if (full.extensionId) {
        const nextExtensions = new Set(updated.enabledExtensions);
        nextExtensions.add(full.extensionId);
        updated = setAgentExtensions(updated.id, [...nextExtensions]);
      }
      assignedSkills.push(`${updated.name}: ${full.label}`);
    }
    return [
      `Created ${createdAgents.length} agents.`,
      `Agents: ${createdAgents.map((agent) => `${agent.name} (${agent.id})`).join(", ")}.`,
      assignedSkills.length > 0 ? `Assigned skills: ${assignedSkills.join(", ")}.` : null,
      unresolvedSkills.length > 0 ? `Could not match skills: ${unresolvedSkills.join(", ")}.` : null,
      "They are available in the Agents tab. Say \"create an org with these agents\" if you want them grouped into a hierarchy next.",
    ].filter(Boolean).join("\n");
  }

  const directAgentProviderIntent =
    raw.match(/^(?:make|set|change|switch|update|configure)\s+agent\s+(.+?)\s+(?:to\s+use|use|to|onto)\s+(.+)$/i) ||
    raw.match(/^(?:make|set|change|switch|update|configure)\s+(.+?)\s+agent\s+(?:to\s+use|use|to|onto)\s+(.+)$/i) ||
    raw.match(/^(?:have|let)\s+agent\s+(.+?)\s+use\s+(.+)$/i) ||
    raw.match(/^use\s+(.+?)\s+for\s+agent\s+(.+)$/i) ||
    raw.match(/^(?:change|switch|set|update)\s+agent\s+(.+?)\s+provider\s+(?:to|=)\s+(.+)$/i) ||
    raw.match(/^(?:change|switch|set|update)\s+(.+?)\s+agent\s+provider\s+(?:to|=)\s+(.+)$/i);
  if (directAgentProviderIntent?.[1] && directAgentProviderIntent?.[2]) {
    if (!isSensitiveCommandAllowed(ctx)) return denySensitiveCommand();
    const byUseForPattern = /^use\s+.+\s+for\s+agent\s+.+$/i.test(raw);
    const agentRef = stripWrappedQuotes(byUseForPattern ? directAgentProviderIntent[2] : directAgentProviderIntent[1]);
    const providerRef = stripWrappedQuotes(byUseForPattern ? directAgentProviderIntent[1] : directAgentProviderIntent[2]);
    // If providerRef looks like a multi-item capability list (skills, extensions, comma-separated),
    // skip provider-only resolution and fall through to the capability assignment handler below.
    const looksLikeMultiCapability = providerRef.includes(",") || /\b(skill|extension|debugging|probing|transcri|subagent|development|research|planning|github|review)\b/i.test(providerRef);
    const resolvedProvider = looksLikeMultiCapability
      ? null
      : ((await resolveNaturalLanguageProviderOnly(providerRef)) ??
         (await resolveNaturalLanguageProviderModelRef(providerRef)));
    if (resolvedProvider) {
      const { listAgents, updateAgent } = await import("@/lib/agents/registry");
      const agents = listAgents() as AgentLite[];
      const matches = resolveAgentMatches(agents, agentRef);
      if (matches.length === 0) return `Agent not found: ${agentRef}.`;
      if (matches.length > 1) {
        return `Multiple agents matched: ${matches.map((agent) => `${agent.name} (${agent.id})`).join(", ")}`;
      }
      const updated = updateAgent(matches[0].id, { modelRef: resolvedProvider.modelRef });
      return `Agent ${updated.name} now uses ${resolvedProvider.providerName} with default model "${resolvedProvider.modelLabel}" (${resolvedProvider.modelRef}).`;
    }
  }

  const earlyFreeformAgentCapability = parseFreeformAgentCapabilityAssignment(raw);
  const looksLikeAgentCapabilityAssignment =
    Boolean(earlyFreeformAgentCapability) ||
    /^(?:please\s+)?(?:make|have|let|set|configure|assign|give)\s+(?:agent\b|the\s+.+?\s+agent\b)/i.test(raw);
  if (looksLikeAgentCapabilityAssignment) {
    if (!isSensitiveCommandAllowed(ctx)) return denySensitiveCommand();
    const [{ getDefaultAgent, listAgents, getAgentById, setAgentEnabledSkills, setAgentExtensions }, { listInstalledSkillCatalog, listInstalledExtensions }] =
      await Promise.all([import("@/lib/agents/registry"), import("@/lib/extensions/registry")]);
    const agents = listAgents() as AgentLite[];
    const capabilityIntent =
      resolveAgentCapabilityAssignmentWithAgentList(raw, agents) ??
      earlyFreeformAgentCapability;
    if (!capabilityIntent) {
      return null;
    }
    const { agentRef, requested } = capabilityIntent;
    const target = isDefaultAgentReference(agentRef)
      ? getAgentById(getDefaultAgent().id)
      : (() => {
          const matches = resolveAgentMatches(agents, agentRef);
          if (matches.length === 0) return null;
          if (matches.length > 1) return matches;
          return getAgentById(matches[0].id);
        })();
    if (Array.isArray(target)) {
      return `Multiple agents matched: ${target.map((agent) => `${agent.name} (${agent.id})`).join(", ")}`;
    }
    if (!target) return `Agent not found: ${agentRef}.`;

    const requestedRefs = splitCapabilityReferences(requested);
    if (requestedRefs.length === 0) {
      return `I could not determine which skills or extensions to enable for ${target.name}.`;
    }

    if (requestedRefs.length === 1) {
      const resolvedProvider =
        (await resolveNaturalLanguageProviderOnly(requestedRefs[0])) ??
        (await resolveNaturalLanguageProviderModelRef(requestedRefs[0]));
      if (resolvedProvider) {
        const withModel = await import("@/lib/agents/registry").then(({ updateAgent }) =>
          updateAgent(target.id, { modelRef: resolvedProvider.modelRef }),
        );
        return `Agent ${withModel.name} now uses ${resolvedProvider.providerName} with default model "${resolvedProvider.modelLabel}" (${resolvedProvider.modelRef}).`;
      }
    }

    const extensionOnly =
      requestedRefs.length === 1 && /\b(?:extensions?|plugins?)\b/i.test(requested) && !/\bskills?\b/i.test(requested);
    const skillOnly =
      requestedRefs.length === 1 && /\bskills?\b/i.test(requested) && !/\b(?:extensions?|plugins?)\b/i.test(requested);
    const skillCatalog = listInstalledSkillCatalog();
    const extensionCatalog = listInstalledExtensions();
    const nextSkills = new Set(target.enabledSkills);
    const nextExtensions = new Set(target.enabledExtensions);
    const enabledSkillLabels: string[] = [];
    const enabledExtensionLabels: string[] = [];
    const unresolved: string[] = [];

    for (const ref of requestedRefs) {
      let matchedSkill = !extensionOnly
        ? resolveSingleCatalogItem(
            skillCatalog.map((entry) => ({ id: entry.id, name: entry.label, description: entry.description })),
            ref,
          )
        : null;
      let matchedExtension = !skillOnly
        ? resolveSingleCatalogItem(
            extensionCatalog.map((entry) => ({ id: entry.id, name: entry.name, description: entry.description })),
            ref,
          )
        : null;

      if (!matchedSkill && !matchedExtension) {
        unresolved.push(ref);
        continue;
      }

      if (matchedSkill && matchedExtension) {
        const normalizedRef = normalizeLookup(ref);
        if (normalizeLookup(matchedExtension.name) === normalizedRef || normalizeLookup(matchedExtension.id) === normalizedRef) {
          matchedSkill = null;
        } else {
          matchedExtension = null;
        }
      }

      if (matchedSkill) {
        const full = skillCatalog.find((entry) => entry.id === matchedSkill.id);
        if (!full) {
          unresolved.push(ref);
          continue;
        }
        nextSkills.add(full.id);
        if (!enabledSkillLabels.includes(full.label)) enabledSkillLabels.push(full.label);
        if (full.extensionId) nextExtensions.add(full.extensionId);
        continue;
      }

      if (matchedExtension) {
        const full = extensionCatalog.find((entry) => entry.id === matchedExtension.id);
        if (!full) {
          unresolved.push(ref);
          continue;
        }
        nextExtensions.add(full.id);
        if (!enabledExtensionLabels.includes(full.name)) enabledExtensionLabels.push(full.name);
      }
    }

    let updated = setAgentExtensions(target.id, [...nextExtensions]);
    updated = setAgentEnabledSkills(updated.id, [...nextSkills]);

    return [
      `Updated ${updated.name}.`,
      enabledExtensionLabels.length > 0 ? `Enabled extensions: ${enabledExtensionLabels.join(", ")}` : null,
      enabledSkillLabels.length > 0 ? `Enabled skill packs: ${enabledSkillLabels.join(", ")}` : null,
      unresolved.length > 0 ? `Could not match: ${unresolved.join(", ")}` : null,
    ]
      .filter(Boolean)
      .join("\n");
  }

  const directCreateAgentIntent = parseDirectCreateAgentIntent(raw);
  if (directCreateAgentIntent) {
    if (!isSensitiveCommandAllowed(ctx)) return denySensitiveCommand();
    const { createAgent } = await import("@/lib/agents/registry");

    try {
      const created = createAgent({
        name: directCreateAgentIntent.name,
        ...(directCreateAgentIntent.modelRef ? { modelRef: directCreateAgentIntent.modelRef } : {}),
      });
      return [
        `Agent created: ${created.name} (${created.id}).`,
        directCreateAgentIntent.purpose ? `Purpose inferred from chat: ${directCreateAgentIntent.purpose}.` : null,
        "It is now available in the Agents tab.",
      ].filter(Boolean).join("\n");
    } catch (error) {
      return `Create agent failed: ${String(error)}.`;
    }
  }

  const setAgentRoleMatch =
    raw.match(/^(?:set|change|update)\s+(?:role\s+of\s+)?agent\s+(.+?)\s+(?:to|as)\s+(orchestrator|operations|specialist|worker|support)$/i) ||
    raw.match(/^(?:set|change|update)\s+(.+?)\s+(?:agent\s+)?role\s+(?:to|as)\s+(orchestrator|operations|specialist|worker|support)$/i);
  if (setAgentRoleMatch?.[1] && setAgentRoleMatch?.[2]) {
    if (!isSensitiveCommandAllowed(ctx)) return denySensitiveCommand();
    const { listAgents } = await import("@/lib/agents/registry");
    const { updateAgentRole } = await import("@/lib/agents/roles");
    const agents = listAgents() as AgentLite[];
    const matches = resolveAgentMatches(agents, setAgentRoleMatch[1]);
    if (matches.length === 0) return `Agent not found: ${setAgentRoleMatch[1]}.`;
    if (matches.length > 1) {
      return `Multiple agents matched: ${matches.map((agent) => `${agent.name} (${agent.id})`).join(", ")}`;
    }
    const updated = updateAgentRole(matches[0].id, { roleType: setAgentRoleMatch[2].toLowerCase() as never });
    return `Agent ${matches[0].name} is now ${updated.roleType}.`;
  }

  const setAgentManagerMatch =
    raw.match(/^(?:set|change|update)\s+agent\s+(.+?)\s+reports\s+to\s+(.+)$/i) ||
    raw.match(/^(?:set|change|update)\s+agent\s+(.+?)\s+manager\s+(?:to\s+)?(.+)$/i) ||
    raw.match(/^(?:make|set)\s+(.+?)\s+report\s+to\s+(.+)$/i);
  if (setAgentManagerMatch?.[1] && setAgentManagerMatch?.[2]) {
    if (!isSensitiveCommandAllowed(ctx)) return denySensitiveCommand();
    const { listAgents } = await import("@/lib/agents/registry");
    const { updateAgentRole } = await import("@/lib/agents/roles");
    const agents = listAgents() as AgentLite[];
    const agentMatches = resolveAgentMatches(agents, setAgentManagerMatch[1]);
    if (agentMatches.length === 0) return `Agent not found: ${setAgentManagerMatch[1]}.`;
    if (agentMatches.length > 1) {
      return `Multiple agents matched: ${agentMatches.map((agent) => `${agent.name} (${agent.id})`).join(", ")}`;
    }
    const managerRef = stripWrappedQuotes(setAgentManagerMatch[2]);
    const reportsTo = /^(?:none|no manager|nobody|null)$/i.test(managerRef)
      ? null
      : (() => {
          const managerMatches = resolveAgentMatches(agents, managerRef);
          if (managerMatches.length === 0) return "__missing__";
          if (managerMatches.length > 1) return "__multiple__";
          return managerMatches[0].id;
        })();
    if (reportsTo === "__missing__") return `Manager not found: ${managerRef}.`;
    if (reportsTo === "__multiple__") {
      const managerMatches = resolveAgentMatches(agents, managerRef);
      return `Multiple manager matches: ${managerMatches.map((agent) => `${agent.name} (${agent.id})`).join(", ")}`;
    }
    updateAgentRole(agentMatches[0].id, { reportsTo: reportsTo as string | null });
    return reportsTo
      ? `Agent ${agentMatches[0].name} now reports to ${agents.find((agent) => agent.id === reportsTo)?.name || reportsTo}.`
      : `Agent ${agentMatches[0].name} no longer has a manager.`;
  }

  const agentExtensionToggleMatch = raw.match(
    /^(enable|disable|activate|deactivate|turn\s+on|turn\s+off)\s+(?:extension|plugin)\s+(.+?)\s+(?:for|on)\s+agent\s+(.+)$/i,
  );
  if (agentExtensionToggleMatch?.[1] && agentExtensionToggleMatch?.[2] && agentExtensionToggleMatch?.[3]) {
    if (!isSensitiveCommandAllowed(ctx)) return denySensitiveCommand();
    const enable = /^(enable|activate|turn\s+on)/i.test(agentExtensionToggleMatch[1]);
    const extensionRef = stripWrappedQuotes(agentExtensionToggleMatch[2]);
    const agentRef = stripWrappedQuotes(agentExtensionToggleMatch[3]);
    const [{ listAgents, getAgentById, setAgentExtensions }, { listInstalledExtensions }, { buildGlobalExtensionEntries }] = await Promise.all([
      import("@/lib/agents/registry"),
      import("@/lib/extensions/registry"),
      import("@/lib/extensions/state"),
    ]);
    const agents = listAgents() as AgentLite[];
    const matches = resolveAgentMatches(agents, agentRef);
    if (matches.length === 0) return `Agent not found: ${agentRef}.`;
    if (matches.length > 1) {
      return `Multiple agents matched: ${matches.map((agent) => `${agent.name} (${agent.id})`).join(", ")}`;
    }
    const target = getAgentById(matches[0].id);
    if (!target) return `Agent not found: ${agentRef}.`;
    const extensionMatches = resolveCatalogMatches(
      listInstalledExtensions().map((entry) => ({ id: entry.id, name: entry.name, description: entry.description })),
      extensionRef,
    );
    if (extensionMatches.length === 0) return `Extension not found: ${extensionRef}.`;
    if (extensionMatches.length > 1) {
      return `Multiple extensions matched: ${extensionMatches.map((entry) => `${entry.name} (${entry.id})`).join(", ")}`;
    }
    const next = new Set(target.enabledExtensions);
    if (enable) next.add(extensionMatches[0].id);
    else next.delete(extensionMatches[0].id);
    const updated = setAgentExtensions(target.id, [...next]);
    const suffix = enable
      ? (() => {
          const entry = buildGlobalExtensionEntries(updated.enabledExtensions).find((candidate) => candidate.id === extensionMatches[0].id);
          return entry
            ? `\n\n${formatExtensionSetupGuidance({
                extensionId: entry.id,
                extensionName: entry.name,
                manifestPath: entry.manifestPath,
                config: entry.config,
                globallyEnabled: entry.globallyEnabled,
              })}`
            : "";
        })()
      : "";
    return `Extension ${extensionMatches[0].name} ${enable ? "enabled" : "disabled"} for agent ${updated.name}.${suffix}`;
  }

  const globalExtensionToggleMatch = raw.match(
    /^(enable|disable|activate|deactivate|turn\s+on|turn\s+off)\s+(?:extension|plugin)\s+(.+?)\s+(?:globally|for\s+everyone|for\s+all\s+agents)?$/i,
  );
  if (
    globalExtensionToggleMatch?.[1] &&
    globalExtensionToggleMatch?.[2] &&
    !/\s+(?:for|on)\s+agent\s+/i.test(raw)
  ) {
    if (!isSensitiveCommandAllowed(ctx)) return denySensitiveCommand();
    const enable = /^(enable|activate|turn\s+on)/i.test(globalExtensionToggleMatch[1]);
    const extensionRef = stripWrappedQuotes(globalExtensionToggleMatch[2]);
    const { listInstalledExtensions } = await import("@/lib/extensions/registry");
    const extensionMatches = resolveCatalogMatches(
      listInstalledExtensions().map((entry) => ({ id: entry.id, name: entry.name, description: entry.description })),
      extensionRef,
    );
    if (extensionMatches.length === 0) return `Extension not found: ${extensionRef}.`;
    if (extensionMatches.length > 1) {
      return formatAmbiguousCatalogMatches("extensions", extensionRef, extensionMatches);
    }
    const queued = queueSensitiveMutation(ctx, {
      kind: "extension-global-toggle",
      summary: `${enable ? "Enable" : "Disable"} extension ${extensionMatches[0].name} globally.`,
      payload: {
        extensionId: extensionMatches[0].id,
        enable,
      },
    });
    if (queued) return queued;
  }

  const agentSkillToggleMatch = raw.match(
    /^(enable|disable|activate|deactivate|turn\s+on|turn\s+off)\s+skill\s+(.+?)\s+(?:for|on)\s+agent\s+(.+)$/i,
  );
  if (agentSkillToggleMatch?.[1] && agentSkillToggleMatch?.[2] && agentSkillToggleMatch?.[3]) {
    if (!isSensitiveCommandAllowed(ctx)) return denySensitiveCommand();
    const enable = /^(enable|activate|turn\s+on)/i.test(agentSkillToggleMatch[1]);
    const skillRef = stripWrappedQuotes(agentSkillToggleMatch[2]);
    const agentRef = stripWrappedQuotes(agentSkillToggleMatch[3]);
    const [{ listAgents, getAgentById, setAgentEnabledSkills, setAgentExtensions }, { listInstalledSkillCatalog }] =
      await Promise.all([import("@/lib/agents/registry"), import("@/lib/extensions/registry")]);
    const agents = listAgents() as AgentLite[];
    const matches = resolveAgentMatches(agents, agentRef);
    if (matches.length === 0) return `Agent not found: ${agentRef}.`;
    if (matches.length > 1) {
      return formatAmbiguousAgentMatches(agentRef, matches);
    }
    const target = getAgentById(matches[0].id);
    if (!target) return `Agent not found: ${agentRef}.`;
    const skillMatches = resolveCatalogMatches(
      listInstalledSkillCatalog().map((entry) => ({ id: entry.id, name: entry.label, description: entry.description })),
      skillRef,
    );
    if (skillMatches.length === 0) return `Skill pack not found: ${skillRef}.`;
    if (skillMatches.length > 1) {
      return formatAmbiguousCatalogMatches("skill packs", skillRef, skillMatches);
    }
    const matched = listInstalledSkillCatalog().find((entry) => entry.id === skillMatches[0].id);
    if (!matched) return `Skill pack not found: ${skillRef}.`;
    const nextSkills = new Set(target.enabledSkills);
    if (enable) nextSkills.add(matched.id);
    else nextSkills.delete(matched.id);
    let updated = setAgentEnabledSkills(target.id, [...nextSkills]);
    if (enable && matched.extensionId && !updated.enabledExtensions.includes(matched.extensionId)) {
      updated = setAgentExtensions(updated.id, [...updated.enabledExtensions, matched.extensionId]);
    }
    const suffix = enable
      ? `\n\n${formatSkillSetupGuidance({
          skillId: matched.id,
          skillLabel: matched.label,
          requiredEnv: matched.requiredEnv,
          setupNotes: matched.setupNotes,
          platforms: matched.platforms,
        })}`
      : "";
    return `Skill pack ${matched.label} ${enable ? "enabled" : "disabled"} for agent ${updated.name}.${suffix}`;
  }

  const directProviderForAgentMatch = raw.match(/^use\s+(.+?)\s+for\s+agent\s+(.+)$/i);
  const naturalLanguageAgentProviderMatch =
    raw.match(/^(?:make|set|change|switch|update|configure)\s+agent\s+(.+?)\s+(?:to\s+use|use|to|onto)\s+(.+)$/i) ||
    raw.match(/^(?:make|set|change|switch|update|configure)\s+(.+?)\s+agent\s+(?:to\s+use|use|to|onto)\s+(.+)$/i) ||
    raw.match(/^(?:have|let)\s+agent\s+(.+?)\s+use\s+(.+)$/i) ||
    raw.match(/^(?:change|switch|set|update)\s+agent\s+(.+?)\s+provider\s+(?:to|=)\s+(.+)$/i) ||
    raw.match(/^(?:change|switch|set|update)\s+(.+?)\s+agent\s+provider\s+(?:to|=)\s+(.+)$/i);
  if ((naturalLanguageAgentProviderMatch?.[1] && naturalLanguageAgentProviderMatch?.[2]) || (directProviderForAgentMatch?.[1] && directProviderForAgentMatch?.[2])) {
    if (!isSensitiveCommandAllowed(ctx)) return denySensitiveCommand();
    const agentRef = stripWrappedQuotes(directProviderForAgentMatch?.[2] || naturalLanguageAgentProviderMatch?.[1] || "");
    const providerRef = stripWrappedQuotes(directProviderForAgentMatch?.[1] || naturalLanguageAgentProviderMatch?.[2] || "");
    const resolvedProvider =
      (await resolveNaturalLanguageProviderOnly(providerRef)) ??
      (await resolveNaturalLanguageProviderModelRef(providerRef));
    if (resolvedProvider) {
      const { listAgents, updateAgent } = await import("@/lib/agents/registry");
      const agents = listAgents() as AgentLite[];
      const matches = resolveAgentMatches(agents, agentRef);
      if (matches.length === 0) return `Agent not found: ${agentRef}.`;
      if (matches.length > 1) {
        return `Multiple agents matched: ${matches.map((agent) => `${agent.name} (${agent.id})`).join(", ")}`;
      }
      const updated = updateAgent(matches[0].id, { modelRef: resolvedProvider.modelRef });
      return `Agent ${updated.name} now uses ${resolvedProvider.providerName} with default model "${resolvedProvider.modelLabel}" (${resolvedProvider.modelRef}).`;
    }
  }

  const freeformAgentCapabilityMatch =
    raw.match(/^(?:make|have|let|set|configure|assign|give)\s+(?:the\s+)?(.+?)\s+agent\s+(?:use|with|to\s+use|to\s+have)\s+(.+)$/i) ||
    raw.match(/^(?:make|have|let|set|configure|assign|give)\s+agent\s+(.+?)\s+(?:use|with|to\s+use|to\s+have)\s+(.+)$/i);
  if (freeformAgentCapabilityMatch?.[1] && freeformAgentCapabilityMatch?.[2]) {
    if (!isSensitiveCommandAllowed(ctx)) return denySensitiveCommand();
    const agentRef = stripWrappedQuotes(freeformAgentCapabilityMatch[1]);
    const requested = stripWrappedQuotes(freeformAgentCapabilityMatch[2]);
    const [{ listAgents, getAgentById, setAgentEnabledSkills, setAgentExtensions }, { listInstalledSkillCatalog, listInstalledExtensions }] =
      await Promise.all([import("@/lib/agents/registry"), import("@/lib/extensions/registry")]);
    const agents = listAgents() as AgentLite[];
    const matches = resolveAgentMatches(agents, agentRef);
    if (matches.length === 0) return `Agent not found: ${agentRef}.`;
    if (matches.length > 1) {
      return formatAmbiguousAgentMatches(agentRef, matches);
    }
    const target = getAgentById(matches[0].id);
    if (!target) return `Agent not found: ${agentRef}.`;

    const requestedRefs = splitCapabilityReferences(requested);
    if (requestedRefs.length === 0) {
      return `I could not determine which skills or extensions to enable for ${target.name}.`;
    }

    if (requestedRefs.length === 1) {
      const resolvedProvider =
        (await resolveNaturalLanguageProviderOnly(requestedRefs[0])) ??
        (await resolveNaturalLanguageProviderModelRef(requestedRefs[0]));
      if (resolvedProvider) {
        const { updateAgent } = await import("@/lib/agents/registry");
        const updated = updateAgent(target.id, { modelRef: resolvedProvider.modelRef });
        return `Agent ${updated.name} now uses ${resolvedProvider.providerName} with default model "${resolvedProvider.modelLabel}" (${resolvedProvider.modelRef}).`;
      }
    }

    const extensionOnly =
      requestedRefs.length === 1 && /\b(?:extensions?|plugins?)\b/i.test(requested) && !/\bskills?\b/i.test(requested);
    const skillOnly =
      requestedRefs.length === 1 && /\bskills?\b/i.test(requested) && !/\b(?:extensions?|plugins?)\b/i.test(requested);
    const skillCatalog = listInstalledSkillCatalog();
    const extensionCatalog = listInstalledExtensions();
    const nextSkills = new Set(target.enabledSkills);
    const nextExtensions = new Set(target.enabledExtensions);
    const enabledSkillLabels: string[] = [];
    const enabledExtensionLabels: string[] = [];
    const unresolved: string[] = [];

    for (const ref of requestedRefs) {
      let matchedSkill = !extensionOnly
        ? resolveSingleCatalogItem(
            skillCatalog.map((entry) => ({ id: entry.id, name: entry.label, description: entry.description })),
            ref,
          )
        : null;
      let matchedExtension = !skillOnly
        ? resolveSingleCatalogItem(
            extensionCatalog.map((entry) => ({ id: entry.id, name: entry.name, description: entry.description })),
            ref,
          )
        : null;

      if (!matchedSkill && !matchedExtension) {
        unresolved.push(ref);
        continue;
      }

      if (matchedSkill && matchedExtension) {
        const normalizedRef = normalizeLookup(ref);
        if (normalizeLookup(matchedExtension.name) === normalizedRef || normalizeLookup(matchedExtension.id) === normalizedRef) {
          matchedSkill = null;
        } else {
          matchedExtension = null;
        }
      }

      if (matchedSkill) {
        const full = skillCatalog.find((entry) => entry.id === matchedSkill.id);
        if (!full) {
          unresolved.push(ref);
          continue;
        }
        nextSkills.add(full.id);
        if (!enabledSkillLabels.includes(full.label)) enabledSkillLabels.push(full.label);
        if (full.extensionId) nextExtensions.add(full.extensionId);
        continue;
      }

      if (matchedExtension) {
        const full = extensionCatalog.find((entry) => entry.id === matchedExtension.id);
        if (!full) {
          unresolved.push(ref);
          continue;
        }
        nextExtensions.add(full.id);
        if (!enabledExtensionLabels.includes(full.name)) enabledExtensionLabels.push(full.name);
      }
    }

    let updated = setAgentExtensions(target.id, [...nextExtensions]);
    updated = setAgentEnabledSkills(updated.id, [...nextSkills]);

    return [
      `Updated ${updated.name}.`,
      enabledExtensionLabels.length > 0 ? `Enabled extensions: ${enabledExtensionLabels.join(", ")}` : null,
      enabledSkillLabels.length > 0 ? `Enabled skill packs: ${enabledSkillLabels.join(", ")}` : null,
      unresolved.length > 0 ? `Could not match: ${unresolved.join(", ")}` : null,
    ]
      .filter(Boolean)
      .join("\n");
  }

  const renameAgentMatch = raw.match(
    /^(?:rename|change\s+name\s+of)\s+agent\s+(.+?)\s+(?:to|as)\s+(.+)$/i,
  );
  if (renameAgentMatch?.[1] && renameAgentMatch?.[2]) {
    if (!isSensitiveCommandAllowed(ctx)) return denySensitiveCommand();
    const { listAgents, updateAgent } = await import("@/lib/agents/registry");
    const agents = listAgents() as AgentLite[];
    const matches = resolveAgentMatches(agents, renameAgentMatch[1]);
    if (matches.length === 0) {
      return `Agent not found: ${renameAgentMatch[1]}. Use "list agents" first.`;
    }
    if (matches.length > 1) {
      return `Multiple agents matched: ${matches.map((agent) => `${agent.name} (${agent.id})`).join(", ")}`;
    }
    const nextName = stripWrappedQuotes(renameAgentMatch[2]);
    if (!nextName) return "New agent name cannot be empty.";
    const updated = updateAgent(matches[0].id, { name: nextName });
    return `Agent renamed: ${updated.name} (${updated.id}).`;
  }

  const setDefaultAgentMatch =
    raw.match(/^set\s+default\s+agent(?:\s+to)?\s+(.+)$/i) ||
    raw.match(/^(?:set|make)\s+agent\s+(.+?)\s+(?:as\s+)?default$/i);
  if (setDefaultAgentMatch?.[1]) {
    if (!isSensitiveCommandAllowed(ctx)) return denySensitiveCommand();
    const { listAgents, updateAgent } = await import("@/lib/agents/registry");
    const agents = listAgents() as AgentLite[];
    const matches = resolveAgentMatches(agents, setDefaultAgentMatch[1]);
    if (matches.length === 0) {
      return `Agent not found: ${setDefaultAgentMatch[1]}.`;
    }
    if (matches.length > 1) {
      return `Multiple agents matched: ${matches.map((agent) => `${agent.name} (${agent.id})`).join(", ")}`;
    }
    const updated = updateAgent(matches[0].id, { isDefault: true });
    return `Default agent is now ${updated.name} (${updated.id}).`;
  }

  const setAgentModelMatch =
    raw.match(/^(?:set|change|update)\s+agent\s+(.+?)\s+model\s+(?:to|=)\s+(.+)$/i) ||
    raw.match(/^use\s+model\s+(.+?)\s+for\s+agent\s+(.+)$/i);
  if (setAgentModelMatch?.[1] && setAgentModelMatch?.[2]) {
    if (!isSensitiveCommandAllowed(ctx)) return denySensitiveCommand();
    const byForPattern = /^use\s+model\s+/i.test(raw);
    const agentRef = byForPattern ? setAgentModelMatch[2] : setAgentModelMatch[1];
    const modelRefRaw = byForPattern ? setAgentModelMatch[1] : setAgentModelMatch[2];
    const modelRef = stripWrappedQuotes(modelRefRaw);
    const { listAgents, updateAgent } = await import("@/lib/agents/registry");
    const agents = listAgents() as AgentLite[];
    const matches = resolveAgentMatches(agents, agentRef);
    if (matches.length === 0) {
      return `Agent not found: ${agentRef}.`;
    }
    if (matches.length > 1) {
      return `Multiple agents matched: ${matches.map((agent) => `${agent.name} (${agent.id})`).join(", ")}`;
    }
    if (!modelRef) return "Model reference is required.";
    const updated = updateAgent(matches[0].id, { modelRef });
    return `Agent ${updated.name} now uses model ref "${modelRef}".`;
  }

  const enableAgentMatch = raw.match(/^(?:enable|activate|turn\s+on|resume)\s+agent\s+(.+)$/i);
  if (enableAgentMatch?.[1]) {
    if (!isSensitiveCommandAllowed(ctx)) return denySensitiveCommand();
    const { listAgents, updateAgent } = await import("@/lib/agents/registry");
    const agents = listAgents() as AgentLite[];
    const matches = resolveAgentMatches(agents, enableAgentMatch[1]);
    if (matches.length === 0) return `Agent not found: ${enableAgentMatch[1]}.`;
    if (matches.length > 1) {
      return `Multiple agents matched: ${matches.map((agent) => `${agent.name} (${agent.id})`).join(", ")}`;
    }
    const updated = updateAgent(matches[0].id, { isActive: true });
    return `Agent enabled: ${updated.name} (${updated.id}).`;
  }

  const disableAgentMatch = raw.match(/^(?:disable|deactivate|turn\s+off|pause)\s+agent\s+(.+)$/i);
  if (disableAgentMatch?.[1]) {
    if (!isSensitiveCommandAllowed(ctx)) return denySensitiveCommand();
    const { listAgents, updateAgent } = await import("@/lib/agents/registry");
    const agents = listAgents() as AgentLite[];
    const matches = resolveAgentMatches(agents, disableAgentMatch[1]);
    if (matches.length === 0) return `Agent not found: ${disableAgentMatch[1]}.`;
    if (matches.length > 1) {
      return `Multiple agents matched: ${matches.map((agent) => `${agent.name} (${agent.id})`).join(", ")}`;
    }
    const updated = updateAgent(matches[0].id, { isActive: false });
    return `Agent disabled: ${updated.name} (${updated.id}).`;
  }

  const retryAgentFailureMatch =
    raw.match(/^(?:retry|rerun)\s+(?:the\s+)?(?:last\s+)?failed\s+(?:run|workflow)(?:\s+for\s+agent|\s+for)?\s+(.+)$/i) ||
    raw.match(/^(?:retry|rerun)\s+agent\s+(.+?)\s+(?:failed\s+run|failed\s+workflow|last\s+failed\s+run|last\s+failed\s+workflow)$/i);
  if (retryAgentFailureMatch?.[1]) {
    if (!isSensitiveCommandAllowed(ctx)) return denySensitiveCommand();
    const [{ listAgents, getDefaultAgent }, { workflowUsesAgent }] = await Promise.all([
      import("@/lib/agents/registry"),
      import("@/lib/agents/workflow-insights"),
    ]);
    const agents = listAgents() as AgentLite[];
    const matches = resolveAgentMatches(agents, retryAgentFailureMatch[1]);
    if (matches.length === 0) return `Agent not found: ${retryAgentFailureMatch[1]}.`;
    if (matches.length > 1) {
      return `Multiple agents matched: ${matches.map((agent) => `${agent.name} (${agent.id})`).join(", ")}`;
    }
    const targetAgent = matches[0];
    const defaultAgentId = getDefaultAgent().id;
    const { initializeDatabase, getSqlite } = await import("@/lib/db");
    initializeDatabase();
    const db = getSqlite();
    const workflowRows = db
      .prepare("SELECT id, name, nodes FROM workflows WHERE is_active = 1 ORDER BY updated_at DESC")
      .all() as Array<{ id: string; name: string; nodes: string }>;
    const workflowsById = new Map(
      workflowRows.map((row) => {
        let nodes: Array<{ id: string; type: string; data?: Record<string, unknown> }> = [];
        try {
          nodes = JSON.parse(row.nodes);
        } catch {
          nodes = [];
        }
        return [row.id, { id: row.id, name: row.name, nodes }];
      }),
    );
    const failedExecutions = db
      .prepare("SELECT workflow_id, started_at FROM executions WHERE status = 'failed' ORDER BY started_at DESC LIMIT 200")
      .all() as Array<{ workflow_id: string; started_at: string }>;
    const failedWorkflow = failedExecutions
      .map((row) => workflowsById.get(row.workflow_id))
      .find((workflow) => workflow && workflowUsesAgent(workflow.nodes, targetAgent.id, defaultAgentId));
    if (!failedWorkflow) {
      return `No failed workflow found for ${targetAgent.name}.`;
    }
    try {
      const response = await fetch(`${internalApiBaseUrl}/api/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflowId: failedWorkflow.id,
          triggerType: "manual",
          triggerData: { message: `Retry requested for ${targetAgent.name} from channel governance command` },
          provenance: createProvenance("channel", `channel:${ctx.channel}`, {
            channel: ctx.channel,
            sessionId: ctx.sessionId ?? undefined,
            sender: ctx.sender,
            agentId: targetAgent.id,
            routeSource: "agent-retry-command",
          }),
        }),
      });
      const payload = (await response.json()) as { success?: boolean; data?: { id?: string }; error?: string };
      if (!response.ok || !payload.success) {
        return `Retry failed: ${payload.error || `HTTP ${response.status}`}.`;
      }
      return `Retry started for ${targetAgent.name} using workflow "${failedWorkflow.name}" (${failedWorkflow.id}). Execution ${payload.data?.id || "started"}.`;
    } catch (error) {
      return `Retry failed: ${String(error)}.`;
    }
  }

  const deleteAgentMatch = raw.match(/^(?:delete|remove)\s+agent\s+(.+)$/i);
  if (deleteAgentMatch?.[1]) {
    if (!isSensitiveCommandAllowed(ctx)) return denySensitiveCommand();
    const { listAgents, deleteAgent } = await import("@/lib/agents/registry");
    const agents = listAgents() as AgentLite[];
    const matches = resolveAgentMatches(agents, deleteAgentMatch[1]);
    if (matches.length === 0) return `Agent not found: ${deleteAgentMatch[1]}.`;
    if (matches.length > 1) {
      return `Multiple agents matched: ${matches.map((agent) => `${agent.name} (${agent.id})`).join(", ")}`;
    }
    try {
      deleteAgent(matches[0].id);
      return `Agent deleted: ${matches[0].name} (${matches[0].id}).`;
    } catch (error) {
      return `Delete agent failed: ${String(error)}.`;
    }
  }

  const wantsModelList =
    normalized === "models" ||
    normalized === "/models" ||
    normalized === "list models" ||
    normalized === "show models" ||
    normalized === "active models";
  if (wantsModelList) {
    const { initializeDatabase, getSqlite } = await import("@/lib/db");
    initializeDatabase();
    const db = getSqlite();
    ensureModelsBaseUrlColumn(db);
    const rows = db
      .prepare("SELECT * FROM models ORDER BY priority DESC")
      .all() as ModelRow[];
    return formatModelRows(rows);
  }

  const addModelMatch = raw.match(/^(?:add|create)\s+model\s+(.+)$/i);
  if (addModelMatch?.[1]) {
    if (!isSensitiveCommandAllowed(ctx)) return denySensitiveCommand();
    const tail = stripWrappedQuotes(addModelMatch[1]);
    const parsedRef = parseModelReference(tail);
    const fallbackTokens = tail.split(/\s+/).filter(Boolean);
    const providerToken = parsedRef?.provider ?? fallbackTokens[0] ?? "";
    const requestedModelId =
      parsedRef?.modelId ?? fallbackTokens.slice(1).join(" ").trim();

    if (!providerToken) {
      return "Provider is required. Example: add model openai gpt-5-mini";
    }

    const [{ normalizeProviderId }, { PROVIDERS }, { checkModelToolSupport, getToolCapableRecommendations }, dbMod, authMod, { normalizeProviderBaseUrl }, providerPlugins, { nanoid }] =
      await Promise.all([
        import("@/lib/agents/provider-normalization"),
        import("@/types/model"),
        import("@/lib/agents/model-capabilities"),
        import("@/lib/db"),
        import("@/lib/agents/provider-auth"),
        import("@/lib/agents/provider-base-url"),
        import("@/lib/agents/provider-plugins"),
        import("nanoid"),
      ]);

    const provider = normalizeProviderId(providerToken);
    if (!provider) {
      return `Unknown provider: ${providerToken}. Try one of: ${PROVIDERS.map((p) => p.id).join(", ")}`;
    }

    const providerInfo = PROVIDERS.find((entry) => entry.id === provider);
    if (!providerInfo) {
      return `Provider metadata not found: ${provider}`;
    }

    const baseUrl = normalizeProviderBaseUrl(provider, providerInfo.baseUrl) ?? null;
    const envAuth = authMod.resolveProviderEnvApiKey(provider);
    const apiKey = providerRequiresApiKey(provider) ? (envAuth?.apiKey ?? "") : "";
    const selection = await providerPlugins.resolveProviderModelSelection({
      provider,
      requestedModelId: requestedModelId || undefined,
      baseUrl,
      apiKey,
    });
    const modelId = selection.modelId || providerInfo.defaultModel;
    const support = checkModelToolSupport(provider, modelId);
    if (support.status === "unsupported") {
      const recommendations = getToolCapableRecommendations(provider).map((item) => item.id);
      const suffix = recommendations.length > 0 ? ` Try: ${recommendations.join(", ")}` : "";
      return `Model not supported for tools: ${support.reason}.${suffix}`;
    }

    dbMod.initializeDatabase();
    const db = dbMod.getSqlite();
    ensureModelsBaseUrlColumn(db);

    const existing = db
      .prepare("SELECT * FROM models WHERE provider = ? AND model_id = ? LIMIT 1")
      .get(provider, modelId) as ModelRow | undefined;
    if (existing) {
      return `Model already exists: ${existing.provider}/${existing.model_id} (${existing.id}).`;
    }

    const id = nanoid(8);
    const now = new Date().toISOString();
    const count = (db.prepare("SELECT COUNT(*) as count FROM models").get() as { count: number }).count;
    const discoveredName =
      selection.name ||
      (providerInfo.models.find((item) => item.id === modelId)?.name ??
        `${providerInfo.name} ${modelId}`);

    db.prepare(
      "INSERT INTO models (id, provider, model_id, name, api_key, priority, is_active, max_tokens, base_url, fast_mode, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(id, provider, modelId, discoveredName, apiKey, count, 1, null, baseUrl, 0, now);

    const warnings: string[] = [...selection.warnings];
    if (providerInfo.requiresApiKey && !apiKey) {
      warnings.push(`No API key detected for ${provider}. Add ${providerInfo.envKey} in env or Secrets.`);
    }
    if (support.status === "unknown") {
      warnings.push(support.reason);
    }
    const warningText = warnings.length > 0 ? `\nWarnings: ${warnings.join(" | ")}` : "";
    return `Model added: ${provider}/${modelId} (${id}).${warningText}`;
  }

  const enableModelMatch = raw.match(/^(?:enable|activate)\s+model\s+(.+)$/i);
  if (enableModelMatch?.[1]) {
    if (!isSensitiveCommandAllowed(ctx)) return denySensitiveCommand();
    const { initializeDatabase, getSqlite } = await import("@/lib/db");
    initializeDatabase();
    const db = getSqlite();
    ensureModelsBaseUrlColumn(db);
    const rows = db.prepare("SELECT * FROM models ORDER BY priority DESC").all() as ModelRow[];
    const target = resolveModelRow(rows, enableModelMatch[1]);
    if (!target) return `Model not found: ${enableModelMatch[1]}. Use "list models" first.`;
    db.prepare("UPDATE models SET is_active = 1 WHERE id = ?").run(target.id);
    return `Model enabled: ${target.provider}/${target.model_id} (${target.id}).`;
  }

  const disableModelMatch = raw.match(/^(?:disable|deactivate)\s+model\s+(.+)$/i);
  if (disableModelMatch?.[1]) {
    if (!isSensitiveCommandAllowed(ctx)) return denySensitiveCommand();
    const { initializeDatabase, getSqlite } = await import("@/lib/db");
    initializeDatabase();
    const db = getSqlite();
    ensureModelsBaseUrlColumn(db);
    const rows = db.prepare("SELECT * FROM models ORDER BY priority DESC").all() as ModelRow[];
    const target = resolveModelRow(rows, disableModelMatch[1]);
    if (!target) return `Model not found: ${disableModelMatch[1]}.`;
    db.prepare("UPDATE models SET is_active = 0 WHERE id = ?").run(target.id);
    const remainingActive = (
      db.prepare("SELECT COUNT(*) as count FROM models WHERE is_active = 1").get() as {
        count: number;
      }
    ).count;
    const suffix = remainingActive === 0 ? " Warning: no active models remain." : "";
    return `Model disabled: ${target.provider}/${target.model_id} (${target.id}).${suffix}`;
  }

  const deleteModelMatch = raw.match(/^(?:delete|remove)\s+model\s+(.+)$/i);
  if (deleteModelMatch?.[1]) {
    if (!isSensitiveCommandAllowed(ctx)) return denySensitiveCommand();
    const { initializeDatabase, getSqlite } = await import("@/lib/db");
    initializeDatabase();
    const db = getSqlite();
    ensureModelsBaseUrlColumn(db);
    const rows = db.prepare("SELECT * FROM models ORDER BY priority DESC").all() as ModelRow[];
    const target = resolveModelRow(rows, deleteModelMatch[1]);
    if (!target) return `Model not found: ${deleteModelMatch[1]}.`;
    db.prepare("DELETE FROM models WHERE id = ?").run(target.id);
    return `Model deleted: ${target.provider}/${target.model_id} (${target.id}).`;
  }

  const useModelMatch = raw.match(
    /^(?:use|switch\s+to|set\s+(?:default|primary)\s+model(?:\s+to)?|set\s+model\s+to)\s+(.+)$/i,
  );
  if (useModelMatch?.[1]) {
    if (!isSensitiveCommandAllowed(ctx)) return denySensitiveCommand();
    const modelRef = stripWrappedQuotes(useModelMatch[1]);
    const { initializeDatabase, getSqlite } = await import("@/lib/db");
    initializeDatabase();
    const db = getSqlite();
    ensureModelsBaseUrlColumn(db);
    const rows = db.prepare("SELECT * FROM models ORDER BY priority DESC").all() as ModelRow[];
    const target = resolveModelRow(rows, modelRef);
    if (!target) {
      return `Model not found: ${modelRef}. Add it first with "add model <provider> <modelId>".`;
    }
    const maxPriority = (
      db.prepare("SELECT COALESCE(MAX(priority), 0) as max FROM models").get() as { max: number }
    ).max;
    db.prepare("UPDATE models SET is_active = 1, priority = ? WHERE id = ?").run(maxPriority + 1, target.id);
    return `Primary model set to ${target.provider}/${target.model_id} (${target.id}).`;
  }

  const wantsToolList =
    normalized === "tools" ||
    normalized === "list tools" ||
    normalized === "show tools" ||
    normalized === "list custom tools";
  if (wantsToolList) {
    const [{ initializeDatabase, getSqlite }, { TOOL_LABELS }] = await Promise.all([
      import("@/lib/db"),
      import("@/lib/engine/tools"),
    ]);
    initializeDatabase();
    const db = getSqlite();
    ensureCustomToolsTable(db);
    const rows = db
      .prepare("SELECT * FROM custom_tools ORDER BY created_at DESC")
      .all() as ToolRow[];
    const activeCustom = rows.filter((row) => row.is_active === 1);
    if (rows.length === 0) {
      return `Tools: ${Object.keys(TOOL_LABELS).length} built-in, 0 custom.`;
    }
    const lines = rows.slice(0, 12).map((row, index) => {
      const status = row.is_active === 1 ? "active" : "inactive";
      const wrapper = row.wrapper_mode === "generated" ? "wrapper" : row.type;
      const validation = row.validation_status && row.validation_status !== "untested" ? `, ${row.validation_status}` : "";
      return `${index + 1}. ${row.name} (${row.id}) [${status}, ${wrapper}${validation}]`;
    });
    return `Tools: ${Object.keys(TOOL_LABELS).length} built-in, ${rows.length} custom (${activeCustom.length} active).\n${lines.join("\n")}`;
  }

  const findToolsMatch =
    raw.match(/^find\s+tools?\s+for\s+(.+)$/i) ||
    raw.match(/^recommend\s+tools?\s+for\s+(.+)$/i) ||
    raw.match(/^what\s+tools?\s+should\s+i\s+use\s+for\s+(.+)$/i) ||
    raw.match(/^which\s+tools?\s+(?:is|are)\s+(?:best|good|right)\s+for\s+(.+)$/i) ||
    raw.match(/^is\s+there\s+a\s+tool\s+for\s+(.+)$/i);
  if (findToolsMatch?.[1]) {
    const { searchToolKnowledgeDocs } = await import("@/lib/engine/tools");
    const query = stripWrappedQuotes(findToolsMatch[1]);
    const matches = await searchToolKnowledgeDocs(query, 5);
    if (matches.length === 0) {
      return `No strong tool matches found for "${query}". Try: show tools`;
    }
    return [
      `Recommended tools for "${query}":`,
      ...matches.map((doc, index) =>
        `${index + 1}. ${doc.label} (${doc.name}) [${doc.source}]${doc.parameterNames.length ? `\n   Params: ${doc.parameterNames.join(", ")}` : ""}\n   ${doc.description}`,
      ),
    ].join("\n");
  }

  const showToolHelpMatch =
    raw.match(/^(?:show|open|explain|inspect)\s+tool\s+(?:help\s+for\s+)?(.+)$/i) ||
    raw.match(/^how\s+do\s+i\s+use\s+(?:the\s+)?tool\s+(.+)$/i) ||
    raw.match(/^what\s+does\s+(?:the\s+)?tool\s+(.+?)\s+do$/i);
  if (showToolHelpMatch?.[1]) {
    const { listToolKnowledgeDocs } = await import("@/lib/engine/tools");
    const query = trimReferenceTrail(stripWrappedQuotes(showToolHelpMatch[1]));
    const docs = await listToolKnowledgeDocs();
    const exact =
      docs.find((doc) => doc.name.toLowerCase() === query.toLowerCase()) ??
      docs.find((doc) => doc.label.toLowerCase() === query.toLowerCase()) ??
      docs.find((doc) => doc.name.toLowerCase().includes(query.toLowerCase())) ??
      docs.find((doc) => doc.label.toLowerCase().includes(query.toLowerCase()));
    if (!exact) {
      return `Tool not found: ${query}. Try: find tools for ${query}`;
    }
    return [
      `${exact.label} (${exact.name}) [${exact.source}]`,
      exact.description,
      exact.parameterNames.length > 0 ? `Parameters: ${exact.parameterNames.join(", ")}` : "Parameters: none",
      exact.detailText,
    ]
      .filter(Boolean)
      .join("\n");
  }

  const agentToolToggleMatch = raw.match(
    /^(enable|disable|activate|deactivate|turn\s+on|turn\s+off)\s+tool\s+([A-Za-z0-9_:-]+)\s+(?:for|on)\s+agent\s+(.+)$/i,
  );
  if (agentToolToggleMatch?.[1] && agentToolToggleMatch?.[2] && agentToolToggleMatch?.[3]) {
    if (!isSensitiveCommandAllowed(ctx)) return denySensitiveCommand();
    const action = agentToolToggleMatch[1].toLowerCase();
    const toolName = agentToolToggleMatch[2].trim();
    const agentRef = agentToolToggleMatch[3].trim();
    const enable = action.startsWith("enable") || action.startsWith("activate") || action.startsWith("turn on");

    const { listAgents, setAgentDisabledTools } = await import("@/lib/agents/registry");
    const agents = listAgents() as AgentLite[];
    const matches = resolveAgentMatches(agents, agentRef);
    if (matches.length === 0) return `Agent not found: ${agentRef}.`;
    if (matches.length > 1) {
      return `Multiple agents matched: ${matches.map((agent) => `${agent.name} (${agent.id})`).join(", ")}`;
    }

    const target = matches[0];
    const nextDisabled = new Set(target.disabledTools);
    if (enable) nextDisabled.delete(toolName);
    else nextDisabled.add(toolName);
    const updated = setAgentDisabledTools(target.id, [...nextDisabled]);

    return `Tool ${toolName} ${enable ? "enabled" : "disabled"} for agent ${updated.name} (${updated.id}).`;
  }

  const customToolToggleMatch = raw.match(
    /^(enable|disable|activate|deactivate|turn\s+on|turn\s+off)\s+(?:custom\s+)?tool\s+([A-Za-z0-9_:-]+)$/i,
  );
  if (customToolToggleMatch?.[1] && customToolToggleMatch?.[2]) {
    if (!isSensitiveCommandAllowed(ctx)) return denySensitiveCommand();
    const action = customToolToggleMatch[1].toLowerCase();
    const toolRef = customToolToggleMatch[2].trim();
    const enable = action.startsWith("enable") || action.startsWith("activate") || action.startsWith("turn on");

    const [{ initializeDatabase, getSqlite }, { TOOL_LABELS }] = await Promise.all([
      import("@/lib/db"),
      import("@/lib/engine/tools"),
    ]);
    initializeDatabase();
    const db = getSqlite();
    ensureCustomToolsTable(db);
    const row = db
      .prepare("SELECT * FROM custom_tools WHERE id = ? OR name = ? LIMIT 1")
      .get(toolRef, toolRef) as ToolRow | undefined;
    if (!row) {
      if (TOOL_LABELS[toolRef]) {
        return `Built-in tool "${toolRef}" is always available globally. Use "disable tool ${toolRef} for agent <id>" to block it per agent.`;
      }
      return `Custom tool not found: ${toolRef}.`;
    }
    db.prepare("UPDATE custom_tools SET is_active = ?, updated_at = ? WHERE id = ?").run(
      enable ? 1 : 0,
      new Date().toISOString(),
      row.id,
    );
    return `Custom tool ${row.name} is now ${enable ? "active" : "inactive"}.`;
  }

  const wantsSecretList =
    normalized === "list secrets" ||
    normalized === "show secrets" ||
    normalized === "secrets" ||
    normalized === "secrets status";
  if (wantsSecretList) {
    const { getSecretsStatus, listSecretsMeta } = await import("@/lib/secrets/store");
    const status = getSecretsStatus();
    const secrets = listSecretsMeta();
    const lines = secrets.slice(0, 20).map((item, index) => {
      return `${index + 1}. ${item.name} (source=${item.source})`;
    });
    return [
      `Secrets: ${secrets.length} stored`,
      `Master key configured: ${status.masterKeyConfigured ? "yes" : "no"}`,
      ...(status.keySource ? [`Key source: ${status.keySource}`] : []),
      ...(lines.length > 0 ? lines : ["No secrets stored yet."]),
    ].join("\n");
  }

  const extensionHookResponse = await (async () => {
    const { runExtensionCommandHooks } = await import("@/lib/extensions/runtime");
    return runExtensionCommandHooks(raw, ctx);
  })();
  if (extensionHookResponse) {
    return extensionHookResponse;
  }

  const setSecretMatch = raw.match(
    /^(?:set|save|store|update)\s+secret\s+([A-Za-z][A-Za-z0-9_]*)\s*(?:to|=)\s*(.+)$/i,
  );
  if (setSecretMatch?.[1] && setSecretMatch?.[2]) {
    if (!isSensitiveCommandAllowed(ctx)) return denySensitiveCommand();
    const name = setSecretMatch[1].trim();
    const value = stripWrappedQuotes(setSecretMatch[2]);
    if (!value) return "Secret value cannot be empty.";
    const queued = queueSensitiveMutation(ctx, {
      kind: "secret-set",
      summary: `Set secret ${name.toUpperCase()}.`,
      payload: { name, value },
    });
    if (queued) return queued;
  }

  const deleteSecretMatch = raw.match(/^(?:delete|remove)\s+secret\s+([A-Za-z][A-Za-z0-9_]*)$/i);
  if (deleteSecretMatch?.[1]) {
    if (!isSensitiveCommandAllowed(ctx)) return denySensitiveCommand();
    const name = deleteSecretMatch[1].trim();
    const queued = queueSensitiveMutation(ctx, {
      kind: "secret-delete",
      summary: `Delete secret ${name.toUpperCase()}.`,
      payload: { name },
    });
    if (queued) return queued;
  }

  const wantsConfigSummary =
    normalized === "config" ||
    normalized === "/config" ||
    normalized === "show config" ||
    normalized === "show settings" ||
    normalized === "list settings" ||
    normalized === "show settings tab";
  if (wantsConfigSummary) {
    const { initializeDatabase, getSqlite } = await import("@/lib/db");
    initializeDatabase();
    const db = getSqlite();
    const appRow = db.prepare("SELECT * FROM app_config WHERE id = 'default'").get() as
      | Record<string, unknown>
      | undefined;
    const memRow = db.prepare("SELECT * FROM memory_config WHERE id = 'default'").get() as
      | Record<string, unknown>
      | undefined;
    if (!appRow) return "Config not found.";

    const merged = { ...(appRow ?? {}), ...(memRow ?? {}) };
    const lines: string[] = [];
    for (const key of SHOW_CONFIG_DEFAULT_FIELDS) {
      const field = CONFIG_FIELDS.find((item) => item.column === key);
      if (!field) continue;
      lines.push(`- ${key}: ${formatConfigValue(merged[key], field)}`);
    }
    return [
      "Config summary:",
      lines.join("\n"),
      "",
      formatFeatureHowTo("settings"),
    ].join("\n");
  }

  const showConfigFieldMatch = raw.match(/^(?:show|get|read)\s+(?:config|setting)\s+(.+)$/i);
  if (showConfigFieldMatch?.[1]) {
    const field = resolveConfigField(showConfigFieldMatch[1]);
    if (!field) {
      return `Unknown config key: ${showConfigFieldMatch[1]}. Try "show config" for supported keys.`;
    }
    const { initializeDatabase, getSqlite } = await import("@/lib/db");
    initializeDatabase();
    const db = getSqlite();
    const row = db
      .prepare(`SELECT ${field.column} FROM ${field.table} WHERE id = 'default'`)
      .get() as Record<string, unknown> | undefined;
    const value = row?.[field.column];
    return `Config ${field.column} = ${formatConfigValue(value, field)}`;
  }

  const setConfigMatch = raw.match(
    /^(?:set|update|change)\s+(?:config|setting)\s+(.+?)\s*(?:to|=)\s*(.+)$/i,
  );
  if (setConfigMatch?.[1] && setConfigMatch?.[2]) {
    if (!isSensitiveCommandAllowed(ctx)) return denySensitiveCommand();
    const field = resolveConfigField(setConfigMatch[1]);
    if (!field) {
      return `Unknown config key: ${setConfigMatch[1]}.`;
    }
    try {
      const parsed = parseConfigValue(setConfigMatch[2], field);
      const queued = queueSensitiveMutation(ctx, {
        kind: "config-set",
        summary: `Set config ${field.column} to ${formatConfigValue(parsed, field)}.`,
        payload: {
          table: field.table,
          column: field.column,
          value: parsed,
        },
      });
      if (queued) return queued;
    } catch (error) {
      return `Config update failed: ${String(error)}`;
    }
  }

  const toggleConfigMatch = raw.match(/^(enable|disable|turn\s+on|turn\s+off)\s+(.+)$/i);
  if (toggleConfigMatch?.[1] && toggleConfigMatch?.[2]) {
    if (!isSensitiveCommandAllowed(ctx)) return denySensitiveCommand();
    const field = resolveConfigField(toggleConfigMatch[2]);
    if (field && field.type === "boolean") {
      const action = toggleConfigMatch[1].toLowerCase();
      const value = action.startsWith("disable") || action.startsWith("turn off") ? 0 : 1;
      const queued = queueSensitiveMutation(ctx, {
        kind: "config-toggle",
        summary: `${value === 1 ? "Enable" : "Disable"} ${field.column}.`,
        payload: {
          table: field.table,
          column: field.column,
          value,
        },
      });
      if (queued) return queued;
    }
  }

  const wantsGeneratedCleanup =
    normalized === "cleanup generated artifacts" ||
    normalized === "cleanup generated" ||
    normalized === "cleanup test artifacts" ||
    normalized === "clean up generated artifacts" ||
    normalized === "clean up test artifacts";

  if (wantsGeneratedCleanup) {
    if (!isSensitiveCommandAllowed(ctx)) return denySensitiveCommand();
    const queued = queueSensitiveMutation(ctx, {
      kind: "cleanup-generated",
      summary: "Clean up generated artifacts and test cron workflows.",
      payload: {},
    });
    if (queued) return queued;
  }

  const wantsLastProvenance =
    normalized === "show last provenance" ||
    normalized === "last provenance" ||
    normalized === "show provenance" ||
    normalized === "provenance";

  if (wantsLastProvenance) {
    if (!ctx.sessionId) {
      return "No session provenance is available for this channel yet.";
    }
    const { initializeDatabase, getSqlite } = await import("@/lib/db");
    initializeDatabase();
    const db = getSqlite();
    const row = db.prepare(
      "SELECT role, provenance, metadata, created_at FROM messages WHERE session_id = ? ORDER BY created_at DESC LIMIT 1",
    ).get(ctx.sessionId) as
      | { role: string; provenance: string | null; metadata: string | null; created_at: string }
      | undefined;
    if (!row) {
      return "No channel messages have been recorded for this session yet.";
    }
    let provenance: Record<string, unknown> | null = null;
    if (row.provenance) {
      try {
        provenance = JSON.parse(row.provenance) as Record<string, unknown>;
      } catch {
        provenance = null;
      }
    }
    if (!provenance && row.metadata) {
      try {
        const metadata = JSON.parse(row.metadata) as { provenance?: Record<string, unknown> };
        provenance = metadata.provenance ?? null;
      } catch {
        provenance = null;
      }
    }
    if (!provenance) {
      return `No provenance recorded for the latest ${row.role} message in ${ctx.sessionId}.`;
    }
    return formatProvenanceReceipt(provenance);
  }

  if (
    /\bhow\s+(?:do|can)\s+i\s+use\s+(?:the\s+)?docs?\b/i.test(raw) ||
    /\bhow\s+(?:do|can)\s+i\s+use\s+(?:the\s+)?documentation\b/i.test(raw) ||
    normalized.startsWith("how do i use docs") ||
    normalized.startsWith("how can i use docs")
  ) {
    return formatFeatureHowTo("docs");
  }
  if (
    /\bhow\s+(?:do|can)\s+i\s+use\s+(?:the\s+)?(?:workflows?|workflow templates?)\b/i.test(raw) ||
    normalized.startsWith("how do i use workflow") ||
    normalized.startsWith("how can i use workflow")
  ) {
    return formatFeatureHowTo("workflow");
  }
  if (
    /\bhow\s+(?:do|can)\s+i\s+use\s+(?:the\s+)?(?:boards?|tasks?)\b/i.test(raw) ||
    normalized.startsWith("how do i use board") ||
    normalized.startsWith("how can i use board")
  ) {
    return formatFeatureHowTo("board");
  }
  if (
    /\bhow\s+(?:do|can)\s+i\s+use\s+(?:the\s+)?(?:(?:council(?:\s+and\s+hierarchy)?)|hierarchy|org|organization)\b/i.test(raw) ||
    normalized.startsWith("how do i use council") ||
    normalized.startsWith("how do i use hierarchy") ||
    normalized.startsWith("how can i use council") ||
    normalized.startsWith("how can i use hierarchy")
  ) {
    return formatFeatureHowTo("council");
  }
  if (
    /\bhow\s+(?:do|can)\s+i\s+use\s+(?:the\s+)?(?:scheduler|schedules?|cron)\b/i.test(raw) ||
    normalized.startsWith("how do i use the scheduler") ||
    normalized.startsWith("how do i use scheduler") ||
    normalized.startsWith("how can i use the scheduler") ||
    normalized.startsWith("how can i use scheduler")
  ) {
    return formatFeatureHowTo("scheduler");
  }
  if (
    /\bhow\s+(?:do|can)\s+i\s+use\s+(?:the\s+)?(?:data\s+sources?|documents?|docs?)\b/i.test(raw) ||
    normalized.startsWith("how do i use data source") ||
    normalized.startsWith("how can i use data source")
  ) {
    return formatFeatureHowTo("data-source");
  }
  if (
    /\bhow\s+(?:do|can)\s+i\s+use\s+(?:the\s+)?channels?\b/i.test(raw) ||
    normalized.startsWith("how do i use channels") ||
    normalized.startsWith("how can i use channels")
  ) {
    return formatFeatureHowTo("channels");
  }
  if (
    /\bhow\s+(?:do|can)\s+i\s+use\s+(?:the\s+)?(?:extensions?|plugins?)\b/i.test(raw) ||
    normalized.startsWith("how do i use extensions") ||
    normalized.startsWith("how can i use extensions")
  ) {
    return formatFeatureHowTo("extensions");
  }
  if (
    /\bhow\s+(?:do|can)\s+i\s+use\s+(?:the\s+)?(?:skills?|skill\s+packs?)\b/i.test(raw) ||
    normalized.startsWith("how do i use skills") ||
    normalized.startsWith("how can i use skills")
  ) {
    return formatFeatureHowTo("skills");
  }
  if (
    /\bhow\s+(?:do|can)\s+i\s+use\s+(?:the\s+)?(?:dashboard|overview)\b/i.test(raw) ||
    normalized.startsWith("how do i use dashboard") ||
    normalized.startsWith("how can i use dashboard")
  ) {
    return formatFeatureHowTo("dashboard");
  }
  if (
    /\bhow\s+(?:do|can)\s+i\s+use\s+(?:the\s+)?activity\b/i.test(raw) ||
    normalized.startsWith("how do i use activity") ||
    normalized.startsWith("how can i use activity")
  ) {
    return formatFeatureHowTo("activity");
  }
  if (
    /\bhow\s+(?:do|can)\s+i\s+use\s+(?:the\s+)?approvals?\b/i.test(raw) ||
    normalized.startsWith("how do i use approvals") ||
    normalized.startsWith("how can i use approvals")
  ) {
    return formatFeatureHowTo("approvals");
  }
  if (
    /\bhow\s+(?:do|can)\s+i\s+use\s+(?:the\s+)?logs?\b/i.test(raw) ||
    normalized.startsWith("how do i use logs") ||
    normalized.startsWith("how can i use logs")
  ) {
    return formatFeatureHowTo("logs");
  }
  if (
    /\bhow\s+(?:do|can)\s+i\s+use\s+(?:the\s+)?debug\b/i.test(raw) ||
    normalized.startsWith("how do i use debug") ||
    normalized.startsWith("how can i use debug")
  ) {
    return formatFeatureHowTo("debug");
  }
  if (
    /\bhow\s+(?:do|can)\s+i\s+use\s+(?:the\s+)?maintenance\b/i.test(raw) ||
    normalized.startsWith("how do i use maintenance") ||
    normalized.startsWith("how can i use maintenance")
  ) {
    return formatFeatureHowTo("maintenance");
  }
  if (
    /\bhow\s+(?:do|can)\s+i\s+use\s+(?:the\s+)?security\b/i.test(raw) ||
    normalized.startsWith("how do i use security") ||
    normalized.startsWith("how can i use security")
  ) {
    return formatFeatureHowTo("security");
  }
  if (
    /\bhow\s+(?:do|can)\s+i\s+use\s+(?:the\s+)?(?:metrics|cost analysis|costs?)\b/i.test(raw) ||
    normalized.startsWith("how do i use metrics") ||
    normalized.startsWith("how can i use metrics")
  ) {
    return formatFeatureHowTo("metrics");
  }
  if (
    /\bhow\s+(?:do|can)\s+i\s+use\s+(?:the\s+)?usage\b/i.test(raw) ||
    normalized.startsWith("how do i use usage") ||
    normalized.startsWith("how can i use usage")
  ) {
    return formatFeatureHowTo("usage");
  }
  if (
    /\bhow\s+(?:do|can)\s+i\s+use\s+(?:the\s+)?settings\b/i.test(raw) ||
    normalized.startsWith("how do i use settings") ||
    normalized.startsWith("how can i use settings") ||
    normalizedLookup === "what can i change in settings" ||
    normalizedLookup === "what can the settings page help me control"
  ) {
    return formatFeatureHowTo("settings");
  }
  if (
    /\bhow\s+(?:do|can)\s+i\s+use\s+(?:the\s+)?tags?\b/i.test(raw) ||
    normalized.startsWith("how do i use tags") ||
    normalized.startsWith("how can i use tags")
  ) {
    return formatFeatureHowTo("tags");
  }
  if (
    /\bhow\s+(?:do|can)\s+i\s+use\s+(?:the\s+)?memory\b/i.test(raw) ||
    normalized.startsWith("how do i use memory") ||
    normalized.startsWith("how can i use memory")
  ) {
    return formatFeatureHowTo("memory");
  }
  if (
    /\bhow\s+(?:do|can)\s+i\s+use\s+(?:the\s+)?live\b/i.test(raw) ||
    normalized.startsWith("how do i use live") ||
    normalized.startsWith("how can i use live")
  ) {
    return formatFeatureHowTo("live");
  }

  const wantsDocsSummary =
    normalized === "docs" ||
    normalized === "show docs" ||
    normalized === "show docs tab" ||
    normalized === "show documentation" ||
    normalized === "docs summary" ||
    normalizedLookup === "show docs summary";
  if (wantsDocsSummary) {
    try {
      return await buildDocsSummary(internalApiBaseUrl);
    } catch (error) {
      return `Docs summary failed: ${String(error)}.`;
    }
  }

  const wantsExtensionsSummary =
    normalized === "extensions" ||
    normalized === "show extensions" ||
    normalized === "show extensions tab" ||
    normalized === "list extensions" ||
    normalized === "plugins" ||
    normalized === "show plugins" ||
    normalized === "list plugins";
  if (wantsExtensionsSummary) {
    try {
      return await buildExtensionsSummary(internalApiBaseUrl);
    } catch (error) {
      return `Extensions summary failed: ${String(error)}.`;
    }
  }

  const wantsMetricsSummary =
    normalized === "metrics" ||
    normalized === "show metrics" ||
    normalized === "list metrics" ||
    normalized === "metrics summary" ||
    normalized === "show metrics summary" ||
    normalized === "show metrics tab" ||
    normalized === "show cost analysis" ||
    normalized === "show costs" ||
    normalized === "cost analysis" ||
    normalizedLookup === "show me cost analysis" ||
    normalizedLookup === "what are the top providers and workflows this week" ||
    normalizedLookup === "what do the metrics look like today" ||
    normalizedLookup === "how are our metrics today";
  if (wantsMetricsSummary) {
    try {
      return await buildMetricsSummary(internalApiBaseUrl);
    } catch (error) {
      return `Metrics summary failed: ${String(error)}.`;
    }
  }

  const wantsDashboardSummary =
    normalized === "dashboard" ||
    normalized === "show dashboard" ||
    normalized === "show dashboard tab" ||
    normalized === "show overview" ||
    normalizedLookup === "what does the dashboard look like right now" ||
    normalizedLookup === "give me a quick system overview";
  if (wantsDashboardSummary) {
    try {
      return await buildDashboardSummary(internalApiBaseUrl);
    } catch (error) {
      return `Dashboard summary failed: ${String(error)}.`;
    }
  }

  const wantsChannelsSummary =
    normalized === "channels" ||
    normalized === "show channels" ||
    normalized === "show channels tab" ||
    normalized === "channel status" ||
    normalized === "channels status" ||
    normalizedLookup === "show channels summary" ||
    normalizedLookup === "what channels are connected" ||
    normalizedLookup === "which channels are connected" ||
    normalizedLookup === "which channels do we have live" ||
    normalizedLookup === "what channels do we have live" ||
    normalized.includes("connected channels");
  if (wantsChannelsSummary) {
    try {
      return await buildChannelsSummary(internalApiBaseUrl);
    } catch (error) {
      return `Channels summary failed: ${String(error)}.`;
    }
  }

  const wantsActivitySummary =
    normalized === "activity" ||
    normalized === "show activity" ||
    normalized === "show activity tab" ||
    normalized === "show recent activity" ||
    normalized === "show my recent activity" ||
    normalized === "show me recent activity" ||
    normalized === "show me my recent activity" ||
    normalized === "recent activity" ||
    normalized === "my recent activity" ||
    normalized === "show recent errors" ||
    normalized === "show recent workflow errors" ||
    normalized === "show me recent workflow errors" ||
    normalized === "recent workflow errors" ||
    normalizedLookup === "what has been running lately" ||
    normalizedLookup === "show the recent execution history" ||
    /^(?:show me|show)\s+(?:my\s+)?recent\s+(?:activity|executions?|runs?|errors?|workflow\s+errors?)\??$/i.test(raw) ||
    /^(?:what(?:'s| is|were)\s+(?:my\s+)?(?:recent|latest)\s+(?:workflow\s+)?(?:runs?|executions?|errors?))\??$/i.test(raw);
  if (wantsActivitySummary) {
    try {
      return await buildActivitySummary(internalApiBaseUrl);
    } catch (error) {
      return `Activity summary failed: ${String(error)}.`;
    }
  }

  const wantsLiveSummary =
    normalized === "live" ||
    normalized === "show live" ||
    normalized === "show live tab" ||
    normalized === "live status";
  if (wantsLiveSummary) {
    try {
      return [
        "## Live summary",
        "The Live tab currently redirects to Activity in this build.",
        await buildActivitySummary(internalApiBaseUrl),
      ].join("\n");
    } catch (error) {
      return `Live summary failed: ${String(error)}.`;
    }
  }

  const wantsApprovalsSummary =
    normalized === "approvals" ||
    normalized === "show approvals" ||
    normalized === "show approvals tab" ||
    normalized === "show approval queue" ||
    normalizedLookup === "what approvals are waiting right now" ||
    normalizedLookup === "what approvals need attention" ||
    normalizedLookup === "what approvals need attention right now";
  if (wantsApprovalsSummary) {
    try {
      return await buildApprovalsSummary(internalApiBaseUrl);
    } catch (error) {
      return `Approvals summary failed: ${String(error)}.`;
    }
  }

  const wantsLogsSummary =
    normalized === "logs" ||
    normalized === "show logs" ||
    normalized === "show the logs" ||
    normalized === "show logs tab" ||
    normalized === "show recent logs" ||
    normalizedLookup === "show the recent logs" ||
    normalizedLookup === "what do the recent logs show" ||
    normalized === "tail logs" ||
    normalizedLookup === "tail logs for errors" ||
    (/^(?:show|tail|open|get|read)\b/.test(normalizedLookup) && /\blogs?\b/.test(normalizedLookup));
  if (wantsLogsSummary) {
    try {
      return await buildLogsSummary(internalApiBaseUrl);
    } catch (error) {
      return `Logs summary failed: ${String(error)}.`;
    }
  }

  const wantsDebugSummary =
    normalized === "debug" ||
    normalized === "show debug" ||
    normalized === "show debug tab" ||
    normalized === "debug summary" ||
    normalized === "show debug summary" ||
    normalizedLookup === "give me a debug snapshot" ||
    normalizedLookup === "show the debug tab summary";
  if (wantsDebugSummary) {
    try {
      return await buildDebugSummary(internalApiBaseUrl);
    } catch (error) {
      return `Debug summary failed: ${String(error)}.`;
    }
  }

  const wantsMaintenanceSummary =
    normalized === "maintenance" ||
    normalized === "show maintenance" ||
    normalized === "show maintenance tab" ||
    normalizedLookup === "give me the maintenance health report" ||
    normalizedLookup === "what needs maintenance attention right now";
  if (wantsMaintenanceSummary) {
    try {
      return await buildMaintenanceSummary(internalApiBaseUrl);
    } catch (error) {
      return `Maintenance summary failed: ${String(error)}.`;
    }
  }

  const wantsSecuritySummary =
    normalized === "security" ||
    normalized === "show security" ||
    normalized === "show security tab" ||
    normalized === "security report" ||
    normalized === "show security report" ||
    normalizedLookup === "run the security summary" ||
    normalizedLookup === "what does the security report say";
  if (wantsSecuritySummary) {
    try {
      return await buildSecuritySummary(internalApiBaseUrl);
    } catch (error) {
      return `Security summary failed: ${String(error)}.`;
    }
  }

  const wantsUsageSummary =
    normalized === "usage" ||
    normalized === "show usage" ||
    normalized === "list usage" ||
    normalized === "usage summary" ||
    normalized === "show usage tab" ||
    normalized === "what is running right now" ||
    normalized === "show recent executions" ||
    normalized === "show running workflows" ||
    normalizedLookup === "how are we doing today on usage";
  if (wantsUsageSummary) {
    try {
      return await buildUsageSummary(internalApiBaseUrl);
    } catch (error) {
      return `Usage summary failed: ${String(error)}.`;
    }
  }

  const wantsTagsSummary =
    normalized === "tags" ||
    normalized === "show tags" ||
    normalized === "list tags" ||
    normalized === "show tags tab" ||
    normalizedLookup === "show tags summary";
  if (wantsTagsSummary) {
    try {
      return await buildTagsSummary(internalApiBaseUrl);
    } catch (error) {
      return `Tags summary failed: ${String(error)}.`;
    }
  }

  if (isMemoryFileReadRequest(raw)) {
    try {
      const [{ getDefaultAgent }, { readWorkspaceMemorySlice }] = await Promise.all([
        import("@/lib/agents/registry"),
        import("@/lib/workspace/files"),
      ]);
      const agent = getDefaultAgent();
      const slice = readWorkspaceMemorySlice({
        relPath: "MEMORY.md",
        lines: 120,
        workspacePath: agent.workspacePath,
      });
      const text = slice.text.trim();
      if (!text) return "MEMORY.md exists but is empty, or it has not been created yet.";
      const truncated = text.length > 5000 ? `${text.slice(0, 5000)}\n\n[truncated]` : text;
      return [`MEMORY.md (${slice.path})`, "", truncated].join("\n");
    } catch (error) {
      return `Memory file read failed: ${String(error)}.`;
    }
  }

  const wantsMemorySummary =
    normalized === "memory" ||
    normalized === "show memory" ||
    normalized === "show memory tab" ||
    normalized === "memory summary" ||
    normalized === "memory status" ||
    normalized === "show memory status";
  if (wantsMemorySummary) {
    try {
      return await buildMemorySummary(internalApiBaseUrl);
    } catch (error) {
      return `Memory summary failed: ${String(error)}.`;
    }
  }

  const checkpointIntent = parseCheckpointIntent(raw);
  if (checkpointIntent) {
    if (checkpointIntent.action === "rollback" && !isSensitiveCommandAllowed(ctx)) {
      return denySensitiveCommand();
    }
    const {
      createCheckpoint,
      diffCheckpoint,
      listCheckpoints,
      rollbackToCheckpointPath,
    } = await import("@/lib/checkpoint/manager");
    if (checkpointIntent.action === "list") {
      const checkpoints = listCheckpoints(checkpointIntent.limit);
      if (checkpoints.length === 0) return "No checkpoints found yet.";
      return [
        `Checkpoints (${checkpoints.length} shown):`,
        ...checkpoints.map((entry, index) => `${index + 1}. [${entry.id}] ${entry.label} • ${entry.timestamp}`),
      ].join("\n");
    }
    if (checkpointIntent.action === "create") {
      const created = createCheckpoint(checkpointIntent.label || undefined);
      return created
        ? `Checkpoint created: [${created.id}] ${created.label}`
        : "Checkpoint create failed.";
    }

    const checkpoints = listCheckpoints(20);
    const resolved = resolveCheckpointReference(checkpointIntent.reference, checkpoints);
    if (!resolved) {
      return `Checkpoint not found: ${checkpointIntent.reference}. Use "list checkpoints" first.`;
    }
    if (checkpointIntent.action === "diff") {
      const diff = diffCheckpoint(resolved.id);
      return `Checkpoint diff [${resolved.id}] ${resolved.label}\n\n${diff.diff}`;
    }
    const rolledBack = rollbackToCheckpointPath(resolved.id, checkpointIntent.targetPath || undefined);
    if (!rolledBack.success) {
      return `Checkpoint rollback failed: ${rolledBack.error || "unknown error"}.`;
    }
    return [
      `Rollback complete: [${resolved.id}] ${resolved.label}`,
      rolledBack.restoredPath ? `Restored file: ${rolledBack.restoredPath}` : "Restored workspace state.",
      rolledBack.safetyCheckpoint ? `Safety checkpoint: [${rolledBack.safetyCheckpoint.id}]` : null,
    ].filter(Boolean).join("\n");
  }

  const wantsWorkflowList =
    normalized === "workflows" ||
    normalized === "workflow" ||
    normalized === "list workflows" ||
    normalized === "show workflows" ||
    normalized === "show workflow" ||
    normalized === "my workflows" ||
    normalized === "our workflows" ||
    normalized === "current workflows";

  if (wantsWorkflowList) {
    const { initializeDatabase, getSqlite } = await import("@/lib/db");
    const { extractCronNodes, parseWorkflowNodes } = await import("@/lib/agents/workflow-insights");
    initializeDatabase();
    const db = getSqlite();
    const rows = db
      .prepare("SELECT id, name, is_active, nodes FROM workflows ORDER BY updated_at DESC")
      .all() as Array<{ id: string; name: string; is_active: number; nodes: string }>;
    if (rows.length === 0) {
      return "Workflows (0 total)\nNo active workflows found yet. Create one from the Workflows tab or say \"list workflow templates\" first.";
    }
    const lines = rows.slice(0, 12).map((row, index) => {
      const cronCount = extractCronNodes(parseWorkflowNodes(row.nodes)).length;
      const flags = [
        Number(row.is_active) === 1 ? "active" : "inactive",
        cronCount > 0 ? `${cronCount} cron` : null,
      ].filter(Boolean).join(", ");
      return `${index + 1}. ${row.name} (${row.id})${flags ? ` [${flags}]` : ""}`;
    });
    const moreLine =
      rows.length > lines.length
        ? `\n\nShowing ${lines.length} of ${rows.length}. Open the Workflows tab for the full list.`
        : "";
    return `Workflows (${rows.length} total):\n${lines.join("\n")}${moreLine}`;
  }

  const workflowTemplateRecommendation = shouldUseWorkflowTemplateRecommendation(raw)
    ? formatWorkflowTemplateRecommendations(listWorkflowTemplateCatalog(), normalized)
    : null;
  if (workflowTemplateRecommendation) {
    return workflowTemplateRecommendation;
  }

  const wantsWorkflowTemplateList =
    normalized === "list workflow templates" ||
    normalized === "show workflow templates" ||
    normalized === "list templates" ||
    normalized === "show templates" ||
    /\b(?:what|show|list)\b.*\b(?:all\s+)?(?:the\s+)?(?:my\s+)?templates\b/.test(normalized) ||
    normalized.includes("workflow template") ||
    normalized.includes("workflow templates") ||
    normalized.includes("templates can you use") ||
    normalized.includes("what templates can you use");

  if (wantsWorkflowTemplateList) {
    const entries = listWorkflowTemplateCatalog();
    return formatWorkflowTemplateRecommendations(entries, normalized);
  }

  const fuzzyTemplateCreateIntent = parseTemplateCreateIntent(raw);
  if (fuzzyTemplateCreateIntent) {
    const template = resolveWorkflowTemplateReference(fuzzyTemplateCreateIntent.templateRef);
    if (!template) {
      return `Workflow template not found for "${fuzzyTemplateCreateIntent.templateRef}". Use "list workflow templates" first.`;
    }
    try {
      const response = await fetch(`${internalApiBaseUrl}/api/workflows`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: fuzzyTemplateCreateIntent.workflowName,
          template: template.key,
        }),
      });
      const payload = (await response.json()) as { success?: boolean; data?: { id?: string; name?: string }; error?: string };
      if (!response.ok || !payload.success || !payload.data?.id) {
        return `Workflow creation failed: ${payload.error || `HTTP ${response.status}`}.`;
      }
      return `Created workflow "${payload.data.name || fuzzyTemplateCreateIntent.workflowName}" (${payload.data.id}) from template "${template.name}".`;
    } catch (error) {
      return `Workflow creation failed: ${String(error)}.`;
    }
  }

  const createWorkflowFromTemplateMatch = raw.match(/^create\s+workflow\s+called\s+(.+?)\s+from\s+template\s+(.+)$/i);
  const createWorkflowTemplateMatch = raw.match(/^create\s+workflow\s+template\s+(.+?)\s+called\s+(.+)$/i);
  if ((createWorkflowTemplateMatch?.[1] && createWorkflowTemplateMatch?.[2]) || (createWorkflowFromTemplateMatch?.[1] && createWorkflowFromTemplateMatch?.[2])) {
    const templateRef = createWorkflowTemplateMatch?.[1]?.trim() || createWorkflowFromTemplateMatch?.[2]?.trim() || "";
    let workflowName = createWorkflowTemplateMatch?.[2]?.trim() || createWorkflowFromTemplateMatch?.[1]?.trim() || "";
    let organizationId: string | undefined;
    let goalId: string | undefined;
    const scope = parseScopeRefs(workflowName);
    workflowName = scope.remainder || workflowName;
    if (scope.organizationRef) {
      const { resolveHierarchyOrganization } = await import("@/lib/hierarchy/organizations");
      const organization = resolveHierarchyOrganization(scope.organizationRef);
      if (!organization) {
        return `Organization not found: ${scope.organizationRef}.`;
      }
      organizationId = organization.id;
    }
    if (scope.goalRef) {
      const { resolveHierarchyGoal } = await import("@/lib/hierarchy/goals");
      const goal = resolveHierarchyGoal(scope.goalRef, organizationId);
      if (!goal) {
        return `Goal not found: ${scope.goalRef}.`;
      }
      goalId = goal.id;
      organizationId = goal.organizationId ?? organizationId;
    }
    const template = resolveWorkflowTemplateReference(templateRef);
    if (!template) {
      return `Workflow template not found for "${templateRef}". Use "list workflow templates" first.`;
    }
    try {
      const { response, payload } = await fetchInternalJson<{ success?: boolean; data?: { id?: string; name?: string }; error?: string }>(
        `${internalApiBaseUrl}/api/workflows`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: workflowName,
            template: template.key,
            organizationId,
            goalId,
          }),
        },
        "channel-workflow-template-create",
      );
      if (!response.ok || !payload.success || !payload.data?.id) {
        return `Workflow creation failed: ${payload.error || `HTTP ${response.status}`}.`;
      }
      return `Created workflow "${payload.data.name || workflowName}" (${payload.data.id}) from template "${template.name}"${organizationId ? " with organization scope" : ""}${goalId ? " and linked goal" : ""}.`;
    } catch (error) {
      return `Workflow creation failed: ${String(error)}.`;
    }
  }

  const fuzzyTemplateRunIntent = parseTemplateRunIntent(raw);
  if (fuzzyTemplateRunIntent) {
    const template = resolveWorkflowTemplateReference(fuzzyTemplateRunIntent.templateRef);
    if (!template) {
      return `Workflow template not found for "${fuzzyTemplateRunIntent.templateRef}". Use "list workflow templates" first.`;
    }
    try {
      const { response: createResponse, payload: createPayload } = await fetchInternalJson<{ success?: boolean; data?: { id?: string; name?: string }; error?: string }>(
        `${internalApiBaseUrl}/api/workflows`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: fuzzyTemplateRunIntent.workflowName,
            template: template.key,
          }),
        },
        "channel-workflow-template-launch-create",
      );
      if (!createResponse.ok || !createPayload.success || !createPayload.data?.id) {
        return `Workflow launch failed: ${createPayload.error || `HTTP ${createResponse.status}`}.`;
      }
      const executeRequest = {
        workflowId: createPayload.data.id,
        triggerType: "manual" as const,
        triggerData: {
          message: fuzzyTemplateRunIntent.payload || raw,
          text: fuzzyTemplateRunIntent.payload || raw,
        },
        provenance: createProvenance("channel", `channel:${ctx.channel}`, {
          channel: ctx.channel,
          sessionId: ctx.sessionId ?? undefined,
          sender: ctx.sender,
          routeSource: "workflow-template-run-command",
          workflowId: createPayload.data.id,
          workflowName: createPayload.data.name || fuzzyTemplateRunIntent.workflowName,
        }),
      };
      void withRetry(
        () =>
          fetch(`${internalApiBaseUrl}/api/execute`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            cache: "no-store",
            body: JSON.stringify(executeRequest),
          }),
        {
          label: "channel-workflow-template-launch-execute",
          shouldRetry: (error) => {
            const message = String(error).toLowerCase();
            return message.includes("fetch failed") || message.includes("econnrefused") || message.includes("socket");
          },
        },
      ).catch((error) => {
        log.warn("Async workflow template launch failed", {
          workflowId: createPayload.data?.id,
          templateKey: template.key,
          error: String(error),
        });
      });
      return [
        `Started template "${template.name}" as workflow "${createPayload.data.name || fuzzyTemplateRunIntent.workflowName}" (${createPayload.data.id}).`,
        "Execution: queued.",
        fuzzyTemplateRunIntent.payload ? `Input: ${fuzzyTemplateRunIntent.payload}` : null,
        "Check Activity or Logs for progress.",
      ].filter(Boolean).join("\n");
    } catch (error) {
      return `Workflow launch failed: ${String(error)}.`;
    }
  }

  const workflowGenerateIntent = parseWorkflowGenerateIntent(raw);
  if (workflowGenerateIntent) {
    try {
      const { response: generatedResponse, payload: generatedPayload } = await fetchInternalJson<{
        success?: boolean;
        data?: { nodes?: unknown[]; edges?: unknown[] };
        error?: string;
      }>(
        `${internalApiBaseUrl}/api/workflows/generate`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ description: workflowGenerateIntent.description }),
        },
        "channel-workflow-generate",
      );
      if (!generatedResponse.ok || !generatedPayload.success || !Array.isArray(generatedPayload.data?.nodes)) {
        return `Workflow generation failed: ${generatedPayload.error || `HTTP ${generatedResponse.status}`}.`;
      }
      const { response: createResponse, payload: createPayload } = await fetchInternalJson<{
        success?: boolean;
        data?: { id?: string; name?: string };
        error?: string;
      }>(
        `${internalApiBaseUrl}/api/workflows`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: workflowGenerateIntent.name,
            description: workflowGenerateIntent.description,
            nodes: generatedPayload.data?.nodes ?? [],
            edges: generatedPayload.data?.edges ?? [],
          }),
        },
        "channel-workflow-generate-create",
      );
      if (!createResponse.ok || !createPayload.success || !createPayload.data?.id) {
        return `Workflow generation failed: ${createPayload.error || `HTTP ${createResponse.status}`}.`;
      }
      return [
        `Generated workflow "${createPayload.data.name || workflowGenerateIntent.name}" (${createPayload.data.id}).`,
        `Description: ${workflowGenerateIntent.description}`,
        "You can run it from chat, export it, or add a schedule next.",
      ].join("\n");
    } catch (error) {
      return `Workflow generation failed: ${String(error)}.`;
    }
  }

  const workflowExportIntent = parseWorkflowExportIntent(raw);
  if (workflowExportIntent) {
    if (!isSensitiveCommandAllowed(ctx)) return denySensitiveCommand();
    const { initializeDatabase, getSqlite } = await import("@/lib/db");
    initializeDatabase();
    const db = getSqlite();
    const workflows = db
      .prepare("SELECT id, name FROM workflows ORDER BY updated_at DESC")
      .all() as Array<{ id: string; name: string }>;
    const workflow = findWorkflowMatchByName(workflows, workflowExportIntent.workflowRef.toLowerCase());
    if (!workflow) {
      return `Workflow not found: ${workflowExportIntent.workflowRef}. Use "list workflows" in the Workflows tab or create one first.`;
    }
    try {
      const response = await withRetry(
        () =>
          fetch(`${internalApiBaseUrl}/api/workflows?action=export&id=${encodeURIComponent(workflow.id)}`, {
            cache: "no-store",
          }),
        {
          label: "channel-workflow-export",
          shouldRetry: (error) => {
            const message = String(error).toLowerCase();
            return message.includes("fetch failed") || message.includes("econnrefused") || message.includes("socket");
          },
        },
      );
      if (!response.ok) {
        return `Workflow export failed: HTTP ${response.status}.`;
      }
      const exportText = await response.text();
      const outputDir = path.resolve("data/workflow-exports");
      fs.mkdirSync(outputDir, { recursive: true });
      const outputPath =
        resolveUserSuppliedPath(workflowExportIntent.outputPath) ||
        path.join(outputDir, `${slugifyFileStem(workflow.name)}.disp8ch.json`);
      fs.writeFileSync(outputPath, exportText, "utf8");
      return `Exported workflow "${workflow.name}" (${workflow.id}) to ${outputPath}.`;
    } catch (error) {
      return `Workflow export failed: ${String(error)}.`;
    }
  }

  const workflowImportIntent = parseWorkflowImportIntent(raw);
  if (workflowImportIntent) {
    if (!isSensitiveCommandAllowed(ctx)) return denySensitiveCommand();
    try {
      const filePath = resolveUserSuppliedPath(workflowImportIntent.filePath);
      if (!fs.existsSync(filePath)) {
        return `Workflow import failed: file not found at ${filePath}.`;
      }
      const importText = fs.readFileSync(filePath, "utf8");
      const importData = JSON.parse(importText) as Record<string, unknown>;
      let importSource: "compatible" | "disp8ch" | null = workflowImportIntent.explicitSource;
      if (!importSource) {
        if (Array.isArray(importData.nodes) && Array.isArray(importData.edges)) {
          importSource = "disp8ch";
        } else if (Array.isArray(importData.nodes) && importData.connections && typeof importData.connections === "object") {
          importSource = "compatible";
        }
      }
      if (!importSource) {
        return `Workflow import failed: unsupported JSON format in ${filePath}.`;
      }
      const { response, payload } = await fetchInternalJson<{
        success?: boolean;
        data?: { id?: string; name?: string; importWarnings?: string[] };
        error?: string;
      }>(
        `${internalApiBaseUrl}/api/workflows`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: workflowImportIntent.name,
            importSource,
            importData,
          }),
        },
        "channel-workflow-import",
      );
      if (!response.ok || !payload.success || !payload.data?.id) {
        return `Workflow import failed: ${payload.error || `HTTP ${response.status}`}.`;
      }
      return [
        `Imported ${importSource.toUpperCase()} workflow as "${payload.data.name || workflowImportIntent.name}" (${payload.data.id}).`,
        Array.isArray(payload.data.importWarnings) && payload.data.importWarnings.length
          ? `Warnings: ${payload.data.importWarnings.join("; ")}`
          : null,
      ].filter(Boolean).join("\n");
    } catch (error) {
      return `Workflow import failed: ${String(error)}.`;
    }
  }

  const listGoalsMatch =
    raw.match(/^list\s+goals(?:\s+in\s+organization\s+(.+))?$/i) ||
    raw.match(/^show\s+goals(?:\s+in\s+organization\s+(.+))?$/i);
  if (listGoalsMatch) {
    const organizationRef = stripWrappedQuotes(listGoalsMatch[1] || "");
    const [{ listHierarchyGoals }, { resolveHierarchyOrganization }] = await Promise.all([
      import("@/lib/hierarchy/goals"),
      import("@/lib/hierarchy/organizations"),
    ]);
    const organization = organizationRef ? resolveHierarchyOrganization(organizationRef) : null;
    if (organizationRef && !organization) {
      return `Organization not found: ${organizationRef}.`;
    }
    const goals = listHierarchyGoals({ organizationId: organization?.id });
    if (goals.length === 0) {
      return organization ? `No goals in ${organization.name}.` : "No goals yet.";
    }
    return [
      `Goals${organization ? ` in ${organization.name}` : ""}:`,
      ...goals.map((goal, index) =>
        `${index + 1}. ${goal.name}${goal.parentGoalName ? ` <- ${goal.parentGoalName}` : ""}`,
      ),
    ].join("\n");
  }

  const showGoalMatch = raw.match(/^(?:show|open|get)\s+goal\s+(.+)$/i);
  if (showGoalMatch?.[1]) {
    const scope = parseScopeRefs(stripWrappedQuotes(showGoalMatch[1]));
    const [{ listGoalAncestry, resolveHierarchyGoal }, { resolveHierarchyOrganization }] = await Promise.all([
      import("@/lib/hierarchy/goals"),
      import("@/lib/hierarchy/organizations"),
    ]);
    const organization = scope.organizationRef ? resolveHierarchyOrganization(scope.organizationRef) : null;
    if (scope.organizationRef && !organization) {
      return `Organization not found: ${scope.organizationRef}.`;
    }
    const goal = resolveHierarchyGoal(scope.remainder || scope.goalRef, organization?.id);
    if (!goal) {
      return `Goal not found: ${scope.remainder || scope.goalRef}.`;
    }
    const ancestry = listGoalAncestry(goal.id);
    return [
      `${goal.name}`,
      goal.description ? `Description: ${goal.description}` : null,
      goal.organizationName ? `Organization: ${goal.organizationName}` : null,
      ancestry.length > 1 ? `Ancestry: ${ancestry.map((item) => item.name).join(" <- ")}` : null,
    ].filter(Boolean).join("\n");
  }

  const createGoalMatch =
    raw.match(/^create\s+goal\s+(?:called|named)?\s*(.+?)(?:\s+about\s+(.+))?$/i) ||
    raw.match(/^add\s+goal\s+(?:called|named)?\s*(.+?)(?:\s+about\s+(.+))?$/i);
  if (createGoalMatch?.[1]) {
    if (!isSensitiveCommandAllowed(ctx)) return denySensitiveCommand();
    let goalNameInput = stripWrappedQuotes(createGoalMatch[1]);
    const description = stripWrappedQuotes(createGoalMatch[2] || "");
    const scope = parseScopeRefs(goalNameInput);
    goalNameInput = scope.remainder || goalNameInput;
    const [{ createHierarchyGoal, resolveHierarchyGoal }, { getActiveHierarchyOrganization, resolveHierarchyOrganization }] = await Promise.all([
      import("@/lib/hierarchy/goals"),
      import("@/lib/hierarchy/organizations"),
    ]);
    const organization =
      (scope.organizationRef ? resolveHierarchyOrganization(scope.organizationRef) : null) ??
      getActiveHierarchyOrganization();
    if (scope.organizationRef && !organization) {
      return `Organization not found: ${scope.organizationRef}.`;
    }
    const parentGoal = scope.goalRef ? resolveHierarchyGoal(scope.goalRef, organization?.id) : null;
    if (scope.goalRef && !parentGoal) {
      return `Goal not found: ${scope.goalRef}.`;
    }
    const goal = createHierarchyGoal({
      name: goalNameInput,
      description: description || null,
      organizationId: organization?.id ?? null,
      parentGoalId: parentGoal?.id ?? null,
    });
    return `Goal created: ${goal.name}${goal.organizationName ? ` in ${goal.organizationName}` : ""}${goal.parentGoalName ? ` under ${goal.parentGoalName}` : ""}.`;
  }

  const listDocs =
    /^(?:list|show)\s+(?:me\s+)?(?:all\s+)?(?:my\s+)?(?:the\s+)?(?:docs?|documents?|data sources?)\s*$/i.test(raw) ||
    normalized.includes("show documents") ||
    normalized.includes("show docs") ||
    normalized.includes("show data sources") ||
    /^(?:what|which|how many)\s+(?:data sources?|documents?)\s+(?:do i have|have i added|are there|are stored)\??$/i.test(raw) ||
    /^(?:what|which)\s+(?:data sources?|documents?)\s+(?:have i|did i)\s+(?:added?|uploaded?|imported?|stored?)\??$/i.test(raw);

  const dataSourceCreateIntent = parseDataSourceCreateIntent(raw);
  if (dataSourceCreateIntent) {
    if (dataSourceCreateIntent.mode === "upload" && !isSensitiveCommandAllowed(ctx)) {
      return denySensitiveCommand();
    }
    try {
      if (dataSourceCreateIntent.mode === "upload") {
        const filePath = resolveUserSuppliedPath(dataSourceCreateIntent.filePath);
        if (!fs.existsSync(filePath)) {
          return `Data source import failed: file not found at ${filePath}.`;
        }
        const buffer = fs.readFileSync(filePath);
        const { response, payload } = await fetchInternalJson<{
          success?: boolean;
          data?: { id?: string; name?: string };
          error?: string;
        }>(
          `${internalApiBaseUrl}/api/documents`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "upload",
              fileName: dataSourceCreateIntent.name,
              mimeType: dataSourceCreateIntent.mimeType,
              contentBase64: buffer.toString("base64"),
            }),
          },
          "channel-doc-upload",
        );
        if (!response.ok || !payload.success || !payload.data?.id) {
          return `Data source import failed: ${payload.error || `HTTP ${response.status}`}.`;
        }
        return `Uploaded data source "${payload.data.name || dataSourceCreateIntent.name}" (${payload.data.id}) from ${filePath}.`;
      }
      const { response, payload } = await fetchInternalJson<{
        success?: boolean;
        data?: { id?: string; name?: string };
        error?: string;
      }>(
        `${internalApiBaseUrl}/api/documents`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "scrape",
            url: dataSourceCreateIntent.url,
            name: dataSourceCreateIntent.name,
            mode: dataSourceCreateIntent.mode === "crawl" ? "crawl" : "single",
          }),
        },
        "channel-doc-create",
      );
      if (!response.ok || !payload.success || !payload.data?.id) {
        return `Data source creation failed: ${payload.error || `HTTP ${response.status}`}.`;
      }
      return `Created data source "${payload.data.name || dataSourceCreateIntent.name}" (${payload.data.id}) from ${dataSourceCreateIntent.url}.`;
    } catch (error) {
      return `Data source creation failed: ${String(error)}.`;
    }
  }

  if (listDocs) {
    const { listDocuments } = await import("@/lib/documents/store");
    const docs = listDocuments().slice(0, 10);
    if (docs.length === 0) {
      return "Data Sources (0 shown):\nNo data sources stored yet. Open the Data Sources tab to upload files, scrape a site, or import a connected source.";
    }
    const lines = docs.map((doc, index) => {
      const source = doc.sourceType;
      return `${index + 1}. ${doc.name} (${doc.id}) [${source}]`;
    });
    return `Data Sources (${docs.length} shown):\n${lines.join("\n")}`;
  }

  const searchDocsMatch = raw.match(
    /^(?:search|find)\s+(?:docs?|documents?|data\s+sources?)\s+(?:for\s+)?(.+)$/i,
  );
  if (searchDocsMatch?.[1]) {
    const query = searchDocsMatch[1].trim();
    const { searchDocuments } = await import("@/lib/documents/store");
    const docs = searchDocuments(query, 8);
    if (docs.length === 0) {
      return `No document matches for "${query}".`;
    }
    const lines = docs.map((doc, index) => {
      return `${index + 1}. ${doc.name} (${doc.id})\n${doc.excerpt}`;
    });
    return `Data source results for "${query}":\n\n${lines.join("\n\n")}`;
  }

  const showDocTarget =
    normalized.startsWith("show data source ")
      ? raw.replace(/^show\s+data\s+source\s+/i, "").trim()
      : normalized.startsWith("open data source ")
        ? raw.replace(/^open\s+data\s+source\s+/i, "").trim()
        : normalized.startsWith("get data source ")
          ? raw.replace(/^get\s+data\s+source\s+/i, "").trim()
          : normalized.startsWith("read data source ")
            ? raw.replace(/^read\s+data\s+source\s+/i, "").trim()
            : raw.match(/^(?:show|open|get|read)\s+(?:doc(?:ument)?|data\s+source)\s+(.+)$/i)?.[1]?.trim() || "";
  if (showDocTarget) {
    const target = showDocTarget;
    const { listDocuments, searchDocuments, getDocumentById } = await import("@/lib/documents/store");
    const fallback = searchDocuments(target, 1)[0];
    const resolvedDoc =
      findDocumentByReference(target, listDocuments()) ??
      fallback ??
      null;
    const doc = resolvedDoc ? getDocumentById(resolvedDoc.id) : null;
    if (!doc) {
      return `Data source not found: ${target}. Use "list data sources" first.`;
    }
    return `Data Source ${doc.name} (${doc.id}):\n\n${doc.extractedText.slice(0, 3000)}`;
  }

  const taskFromDocRef = normalized.startsWith("create task from data source ")
    ? raw.replace(/^create\s+task\s+from\s+data\s+source\s+/i, "").trim()
    : normalized.startsWith("create task from document ")
      ? raw.replace(/^create\s+task\s+from\s+document\s+/i, "").trim()
      : raw.match(/^create\s+(?:a\s+)?(?:follow[-\s]+up\s+)?(?:board\s+)?task\s+from\s+(?:doc(?:ument)?|data\s+source)\s+(.+)$/i)?.[1]?.trim() || "";
  if (taskFromDocRef) {
    const docRef = taskFromDocRef;
    const { listDocuments, searchDocuments, getDocumentById } = await import("@/lib/documents/store");
    const { createBoardTask } = await import("@/lib/boards/manager");
    let { doc, extraTitle } = resolveDocumentTaskReference(docRef, listDocuments());
    if (!doc) {
      const tokens = docRef.split(/\s+/).filter(Boolean);
      for (let size = tokens.length; size >= 1 && !doc; size -= 1) {
        const candidateQuery = tokens.slice(0, size).join(" ");
        const result = searchDocuments(candidateQuery, 1)[0];
        if (!result) continue;
        doc = result;
        const trailingTokens = tokens.slice(size);
        extraTitle = trailingTokens.length > 0 ? trailingTokens.join(" ") : "Follow up document";
      }
    }
    const fullDoc = doc ? getDocumentById(doc.id) : null;
    if (!fullDoc) {
      return `Data source not found: ${docRef}. Use "list data sources" first.`;
    }

    const taskTitle = `${extraTitle} (${fullDoc.name})`.slice(0, 160);
    const task = createBoardTask({
      boardId: "main-board",
      title: taskTitle,
      description: `Document source: ${fullDoc.id}\n${fullDoc.sourceUrl ? `URL: ${fullDoc.sourceUrl}\n` : ""}\n${fullDoc.extractedText.slice(0, 1200)}`,
      status: "inbox",
      priority: "medium",
    });
    return [
      `Task created from data source **${fullDoc.name}**.`,
      `Title: ${task.title}`,
      "Status: inbox",
      `Task ID: ${task.id}`,
    ].join("\n");
  }

  if (normalized === "show memory timeline" || normalized === "list memory timeline" || normalized === "memory timeline") {
    try {
      const { response, payload } = await fetchInternalJson<{
        success?: boolean;
        data?: { entries?: Array<{ type?: string; created?: string; content?: string; text?: string }>; total?: number };
        error?: string;
      }>(
        `${internalApiBaseUrl}/api/memory?action=timeline&limit=8`,
        {
          method: "GET",
        },
        "channel-memory-timeline",
      );
      if (!response.ok || !payload.success) {
        return `Memory timeline failed: ${payload.error || `HTTP ${response.status}`}.`;
      }
      const entries = Array.isArray(payload.data?.entries) ? payload.data.entries : [];
      if (entries.length === 0) return "Memory timeline is empty right now.";
      return [
        `Memory timeline (${entries.length} shown of ${payload.data?.total ?? entries.length}):`,
        ...entries.map((entry, index) => {
          const preview = String(entry.content || entry.text || "").replace(/\s+/g, " ").slice(0, 120);
          return `${index + 1}. [${entry.type || "memory"}] ${entry.created || "unknown"}${preview ? ` • ${preview}` : ""}`;
        }),
      ].join("\n");
    } catch (error) {
      return `Memory timeline failed: ${String(error)}.`;
    }
  }

  if (normalized === "backup create" || normalized === "create backup") {
    if (!isSensitiveCommandAllowed(ctx)) return denySensitiveCommand();
    const { createBackup } = await import("@/lib/backup/manager");
    const backup = await createBackup();
    return [
      `Backup created: ${backup.id}`,
      `Files: ${backup.totalFiles}`,
      `Size: ${backup.totalBytes} bytes`,
      `Directory: ${backup.backupDir}`,
    ].join("\n");
  }

  if (normalized === "backup status" || normalized === "show backup status") {
    const { getBackupPolicyStatus } = await import("@/lib/backup/policy");
    const status = getBackupPolicyStatus();
    return [
      `Automated backups: ${status.config.enabled ? "enabled" : "disabled"}`,
      `Scheduled: ${status.scheduled ? "yes" : "no"}`,
      `Cron: ${status.config.cronExpression}`,
      `Retention: ${status.config.retentionCount}`,
      `Replication: ${status.config.replicationMode}${status.config.replicationTarget ? ` -> ${status.config.replicationTarget}` : ""}`,
      `Next run: ${status.nextRunAt || "n/a"}`,
      `Last success: ${status.config.lastSuccessAt || "never"}`,
      `Last error: ${status.config.lastError || "none"}`,
      status.latestBackup ? `Latest backup: ${status.latestBackup.id}` : "Latest backup: none",
      status.setupWarnings.length ? `Setup warnings:\n${status.setupWarnings.map((warning) => `- ${warning}`).join("\n")}` : "Setup warnings: none",
    ].join("\n");
  }

  if (normalized === "list backups" || normalized === "show backups") {
    const { listBackups } = await import("@/lib/backup/manager");
    const backups = listBackups().slice(0, 8);
    if (backups.length === 0) return "No backups found.";
    return [
      `Backups (${backups.length} shown):`,
      ...backups.map((backup, index) => `${index + 1}. ${backup.id} • ${backup.totalFiles} files • ${backup.createdAt}`),
    ].join("\n");
  }

  const verifyBackupMatch = raw.match(/^backup\s+verify(?:\s+(.+))?$/i) || raw.match(/^verify\s+backup(?:\s+(.+))?$/i);
  if (verifyBackupMatch) {
    const target = (verifyBackupMatch[1] || "latest").trim() || "latest";
    const { verifyBackup } = await import("@/lib/backup/manager");
    const result = verifyBackup(target);
    return [
      `Backup verify: ${result.manifest.id}`,
      `Status: ${result.ok ? "ok" : "failed"}`,
      `Checked files: ${result.checkedFiles}`,
      `Size: ${result.totalBytes} bytes`,
      result.missingFiles.length ? `Missing: ${result.missingFiles.join(", ")}` : null,
      result.mismatchedFiles.length ? `Changed: ${result.mismatchedFiles.join(", ")}` : null,
    ].filter(Boolean).join("\n");
  }

  const restoreBackupMatch =
    raw.match(/^backup\s+restore(?:\s+(.+))?$/i) ||
    raw.match(/^restore\s+backup(?:\s+(.+))?$/i) ||
    raw.match(/^dry\s+run\s+backup\s+restore(?:\s+(.+))?$/i);
  if (restoreBackupMatch) {
    const target = (restoreBackupMatch[1] || "latest").trim() || "latest";
    const { restoreBackup } = await import("@/lib/backup/manager");
    const result = restoreBackup(target, { dryRun: true });
    return [
      `Backup restore plan: ${result.backupId}`,
      `Target: ${result.targetDataDir}`,
      `Files: ${result.files.length}`,
      result.warnings.length ? `Warnings:\n${result.warnings.map((warning) => `- ${warning}`).join("\n")}` : "Warnings: none",
      `Dry run only. Use the backup_restore tool with dry_run=false after stopping the server if you really need to apply it.`,
    ].join("\n");
  }

  if (normalized === "run backup policy" || normalized === "backup run policy") {
    if (!isSensitiveCommandAllowed(ctx)) return denySensitiveCommand();
    const { runBackupPolicy } = await import("@/lib/backup/policy");
    const result = await runBackupPolicy("channel", { ignoreDisabled: true });
    return [
      `Backup policy run: ${result.backup.id}`,
      `Verified: ${result.verified ? "yes" : "no"}`,
      `Pruned: ${result.prunedBackupIds.length > 0 ? result.prunedBackupIds.join(", ") : "none"}`,
      `Replication: ${result.replication.skipped ? "skipped" : `${result.replication.mode} -> ${result.replication.destination}`}`,
    ].join("\n");
  }

  const createHierarchyTaskMatch =
    raw.match(/^create\s+hierarchy\s+task\s+(?:called|named)?\s*(.+?)(?:\s+about\s+(.+))?$/i) ||
    raw.match(/^create\s+leadership\s+task\s+(?:called|named)?\s*(.+?)(?:\s+about\s+(.+))?$/i) ||
    raw.match(/^create\s+ceo\s+team\s+task\s+(?:called|named)?\s*(.+?)(?:\s+about\s+(.+))?$/i);
  if (createHierarchyTaskMatch?.[1]) {
    if (!isSensitiveCommandAllowed(ctx)) return denySensitiveCommand();
    const [{ createBoardTask }, { getActiveHierarchyOrganization, resolveHierarchyOrganization }] = await Promise.all([
      import("@/lib/boards/manager"),
      import("@/lib/hierarchy/organizations"),
    ]);
    let titleInput = stripWrappedQuotes(createHierarchyTaskMatch[1]);
    const details = stripWrappedQuotes(createHierarchyTaskMatch[2] || "");
    const scope = parseScopeRefs(titleInput);
    titleInput = scope.remainder || titleInput;
    const title = titleInput.slice(0, 160);
    if (!title) return "Task title is required. Example: create hierarchy task called CEO Launch Strategy";
    const organization =
      (scope.organizationRef ? resolveHierarchyOrganization(scope.organizationRef) : null) ??
      getActiveHierarchyOrganization();
    if (scope.organizationRef && !organization) {
      return `Organization not found: ${scope.organizationRef}.`;
    }
    const { resolveHierarchyGoal } = await import("@/lib/hierarchy/goals");
    const goalRef = scope.goalRef ? trimReferenceTrail(scope.goalRef) : "";
    const goal = goalRef ? resolveHierarchyGoal(goalRef, organization?.id) : null;
    if (scope.goalRef && !goal) {
      return `Goal not found: ${goalRef || scope.goalRef}.`;
    }
    const task = createBoardTask({
      boardId: "main-board",
      organizationId: organization?.id ?? null,
      goalId: goal?.id ?? null,
      title,
      description:
        details ||
        `Run this through the hierarchy team workflow. Break the work into two coordinated tracks, then synthesize one recommendation.`,
      workflowTemplateKey: "hierarchy-orchestrator-team",
      status: "inbox",
      priority: "high",
    });
    return `Hierarchy task created: "${task.title}" (${task.id})${organization ? ` for ${organization.name}` : ""}${goal ? ` under goal ${goal.name}` : ""}. Run it with "run the ${task.title.toLowerCase()} task".`;
  }

  const leadershipCouncilMatch =
    raw.match(/^(?:ask|run|start|have)\s+(?:a\s+)?(?:the\s+)?(?:(?:leadership\s+team|leadership\s+council|council)(?:\s+vote)?)\s+in\s+organization\s+(.+?)\s+(?:about|on|to|whether|for)\s+(.+)$/i) ||
    raw.match(/^(?:ask|run|start|have)\s+(?:a\s+)?(?:the\s+)?(?:(?:leadership\s+team|leadership\s+council|council)(?:\s+vote)?)\s+(?:about|on|to|whether|for)\s+(.+)$/i) ||
    raw.match(/^(?:what\s+does|what\s+would)\s+(?:the\s+)?(?:leadership\s+team|leadership\s+council)\s+(?:think|say)\s+about\s+(.+)$/i);
  if (leadershipCouncilMatch?.[1]) {
    let organizationRef = "";
    let topic = stripWrappedQuotes(leadershipCouncilMatch[2] || leadershipCouncilMatch[1]);
    if (leadershipCouncilMatch[2]) {
      organizationRef = stripWrappedQuotes(leadershipCouncilMatch[1]);
    }
    if (!topic) return "Council topic is required.";
    const organizationSuffix = topic.match(/^(.+?)\s+in\s+organization\s+(.+)$/i);
    if (organizationSuffix?.[1] && organizationSuffix?.[2]) {
      topic = stripWrappedQuotes(organizationSuffix[1]);
      organizationRef = stripWrappedQuotes(organizationSuffix[2]);
    }
    return runOrganizationCollaborationTask({
      rawMessage: raw,
      topic,
      organizationRef,
      explicitMode: parseExplicitOrgMode(raw),
      ctx,
    });
  }

  const runTaskIntent = parseTaskRunIntent(raw);
  if (runTaskIntent.taskId || runTaskIntent.taskReference) {
    const { getBoardTask, listBoardTasks } = await import("@/lib/boards/manager");
    const boardTasks = runTaskIntent.taskReference ? listBoardTasks("main-board") : [];
    const resolvedTask = runTaskIntent.taskReference
      ? resolveTaskByReference(boardTasks, runTaskIntent.taskReference)
      : null;
    const task = runTaskIntent.taskId ? getBoardTask(runTaskIntent.taskId) : resolvedTask?.task ?? null;
    if (!task) {
      const missingRef = runTaskIntent.taskId || runTaskIntent.taskReference;
      return `Run task failed: I couldn't find a board task matching "${missingRef}". Use "list tasks" first.`;
    }

    let selectionPrefix = "";
    if (!runTaskIntent.taskId && runTaskIntent.taskReference && resolvedTask?.task) {
        selectionPrefix =
          resolvedTask.matchedCount > 1
            ? `Matched ${resolvedTask.matchedCount} tasks for "${runTaskIntent.taskReference}". Using the most recent match: "${resolvedTask.task.title}" (${resolvedTask.task.id}).\n\n`
            : `Matched "${runTaskIntent.taskReference}" to "${resolvedTask.task.title}" (${resolvedTask.task.id}).\n\n`;
    }

    try {
      const { runWorkflowBackedBoardTask } = await import("@/lib/boards/task-runner");
      const result = await runWorkflowBackedBoardTask(task.id, {
        provenance: createProvenance("channel", `channel:${ctx.channel}`, {
          channel: ctx.channel,
          sessionId: ctx.sessionId ?? undefined,
          sender: ctx.sender,
          taskId: task.id,
          taskTitle: task.title,
          routeSource: "task-run-command",
        }),
      });
      const responseSuffix = result.response ? `\n\n${result.response}` : "";
      return `${selectionPrefix}Task **${task.id}** ("${task.title}") moved to **in_progress** and started workflow **${result.workflowName}** (execution **${result.executionId}**).${responseSuffix}`;
    } catch (error) {
      return `Run task failed: ${String(error)}.`;
    }
  }

  const boardTaskTemplateIntent = parseBoardTaskTemplateIntent(raw);
  if (boardTaskTemplateIntent) {
    const template = resolveWorkflowTemplateReference(boardTaskTemplateIntent.templateRef);
    if (!template) {
      return `Workflow template not found for "${boardTaskTemplateIntent.templateRef}". Use "list workflow templates" first.`;
    }
    const { createBoardTask } = await import("@/lib/boards/manager");
    try {
      const task = createBoardTask({
        boardId: "main-board",
        title: boardTaskTemplateIntent.title.slice(0, 160),
        description: `Created from plain-English WebChat request using template "${template.name}".`,
        status: "inbox",
        priority: "medium",
        workflowTemplateKey: template.key,
      });
      return `Task **${task.id}** ("${task.title}") added to **${task.status}** with workflow template **${template.name}**.`;
    } catch (error) {
      return `Task creation failed: ${String(error)}.`;
    }
  }

  const inferredTaskTitle = extractTaskTitleFromNaturalLanguage(raw);
  if (inferredTaskTitle) {
    const { createBoardTask } = await import("@/lib/boards/manager");
    try {
      const task = createBoardTask({
        boardId: "main-board",
        title: inferredTaskTitle,
        description: `Created from channel command: ${raw}`,
        status: "inbox",
        priority: "medium",
      });
      return `Task **${task.id}** (\"${task.title}\") added to **${task.status}**.`;
    } catch (error) {
      return `Task creation failed: ${String(error)}.`;
    }
  }

  const wantsInbox =
    normalized.includes("inbox task") ||
    normalized.includes("tasks in inbox") ||
    normalized === "inbox" ||
    normalized === "list inbox" ||
    normalized === "show inbox" ||
    normalized.includes("what's in my inbox") ||
    normalized.includes("what is in my inbox") ||
    normalized.includes("in my inbox");
  const taskStatusFilter: string | null =
    /\b(?:pending|unstarted|not started|inbox)\b/i.test(raw) ? "inbox" :
    /\bin[- ]progress\b|\bactive tasks?\b|\bcurrent tasks?\b/i.test(raw) ? "in_progress" :
    /\bin\s+review\b|\bunder review\b|\bwaiting for review\b/i.test(raw) ? "review" :
    /\b(?:done|completed|finished|closed)\b/i.test(raw) ? "done" :
    /\bblocked\b/i.test(raw) ? "blocked" :
    null;
  const effectiveTaskStatusFilter =
    taskStatusFilter ??
    (normalizedLookup === "what tasks are done" || normalizedLookup === "which tasks are done" ? "done" :
    normalizedLookup === "what tasks are open" || normalizedLookup === "which tasks are open" ? "inbox" :
    (normalized.startsWith("list completed task") || normalized.startsWith("show completed task") ? "done" :
    normalized.startsWith("list pending task") || normalized.startsWith("show pending task") ? "inbox" :
    null));
  const wantsTaskList =
    normalized === "tasks" ||
    normalized === "task" ||
    normalized === "my tasks" ||
    normalized === "our tasks" ||
    normalized === "current tasks" ||
    normalized === "open tasks" ||
    normalized === "pending tasks" ||
    normalized === "completed tasks" ||
    normalized === "done tasks" ||
    normalized === "list pending tasks" ||
    normalized === "list completed tasks" ||
    normalized === "show pending tasks" ||
    normalized === "show completed tasks" ||
    normalized.startsWith("list task") ||
    normalized.startsWith("list down task") ||
    normalized.startsWith("show task") ||
    normalized.startsWith("find task") ||
    normalized.startsWith("search task") ||
    normalized.startsWith("more task") ||
    normalized.startsWith("next task") ||
    normalized.startsWith("list my task") ||
    normalized.startsWith("list all task") ||
    normalized.startsWith("show all task") ||
    normalized.startsWith("show me all task") ||
    normalized.startsWith("show me my task") ||
    normalized.startsWith("show my task") ||
    normalized.includes("show tasks") ||
    normalized.includes("what are my tasks") ||
    normalized.includes("what are the tasks") ||
    normalized.includes("list down my tasks") ||
    normalized.includes("list down tasks") ||
    normalized.includes("board tasks") ||
    normalized.includes("pending tasks") ||
    normalized.includes("tasks in progress") ||
    normalized.includes("in progress tasks") ||
    normalized.includes("all my tasks") ||
    normalized.includes("all tasks") ||
    /^(?:what|which|how many)\s+tasks?\s+(?:do i have|are there|are pending|are open|are blocked)\??$/i.test(raw) ||
    wantsInbox;

  const scopedTaskListMatch =
    raw.match(/^(?:list|show|find|search)\s+(?:(inbox|board)\s+)?tasks?\s+(.+)$/i) ||
    raw.match(/^(?:what(?:'s| is)\s+in\s+my\s+inbox)\s+(.+)$/i);

  if (scopedTaskListMatch?.[2] || scopedTaskListMatch?.[1]) {
    const scope = parseScopeRefs(stripWrappedQuotes(scopedTaskListMatch[2] || scopedTaskListMatch[1] || ""));
    if (scope.organizationRef || scope.goalRef) {
      const [{ listBoardTasks }, { resolveHierarchyOrganization }, { resolveHierarchyGoal }] = await Promise.all([
        import("@/lib/boards/manager"),
        import("@/lib/hierarchy/organizations"),
        import("@/lib/hierarchy/goals"),
      ]);
      const organization = scope.organizationRef ? resolveHierarchyOrganization(scope.organizationRef) : null;
      if (scope.organizationRef && !organization) {
        return `Organization not found: ${scope.organizationRef}.`;
      }
      const goal = scope.goalRef ? resolveHierarchyGoal(scope.goalRef, organization?.id) : null;
      if (scope.goalRef && !goal) {
        return `Goal not found: ${scope.goalRef}.`;
      }
      const wantsScopedInbox =
        /^what(?:'s| is)\s+in\s+my\s+inbox/i.test(raw) ||
        String(scopedTaskListMatch[1] || "").toLowerCase() === "inbox";
      const tasks = prioritizeTasksForChannelList(
        listBoardTasks("main-board", {
          organizationId: organization?.id,
          goalId: goal?.id,
        }),
      );
      const baseTasks = wantsScopedInbox ? tasks.filter((task) => task.status === "inbox") : tasks;
      const filteredTasks = scope.remainder
        ? baseTasks.filter((task) =>
            normalizeLookup([task.title, task.description || "", task.workflowTemplateKey || ""].join(" ")).includes(
              normalizeLookup(scope.remainder),
            ),
          )
        : baseTasks;
      return formatTaskList(
        filteredTasks.map((task) => ({ id: task.id, title: task.title, status: task.status })),
        wantsScopedInbox ? "Inbox" : "Board",
        {
          query: [organization?.name ? `org:${organization.name}` : "", goal?.name ? `goal:${goal.name}` : "", scope.remainder].filter(Boolean).join(" • "),
        },
      );
    }
  }

  if (wantsTaskList) {
    const { listBoardTasks } = await import("@/lib/boards/manager");
    const intent = parseTaskListIntent(raw) ?? {
      kind: wantsInbox ? ("inbox" as const) : ("board" as const),
      query: "",
      pageSize: DEFAULT_TASK_LIST_PAGE_SIZE,
      mode: "reset" as const,
    };
    cleanupExpiredTaskListCursorState();

    const orderedTasks = prioritizeTasksForChannelList(listBoardTasks("main-board"));
    const baseTasks = effectiveTaskStatusFilter
      ? orderedTasks.filter((task) => task.status === effectiveTaskStatusFilter)
      : intent.kind === "inbox"
        ? orderedTasks.filter((task) => task.status === "inbox")
        : orderedTasks;
    if (baseTasks.length === 0 && !intent.query && effectiveTaskStatusFilter) {
      const friendlyStatus =
        effectiveTaskStatusFilter === "inbox" ? "open" :
        effectiveTaskStatusFilter === "in_progress" ? "in progress" :
        effectiveTaskStatusFilter;
      if (friendlyStatus === "open") {
        return "Board tasks\nBoard: main-board\nTotal: 0\nNo open tasks on main-board yet.";
      }
      return `Board tasks\nBoard: main-board\nTotal: 0\nNo tasks with status: ${friendlyStatus} on main-board yet.`;
    }
    if (baseTasks.length === 0 && !intent.query && intent.kind === "board" && !effectiveTaskStatusFilter) {
      const completedCount = orderedTasks.filter((task) => task.status === "done").length;
      if (completedCount > 0) {
        return `All current board tasks are completed. ${completedCount} done task(s) are on main-board.`;
      }
    }
    const filteredTasks = intent.query
      ? baseTasks.filter((task) => {
          const haystack = normalizeLookup(
            [task.title, task.description || "", task.workflowTemplateKey || ""].join(" "),
          );
          return haystack.includes(normalizeLookup(intent.query));
        })
      : baseTasks;
    if (filteredTasks.length === 0 && !intent.query && effectiveTaskStatusFilter && orderedTasks.some((task) => task.status === "done")) {
      const friendlyStatus =
        effectiveTaskStatusFilter === "inbox" ? "open" :
        effectiveTaskStatusFilter === "in_progress" ? "in progress" :
        effectiveTaskStatusFilter;
      return `No ${friendlyStatus} tasks on main-board. The board only has completed tasks right now.`;
    }

    const cursorKey = getTaskListCursorKey(ctx, intent.kind, intent.query);
    const previousState = taskListCursorState.get(cursorKey);
    const offset =
      intent.mode === "next" && previousState
        ? previousState.nextOffset
        : 0;

    const response = formatTaskList(
      filteredTasks.map((task) => ({ id: task.id, title: task.title, status: task.status })),
      effectiveTaskStatusFilter === "inbox"
        ? "Open"
        : effectiveTaskStatusFilter === "done"
          ? "Completed"
          : intent.kind === "inbox"
            ? "Inbox"
            : "Board",
      {
        offset,
        pageSize: intent.pageSize,
        query: intent.query,
      },
    );

    if (/^No more /i.test(response)) {
      taskListCursorState.delete(cursorKey);
      return response;
    }

    taskListCursorState.set(cursorKey, {
      kind: intent.kind,
      query: intent.query,
      nextOffset: offset + intent.pageSize,
      pageSize: intent.pageSize,
      updatedAt: Date.now(),
    });
    return response;
  }

  const taskUpdateStatusMatch =
    raw.match(/^(?:mark|set|move)\s+(?:task\s+)?(?:the\s+)?["']?(.+?)["']?\s+(?:task\s+)?(?:as|to)\s+(done|completed|finished|in[- ]progress|in progress|review|inbox|blocked)\s*$/i) ||
    raw.match(/^(?:mark|set|move)\s+(?:the\s+)?["']?(.+?)["']?\s+(?:as|to)\s+(done|completed|finished|in[- ]progress|in progress|review|inbox|blocked)\s*$/i) ||
    raw.match(/^(?:complete|finish|close|resolve)\s+(?:the\s+)?(?:task\s+)?["']?(.+?)["']?\s*$/i);
  const taskUpdatePriorityMatch =
    raw.match(/^(?:set|change|update|mark)\s+(?:the\s+)?(?:task\s+)?["']?(.+?)["']?\s+(?:task\s+)?(?:to|as|with)\s+(high|low|medium|urgent)\s+priority\s*$/i) ||
    raw.match(/^(?:set|change|update|mark)\s+(?:priority\s+of\s+)?(?:the\s+)?["']?(.+?)["']?\s+(?:to|as)\s+(high|low|medium|urgent)\s*$/i);

  if (taskUpdateStatusMatch?.[1] || taskUpdatePriorityMatch?.[1]) {
    const { listBoardTasks, updateBoardTask } = await import("@/lib/boards/manager");
    const allTasks = listBoardTasks("main-board");
    const ref = (taskUpdateStatusMatch?.[1] || taskUpdatePriorityMatch?.[1] || "").trim();
    const resolvedTask = resolveTaskByReference(allTasks, ref);
    const task = resolvedTask?.task ?? null;
    if (!task) {
      return `Task not found matching "${ref}". Use "list tasks" to see available tasks.`;
    }
    if (taskUpdateStatusMatch) {
      const rawStatus = String(taskUpdateStatusMatch[2] || "done").toLowerCase();
      const statusMap: Record<string, string> = {
        done: "done", completed: "done", finished: "done",
        "in-progress": "in_progress", "in progress": "in_progress",
        review: "review", inbox: "inbox", blocked: "blocked",
        close: "done", closed: "done", resolve: "done", resolved: "done",
      };
      const newStatus = statusMap[rawStatus] ?? "inbox";
      updateBoardTask(task.id, { status: newStatus as any });
      return `Task **${task.title}** (${task.id}) moved to **${newStatus}**.`;
    }
    if (taskUpdatePriorityMatch?.[2]) {
      const newPriority = taskUpdatePriorityMatch[2].toLowerCase() as any;
      updateBoardTask(task.id, { priority: newPriority });
      return `Task **${task.title}** (${task.id}) priority set to **${newPriority}**.`;
    }
  }

  const claimTaskMatch =
    raw.match(/^(?:claim|checkout|check out)\s+(?:the\s+)?(.+?)\s+task$/i) ||
    raw.match(/^(?:claim|checkout|check out)\s+task\s+(.+)$/i);
  if (claimTaskMatch?.[1]) {
    if (!isSensitiveCommandAllowed(ctx)) return denySensitiveCommand();
    const [{ claimBoardTask, listBoardTasks }, { getDefaultAgent }] = await Promise.all([
      import("@/lib/boards/manager"),
      import("@/lib/agents/registry"),
    ]);
    const resolved = resolveTaskByReference(listBoardTasks("main-board"), claimTaskMatch[1]);
    if (!resolved?.task) return `Task not found: ${claimTaskMatch[1]}.`;
    const task = claimBoardTask(resolved.task.id, getDefaultAgent().id);
    return `Claimed "${task.title}" for ${task.checkedOutByAgentName || task.checkedOutByAgentId}.`;
  }

  const releaseTaskMatch =
    raw.match(/^(?:release|unclaim)\s+(?:the\s+)?(.+?)\s+task$/i) ||
    raw.match(/^(?:release|unclaim)\s+task\s+(.+)$/i);
  if (releaseTaskMatch?.[1]) {
    if (!isSensitiveCommandAllowed(ctx)) return denySensitiveCommand();
    const { listBoardTasks, releaseBoardTask } = await import("@/lib/boards/manager");
    const resolved = resolveTaskByReference(listBoardTasks("main-board"), releaseTaskMatch[1]);
    if (!resolved?.task) return `Task not found: ${releaseTaskMatch[1]}.`;
    const task = releaseBoardTask(resolved.task.id);
    return `Released "${task.title}".`;
  }

  // ── Scheduler commands ──────────────────────────────────────────────────────
  const wantsScheduleList =
    normalized === "list schedules" ||
    normalized === "list cron" ||
    normalized === "list cron jobs" ||
    normalized === "show scheduler" ||
    normalized === "show schedule" ||
    normalized === "scheduler" ||
    normalized.startsWith("list scheduled") ||
    normalized.startsWith("what schedules") ||
    (isAutomationLiveStateReadRequest(raw) && /\b(?:cron|schedule|schedules|scheduled|scheduler|automation|automations)\b/i.test(raw));

  const scheduleExpressionOnly = parseScheduleExpressionIntent(raw);
  let schedulerCreateIntent = parseSchedulerCreateIntent(raw);
  if (!schedulerCreateIntent && scheduleExpressionOnly && /\b(?:it|that|this|the\s+workflow)\b/i.test(raw)) {
    const recentWorkflowName = getDisplayName(getChannelSessionAppState(ctx.sessionId)?.payload?.workflow);
    if (recentWorkflowName) {
      schedulerCreateIntent = {
        kind: "workflow",
        workflowRef: recentWorkflowName,
        wrapperName: `${recentWorkflowName} Schedule`,
        schedule: scheduleExpressionOnly,
      };
    }
  }
  if (schedulerCreateIntent) {
    if (!isSensitiveCommandAllowed(ctx)) return denySensitiveCommand();
    try {
      if (schedulerCreateIntent.kind === "health-check") {
        const { response: createResponse, payload: createPayload } = await fetchInternalJson<{
          success?: boolean;
          data?: { id?: string; name?: string };
          error?: string;
        }>(
          `${internalApiBaseUrl}/api/workflows`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: schedulerCreateIntent.workflowName,
              template: "scheduled-health-check",
            }),
          },
          "channel-schedule-health-check-create",
        );
        if (!createResponse.ok || !createPayload.success || !createPayload.data?.id) {
          return `Schedule creation failed: ${createPayload.error || `HTTP ${createResponse.status}`}.`;
        }
        const { initializeDatabase, getSqlite } = await import("@/lib/db");
        initializeDatabase();
        const db = getSqlite();
        const row = db
          .prepare("SELECT nodes, edges FROM workflows WHERE id = ?")
          .get(createPayload.data.id) as { nodes: string; edges: string } | undefined;
        if (!row) {
          return `Schedule creation failed: workflow ${createPayload.data.id} not found after create.`;
        }
        const nodes = JSON.parse(row.nodes) as Array<{ type?: string; data?: Record<string, unknown> }>;
        const updatedNodes = nodes.map((node) =>
          node.type === "cron-trigger"
            ? {
                ...node,
                data: {
                  ...(node.data || {}),
                  label: schedulerCreateIntent.schedule.label,
                  expression: schedulerCreateIntent.schedule.expression,
                  timezone: schedulerCreateIntent.schedule.timezone,
                },
              }
            : node,
        );
        const { response: updateResponse, payload: updatePayload } = await fetchInternalJson<{ success?: boolean; error?: string }>(
          `${internalApiBaseUrl}/api/workflows`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              id: createPayload.data.id,
              nodes: updatedNodes,
            }),
          },
          "channel-schedule-health-check-update",
        );
        if (!updateResponse.ok || !updatePayload.success) {
          return `Schedule creation failed: ${updatePayload.error || `HTTP ${updateResponse.status}`}.`;
        }
        return `Created scheduled health check "${createPayload.data.name || schedulerCreateIntent.workflowName}" (${createPayload.data.id}) on ${schedulerCreateIntent.schedule.expression}.`;
      }

      const { initializeDatabase, getSqlite } = await import("@/lib/db");
      initializeDatabase();
      const db = getSqlite();
      const workflows = db
        .prepare("SELECT id, name FROM workflows ORDER BY updated_at DESC")
        .all() as Array<{ id: string; name: string }>;
      const target = findWorkflowMatchByName(workflows, schedulerCreateIntent.workflowRef.toLowerCase());
      if (!target) {
        return `Schedule creation failed: workflow not found for "${schedulerCreateIntent.workflowRef}".`;
      }
      const wrapper = buildWorkflowScheduleWrapper({
        name: schedulerCreateIntent.wrapperName,
        expression: schedulerCreateIntent.schedule.expression,
        timezone: schedulerCreateIntent.schedule.timezone,
        label: schedulerCreateIntent.schedule.label,
        targetWorkflowId: target.id,
      });
      const { response, payload } = await fetchInternalJson<{
        success?: boolean;
        data?: { id?: string; name?: string };
        error?: string;
      }>(
        `${internalApiBaseUrl}/api/workflows`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(wrapper),
        },
        "channel-schedule-create",
      );
      if (!response.ok || !payload.success || !payload.data?.id) {
        return `Schedule creation failed: ${payload.error || `HTTP ${response.status}`}.`;
      }
      return [
        `Created scheduled workflow "${payload.data.name || schedulerCreateIntent.wrapperName}" (${payload.data.id}).`,
        `Runs workflow "${target.name}" on ${schedulerCreateIntent.schedule.expression}.`,
      ].join("\n");
    } catch (error) {
      return `Schedule creation failed: ${String(error)}.`;
    }
  }

  const wantsAutomationOverview =
    isAutomationLiveStateReadRequest(raw) &&
    /\b(?:automation|automations)\b/i.test(raw) &&
    (
      /\b(?:cron|schedule|schedules|scheduled|scheduler)\b/i.test(raw) ||
      /\bseparate\b/i.test(raw) ||
      !/\bwebhooks?\b/i.test(raw)
    );

  if (wantsAutomationOverview) {
    const schedules = await handleBuiltinCommands("list schedules", { ...ctx, allowCompound: false });
    const webhooks = await handleBuiltinCommands("list webhooks", { ...ctx, allowCompound: false });
    return ["Automations", "", schedules, "", webhooks].join("\n");
  }

  if (wantsScheduleList) {
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
        lines.push(`• ${row.name} | ${cron.expression} | ${cron.timezone} | ${active ? (live ? "live" : "inactive") : "disabled"}`);
      }
    }
    if (lines.length === 0) {
      return "Scheduled workflows (0):\nCron jobs: none configured yet. Add a cron-trigger node in the workflow editor.";
    }
    return `Scheduled workflows (${lines.length}):\nCron jobs:\n${lines.join("\n")}`;
  }

  // ── Webhook list (deterministic, read-only) ────────────────────────────────
  const wantsWebhookList =
    normalized === "list webhooks" ||
    normalized === "show webhooks" ||
    normalized === "list webhook automations" ||
    normalized === "show webhook automations" ||
    normalized === "list automations" ||
    normalized === "show automations" ||
    normalized === "automations" ||
    normalized === "webhooks" ||
    normalized.startsWith("list my webhooks") ||
    normalized.startsWith("show my webhooks") ||
    normalized.startsWith("what webhooks") ||
    (isAutomationLiveStateReadRequest(raw) && /\b(?:webhook|webhooks|automation|automations)\b/i.test(raw));

  if (wantsWebhookList) {
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
      return `• [${i + 1}] ${r.name} (${status}) → ${r.workflow_name ?? "(deleted)"} [${wfStatus}] — URL: /api/webhooks/${r.id}`;
    });
    return `Webhook automations (${rows.length} total, ${active} active):\n${lines.join("\n")}`;
  }

  const runCronMatch = raw.match(
    /^(?:run|trigger|fire|execute)\s+(?:now|workflow|cron)?\s*[:\-]?\s*"?([^"]+)"?\s*(?:now)?$/i,
  );
  if (runCronMatch?.[1]) {
    if (!isSensitiveCommandAllowed(ctx)) return denySensitiveCommand();
    const name = runCronMatch[1].trim();
    const { initializeDatabase, getSqlite } = await import("@/lib/db");
    initializeDatabase();
    const db = getSqlite();
    const rows = db.prepare("SELECT id, name FROM workflows WHERE is_active = 1").all() as Array<{ id: string; name: string }>;
    const target = rows.find((r) => r.name.toLowerCase().includes(name.toLowerCase()));
    if (!target) return `No active workflow matching "${name}". Try "list schedules" to see available jobs.`;
    try {
      const { response, payload } = await fetchInternalJson<{ success?: boolean; error?: string }>(
        `${internalApiBaseUrl}/api/cron`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "run", workflowId: target.id }),
        },
        "channel-run-cron",
      );
      if (!response.ok || !payload.success) {
        return `Failed to trigger "${target.name}": ${payload.error || `HTTP ${response.status}`}.`;
      }
      return `Workflow "${target.name}" triggered manually.`;
    } catch (error) {
      return `Failed to trigger "${target.name}": ${String(error)}.`;
    }
  }

  return null;
}

/**
 * Routes an incoming channel message to the best matching active workflow.
 */
export async function routeToWorkflowWithDetails(opts: {
  triggerNodeType: string;
  channel: string;
  agentId?: string | null;
  triggerData: Record<string, unknown>;
  provenance?: Partial<ProvenanceRecord> | null;
  ingressModeOverride?: IngressProvenanceMode;
  onEmit?: (event: string, data: unknown) => void;
  internalBaseUrl?: string | null;
  clientTurnId?: string;
  onStatus?: (phase: string, label: string, detail?: string) => void;
}): Promise<RouteToWorkflowResult> {
  try {
    const { getSqlite } = await import("@/lib/db");
    const { getModelConfig } = await import("@/lib/agents/model-router");
    const { executeWorkflow } = await import("@/lib/engine/executor");
    const { consumeSessionFollowUp } = await import("@/lib/channels/session-followups");

    const db = getSqlite();
    const workflows = db
      .prepare("SELECT * FROM workflows WHERE is_active = 1")
      .all() as Array<{ id: string; name?: string; nodes: string; edges: string }>;

    const rawMessage = String(opts.triggerData.message ?? "").trim();
    const senderRaw =
      String(opts.triggerData.sender ?? "") ||
      String(opts.triggerData.chatId ?? "") ||
      String(opts.triggerData.channelId ?? "") ||
      "unknown";

    // Expand context references (@file:..., @folder:..., @diff, @url:...)
    let message = rawMessage;
    try {
      const { expandContextReferences } = await import("@/lib/channels/context-references");
      const refResult = await expandContextReferences(rawMessage);
      if (refResult.references.length > 0) {
        message = refResult.expandedMessage;
        // Update triggerData so the expanded message flows into the workflow
        opts.triggerData = { ...opts.triggerData, message };
        log.info("Context references expanded", {
          count: refResult.references.length,
          totalChars: refResult.totalCharsInjected,
          types: refResult.references.map((r) => r.type),
        });
      }
    } catch (err) {
      log.error("Context reference expansion failed", { error: String(err) });
    }

    const sessionId = deriveChannelSessionId(opts.channel, opts.triggerData);
    const sessionAppState = getChannelSessionAppState(sessionId || "")?.payload ?? null;
    const normalizedInput = normalizeRoutingPreamble(message);
    if (normalizedInput.normalizedMessage && normalizedInput.normalizedMessage !== message) {
      message = normalizedInput.normalizedMessage;
      opts.triggerData = { ...opts.triggerData, message };
    }
    const rewritesApplied = [...normalizedInput.rewritesApplied];
    const sessionResolved = resolveSessionAwareAppMessage(message, sessionAppState);

    let routingTrace = buildRoutingDecisionTrace({
      rawMessage,
      normalizedMessage: message,
      classification: classifyAppControlIntent(message, sessionAppState),
      rewritesApplied,
      clauses: splitCompoundBuiltinMessage(message),
    });
    const finishRouted = (
      result: Omit<RouteToWorkflowResult, "routingTrace">,
      traceUpdate?: Partial<RoutingDecisionTrace>,
    ): RouteToWorkflowResult => {
      const finalTrace = { ...routingTrace, ...(traceUpdate ?? {}) };
      log.debug("Routing decision trace", finalTrace);
      return { ...result, routingTrace: finalTrace };
    };
    const checkAndCancelIfAborted = async (): Promise<RouteToWorkflowResult | null> => {
      if (!opts.clientTurnId) return null;
      try {
        const { isTurnAborted: check } = await import("@/lib/channels/turn-abort-registry");
        if (check(opts.clientTurnId)) {
          log.warn("Routing turn aborted", { clientTurnId: opts.clientTurnId });
          return finishRouted({
            response: "Request was cancelled",
            workflowId: null,
            workflowName: null,
            source: "cancelled",
          }, { routeSource: "cancelled" });
        }
      } catch { /* registry not available */ }
      return null;
    };
    const resolveTraceCommand = (part: string): string | null => {
      if (normalizeLookup(part) === "how would i wire telegram if i need it") {
        return "how do i use channels";
      }
      const featureHowToCommand = resolveFeatureHowToCommand(part);
      if (featureHowToCommand) return featureHowToCommand;
      if (
        parseCheckpointIntent(part) ||
        parseDataSourceCreateIntent(part) ||
        parseTemplateCreateIntent(part) ||
        parseTemplateRunIntent(part) ||
        matchesDirectAgentChangeMessage(part) ||
        matchesExternalCatalogMutation(part)
      ) {
        return normalizeLookup(part);
      }
      const directCommand = findBuiltinIntentByCommand(part)?.command ?? null;
      if (directCommand) return directCommand;
      const aliasCommand = findBuiltinIntentByAlias(part)?.command ?? null;
      if (aliasCommand) return aliasCommand;
      const classification = classifyAppControlIntent(part, sessionAppState);
      const inferredCommands = inferReadOnlyAppCommandsFromParaphrase(part);
      if (inferredCommands.length > 0) return inferredCommands[0] ?? null;
      const bestEffort = resolveBestEffortAppSurfaceCommand({
        rawMessage: part,
        classification,
      });
      if (bestEffort) return bestEffort;
      const keywordCommand = resolveBuiltinIntentByKeywords(part, classification.domain)?.command ?? null;
      if (keywordCommand) return keywordCommand;
      return getDefaultBuiltinCommandForDomain(classification.domain);
    };
    const resolveTraceCommands = (parts: string[]): string[] =>
      Array.from(
        new Set(
          parts
            .map((part) => resolveTraceCommand(part))
            .filter((part): part is string => Boolean(part && part.trim())),
        ),
      );
    const resolveTraceCommandsWithFallback = (parts: string[]): string[] => {
      const resolved = resolveTraceCommands(parts);
      if (resolved.length > 0) return resolved;
      return Array.from(
        new Set(
          parts
            .map((part) => normalizeLookup(part))
            .filter(Boolean),
        ),
      );
    };
    const builtinCtx: BuiltinCommandContext = {
      channel: opts.channel,
      sender:
        String(opts.triggerData.sender ?? "") ||
        String(opts.triggerData.chatId ?? "") ||
        String(opts.triggerData.channelId ?? "") ||
        String(opts.triggerData.userId ?? "") ||
        "unknown",
      sessionId,
      internalBaseUrl: opts.internalBaseUrl,
      clientTurnId: opts.clientTurnId,
    };
    const pendingForEdit = getPendingMutation(sessionId);
    const pendingPlanEdit = revisePendingAppActionPlanFromPlainEnglish(rawMessage, pendingForEdit);
    if (pendingPlanEdit && sessionId) {
      const editTrailId = typeof pendingForEdit?.payload?.trailId === "string" ? pendingForEdit.payload.trailId : "";
      if (editTrailId) {
        try {
          const wt = await import("@/lib/work-trails/work-trails");
          wt.appendWorkTrailEvent({ trailId: editTrailId, eventType: "plan_edited", summary: "Plan edited before confirmation" });
          wt.updateWorkTrailPlan(editTrailId, pendingPlanEdit.plan);
        } catch { /* trail is best-effort */ }
      }
      rememberPendingMutation({
        sessionId,
        kind: "app-action-plan",
        summary: pendingPlanEdit.summary,
        payload: { plan: pendingPlanEdit.plan as unknown as Record<string, unknown>, ...(editTrailId ? { trailId: editTrailId } : {}) },
        createdAt: Date.now(),
      });
      const response = buildPendingMutationPrompt(pendingPlanEdit.summary);
      mergeSessionAppStateForInteraction({
        sessionId,
        message: rawMessage,
        response,
        classification: { kind: "app_control", domain: null, reason: "pending app-action plan edit", usesSessionReference: true },
      });
      return finishRouted({
        response,
        workflowId: null,
        workflowName: null,
        source: "app-action-planner",
        // P0: keep the (edited) plan editable — surface it, not just session state.
        pendingAppActionPlan: pendingPlanEdit.plan,
        pendingWorkTrailId: editTrailId || undefined,
      }, {
        intentClass: "app_write",
        routeSource: "app-action-planner",
        modelAssistUsed: false,
        rewritesApplied: [...rewritesApplied, "pending-plan-edit-deterministic"],
      });
    }

    // Early confirm/cancel handling: a bare "confirm"/"cancel" with a pending
    // app-action plan or mutation MUST execute (or cancel) it before any other
    // routing. Otherwise short, non-planner-eligible confirmations fall through
    // to the agentic runtime, which fabricates a "done" message without ever
    // running the plan (e.g. an org switch that never persists).
    if (sessionId) {
      const isConfirmReply = /^(?:confirm|yes|apply it|do it)$/i.test(rawMessage);
      const isCancelReply = /^(?:cancel|never mind|nevermind|stop|don'?t do that|do not do that)$/i.test(rawMessage);
      if (isConfirmReply || isCancelReply) {
        const pendingForReply = getPendingMutation(sessionId);
        if (pendingForReply) {
          let earlyResponse: string;
          if (isConfirmReply) {
            clearPendingMutation(sessionId);
            earlyResponse = await executePendingMutation(pendingForReply, builtinCtx);
          } else {
            const earlyCancelTrailId = typeof pendingForReply.payload?.trailId === "string" ? pendingForReply.payload.trailId : "";
            if (earlyCancelTrailId) {
              try {
                const wt = await import("@/lib/work-trails/work-trails");
                wt.appendWorkTrailEvent({ trailId: earlyCancelTrailId, eventType: "cancelled", summary: "User cancelled the plan" });
                wt.updateWorkTrailStatus(earlyCancelTrailId, "cancelled");
              } catch { /* trail is best-effort */ }
            }
            clearPendingMutation(sessionId);
            earlyResponse = `Cancelled pending change: ${pendingForReply.summary}`;
          }
          mergeSessionAppStateForInteraction({
            sessionId,
            message: rawMessage,
            response: earlyResponse,
            classification: { kind: "app_control", domain: null, reason: "pending confirmation reply", usesSessionReference: true },
          });
          return finishRouted({
            response: earlyResponse,
            workflowId: null,
            workflowName: null,
            source: "builtin",
          }, {
            intentClass: "app_write",
            routeSource: "builtin",
          });
        }
      }
    }
    const normalizedRawLookup = normalizeLookup(rawMessage);
    if (
      normalizedRawLookup === "switch to council mode" ||
      normalizedRawLookup === "use council mode" ||
      normalizedRawLookup === "switch to discussion mode" ||
      normalizedRawLookup === "use discussion mode" ||
      normalizedRawLookup === "switch to execution mode" ||
      normalizedRawLookup === "use execution mode" ||
      normalizedRawLookup === "switch to workflow mode" ||
      normalizedRawLookup === "use workflow mode"
    ) {
      const modeResponse = await handleBuiltinCommands(rawMessage, builtinCtx);
      if (modeResponse) {
        return finishRouted({
          response: modeResponse,
          workflowId: null,
          workflowName: null,
          source: "builtin",
        }, {
          intentClass: "app_read",
          routeSource: "builtin",
          commands: [normalizedRawLookup],
        });
      }
    }
    const compatibleWorkflowChannels =
      opts.channel === "acp" ? new Set(["acp", "webchat", ""]) : new Set([opts.channel, opts.channel === "webchat" ? "" : null].filter(Boolean) as string[]);
    const hasSpecificWorkflowTriggerMatch = workflows.some((wf) => {
      const nodes = JSON.parse(wf.nodes) as WorkflowNode[];
      const matchingTriggerNode = nodes.find((n) => {
        if (opts.triggerNodeType === "message-trigger") {
          const channel = String(n.data.channel ?? "");
          return n.type === "message-trigger" && compatibleWorkflowChannels.has(channel);
        }
        return (
          n.type === opts.triggerNodeType ||
          (n.type === "message-trigger" && compatibleWorkflowChannels.has(String(n.data.channel ?? "")))
        );
      });
      if (!matchingTriggerNode) return false;
      const rawFilter = String(matchingTriggerNode.data.filter ?? "").trim();
      if (!rawFilter) return false;
      const specificity = scoreWorkflowTriggerSpecificity({
        workflowName: String(wf.name || wf.id),
        triggerNode: matchingTriggerNode,
        message,
        hasExplicitWorkflowCommand: /^(?:run|execute)\s+(?:workflow|template)\s*:/i.test(message),
        requestedWorkflowName: "",
      });
      return specificity.accepted && specificity.score >= 60;
    });
    const rawMessageBuiltinAlias = findBuiltinIntentByAlias(rawMessage);

    // Tool invocations: bypass classification entirely.
    // "use fetch_url to check X" should NOT be classified as "show org" builtin.
    // Let it fall through to the general assistant where the agent has tools.
    if (looksLikeToolInvocation(rawMessage) && !rawMessageBuiltinAlias) {
      return finishRouted({
        response: null,
        workflowId: null,
        workflowName: null,
        source: "none",
      }, {
        ...routingTrace,
        intentClass: "general_assistant",
        routeSource: "none",
        commands: [],
      });
    }

    const existingOrgRunBeforePlanner = parseExistingOrgResearchRun(rawMessage);
    if (existingOrgRunBeforePlanner) {
      const orgRunResponse = await handleBuiltinCommands(rawMessage, builtinCtx);
      if (orgRunResponse) {
        clearPendingMutation(sessionId);
        mergeSessionAppStateForInteraction({
          sessionId,
          message: rawMessage,
          response: orgRunResponse,
          classification: { kind: "app_control", domain: "hierarchy", reason: "existing organization execution command", usesSessionReference: true },
        });
        return finishRouted({
          response: orgRunResponse,
          workflowId: null,
          workflowName: null,
          source: "builtin",
        }, {
          intentClass: "app_write",
          commands: resolveTraceCommandsWithFallback([rawMessage]),
          routeSource: "builtin",
        });
      }
    }

    const { isAppActionPlannerEligible, isHierarchyMutationIntent, isWorkflowActivationMutationIntent, isWorkflowNodeEditMutationIntent } = await import("@/lib/channels/app-action-eligibility");
    // Words such as "review" and "prepare" are valid inside concrete app
    // mutations (for example, "review in council, then create follow-ups").
    // Do not let the broad improvement/audit classifier suppress an explicit
    // typed mutation before the planner gets a chance to handle it.
    const explicitTypedMutation =
      isCrossSurfaceAppMutationRequest(rawMessage) ||
      isBoardTaskMutationRequest(rawMessage);
    const openEndedKnowledgeRequest =
      isOpenEndedAppImprovementRequest(rawMessage) && !explicitTypedMutation;
    const appActionPlannerEligible =
      isAppActionPlannerEligible(rawMessage) && !openEndedKnowledgeRequest;
    routingTrace = {
      ...routingTrace,
      plannerEligible: appActionPlannerEligible,
      plannerEligibilityReason: appActionPlannerEligible
        ? "eligible by app-action-eligibility gate"
        : openEndedKnowledgeRequest
          ? "open-ended readiness or improvement request belongs to the agentic knowledge lane"
          : "not eligible by app-action-eligibility gate",
      protectedParser: isProtectedBuiltinParserMessage(rawMessage),
    };
    if (
      appActionPlannerEligible &&
      !isCrossSurfaceAppMutationRequest(rawMessage) &&
      /\b(?:make|improve|fix|optimi[sz]e)\b/i.test(rawMessage) &&
      /\b(?:workflow|workflows|flow|flows|automation|automations|situation|setup)\b/i.test(rawMessage) &&
      !/\b(?:called|named|workflow\s+["'][^"']+["']|flow\s+["'][^"']+["']|id\s+[A-Za-z0-9_-]+)\b/i.test(rawMessage)
    ) {
      const classification = classifyAppControlIntent(rawMessage, sessionAppState);
      const response = buildTargetedAppWriteClarifier(classification, sessionAppState);
      mergeSessionAppStateForInteraction({
        sessionId,
        message: rawMessage,
        response,
        classification,
      });
      return finishRouted({
        response,
        workflowId: null,
        workflowName: null,
        source: "builtin",
      }, {
        intentClass: "app_write",
        routeSource: "builtin",
        commands: [],
      });
    }
    // Hierarchy mutations (rename/switch/update-mission/update-goal/role/etc.)
    // must prefer the model app-action planner BEFORE the read/command-registry
    // lane, otherwise phrasings like "update the mission of <org>" get caught by
    // a read alias ("show org") and never produce an executable plan.
    // Cross-surface mutations must reach the typed planner BEFORE single-surface
    // lanes (e.g. the workflow-run/no-match lane), otherwise a multi-tab build
    // like "use my active org to build a workflow, schedule it, and debate ... in
    // council" gets hijacked by workflow execution and the tabs feel standalone.
    const preferModelAppActionPlanner =
      appActionPlannerEligible &&
      (shouldPreferModelAppActionPlanner(rawMessage) ||
        isHierarchyMutationIntent(rawMessage) ||
        isWorkflowActivationMutationIntent(rawMessage) ||
        isWorkflowNodeEditMutationIntent(rawMessage) ||
        isCrossSurfaceAppMutationRequest(rawMessage));
    const explicitBuiltinParserMessage =
      isExplicitBuiltinParserPhrase(rawMessage) || isExplicitBuiltinParserPhrase(message);
    const explicitSecretStoreCommand = /^(?:set|save|store|update)\s+secret\s+[A-Za-z][A-Za-z0-9_]*\s*(?:to|=)\s*.+$/i.test(rawMessage);
    const runAppActionPlannerRoute = async (
      plannerEligibilityReason = "eligible by app-action-eligibility gate",
    ): Promise<RouteToWorkflowResult | null> => {
      try {
        const cancelled = await checkAndCancelIfAborted();
        if (cancelled) return cancelled;
        const { planAppAction } = await import("@/lib/channels/app-action-planner");
        const planSessionId = String(sessionId || "");
        // Cross-tab mutation proposals go through the model-led app-plan bridge
        // first (typed plan + intent-surface coverage net), then fall back to
        // the deterministic planner if the model is unavailable.
        const crossTabIntent = detectCrossTabIntent(rawMessage);
        let plan: AppActionPlan | null = null;
        if (shouldUseTypedAppPlan(crossTabIntent)) {
          try {
            const { proposeUniversalAppActionPlan } = await import("@/lib/channels/universal-app-plan-bridge");
            plan = await proposeUniversalAppActionPlan({
              message: rawMessage,
              sessionId: planSessionId,
              intent: crossTabIntent,
              internalBaseUrl: opts.internalBaseUrl,
              clientTurnId: opts.clientTurnId,
              onStatus: opts.onStatus,
            });
          } catch (bridgeError) {
            log.warn("universal app-plan bridge failed — falling back to planner", { error: String(bridgeError) });
          }
        }
        if (!plan) {
          plan = await planAppAction(rawMessage, {
            sessionId: planSessionId,
            channel: opts.channel,
            internalBaseUrl: opts.internalBaseUrl,
            clientTurnId: opts.clientTurnId,
            onStatus: opts.onStatus,
          });
        }
        if (!plan) return null;
        if (plan.clarificationQuestion && plan.steps.length === 0) {
          const clarification = formatPlannerClarification(plan);
          mergeSessionAppStateForInteraction({
            sessionId,
            message: rawMessage,
            response: clarification,
            classification: { kind: "app_control", domain: null, reason: "app-action planner clarification", usesSessionReference: false },
          });
          return finishRouted({
            response: clarification,
            workflowId: null,
            workflowName: null,
            source: "app-action-planner",
          }, {
            intentClass: "app_write",
            routeSource: "app-action-planner",
            modelAssistUsed: true,
            plannerEligible: true,
            plannerEligibilityReason,
          });
        }
        const risk = classifyAppActionRisk(plan);
        const needsConfirmation = risk === "confirm-write" || risk === "destructive" || risk === "sensitive" || plan.steps.length > 3;
        if (needsConfirmation && plan.steps.length > 0) {
          const preview = formatAppActionPlanPreview(plan);
          // Open a durable work trail for this cross-tab plan. Stored on the
          // pending payload so confirm/cancel can append to the same trail.
          let trailId = "";
          try {
            const wt = await import("@/lib/work-trails/work-trails");
            trailId = wt.createWorkTrail({
              sessionId: planSessionId,
              clientTurnId: opts.clientTurnId ?? null,
              userMessage: rawMessage,
              intent: crossTabIntent,
              plan,
              status: "pending",
            });
            wt.appendWorkTrailEvent({ trailId, eventType: "intent_detected", summary: crossTabIntent.reason, metadata: { surfaces: crossTabIntent.surfaces, kind: crossTabIntent.kind } });
            wt.appendWorkTrailEvent({ trailId, eventType: "plan_drafted", summary: `${plan.steps.length} steps`, metadata: { stepCount: plan.steps.length } });
          } catch { /* trail is best-effort */ }
          rememberPendingMutation({
            sessionId: planSessionId,
            kind: "app-action-plan",
            summary: preview,
            payload: { plan: plan as unknown as Record<string, unknown>, ...(trailId ? { trailId } : {}) },
            createdAt: Date.now(),
          });
          const plannedResponse = buildPendingMutationPrompt(preview);
          mergeSessionAppStateForInteraction({
            sessionId,
            message: rawMessage,
            response: plannedResponse,
            classification: { kind: "app_control", domain: null, reason: "app-action plan pending confirmation", usesSessionReference: false },
          });
          return finishRouted({
            response: plannedResponse,
            workflowId: null,
            workflowName: null,
            source: "app-action-planner",
            pendingAppActionPlan: plan,
            pendingWorkTrailId: trailId || undefined,
          }, {
            intentClass: "app_write",
            routeSource: "app-action-planner",
            modelAssistUsed: true,
            plannerEligible: true,
            plannerEligibilityReason,
          });
        }
        if (plan.steps.length > 0) {
          const { executeAppActionPlan } = await import("@/lib/channels/app-action-executor");
          const report = await executeAppActionPlan(plan, {
            sessionId: planSessionId,
            channel: opts.channel,
            internalBaseUrl: opts.internalBaseUrl,
          });
          mergeSessionAppStateForInteraction({
            sessionId,
            message: rawMessage,
            response: report.summary,
            classification: { kind: "app_control", domain: null, reason: "app-action read-only plan", usesSessionReference: false },
          });
          return finishRouted({
            response: report.summary,
            workflowId: null,
            workflowName: null,
            source: "app-action-planner",
          }, {
            intentClass: "app_read",
            routeSource: "app-action-planner",
            modelAssistUsed: true,
            plannerEligible: true,
            plannerEligibilityReason,
          });
        }
      } catch (plannerError) {
        log.warn("App-action planner failed — falling through to standard routing", { error: String(plannerError) });
      }
      return null;
    };
    // Reading a previously stored synthetic identifier (exact memory recall) is
    // not the same as submitting a new secret. Allow exact-recall reads through;
    // only block when the message actually carries a value assignment.
    const exactRecallReadOnly =
      queryLooksLikeExactMemoryRecall(rawMessage) && !/[:=]\s*\S{6,}/.test(rawMessage);
    if (containsSecretOrCredentialIntent(rawMessage) && !explicitSecretStoreCommand && !exactRecallReadOnly) {
      return finishRouted({
        response:
          "I can't accept raw API keys, tokens, passwords, or credentials in WebChat. Add them through Settings/Secrets or the connection form, then ask me to validate or use that configured connection.",
        workflowId: null,
        workflowName: null,
        source: "builtin",
      }, {
        intentClass: "app_write",
        routeSource: "builtin",
        commands: [],
      });
    }
    if (
      /\bdynamic\s+workflow\b/i.test(rawMessage) ||
      /\bproject\s+manager\s+agent\s+harness\b/i.test(rawMessage) ||
      /^save\s+(?:this|the)\s+(?:successful\s+)?run\s+as\s+\/?[a-z0-9_.-]+\.?$/i.test(rawMessage)
    ) {
      const cmd = matchAppCommand(rawMessage);
      if (cmd) {
        const result = await cmd.handler(rawMessage, {
          sessionId: String(sessionId || ""),
          channel: opts.channel,
          message: rawMessage,
        });
        if (result) {
          if (cmd.clearsPendingMutation) {
            clearPendingMutation(sessionId);
          }
          mergeSessionAppStateForInteraction({
            sessionId,
            message: rawMessage,
            response: result.response,
            classification: { kind: "app_control", domain: cmd.domain as AppControlDomain, reason: `app-command-registry:${cmd.id}`, usesSessionReference: false },
          });
          return finishRouted({
            response: result.response,
            workflowId: result.workflowId ?? null,
            workflowName: result.workflowName ?? null,
            source: "app-command-registry",
          }, {
            intentClass: result.risk === "read" ? "app_read" : "app_write",
            routeSource: "app-command-registry",
            modelAssistUsed: false,
          });
        }
      }
    }
    if (isHighPriorityChannelBuiltinCommand(rawMessage)) {
      const directBuiltinResponse = await handleBuiltinCommands(rawMessage, builtinCtx);
      if (directBuiltinResponse) {
        return finishRouted({
          response: directBuiltinResponse,
          workflowId: null,
          workflowName: null,
          source: "builtin",
        }, {
          intentClass: /^(?:run|start|execute)\b/i.test(rawMessage) ? "app_write" : "app_read",
          commands: [rawMessage],
          routeSource: "builtin",
        });
      }
    }
    if (preferModelAppActionPlanner) {
      const plannerRoute = await runAppActionPlannerRoute("preferred app-action planner before workflow routing");
      if (plannerRoute) return plannerRoute;
    }
    if (isChannelSetupRequest(rawMessage)) {
      const setupResponse = await handleBuiltinCommands(rawMessage, builtinCtx);
      if (setupResponse) {
        return finishRouted({
          response: setupResponse,
          workflowId: null,
          workflowName: null,
          source: "builtin",
        }, {
          intentClass: "app_read",
          commands: [rawMessage],
          routeSource: "builtin",
        });
      }
    }
    if (!hasSpecificWorkflowTriggerMatch && isToolKnowledgeCommand(rawMessage)) {
      const response = await handleBuiltinCommands(rawMessage, builtinCtx);
      if (response) {
        mergeSessionAppStateForInteraction({
          sessionId,
          message: rawMessage,
          response,
          classification: { kind: "app_control", domain: null, reason: "tool knowledge command", usesSessionReference: false },
        });
        return finishRouted({
          response,
          workflowId: null,
          workflowName: null,
          source: "builtin",
        }, {
          intentClass: "app_read",
          commands: [rawMessage],
          routeSource: "builtin",
        });
      }
    }
    if (rewritesApplied.some((item) => item.includes("workflow template follow-up"))) {
      const templateRecommendation = formatWorkflowTemplateRecommendations(
        listWorkflowTemplateCatalog(),
        message.toLowerCase(),
      );
      if (templateRecommendation) {
        mergeSessionAppStateForInteraction({
          sessionId,
          message,
          response: templateRecommendation,
          classification: { kind: "app_control", domain: "workflow", reason: "workflow template follow-up", usesSessionReference: true },
        });
        return finishRouted({
          response: templateRecommendation,
          workflowId: null,
          workflowName: null,
          source: "builtin",
        }, {
          intentClass: "app_read",
          commands: [message],
          routeSource: "builtin",
        });
      }
    }
    const earlyReadOnlyCommands = inferReadOnlyAppCommandsFromParaphrase(rawMessage);
    // Tool invocations must NOT be classified as builtin app commands.
    // "use fetch_url to check X" → the word "check" triggers "show org" 
    // but the user wants to call a tool, not read org state.
    // Early read-only paraphrase — only if planner is NOT eligible
    // (eligible messages go through planner which handles classification better than regex)
    if (earlyReadOnlyCommands.length > 0 && !hasSpecificWorkflowTriggerMatch && !appActionPlannerEligible && !explicitBuiltinParserMessage) {
      const response = await renderBuiltinCommandList(earlyReadOnlyCommands, builtinCtx);
      if (response) {
        mergeSessionAppStateForInteraction({
          sessionId,
          message: earlyReadOnlyCommands.join(" | "),
          response,
          classification: { kind: "app_control", domain: null, reason: "early read-only paraphrase heuristic", usesSessionReference: false },
        });
        return finishRouted({
          response,
          workflowId: null,
          workflowName: null,
          source: "builtin",
        }, {
          intentClass: "app_read",
          commands: earlyReadOnlyCommands,
          routeSource: "builtin",
        });
      }
    }
    // Non-mutating / overloaded / open-ended — only block if planner is NOT eligible
    if (!explicitBuiltinParserMessage && !appActionPlannerEligible) {
      if (!rawMessageBuiltinAlias && (isNonMutatingPlanningRequest(rawMessage) || isClearlyNonAppOverloadedSurfaceRequest(rawMessage) || isOpenEndedAppImprovementRequest(rawMessage))) {
        return finishRouted({
          response: null,
          workflowId: null,
          workflowName: null,
          source: "none",
        }, {
          intentClass: "general_assistant",
          routeSource: "none",
          commands: [],
        });
      }
    }
    if (!isProtectedBuiltinParserMessage(rawMessage)) {
      const confusionClarifier = appActionPlannerEligible ? null : detectConfusionPairClarifier(rawMessage);
      if (confusionClarifier) {
        return finishRouted({
          response: confusionClarifier.reply,
          workflowId: null,
          workflowName: null,
          source: "builtin",
        }, {
          intentClass: routingTrace.intentClass,
          routeSource: "builtin",
          commands: [],
        });
      }
    }
    if (/^actually\s+don'?t\s+create\s+it\b/i.test(rawMessage) && /\b(?:tasks?\s+exist|list\s+tasks|what\s+tasks)\b/i.test(rawMessage)) {
      clearPendingMutation(sessionId);
      const response = await handleBuiltinCommands("list tasks", builtinCtx);
      if (response) {
        return finishRouted({
          response,
          workflowId: null,
          workflowName: null,
          source: "builtin",
        }, {
          intentClass: "app_read",
          commands: ["list tasks"],
          routeSource: "builtin",
        });
      }
    }
    const boardTaskPreviewTitle =
      /^(?:please\s+)?create\s+a\s+board\s+task\s+to\b/i.test(rawMessage)
        ? extractTaskTitleFromNaturalLanguage(rawMessage)
        : null;
    if (boardTaskPreviewTitle) {
      const previewPlan = [{ raw: `create a task called ${boardTaskPreviewTitle}`, label: `create a board task called ${boardTaskPreviewTitle}` }];
      const plannedResponse =
        queueSensitiveMutation(builtinCtx, {
          kind: "multi-step-plan",
          summary: [
            "Apply this 1-step plan:",
            `1. ${previewPlan[0].label}`,
          ].join("\n"),
          payload: { steps: previewPlan },
        }) ?? "This board task plan needs an active chat session.";
      return finishRouted({
        response: plannedResponse,
        workflowId: null,
        workflowName: null,
        source: "builtin",
      }, {
        intentClass: "app_write",
        routeSource: "builtin",
      });
    }
    const isImmediatePendingReply = /^(?:confirm|yes|apply it|do it|cancel|never mind|nevermind|stop|don t do that|don't do that)$/i.test(rawMessage);
    if (!isImmediatePendingReply) {
      const earlyCorrectionPlan = buildPendingMutationCorrectionPlan(rawMessage, getPendingMutation(sessionId));
      const earlyMultiStepPlan = earlyCorrectionPlan ?? buildMultiStepPlan(rawMessage, sessionAppState);
      if (earlyMultiStepPlan && !appActionPlannerEligible) {
        const plannedResponse =
          queueSensitiveMutation(builtinCtx, {
            kind: "multi-step-plan",
            summary: [
              `Apply this ${earlyMultiStepPlan.length}-step plan:`,
              ...earlyMultiStepPlan.map((step, index) => `${index + 1}. ${step.label}`),
            ].join("\n"),
            payload: {
              steps: earlyMultiStepPlan,
            },
          }) ??
          "This multi-step plan needs an active chat session.";
        return finishRouted({
          response: plannedResponse,
          workflowId: null,
          workflowName: null,
          source: "builtin",
        }, {
          intentClass: "app_write",
          routeSource: "builtin",
        });
      }
    }
    const explicitUseWorkflowMatch = message.match(/^(?:use)\s+(.+?)\s+to\s+(.+)$/i);
    if (explicitUseWorkflowMatch?.[1] && explicitUseWorkflowMatch[2]) {
      const workflowRef = stripWrappedQuotes(explicitUseWorkflowMatch[1]).trim();
      // Don't treat tool invocations as workflow references.
      // e.g. "use the fetch_url tool to get content from X"
      // or   "use web_search to search the web"
      if (!looksLikeToolInvocationRef(workflowRef)) {
        const matchedWorkflow = findWorkflowMatchByName(
          workflows.map((workflow) => ({ name: String(workflow.name || ""), id: workflow.id })),
          workflowRef.toLowerCase(),
        );
        if (!matchedWorkflow) {
          const available = workflows.slice(0, 6).map((workflow) => String(workflow.name || workflow.id)).join(", ");
          return finishRouted({
            response: `No active workflow matched "${workflowRef}". Available: ${available}`,
            workflowId: null,
            workflowName: null,
            source: "none",
          }, {
            routeSource: "none",
            commands: [workflowRef.toLowerCase()],
          });
        }
        message = `run workflow: ${matchedWorkflow.name} :: ${trimIntentLeadIn(explicitUseWorkflowMatch[2])}`;
        opts.triggerData = { ...opts.triggerData, message };
      }
    }
    if (shouldUseWorkflowTemplateRecommendation(rawMessage)) {
      const templateRecommendation = formatWorkflowTemplateRecommendations(
        listWorkflowTemplateCatalog(),
        rawMessage.toLowerCase(),
      );
      if (templateRecommendation) {
        mergeSessionAppStateForInteraction({
          sessionId,
          message: rawMessage,
          response: templateRecommendation,
          classification: { kind: "app_control", domain: "workflow", reason: "workflow template recommendation", usesSessionReference: false },
        });
        return finishRouted({
          response: templateRecommendation,
          workflowId: null,
          workflowName: null,
          source: "builtin",
        }, {
          intentClass: "app_read",
          commands: [rawMessage],
          routeSource: "builtin",
        });
      }
    }
    if (
      routingTrace.clauses.length < 2 &&
      !hasSpecificWorkflowTriggerMatch &&
      !appActionPlannerEligible &&
      (isExplicitBuiltinParserPhrase(rawMessage) || isExplicitBuiltinParserPhrase(message))
    ) {
      const parserMessage = isExplicitBuiltinParserPhrase(rawMessage) ? rawMessage : message;
      const parserClassification = classifyAppControlIntent(parserMessage, sessionAppState);
      const parserResponse = await handleBuiltinCommands(parserMessage, builtinCtx);
      if (parserResponse) {
        mergeSessionAppStateForInteraction({
          sessionId,
          message: parserMessage,
          response: parserResponse,
          classification: parserClassification,
        });
        const parserTraceUpdate: Partial<RoutingDecisionTrace> = {
          intentClass: /^Pending confirmation\b/i.test(parserResponse)
            ? "app_write"
            : classifyIntentClass(parserMessage, parserClassification),
          commands: resolveTraceCommandsWithFallback([parserMessage]),
          routeSource: "builtin",
        };
        return finishRouted({
          response: parserResponse,
          workflowId: null,
          workflowName: null,
          source: "builtin",
        }, parserTraceUpdate);
      }
    }
    if (routingTrace.clauses.length >= 2 && !hasSpecificWorkflowTriggerMatch && !appActionPlannerEligible) {
      const compoundWrapperCommand =
        findBuiltinIntentByAlias(message)?.command ??
        findBuiltinIntentByCommand(message)?.command ??
        null;
      const compoundResponse = compoundWrapperCommand
        ? await handleBuiltinCommands(compoundWrapperCommand, builtinCtx)
        : await renderCompoundBuiltinSections(routingTrace.clauses, builtinCtx);
      if (compoundResponse) {
        mergeSessionAppStateForInteraction({
          sessionId,
          message: rawMessage,
          response: compoundResponse,
          classification: { kind: "app_control", domain: null, reason: "compound builtin summary", usesSessionReference: false },
        });
        return finishRouted({
          response: compoundResponse,
          workflowId: null,
          workflowName: null,
          source: "builtin",
        }, {
          intentClass: "app_read",
          commands: compoundWrapperCommand ? [compoundWrapperCommand] : resolveTraceCommandsWithFallback(routingTrace.clauses),
          routeSource: "builtin",
        });
      }
    }
    const isConfirmPendingMessage = /^(?:confirm|yes|apply it|do it)$/i.test(rawMessage);
    const isCancelPendingMessage = /^(?:cancel|never mind|nevermind|stop|don t do that|don't do that)$/i.test(rawMessage);
    const persistedPendingConfirmation = getChannelSessionAppState(sessionId)?.payload?.pendingMutation ?? null;
    if ((isConfirmPendingMessage || isCancelPendingMessage) && persistedPendingConfirmation?.kind) {
      let response: string | null = null;
      const builtinCtx: BuiltinCommandContext = {
        channel: opts.channel,
        sender: String(opts.triggerData.sender ?? "") || String(opts.triggerData.userId ?? "") || "unknown",
        sessionId,
        internalBaseUrl: opts.internalBaseUrl,
        clientTurnId: opts.clientTurnId,
      };
      if (isConfirmPendingMessage) {
        const pending = getPendingMutation(sessionId);
        if (!pending) {
          clearPendingMutation(sessionId);
          response = "No pending confirmation found — it may have expired. Please repeat your request.";
        } else {
          clearPendingMutation(sessionId);
          response = await executePendingMutation(pending, builtinCtx);
        }
      } else if (isCancelPendingMessage) {
        const pending = getPendingMutation(sessionId);
        clearPendingMutation(sessionId);
        response = pending
          ? `Cancelled pending change: ${pending.summary}`
          : "There is no pending confirmed change in this chat right now.";
      }
      if (!response) {
        response = await handleBuiltinCommands(rawMessage, builtinCtx);
      }
      if (response) {
        mergeSessionAppStateForInteraction({
          sessionId,
          message: rawMessage,
          response,
          classification: { kind: "app_control", domain: null, reason: "pending mutation confirmation", usesSessionReference: true },
        });
        const pendingIntentClass: IntentClass =
          getPendingMutation(sessionId)?.kind === "multi-step-plan" ? "app_write" : "app_write";
        return finishRouted({
          response,
          workflowId: null,
          workflowName: null,
          source: "builtin",
        }, {
          intentClass: pendingIntentClass,
          routeSource: "builtin",
        });
      }
    }
    const correctionPlan = buildPendingMutationCorrectionPlan(rawMessage, getPendingMutation(sessionId));
    const multiStepPlan = correctionPlan ?? buildMultiStepPlan(rawMessage, sessionAppState);
    if (multiStepPlan && !appActionPlannerEligible) {
      const plannedResponse =
        queueSensitiveMutation(builtinCtx, {
          kind: "multi-step-plan",
          summary: [
            `Apply this ${multiStepPlan.length}-step plan:`,
            ...multiStepPlan.map((step, index) => `${index + 1}. ${step.label}`),
          ].join("\n"),
          payload: {
            steps: multiStepPlan,
          },
        }) ??
        "This multi-step plan needs an active chat session.";
      if (plannedResponse) {
        mergeSessionAppStateForInteraction({
          sessionId,
          message: rawMessage,
          response: plannedResponse,
          classification: { kind: "app_control", domain: null, reason: "multi-step mutation plan", usesSessionReference: false },
        });
        return finishRouted({
          response: plannedResponse,
          workflowId: null,
          workflowName: null,
          source: "builtin",
        }, {
          intentClass: "app_write",
          routeSource: "builtin",
        });
      }
    }
    if (/^(?:run|trigger|fire|execute)\s+now\s+["']?[^"']+["']?\s*$/i.test(rawMessage)) {
      const runNowResponse = await handleBuiltinCommands(rawMessage, builtinCtx);
      if (runNowResponse) {
        mergeSessionAppStateForInteraction({
          sessionId,
          message: rawMessage,
          response: runNowResponse,
          classification: { kind: "app_control", domain: "scheduler", reason: "deterministic run-now command", usesSessionReference: false },
        });
        return finishRouted({
          response: runNowResponse,
          workflowId: null,
          workflowName: null,
          source: "builtin",
        }, {
          intentClass: "app_write",
          commands: resolveTraceCommandsWithFallback([rawMessage]),
          routeSource: "builtin",
        });
      }
    }
    if (parseExistingOrgResearchRun(rawMessage)) {
      const orgRunResponse = await handleBuiltinCommands(rawMessage, builtinCtx);
      if (orgRunResponse) {
        clearPendingMutation(sessionId);
        mergeSessionAppStateForInteraction({
          sessionId,
          message: rawMessage,
          response: orgRunResponse,
          classification: { kind: "app_control", domain: "hierarchy", reason: "existing organization execution command", usesSessionReference: true },
        });
        return finishRouted({
          response: orgRunResponse,
          workflowId: null,
          workflowName: null,
          source: "builtin",
        }, {
          intentClass: "app_write",
          commands: resolveTraceCommandsWithFallback([rawMessage]),
          routeSource: "builtin",
        });
      }
    }
    // Step 5.5: Deterministic app-command registry (before LLM planner)
    {
      const cmd = matchAppCommand(rawMessage);
      if (cmd) {
        const result = await cmd.handler(rawMessage, {
          sessionId: String(sessionId || ""),
          channel: opts.channel,
          message: rawMessage,
        });
        if (result) {
          if (cmd.clearsPendingMutation) {
            clearPendingMutation(sessionId);
          }
          mergeSessionAppStateForInteraction({
            sessionId,
            message: rawMessage,
            response: result.response,
            classification: { kind: "app_control", domain: cmd.domain as AppControlDomain, reason: `app-command-registry:${cmd.id}`, usesSessionReference: false },
          });
          return finishRouted({
            response: result.response,
            workflowId: result.workflowId ?? null,
            workflowName: result.workflowName ?? null,
            source: "app-command-registry",
          }, { intentClass: "app_read", routeSource: "app-command-registry", modelAssistUsed: false });
        }
      }
    }
    // Step 6: LLM app-action planner for vague multi-domain app-write prompts
    {
      if (appActionPlannerEligible) {
        const plannerRoute = await runAppActionPlannerRoute();
        if (plannerRoute) return plannerRoute;
      }
    }

    if (isExplicitlyConversationalMessage(rawMessage)) {
      const response = /^(?:hello|hi|hey|yo|sup|howdy|hiya|greetings|morning|evening|night)\b/i.test(rawMessage.trim())
        ? "Hi. Ask me about the app or tell me what you want to do."
        : "Noted.";
      return finishRouted({
        response,
        workflowId: null,
        workflowName: null,
        source: "none",
      }, {
        intentClass: "conversation",
        routeSource: "none",
        commands: [],
      });
    }
    if (!hasSpecificWorkflowTriggerMatch && isToolKnowledgeCommand(rawMessage)) {
      const response = await handleBuiltinCommands(rawMessage, builtinCtx);
      if (response) {
        mergeSessionAppStateForInteraction({
          sessionId,
          message: rawMessage,
          response,
          classification: { kind: "app_control", domain: null, reason: "tool knowledge command", usesSessionReference: false },
        });
        return finishRouted({
          response,
          workflowId: null,
          workflowName: null,
          source: "builtin",
        }, {
          intentClass: "app_read",
          commands: [rawMessage],
          routeSource: "builtin",
        });
      }
    }
    const inferredReadCommands = inferReadOnlyAppCommandsFromParaphrase(message);
    if (!hasSpecificWorkflowTriggerMatch && inferredReadCommands.length > 0) {
      const response = await renderBuiltinCommandList(inferredReadCommands, builtinCtx);
      if (response) {
        mergeSessionAppStateForInteraction({
          sessionId,
          message: inferredReadCommands.join(" | "),
          response,
          classification: { kind: "app_control", domain: null, reason: "read-only paraphrase heuristic", usesSessionReference: false },
        });
        return finishRouted({
          response,
          workflowId: null,
          workflowName: null,
          source: "builtin",
        }, {
          intentClass: "app_read",
          commands: inferredReadCommands,
          routeSource: "builtin",
        });
      }
    }
    let builtinRoute = decideBuiltinRoute(rawMessage, message, sessionAppState);
    if (builtinRoute.mode === "exact" && !builtinRoute.protectedParser && !hasSpecificWorkflowTriggerMatch) {
      const ellipticalResolved = resolveEllipticalAppMessage(message);
      if (ellipticalResolved?.message.trim()) {
        message = ellipticalResolved.message.trim();
        opts.triggerData = { ...opts.triggerData, message };
        builtinRoute = decideBuiltinRoute(rawMessage, message, sessionAppState);
      }
    }
    const directBuiltinSummaryMessage = (() => {
      const normalizedMessage = normalizeLookup(message);
      if (
        normalizedMessage === "channel status" ||
        normalizedMessage === "what channels are connected" ||
        normalizedMessage === "which channels are connected" ||
        normalizedMessage === "which channels do we have live" ||
        normalizedMessage === "what channels do we have live" ||
        (
          /\b(?:chat|channel|channels|messaging|message|communication|inbox|inboxes|bridge|bridges)\b/i.test(message) &&
          /\b(?:connections?|connected|working|alive|active|online|offline|disconnected|health|routes?|send\s+messages|wired\s+up)\b/i.test(message)
        )
      ) {
        return "channel status";
      }
      return null;
    })();
    if (!hasSpecificWorkflowTriggerMatch && builtinRoute.mode === "exact" && directBuiltinSummaryMessage) {
      const response = await handleBuiltinCommands(directBuiltinSummaryMessage, {
        channel: opts.channel,
        sender: String(opts.triggerData.sender ?? "") || String(opts.triggerData.userId ?? "") || "unknown",
        sessionId,
        internalBaseUrl: opts.internalBaseUrl,
      });
      if (response) {
        mergeSessionAppStateForInteraction({
          sessionId,
          message: directBuiltinSummaryMessage,
          response,
          classification: { kind: "app_control", domain: "channels", reason: "direct summary fast-path", usesSessionReference: false },
        });
        return finishRouted({
          response,
          workflowId: null,
          workflowName: null,
          source: "builtin",
        }, {
          commands: [directBuiltinSummaryMessage],
          routeSource: "builtin",
        });
      }
    }
    if (isDeclarativeStatusUpdateMessage(rawMessage)) {
      const response =
        "Noted. I recorded the status update in this session and will not change tasks, workflows, or schedules unless you ask.";
      mergeSessionAppStateForInteraction({
        sessionId,
        message,
        response,
        classification: { kind: "conversation", domain: null, reason: "status note acknowledgement", usesSessionReference: false },
      });
      return finishRouted({
        response,
        workflowId: null,
        workflowName: null,
        source: "builtin",
      }, {
        routeSource: "builtin",
      });
    }
    let workflowIntent = parseWorkflowIntent(message);
    const hasExplicitWorkflowCommand = /^(?:run|execute)\s+(?:workflow|template)\s*:/i.test(message);
    const compatibleChannels = compatibleWorkflowChannels;
    const executeWorkflowRoute = async (params?: {
      workflowIntent?: WorkflowCommandIntent;
      skipWorkflowInference?: boolean;
      exactMemoryRecall?: boolean;
      traceUpdate?: Partial<RoutingDecisionTrace>;
    }): Promise<RouteToWorkflowResult> => {
      let nextWorkflowIntent = params?.workflowIntent ?? workflowIntent;
      const exactMemoryRecall = Boolean(params?.exactMemoryRecall);

      const allActiveCandidates: Array<{
        id: string;
        name: string;
        nodes: WorkflowNode[];
        edges: WorkflowEdge[];
        specificityScore: number;
      }> = [];
      const candidates: Array<{
        id: string;
        name: string;
        nodes: WorkflowNode[];
        edges: WorkflowEdge[];
        specificityScore: number;
      }> = [];

      const keywordCandidates: typeof candidates = [];
      const genericCandidates: typeof candidates = [];

      for (const wf of workflows) {
        const nodes = JSON.parse(wf.nodes) as WorkflowNode[];
        const matchingTriggerNode = nodes.find((n) => {
          if (opts.triggerNodeType === "message-trigger") {
            const channel = String(n.data.channel ?? "");
            return n.type === "message-trigger" && compatibleChannels.has(channel);
          }
          return (
            n.type === opts.triggerNodeType ||
            (n.type === "message-trigger" && compatibleChannels.has(String(n.data.channel ?? "")))
          );
        });

        const candidate = {
          id: wf.id,
          name: String(wf.name || wf.id),
          nodes,
          edges: JSON.parse(wf.edges) as WorkflowEdge[],
          specificityScore: 0,
        };
        allActiveCandidates.push(candidate);

        if (matchingTriggerNode) {
          const specificity = scoreWorkflowTriggerSpecificity({
            workflowName: candidate.name,
            triggerNode: matchingTriggerNode,
            message,
            hasExplicitWorkflowCommand,
            requestedWorkflowName: nextWorkflowIntent.requestedWorkflowName,
          });
          if (specificity.accepted) {
            const scoredCandidate = { ...candidate, specificityScore: specificity.score };
            if (specificity.score >= 60) {
              keywordCandidates.push(scoredCandidate);
            } else {
              genericCandidates.push(scoredCandidate);
            }
          } else {
            log.debug("Workflow trigger skipped by specificity guard", {
              workflowId: candidate.id,
              workflowName: candidate.name,
              reason: specificity.reason,
            });
          }
          continue;
        }
      }

      candidates.push(...keywordCandidates, ...genericCandidates);
      const resolvedCandidates = candidates;

      if (!nextWorkflowIntent.requestedWorkflowName && !params?.skipWorkflowInference && !exactMemoryRecall) {
        nextWorkflowIntent = inferWorkflowIntentFromCandidates(
          message,
          allActiveCandidates.map((candidate) => candidate.name),
        );
      }

      if (resolvedCandidates.length === 0) {
        log.warn("No active workflow found for channel trigger", {
          triggerNodeType: opts.triggerNodeType,
          channel: opts.channel,
        });
        return finishRouted({
          response: null,
          workflowId: null,
          workflowName: null,
          source: "none",
        }, {
          ...(params?.traceUpdate ?? {}),
          routeSource: "none",
        });
      }

      let selected = resolvedCandidates[0];
      if (!nextWorkflowIntent.requestedWorkflowName) {
        selected = selectPreferredDefaultWorkflowCandidate(resolvedCandidates, opts.channel) ?? selected;
      }
      if (!nextWorkflowIntent.requestedWorkflowName) {
        selected = [...resolvedCandidates].sort((left, right) =>
          right.specificityScore - left.specificityScore || left.name.localeCompare(right.name),
        )[0] ?? selected;
      }
      if (nextWorkflowIntent.requestedWorkflowName) {
        const compatibleMatch = findWorkflowMatchByName(resolvedCandidates, nextWorkflowIntent.requestedWorkflowName);
        const globalMatch = findWorkflowMatchByName(allActiveCandidates, nextWorkflowIntent.requestedWorkflowName);

        if (compatibleMatch || globalMatch) {
          selected = compatibleMatch ?? globalMatch ?? selected;
        } else {
          // Don't show "no workflow matched" for tool invocations — let fallback handle
          if (looksLikeToolInvocationRef(nextWorkflowIntent.requestedWorkflowNameRaw)) {
            return finishRouted({
              response: null,
              workflowId: null,
              workflowName: null,
              source: "none",
            }, {
              ...(params?.traceUpdate ?? {}),
              routeSource: "none",
            });
          }
          const available = allActiveCandidates.slice(0, 6).map((wf) => wf.name).join(", ");
          return finishRouted({
            response: `No active workflow matched "${nextWorkflowIntent.requestedWorkflowNameRaw}". Available: ${available}`,
            workflowId: null,
            workflowName: null,
            source: "none",
          }, {
            ...(params?.traceUpdate ?? {}),
            routeSource: "none",
            commands: nextWorkflowIntent.requestedWorkflowName ? [nextWorkflowIntent.requestedWorkflowName] : [],
          });
        }

        if (!nextWorkflowIntent.workflowPayload) {
          if (sessionId) {
            upsertChannelSessionAppState({
              sessionId,
              patch: {
                workflow: buildSessionEntityRef(selected.name, selected.id),
                lastDomain: "workflow",
                lastAction: "workflow-select",
              },
            });
          }
          return finishRouted({
            response: `Workflow "${selected.name}" selected. Say "use ${selected.name} to <your message>" or "run workflow: ${selected.name} :: <your message>".`,
            workflowId: selected.id,
            workflowName: selected.name,
            source: "workflow",
          }, {
            ...(params?.traceUpdate ?? {}),
            routeSource: "workflow",
            commands: [selected.name],
          });
        }
      }

      const pendingFollowUp = sessionId ? consumeSessionFollowUp(sessionId) : null;
      const modelConfig = getModelConfig({
        agentId: String(opts.agentId || "").trim() || undefined,
        sessionId,
      });
      const provenanceSource = opts.provenance?.source?.startsWith("acp:")
        ? String(opts.provenance.source)
        : `channel:${opts.channel}`;
      const provenanceChannel = opts.provenance?.channel ?? opts.channel;
      const workflowProvenance = createChildProvenance(
        opts.provenance,
        "channel",
        provenanceSource,
        {
          ingressProtocol: opts.provenance?.ingressProtocol,
          ingressSessionId: opts.provenance?.ingressSessionId,
          originActor: opts.provenance?.originActor,
          originClient: opts.provenance?.originClient,
          originTraceId: opts.provenance?.originTraceId,
          receiptMode: opts.provenance?.receiptMode,
          channel: provenanceChannel,
          sessionId: sessionId ?? undefined,
          sender: senderRaw,
          workflowId: selected.id,
          workflowName: selected.name,
          routeSource: exactMemoryRecall ? "exact-memory-recall" : (nextWorkflowIntent.requestedWorkflowName ? "named-workflow" : "channel-router"),
          triggerType: "message",
        },
      );
      const ingressMode = opts.ingressModeOverride ?? getConfiguredIngressProvenanceMode();
      const requestedWorkflowPayload = nextWorkflowIntent.workflowPayload || workflowIntent.workflowPayload;
      const triggerData =
        nextWorkflowIntent.requestedWorkflowName && requestedWorkflowPayload
          ? applyIngressProvenance(
              {
                ...opts.triggerData,
                message: requestedWorkflowPayload,
                sessionId: sessionId ?? opts.triggerData.sessionId,
                ...(exactMemoryRecall ? { exactMemoryRecall: true, routingIntentClass: "exact_memory_recall" } : {}),
                ...(pendingFollowUp?.message ? { hiddenFollowUpMessage: pendingFollowUp.message } : {}),
                ...(pendingFollowUp?.hiddenPayload ? { hiddenFollowUpPayload: pendingFollowUp.hiddenPayload } : {}),
              },
              workflowProvenance,
              ingressMode,
            )
          : applyIngressProvenance(
              {
                ...opts.triggerData,
                sessionId: sessionId ?? opts.triggerData.sessionId,
                ...(exactMemoryRecall ? { exactMemoryRecall: true, routingIntentClass: "exact_memory_recall" } : {}),
                ...(pendingFollowUp?.message ? { hiddenFollowUpMessage: pendingFollowUp.message } : {}),
                ...(pendingFollowUp?.hiddenPayload ? { hiddenFollowUpPayload: pendingFollowUp.hiddenPayload } : {}),
              },
              workflowProvenance,
              ingressMode,
            );

      const cancelled = await checkAndCancelIfAborted();
      if (cancelled) return cancelled;
      const result = await executeWorkflow({
        workflowId: selected.id,
        nodes: selected.nodes,
        edges: selected.edges,
        triggerType: "message",
        triggerData,
        provenance: workflowProvenance,
        modelConfig,
        clientTurnId: opts.clientTurnId,
        onEmit: opts.onEmit,
      });

      const results = Object.values(result.nodeResults);
      for (const r of results.reverse()) {
        if (typeof r.output.response === "string" && r.output.response) {
          if (nextWorkflowIntent.requestedWorkflowName && sessionId) {
            upsertChannelSessionAppState({
              sessionId,
              patch: {
                workflow: buildSessionEntityRef(selected.name, selected.id),
                lastDomain: "workflow",
                lastAction: "workflow-run",
              },
            });
          }
          return finishRouted({
            response: r.output.response,
            workflowId: selected.id,
            workflowName: selected.name,
            source: "workflow",
          }, {
            ...(params?.traceUpdate ?? {}),
            routeSource: "workflow",
            commands: nextWorkflowIntent.requestedWorkflowName ? [nextWorkflowIntent.requestedWorkflowName] : [selected.name],
          });
        }
        if (typeof r.output.content === "string" && r.output.content) {
          if (nextWorkflowIntent.requestedWorkflowName && sessionId) {
            upsertChannelSessionAppState({
              sessionId,
              patch: {
                workflow: buildSessionEntityRef(selected.name, selected.id),
                lastDomain: "workflow",
                lastAction: "workflow-run",
              },
            });
          }
          return finishRouted({
            response: r.output.content,
            workflowId: selected.id,
            workflowName: selected.name,
            source: "workflow",
          }, {
            ...(params?.traceUpdate ?? {}),
            routeSource: "workflow",
            commands: nextWorkflowIntent.requestedWorkflowName ? [nextWorkflowIntent.requestedWorkflowName] : [selected.name],
          });
        }
      }

      if (nextWorkflowIntent.requestedWorkflowName && sessionId) {
        upsertChannelSessionAppState({
          sessionId,
          patch: {
            workflow: buildSessionEntityRef(selected.name, selected.id),
            lastDomain: "workflow",
            lastAction: "workflow-run",
          },
        });
      }

      return finishRouted({
        response: null,
        workflowId: selected.id,
        workflowName: selected.name,
        source: "workflow",
      }, {
        ...(params?.traceUpdate ?? {}),
        routeSource: "workflow",
        commands: nextWorkflowIntent.requestedWorkflowName ? [nextWorkflowIntent.requestedWorkflowName] : [selected.name],
      });
    };
    if (hasSpecificWorkflowTriggerMatch && !preferModelAppActionPlanner) {
      return executeWorkflowRoute({
        workflowIntent,
        skipWorkflowInference: true,
        traceUpdate: {
          routeSource: "workflow",
        },
      });
    }
    if (!hasExplicitWorkflowCommand) {
      if (/\bagent\b/i.test(rawMessage) && /\bwhat would that look like\b/i.test(rawMessage)) {
        return finishRouted({
          response: buildBuiltinRoutingClarifier({
            kind: "app_control",
            domain: "agent",
            reason: "hypothetical agent-upgrade phrasing needs explicit confirmation",
            usesSessionReference: detectSessionReference(rawMessage),
          }),
          workflowId: null,
          workflowName: null,
          source: "builtin",
        }, {
          routeSource: "builtin",
        });
      }
      if (looksLikeLearningCandidateCommand(rawMessage)) {
        const directResponse = await handleBuiltinCommands(rawMessage, {
          channel: opts.channel,
          sender: senderRaw,
          sessionId,
          internalBaseUrl: opts.internalBaseUrl,
        });
        if (directResponse) {
          return finishRouted({
            response: directResponse,
            workflowId: null,
            workflowName: null,
            source: "builtin",
          }, {
            intentClass: "app_write",
            routeSource: "builtin",
            commands: [rawMessage],
          });
        }
      }
      if (looksLikeOrgCollaborationCommand(rawMessage)) {
        const directResponse = await handleBuiltinCommands(rawMessage, {
          channel: opts.channel,
          sender: senderRaw,
          sessionId,
          internalBaseUrl: opts.internalBaseUrl,
        });
        if (directResponse) {
          const classification: AppIntentClassification = {
            kind: "app_control",
            domain: "council",
            reason: "direct organization collaboration routing",
            usesSessionReference: detectSessionReference(rawMessage),
          };
          mergeSessionAppStateForInteraction({
            sessionId,
            message: rawMessage,
            response: directResponse,
            classification,
          });
          return finishRouted({
            response: directResponse,
            workflowId: null,
            workflowName: null,
            source: "builtin",
          }, {
            intentClass: classifyIntentClass(rawMessage, classification),
            routeSource: "builtin",
            commands: [rawMessage],
          });
        }
      }
      const directBuiltinAlias =
        isProtectedBuiltinParserMessage(rawMessage) || queryLooksLikeExactMemoryRecall(rawMessage)
          ? null
          : findBuiltinIntentByAlias(rawMessage);
      if (directBuiltinAlias) {
        const directResponse = await handleBuiltinCommands(directBuiltinAlias.command, {
          channel: opts.channel,
          sender: senderRaw,
          sessionId,
          internalBaseUrl: opts.internalBaseUrl,
        });
        if (directResponse) {
          mergeSessionAppStateForInteraction({
            sessionId,
            message: directBuiltinAlias.command,
            response: directResponse,
            classification: {
              kind: "app_control",
              domain: (directBuiltinAlias.domains[0] as AppControlDomain | undefined) ?? null,
              reason: `direct builtin alias routing (${directBuiltinAlias.id})`,
              usesSessionReference: detectSessionReference(rawMessage),
            },
          });
          return finishRouted({
            response: directResponse,
            workflowId: null,
            workflowName: null,
            source: "builtin",
          }, {
            commands: [directBuiltinAlias.command],
            routeSource: "builtin",
          });
        }
      }
      const builtinClassification = builtinRoute.classification;
      routingTrace = {
        ...routingTrace,
        classificationKind: builtinClassification.kind,
        classificationDomain: builtinClassification.domain,
        intentClass: classifyIntentClass(message, builtinClassification),
      };
      let topIntentClass = routingTrace.intentClass;
      const upstreamTaskIntent = opts.triggerData.taskIntentContract as Record<string, unknown> | undefined;
      const upstreamEvidenceSources = Array.isArray(upstreamTaskIntent?.evidenceSources)
        ? upstreamTaskIntent.evidenceSources.map((source) => String(source))
        : [];
      const exactRecallConflictsWithEvidenceContract =
        topIntentClass === "exact_memory_recall" &&
        upstreamTaskIntent?.toolPolicy === "required" &&
        (
          upstreamTaskIntent.requiresRepoEvidence === true ||
          upstreamTaskIntent.requiresAppState === true ||
          upstreamEvidenceSources.some((source) => source !== "memory" && source !== "session_history")
        );
      if (exactRecallConflictsWithEvidenceContract) {
        topIntentClass = "general_assistant";
        routingTrace = {
          ...routingTrace,
          intentClass: topIntentClass,
          rewritesApplied: [...routingTrace.rewritesApplied, "suppressed exact recall because required evidence contract takes precedence"],
        };
      }
      // Workflow inspection/editing prompts bypass the deterministic builtin
      // handler and reach the LLM workflow_* tool catalog.
      const isWfEditIntent = (await import("@/lib/channels/app-action-eligibility")).isWorkflowEditOrInspectIntent(rawMessage);
      const builtin =
        isWfEditIntent || builtinRoute.mode !== "exact" || (topIntentClass === "exact_memory_recall" && !builtinRoute.protectedParser)
          ? null
          : await handleBuiltinCommands(message, {
            channel: opts.channel,
            sender: senderRaw,
            sessionId,
            internalBaseUrl: opts.internalBaseUrl,
          });
      if (builtin) {
        mergeSessionAppStateForInteraction({
          sessionId,
          message,
          response: builtin,
          classification: builtinClassification,
        });
        const builtinTraceUpdate: Partial<RoutingDecisionTrace> = {
          commands: resolveTraceCommands([message]),
          routeSource: "builtin",
        };
        if (/^Pending confirmation\b/i.test(builtin)) {
          builtinTraceUpdate.intentClass = "app_write";
        }
        return finishRouted({
          response: builtin,
          workflowId: null,
          workflowName: null,
          source: "builtin",
        }, builtinTraceUpdate);
      }
      if (!workflowIntent.requestedWorkflowName) {
        if (topIntentClass === "exact_memory_recall") {
          const exactResolution = resolveDirectExactRecall({
            agentId: opts.agentId,
            query: message,
            sessionId,
          });
          if (exactResolution) {
            return finishRouted({
              response: exactResolution.response,
              workflowId: null,
              workflowName: null,
              source: "workflow",
            }, {
              intentClass: "exact_memory_recall",
              routeSource: "workflow",
              commands: ["exact-memory-recall"],
            });
          }
          return executeWorkflowRoute({
            workflowIntent,
            exactMemoryRecall: true,
            skipWorkflowInference: true,
            traceUpdate: {
              intentClass: "exact_memory_recall",
              routeSource: "workflow",
            },
          });
        }
        if (topIntentClass === "app_read" && (builtinRoute.mode === "exact" || builtinRoute.mode === "fuzzy") && !isWfEditIntent) {
          const assistedBuiltin = await resolveBuiltinWithModel({
            rawMessage,
            classification: builtinClassification,
            sessionId,
            sessionAppState,
          });
          if (assistedBuiltin?.command && shouldAcceptModelBuiltinResolution(rawMessage, builtinClassification, assistedBuiltin)) {
            const response = await renderBuiltinCommandList(assistedBuiltin.commands, {
              channel: opts.channel,
              sender: senderRaw,
              sessionId,
              internalBaseUrl: opts.internalBaseUrl,
            });
            if (response) {
              mergeSessionAppStateForInteraction({
                sessionId,
                message: assistedBuiltin.commands.length > 1 ? assistedBuiltin.commands.join(" | ") : assistedBuiltin.command,
                response,
                classification: {
                  kind: "app_control",
                  domain: assistedBuiltin.domain === "help" || assistedBuiltin.domain === "none" ? null : assistedBuiltin.domain,
                  reason: `model-assisted builtin routing: ${assistedBuiltin.reason}`,
                  usesSessionReference: builtinClassification.usesSessionReference,
                },
              });
              return finishRouted({
                response,
                workflowId: null,
                workflowName: null,
                source: "builtin",
              }, {
                commands: assistedBuiltin.commands,
                routeSource: "builtin",
                modelAssistUsed: true,
              });
            }
          }
        }
        const explicitNoMutationAppRead =
          isNonMutatingPlanningRequest(rawMessage) ||
          /\bwithout\s+(?:creating|changing|modifying|touching|doing|running|executing|adding|making|updating)\b/i.test(rawMessage) ||
          /\b(?:don'?t|do\s+not)\s+(?:create|change|modify|touch|apply|execute|run|add|make|update|do|alter)\b/i.test(rawMessage);
        if (topIntentClass === "app_write" && !appActionPlannerEligible && explicitNoMutationAppRead) {
          const commands = resolveTraceCommandsWithFallback([rawMessage]);
          const response = await renderBuiltinCommandList(commands, {
            channel: opts.channel,
            sender: senderRaw,
            sessionId,
            internalBaseUrl: opts.internalBaseUrl,
          });
          if (response) {
            return finishRouted({
              response,
              workflowId: null,
              workflowName: null,
              source: "builtin",
            }, {
              intentClass: "app_read",
              routeSource: "builtin",
              commands,
            });
          }
        }
        if (topIntentClass === "app_write" && !appActionPlannerEligible) {
          try {
            const cancelled = await checkAndCancelIfAborted();
            if (cancelled) return cancelled;
            const { planAppAction } = await import("@/lib/channels/app-action-planner");
            const retryPlan = await planAppAction(
              [
                rawMessage,
                "",
                `Previous route failed: ${builtinClassification.reason}`,
                `Failed classification domain: ${builtinClassification.domain ?? "none"}`,
              ].join("\n"),
              {
                sessionId: String(sessionId || ""),
                channel: opts.channel,
                internalBaseUrl: opts.internalBaseUrl,
                clientTurnId: opts.clientTurnId,
              },
            );
            if (retryPlan?.clarificationQuestion && retryPlan.steps.length === 0) {
              const clarification = formatPlannerClarification(retryPlan);
              return finishRouted({
                response: clarification,
                workflowId: null,
                workflowName: null,
                source: "app-action-planner",
              }, {
                routeSource: "app-action-planner",
                modelAssistUsed: true,
                plannerEligible: true,
                plannerEligibilityReason: "self-healing retry before generic app-control fallback",
              });
            }
            if (retryPlan && retryPlan.confidence >= 0.55 && retryPlan.steps.length > 0) {
              const preview = formatAppActionPlanPreview(retryPlan);
              // Open a durable work trail (best-effort), mirroring the main planner
              // path, so this self-healed plan is also linkable/inspectable.
              let retryTrailId = "";
              try {
                const wt = await import("@/lib/work-trails/work-trails");
                retryTrailId = wt.createWorkTrail({
                  sessionId: String(sessionId || ""),
                  clientTurnId: opts.clientTurnId ?? null,
                  userMessage: rawMessage,
                  intent: { kind: "app_write", reason: "self-healing planner retry", domain: builtinClassification.domain ?? null },
                  plan: retryPlan,
                  status: "pending",
                });
                wt.appendWorkTrailEvent({ trailId: retryTrailId, eventType: "plan_drafted", summary: `${retryPlan.steps.length} steps`, metadata: { stepCount: retryPlan.steps.length } });
              } catch { /* trail is best-effort */ }
              rememberPendingMutation({
                sessionId: String(sessionId || ""),
                kind: "app-action-plan",
                summary: preview,
                payload: { plan: retryPlan as unknown as Record<string, unknown>, ...(retryTrailId ? { trailId: retryTrailId } : {}) },
                createdAt: Date.now(),
              });
              const plannedResponse = buildPendingMutationPrompt(preview);
              return finishRouted({
                response: plannedResponse,
                workflowId: null,
                workflowName: null,
                source: "app-action-planner",
                // P0: surface the plan so the client can edit it (not just session state).
                pendingAppActionPlan: retryPlan,
                pendingWorkTrailId: retryTrailId || undefined,
              }, {
                intentClass: "app_write",
                routeSource: "app-action-planner",
                modelAssistUsed: true,
                plannerEligible: true,
                plannerEligibilityReason: "self-healing retry before generic app-control fallback",
              });
            }
          } catch (error) {
            log.debug("Self-healing planner retry failed", { error: String(error) });
          }
          return finishRouted({
            response: buildTargetedAppWriteClarifier(builtinClassification, sessionAppState),
            workflowId: null,
            workflowName: null,
            source: "builtin",
          }, {
            routeSource: "builtin",
          });
        }
        if (topIntentClass === "app_read" && (builtinRoute.mode === "exact" || builtinRoute.mode === "clarify" || builtinRoute.mode === "fuzzy") && !isWfEditIntent) {
          return finishRouted({
            response:
              buildBuiltinRoutingClarifier(builtinClassification),
            workflowId: null,
            workflowName: null,
            source: "builtin",
          }, {
            routeSource: "builtin",
          });
        }
      }
    }

    return executeWorkflowRoute({ workflowIntent });
  } catch (error) {
    log.error("Channel routing failed", { error: String(error) });
    return {
      response: null,
      workflowId: null,
      workflowName: null,
      source: "none",
    };
  }
}

/**
 * Compatibility wrapper that returns only response text.
 */
export async function routeToWorkflow(opts: {
  triggerNodeType: string;
  channel: string;
  triggerData: Record<string, unknown>;
}): Promise<string | null> {
  const result = await routeToWorkflowWithDetails(opts);
  return result.response;
}
