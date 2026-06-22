import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import { getSqlite, initializeDatabase } from "@/lib/db";
import { checkRateLimit, getClientIp, getRateLimitConfig } from "@/lib/utils/rate-limit";
import {
  getTelegramStatus,
  startTelegram,
  stopTelegram,
  sendTelegramMessage,
} from "@/lib/channels/telegram";
import {
  getDiscordStatus,
  startDiscord,
  stopDiscord,
  sendDiscordMessage,
} from "@/lib/channels/discord";
import {
  getWhatsAppStatus,
  connectWhatsApp,
  disconnectWhatsApp,
  resetWhatsAppAuth,
  sendWhatsAppMessage,
} from "@/lib/channels/whatsapp";
import {
  getSlackStatus,
  startSlack,
  stopSlack,
  sendSlackMessage,
} from "@/lib/channels/slack";
import {
  getBlueBubblesStatus,
  startBlueBubbles,
  stopBlueBubbles,
  sendBlueBubblesMessage,
} from "@/lib/channels/bluebubbles";
import {
  getTeamsStatus,
  configureTeams,
  sendTeamsMessage,
} from "@/lib/channels/teams";
import { routeToWorkflowWithDetails, updatePendingAppActionPlan, isProtectedBuiltinParserMessage, isExactAppReadBuiltin, isAutomationLiveStateReadRequest, renderAutomationLiveStateResponse, isWebhookSigningHelpRequest, renderWebhookSigningHelpResponse, isBoardTaskListRequest, renderBoardTaskListResponse, isChannelCommandBuiltinRequest, renderChannelCommandBuiltinResponse, renderCompoundChannelCommandBuiltinResponse, isChannelSetupRequest } from "@/lib/channels/router";
import {
  NO_WORKFLOW_FALLBACK_TEXT,
  resolveChannelResponseWithFallback,
  resolveExplicitWorkflowNoMatchText,
} from "@/lib/channels/fallback-assistant";
import {
  bindDiscordHandler,
  bindTelegramHandler,
  bindWhatsAppHandler,
  bindSlackHandler,
  bindBlueBubblesHandler,
  bindTeamsHandler,
} from "@/lib/channels/runtime";
import { presentChannelResponse } from "@/lib/channels/presentation";
import { broadcastEvent } from "@/lib/ws/broadcast";
import { scheduleSessionIndex } from "@/lib/memory/session-watcher";
import { defaultChannelAgentId, persistChannelMessage } from "@/lib/channels/transcript";
import { createProvenance } from "@/lib/provenance";
import { runByTheWayQuestion } from "@/lib/channels/btw";
import {
  getChannelSessionSettings,
  resolveChannelSessionAgentId,
  upsertChannelSessionSettings,
} from "@/lib/channels/session-settings";
import { getChannelSessionAppState } from "@/lib/channels/session-app-state";
import {
  clearCompletedSessionTodos,
  createSessionTodo,
  deleteSessionTodo,
  listSessionTodos,
  updateSessionTodo,
} from "@/lib/channels/session-todos";
import { listRecentChannelTargets } from "@/lib/channels/directory";
import {
  approveChannelPairing,
  approveChannelSender,
  denyChannelPairing,
  getChannelAccessOverview,
  setChannelAccessMode,
  revokeChannelSender,
} from "@/lib/channels/access";
import { readCappedJson, RequestBodyTooLargeError } from "@/lib/security/body";
import {
  isLoopbackHostname,
  requireOperatorAccess,
  resolveRequestHostname,
} from "@/lib/security/admin";
import { logger } from "@/lib/utils/logger";
import { resetStaleProcessingTurns, processQueuedWebChatTurn, persistProgressEvent } from "@/lib/channels/turn-worker";
import { abortTurn } from "@/lib/channels/turn-abort-registry";
import { routeRequestSmart } from "@/lib/agents/smart-routing";
import { classifyWebChatIntent } from "@/lib/channels/webchat-intent";
import { buildUnknownToolResponse } from "@/lib/channels/tool-catalog-response";
import { handleBoardRequest } from "@/lib/channels/app-surface-handlers/boards";
import { handleCouncilRequest } from "@/lib/channels/app-surface-handlers/council";
import { handleHierarchyRequest } from "@/lib/channels/app-surface-handlers/hierarchy";
import { handleSessionRequest } from "@/lib/channels/app-surface-handlers/session";
import { handleWorkflowRequest } from "@/lib/channels/app-surface-handlers/workflows";
import { shouldModelEnrichAppSurface } from "@/lib/channels/app-surface-handlers/contract";
import { buildDisp8chSystemMap } from "@/lib/channels/disp8ch-system-map";
import { resolveWorkspaceReadResponse } from "@/lib/channels/workspace-read-handlers";
import { hasLeakedToolMarkup, hasLeakedToolMarkupDeep, buildMarkupFallbackResponse } from "@/lib/channels/tool-markup-guard";
import { isRepoInspectRequest, buildRepoMap, isRootWorkspaceExplanationRequest } from "@/lib/channels/repo-inspection-lane";
import { classifyDeepInspectionRequest } from "@/lib/channels/deep-inspection-arbiter";
import { buildBroadSynthesisContext, shouldUseBroadSynthesisContext } from "@/lib/channels/broad-synthesis-context";
import { evaluateDeepAnswerContract } from "@/lib/channels/deep-answer-contract";
import { isRawCliHelpOrToolDump } from "@/lib/channels/tool-output-sanitizer";
import {
  collectRepoInspectionEvidence,
  mergeRepoInspectionEvidence,
  planDeepAuditExpansion,
  repoEvidenceToLedger,
  type RepoInspectionEvidence,
} from "@/lib/channels/repo-inspection-controller";
import {
  evaluateRepoEvidenceContract,
  formatEvidenceContractRepairInstruction,
} from "@/lib/channels/evidence-contract";
import { classifyDeepAudit } from "@/lib/channels/deep-audit-profile";
import { buildDeepAuditOutline } from "@/lib/channels/deep-audit-outline";
import { synthesizeDeepAuditAnswer, buildFallbackDeepAuditAnswer } from "@/lib/channels/deep-audit-synthesizer";
import { enrichDeepSynthesisAnswer, shouldEnrich, classifyDepthTier, type DepthTier } from "@/lib/channels/deep-synthesis-enricher";
import { evaluateDeepAuditContract } from "@/lib/channels/deep-audit-contract";
import { buildProviderOperationalGuidance } from "@/lib/agents/provider-operational-guidance";
import { evaluateAnswerQuality } from "@/lib/channels/answer-quality-gate";
import { isLikelyBroadResearchPrompt, isSessionOnlyDirectAnswerPrompt, needsCurrentPublicFacts } from "@/lib/channels/broad-research-prompt";
import {
  buildCodeChangeSystemPrompt,
  buildCodeReviewSystemPrompt,
  isCodeChangeRequest,
  isCodeReviewRequest,
} from "@/lib/channels/code-task-lane";
import { getModelConfig } from "@/lib/agents/model-router";
import { executeTool } from "@/lib/engine/tools";
import { deleteSecret, upsertSecret } from "@/lib/secrets/store";
import { classifyBroadTask, shouldBypassBroadSynthesisForComposition, isFastCompositionTask, taskKindToLabel } from "@/lib/channels/broad-task-decision";
import { collectBroadEvidence, mergeBroadEvidenceWithModelToolLedger, type BroadEvidencePack } from "@/lib/channels/broad-evidence-controller";
import { evaluateBroadAnswerContract, formatBroadContractRepairInstruction, shouldAcceptRepairedAnswer } from "@/lib/channels/broad-answer-contract";
import { buildSkillPackPrompt } from "@/lib/channels/skill-pack-registry";
import { sanitizeFinalAnswer } from "@/lib/channels/final-answer-sanitizer";
import { evaluateOutputQuality } from "@/lib/channels/output-quality-contract";
import { synthesizeEvidenceRichAnswer, shouldSynthesizeEvidenceRich, shouldSkipSynthesis, buildSynthesisRequirements } from "@/lib/channels/evidence-rich-synthesis";
import { expandDepthDeterministically } from "@/lib/channels/deterministic-depth-expander";
import { buildWebResearchEvidenceAnswer } from "@/lib/channels/web-research-finalizer";
import { polishWebResearchAnswer } from "@/lib/channels/web-research-answer-polisher";
import {
  buildCapabilityAuditResponse,
  buildImageGenerationUnavailableResponse,
  buildYoutubeTranscriptUnavailableResponse,
  imageGenerationArgsForPrompt,
  isCapabilityAuditPrompt,
  isImageFallbackConfirm,
  isImageGenerationPrompt,
  isYoutubeTranscriptPrompt,
  resolveImageGenerationConfig,
} from "@/lib/channels/capability-audit";
import { runBrowserImageFallback } from "@/lib/channels/browser-image-fallback";
import { buildWebchatSystemPromptParts } from "@/lib/channels/webchat-system-prompt";
import { determineTaskIntentContract } from "@/lib/channels/task-intent-contract";
import { applyRequestedOutputShape } from "@/lib/channels/output-shape-contract";
import { evaluateSimpleCalculation } from "@/lib/channels/simple-calculator";
import { enforceExplicitFormat, extractExplicitFormatConstraint } from "@/lib/channels/universal-answer-shape";
import { buildTurnPlanFromContract, buildTurnPlanWithLlm, shouldUseLlmTurnPlanner } from "@/lib/channels/turn-planner";
import { arbitrateRouting } from "@/lib/channels/routing-arbiter";
import {
  isCrossSurfaceAppMutationRequest,
  isBoardTaskMutationRequest,
} from "@/lib/channels/cross-tab-intent";
import { isWorkflowActivationMutationIntent, isWorkflowChannelWriteIntent, isWorkflowNodeEditMutationIntent } from "@/lib/channels/app-action-eligibility";
import { runToolHeavyEvidenceCollection, buildToolHeavyEvidencePrompt, buildToolHeavyContractFallbackAnswer } from "@/lib/channels/tool-heavy-evidence-controller";
import { evaluateToolHeavyAnswerContract } from "@/lib/channels/tool-heavy-answer-contract";

export const dynamic = "force-dynamic";
const log = logger.child("api:channels");

function shouldUseWebChatAppActionLane(raw: string): boolean {
  const value = String(raw || "").trim();
  if (!value) return false;
  if (isChannelSetupRequest(value)) return true;
  if (isBoardTaskMutationRequest(value)) return true;
  if (isCrossSurfaceAppMutationRequest(value)) return true;
  // Workflow node-config edits ("change a node's prompt/url/model in workflow X") are
  // confirmation-gated structured mutations — route them through the app-action lane.
  if (isWorkflowActivationMutationIntent(value)) return true;
  if (isWorkflowChannelWriteIntent(value)) return true;
  if (isWorkflowNodeEditMutationIntent(value)) return true;
  const appSurface =
    /\b(?:org(?:anization)?s?|hierarchy|teams?|crews?|agents?|boards?|tasks?|workflows?|flows?|automations?|channels?|schedules?|cron|goals?|objectives?|milestones?|templates?)\b/i.test(value);
  const writeOrSetup =
    /\b(?:create|make|build|add|connect|schedule|set\s*up|setup|assemble|prepare|configure|improve|fix|optimi[sz]e|put|assign|link|attach|apply|switch|change|update|rename|run|execute|have)\b/i.test(value);
  const peopleDirectedHandoff =
    /\b(?:have|ask|get|run|let)\s+(?:the\s+)?(?:team|council|org(?:anization)?|crew|agents?|analysts?|researchers?)\s+(?:to\s+)?(?:debate|discuss|deliberate|coordinate|route|assign)\b/i.test(value) &&
    /\b(?:record|track|put|create|make|add|save)\b/i.test(value) &&
    /\b(?:decision|verdict|result|output|task|board|handoff)\b/i.test(value);
  const optimizeAppOps =
    /\boptimi[sz]e\b/i.test(value) &&
    /\b(?:workflows?|agents?|boards?|tasks?|org(?:anization)?s?)\b/i.test(value);
  return appSurface && writeOrSetup && (peopleDirectedHandoff || optimizeAppOps || /\b(?:org(?:anization)?|hierarchy|goals?|teams?|crews?)\b/i.test(value));
}

// Cross-surface and board-task mutation detection now live in the shared
// cross-tab intent layer (single source of truth). See cross-tab-intent.ts.

function buildHypotheticalWorkflowPreview(raw: string): string | null {
  const value = String(raw || "").trim();
  if (!/\b(?:what\s+would\s+happen|show\s+me\s+what\s+would\s+happen|hypothetical|pretend)\b/i.test(value)) return null;
  const match = value.match(/\bworkflow\s+called\s+["\u201C]?(.+?)["\u201D]?(?:\s*$|[?.!,;])/i);
  if (!match?.[1]?.trim()) return null;
  const name = match[1].trim();
  return [
    "Dry-run preview only. Nothing was saved, scheduled, run, or changed.",
    "",
    `If you asked me to build a workflow named "${name}", I would prepare a confirmation-gated app plan first.`,
    "Likely steps:",
    "1. Pick or ask for the closest workflow template.",
    "2. Draft the workflow name and starting node configuration.",
    "3. Show an editable pending plan.",
    "4. Wait for an explicit \"confirm\" before creating anything.",
  ].join("\n");
}

function isVagueAppOpsOptimizationRequest(raw: string): boolean {
  const value = String(raw || "").trim();
  return (
    /\boptimi[sz]e\b/i.test(value) &&
    /\b(?:workflows?|automations?|agents?|boards?|tasks?|org(?:anization)?s?)\b/i.test(value) &&
    !/\b(?:confirm|apply|do it|run it|execute|change|update|delete|remove|reset)\b/i.test(value)
  );
}

const pendingImageFallbackForSession = new Map<string, { shape: string; prompt: string; at: number }>();

function clearStaleImageFallbacks() {
  const now = Date.now();
  for (const [sessionId, entry] of pendingImageFallbackForSession) {
    if (now - entry.at > 300_000) pendingImageFallbackForSession.delete(sessionId);
  }
}



// Per-session lock: prevents concurrent workflow execution for the same chat session.
// Maps sessionId → true when a response is in-flight.
const sessionProcessing = new Map<string, boolean>();
const turnStreamBuffers = new Map<string, { content: string; timer: ReturnType<typeof setTimeout> | null }>();
const STREAM_FLUSH_INTERVAL_MS = 350;
const STREAM_FLUSH_CHARS = 1600;

function isEmptyWorkspaceFallback(response: string): boolean {
  return /^\s*I['’]m here and ready to help with your workspace\. What would you like to do\?\s*$/i.test(response);
}

function requestedLineCount(message: string): number | null {
  const match = message.match(/\b(?:exactly\s+)?(\d{1,2})[-\s]?(?:line|sentence)s?\b/i);
  if (!match) return null;
  const count = Number(match[1]);
  return Number.isFinite(count) && count > 0 && count <= 20 ? count : null;
}

function normalizeExactLineResponse(answer: string, message: string): string {
  const expected = requestedLineCount(message);
  if (!expected) return answer;
  const lines = answer.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === expected) return answer;
  const nonHeading = lines.filter((line) => !/^\s{0,3}#{1,6}\s+\S/.test(line) && !/^\*\*[^*]{1,80}\*\*:?$/.test(line));
  if (nonHeading.length === expected) return nonHeading.join("\n");
  const bulletLines = lines.filter((line) => /^\s*(?:[-*]\s+|\d+\.\s+)/.test(line));
  if (bulletLines.length === expected) {
    return bulletLines.map((line) => line.replace(/^\s*(?:[-*]\s+|\d+\.\s+)/, "")).join("\n");
  }
  return answer;
}

function rootEntryPurpose(name: string, isDir: boolean): string {
  const normalized = name.replace(/\/$/, "");
  const purposes: Record<string, string> = {
    src: "main Next.js application source: operator UI, API routes, channel routing, agent logic, and reusable app libraries.",
    scripts: "regression, benchmark, setup, and diagnostic scripts used to validate disp8ch AI behavior outside the UI.",
    docs: "implementation notes, comparison artifacts, screenshots, and improvement reports from prior engineering work.",
    agents: "agent workspace/persona files that shape how the default assistant starts, remembers, and uses tools.",
    server: "standalone runtime services such as the WebSocket server used by the app during local operation.",
    extensions: "bundled extension packs that expand app/tool capability surfaces.",
    "optional-skills": "skill packs that can be enabled without being part of the core startup set.",
    skills: "core local skill definitions used by agents and channel lanes.",
    public: "static assets served by the Next.js app.",
    data: "local runtime data, SQLite state, run logs, and generated operational artifacts.",
    package: "project metadata, npm scripts, and dependency declarations.",
    "package.json": "project metadata, npm scripts, and dependency declarations.",
    "pnpm-lock.yaml": "pinned pnpm dependency graph for repeatable installs.",
    "package-lock.json": "npm lockfile retained for npm-based installs or compatibility checks.",
    "next.config.mjs": "Next.js runtime/build configuration.",
    "tsconfig.json": "TypeScript compiler configuration.",
    "tailwind.config.ts": "Tailwind design token and content scanning configuration.",
    "drizzle.config.ts": "database migration/schema tooling configuration.",
    "README.md": "top-level project orientation and setup notes.",
    "CORE_ARCHITECTURE_EXPLANATION.md": "repo-specific architecture summary useful before deeper code inspection.",
    "AGENTS.md": "agent startup instructions and local operating rules.",
    "SOUL.md": "assistant behavior/personality guidance loaded at session startup.",
    "USER.md": "user preference/context file loaded at session startup.",
    "IDENTITY.md": "assistant identity/context file loaded at session startup.",
    "TOOLS.md": "tool usage guidance loaded at session startup.",
    "MEMORY.md": "durable memory entries with status markers.",
  };
  return purposes[normalized] ?? (isDir
    ? "project directory; inspect it before making detailed behavior claims."
    : "project file; read it before relying on its contents for a specific claim.");
}

function buildRootWorkspaceExplanationResponse(evidence: RepoInspectionEvidence): string {
  const cwd = process.cwd();
  let entries: Array<{ name: string; isDir: boolean }> = [];
  try {
    entries = fs.readdirSync(cwd, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith(".") && !["node_modules", ".next", ".git", "tmp"].includes(entry.name))
      .map((entry) => ({ name: entry.name, isDir: entry.isDirectory() }));
  } catch {
    entries = [];
  }
  const importantDirs = ["src", "scripts", "docs", "agents", "server", "extensions", "skills", "optional-skills", "public", "data"]
    .map((name) => entries.find((entry) => entry.name === name))
    .filter((entry): entry is { name: string; isDir: boolean } => Boolean(entry));
  const importantFiles = ["package.json", "README.md", "CORE_ARCHITECTURE_EXPLANATION.md", "AGENTS.md", "SOUL.md", "USER.md", "IDENTITY.md", "TOOLS.md", "MEMORY.md", "next.config.mjs", "tsconfig.json", "tailwind.config.ts", "drizzle.config.ts"]
    .map((name) => entries.find((entry) => entry.name === name))
    .filter((entry): entry is { name: string; isDir: boolean } => Boolean(entry));

  const lines = [
    "## Repository Root",
    "",
    `Read-only inspection of \`${cwd}\`. No files were modified.`,
    "",
    "## Important Folders",
    ...importantDirs.map((entry) => `- \`${entry.name}/\`: ${rootEntryPurpose(entry.name, true)}`),
    "",
    "## Important Files",
    ...importantFiles.map((entry) => `- \`${entry.name}\`: ${rootEntryPurpose(entry.name, false)}`),
    "",
    "## Evidence",
    `- Tool pass: ${evidence.metrics.listCalls} list calls, ${evidence.metrics.searchCalls} searches, ${evidence.metrics.readCalls} verified file reads.`,
    ...evidence.filesRead.slice(0, 6).map((file) => `- Read: \`${file}\``),
    "",
    "## Verification Notes",
    "- Folder/file purposes above are grounded in names plus the root/package/startup files read in this pass.",
    "- For behavior-level claims about a specific implementation file, run a targeted read of that file first.",
  ];
  return lines.join("\n");
}

function applyQualityGates(response: string, message: string): string {
  response = sanitizeFinalAnswer(response).answer || response;
  response = applyRequestedOutputShape(response, message);
  response = enforceExplicitFormat(response, extractExplicitFormatConstraint(message)).answer;
  const explicitlyReadOnlyPlan =
    /\b(?:do\s+not|don't)\s+(?:create|save|schedule|run|execute|send|change|update|modify|delete)\b/i.test(message) ||
    /\b(?:plan|design|describe)\s+(?:only|it)\b/i.test(message) ||
    /\bwithout\s+(?:creating|saving|scheduling|running|executing|sending|changing|updating|modifying|deleting)\b/i.test(message);
  const acknowledgesNoMutation =
    /\b(?:not\s+creating|not\s+created|not\s+saving|not\s+saved|not\s+scheduling|not\s+scheduled|not\s+running|not\s+executed|not\s+changing|not\s+modified|nothing\s+(?:was|has been)\s+(?:created|saved|scheduled|run|executed|changed|modified)|i\s+(?:have\s+)?not\s+(?:created|saved|scheduled|run|executed|changed|modified))\b/i.test(response);
  if (explicitlyReadOnlyPlan && !acknowledgesNoMutation) {
    const firstLine = response.split(/\n+/).find((line) => line.trim().length > 0)?.trim() ?? "";
    const startsWithVerdict =
      /\b(?:recommendation|release-ready|not release-ready|implemented|configured|missing|use|yes|no)\b/i.test(firstLine) &&
      !/^(?:#{1,6}\s|\|)/.test(firstLine);
    const readOnlyNote = "Read-only boundary: I have not created, saved, scheduled, run, or changed anything.";
    response = startsWithVerdict
      ? `${response.trim()}\n\n${readOnlyNote}`
      : `${readOnlyNote}\n\n${response}`;
  }
  const pureWorkspaceList = /^\s*(?:please\s+)?(?:list|show(?: me)?|display|print|what(?:'s| is| are)?)\b[\s\S]{0,80}\b(?:files?|folders?|director(?:y|ies)|workspace\s+contents?|workspace\s+structure|repo\s+structure|project\s+structure)\s*\??\s*$/i.test(message);
  if (/no active workflow matched/i.test(response) && pureWorkspaceList) {
    return "I found these files in the workspace. You can browse them at /files or ask me to read specific files.";
  }
  if (response.length < 20 && /list.*files|show.*files|what.*files|inspect.*workspace/i.test(message)) {
    return "I was unable to produce a clean file listing. You can view files at /files, or ask me to list files in a specific directory.";
  }
  const prose = response.replace(/```[\s\S]*?```/g, " ").replace(/`[^`]*`/g, " ");
  if (/<｜｜DSML｜｜tool_calls>|(^|\n)\s*<tool_call\b|(^|\n)\s*<invoke\s+name=/i.test(prose)) {
    return "I was unable to produce a clean response. Please try rephrasing your request.";
  }
  return response;
}

function guardEmptyAnswer(content: string, ctx?: { didMemoryStore?: boolean }): string {
  if (content && content.trim()) return content;
  return ctx?.didMemoryStore ? "Saved." : "Done.";
}

function buildRepoInspectionRecoveryResponse(message: string, repoMap: string): string {
  const likelyFiles = repoMap
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*]\s*/, ""))
    .filter((line) => /\b(?:src\/app|src\/components|src\/lib|package\.json|tailwind|styles|globals\.css)\b/i.test(line))
    .slice(0, 8);
  const files = likelyFiles.length > 0
    ? likelyFiles
    : [
      "src/app - app routes and page/layout entry points",
      "src/components - reusable UI components",
      "src/lib - shared runtime helpers",
      "package.json - dependency and script changes",
    ];
  return [
    "## Repo Inspection Recovery",
    "Model-led synthesis was unavailable or rejected. The entries below come from the repository map and are candidates for targeted inspection, not proof of behavior.",
    "",
    "Candidate files:",
    ...files.map((file) => `- ${file}`),
    "",
    "## Evidence Limits",
    "- Evidence was insufficient to ground the requested diagnosis or implementation plan.",
    "- No case-specific fix, architecture claim, or test recommendation is asserted by this fallback.",
    "- Read the relevant candidates and retry model-led synthesis before changing code.",
    "",
    `Request covered: ${message}`,
  ].join("\n");
}

function buildRepoInspectionContractFallbackResponse(message: string, evidence: RepoInspectionEvidence): string {
  const verifiedFiles = Array.from(new Set(evidence.filesRead.filter(Boolean))).slice(0, 12);
  const searchSignals = Array.from(new Set(evidence.searchesRun.filter(Boolean))).slice(0, 8);
  return [
    "## Repo Inspection Recovery",
    "Model-led synthesis was unavailable or rejected. This response reports collected evidence only and does not invent a diagnosis, implementation plan, or test result.",
    "",
    `Request: ${String(message || "").trim().slice(0, 500)}`,
    "",
    "## Verified File Reads",
    ...(verifiedFiles.length > 0
      ? verifiedFiles.map((path) => `- \`${path}\``)
      : ["- No verified file reads were available."]),
    ...(searchSignals.length > 0
      ? ["", "## Search Signals (Candidates, Not Proof)", ...searchSignals.map((query) => `- \`${query}\``)]
      : []),
    "",
    "## Evidence Limits",
    `- Repo preflight completed ${evidence.metrics.readCalls} read(s), ${evidence.metrics.searchCalls} search(es), and ${evidence.metrics.listCalls} list call(s).`,
    "- Search and listing results are discovery hints only; behavior claims require verified reads.",
    "- Retry agentic synthesis or perform targeted reads before changing code.",
  ].join("\n");
}

function buildBroadSynthesisRecoveryResponse(message: string): string {
  return [
    "Agentic synthesis was unavailable or rejected, so I cannot provide a grounded answer from a canned fallback.",
    "No app objects were created, changed, scheduled, sent, or executed.",
    `Request: ${String(message || "").trim().slice(0, 500)}`,
    "Retry after checking the active model/provider, or narrow the request so the required evidence can be gathered and synthesized reliably.",
  ].join("\n\n");
}

function buildWorkflowDesignContractFallbackResponse(message: string): string {
  return [
    "The model-led workflow design did not complete, so no topology or node plan is being fabricated.",
    "Nothing was created, saved, scheduled, sent, or executed.",
    `Request: ${String(message || "").trim().slice(0, 500)}`,
    "Retry with an active model. A valid design must be generated from the current node registry and then pass the workflow answer contract before it is shown.",
  ].join("\n\n");
}

function asksForDeterministicDepthEnrichment(message: string): boolean {
  return /\b(?:detailed|thorough|comprehensive|in-depth|deep\s+dive|deeply|more\s+depth|richer|full\s+breakdown|decision-ready|not\s+shallow|avoid\s+shallow|as\s+good\s+as|better\s+than)\b/i.test(
    message,
  );
}

function asksForSpeedOverDepth(message: string): boolean {
  return /\b(?:quick(?:ly)?|briefly|in\s+brief|short(?:ly)?|one[-\s]liner|tl;?dr|just\s+(?:a\s+)?(?:list|summary|sketch)|concise(?:ly)?|fast\s+answer|keep\s+it\s+(?:short|brief|simple))\b/i.test(
    message,
  );
}

function parseExplicitSourceQuestion(message: string): { kind: "notebook" | "document"; id: string; query: string } | null {
  const raw = String(message || "").trim();
  if (!raw) return null;
  const notebookMatch = raw.match(/\bnotebook\b[\s\S]{0,80}\bid\s*:\s*([A-Za-z0-9_-]{6,})/i);
  const documentMatch = raw.match(/\b(?:data\s+source|document|source)\b[\s\S]{0,80}\bid\s*:\s*([A-Za-z0-9_-]{6,})/i);
  const kind = notebookMatch?.[1] ? "notebook" : documentMatch?.[1] ? "document" : null;
  const id = notebookMatch?.[1] || documentMatch?.[1] || "";
  if (!kind || !id) return null;
  if (!/\b(?:answer|ask|search|find|summari[sz]e|explain|what|which|why|how|tell\s+me)\b/i.test(raw)) return null;
  if (/<type\s+your\s+question\s+here>/i.test(raw)) {
    return { kind, id, query: "" };
  }
  const query = raw
    .replace(/\b(?:Use|Search)\s+(?:the\s+stored\s+)?(?:notebook|data\s+source|document|source)\b[\s\S]{0,140}?\b(?:with\s+citations\s*)?:/i, " ")
    .replace(/\b(?:notebook|data\s+source|document|source)\b[\s\S]{0,80}\bid\s*:\s*[A-Za-z0-9_-]{6,}/gi, " ")
    .replace(/\b(?:answer|ask|search|find)\s+(?:this|my\s+question)?\s*(?:from|over|in)?\s*(?:its|the)?\s*(?:enabled\s+)?(?:sources?)?\s*(?:with\s+citations)?\s*:/i, " ")
    .replace(/<type\s+your\s+question\s+here>/gi, " ")
    .trim();
  return { kind, id, query };
}

async function enrichDeterministicDraftForDepth(params: {
  userMessage: string;
  draft: string;
  routeSource: string;
  requiredSections?: string[];
  /** Listings/status reads: only enrich when the user explicitly asks for depth. */
  requireExplicitDepth?: boolean;
  provider: ReturnType<typeof getModelConfig>["provider"];
  modelId: string;
  apiKey: string;
  baseUrl?: string | null;
}): Promise<{ answer: string; diagnostics: Record<string, unknown> }> {
  // Depth-by-default policy: design/analysis answers from deterministic
  // preflight routes get one bounded enrichment pass even without explicit
  // depth wording. Explicit speed wording keeps the fast compact draft;
  // explicit depth wording upgrades the budget tier.
  const explicitDepth = asksForDeterministicDepthEnrichment(params.userMessage);
  if (asksForSpeedOverDepth(params.userMessage) && !explicitDepth) {
    return { answer: params.draft, diagnostics: { attempted: false, reason: "user asked for speed/brevity" } };
  }
  if (params.requireExplicitDepth && !explicitDepth) {
    return { answer: params.draft, diagnostics: { attempted: false, reason: "listing/status read; no explicit depth request" } };
  }

  const classified = classifyDepthTier(params.userMessage, null);
  // Without explicit depth wording, use the base "normal" tier (bounded
  // 45s/4k-token budget); explicit wording upgrades to thorough/exhaustive.
  const depthTier: DepthTier = explicitDepth
    ? (classified === "normal" ? "thorough" : classified)
    : "normal";
  const enrichment = await enrichDeepSynthesisAnswer({
    userMessage: params.userMessage,
    safeAnswer: params.draft,
    evidencePromptBlock: [
      "Deterministic preflight draft:",
      params.draft,
      "",
      "The draft is the authoritative source. Expand only by explaining the same facts and workflow/source-management concepts.",
      "Do not invent source content, file line references, live state, or completed side effects.",
    ].join("\n"),
    routeSource: `${params.routeSource}:depth-enrichment`,
    depthTier,
    requiredSections: params.requiredSections ?? [],
    provider: params.provider,
    modelId: params.modelId,
    apiKey: params.apiKey,
    baseUrl: params.baseUrl,
  });
  const diagnostics: Record<string, unknown> = {
    attempted: true,
    usedModel: enrichment.usedModel,
    depthTier,
    ...enrichment.diagnostics,
  };
  if (!enrichment.usedModel || !enrichment.answer.trim()) {
    return { answer: params.draft, diagnostics: { ...diagnostics, applied: false, reason: "model unavailable or empty" } };
  }

  const sanitized = sanitizeFinalAnswer(enrichment.answer);
  const candidate = applyQualityGates(sanitized.answer.trim(), params.userMessage);
  if (sanitized.leaked || hasLeakedToolMarkup(candidate)) {
    return { answer: params.draft, diagnostics: { ...diagnostics, applied: false, reason: "sanitizer rejected markup leak" } };
  }
  if (candidate.length < params.draft.length * 0.85) {
    return { answer: params.draft, diagnostics: { ...diagnostics, applied: false, reason: "enriched answer was thinner than draft" } };
  }

  return { answer: candidate, diagnostics: { ...diagnostics, applied: true, answerChars: candidate.length } };
}

function buildWebResearchRecoveryResponse(message: string, evidence?: BroadEvidencePack | null): string {
  return buildWebResearchEvidenceAnswer(message, evidence);
}

function resolveAppSurfaceResponse(
  message: string,
  surface?: string,
  sessionCtx?: {
    modelId?: string;
    provider?: string;
    workspacePath?: string;
    fastMode?: boolean;
    toolMode?: string;
    readOnly?: boolean;
  },
): string | null {
  switch (surface) {
    case "boards":
      return handleBoardRequest(message);
    case "council":
      return handleCouncilRequest(message);
    case "hierarchy":
      return handleHierarchyRequest(message);
    case "workflows":
      return handleWorkflowRequest(message);
    case "designs":
      if (/\b(show|open|go\s+to|navigate\s+to|take\s+me\s+to)\b/i.test(message)) {
        return "Opening Design Studio at /designs. You can create, preview, edit, validate, version, and export HTML artifacts there.";
      }
      if (/\b(list|what)\b/i.test(message) && /\bdesign/i.test(message)) {
        return "Design projects are listed in the Design Studio rail at /designs. Ask WebChat to create or update a design when you want a persistent artifact.";
      }
      return null;
    case "settings":
      return handleSessionRequest(message, sessionCtx);
    default:
      return surface ? null : handleSessionRequest(message, sessionCtx);
  }
}

function parseSessionVisibility(sessionId: string) {
  const parts = sessionId.split(":");
  if (parts.length >= 2 && parts[0]) {
    const sender = parts.slice(1).join(":");
    return {
      channel: parts[0],
      senderLabel: sender || "unknown sender",
      deliveryState: parts[0] === "webchat" ? "webchat" : "external channel",
    };
  }
  return {
    channel: "webchat",
    senderLabel: "local operator",
    deliveryState: "webchat",
  };
}

function restrictedToolModeBlockReason(message: string): string | null {
  const lowered = message.toLowerCase();
  const riskyPatterns = [
    /\b(shell|terminal|bash|powershell|cmd\.exe)\b/,
    /\b(git\s+(push|reset|checkout|clean|rebase|merge)|delete\s+(file|folder|directory)|rm\s+-|drop\s+table)\b/,
    /\b(sql|database|db\s+query|run\s+command|execute\s+script|write\s+file|edit\s+file)\b/,
  ];
  return riskyPatterns.some((pattern) => pattern.test(lowered))
    ? "Restricted tool mode blocked this high-risk tool request. Switch Tool Mode to Default or Full for this session, then resend it."
    : null;
}

function readObjectJson(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function summarizeValue(value: unknown, max = 180): string {
  if (value == null) return "";
  if (typeof value === "string") return value.trim().slice(0, max);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value).slice(0, max);
  } catch {
    return String(value).slice(0, max);
  }
}

function executionNodeCategory(type: string): "browser" | "council" | "memory" | "tool" | "workflow" {
  const normalized = type.toLowerCase();
  if (normalized.includes("browser") || normalized.includes("web-search") || normalized.includes("document-tool")) return "browser";
  if (normalized.includes("council")) return "council";
  if (normalized.includes("memory")) return "memory";
  if (
    normalized.includes("tool") ||
    normalized.includes("file") ||
    normalized.includes("http") ||
    normalized.includes("code") ||
    normalized.includes("database") ||
    normalized.includes("clipboard") ||
    normalized.includes("board-task")
  ) return "tool";
  return "workflow";
}

function buildNodeOutputSummary(output: Record<string, unknown>, error?: string | null): string {
  if (error) return `error: ${error}`.slice(0, 240);
  for (const key of ["response", "content", "summary", "message", "path", "action"]) {
    const text = summarizeValue(output[key], 220);
    if (text) return text;
  }
  if (output.written === true && typeof output.path === "string") return `wrote ${output.path}`;
  if (output.task && typeof output.task === "object") {
    const task = output.task as Record<string, unknown>;
    return `task ${String(task.title ?? task.id ?? "created")}`;
  }
  return "completed";
}

function buildExecutionSummary(workflowId: string | null | undefined, sessionId: string): Record<string, unknown> | null {
  if (!workflowId) return null;
  try {
    const db = getSqlite();
    const rows = db
      .prepare(
        `SELECT e.id, e.status, e.trigger_data, e.provenance, e.node_results, e.started_at, w.nodes, w.name AS workflow_name
         FROM executions e
         LEFT JOIN workflows w ON w.id = e.workflow_id
         WHERE e.workflow_id = ?
         ORDER BY e.started_at DESC
         LIMIT 8`,
      )
      .all(workflowId) as Array<{
        id: string;
        status: string;
        trigger_data: string | null;
        provenance: string | null;
        node_results: string | null;
        started_at: string;
        nodes: string | null;
        workflow_name: string | null;
      }>;
    const row = rows.find((candidate) => {
      const triggerData = readObjectJson(candidate.trigger_data);
      const provenance = readObjectJson(candidate.provenance);
      return String(triggerData?.sessionId ?? provenance?.sessionId ?? "").trim() === sessionId;
    }) ?? rows[0];
    if (!row) return null;
    const results = readObjectJson(row.node_results);
    if (!results) return null;
    let nodes: Array<{ id?: string; type?: string; data?: Record<string, unknown> }> = [];
    try {
      const parsedNodes = JSON.parse(row.nodes || "[]") as unknown;
      nodes = Array.isArray(parsedNodes) ? parsedNodes as typeof nodes : [];
    } catch {
      nodes = [];
    }
    const nodeLookup = new Map(nodes.map((node) => [String(node.id || ""), node]));
    const entries = Object.entries(results).map(([nodeId, rawResult]) => {
      const result = rawResult && typeof rawResult === "object" ? rawResult as Record<string, unknown> : {};
      const node = nodeLookup.get(nodeId);
      const type = String(node?.type || "node");
      const output = result.output && typeof result.output === "object" ? result.output as Record<string, unknown> : {};
      const error = typeof result.error === "string" ? result.error : null;
      return {
        nodeId,
        type,
        label: String(node?.data?.label || nodeId),
        category: executionNodeCategory(type),
        status: error ? "failed" : "completed",
        durationMs: typeof result.duration === "number" ? result.duration : null,
        summary: buildNodeOutputSummary(output, error),
      };
    });
    if (entries.length === 0) return null;
    const counts = entries.reduce<Record<string, number>>((acc, entry) => {
      acc[entry.category] = (acc[entry.category] ?? 0) + 1;
      return acc;
    }, {});
    return {
      executionId: row.id,
      workflowId,
      workflowName: row.workflow_name,
      status: row.status,
      startedAt: row.started_at,
      counts,
      entries: entries.slice(0, 12),
    };
  } catch (error) {
    log.warn("Failed to build execution summary", { workflowId, sessionId, error: String(error) });
    return null;
  }
}

function getPendingMutationTtlMsForDebug(): number {
  try {
    const row = getSqlite()
      .prepare("SELECT pending_mutation_ttl_ms FROM app_config LIMIT 1")
      .get() as { pending_mutation_ttl_ms?: number | null } | undefined;
    const value = row?.pending_mutation_ttl_ms;
    if (typeof value === "number" && Number.isFinite(value) && value >= 1000) return value;
  } catch {
    // best-effort debug helper
  }
  return 15 * 60 * 1000;
}

async function waitForSessionSlot(sessionId: string, timeoutMs = 25_000) {
  const startedAt = Date.now();
  while (sessionProcessing.get(sessionId)) {
    if (Date.now() - startedAt >= timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return true;
}

function flushTurnStream(clientTurnId: string) {
  const entry = turnStreamBuffers.get(clientTurnId);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  turnStreamBuffers.delete(clientTurnId);
  if (!entry.content) return;
  try {
    getSqlite()
      .prepare(
        `UPDATE channel_session_turns
         SET stream_content = COALESCE(stream_content, '') || ?, updated_at = ?
         WHERE client_turn_id = ?`,
      )
      .run(entry.content, new Date().toISOString(), clientTurnId);
  } catch {
    // Streaming persistence is best effort; the final turn response is still authoritative.
  }
}

function appendTurnStream(clientTurnId: string, token: string) {
  if (!token) return;
  const entry = turnStreamBuffers.get(clientTurnId) ?? { content: "", timer: null };
  entry.content += token;
  turnStreamBuffers.set(clientTurnId, entry);
  if (entry.content.length >= STREAM_FLUSH_CHARS) {
    flushTurnStream(clientTurnId);
    return;
  }
  if (!entry.timer) {
    entry.timer = setTimeout(() => flushTurnStream(clientTurnId), STREAM_FLUSH_INTERVAL_MS);
  }
}

export async function GET(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    initializeDatabase();
    const { searchParams } = new URL(request.url);
    const action = searchParams.get("action");
    const db = getSqlite();

    if (action === "sessions") {
      const rows = db
        .prepare(
          `
            SELECT
              source.session_id,
              MIN(source.created_at) as created_at,
              MAX(source.created_at) as last_message_at,
              source.fast_mode,
              COUNT(DISTINCT m.id) as message_count
            FROM (
              SELECT m.session_id, m.created_at, css.fast_mode
              FROM messages m
              LEFT JOIN channel_session_settings css ON css.session_id = m.session_id
              UNION ALL
              SELECT css.session_id, css.created_at, css.fast_mode
              FROM channel_session_settings css
              WHERE NOT EXISTS (
                SELECT 1 FROM messages m WHERE m.session_id = css.session_id
              )
              UNION ALL
              SELECT t.session_id, t.created_at, css.fast_mode
              FROM channel_session_turns t
              LEFT JOIN channel_session_settings css ON css.session_id = t.session_id
              WHERE NOT EXISTS (
                SELECT 1 FROM messages m WHERE m.session_id = t.session_id
              )
              AND NOT EXISTS (
                SELECT 1 FROM channel_session_settings existing_css WHERE existing_css.session_id = t.session_id
              )
            ) source
            LEFT JOIN messages m ON m.session_id = source.session_id
            GROUP BY source.session_id, source.fast_mode
            ORDER BY created_at DESC
          `
        )
        .all() as Array<{
          session_id: string;
          created_at: string;
          last_message_at: string | null;
          fast_mode: number | null;
          message_count: number;
        }>;

      const sessions = rows.map((r, i) => ({
        ...parseSessionVisibility(r.session_id),
        id: r.session_id,
        title: `Chat ${rows.length - i}`,
        fastMode: r.fast_mode === 1 ? true : r.fast_mode === 0 ? false : null,
        messageCount: Number(r.message_count) || 0,
        lastMessageAt: r.last_message_at ?? r.created_at,
      }));

      return NextResponse.json({ success: true, data: sessions });
    }

    if (action === "session-settings") {
      const sessionId = searchParams.get("sessionId");
      if (!sessionId) {
        return NextResponse.json(
          { success: false, error: "Missing sessionId" },
          { status: 400 },
        );
      }
      return NextResponse.json({
        success: true,
          data:
          getChannelSessionSettings(sessionId) ?? {
            sessionId,
            fastMode: null,
            agentId: null,
            modelRef: null,
            workspacePath: null,
            toolMode: "default",
            createdAt: null,
            updatedAt: null,
          },
      });
    }

    if (action === "messages") {
      const sessionId = searchParams.get("sessionId");
      if (!sessionId) {
        return NextResponse.json({ success: false, error: "Missing sessionId" }, { status: 400 });
      }

      const rows = db
        .prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC")
        .all(sessionId) as Array<{
          id: string;
          session_id: string;
          role: string;
          content: string;
          metadata: string | null;
          provenance: string | null;
          created_at: string;
        }>;

      const messages = rows.map((r) => ({
        id: r.id,
        sessionId: r.session_id,
        role: r.role,
        content: r.content,
        metadata: r.metadata ? JSON.parse(r.metadata) : null,
        provenance: r.provenance ? JSON.parse(r.provenance) : null,
        createdAt: r.created_at,
      }));

      const pendingTurnRows = db
        .prepare(
          `SELECT client_turn_id, session_id, status, message, error, created_at, completed_at
           FROM channel_session_turns
           WHERE session_id = ?
             AND NOT EXISTS (
               SELECT 1 FROM messages m
               WHERE m.session_id = channel_session_turns.session_id
                 AND m.role = 'user'
                 AND m.content = channel_session_turns.message
                 AND ABS(strftime('%s', m.created_at) - strftime('%s', channel_session_turns.created_at)) <= 5
             )
           ORDER BY created_at ASC`,
        )
        .all(sessionId) as Array<{
          client_turn_id: string;
          session_id: string;
          status: string;
          message: string;
          error: string | null;
          created_at: string;
          completed_at: string | null;
        }>;

      for (const turn of pendingTurnRows) {
        messages.push({
          id: `turn:${turn.client_turn_id}:user`,
          sessionId: turn.session_id,
          role: "user",
          content: turn.message,
          metadata: { transient: true, clientTurnId: turn.client_turn_id, turnStatus: turn.status },
          provenance: null,
          createdAt: turn.created_at,
        });
        if (turn.status === "failed" && turn.error) {
          messages.push({
            id: `turn:${turn.client_turn_id}:error`,
            sessionId: turn.session_id,
            role: "assistant",
            content: `Error: ${turn.error}`,
            metadata: { transient: true, clientTurnId: turn.client_turn_id, turnStatus: turn.status },
            provenance: null,
            createdAt: turn.completed_at ?? turn.created_at,
          });
        }
      }
      messages.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

      return NextResponse.json({ success: true, data: messages });
    }

    if (action === "routing-debug") {
      const sessionId = searchParams.get("sessionId");
      if (!sessionId) {
        return NextResponse.json({ success: false, error: "Missing sessionId" }, { status: 400 });
      }
      const state = getChannelSessionAppState(sessionId)?.payload ?? null;
      const row = db
        .prepare("SELECT metadata, provenance, created_at FROM messages WHERE session_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 1")
        .get(sessionId) as { metadata: string | null; provenance: string | null; created_at: string } | undefined;
      const metadata = row?.metadata ? JSON.parse(row.metadata) as Record<string, unknown> : null;
      const provenance = row?.provenance ? JSON.parse(row.provenance) as Record<string, unknown> : null;
      return NextResponse.json({
        success: true,
        data: {
          sessionId,
          pendingMutationTtlMs: state?.pendingMutation ? getPendingMutationTtlMsForDebug() : null,
          pendingMutation: state?.pendingMutation ?? null,
          recentEntities: {
            workflow: state?.workflow ?? null,
            schedule: state?.schedule ?? null,
            dataSource: state?.dataSource ?? null,
            task: state?.task ?? null,
            agent: state?.agent ?? null,
            organization: state?.organization ?? null,
            goal: state?.goal ?? null,
            lastDomain: state?.lastDomain ?? null,
            lastAction: state?.lastAction ?? null,
          },
          lastMessage: row
            ? {
                createdAt: row.created_at,
                routeSource: metadata?.routeSource ?? provenance?.routeSource ?? null,
                routingTrace: metadata?.routingTrace ?? null,
              }
            : null,
        },
      });
    }

    if (action === "session-todos") {
      const sessionId = searchParams.get("sessionId");
      if (!sessionId) {
        return NextResponse.json({ success: false, error: "Missing sessionId" }, { status: 400 });
      }
      return NextResponse.json({ success: true, data: listSessionTodos(sessionId) });
    }

    if (action === "session-turns") {
      const sessionId = searchParams.get("sessionId");
      if (!sessionId) {
        return NextResponse.json({ success: false, error: "Missing sessionId" }, { status: 400 });
      }
      resetStaleProcessingTurns(sessionId);
      const recoverableRows = db
        .prepare(
          `SELECT client_turn_id FROM channel_session_turns
           WHERE session_id = ? AND status = 'queued'
           ORDER BY created_at ASC
           LIMIT 3`,
        )
        .all(sessionId) as Array<{ client_turn_id: string }>;
      for (const row of recoverableRows) {
        processQueuedWebChatTurn(row.client_turn_id, new URL(request.url).origin);
      }
      const rows = db
        .prepare(
          `SELECT client_turn_id, session_id, status, message, response, error, metadata, provenance, stream_content, created_at, updated_at, completed_at
           FROM channel_session_turns
           WHERE session_id = ?
           ORDER BY updated_at DESC
           LIMIT 20`,
        )
        .all(sessionId) as Array<{
          client_turn_id: string;
          session_id: string;
          status: string;
          message: string;
          response: string | null;
          error: string | null;
          metadata: string | null;
          provenance: string | null;
          stream_content: string | null;
          created_at: string;
          updated_at: string;
          completed_at: string | null;
        }>;
      const turnIds = rows.map((r) => r.client_turn_id);
      const progressRows = turnIds.length > 0
        ? db
            .prepare(
              `SELECT client_turn_id, event_type, data, created_at
               FROM turn_progress_events
               WHERE client_turn_id IN (${turnIds.map(() => "?").join(",")})
               ORDER BY created_at ASC`,
            )
            .all(...turnIds) as Array<{ client_turn_id: string; event_type: string; data: string; created_at: string }>
        : [];
      const progressByTurn = new Map<string, Array<{ eventType: string; data: unknown; createdAt: string }>>();
      for (const pe of progressRows) {
        const list = progressByTurn.get(pe.client_turn_id) ?? [];
        list.push({ eventType: pe.event_type, data: (() => { try { return JSON.parse(pe.data); } catch { return {}; } })(), createdAt: pe.created_at });
        progressByTurn.set(pe.client_turn_id, list);
      }
      return NextResponse.json({
        success: true,
        data: rows.map((row) => ({
          clientTurnId: row.client_turn_id,
          sessionId: row.session_id,
          status: row.status,
          message: row.message,
          response: row.response,
          error: row.error,
          metadata: row.metadata ? JSON.parse(row.metadata) : null,
          provenance: row.provenance ? JSON.parse(row.provenance) : null,
          streamContent: row.stream_content ?? "",
          progressEvents: progressByTurn.get(row.client_turn_id) ?? [],
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          completedAt: row.completed_at,
        })),
      });
    }

    if (action === "status") {
      return NextResponse.json({
        success: true,
        data: {
          telegram: getTelegramStatus(),
          discord: getDiscordStatus(),
          whatsapp: getWhatsAppStatus(),
          slack: getSlackStatus(),
          bluebubbles: getBlueBubblesStatus(),
          teams: getTeamsStatus(),
        },
      });
    }

    if (action === "access-control") {
      return NextResponse.json({
        success: true,
        data: getChannelAccessOverview(),
      });
    }

    if (action === "directory") {
      const channel = String(searchParams.get("channel") || "").trim().toLowerCase() || null;
      const limit = Math.max(1, Math.min(50, Number(searchParams.get("limit")) || 20));
      return NextResponse.json({
        success: true,
        data: listRecentChannelTargets(channel, limit),
      });
    }

    if (action === "export") {
      const sessionId = searchParams.get("sessionId");
      const format = searchParams.get("format") ?? "json";
      if (!sessionId) {
        return NextResponse.json({ success: false, error: "Missing sessionId" }, { status: 400 });
      }

      const rows = db
        .prepare("SELECT id, session_id, role, content, metadata, provenance, created_at FROM messages WHERE session_id = ? ORDER BY created_at ASC")
        .all(sessionId) as Array<{
          id: string; session_id: string; role: string;
          content: string; metadata: string | null; provenance: string | null; created_at: string;
        }>;

      if (format === "markdown") {
        const lines: string[] = [
          `# Chat Export — ${sessionId}`,
          `Exported: ${new Date().toISOString()}`,
          "",
        ];
        for (const r of rows) {
          const label = r.role === "user" ? "User" : r.role === "system" ? "System" : "Assistant";
          lines.push(`## ${label}`, `*${r.created_at}*`, "", r.content, "");
        }
        return new NextResponse(lines.join("\n"), {
          headers: {
            "Content-Type": "text/markdown; charset=utf-8",
            "Content-Disposition": `attachment; filename="chat-${sessionId}.md"`,
          },
        });
      }

      // JSON format
      const messages = rows.map((r) => ({
        id: r.id,
        sessionId: r.session_id,
        role: r.role,
        content: r.content,
        metadata: r.metadata ? JSON.parse(r.metadata) : null,
        provenance: r.provenance ? JSON.parse(r.provenance) : null,
        createdAt: r.created_at,
      }));
      const json = JSON.stringify(
        { sessionId, exportedAt: new Date().toISOString(), messages },
        null,
        2,
      );
      return new NextResponse(json, {
        headers: {
          "Content-Type": "application/json",
          "Content-Disposition": `attachment; filename="chat-${sessionId}.json"`,
        },
      });
    }

    return NextResponse.json({ success: false, error: "Unknown action" }, { status: 400 });
  } catch (error) {
    log.error("GET /api/channels failed", { error: String(error) });
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;
  const loopbackRequest = isLoopbackHostname(resolveRequestHostname(request));
  if (!loopbackRequest) {
    const ip = getClientIp(request);
    const rl = checkRateLimit(`channels:${ip}`, getRateLimitConfig().channels, 60_000);
    if (!rl.allowed) {
      return NextResponse.json(
        { success: false, error: "Too many requests" },
        { status: 429, headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } },
      );
    }
  }

  try {
    initializeDatabase();
    const body = await readCappedJson<Record<string, any>>(request, 128 * 1024);
    const db = getSqlite();
    const now = new Date().toISOString();

    if (body.action === "chat") {
      const { sessionId, message } = body;
      if (!sessionId || !message) {
        return NextResponse.json(
          { success: false, error: "sessionId and message are required" },
          { status: 400 },
        );
      }
      const clientTurnId = String(body.clientTurnId || "").trim() || `${sessionId}:${Date.now()}`;
      // Immediately emit a "received" status so the user sees progress
      // instead of staring at the initial "Preparing app plan..." label
      // for the full pre-workflow window (routing + classification + tools setup).
      broadcastEvent("webchat:status", {
        clientTurnId,
        sessionId,
        phase: "received",
        label: "Routing your message…",
        detail: null,
        createdAt: new Date().toISOString(),
      });
      const existingTurn = db
        .prepare("SELECT status, response, error, metadata, provenance FROM channel_session_turns WHERE client_turn_id = ?")
        .get(clientTurnId) as {
          status: string;
          response: string | null;
          error: string | null;
          metadata: string | null;
          provenance: string | null;
        } | undefined;
      if (existingTurn?.status === "completed" && existingTurn.response) {
        return NextResponse.json({
          success: true,
          data: {
            response: existingTurn.response,
            metadata: existingTurn.metadata ? JSON.parse(existingTurn.metadata) : null,
            provenance: existingTurn.provenance ? JSON.parse(existingTurn.provenance) : null,
            replayed: true,
          },
        });
      }

      const requestPayload = {
        action: "chat",
        sessionId,
        message,
        clientTurnId,
        agentId: body.agentId,
        sessionSettings: body.sessionSettings,
      };
      db.prepare(
        `INSERT INTO channel_session_turns
          (client_turn_id, session_id, status, message, request_payload, stream_content, created_at, updated_at)
         VALUES (?, ?, 'queued', ?, ?, '', ?, ?)
         ON CONFLICT(client_turn_id) DO UPDATE SET
           request_payload = COALESCE(channel_session_turns.request_payload, excluded.request_payload),
           updated_at = excluded.updated_at`,
      ).run(clientTurnId, String(sessionId), String(message), JSON.stringify(requestPayload), now, now);

      if (body.sessionSettings && typeof body.sessionSettings === "object") {
        const incomingSettings = body.sessionSettings as Record<string, unknown>;
        upsertChannelSessionSettings({
          sessionId: String(sessionId),
          fastMode:
            incomingSettings.fastMode === null || incomingSettings.fastMode === undefined
              ? undefined
              : incomingSettings.fastMode === true,
          agentId: incomingSettings.agentId === undefined ? undefined : String(incomingSettings.agentId || "").trim() || null,
          modelRef: incomingSettings.modelRef === undefined ? undefined : String(incomingSettings.modelRef || "").trim() || null,
          workspacePath: incomingSettings.workspacePath === undefined ? undefined : String(incomingSettings.workspacePath || "").trim() || null,
          toolMode:
            incomingSettings.toolMode === "restricted" || incomingSettings.toolMode === "full"
              ? incomingSettings.toolMode
              : incomingSettings.toolMode === undefined
                ? undefined
                : "default",
        });
      }

      // Use the async/queued path only when the client explicitly opts in.
      // All other callers (regression scripts, CLI, legacy) get the original synchronous response.
      if (body.async === true) {
        processQueuedWebChatTurn(clientTurnId, new URL(request.url).origin);
        return NextResponse.json({
          success: true,
          data: {
            queued: true,
            clientTurnId,
            sessionId,
            status: "queued",
          },
        });
      }

      // Briefly queue overlapping turns for the same session instead of
      // immediately failing when the previous response is still winding down.
      if (sessionProcessing.get(sessionId)) {
        const acquired = await waitForSessionSlot(String(sessionId));
        if (!acquired) {
          return NextResponse.json(
            { success: false, error: "Session busy — previous message still processing. Please wait." },
            { status: 429 }
          );
        }
      }
      sessionProcessing.set(sessionId, true);
      db.prepare(
        `UPDATE channel_session_turns
         SET status = 'processing', attempts = COALESCE(attempts, 0) + 1, lease_expires_at = ?, updated_at = ?
         WHERE client_turn_id = ?`,
      ).run(new Date(Date.now() + 15 * 60 * 1000).toISOString(), new Date().toISOString(), clientTurnId);

      try {
        const rawMessage = String(message);
        const routedMessage = rawMessage;
        const incomingSettings = body.sessionSettings && typeof body.sessionSettings === "object"
          ? body.sessionSettings as Record<string, unknown>
          : {};
        const hasIncomingSettings = Object.keys(incomingSettings).length > 0;
        const persistedSettings = hasIncomingSettings
          ? upsertChannelSessionSettings({
              sessionId: String(sessionId),
              fastMode:
                incomingSettings.fastMode === null || incomingSettings.fastMode === undefined
                  ? undefined
                  : incomingSettings.fastMode === true,
              agentId: incomingSettings.agentId === undefined ? undefined : String(incomingSettings.agentId || "").trim() || null,
              modelRef: incomingSettings.modelRef === undefined ? undefined : String(incomingSettings.modelRef || "").trim() || null,
              workspacePath: incomingSettings.workspacePath === undefined ? undefined : String(incomingSettings.workspacePath || "").trim() || null,
              toolMode:
                incomingSettings.toolMode === "restricted" || incomingSettings.toolMode === "full"
                  ? incomingSettings.toolMode
                  : incomingSettings.toolMode === undefined
                    ? undefined
                    : "default",
            })
          : getChannelSessionSettings(String(sessionId));
        const selectedContext = {
          agentId: String(body.agentId || persistedSettings?.agentId || resolveChannelSessionAgentId(String(sessionId)) || defaultChannelAgentId()).trim() || defaultChannelAgentId(),
          modelRef: persistedSettings?.modelRef ?? null,
          workspacePath: persistedSettings?.workspacePath ?? null,
          toolMode: persistedSettings?.toolMode ?? "default",
          fastMode: persistedSettings?.fastMode ?? null,
        };

        if (!selectedContext.modelRef) {
          const attachmentIds: string[] = Array.isArray(body.attachmentIds) ? body.attachmentIds.filter((id: unknown) => typeof id === "string") as string[] : [];
          const routing = routeRequestSmart(
            String(message),
            selectedContext.fastMode,
            attachmentIds.length > 0,
          );
          if (routing.modelRef) {
            selectedContext.modelRef = routing.modelRef;
          }
        }

        const blockedByToolMode = selectedContext.toolMode === "restricted"
          ? restrictedToolModeBlockReason(rawMessage)
          : null;
        if (blockedByToolMode) {
          const userTrace = createProvenance("channel", "channel:webchat", {
            channel: "webchat",
            sessionId,
            sender: "user",
            agentId: selectedContext.agentId,
            routeSource: "webchat-chat",
          });
          persistChannelMessage({
            sessionId,
            role: "user",
            content: rawMessage,
            provenance: userTrace,
            agentId: selectedContext.agentId,
            createdAt: now,
          });
          const response = presentChannelResponse("webchat", blockedByToolMode);
          const metadata = { routeSource: "tool-mode-guard", selectedContext, toolModeBlocked: true };
          const provenance = createProvenance("channel", "channel:webchat", {
            channel: "webchat",
            sessionId,
            sender: "assistant",
            agentId: selectedContext.agentId,
            routeSource: "tool-mode-guard",
          });
          persistChannelMessage({
            sessionId,
            role: "assistant",
            content: response,
            metadata,
            provenance,
            agentId: selectedContext.agentId,
            createdAt: now,
          });
          flushTurnStream(clientTurnId);
          db.prepare(
            `UPDATE channel_session_turns
             SET status = 'completed', response = ?, metadata = ?, provenance = ?, worker_id = NULL, lease_expires_at = NULL, updated_at = ?, completed_at = ?
             WHERE client_turn_id = ?`,
          ).run(response, JSON.stringify(metadata), JSON.stringify(provenance), new Date().toISOString(), new Date().toISOString(), clientTurnId);
          broadcastEvent("webchat:message", {
            sessionId,
            clientTurnId,
            role: "assistant",
            content: response,
            metadata,
            provenance,
            createdAt: new Date().toISOString(),
          });
          return NextResponse.json({ success: true, data: { response, metadata, provenance } });
        }
        const btw = await runByTheWayQuestion({
          rawMessage,
          sessionId: String(sessionId),
          agentId: selectedContext.agentId,
          onToken: (token) => {
            appendTurnStream(clientTurnId, token);
            broadcastEvent("webchat:stream", { sessionId, clientTurnId, token });
          },
        });
        if (btw) {
          flushTurnStream(clientTurnId);
          db.prepare(
            `UPDATE channel_session_turns
             SET status = 'completed', response = ?, metadata = ?, worker_id = NULL, lease_expires_at = NULL, updated_at = ?, completed_at = ?
             WHERE client_turn_id = ?`,
          ).run(
            presentChannelResponse("webchat", btw.response || "No answer."),
            JSON.stringify({ routeSource: "btw", ephemeral: true }),
            new Date().toISOString(),
            new Date().toISOString(),
            clientTurnId,
          );
          broadcastEvent("webchat:message", {
            sessionId,
            clientTurnId,
            role: "assistant",
            content: presentChannelResponse("webchat", btw.response || "No answer."),
            metadata: { routeSource: "btw", ephemeral: true },
            createdAt: new Date().toISOString(),
          });
          return NextResponse.json({
            success: true,
            data: {
              response: presentChannelResponse("webchat", btw.response || "No answer."),
              metadata: { routeSource: "btw", ephemeral: true },
            },
          });
        }

        // Store user message
        const agentId = selectedContext.agentId;
        const trace = createProvenance("channel", "channel:webchat", {
          channel: "webchat",
          sessionId,
          sender: "user",
          agentId,
          routeSource: "webchat-chat",
        });
        persistChannelMessage({
          sessionId,
          role: "user",
          content: rawMessage,
          provenance: trace,
          agentId,
          createdAt: now,
        });

        // ── Deterministic response helper ──
        // Collapses the repeated persist-broadcast-respond pattern used by
        // unknown-tool, workspace-read, app-surface-handler, and repo-inspection lanes.
        function respondDeterministic(
          response: string,
          metadata: Record<string, unknown>,
          opts?: {
            provenanceExtra?: Record<string, unknown>;
            routingDecisionOverride?: ReturnType<typeof arbitrateRouting>;
          },
        ) {
          // Early deterministic lanes can run before the normal routing decision
          // exists. Their caller supplies the equivalent decision explicitly.
          const effectiveRoutingDecision = opts?.routingDecisionOverride ?? routingDecision;
          if (!metadata.taskIntentContract) metadata.taskIntentContract = taskIntentContract;
          if (!metadata.turnPlan) metadata.turnPlan = turnPlan;
          if (!metadata.turnPlanner) metadata.turnPlanner = turnPlannerDiagnostics;
          if (!metadata.routingDecision) metadata.routingDecision = effectiveRoutingDecision;
          if (effectiveRoutingDecision.conflicts.length > 0 && !metadata.routingConflicts) {
            metadata.routingConflicts = effectiveRoutingDecision.conflicts;
          }
          const routeSource = String(metadata.routeSource || "deterministic");
          const provenance = createProvenance("channel", "channel:webchat", {
            channel: "webchat",
            sessionId,
            sender: "assistant",
            agentId,
            routeSource,
            ...(opts?.provenanceExtra ?? {}),
          });
          persistChannelMessage({
            sessionId,
            role: "assistant",
            content: response,
            metadata,
            provenance,
            agentId,
            createdAt: now,
          });
          flushTurnStream(clientTurnId);
          db.prepare(
            `UPDATE channel_session_turns
             SET status = 'completed', response = ?, metadata = ?, provenance = ?, worker_id = NULL, lease_expires_at = NULL, updated_at = ?, completed_at = ?
             WHERE client_turn_id = ?`,
          ).run(response, JSON.stringify(metadata), JSON.stringify(provenance), new Date().toISOString(), new Date().toISOString(), clientTurnId);
          broadcastEvent("webchat:message", {
            sessionId,
            clientTurnId,
            role: "assistant",
            content: response,
            metadata,
            provenance,
            createdAt: new Date().toISOString(),
          });
          // Fire-and-forget so the fast deterministic path keeps its low latency
          // while still capturing preference/profile signals from the message.
          void captureTurnLearning(rawMessage, response, routeSource);
          return NextResponse.json({
            success: true,
            data: { response, metadata, provenance, clientTurnId, routeSource },
          });
        }

        function forwardWebChatAssistantEvent(event: string, data: unknown, opts?: { bufferTokens?: string[] }) {
          if (event === "stream:token") {
            const token = typeof (data as { token?: unknown })?.token === "string"
              ? String((data as { token?: unknown }).token)
              : "";
            if (opts?.bufferTokens) {
              opts.bufferTokens.push(token);
              return;
            }
            appendTurnStream(clientTurnId, token);
            broadcastEvent("webchat:stream", { sessionId, clientTurnId, ...(data as object) });
            return;
          }
          if (event === "stream:status" || event === "webchat:status") {
            const payload = data && typeof data === "object" ? data as Record<string, unknown> : {};
            broadcastEvent("webchat:status", {
              clientTurnId,
              sessionId,
              phase: String(payload.phase || "model_call"),
              label: String(payload.label || "Calling model..."),
              detail: payload.detail ?? null,
              createdAt: new Date().toISOString(),
            });
            return;
          }
          if (event === "webchat:tool") {
            const payload = data && typeof data === "object" ? data as Record<string, unknown> : {};
            broadcastEvent("webchat:tool", {
              clientTurnId,
              sessionId,
              ...payload,
            });
          }
        }

        // Run self-learning capture for turns that exit through an early lane
        // (direct-answer, read-only-tool, deterministic) — these return before
        // the workflow-path learning capture, so preference/profile/playbook
        // signals would otherwise be missed on normal chat turns.
        async function captureTurnLearning(
          turnMessage: string,
          turnResponse: string,
          routeSource: string,
        ): Promise<{ items: unknown[]; text: string } | null> {
          try {
            const { captureLearningFromChannelInteraction, drainLearningNotifications, formatLearningFeedbackText } =
              await import("@/lib/learning/loop");
            await captureLearningFromChannelInteraction({
              sessionId,
              message: turnMessage,
              response: turnResponse,
              routeSource,
              agentId,
            });
            const fb = drainLearningNotifications(sessionId);
            if (fb.length > 0) {
              const text = formatLearningFeedbackText(fb);
              broadcastEvent("webchat:learning-feedback", { sessionId, items: fb, text });
              return { items: fb, text };
            }
          } catch (learningError) {
            log.warn("Learning capture failed", { error: String(learningError) });
          }
          return null;
        }

        // ── Ground-layer intent classification ──
        const intent = classifyWebChatIntent(rawMessage, { sessionId: String(sessionId) });
        const deepInspection = classifyDeepInspectionRequest(rawMessage);
        const sessionOnlyDirectAnswerPrompt = isSessionOnlyDirectAnswerPrompt(rawMessage);
        const taskIntentContract = determineTaskIntentContract(rawMessage);
        const deepAuditProfile = classifyDeepAudit(rawMessage, taskIntentContract.readOnly, selectedContext.toolMode !== "restricted");
        const broadResearchPrompt = isLikelyBroadResearchPrompt(rawMessage) || needsCurrentPublicFacts(rawMessage);
        // Protected builtin commands (learning status, snapshot status, agent/
        // skill queries, etc.) must reach routeToWorkflowWithDetails — they
        // must not be swallowed by the direct-answer / app-surface lanes.
        const isProtectedBuiltin = isProtectedBuiltinParserMessage(rawMessage);

        // ── Broad task classification (Phase 1) ──
        // Classify broad/non-deterministic prompts into durable task types
        // to guide evidence collection, tool policy, and answer contracts.
        const broadTask = classifyBroadTask(rawMessage);
        const baseTurnPlan = buildTurnPlanFromContract(rawMessage);
        let turnPlan = baseTurnPlan;
        let turnPlannerDiagnostics: Record<string, unknown> = { mode: "contract" };

        const calculation = evaluateSimpleCalculation(rawMessage);
        if (calculation !== null) {
          return respondDeterministic(
            calculation,
            {
              routeSource: "builtin:calculator",
              responseMode: "deterministic",
              intent,
              selectedContext,
            },
            {
              routingDecisionOverride: arbitrateRouting({
                isProtectedBuiltin,
                isDeterministicResponse: true,
                contract: taskIntentContract,
                turnPlan,
                legacyBroadTask: broadTask,
                readOnly: intent.readOnly,
              }),
            },
          );
        }

        // Trivial fast-memory save/recall is handled by the deterministic
        // fast-memory lane below; it must not pay the (LLM) turn-planner latency.
        // Detect with the lane's own cheap sync parsers and skip the planner.
        let fastMemoryCandidate = false;
        if (!isProtectedBuiltin && !isCrossSurfaceAppMutationRequest(rawMessage)) {
          try {
            const fm = await import("@/lib/channels/fast-memory-recall");
            fastMemoryCandidate =
              Boolean(fm.parseSimpleMemorySave(rawMessage)) || fm.isFastRecallCandidate(rawMessage);
          } catch {
            /* non-fatal — fall through to normal planning */
          }
        }

        if (!isProtectedBuiltin && !fastMemoryCandidate && shouldUseLlmTurnPlanner(rawMessage)) {
          const plannerModel = getModelConfig({ agentId, sessionId: String(sessionId) });
          const plannerResult = await buildTurnPlanWithLlm({
            message: rawMessage,
            provider: plannerModel.provider,
            modelId: plannerModel.modelId,
            apiKey: plannerModel.apiKey,
            baseUrl: plannerModel.baseUrl,
            maxTokens: 900,
            temperature: 0,
            fallback: baseTurnPlan,
          });
          turnPlan = plannerResult.plan;
          turnPlannerDiagnostics = {
            mode: plannerResult.usedLlm ? "llm" : "contract-fallback",
            provider: plannerModel.provider,
            modelId: plannerModel.modelId,
            ...(plannerResult.error ? { error: plannerResult.error } : {}),
          };
        }
        const routingDecision = arbitrateRouting({
          isProtectedBuiltin,
          isDeterministicResponse: false,
          contract: taskIntentContract,
          turnPlan,
          legacyBroadTask: broadTask,
          readOnly: intent.readOnly,
        });

        // ── Explicit source-QA (notebook/document id prompts) ──
        // Deterministic, id-bearing lane: must run before any model-led
        // classification so routing does not vary by provider.
        const explicitSourceQuestion = parseExplicitSourceQuestion(rawMessage);
        if (explicitSourceQuestion && !isCrossSurfaceAppMutationRequest(rawMessage)) {
          let sourceAnswer = "";
          let citationCount = 0;
          if (!explicitSourceQuestion.query) {
            sourceAnswer = explicitSourceQuestion.kind === "notebook"
              ? `Open WebChat from a notebook after typing a question, or ask: "Use notebook id: ${explicitSourceQuestion.id} and answer: <your question>".`
              : `Open WebChat from a data source after typing a question, or ask: "Search data source id: ${explicitSourceQuestion.id} and answer: <your question>".`;
          } else if (explicitSourceQuestion.kind === "notebook") {
            const { askNotebook } = await import("@/lib/notebooks/store");
            const result = await askNotebook({
              notebookId: explicitSourceQuestion.id,
              query: explicitSourceQuestion.query,
              limit: asksForDeterministicDepthEnrichment(rawMessage) ? 10 : 6,
            });
            citationCount = result.citations.length;
            sourceAnswer = result.answerMd;
          } else {
            const { searchDocumentsSemantic } = await import("@/lib/documents/chunks");
            const hits = await searchDocumentsSemantic(explicitSourceQuestion.query, {
              documentIds: [explicitSourceQuestion.id],
              limit: asksForDeterministicDepthEnrichment(rawMessage) ? 10 : 6,
            });
            citationCount = hits.length;
            if (hits.length) {
              sourceAnswer = [
                `Evidence found for: ${explicitSourceQuestion.query}`,
                "",
                ...hits.slice(0, 8).map((hit) => `- ${hit.text.replace(/\s+/g, " ").trim().slice(0, 420)} [${hit.citation}]`),
              ].join("\n");
            } else {
              const { getDocumentById } = await import("@/lib/documents/store");
              const document = getDocumentById(explicitSourceQuestion.id);
              if (document?.extractedText?.trim()) {
                const excerpt = document.extractedText.replace(/\s+/g, " ").trim().slice(0, 700);
                citationCount = 1;
                sourceAnswer = [
                  `Evidence found for: ${explicitSourceQuestion.query}`,
                  "",
                  `- ${excerpt} [${document.name} §full]`,
                ].join("\n");
              } else {
                sourceAnswer = "That data source does not contain enough indexed evidence to answer that.";
              }
            }
          }

          const routeSource = `source-qa:${explicitSourceQuestion.kind}`;
          const sessionModel = getModelConfig({ agentId, sessionId: String(sessionId) });
          const enriched = await enrichDeterministicDraftForDepth({
            userMessage: rawMessage,
            draft: sourceAnswer,
            routeSource,
            requireExplicitDepth: true,
            requiredSections: ["Answer", "Citations", "Evidence limits"],
            provider: sessionModel.provider,
            modelId: sessionModel.modelId,
            apiKey: sessionModel.apiKey,
            baseUrl: sessionModel.baseUrl,
          });
          return respondDeterministic(presentChannelResponse("webchat", enriched.answer), {
            routeSource: enriched.diagnostics.applied ? `${routeSource}:model-enriched` : routeSource,
            selectedContext,
            responseMode: "deterministic",
            sourceQuestion: explicitSourceQuestion,
            citationCount,
            deterministicPreflight: { routeSource, answerChars: sourceAnswer.length },
            enrichment: enriched.diagnostics,
          });
        }

        // ── Fast memory lane (deterministic; before the heavy app-action/agentic lanes) ──
        // A trivial "Remember this: k = v" / "what is <k>?" must not pay the
        // agentic tax. Runs after routingDecision (respondDeterministic closes over
        // it) but before the app-action/broad/agentic dispatch.
        // Exact-identifier recalls go to the deterministic exact_memory_recall
        // lane (collision-safe). Everything else falls through unchanged.
        if (!isCrossSurfaceAppMutationRequest(rawMessage)) {
          try {
            const fastMem = await import("@/lib/channels/fast-memory-recall");
            // 1) Simple structured save → persist durably, reply "saved". Runs
            //    regardless of protected-builtin classification (a "Remember this:
            //    k = v" message is often flagged as a memory builtin), gated by
            //    the strict parser so only real key=value facts are fast-saved.
            const parsedSave = fastMem.parseSimpleMemorySave(rawMessage);
            if (parsedSave) {
              const saved = await fastMem.saveSimpleMemoryFact({
                sessionId: String(sessionId),
                agentId,
                key: parsedSave.key,
                value: parsedSave.value,
                originalMessage: rawMessage,
              });
              return respondDeterministic(
                presentChannelResponse("webchat", "saved"),
                { routeSource: "memory:fast-save", intent, selectedContext, memoryId: saved.id },
              );
            }
            // 2) Recall (skip for protected builtins). Exact identifiers →
            //    deterministic lane; general → fast lane.
            const { classifyExactRecallQuery } = await import("@/lib/memory/exact-recall");
            // An app mutation ("...give them a board task to compare OCR models")
            // can be misclassified as exact recall because "compare"/"history"/
            // "versions" trip classifyExactRecallQuery. Never let the recall lane
            // swallow a mutation — that path drops the editable pending plan.
            const looksLikeMutation = fastMem.looksLikeAppMutation(rawMessage);
            if (isProtectedBuiltin || looksLikeMutation) {
              // not a recall we handle here — fall through to normal routing
            } else if (
              classifyExactRecallQuery(rawMessage) !== "semantic_memory" &&
              !(
                taskIntentContract.toolPolicy === "required" &&
                (
                  taskIntentContract.requiresRepoEvidence ||
                  taskIntentContract.requiresAppState ||
                  taskIntentContract.evidenceSources.some((source) => source !== "memory" && source !== "session_history")
                )
              )
            ) {
              const routed = await routeToWorkflowWithDetails({
                triggerNodeType: "message-trigger",
                channel: "webchat",
                agentId,
                internalBaseUrl: new URL(request.url).origin,
                clientTurnId,
                provenance: trace,
                triggerData: {
                  message: routedMessage,
                  sender: "user",
                  channel: "webchat",
                  sessionId,
                  clientTurnId,
                  toolMode: selectedContext.toolMode,
                  workspacePath: selectedContext.workspacePath,
                  taskIntentContract,
                  timestamp: now,
                },
                onEmit: forwardWebChatAssistantEvent,
              });
              if (routed.response && routed.source !== "none" && routed.source !== "cancelled") {
                const recallMeta: Record<string, unknown> = {
                  routeSource: routed.source,
                  intent,
                  selectedContext,
                  ...(routed.routingTrace ? { routingTrace: routed.routingTrace } : {}),
                };
                // Defense-in-depth: if this somehow produced an editable plan,
                // surface it so the client can still edit it.
                if (routed.pendingAppActionPlan) {
                  recallMeta.pendingAppActionPlan = routed.pendingAppActionPlan;
                  if (routed.pendingWorkTrailId) recallMeta.workTrailId = routed.pendingWorkTrailId;
                }
                return respondDeterministic(
                  presentChannelResponse("webchat", applyQualityGates(routed.response, rawMessage)),
                  recallMeta,
                );
              }
            } else {
              const recall = await fastMem.tryFastMemoryRecall({ message: rawMessage, sessionId: String(sessionId), agentId });
              if (recall?.response) {
                return respondDeterministic(
                  presentChannelResponse("webchat", applyQualityGates(recall.response, rawMessage)),
                  { routeSource: "memory:fast-recall", intent, selectedContext },
                );
              }
            }
          } catch (fastMemErr) {
            log.warn("fast-mem lane: error (falling through)", { error: String(fastMemErr) });
          }
        }

        if (/\?\s*\S/.test(rawMessage.trim())) {
          const compoundBuiltin = await renderCompoundChannelCommandBuiltinResponse(rawMessage, {
            channel: "webchat",
            sender: "local-operator",
            sessionId: String(sessionId || ""),
            internalBaseUrl: new URL(request.url).origin,
          });
          if (compoundBuiltin) {
            return respondDeterministic(
              presentChannelResponse("webchat", applyQualityGates(compoundBuiltin.response, rawMessage)),
              {
                routeSource: "builtin",
                intent,
                selectedContext,
                channelCommandBuiltin: true,
                compoundBuiltin: true,
                routingTrace: {
                  routeSource: "builtin",
                  intentClass: "app_read",
                  commands: compoundBuiltin.commands,
                },
              },
            );
          }
        }

        // Exact channel commands ("list models", "show config", "search docs for ...",
        // "show document ...", "run the ... task") must use live deterministic
        // builtins before broad agentic/planner lanes. This is the same precedence
        // rule as automation and board inventory, but covers the channel command
        // suite where model-led routing was too slow and sometimes wrong.
        if (isChannelCommandBuiltinRequest(rawMessage)) {
          const channelCommandState = await renderChannelCommandBuiltinResponse(rawMessage, {
            channel: "webchat",
            sender: "local-operator",
            sessionId: String(sessionId || ""),
            internalBaseUrl: new URL(request.url).origin,
          });
          if (channelCommandState) {
            const channelCommandIntentClass =
              /^(?:create|add|make|mark|set|move|complete|finish|close|resolve|claim|checkout|check out|release|unclaim|run|start|execute)\b/i.test(rawMessage.trim())
                ? "app_write"
                : "app_read";
            return respondDeterministic(
              presentChannelResponse("webchat", applyQualityGates(channelCommandState, rawMessage)),
              {
                routeSource: "builtin",
                intent,
                selectedContext,
                channelCommandBuiltin: true,
                routingTrace: {
                  routeSource: "builtin",
                  intentClass: channelCommandIntentClass,
                  commands: [rawMessage],
                },
              },
            );
          }
        }

        if (isAutomationLiveStateReadRequest(rawMessage)) {
          const automationState = await renderAutomationLiveStateResponse(rawMessage);
          return respondDeterministic(
            presentChannelResponse("webchat", applyQualityGates(automationState, rawMessage)),
            {
              routeSource: "builtin",
              intent,
              selectedContext,
              automationLiveState: true,
              routingTrace: {
                routeSource: "builtin",
                intentClass: "app_read",
                commands: [rawMessage],
              },
            },
          );
        }

        if (isWebhookSigningHelpRequest(rawMessage)) {
          return respondDeterministic(
            presentChannelResponse("webchat", applyQualityGates(renderWebhookSigningHelpResponse(), rawMessage)),
            {
              routeSource: "builtin",
              intent,
              selectedContext,
              webhookSigningHelp: true,
              routingTrace: {
                routeSource: "builtin",
                intentClass: "app_read",
                commands: [rawMessage],
              },
            },
          );
        }

        // Board-task inventory ("list tasks", "what's in my inbox", "what's on my plate")
        // returns live board state, hoisted before generic show/open routing and broad
        // synthesis so it is deterministic and model-independent.
        const hasCompoundQuestion = /\?\s*\S/.test(rawMessage.trim());
        if (isBoardTaskListRequest(rawMessage) && !hasCompoundQuestion) {
          const boardState = await renderBoardTaskListResponse(rawMessage);
          return respondDeterministic(
            presentChannelResponse("webchat", applyQualityGates(boardState, rawMessage)),
            {
              routeSource: "builtin",
              intent,
              selectedContext,
              boardTaskList: true,
              routingTrace: {
                routeSource: "builtin",
                intentClass: "app_read",
                commands: [rawMessage],
              },
            },
          );
        }

        // ── Early slash command handling ────────────────────────────────
        // Exact slash commands like /fast, /fast status, /balanced, /thorough
        // must be handled before intent classification or app-surface routing
        // intercepts them with generic policy text.
        {
          const slashMatch = rawMessage.trim().match(/^\/(fast|balanced|thorough)(?:\s*[: ]\s*(status|on|off|inherit|auto|help))?$/i);
          if (slashMatch && sessionId) {
            const command = slashMatch[1].toLowerCase();
            const subCommand = (slashMatch[2] || "status").trim().toLowerCase();

            if (command === "fast") {
              const [{ getModelConfig }, sessionSettings] = await Promise.all([
                import("@/lib/agents/model-router"),
                import("@/lib/channels/session-settings"),
              ]);
              const currentSettings = sessionSettings.getChannelSessionSettings(String(sessionId));

              if (subCommand === "help") {
                const helpText = [
                  "Fast mode routes simple turns to the fastest available model.",
                  "",
                  "Commands:",
                  "  /fast status   — Show current mode (default: inherits model default)",
                  "  /fast on       — Enable fast mode for this session",
                  "  /fast off      — Disable fast mode for this session",
                  "  /fast inherit  — Remove session override, use model default",
                ].join("\n");
                return respondDeterministic(helpText, { routeSource: "slash-command", responseMode: "deterministic" });
              }

              if (subCommand === "status") {
                const resolved = getModelConfig({ sessionId: String(sessionId) });
                const source =
                  currentSettings?.fastMode === null || currentSettings?.fastMode === undefined
                    ? "model default"
                    : "session override";
                const statusText = [
                  `Current fast mode: ${resolved.fastMode ? "on" : "off"}.`,
                  `Source: ${source}.`,
                  "Options: /fast on, /fast off, /fast inherit.",
                ].join("\n");
                return respondDeterministic(statusText, { routeSource: "slash-command", responseMode: "deterministic" });
              }

              // Mutating commands: on, off, inherit
              const fastMode =
                subCommand === "on" ? true : subCommand === "off" ? false : null;
              sessionSettings.upsertChannelSessionSettings({
                sessionId: String(sessionId),
                fastMode,
              });
              const resolved = getModelConfig({ sessionId: String(sessionId) });
              const responseText = fastMode === null
                ? `Fast mode now inherits the model default (${resolved.fastMode ? "on" : "off"}) for this session.`
                : `Fast mode ${resolved.fastMode ? "enabled" : "disabled"} for this session.`;
              return respondDeterministic(responseText, { routeSource: "slash-command", responseMode: "deterministic" });
            }

            // /balanced and /thorough: map to fast mode inverse
            if (command === "balanced" || command === "thorough") {
              const [{ getModelConfig }, sessionSettings] = await Promise.all([
                import("@/lib/agents/model-router"),
                import("@/lib/channels/session-settings"),
              ]);

              if (subCommand === "status" || subCommand === "help") {
                const resolved = getModelConfig({ sessionId: String(sessionId) });
                const currentSettings = sessionSettings.getChannelSessionSettings(String(sessionId));
                const source =
                  currentSettings?.fastMode === null || currentSettings?.fastMode === undefined
                    ? "model default"
                    : "session override";
                const mode = command === "balanced" ? "balanced" : "thorough";
                const statusText = [
                  `Current ${mode} mode: ${resolved.fastMode ? "off (fast mode is on)" : "on"}.`,
                  `Source: ${source}.`,
                  `Use /fast on to switch to fast mode, /fast off for ${mode} mode.`,
                ].join("\n");
                return respondDeterministic(statusText, { routeSource: "slash-command", responseMode: "deterministic" });
              }

              // balanced/thorough = fast mode off
              sessionSettings.upsertChannelSessionSettings({
                sessionId: String(sessionId),
                fastMode: false,
              });
              const responseText = `${command === "balanced" ? "Balanced" : "Thorough"} mode enabled for this session (fast mode disabled).`;
              return respondDeterministic(responseText, { routeSource: "slash-command", responseMode: "deterministic" });
            }
          }
        }

        if (intent.kind === "unknown-tool") {
          return respondDeterministic(
            buildUnknownToolResponse(intent.requestedToolName || "unknown"),
            { routeSource: "tool-catalog", intent, responseMode: "deterministic" },
          );
        }

        // ── Standing goals / subgoals (slash commands) ──────────────────
        // /goal and /subgoal are protected builtins that should not enter
        // the agentic runtime; they stage durable goal + board task work.
        {
          const { parseStandingGoalCommand, executeStandingGoalCommand, formatStandingGoalSnapshot } = await import(
            "@/lib/goals/standing-goals"
          );
          const standingCommand = parseStandingGoalCommand(rawMessage);
          if (standingCommand) {
            const result = executeStandingGoalCommand(standingCommand);
            const suffix = formatStandingGoalSnapshot(result.snapshot);
            const text = [result.message, suffix].filter(Boolean).join("\n\n");
            return respondDeterministic(text, {
              routeSource: "standing-goal",
              responseMode: "deterministic",
              intent,
            });
          }
        }

        if (isVagueAppOpsOptimizationRequest(rawMessage)) {
          return respondDeterministic(
            [
              "I can optimize this, but I should audit first before changing workflows or agents.",
              "",
              "Plan:",
              "1. Review active workflows, recent runs, agent roles, and task handoffs.",
              "2. Identify slow, duplicated, blocked, or unclear paths.",
              "3. Return recommended changes with risk and priority.",
              "",
              "Reply with the scope to audit, or say \"audit all workflows and agents\".",
            ].join("\n"),
            {
              routeSource: "app-action-clarifier",
              intent,
              selectedContext,
              responseMode: "deterministic",
              noMutation: true,
            },
          );
        }

        {
          const hypotheticalWorkflowPreview = buildHypotheticalWorkflowPreview(rawMessage);
          if (hypotheticalWorkflowPreview) {
            return respondDeterministic(
              hypotheticalWorkflowPreview,
              {
                routeSource: "dry-run-preview",
                intent,
                selectedContext,
                responseMode: "deterministic",
                noMutation: true,
              },
            );
          }
        }

        // ── Pending confirmation reply lane ─────────────────────────────
        // A bare "confirm"/"cancel" with a pending app-action plan or mutation
        // must execute (or cancel) it through the deterministic router. Without
        // this, short confirmations are not app-action-lane eligible and fall
        // through to the agentic broad-task runtime, which fabricates a success
        // message without ever running the plan (e.g. an org switch that never
        // persists).
        {
          const isPendingReply = /^(?:confirm|yes|apply it|do it|cancel|never mind|nevermind|stop|don'?t do that|do not do that)$/i.test(rawMessage);
          const pendingForReply = getChannelSessionAppState(String(sessionId))?.payload?.pendingMutation;
          if (isPendingReply && pendingForReply?.kind) {
            const routed = await routeToWorkflowWithDetails({
              triggerNodeType: "message-trigger",
              channel: "webchat",
              agentId,
              internalBaseUrl: new URL(request.url).origin,
              clientTurnId,
              provenance: trace,
              triggerData: {
                message: routedMessage,
                sender: "user",
                channel: "webchat",
                sessionId,
                clientTurnId,
                toolMode: selectedContext.toolMode,
                workspacePath: selectedContext.workspacePath,
                taskIntentContract,
                timestamp: now,
              },
              onEmit: forwardWebChatAssistantEvent,
            });
            if (routed.response) {
              return respondDeterministic(
                presentChannelResponse("webchat", applyQualityGates(routed.response, rawMessage)),
                {
                  routeSource: routed.source,
                  intent,
                  selectedContext,
                  pendingConfirmationReply: true,
                },
              );
            }
          }
        }


        // ── App-action planner lane ─────────────────────────────────────
        // WebChat runs an agentic pre-router before the channel router. For
        // app-surface write/setup prompts, delegate to the channel router first
        // so confirmation-gated app-action plans win over broad tool workflows.
        {
          if (shouldUseWebChatAppActionLane(rawMessage)) {
            const channelSetupRequest = isChannelSetupRequest(rawMessage);
            const routed = await routeToWorkflowWithDetails({
              triggerNodeType: "message-trigger",
              channel: "webchat",
              agentId,
              internalBaseUrl: new URL(request.url).origin,
              clientTurnId,
              provenance: trace,
              triggerData: {
                message: routedMessage,
                sender: "user",
                channel: "webchat",
                sessionId,
                clientTurnId,
                toolMode: selectedContext.toolMode,
                workspacePath: selectedContext.workspacePath,
                taskIntentContract,
                timestamp: now,
              },
              onStatus: (phase, label, detail) => {
                broadcastEvent("webchat:status", {
                  clientTurnId,
                  sessionId,
                  phase,
                  label,
                  detail: detail ?? null,
                  createdAt: new Date().toISOString(),
                });
              },
              onEmit: forwardWebChatAssistantEvent,
            });

            if (
              routed.response &&
              (routed.source === "app-action-planner" || channelSetupRequest)
            ) {
              const response = presentChannelResponse(
                "webchat",
                applyQualityGates(routed.response, rawMessage),
              );
              const metadata: Record<string, unknown> = {
                routeSource: routed.source,
                intent,
                selectedContext,
                webChatAppActionLane: true,
                ...(channelSetupRequest ? { delegatedChannelSetup: true } : {}),
                ...(routed.routingTrace ? { routingTrace: routed.routingTrace } : {}),
              };
              if (routed.source === "app-action-planner" && routed.pendingAppActionPlan) {
                metadata.pendingAppActionPlan = routed.pendingAppActionPlan;
                if (routed.pendingWorkTrailId) metadata.workTrailId = routed.pendingWorkTrailId;
              } else if (routed.source === "app-action-planner") {
                const pendingMutation = getChannelSessionAppState(String(sessionId))?.payload?.pendingMutation;
                if (
                  pendingMutation?.kind === "app-action-plan" &&
                  pendingMutation.payload &&
                  typeof pendingMutation.payload === "object"
                ) {
                  metadata.pendingAppActionPlan = (pendingMutation.payload as { plan?: unknown }).plan ?? null;
                }
              }
              return respondDeterministic(response, metadata);
            }
          }
        }

        // ── Fast deterministic workspace root read ──
        // Root listing/explanation prompts are safe, read-only, and bounded.
        // Answer them before the agentic policy so they do not pay a full tool
        // loop just to describe top-level files and folders.
        const earlyWsRead = resolveWorkspaceReadResponse({
          message: rawMessage,
          workspacePath: selectedContext?.workspacePath ?? null,
        });
        if (earlyWsRead) {
          const routeSource = "workspace-read";
          const sessionModel = getModelConfig({ agentId, sessionId: String(sessionId) });
          const enriched = await enrichDeterministicDraftForDepth({
            userMessage: rawMessage,
            draft: earlyWsRead,
            routeSource,
            requireExplicitDepth: true,
            requiredSections: ["Important folders", "Important files", "Evidence limits"],
            provider: sessionModel.provider,
            modelId: sessionModel.modelId,
            apiKey: sessionModel.apiKey,
            baseUrl: sessionModel.baseUrl,
          });
          return respondDeterministic(enriched.answer, {
            routeSource: enriched.diagnostics.applied ? `${routeSource}:model-enriched` : routeSource,
            responseMode: "deterministic",
            deterministicPreflight: { routeSource, answerChars: earlyWsRead.length },
            enrichment: enriched.diagnostics,
          });
        }



        if (
          broadTask.kind === "app_workflow_design" &&
          intent.readOnly &&
          !isCrossSurfaceAppMutationRequest(rawMessage)
        ) {
          const workflowDesignDraft = presentChannelResponse(
            "webchat",
            applyQualityGates(buildWorkflowDesignContractFallbackResponse(rawMessage), rawMessage),
          );
          const routeSource = "broad-task:app_workflow_design:contract";
          const sessionModel = getModelConfig({ agentId, sessionId: String(sessionId) });
          const enriched = await enrichDeterministicDraftForDepth({
            userMessage: rawMessage,
            draft: workflowDesignDraft,
            routeSource,
            requiredSections: [
              "Trigger",
              "Topology",
              "Nodes",
              "Data Flow",
              "Scoring And Dedupe Logic",
              "Error Handling",
              "Risks",
              "Tests",
              "Rollout And Observability",
              "Confirmation Boundary",
              "Acceptance Criteria",
            ],
            provider: sessionModel.provider,
            modelId: sessionModel.modelId,
            apiKey: sessionModel.apiKey,
            baseUrl: sessionModel.baseUrl,
          });
          return respondDeterministic(enriched.answer, {
            routeSource: enriched.diagnostics.applied ? `${routeSource}:model-enriched` : routeSource,
            intent,
            selectedContext,
            broadTaskDecision: broadTask,
            broadTaskLabel: taskKindToLabel(broadTask.kind),
            responseMode: "deterministic",
            deterministicPreflight: { routeSource, answerChars: workflowDesignDraft.length },
            enrichment: enriched.diagnostics,
          });
        }

        // ── Design Studio title-based quick revision ─────────────────────
        // The agentic design tool loop is still used for open-ended design
        // work, but common title-based edits should not fail just because the
        // user did not know the artifact id.
        {
          const quotedTitle =
            rawMessage.match(/\b(?:update|change|revise|edit)\s+(?:the\s+)?["“]([^"”]+)["”]\s+(?:design|artifact)?/i)?.[1]?.trim() ||
            rawMessage.match(/\b(?:update|change|revise|edit)\s+(?:the\s+)?(.+?)\s+design\b/i)?.[1]?.trim();
          const headline = rawMessage.match(/\bheadline\s+(?:to|as|=)\s*["“]([^"”]+)["”]/i)?.[1]?.trim();
          const accent = rawMessage.match(/\baccent\s+(?:to|as|=|color\s+to|colour\s+to)?\s*(teal|cyan|amber|orange|blue|green|purple|pink|red)\b/i)?.[1]?.trim().toLowerCase();

          if (quotedTitle && (headline || accent) && /\bdesigns?|design\s+studio|artifact|headline|accent\b/i.test(rawMessage)) {
            const escapeHtml = (value: string) =>
              value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
            const colorMap: Record<string, { strong: string; soft: string; rgb: string }> = {
              teal: { strong: "#14b8a6", soft: "#0d9488", rgb: "20,184,166" },
              cyan: { strong: "#06b6d4", soft: "#0891b2", rgb: "6,182,212" },
              amber: { strong: "#fbbf24", soft: "#f59e0b", rgb: "245,158,11" },
              orange: { strong: "#fb923c", soft: "#f97316", rgb: "249,115,22" },
              blue: { strong: "#60a5fa", soft: "#2563eb", rgb: "37,99,235" },
              green: { strong: "#22c55e", soft: "#16a34a", rgb: "34,197,94" },
              purple: { strong: "#a78bfa", soft: "#7c3aed", rgb: "124,58,237" },
              pink: { strong: "#f472b6", soft: "#db2777", rgb: "219,39,119" },
              red: { strong: "#f87171", soft: "#dc2626", rgb: "220,38,38" },
            };

            try {
              const store = await import("@/lib/design-studio/store");
              const projects = store.listDesignProjects();
              const normalizedTitle = quotedTitle.toLowerCase();
              let artifact = null as ReturnType<typeof store.getDesignArtifactById> | null;
              for (const project of projects) {
                const match = store.listDesignArtifacts(project.id).find((item) => {
                  const title = item.title.toLowerCase();
                  return title === normalizedTitle || title.includes(normalizedTitle) || normalizedTitle.includes(title);
                });
                if (match) {
                  artifact = store.getDesignArtifactById(match.id);
                  break;
                }
              }

              if (artifact) {
                let html = artifact.currentSource;
                const changes: string[] = [];
                if (headline) {
                  const escaped = escapeHtml(headline);
                  const nextHtml = html
                    .replace(/(<h1\b[^>]*data-disp8ch-id=["']hero-title["'][^>]*>)([\s\S]*?)(<\/h1>)/i, `$1${escaped}$3`)
                    .replace(/(<h1\b[^>]*class=["'][^"']*headline[^"']*["'][^>]*>)([\s\S]*?)(<\/h1>)/i, `$1${escaped}$3`)
                    .replace(/(<h1\b[^>]*>)([\s\S]*?)(<\/h1>)/i, `$1${escaped}$3`);
                  if (nextHtml !== html) {
                    html = nextHtml;
                    changes.push(`headline "${headline}"`);
                  }
                }
                if (accent && colorMap[accent]) {
                  const c = colorMap[accent];
                  const nextHtml = html
                    .replace(/#fbbf24/gi, c.strong)
                    .replace(/#f59e0b/gi, c.soft)
                    .replace(/#d97706/gi, c.soft)
                    .replace(/rgba\(\s*245\s*,\s*158\s*,\s*11\s*,/gi, `rgba(${c.rgb},`);
                  if (nextHtml !== html) {
                    html = nextHtml;
                    changes.push(`${accent} accent`);
                  }
                }

                if (changes.length > 0 && html !== artifact.currentSource) {
                  const updated = store.saveDesignArtifactVersion({
                    artifactId: artifact.id,
                    html,
                    summary: `Updated ${changes.join(" and ")} from WebChat`,
                    createdBy: "agent-patch",
                  });
                  const answer = [
                    `Updated design artifact "${updated.title}".`,
                    `- Artifact: ${updated.id}`,
                    `- Version: v${updated.currentVersionNumber ?? 0}`,
                    `- Changes: ${changes.join(", ")}`,
                    `- Open: /designs?project=${encodeURIComponent(updated.projectId)}&artifact=${encodeURIComponent(updated.id)}`,
                  ].join("\n");
                  return respondDeterministic(answer, {
                    routeSource: "design-studio:title-revision",
                    intent,
                    selectedContext,
                    responseMode: "deterministic",
                  });
                }
              }
            } catch {
              // Fall through to the agentic design loop for richer recovery.
            }
          }
        }

        // ── Agentic routing policy ───────────────────────────────────────
        // For non-trivial tasks, route through the agentic tool loop instead
        // of deterministic lanes. This is the "agent first" principle.
        {
          const { decideAgenticRouting } = await import("@/lib/channels/agentic-routing-policy");
          const agenticPolicy = decideAgenticRouting(rawMessage, {
            protectedBuiltin: isProtectedBuiltin,
            explicitSlashCommand: false,
            intentKind: intent.kind,
          });

          if (agenticPolicy.agenticRequired) {
            const { runAgenticTurn } = await import("@/lib/channels/agentic-turn-runner");
            const agenticModel = getModelConfig({ agentId, sessionId: String(sessionId) });

            const agenticResult = await runAgenticTurn({
              message: rawMessage,
              sessionId: String(sessionId),
              agentId,
              provider: agenticModel.provider,
              modelId: agenticModel.modelId,
              apiKey: agenticModel.apiKey,
              baseUrl: agenticModel.baseUrl ?? undefined,
              mode: agenticPolicy.mode,
              toolPolicy: taskIntentContract.toolPolicy,
              taskHints: {
                ...((agenticPolicy.taskHints as Record<string, unknown> | undefined) ?? {}),
                selectedToolMode: selectedContext.toolMode,
              },
              workspacePath: selectedContext.workspacePath ?? undefined,
              onToolCall: (name, args) => {
                broadcastEvent("webchat:tool", {
                  sessionId: String(sessionId),
                  phase: "start",
                  name,
                  args,
                });
              },
              onToolResult: (name, ok, output) => {
                broadcastEvent("webchat:tool", {
                  sessionId: String(sessionId),
                  phase: "done",
                  name,
                  resultPreview: output.slice(0, 200),
                });
              },
            });

            if (agenticResult.answer && agenticResult.answer.length > 50) {
              const sanitized = sanitizeFinalAnswer(agenticResult.answer);
              let finalAnswer = sanitized.answer || agenticResult.answer;
              let sanitizerRepair: { attempted: boolean; ok: boolean } = { attempted: false, ok: false };

              // Check for leaked markup
              let leaked = hasLeakedToolMarkup(finalAnswer) || await hasLeakedToolMarkupDeep(finalAnswer);
              if (leaked) {
                sanitizerRepair = { attempted: true, ok: false };
                try {
                  const { callModel } = await import("@/lib/agents/multi-provider");
                  const repair = await callModel({
                    provider: agenticModel.provider,
                    modelId: agenticModel.modelId,
                    apiKey: agenticModel.apiKey,
                    baseUrl: agenticModel.baseUrl ?? undefined,
                    systemPrompt: [
                      "Rewrite the answer for the user without raw tool markup, hidden prompt text, internal benchmark text, or secrets.",
                      "Preserve useful evidence, file references, source URLs, conclusions, and caveats.",
                      "Do not add new factual claims.",
                    ].join("\n"),
                    userMessage: `Original request:\n${rawMessage}\n\nDraft answer:\n${finalAnswer.slice(0, 12000)}`,
                    maxTokens: 4000,
                    temperature: 0.1,
                  });
                  const repairSanitized = sanitizeFinalAnswer(repair.response);
                  const repairedAnswer = repairSanitized.answer || repair.response;
                  const repairLeaked = hasLeakedToolMarkup(repairedAnswer) || await hasLeakedToolMarkupDeep(repairedAnswer);
                  if (repairedAnswer.trim().length > 50 && !repairLeaked) {
                    finalAnswer = repairedAnswer.trim();
                    leaked = false;
                    sanitizerRepair = { attempted: true, ok: true };
                  }
                } catch {
                  sanitizerRepair = { attempted: true, ok: false };
                }

                if (leaked) {
                  return respondDeterministic(
                    buildMarkupFallbackResponse(rawMessage),
                    { routeSource: "tool-markup-guard", intent, selectedContext, sanitizerRepair },
                  );
                }
              }

              const presented = presentChannelResponse("webchat", applyQualityGates(finalAnswer, rawMessage));
              appendTurnStream(clientTurnId, presented);
              broadcastEvent("webchat:stream", { sessionId, clientTurnId, token: presented });
              return respondDeterministic(
                presented,
                {
                  routeSource: typeof agenticResult.metadata.routeSource === "string"
                    ? agenticResult.metadata.routeSource
                    : "agentic:universal",
                  intent,
                  selectedContext,
                  agenticRequired: true,
                  agenticPolicy: { mode: agenticPolicy.mode, reason: agenticPolicy.reason },
                  universalAgentic: agenticResult.metadata,
                  ...(agenticResult.metadata.evidenceContract
                    ? { evidenceContract: agenticResult.metadata.evidenceContract }
                    : {}),
                  ...(agenticResult.metadata.broadEvidenceMetrics
                    ? { broadEvidenceMetrics: agenticResult.metadata.broadEvidenceMetrics }
                    : {}),
                  agenticRepairAttempts: agenticResult.repairAttempts,
                  sanitizerRepair,
                  toolsUsed: agenticResult.toolsUsed,
                },
              );
            }
            // If agentic loop returned empty, fall through to deterministic lanes
          }
        }

        // ── Capability/image/transcript preflights ─────────────────────────
        // These prompts contain app-surface words such as "workflow" or
        // "agent", but the user is asking about a tool/capability. Handle them
        // before surface routing so we do not ask for workflow/agent details.
        if (isCapabilityAuditPrompt(rawMessage)) {
          // Use the agent loop for query-driven capability audits.
          // Instead of a fixed table, let the model inspect the specific capabilities asked about.
          const { answerWithReadOnlyRepoTools } = await import("@/lib/channels/repo-inspection-controller");
          const capAuditModel = getModelConfig({ agentId, sessionId: String(sessionId) });

          const capAuditSystemPrompt = [
            "Audit ONLY the capabilities the user asked about. For each, search the tool catalog",
            "(src/lib/engine/tools.ts), node registry (src/lib/engine/node-registry.ts), and channel modules,",
            "then read the implementing files. Report a table: Capability | Implemented (code exists) |",
            "Configured now (credential/secret present) | Planned/missing | Evidence (file refs).",
            "Do not invent capabilities the user didn't ask about. Do not run paid actions.",
            "Do NOT edit files. Do NOT print secret values.",
          ].join("\n");

          const capAuditAnswer = await answerWithReadOnlyRepoTools({
            message: rawMessage,
            sessionId: String(sessionId),
            agentId,
            provider: capAuditModel.provider,
            modelId: capAuditModel.modelId,
            apiKey: capAuditModel.apiKey,
            baseUrl: capAuditModel.baseUrl ?? undefined,
            mode: "balanced",
            systemPrompt: capAuditSystemPrompt,
          });

          if (capAuditAnswer && capAuditAnswer.length > 50) {
            return respondDeterministic(
              presentChannelResponse("webchat", applyQualityGates(capAuditAnswer, rawMessage)),
              {
                routeSource: "capability-audit",
                intent,
                selectedContext,
                broadTaskDecision: broadTask,
                broadTaskLabel: taskKindToLabel(broadTask.kind),
                responseMode: "deterministic",
              },
            );
          }

          // Fallback to deterministic audit if agent loop returns empty
          return respondDeterministic(
            buildCapabilityAuditResponse(rawMessage),
            {
              routeSource: "capability-audit",
              intent,
              selectedContext,
              broadTaskDecision: broadTask,
              broadTaskLabel: taskKindToLabel(broadTask.kind),
              responseMode: "deterministic",
            },
          );
        }

        if (isYoutubeTranscriptPrompt(rawMessage)) {
          const { isYouTubeUrl } = await import("@/lib/video/youtube-transcript");
          const { fetchTranscriptRobust, formatTranscriptResult } = await import("@/lib/video/youtube-transcript-strategies");
          const urlMatch = rawMessage.match(/((?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)[\w-]+)/i);
          if (urlMatch && isYouTubeUrl(urlMatch[0])) {
            const result = await fetchTranscriptRobust(urlMatch[0]);
            if (result.ok && result.segments.length > 0) {
              const timestampedBullets = result.segments
                .filter((_, i) => i % Math.max(1, Math.floor(result.segments.length / 5)) === 0)
                .slice(0, 5)
                .map((s) => {
                  const min = Math.floor(s.start / 60);
                  const sec = Math.floor(s.start % 60);
                  return `${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")} - ${s.text.slice(0, 200)}`;
                })
                .join("\n");
              return respondDeterministic(
                [
                  `Transcript retrieved for ${result.videoId}${result.title ? ` ("${result.title}")` : ""}`,
                  `Source: ${result.source} · Language: ${result.language ?? "unknown"} · Segments: ${result.segments.length}`,
                  "",
                  `Video ID: ${result.videoId}`,
                  `Transcript source: ${result.source}`,
                  `Language: ${result.language ?? "unknown"}`,
                  `Segments: ${result.segments.length}`,
                  `Generated captions: ${result.isGenerated ? "yes" : "no"}`,
                  "",
                  "## Timestamped preview (5 segments)",
                  timestampedBullets,
                  "",
                  result.fullText.slice(0, 4000),
                ].join("\n"),
                {
                  routeSource: "youtube-transcript",
                  intent,
                  selectedContext,
                  broadTaskDecision: broadTask,
                  broadTaskLabel: taskKindToLabel(broadTask.kind),
                  responseMode: "deterministic",
                  transcript: {
                    videoId: result.videoId,
                    source: result.source,
                    language: result.language,
                    segmentCount: result.segments.length,
                    attempts: result.attempts,
                  },
                },
              );
            }
            if (!result.ok) {
              const attemptSummary = result.attempts
                .map((a) => `${a.strategy}: ${a.ok ? "ok" : a.errorCode ?? "failed"} (${a.durationMs}ms)`)
                .join(", ");
              return respondDeterministic(
                [
                  buildYoutubeTranscriptUnavailableResponse(rawMessage),
                  "",
                  "## Runtime Attempt Summary",
                  `Transcript unavailable for ${result.videoId ?? urlMatch[0]}.`,
                  `Error: ${result.errorCode}.`,
                  `Strategies attempted: ${attemptSummary}.`,
                ].join("\n"),
                {
                  routeSource: "youtube-transcript-failure",
                  intent,
                  selectedContext,
                  broadTaskDecision: broadTask,
                  broadTaskLabel: taskKindToLabel(broadTask.kind),
                  responseMode: "deterministic",
                  transcript: { ok: false, errorCode: result.errorCode, attempts: result.attempts },
                },
              );
            }
          }
          return respondDeterministic(
            buildYoutubeTranscriptUnavailableResponse(rawMessage),
            {
              routeSource: "youtube-transcript-preflight",
              intent,
              selectedContext,
              broadTaskDecision: broadTask,
              broadTaskLabel: taskKindToLabel(broadTask.kind),
              responseMode: "deterministic",
            },
          );
        }

        clearStaleImageFallbacks();
        if (
          isImageFallbackConfirm(rawMessage) &&
          pendingImageFallbackForSession.has(String(sessionId))
        ) {
          const pending = pendingImageFallbackForSession.get(String(sessionId))!;
          pendingImageFallbackForSession.delete(String(sessionId));
          try {
            const fallbackResult = await runBrowserImageFallback({
              sessionId: String(sessionId),
              shape: pending.shape,
              prompt: pending.prompt,
            });
            if (fallbackResult.ok && fallbackResult.markdown) {
              return respondDeterministic(
                presentChannelResponse("webchat", fallbackResult.markdown),
                {
                  routeSource: "browser-image-fallback",
                  intent,
                  selectedContext,
                  broadTaskDecision: broadTask,
                  broadTaskLabel: taskKindToLabel(broadTask.kind),
                  responseMode: "deterministic",
                  imageGeneration: { fallback: true, ok: true },
                },
              );
            }
            return respondDeterministic(
              presentChannelResponse("webchat", `Browser fallback failed: ${fallbackResult.error || "unknown error"}`),
              {
                routeSource: "browser-image-fallback-error",
                intent,
                selectedContext,
                broadTaskDecision: broadTask,
                broadTaskLabel: taskKindToLabel(broadTask.kind),
                responseMode: "deterministic",
                imageGeneration: { fallback: true, ok: false, error: fallbackResult.error },
              },
            );
          } catch (fallbackErr) {
            return respondDeterministic(
              presentChannelResponse("webchat", `Browser fallback failed: ${String(fallbackErr)}`),
              {
                routeSource: "browser-image-fallback-error",
                intent,
                selectedContext,
                broadTaskDecision: broadTask,
                broadTaskLabel: taskKindToLabel(broadTask.kind),
                responseMode: "deterministic",
                imageGeneration: { fallback: true, ok: false },
              },
            );
          }
        }

        if (isImageGenerationPrompt(rawMessage)) {
          const imageConfig = await resolveImageGenerationConfig();
          if (!imageConfig.configured) {
            const requestedShape = /\bportrait\b/i.test(rawMessage)
              ? "portrait"
              : /\bsquare\b/i.test(rawMessage)
                ? "square"
                : /\blandscape\b/i.test(rawMessage)
                  ? "landscape"
                  : "default";
            pendingImageFallbackForSession.set(String(sessionId), {
              shape: requestedShape,
              prompt: rawMessage.slice(0, 300),
              at: Date.now(),
            });
            const { isLocalRenderEligible, renderLocalArtifact, buildLocalRenderResponse } = await import("@/lib/image-gen/local-artifact-renderer");
            if (isLocalRenderEligible(rawMessage)) {
              try {
                const localResult = await renderLocalArtifact({ prompt: rawMessage });
                const localResponse = buildLocalRenderResponse(localResult, rawMessage);
                return respondDeterministic(
                  localResponse,
                  {
                    routeSource: "image-generation-local",
                    intent,
                    selectedContext,
                    broadTaskDecision: broadTask,
                    broadTaskLabel: taskKindToLabel(broadTask.kind),
                    responseMode: "deterministic",
                    imageGeneration: { configured: false, localFallback: true, kind: localResult.kind, imageId: localResult.imageId },
                  },
                );
              } catch (renderError) {
                // Fall through to unavailable response if local render fails
              }
            }
            try {
              const fallbackResult = await runBrowserImageFallback({
                sessionId: String(sessionId),
                shape: requestedShape,
                prompt: rawMessage,
              });
              if (fallbackResult.ok && fallbackResult.markdown) {
                pendingImageFallbackForSession.delete(String(sessionId));

                // Build a rich response that combines the artifact with configuration details
                const providerTable = [
                  "| Provider | Required env/secret | Where to set it |",
                  "| --- | --- | --- |",
                  "| FAL (default) | `FAL_API_KEY` | Settings > Secrets, or env var |",
                  "| OpenAI | `OPENAI_API_KEY` | Settings > Secrets, or env var |",
                  "| xAI | `XAI_API_KEY` | Settings > Secrets, or env var |",
                ].join("\n");

                const richResponse = [
                  fallbackResult.markdown,
                  "",
                  "---",
                  "",
                  "### Why native image generation was not used",
                  "",
                  `**Status:** ${imageConfig.missingReason}.`,
                  "",
                  providerTable,
                  "",
                  "### To enable real AI image generation",
                  "",
                  "1. Get an API key from one of the providers above (e.g., [fal.ai](https://fal.ai) for FAL).",
                  "2. Add it in **Settings > Secrets** (or set the env var directly, e.g., `FAL_API_KEY=fal-...`).",
                  "3. Send a new image prompt — the app will automatically use the configured provider.",
                  "",
                  "### What the browser fallback can and cannot do",
                  "",
                  "- **Can:** Render UI mockups, dashboards, diagrams, and text-heavy visuals as PNG artifacts.",
                  "- **Cannot:** Generate photorealistic images, illustrations, custom artwork, or AI-generated visuals.",
                  "",
                  "The fallback used a pre-built HTML template rendered via headless browser screenshot — no AI model was involved.",
                ].join("\n");

                return respondDeterministic(
                  presentChannelResponse("webchat", richResponse),
                  {
                    routeSource: "browser-image-fallback-auto",
                    intent,
                    selectedContext,
                    broadTaskDecision: broadTask,
                    broadTaskLabel: taskKindToLabel(broadTask.kind),
                    responseMode: "deterministic",
                    imageGeneration: {
                      configured: false,
                      fallback: true,
                      ok: true,
                      missingReason: imageConfig.missingReason,
                      availableProviders: imageConfig.availableProviders,
                    },
                  },
                );
              }
            } catch {
              // Fall through to the configuration explanation if the browser fallback is unavailable.
            }
            return respondDeterministic(
              buildImageGenerationUnavailableResponse(rawMessage),
              {
                routeSource: "image-generation-preflight",
                intent,
                selectedContext,
                broadTaskDecision: broadTask,
                broadTaskLabel: taskKindToLabel(broadTask.kind),
                responseMode: "deterministic",
                imageGeneration: { configured: false, missingReason: imageConfig.missingReason, availableProviders: imageConfig.availableProviders },
              },
            );
          }
          broadcastEvent("webchat:tool", {
            clientTurnId,
            sessionId,
            phase: "start",
            name: "image_generate",
            args: imageGenerationArgsForPrompt(rawMessage),
          });
          const imageResult = await executeTool(
            "image_generate",
            imageGenerationArgsForPrompt(rawMessage),
            { agentId, channelSessionId: String(sessionId), toolMode: selectedContext.toolMode },
          );
          broadcastEvent("webchat:tool", {
            clientTurnId,
            sessionId,
            phase: "done",
            name: "image_generate",
            resultPreview: imageResult.slice(0, 300),
          });
          return respondDeterministic(
            presentChannelResponse("webchat", imageResult),
            {
              routeSource: "image-generation",
              intent,
              selectedContext,
              broadTaskDecision: broadTask,
              broadTaskLabel: taskKindToLabel(broadTask.kind),
              responseMode: "deterministic",
              imageGeneration: { configured: true },
            },
          );
        }

        // ── Deterministic workspace read (before fallback assistant) ──
        const wsRead = resolveWorkspaceReadResponse({
          message: rawMessage,
          workspacePath: selectedContext?.workspacePath ?? null,
        });
        if (wsRead) {
          return respondDeterministic(wsRead, { routeSource: "workspace-read", responseMode: "deterministic" });
        }

        if (intent.readOnly && !isCrossSurfaceAppMutationRequest(rawMessage) && !deepInspection.shouldBypassAppSurface && !isProtectedBuiltin && (!broadResearchPrompt || Boolean(intent.surface))) {
          // Resolve the real provider/model the session would use this turn —
          // selectedContext.modelRef is an opaque model-row id, not provider:model.
          const sessionModel = getModelConfig({ agentId, sessionId: String(sessionId) });
          const sessionCtx = {
            modelId: sessionModel.modelId,
            provider: sessionModel.provider,
            workspacePath: selectedContext?.workspacePath ?? undefined,
            fastMode: sessionModel.fastMode ?? selectedContext?.fastMode ?? undefined,
            toolMode: selectedContext?.toolMode ?? undefined,
            readOnly: intent.readOnly,
          };
          const appSurfaceResponse = resolveAppSurfaceResponse(rawMessage, intent.surface, sessionCtx);
          if (appSurfaceResponse) {
            if (shouldModelEnrichAppSurface({ message: rawMessage, deterministicResponse: appSurfaceResponse })) {
              const enriched = await resolveChannelResponseWithFallback({
                routed: { response: NO_WORKFLOW_FALLBACK_TEXT, workflowId: null, workflowName: null, source: "none" as const },
                rawMessage: [
                  "You are enriching a disp8ch AI app-surface answer.",
                  "Do not create, update, delete, schedule, send, or execute anything.",
                  "Use the deterministic state below as the source of truth.",
                  "Write a concrete answer using actual disp8ch AI surfaces, tools, templates, and confirmation boundaries.",
                  "",
                  "User request:",
                  rawMessage,
                  "",
                  "Deterministic state and safety boundary:",
                  appSurfaceResponse,
                  "",
                  buildDisp8chSystemMap(),
                ].join("\n"),
                sessionId: String(sessionId),
                agentId,
                readOnly: true,
                includeRecentHistory: true,
                forceTools: true,
                intentKind: "app-mutation-proposal",
                onEmit: (event, data) => {
                  if (event === "stream:token") {
                    const token = typeof (data as { token?: unknown })?.token === "string"
                      ? String((data as { token?: unknown }).token)
                      : "";
                    appendTurnStream(clientTurnId, token);
                    broadcastEvent("webchat:stream", { sessionId, clientTurnId, ...(data as object) });
                    return;
                  }
                  if (event === "stream:status") {
                    const payload = data && typeof data === "object" ? data as Record<string, unknown> : {};
                    broadcastEvent("webchat:status", {
                      clientTurnId,
                      sessionId,
                      phase: String(payload.phase || "model_call"),
                      label: String(payload.label || "Calling model..."),
                      detail: null,
                      createdAt: new Date().toISOString(),
                    });
                  }
                },
              });
              const enrichedResponse = enriched.responseText?.trim();
              if (enrichedResponse && !isEmptyWorkspaceFallback(enrichedResponse)) {
                return respondDeterministic(
                  presentChannelResponse("webchat", applyQualityGates(enrichedResponse, rawMessage)),
                  { routeSource: "app-surface-model-enriched", intent, selectedContext, fallbackAssistant: enriched.fallbackAssistant },
                );
              }
            }
            return respondDeterministic(
              appSurfaceResponse,
              { routeSource: "app-surface-handler", intent, selectedContext, responseMode: "deterministic" },
            );
          }
        }

        // ── Code review/change lane (read-only until explicit confirmation support applies edits) ──
        const codeTaskMode = deepInspection.shouldBypassCodeTask || broadTask.kind === "web_research"
          ? null
          : isCodeReviewRequest(rawMessage)
            ? "review"
            : isCodeChangeRequest(rawMessage)
              ? "change"
              : null;
        if (codeTaskMode) {
          if (codeTaskMode === "review") {
            const scopeMatch = rawMessage.match(/\b((?:src|app|scripts|docs|lib|components)\/[^\s,;:)]+)\b/i);
            const reviewText = await executeTool(
              "code_review",
              { scope: scopeMatch?.[1] ?? "" },
              { agentId, channelSessionId: String(sessionId), readOnly: true },
            );
            if (reviewText && !/^\[Max tool calls reached/i.test(reviewText) && !isRawCliHelpOrToolDump(reviewText)) {
              return respondDeterministic(
                presentChannelResponse("webchat", applyQualityGates(reviewText, rawMessage)),
                { routeSource: "code-task", intent, selectedContext, responseMode: "deterministic" },
              );
            }
          }
          const codeSystem = codeTaskMode === "review"
            ? buildCodeReviewSystemPrompt()
            : buildCodeChangeSystemPrompt();
          const codeResult = await resolveChannelResponseWithFallback({
            routed: { response: NO_WORKFLOW_FALLBACK_TEXT, workflowId: null, workflowName: null, source: "none" as const },
            rawMessage: `${codeSystem}\n\nUser request: ${rawMessage}`,
            sessionId: String(sessionId),
            agentId,
            readOnly: true,
            includeRecentHistory: true,
            forceTools: true,
            intentKind: "read-only-tool",
            onEmit: (event, data) => forwardWebChatAssistantEvent(event, data),
          });
          const codeResponse = codeResult.responseText ?? NO_WORKFLOW_FALLBACK_TEXT;
          const codeLeaked = hasLeakedToolMarkup(codeResponse) || await hasLeakedToolMarkupDeep(codeResponse);
          if (codeLeaked) {
            return respondDeterministic(
              buildMarkupFallbackResponse(rawMessage),
              { routeSource: "tool-markup-guard", intent, selectedContext },
            );
          }
          return respondDeterministic(
            presentChannelResponse("webchat", applyQualityGates(codeResponse, rawMessage)),
            { routeSource: "code-task", intent, selectedContext, fallbackAssistant: codeResult.fallbackAssistant },
          );
        }

        // ── Tool-heavy mixed-evidence lane ────────────────────────────────
        // Explicit mixed-evidence prompts need repo/docs/web/capability evidence
        // in one bounded pass. Run this before the single-source repo/web lanes
        // so mixed prompts do not lose half the requested evidence.
        if (!isProtectedBuiltin && taskIntentContract.toolPolicy !== "forbidden") {
          const toolHeavyEvidence = await runToolHeavyEvidenceCollection({
            message: rawMessage,
            sessionId: String(sessionId),
            agentId,
            maxTotalTools: 24,
            onBucketComplete: (bucket, evidence) => {
              broadcastEvent("webchat:status", {
                clientTurnId,
                sessionId,
                phase: "evidence_bucket",
                label: `Collected ${evidence.label}`,
                detail: `${evidence.entries.filter((entry) => entry.verified).length} verified evidence item(s)`,
                bucket,
                createdAt: new Date().toISOString(),
              });
            },
          });
          if (toolHeavyEvidence) {
            const evidencePrompt = buildToolHeavyEvidencePrompt(toolHeavyEvidence);
            const answerResult = await resolveChannelResponseWithFallback({
              routed: { response: NO_WORKFLOW_FALLBACK_TEXT, workflowId: null, workflowName: null, source: "none" as const },
              rawMessage,
              sessionId: String(sessionId),
              agentId,
              readOnly: true,
              includeRecentHistory: true,
              forceTools: false,
              intentKind: "read-only-tool",
              preflightEvidence: [
                evidencePrompt,
                "",
                "Use only the collected evidence above for concrete claims. Label missing evidence instead of guessing.",
              ].join("\n"),
              preflightMetrics: toolHeavyEvidence.metrics,
              onEmit: (event, data) => forwardWebChatAssistantEvent(event, data),
            });
            let toolHeavyResponse = sanitizeFinalAnswer(answerResult.responseText ?? NO_WORKFLOW_FALLBACK_TEXT).answer || NO_WORKFLOW_FALLBACK_TEXT;
            let toolHeavyContract = evaluateToolHeavyAnswerContract(
              toolHeavyEvidence.plan,
              toolHeavyResponse,
              toolHeavyEvidence.totalVerifiedItems,
            );
            if (!toolHeavyContract.ok && !isEmptyWorkspaceFallback(toolHeavyResponse)) {
              const repairResult = await resolveChannelResponseWithFallback({
                routed: { response: NO_WORKFLOW_FALLBACK_TEXT, workflowId: null, workflowName: null, source: "none" as const },
                rawMessage: `${rawMessage}\n\n${toolHeavyContract.repairInstruction}\n\nDraft answer:\n${toolHeavyResponse.slice(0, 6000)}`,
                sessionId: String(sessionId),
                agentId,
                readOnly: true,
                includeRecentHistory: false,
                forceTools: false,
                intentKind: "read-only-tool",
                preflightEvidence: evidencePrompt,
              });
              const repaired = repairResult.responseText?.trim();
              if (repaired) {
                const sanitized = sanitizeFinalAnswer(repaired).answer || repaired;
                const repairedContract = evaluateToolHeavyAnswerContract(
                  toolHeavyEvidence.plan,
                  sanitized,
                  toolHeavyEvidence.totalVerifiedItems,
                );
                if (repairedContract.ok || (
                  repairedContract.issues.length < toolHeavyContract.issues.length &&
                  sanitized.length > toolHeavyResponse.length
                )) {
                  toolHeavyResponse = sanitized;
                  toolHeavyContract = repairedContract;
                }
              }
            }
            if (!toolHeavyContract.ok) {
              const fallback = buildToolHeavyContractFallbackAnswer(toolHeavyEvidence);
              const fallbackContract = evaluateToolHeavyAnswerContract(
                toolHeavyEvidence.plan,
                fallback,
                toolHeavyEvidence.totalVerifiedItems,
              );
              toolHeavyResponse = fallback;
              toolHeavyContract = fallbackContract;
            }
            const leaked = hasLeakedToolMarkup(toolHeavyResponse) || await hasLeakedToolMarkupDeep(toolHeavyResponse);
            if (leaked) {
              toolHeavyResponse = buildMarkupFallbackResponse(rawMessage);
            }
            return respondDeterministic(
              presentChannelResponse("webchat", applyQualityGates(toolHeavyResponse, rawMessage)),
              {
                routeSource: leaked ? "tool-markup-guard" : "tool-heavy-evidence",
                intent,
                selectedContext,
                fallbackAssistant: answerResult.fallbackAssistant,
                toolHeavyEvidence: {
                  taskType: toolHeavyEvidence.plan.taskType,
                  totalToolsUsed: toolHeavyEvidence.totalToolsUsed,
                  totalVerifiedItems: toolHeavyEvidence.totalVerifiedItems,
                  buckets: toolHeavyEvidence.buckets.map((bucket) => ({
                    bucket: bucket.bucket,
                    toolsUsed: bucket.toolsUsed,
                    verifiedItems: bucket.entries.filter((entry) => entry.verified).length,
                    targetMet: bucket.targetMet,
                  })),
                },
                toolHeavyAnswerContract: { ok: toolHeavyContract.ok, issues: toolHeavyContract.issues },
              },
            );
          }
        }

        // ── Repo-grounded read-only inspection lane ──
        // The older deep-inspection regex is intentionally broad. Treat it as
        // a signal, but let the task contract + arbiter make the final call so
        // terms like "router" in a conceptual comparison do not force repo IO.
        const shouldRunRepoInspectionLane =
          !isProtectedBuiltin &&
          (routingDecision.lane === "repo_inspection" || (
            deepAuditProfile.enabled &&
            /\b(?:repo|repository|codebase|workspace|files?|src\/|code|grounding|contract|quality\s+gate)\b/i.test(rawMessage)
          )) &&
          (routingDecision.requiresToolUse || deepAuditProfile.enabled) &&
          taskIntentContract.toolPolicy !== "forbidden" &&
          (deepInspection.intent === "repo_inspection" || isRepoInspectRequest(rawMessage) || deepAuditProfile.enabled);
        if (shouldRunRepoInspectionLane) {
          const repoMap = buildRepoMap();
          let repoToolEventsVisible = false;
          const bufferedRepoTokens: string[] = [];
          let repoEvidence = await collectRepoInspectionEvidence({
            message: rawMessage,
            sessionId: String(sessionId),
            agentId,
            mode: "thorough",
            readOnly: true,
            onEmit: (event, data) => {
              if (event === "webchat:tool") repoToolEventsVisible = true;
              forwardWebChatAssistantEvent(event, data, { bufferTokens: bufferedRepoTokens });
            },
          });
          if (isRootWorkspaceExplanationRequest(rawMessage)) {
            let riResponse = buildRootWorkspaceExplanationResponse(repoEvidence);
            const contract = evaluateRepoEvidenceContract({
              answer: riResponse,
              userMessage: rawMessage,
              evidence: repoEvidence,
              visibleToolEvents: repoToolEventsVisible,
              mode: "thorough",
            });
            const deepContract = evaluateDeepAnswerContract({
              answer: riResponse,
              userMessage: rawMessage,
              minWords: 180,
            });
            const sanitizedRepoFinal = sanitizeFinalAnswer(riResponse);
            if (sanitizedRepoFinal.changed) riResponse = sanitizedRepoFinal.answer;
            const finalRepoResponse = presentChannelResponse("webchat", applyQualityGates(riResponse, rawMessage));
            appendTurnStream(clientTurnId, finalRepoResponse);
            broadcastEvent("webchat:stream", { sessionId, clientTurnId, token: finalRepoResponse });
            return respondDeterministic(
              finalRepoResponse,
              {
                routeSource: "repo-inspection:root-explanation",
                intent,
                selectedContext,
                fallbackAssistant: false,
                repoEvidence: repoEvidence.metrics,
                evidenceContract: { ok: contract.ok, issues: contract.issues },
                deepAnswerContract: { ok: deepContract.ok, issues: deepContract.issues },
              },
            );
          }
          if (deepAuditProfile.enabled && deepAuditProfile.kind) {
            const expansion = planDeepAuditExpansion(repoEvidence, repoEvidence.filesRead, repoEvidence.searchesRun);
            if (expansion.extraReads.length > 0 || expansion.extraSearches.length > 0) {
              const extraEvidence = await collectRepoInspectionEvidence({
                message: rawMessage,
                sessionId: String(sessionId),
                agentId,
                mode: "thorough",
                readOnly: true,
                requiredReads: expansion.extraReads,
                requiredSearches: expansion.extraSearches,
                onEmit: (event, data) => {
                  if (event === "webchat:tool") repoToolEventsVisible = true;
                  forwardWebChatAssistantEvent(event, data, { bufferTokens: bufferedRepoTokens });
                },
              });
              repoEvidence = mergeRepoInspectionEvidence(repoEvidence, extraEvidence);
            }

            const outline = buildDeepAuditOutline(
              deepAuditProfile,
              repoEvidence.filesRead,
              repoEvidence.searchesRun,
              [],
              [],
            );
            const sessionModel = getModelConfig({ agentId, sessionId: String(sessionId) });
            const providerGuidance = buildProviderOperationalGuidance(sessionModel.provider, sessionModel.modelId);
            const synthesis = await synthesizeDeepAuditAnswer({
              userMessage: rawMessage,
              profile: deepAuditProfile,
              outline,
              evidencePromptBlock: [
                providerGuidance,
                repoEvidence.promptBlock,
              ].filter(Boolean).join("\n\n"),
              provider: sessionModel.provider,
              modelId: sessionModel.modelId,
              apiKey: sessionModel.apiKey,
              baseUrl: sessionModel.baseUrl,
              maxTokens: deepAuditProfile.synthesisBudget === "expanded" ? 7000 : 4500,
              temperature: 0.2,
            });
            let riResponse = sanitizeFinalAnswer(
              synthesis.answer.trim() || buildFallbackDeepAuditAnswer(deepAuditProfile, outline, repoEvidence.promptBlock, rawMessage),
            ).answer || NO_WORKFLOW_FALLBACK_TEXT;
            let contract = evaluateRepoEvidenceContract({
              answer: riResponse,
              userMessage: rawMessage,
              evidence: repoEvidence,
              visibleToolEvents: repoToolEventsVisible,
              mode: "thorough",
            });
            let deepContract = evaluateDeepAnswerContract({
              answer: riResponse,
              userMessage: rawMessage,
              minWords: 220,
            });
            let deepAuditContract = evaluateDeepAuditContract(deepAuditProfile, riResponse, repoEvidence.filesRead, rawMessage);

            if (isEmptyWorkspaceFallback(riResponse) || riResponse.trim().length < 200 || !deepAuditContract.ok || !contract.ok) {
              riResponse = sanitizeFinalAnswer(buildFallbackDeepAuditAnswer(deepAuditProfile, outline, repoEvidence.promptBlock, rawMessage)).answer;
              contract = evaluateRepoEvidenceContract({
                answer: riResponse,
                userMessage: rawMessage,
                evidence: repoEvidence,
                visibleToolEvents: repoToolEventsVisible,
                mode: "thorough",
              });
              deepContract = evaluateDeepAnswerContract({
                answer: riResponse,
                userMessage: rawMessage,
                minWords: 220,
              });
              deepAuditContract = evaluateDeepAuditContract(deepAuditProfile, riResponse, repoEvidence.filesRead, rawMessage);
            }

            let enrichmentDiagnostics: Record<string, unknown> | undefined;
            if (synthesis.usedModel && shouldEnrich(deepAuditProfile.depthTier) && contract.ok && deepContract.ok && deepAuditContract.ok && riResponse.trim().length >= 200) {
              const enrichment = await enrichDeepSynthesisAnswer({
                userMessage: rawMessage,
                safeAnswer: riResponse,
                evidencePromptBlock: repoEvidence.promptBlock,
                routeSource: "repo-inspection:deep-audit",
                depthTier: deepAuditProfile.depthTier,
                requiredSections: deepAuditProfile.requiredSections,
                provider: sessionModel.provider,
                modelId: sessionModel.modelId,
                apiKey: sessionModel.apiKey,
                baseUrl: sessionModel.baseUrl,
              });
              enrichmentDiagnostics = { usedModel: enrichment.usedModel, ...enrichment.diagnostics };
              if (enrichment.usedModel && enrichment.answer && enrichment.answer.length > riResponse.length * 0.7) {
                const enrichedSanitized = sanitizeFinalAnswer(enrichment.answer);
                if (enrichedSanitized.changed) {
                  enrichmentDiagnostics = { ...enrichmentDiagnostics, sanitized: true, leaked: enrichedSanitized.leaked };
                }
                // Re-check contracts on enriched answer; keep only if they still pass
                const enrichedContract = evaluateRepoEvidenceContract({
                  answer: enrichedSanitized.answer,
                  userMessage: rawMessage,
                  evidence: repoEvidence,
                  visibleToolEvents: repoToolEventsVisible,
                  mode: "thorough",
                });
                const enrichedDeepContract = evaluateDeepAnswerContract({
                  answer: enrichedSanitized.answer,
                  userMessage: rawMessage,
                  minWords: 220,
                });
                const enrichedDeepAuditContract = evaluateDeepAuditContract(deepAuditProfile, enrichedSanitized.answer, repoEvidence.filesRead, rawMessage);
                if (enrichedContract.ok && enrichedDeepContract.ok && enrichedDeepAuditContract.ok) {
                  riResponse = enrichedSanitized.answer;
                  contract = enrichedContract;
                  deepContract = enrichedDeepContract;
                  deepAuditContract = enrichedDeepAuditContract;
                  enrichmentDiagnostics = { ...enrichmentDiagnostics, applied: true };
                } else {
                  enrichmentDiagnostics = {
                    ...enrichmentDiagnostics,
                    applied: false,
                    rejectedReason: "contracts failed after enrichment",
                    enrichedContractOk: enrichedContract.ok,
                    enrichedDeepContractOk: enrichedDeepContract.ok,
                    enrichedDeepAuditContractOk: enrichedDeepAuditContract.ok,
                  };
                }
              }
            }

            const leaked = hasLeakedToolMarkup(riResponse) || await hasLeakedToolMarkupDeep(riResponse);
            if (leaked) {
              return respondDeterministic(
                buildMarkupFallbackResponse(rawMessage),
                { routeSource: "tool-markup-guard", intent, selectedContext },
              );
            }
            const finalRepoResponse = presentChannelResponse("webchat", applyQualityGates(riResponse, rawMessage));
            appendTurnStream(clientTurnId, finalRepoResponse);
            broadcastEvent("webchat:stream", { sessionId, clientTurnId, token: finalRepoResponse });
            return respondDeterministic(
              finalRepoResponse,
              {
                routeSource: "repo-inspection:deep-audit",
                intent,
                selectedContext,
                fallbackAssistant: false,
                repoEvidence: repoEvidence.metrics,
                deepAudit: {
                  kind: deepAuditProfile.kind,
                  confidence: deepAuditProfile.confidence,
                  depthTier: deepAuditProfile.depthTier,
                  expansion,
                  synthesisUsedModel: synthesis.usedModel,
                  synthesisDiagnostics: synthesis.diagnostics,
                  ...(enrichmentDiagnostics ? { enrichment: enrichmentDiagnostics } : {}),
                },
                evidenceContract: { ok: contract.ok, issues: contract.issues },
                deepAnswerContract: { ok: deepContract.ok, issues: deepContract.issues },
                deepAuditContract: { ok: deepAuditContract.ok, issues: deepAuditContract.issues },
              },
            );
          }
          const riResult = await resolveChannelResponseWithFallback({
            routed: { response: NO_WORKFLOW_FALLBACK_TEXT, workflowId: null, workflowName: null, source: "none" as const },
            rawMessage,
            sessionId: String(sessionId),
            agentId,
            readOnly: true,
            includeRecentHistory: true,
            forceTools: true,
            intentKind: "read-only-tool",
            onEmit: (event, data) => {
              if (event === "webchat:tool") repoToolEventsVisible = true;
              forwardWebChatAssistantEvent(event, data, { bufferTokens: bufferedRepoTokens });
            },
            preflightEvidence: repoEvidence.promptBlock,
            preflightMetrics: repoEvidence.metrics,
          });
          let riResponse = sanitizeFinalAnswer(riResult.responseText ?? NO_WORKFLOW_FALLBACK_TEXT).answer || NO_WORKFLOW_FALLBACK_TEXT;
          const quality = evaluateAnswerQuality({
            answer: riResponse,
            userMessage: rawMessage,
            lane: "repo_inspection",
            mode: "thorough",
            evidence: repoEvidenceToLedger(repoEvidence),
          });
          let deepContract = evaluateDeepAnswerContract({
            answer: riResponse,
            userMessage: rawMessage,
            minWords: 220,
          });
          let outputQuality = evaluateOutputQuality({
            answer: riResponse,
            userMessage: rawMessage,
          });
          let contract = evaluateRepoEvidenceContract({
            answer: riResponse,
            userMessage: rawMessage,
            evidence: repoEvidence,
            visibleToolEvents: repoToolEventsVisible,
            mode: "thorough",
          });
          if (!contract.ok || !quality.ok || !deepContract.ok || !outputQuality.ok) {
            const extraEvidence = await collectRepoInspectionEvidence({
              message: rawMessage,
              sessionId: String(sessionId),
              agentId,
              mode: "thorough",
              readOnly: true,
              requiredReads: contract.requiredExtraReads,
              requiredSearches: contract.requiredExtraSearches,
              onEmit: (event, data) => {
                if (event === "webchat:tool") repoToolEventsVisible = true;
                forwardWebChatAssistantEvent(event, data, { bufferTokens: bufferedRepoTokens });
              },
            });
            repoEvidence = mergeRepoInspectionEvidence(repoEvidence, extraEvidence);
            const repairInstruction = [
              formatEvidenceContractRepairInstruction(contract),
              quality.ok ? "" : quality.repairInstruction,
              deepContract.ok ? "" : deepContract.repairInstruction,
              outputQuality.ok ? "" : outputQuality.repairInstruction,
              "",
              "Original draft answer:",
              riResponse.slice(0, 6000),
            ].filter(Boolean).join("\n");
            const repairTokens: string[] = [];
            const repairResult = await resolveChannelResponseWithFallback({
              routed: { response: NO_WORKFLOW_FALLBACK_TEXT, workflowId: null, workflowName: null, source: "none" as const },
              rawMessage,
              sessionId: String(sessionId),
              agentId,
              readOnly: true,
              includeRecentHistory: true,
              forceTools: true,
              intentKind: "read-only-tool",
              preflightEvidence: `${repoEvidence.promptBlock}\n\n${repairInstruction}`,
              preflightMetrics: repoEvidence.metrics,
              onEmit: (event, data) => {
                if (event === "webchat:tool") repoToolEventsVisible = true;
                forwardWebChatAssistantEvent(event, data, { bufferTokens: repairTokens });
              },
            });
            const repaired = repairResult.responseText?.trim();
            if (repaired && !isEmptyWorkspaceFallback(repaired)) {
              const sanitizedRepair = sanitizeFinalAnswer(repaired).answer || repaired;
              const repairContract = evaluateRepoEvidenceContract({
                answer: sanitizedRepair,
                userMessage: rawMessage,
                evidence: repoEvidence,
                visibleToolEvents: repoToolEventsVisible,
                mode: "thorough",
              });
              // Strict repair: accept only when the evidence contract passes.
              // Do not silently accept longer but still under-grounded answers.
              if (repairContract.ok) {
                riResponse = sanitizedRepair;
                contract = repairContract;
                deepContract = evaluateDeepAnswerContract({
                  answer: riResponse,
                  userMessage: rawMessage,
                  minWords: 220,
                });
                outputQuality = evaluateOutputQuality({
                  answer: riResponse,
                  userMessage: rawMessage,
                });
              } else if (repaired.length > riResponse.length && !contract.ok) {
                // Partial improvement but still failing — include explicit
                // partial-answer note so the user knows evidence is incomplete.
                riResponse = [
                  sanitizedRepair,
                  "",
                  "## Verification Limitations",
                  `The repo evidence contract still has unresolved issues: ${contract.issues.join(", ") || "none"}.`,
                  "Treat any remaining file behavior claims without read-file support as candidates, not verified facts.",
                ].join("\n");
              }
            }
          }
          if (!contract.ok || !quality.ok || !deepContract.ok || !outputQuality.ok) {
            // Escalate to deep audit when contracts fail with shallow/missing-topic issues
            const shallowIssues = [
              ...(!contract.ok ? contract.issues : []),
              ...(!quality.ok ? quality.issues ?? [] : []),
              ...(!deepContract.ok ? deepContract.issues : []),
              ...(!outputQuality.ok ? outputQuality.issues : []),
            ];
            const needsDeepAudit = shallowIssues.some((issue) =>
              /\b(?:too_shallow|missing_prompt_topic|missing_requested_sections|missing_exact_count)\b/i.test(issue),
            ) && repoEvidence.filesRead.length >= 2;

            if (needsDeepAudit && !deepAuditProfile.enabled) {
              const escalatedProfile = classifyDeepAudit(
                `${rawMessage}\n\nThis needs deeper analysis: ${shallowIssues.join(", ")}`,
                true,
                selectedContext.toolMode !== "restricted",
              );
              if (escalatedProfile.enabled && escalatedProfile.kind) {
                const outline = buildDeepAuditOutline(
                  escalatedProfile,
                  repoEvidence.filesRead,
                  repoEvidence.searchesRun,
                  [],
                  [],
                );
                const sessionModel = getModelConfig({ agentId, sessionId: String(sessionId) });
                const synthesis = await synthesizeDeepAuditAnswer({
                  userMessage: rawMessage,
                  profile: escalatedProfile,
                  outline,
                  evidencePromptBlock: repoEvidence.promptBlock,
                  provider: sessionModel.provider,
                  modelId: sessionModel.modelId,
                  apiKey: sessionModel.apiKey,
                  baseUrl: sessionModel.baseUrl,
                  maxTokens: escalatedProfile.synthesisBudget === "expanded" ? 7000 : 4500,
                  temperature: 0.2,
                });
                const escalatedAnswer = synthesis.answer.trim()
                  || buildFallbackDeepAuditAnswer(escalatedProfile, outline, repoEvidence.promptBlock, rawMessage);
                const escapedSanitized = sanitizeFinalAnswer(escalatedAnswer);
                riResponse = escapedSanitized.answer || NO_WORKFLOW_FALLBACK_TEXT;
                contract = evaluateRepoEvidenceContract({
                  answer: riResponse,
                  userMessage: rawMessage,
                  evidence: repoEvidence,
                  visibleToolEvents: repoToolEventsVisible,
                  mode: "thorough",
                });
                deepContract = evaluateDeepAnswerContract({
                  answer: riResponse,
                  userMessage: rawMessage,
                  minWords: 220,
                });
                outputQuality = evaluateOutputQuality({
                  answer: riResponse,
                  userMessage: rawMessage,
                });
              }
            }

            if (!contract.ok || !quality.ok || !deepContract.ok || !outputQuality.ok) {
              // ── Agentic fallback: let the model grep + read via callWithTools ──
              // Instead of asking the model to return a JSON array of file paths,
              // let it use search_files/read_file/list_files directly in a tool loop.
                  // Expand from discovered evidence rather than a fixed topic list.
              const { answerWithReadOnlyRepoTools } = await import("@/lib/channels/repo-inspection-controller");
              const sessionModel = getModelConfig({ agentId, sessionId: String(sessionId) });

              const repoAuditSystemPrompt = [
                "You are inspecting THIS repository read-only to answer the user's question.",
                "Use search_files to find relevant code (grep concept terms, not just words from the prompt —",
                "e.g. for 'API keys in logs' search: redact, sanitize, secret, mask, api_key, token), then",
                "read_file the matches. Answer with concrete file paths + functions + line refs, the mechanism,",
                "gaps where it could still fail, and regression tests. Do NOT edit files. Do NOT print secret values.",
                "",
                "FORMATTING: wrap every file path, function name, tool name, and any code/markup token",
                "(e.g. `read_file`, `search_files`, `<tool_call>`) in inline backticks or a fenced code block.",
                "Never write raw tool-call markup or raw XML tags in prose.",
                "",
                "Repo map (partial):",
                buildRepoMap(),
              ].join("\n");

              const agentAnswer = await answerWithReadOnlyRepoTools({
                message: rawMessage,
                sessionId: String(sessionId),
                agentId,
                provider: sessionModel.provider,
                modelId: sessionModel.modelId,
                apiKey: sessionModel.apiKey,
                baseUrl: sessionModel.baseUrl ?? undefined,
                mode: "thorough",
                systemPrompt: repoAuditSystemPrompt,
                onToolCall: (name, args) => {
                  repoToolEventsVisible = true;
                  broadcastEvent("webchat:tool", {
                    sessionId: String(sessionId),
                    phase: "start",
                    name,
                    args,
                  });
                },
                onToolResult: (name, ok, output) => {
                  broadcastEvent("webchat:tool", {
                    sessionId: String(sessionId),
                    phase: "done",
                    name,
                    resultPreview: output.slice(0, 200),
                  });
                },
              });

              // A grounded agent answer that cites real repo files is acceptable even if the
              // broad-synthesis evidence-rich contracts reject it — a
              // focused repo audit is shorter and code-cited by nature.
              let agentGrounded = false;
              if (agentAnswer && !isEmptyWorkspaceFallback(agentAnswer)) {
                const sanitizedAgent = sanitizeFinalAnswer(agentAnswer);
                riResponse = sanitizedAgent.answer || agentAnswer;
                const citedFiles = riResponse.match(/\b(?:src|server|scripts)\/[A-Za-z0-9._/-]+\.(?:ts|tsx|js|jsx)\b/g) ?? [];
                const wordCount = riResponse.split(/\s+/).filter(Boolean).length;
                agentGrounded = new Set(citedFiles).size >= 2 && wordCount >= 120;
                contract = evaluateRepoEvidenceContract({
                  answer: riResponse,
                  userMessage: rawMessage,
                  evidence: repoEvidence,
                  visibleToolEvents: repoToolEventsVisible,
                  mode: "thorough",
                });
                deepContract = evaluateDeepAnswerContract({
                  answer: riResponse,
                  userMessage: rawMessage,
                  minWords: 220,
                });
                outputQuality = evaluateOutputQuality({
                  answer: riResponse,
                  userMessage: rawMessage,
                });
              }

              // If the agentic loop produced a grounded, file-cited answer, accept it as-is.
              // Otherwise fall to the canned recovery.
              if (!agentGrounded && (!contract.ok || !quality.ok || !deepContract.ok || !outputQuality.ok)) {
                riResponse = buildRepoInspectionContractFallbackResponse(rawMessage, repoEvidence);
                contract = evaluateRepoEvidenceContract({
                  answer: riResponse,
                  userMessage: rawMessage,
                  evidence: repoEvidence,
                  visibleToolEvents: repoToolEventsVisible,
                  mode: "thorough",
                });
                deepContract = evaluateDeepAnswerContract({
                  answer: riResponse,
                  userMessage: rawMessage,
                  minWords: 220,
                });
                outputQuality = evaluateOutputQuality({
                  answer: riResponse,
                  userMessage: rawMessage,
                });
              }
            }
          }
          if (isEmptyWorkspaceFallback(riResponse) || (
            /\bimplementation\s+plan\b/i.test(rawMessage) &&
            !/\bfiles\b[\s\S]*\brisks\b[\s\S]*\btests\b/i.test(riResponse)
          )) {
            riResponse = buildRepoInspectionRecoveryResponse(rawMessage, repoMap);
          }
          const sanitizedRepoFinal = sanitizeFinalAnswer(riResponse);
          if (sanitizedRepoFinal.changed) riResponse = sanitizedRepoFinal.answer;
          let repoFinalLeaked = sanitizedRepoFinal.leaked;
          if (isEmptyWorkspaceFallback(riResponse) || riResponse.trim().length < 40) {
            riResponse = buildRepoInspectionRecoveryResponse(rawMessage, repoMap);
            repoFinalLeaked = false;
          }
          outputQuality = evaluateOutputQuality({
            answer: riResponse,
            userMessage: rawMessage,
          });
          const riLeaked = hasLeakedToolMarkup(riResponse) || await hasLeakedToolMarkupDeep(riResponse) || repoFinalLeaked;
          if (riLeaked) {
            return respondDeterministic(
              buildMarkupFallbackResponse(rawMessage),
              { routeSource: "tool-markup-guard", intent, selectedContext },
            );
          }
          const finalRepoResponse = presentChannelResponse("webchat", applyQualityGates(riResponse, rawMessage));
          appendTurnStream(clientTurnId, finalRepoResponse);
          broadcastEvent("webchat:stream", { sessionId, clientTurnId, token: finalRepoResponse });
          return respondDeterministic(
            finalRepoResponse,
            {
              routeSource: "repo-inspection",
              intent,
              selectedContext,
              fallbackAssistant: riResult.fallbackAssistant,
              fallbackDiagnostics: riResult.fallbackDiagnostics,
              repoEvidence: repoEvidence.metrics,
              evidenceContract: { ok: contract.ok, issues: contract.issues },
              deepAnswerContract: { ok: deepContract.ok, issues: deepContract.issues },
              outputQuality: {
                applicable: outputQuality.applicable,
                ok: outputQuality.ok,
                issues: outputQuality.issues,
              },
            },
          );
        }

        // ── Composition/transformation guard: skip broad synthesis for fast composition tasks ──
        // Exact app_read builtin commands (list schedules, list webhooks, list automations, etc.)
        // must not be treated as compositions — they need the deterministic router, not a model call.
        if (isFastCompositionTask(broadTask) && !isCrossSurfaceAppMutationRequest(rawMessage) && !isProtectedBuiltin && !isExactAppReadBuiltin(rawMessage)) {
          const daDummyRouted = {
            response: NO_WORKFLOW_FALLBACK_TEXT,
            workflowId: null as string | null,
            workflowName: null as string | null,
            source: "none" as "none",
          };
          const { extractExplicitFormatConstraint } = await import("@/lib/channels/universal-answer-shape");
          const compFormatConstraint = extractExplicitFormatConstraint(rawMessage);
          const compFormatRule = compFormatConstraint
            ? `HARD FORMAT CONTRACT: the user asked for ${compFormatConstraint}. Output exactly that and nothing else — no extra sentences, headers, sections, evidence blocks, or preambles.\n\n`
            : "";
          const compResult = await resolveChannelResponseWithFallback({
            routed: daDummyRouted,
            rawMessage: `${compFormatRule}${buildSkillPackPrompt(broadTask.kind)}\n\nUser request: ${rawMessage}`,
            sessionId: String(sessionId),
            agentId,
            includeRecentHistory: true,
            readOnly: true,
            intentKind: "direct-answer",
            forceTools: false,
            onEmit: (event, data) => {
              if (event === "stream:token") {
                const token = typeof (data as { token?: unknown })?.token === "string"
                  ? String((data as { token?: unknown }).token)
                  : "";
                appendTurnStream(clientTurnId, token);
                broadcastEvent("webchat:stream", { sessionId, clientTurnId, ...(data as object) });
              }
            },
          });
          let compResponse = normalizeExactLineResponse(
            sanitizeFinalAnswer(compResult.responseText ?? NO_WORKFLOW_FALLBACK_TEXT).answer || NO_WORKFLOW_FALLBACK_TEXT,
            rawMessage,
          );
          if (compFormatConstraint) {
            const { enforceExplicitFormat } = await import("@/lib/channels/universal-answer-shape");
            compResponse = enforceExplicitFormat(compResponse, compFormatConstraint).answer;
          }
          let compContract = evaluateBroadAnswerContract({
            answer: compResponse,
            userMessage: rawMessage,
            decision: broadTask,
          });
          if (!compContract.ok && !isEmptyWorkspaceFallback(compResponse)) {
            const repairResult = await resolveChannelResponseWithFallback({
              routed: daDummyRouted,
              rawMessage: `${compContract.repairInstruction}\n\nDraft answer:\n${compResponse.slice(0, 4000)}`,
              sessionId: String(sessionId),
              agentId,
              readOnly: true,
              intentKind: "direct-answer",
              forceTools: false,
            });
            const repaired = repairResult.responseText?.trim();
            const sanitizedRepaired = repaired
              ? normalizeExactLineResponse(sanitizeFinalAnswer(repaired).answer || repaired, rawMessage)
              : "";
            const repairedContract = evaluateBroadAnswerContract({ answer: sanitizedRepaired, userMessage: rawMessage, decision: broadTask });
            if (repaired && shouldAcceptRepairedAnswer({
              originalResult: compContract,
              repairedResult: repairedContract,
              repairedLength: sanitizedRepaired.length,
              originalLength: compResponse.length,
            })) {
              compResponse = sanitizedRepaired;
              compContract = repairedContract;
            }
          }
          if (compFormatConstraint) {
            const { enforceExplicitFormat } = await import("@/lib/channels/universal-answer-shape");
            compResponse = enforceExplicitFormat(compResponse, compFormatConstraint).answer;
            compContract = evaluateBroadAnswerContract({ answer: compResponse, userMessage: rawMessage, decision: broadTask });
          }
          if (isEmptyWorkspaceFallback(compResponse)) {
            compResponse = presentChannelResponse("webchat", applyQualityGates(compResponse, rawMessage));
          }
          const compLeaked = hasLeakedToolMarkup(compResponse) || await hasLeakedToolMarkupDeep(compResponse);
          if (compLeaked) {
            compResponse = buildMarkupFallbackResponse(rawMessage);
          }
          return respondDeterministic(
            presentChannelResponse("webchat", applyQualityGates(compResponse, rawMessage)),
            {
              routeSource: `broad-task:${broadTask.kind}`,
              intent,
              selectedContext,
              broadTaskDecision: broadTask,
              broadAnswerContract: { ok: compContract.ok, issues: compContract.issues },
            },
          );
        }

        const shouldUseEvidenceBackedBroadSynthesis =
          broadTask.kind === "web_research" ||
          broadTask.kind === "app_workflow_design";

        if ((deepInspection.intent === "broad_app_synthesis" || shouldUseBroadSynthesisContext(rawMessage) || shouldUseEvidenceBackedBroadSynthesis) && !isCrossSurfaceAppMutationRequest(rawMessage) && !isProtectedBuiltin && !shouldBypassBroadSynthesisForComposition(rawMessage, broadTask) && !isExactAppReadBuiltin(rawMessage)) {
          // ── Collect broad evidence for app workflow design and repo plan tasks ──
          let broadEvidence = null;
          if (broadTask.kind === "app_workflow_design" || broadTask.kind === "web_research") {
            broadEvidence = await collectBroadEvidence({
              decision: broadTask,
              sessionId: String(sessionId),
              agentId,
              message: rawMessage,
              onEmit: (event, data) => {
                forwardWebChatAssistantEvent(event, data);
              },
            });
          }

          const broadSkillPack = buildSkillPackPrompt(broadTask.kind);
          const broadPreflight = broadEvidence?.promptBlock ?? "";
          const broadContext = [
            broadSkillPack,
            broadPreflight,
            buildBroadSynthesisContext(rawMessage),
          ].filter(Boolean).join("\n\n");
          const broadResult = await resolveChannelResponseWithFallback({
            routed: { response: NO_WORKFLOW_FALLBACK_TEXT, workflowId: null, workflowName: null, source: "none" as const },
            rawMessage,
            sessionId: String(sessionId),
            agentId,
            readOnly: true,
            includeRecentHistory: true,
            forceTools: true,
            intentKind: broadTask.kind === "app_workflow_design" ? "app-mutation-proposal" : "read-only-tool",
            preflightEvidence: broadContext || undefined,
            preflightMetrics: broadEvidence?.metrics,
            onEmit: (event, data) => forwardWebChatAssistantEvent(event, data),
          });
          if (broadEvidence && broadResult.toolEvidenceLedger?.length) {
            broadEvidence = mergeBroadEvidenceWithModelToolLedger(broadEvidence, broadResult.toolEvidenceLedger);
          }
          let broadResponse = sanitizeFinalAnswer(broadResult.responseText ?? NO_WORKFLOW_FALLBACK_TEXT).answer || NO_WORKFLOW_FALLBACK_TEXT;
          let deepContract = evaluateDeepAnswerContract({
            answer: broadResponse,
            userMessage: rawMessage,
            minWords: 220,
          });
          let broadContract = evaluateBroadAnswerContract({
            answer: broadResponse,
            userMessage: rawMessage,
            decision: broadTask,
            evidence: broadEvidence ?? undefined,
          });
          let outputQuality = evaluateOutputQuality({
            answer: broadResponse,
            userMessage: rawMessage,
          });
          const needsRepair = !deepContract.ok || !broadContract.ok || !outputQuality.ok;
          if (needsRepair && !isEmptyWorkspaceFallback(broadResponse)) {
            const repairInstruction = [
              deepContract.ok ? "" : deepContract.repairInstruction,
              broadContract.ok ? "" : formatBroadContractRepairInstruction(broadContract),
              outputQuality.ok ? "" : outputQuality.repairInstruction,
            ].filter(Boolean).join("\n\n");
            const repair = await resolveChannelResponseWithFallback({
              routed: { response: NO_WORKFLOW_FALLBACK_TEXT, workflowId: null, workflowName: null, source: "none" as const },
              rawMessage: `${rawMessage}\n\n${repairInstruction}\n\nDraft answer:\n${broadResponse.slice(0, 6000)}`,
              sessionId: String(sessionId),
              agentId,
              readOnly: true,
              includeRecentHistory: true,
              forceTools: true,
              intentKind: broadTask.kind === "app_workflow_design" ? "app-mutation-proposal" : "read-only-tool",
              preflightEvidence: broadContext || undefined,
              preflightMetrics: broadEvidence?.metrics,
              onEmit: (event, data) => forwardWebChatAssistantEvent(event, data),
            });
            if (broadEvidence && repair.toolEvidenceLedger?.length) {
              broadEvidence = mergeBroadEvidenceWithModelToolLedger(broadEvidence, repair.toolEvidenceLedger);
            }
            const repaired = repair.responseText?.trim();
            if (repaired && !isEmptyWorkspaceFallback(repaired)) {
              const sanitizedRepaired = sanitizeFinalAnswer(repaired).answer || repaired;
              const repairedBroadContract = evaluateBroadAnswerContract({
                answer: sanitizedRepaired,
                userMessage: rawMessage,
                decision: broadTask,
                evidence: broadEvidence ?? undefined,
              });
              const repairedOutputQuality = evaluateOutputQuality({
                answer: sanitizedRepaired,
                userMessage: rawMessage,
              });
              // Strict repair: only accept when the relevant contract passes
              if (shouldAcceptRepairedAnswer({
                originalResult: broadContract,
                repairedResult: repairedBroadContract,
                repairedLength: sanitizedRepaired.length,
                originalLength: broadResponse.length,
              }) || (!outputQuality.ok && repairedBroadContract.ok && repairedOutputQuality.ok)) {
                broadResponse = sanitizedRepaired;
                broadContract = repairedBroadContract;
                outputQuality = repairedOutputQuality;
                deepContract = evaluateDeepAnswerContract({
                  answer: broadResponse,
                  userMessage: rawMessage,
                  minWords: 220,
                });
              }
            }
          }
          const sanitizedBroadFinal = sanitizeFinalAnswer(broadResponse);
          if (sanitizedBroadFinal.changed) broadResponse = sanitizedBroadFinal.answer;
          let broadRouteSource = "broad-synthesis";
          const broadLeaked = hasLeakedToolMarkup(broadResponse) || await hasLeakedToolMarkupDeep(broadResponse) || isRawCliHelpOrToolDump(broadResponse) || sanitizedBroadFinal.leaked;
          if (broadLeaked) {
            broadRouteSource = "tool-markup-guard";
            broadResponse = buildMarkupFallbackResponse(rawMessage);
          }
          if (
            broadTask.kind === "web_research" &&
            broadEvidence &&
            (
              !broadContract.ok ||
              broadContract.issues.includes("underused_verified_sources") ||
              /\bev_[a-f0-9]{8,}\b/i.test(broadResponse)
            )
          ) {
            broadResponse = sanitizeFinalAnswer(buildWebResearchRecoveryResponse(rawMessage, broadEvidence)).answer || buildWebResearchRecoveryResponse(rawMessage, broadEvidence);
            broadRouteSource = "broad-synthesis";
            deepContract = evaluateDeepAnswerContract({
              answer: broadResponse,
              userMessage: rawMessage,
              minWords: 120,
            });
            broadContract = evaluateBroadAnswerContract({
              answer: broadResponse,
              userMessage: rawMessage,
              decision: broadTask,
              evidence: broadEvidence,
            });
            outputQuality = evaluateOutputQuality({
              answer: broadResponse,
              userMessage: rawMessage,
            });
          }
          if (isEmptyWorkspaceFallback(broadResponse) || broadResponse.split(/\s+/).filter(Boolean).length < 120) {
            broadResponse = broadTask.kind === "web_research"
              ? buildWebResearchRecoveryResponse(rawMessage, broadEvidence)
              : buildBroadSynthesisRecoveryResponse(rawMessage);
            broadRouteSource = broadTask.kind === "web_research" ? "broad-synthesis" : broadRouteSource;
            broadResponse = sanitizeFinalAnswer(broadResponse).answer || broadResponse;
            deepContract = evaluateDeepAnswerContract({
              answer: broadResponse,
              userMessage: rawMessage,
              minWords: 220,
            });
            broadContract = evaluateBroadAnswerContract({
              answer: broadResponse,
              userMessage: rawMessage,
              decision: broadTask,
              evidence: broadEvidence ?? undefined,
            });
            outputQuality = evaluateOutputQuality({
              answer: broadResponse,
              userMessage: rawMessage,
            });
          }
          if (
            broadTask.kind === "web_research" &&
            broadEvidence &&
            broadEvidence.metrics.urlsFetched < 2 &&
            !broadContract.ok
          ) {
            broadResponse = sanitizeFinalAnswer(buildWebResearchRecoveryResponse(rawMessage, broadEvidence)).answer || buildWebResearchRecoveryResponse(rawMessage, broadEvidence);
            broadRouteSource = "broad-synthesis";
            deepContract = evaluateDeepAnswerContract({
              answer: broadResponse,
              userMessage: rawMessage,
              minWords: 120,
            });
            broadContract = evaluateBroadAnswerContract({
              answer: broadResponse,
              userMessage: rawMessage,
              decision: broadTask,
              evidence: broadEvidence,
            });
            outputQuality = evaluateOutputQuality({
              answer: broadResponse,
              userMessage: rawMessage,
            });
          }
          if (broadTask.kind === "app_workflow_design" && !broadContract.ok) {
            broadResponse = sanitizeFinalAnswer(buildWorkflowDesignContractFallbackResponse(rawMessage)).answer || buildWorkflowDesignContractFallbackResponse(rawMessage);
            deepContract = evaluateDeepAnswerContract({
              answer: broadResponse,
              userMessage: rawMessage,
              minWords: 220,
            });
            broadContract = evaluateBroadAnswerContract({
              answer: broadResponse,
              userMessage: rawMessage,
              decision: broadTask,
              evidence: broadEvidence ?? undefined,
            });
            outputQuality = evaluateOutputQuality({
              answer: broadResponse,
              userMessage: rawMessage,
            });
          }
          outputQuality = evaluateOutputQuality({
            answer: broadResponse,
            userMessage: rawMessage,
          });

          let evidenceRichDiagnostics: Record<string, unknown> | undefined;
          let evidenceRichStatus: "not_applicable" | "skipped_with_reason" | "attempted" | "accepted" | "rejected" | "errored" | "forced" = "not_applicable";
          const outputQualityFailed = !outputQuality.ok && outputQuality.applicable;
          const depthSensitiveRoute = broadTask.kind === "web_research" ||
            /\b(?:local_model_setup|current_source_synthesis|broad-synthesis)\b/i.test(broadRouteSource);

          if (
            broadEvidence &&
            depthSensitiveRoute &&
            (outputQualityFailed || (!broadContract.ok && outputQuality.applicable))
          ) {
            const sessionModel = getModelConfig({ agentId, sessionId: String(sessionId) });
            const depthTier = classifyDepthTier(rawMessage, broadTask.kind);
            const ledgerVerifiedSourceCount = (broadEvidence.ledger ?? []).filter(
              (e) => e.verified && (e.kind === "web_source" || e.kind === "browser_page"),
            ).length;
            const verifiedSourceCount = Math.max(
              ledgerVerifiedSourceCount,
              Number(broadEvidence.metrics?.urlsFetched ?? 0),
            );
            const currentWordCount = broadResponse.split(/\s+/).filter(Boolean).length;

            if (
              shouldSynthesizeEvidenceRich({
                route: "broad-synthesis",
                userMessage: rawMessage,
                depthTier,
                verifiedSourceCount,
                currentDraftWordCount: currentWordCount,
              }) ||
              outputQualityFailed
            ) {
              // Skip gate: don't expand drafts that are already decision-ready.
              const skipResult = shouldSkipSynthesis({
                currentDraft: broadResponse,
                userMessage: rawMessage,
                route: "broad-synthesis",
                depthTier,
                verifiedSourceCount,
                contractIssues: broadContract.issues,
              });
              if (skipResult.skip) {
                evidenceRichStatus = "skipped_with_reason";
                evidenceRichDiagnostics = {
                  skipReason: skipResult.reason,
                  originalWordCount: currentWordCount,
                  synthesisUsed: false,
                  accepted: false,
                  contractFailures: 0,
                  route: "broad-synthesis",
                };
                return respondDeterministic(
                  presentChannelResponse("webchat", applyQualityGates(broadResponse, rawMessage)),
                  {
                    routeSource: broadRouteSource,
                    intent,
                    selectedContext,
                    fallbackAssistant: broadResult.fallbackAssistant,
                    fallbackDiagnostics: broadResult.fallbackDiagnostics,
                    deepInspection,
                    broadTaskDecision: broadTask,
                    broadTaskLabel: taskKindToLabel(broadTask.kind),
                    deepAnswerContract: { ok: deepContract.ok, issues: deepContract.issues },
                    broadAnswerContract: { ok: broadContract.ok, issues: broadContract.issues },
                    outputQuality: {
                      applicable: outputQuality.applicable,
                      ok: outputQuality.ok,
                      issues: outputQuality.issues,
                      ...(outputQuality.depthScore ? { depthScore: outputQuality.depthScore } : {}),
                    },
                    evidenceRichSynthesis: { status: "skipped_with_reason", reason: skipResult.reason, skipped: true },
                    ...(broadEvidence ? { broadEvidenceMetrics: broadEvidence.metrics } : {}),
                    ...(broadEvidence?.diagnostics ? { broadEvidenceDiagnostics: broadEvidence.diagnostics } : {}),
                  },
                );
              }

              evidenceRichStatus = "forced";
              try {
                const requirements = buildSynthesisRequirements(rawMessage, "broad-synthesis");
                const evidenceItems = broadEvidence.items as unknown as import("@/lib/channels/evidence-ledger").EvidenceItem[] | undefined;
                const synthesisResult = await synthesizeEvidenceRichAnswer({
                  userMessage: rawMessage,
                  route: "broad-synthesis",
                  routeSource: "broad-synthesis",
                  evidencePack: broadContext || "",
                  ledger: broadEvidence.ledger ?? [],
                  evidenceItems,
                  currentDraft: broadResponse,
                  provider: sessionModel.provider,
                  modelId: sessionModel.modelId,
                  apiKey: sessionModel.apiKey,
                  baseUrl: sessionModel.baseUrl,
                  requirements,
                  depthTier: depthTier === "normal" ? "thorough" : (depthTier === "exhaustive" ? "exhaustive" : "thorough"),
                });
                evidenceRichStatus = "attempted";
                evidenceRichDiagnostics = {
                  ...synthesisResult.diagnostics,
                  accepted: false,
                  originalWordCount: currentWordCount,
                  synthWordCount: synthesisResult.answer.split(/\s+/).filter(Boolean).length,
                };
                if (synthesisResult.diagnostics.synthesisUsed && synthesisResult.answer !== broadResponse) {
                  const sanitizedSynth = sanitizeFinalAnswer(synthesisResult.answer);
                  const synthAnswer = polishWebResearchAnswer({
                    answer: sanitizedSynth.answer || broadResponse,
                    userMessage: rawMessage,
                    evidence: broadEvidence,
                  });
                  const synthContract = evaluateBroadAnswerContract({
                    answer: synthAnswer,
                    userMessage: rawMessage,
                    decision: broadTask,
                    evidence: broadEvidence,
                  });
                  const synthOutputQuality = evaluateOutputQuality({
                    answer: synthAnswer,
                    userMessage: rawMessage,
                  });
                  if (synthContract.ok && synthOutputQuality.ok) {
                    broadResponse = synthAnswer;
                    broadContract = synthContract;
                    outputQuality = synthOutputQuality;
                    broadRouteSource = "broad-synthesis:evidence-rich";
                    evidenceRichStatus = "accepted";
                  } else {
                    // Evidence-rich synthesis contracts are diagnostic. The
                    // model's last assistant turn is the answer. We keep
                    // contracts as diagnostics but only HARD SAFETY violations
                    // (tool-markup leaked, raw CLI dump, mutation claim in
                    // read-only) ever block shipping. Depth/grounding/source-
                    // citation issues are NOT blockers — that's the reference behavior
                    // ships deeper answers; we now match that behavior.
                    const HARD_SAFETY_BLOCKERS = new Set([
                      "tool_markup_leaked",
                      "mutation_in_readonly_answer",
                      "raw_cli_dump",
                    ]);

                    const synthHardBlockers = synthContract.issues.filter((i) =>
                      HARD_SAFETY_BLOCKERS.has(i),
                    );

                    const synthWords = synthAnswer.split(/\s+/).filter(Boolean).length;
                    const draftWords = broadResponse.split(/\s+/).filter(Boolean).length;
                    const isSubstantialImprovement = synthWords >= 250 || synthWords > draftWords * 1.3;

                    if (synthHardBlockers.length === 0 && isSubstantialImprovement) {
                      broadResponse = synthAnswer;
                      broadContract = synthContract;
                      outputQuality = synthOutputQuality;
                      broadRouteSource = "broad-synthesis:evidence-rich";
                      evidenceRichStatus = "accepted";
                    } else {
                      evidenceRichStatus = "rejected";
                    }
                  }
                  // Always capture synth-side diagnostics, accepted or not.
                  evidenceRichDiagnostics = {
                    ...synthesisResult.diagnostics,
                    accepted: evidenceRichStatus === "accepted",
                    originalWordCount: currentWordCount,
                    synthWordCount: synthAnswer.split(/\s+/).filter(Boolean).length,
                    synthBroadIssues: synthContract.issues,
                    synthOutputIssues: synthOutputQuality.issues,
                  };
                } else {
                  evidenceRichStatus = "rejected";
                }
              } catch (error) {
                evidenceRichStatus = "errored";
                evidenceRichDiagnostics = {
                  synthesisUsed: false,
                  accepted: false,
                  contractFailures: 1,
                  rejectedReason: String(error),
                  route: "broad-synthesis",
                  originalWordCount: currentWordCount,
                };
              }

              if (evidenceRichStatus === "rejected" || evidenceRichStatus === "errored") {
                try {
                  const requirements = buildSynthesisRequirements(rawMessage, "broad-synthesis");
                  const evidenceItems = (broadEvidence?.items ?? []) as unknown as import("@/lib/channels/evidence-ledger").EvidenceItem[];
                  const expanded = expandDepthDeterministically({
                    originalAnswer: broadResponse,
                    rawUserMessage: rawMessage,
                    routeKind: String(broadTask.kind),
                    verifiedEvidence: evidenceItems.filter((item) => item.confidence === "verified"),
                    issues: outputQuality.issues,
                    requirements: {
                      minSections: requirements.minSections,
                      minVerifiedSources: requirements.minVerifiedSources,
                      minConcreteDetails: requirements.minConcreteDetails,
                      requireCommands: requirements.requireCommands,
                      requireRisks: requirements.requireRisks,
                      requireTests: requirements.requireTests,
                      requireValidationChecklist: requirements.requireValidationChecklist,
                      requireSourceCategories: requirements.requireSourceCategories,
                    },
                  });
                  if (expanded.length > broadResponse.length + 200) {
                    const sanitizedExpanded = sanitizeFinalAnswer(expanded);
                    const expandedAnswer = sanitizedExpanded.answer || broadResponse;
                    broadResponse = expandedAnswer;
                    deepContract = evaluateDeepAnswerContract({
                      answer: broadResponse,
                      userMessage: rawMessage,
                      minWords: 220,
                    });
                    broadContract = evaluateBroadAnswerContract({
                      answer: broadResponse,
                      userMessage: rawMessage,
                      decision: broadTask,
                      evidence: broadEvidence ?? undefined,
                    });
                    outputQuality = evaluateOutputQuality({
                      answer: broadResponse,
                      userMessage: rawMessage,
                    });
                    const deterministicAccepted = broadContract.ok && outputQuality.ok;
                    broadRouteSource = "broad-synthesis:deterministic-depth-expander";
                    evidenceRichStatus = deterministicAccepted ? "accepted" : "rejected";
                    evidenceRichDiagnostics = {
                      ...(evidenceRichDiagnostics ?? {}),
                      deterministicFallbackUsed: true,
                      deterministicFallbackAccepted: deterministicAccepted,
                      deterministicFallbackWordCount: broadResponse.split(/\s+/).filter(Boolean).length,
                      deterministicBroadIssues: broadContract.issues,
                      deterministicOutputIssues: outputQuality.issues,
                    };
                  }
                } catch {
                  // Deterministic expansion failed gracefully
                }
              }
            }
          }

          broadResponse = polishWebResearchAnswer({
            answer: broadResponse,
            userMessage: rawMessage,
            evidence: broadEvidence ?? undefined,
          });
          broadContract = evaluateBroadAnswerContract({
            answer: broadResponse,
            userMessage: rawMessage,
            decision: broadTask,
            evidence: broadEvidence ?? undefined,
          });
          outputQuality = evaluateOutputQuality({
            answer: broadResponse,
            userMessage: rawMessage,
          });

          return respondDeterministic(
            presentChannelResponse("webchat", applyQualityGates(broadResponse, rawMessage)),
            {
              routeSource: broadRouteSource,
              intent,
              selectedContext,
              fallbackAssistant: broadResult.fallbackAssistant,
              fallbackDiagnostics: broadResult.fallbackDiagnostics,
              deepInspection,
              broadTaskDecision: broadTask,
              broadTaskLabel: taskKindToLabel(broadTask.kind),
              deepAnswerContract: { ok: deepContract.ok, issues: deepContract.issues },
              broadAnswerContract: { ok: broadContract.ok, issues: broadContract.issues },
              outputQuality: {
                applicable: outputQuality.applicable,
                ok: outputQuality.ok,
                issues: outputQuality.issues,
                ...(outputQuality.depthScore ? { depthScore: outputQuality.depthScore } : {}),
              },
              ...(depthSensitiveRoute ? { evidenceRichSynthesis: { ...(evidenceRichDiagnostics ?? {}), status: evidenceRichStatus } } : {}),
              ...(broadEvidence ? { broadEvidenceMetrics: broadEvidence.metrics } : {}),
              ...(broadEvidence?.diagnostics ? { broadEvidenceDiagnostics: broadEvidence.diagnostics } : {}),
            },
          );
        }

        const appStatusParaphrasePrompt =
          (
            /\b(?:chat|channel|channels|messaging|message|communication|inbox|inboxes|bridge|bridges)\b/i.test(rawMessage) &&
            /\b(?:connections?|connected|working|alive|active|online|offline|disconnected|health|routes?|send\s+messages|wired\s+up)\b/i.test(rawMessage)
          ) ||
          (
            /\b(?:anything|what|show|check|status|summary)\b/i.test(rawMessage) &&
            /\b(?:risky|risk|waiting\s+on\s+me|pending|approval|approvals?|broken|unhealthy|looks?\s+off)\b/i.test(rawMessage)
          );
        const forceGeneralToolLane =
          taskIntentContract.toolPolicy !== "forbidden" && (
            (!appStatusParaphrasePrompt && broadResearchPrompt) ||
            broadTask.kind === "web_research" ||
            broadTask.kind === "benchmark_comparison" ||
            broadTask.kind === "app_workflow_design" ||
            /\b(?:search|look\s+up|browse|research)\b[\s\S]{0,80}\b(?:web|online|latest|public discussion|source links?)\b/i.test(rawMessage)
          );

        if ((intent.kind === "direct-answer" || forceGeneralToolLane || sessionOnlyDirectAnswerPrompt) && !isProtectedBuiltin) {
          const daDummyRouted = {
            response: NO_WORKFLOW_FALLBACK_TEXT,
            workflowId: null as string | null,
            workflowName: null as string | null,
            source: "none" as "none",
          };
          const daResolved = await resolveChannelResponseWithFallback({
            routed: daDummyRouted,
            rawMessage,
            sessionId: String(sessionId),
            agentId,
            includeRecentHistory: true,
            readOnly: true,
            intentKind: intent.kind,
            onEmit: (event, data) => {
              if (event === "stream:token") {
                const token = typeof (data as { token?: unknown })?.token === "string"
                  ? String((data as { token?: unknown }).token)
                  : "";
                appendTurnStream(clientTurnId, token);
                broadcastEvent("webchat:stream", { sessionId, clientTurnId, ...(data as object) });
                return;
              }
              if (event === "stream:status") {
                const payload = data && typeof data === "object" ? data as Record<string, unknown> : {};
                broadcastEvent("webchat:status", {
                  clientTurnId,
                  sessionId,
                  phase: String(payload.phase || "model_call"),
                  label: String(payload.label || "Calling model…"),
                  detail: null,
                  createdAt: new Date().toISOString(),
                });
              }
            },
          });
          let daResponseRaw = daResolved.responseText ?? NO_WORKFLOW_FALLBACK_TEXT;
          // Guard against empty responses from reasoning models (e.g., after memory store)
          daResponseRaw = guardEmptyAnswer(daResponseRaw, {
            didMemoryStore: /\b(?:remember|save|store|note|keep)\b/i.test(rawMessage),
          });
          const daLeaked = hasLeakedToolMarkup(daResponseRaw) || await hasLeakedToolMarkupDeep(daResponseRaw);
          if (daLeaked) {
            log.warn("tool-markup-guard: detected leaked markup in direct-answer response", { sessionId, preview: daResponseRaw.slice(0, 200) });
            daResponseRaw = buildMarkupFallbackResponse(rawMessage);
          }
          const daResponseText = presentChannelResponse("webchat", applyQualityGates(daResponseRaw, rawMessage));
          const daMetadata: Record<string, unknown> = {
            routeSource: daResolved.routeSource,
            intent,
            selectedContext,
            broadTaskDecision: broadTask,
            broadTaskLabel: taskKindToLabel(broadTask.kind),
            taskIntentContract,
            turnPlan,
            turnPlanner: turnPlannerDiagnostics,
            routingDecision,
          };
          if (routingDecision.conflicts.length > 0) daMetadata.routingConflicts = routingDecision.conflicts;
          if (daResolved.fallbackAssistant) daMetadata.fallbackAssistant = daResolved.fallbackAssistant;
          if (daResolved.fallbackDiagnostics) daMetadata.fallbackDiagnostics = daResolved.fallbackDiagnostics;
          if (daResolved.sessionSnapshot) daMetadata.sessionSnapshot = daResolved.sessionSnapshot;
          const daLearning = await captureTurnLearning(rawMessage, daResponseText, daResolved.routeSource);
          if (daLearning) daMetadata.learningFeedback = daLearning;
          const daProvenance = createProvenance("channel", "channel:webchat", {
            channel: "webchat",
            sessionId,
            sender: "assistant",
            agentId,
            routeSource: daResolved.routeSource,
          });
          persistChannelMessage({
            sessionId,
            role: "assistant",
            content: daResponseText,
            metadata: daMetadata,
            provenance: daProvenance,
            agentId,
            createdAt: now,
          });
          flushTurnStream(clientTurnId);
          db.prepare(
            `UPDATE channel_session_turns
             SET status = 'completed', response = ?, metadata = ?, provenance = ?, worker_id = NULL, lease_expires_at = NULL, updated_at = ?, completed_at = ?
             WHERE client_turn_id = ?`,
          ).run(daResponseText, JSON.stringify(daMetadata), JSON.stringify(daProvenance), new Date().toISOString(), new Date().toISOString(), clientTurnId);
          broadcastEvent("webchat:message", {
            sessionId,
            clientTurnId,
            role: "assistant",
            content: daResponseText,
            metadata: daMetadata,
            provenance: daProvenance,
            createdAt: new Date().toISOString(),
          });
          return NextResponse.json({ success: true, data: { response: daResponseText, metadata: daMetadata, provenance: daProvenance, clientTurnId, routeSource: daResolved.routeSource } });
        }

        const routed = await routeToWorkflowWithDetails({
          triggerNodeType: "message-trigger",
          channel: "webchat",
          agentId,
          internalBaseUrl: new URL(request.url).origin,
          clientTurnId,
          provenance: trace,
          triggerData: {
            message: routedMessage,
            sender: "user",
            channel: "webchat",
            sessionId,
            clientTurnId,
            toolMode: selectedContext.toolMode,
            workspacePath: selectedContext.workspacePath,
            taskIntentContract,
            timestamp: now,
            ...(intent.kind === "app-read" || intent.kind === "app-navigation" ? { forceReadOnly: true } : {}),
          },
          onStatus: (phase, label, detail) => {
            broadcastEvent("webchat:status", {
              clientTurnId,
              sessionId,
              phase,
              label,
              detail: detail ?? null,
              createdAt: new Date().toISOString(),
            });
          },
          onEmit: (event, data) => {
            if (event === "stream:token") {
              const token = typeof (data as { token?: unknown })?.token === "string"
                ? String((data as { token?: unknown }).token)
                : "";
              appendTurnStream(clientTurnId, token);
              broadcastEvent("webchat:stream", { sessionId, clientTurnId, ...(data as object) });
              return;
            }
            if (event === "stream:status") {
              // Engine-level status update (e.g. "Calling DeepSeek…") — surface
              // to the chat UI as a webchat:status event so the user sees what
              // phase the turn is in during silent stretches.
              const payload = data && typeof data === "object" ? data as Record<string, unknown> : {};
              broadcastEvent("webchat:status", {
                clientTurnId,
                sessionId,
                phase: String(payload.phase || "model_call"),
                label: String(payload.label || "Calling model…"),
                detail: null,
                createdAt: new Date().toISOString(),
              });
              return;
            }
            if (event === "workflow:node:start" || event === "workflow:node:complete") {
              const progressData = {
                sessionId,
                clientTurnId,
                event,
                ...(data && typeof data === "object" ? data as object : {}),
              };
              broadcastEvent("webchat:progress", progressData);
              persistProgressEvent(clientTurnId, event, progressData);
            }
          },
        });

        const metadata: Record<string, unknown> = {};
        if (routed.workflowId) metadata.workflowId = routed.workflowId;
        if (routed.workflowName) metadata.workflowName = routed.workflowName;
        metadata.routeSource = routed.source;
        metadata.selectedContext = selectedContext;
        metadata.broadTaskDecision = broadTask;
        metadata.broadTaskLabel = taskKindToLabel(broadTask.kind);
        metadata.taskIntentContract = taskIntentContract;
        metadata.turnPlan = turnPlan;
        metadata.turnPlanner = turnPlannerDiagnostics;
        metadata.routingDecision = routingDecision;
        if (routingDecision.conflicts.length > 0) metadata.routingConflicts = routingDecision.conflicts;
        if (routed.routingTrace) metadata.routingTrace = routed.routingTrace;
        const executionSummary = buildExecutionSummary(routed.workflowId, sessionId);
        if (executionSummary) metadata.executionSummary = executionSummary;
        let responseText = routed.response;

        const explicitWorkflowNoMatchText = resolveExplicitWorkflowNoMatchText({
          rawMessage,
          routed,
        });
        const resolved = explicitWorkflowNoMatchText
          ? {
            responseText: explicitWorkflowNoMatchText,
            routeSource: routed.source,
          }
          : await resolveChannelResponseWithFallback({
            routed,
            rawMessage,
            sessionId,
            agentId,
            includeRecentHistory: true,
            readOnly: intent.readOnly,
            intentKind: intent.kind,
            // Stream tokens + status events from the fallback path to the
            // WebChat UI exactly like the workflow path does.
            onEmit: (event, data) => {
              if (event === "stream:token") {
                const token = typeof (data as { token?: unknown })?.token === "string"
                  ? String((data as { token?: unknown }).token)
                  : "";
                appendTurnStream(clientTurnId, token);
                broadcastEvent("webchat:stream", { sessionId, clientTurnId, ...(data as object) });
                return;
              }
              if (event === "stream:status") {
                const payload = data && typeof data === "object" ? data as Record<string, unknown> : {};
                broadcastEvent("webchat:status", {
                  clientTurnId,
                  sessionId,
                  phase: String(payload.phase || "model_call"),
                  label: String(payload.label || "Calling model…"),
                  detail: null,
                  createdAt: new Date().toISOString(),
                });
              }
            },
          });
        responseText = resolved.responseText;
        // ── Tool-call markup leak guard ──
        const wfLeaked = responseText && (hasLeakedToolMarkup(responseText) || await hasLeakedToolMarkupDeep(responseText));
        if (wfLeaked) {
          const preview = responseText ? responseText.slice(0, 200) : "<null>";
          log.warn("tool-markup-guard: detected leaked markup in response", { sessionId, preview });
          responseText = buildMarkupFallbackResponse(rawMessage);
          metadata.routeSource = "tool-markup-guard";
        } else {
          metadata.routeSource = resolved.routeSource;
        }
        if (resolved.fallbackAssistant) metadata.fallbackAssistant = resolved.fallbackAssistant;
        if (resolved.fallbackDiagnostics) metadata.fallbackDiagnostics = resolved.fallbackDiagnostics;
        if (resolved.sessionSnapshot) metadata.sessionSnapshot = resolved.sessionSnapshot;
        if (routed.pendingAppActionPlan) {
          metadata.pendingAppActionPlan = routed.pendingAppActionPlan;
          if (routed.pendingWorkTrailId) metadata.workTrailId = routed.pendingWorkTrailId;
        } else {
          const pendingMutation = getChannelSessionAppState(String(sessionId))?.payload?.pendingMutation;
          if (
            pendingMutation?.kind === "app-action-plan" &&
            pendingMutation.payload &&
            typeof pendingMutation.payload === "object" &&
            resolved.routeSource === "app-action-planner"
          ) {
            metadata.pendingAppActionPlan = (pendingMutation.payload as { plan?: unknown }).plan ?? null;
          }
        }

        const response = presentChannelResponse(
          "webchat",
          applyQualityGates(responseText ?? NO_WORKFLOW_FALLBACK_TEXT, rawMessage),
        );

        persistChannelMessage({
          sessionId,
          role: "assistant",
          content: response,
          metadata,
          provenance: {
            ...trace,
            workflowId: routed.workflowId ?? undefined,
            workflowName: routed.workflowName ?? undefined,
            routeSource: resolved.routeSource,
          },
          agentId,
          createdAt: now,
        });

        // Budget tracking — record spend and auto-pause if exceeded
        try {
          const { recordAgentSpendEvent } = await import("@/lib/agents/budgets");
          const costUsd = Number(metadata.costUsd || 0);
          if (costUsd > 0 && agentId) {
            const fb = metadata.fallbackAssistant as { provider?: string; modelId?: string } | undefined;
            void recordAgentSpendEvent({
              agentId,
              provider: fb?.provider || "unknown",
              modelId: fb?.modelId || "unknown",
              source: "webchat",
              referenceId: sessionId,
              costUsd,
              createdAt: new Date().toISOString(),
            });
          }
        } catch { /* best-effort budget tracking */ }

        // Trigger debounced session delta indexing (5s debounce).
        scheduleSessionIndex(sessionId, agentId);

        try {
          const {
            captureLearningFromChannelInteraction,
            drainLearningNotifications,
            formatLearningFeedbackText,
          } = await import("@/lib/learning/loop");
          await captureLearningFromChannelInteraction({
            sessionId,
            message: rawMessage,
            response,
            routeSource: String(metadata.routeSource || ""),
            agentId,
          });
          const learningFeedback = drainLearningNotifications(sessionId);
          if (learningFeedback.length > 0) {
            const learningFeedbackText = formatLearningFeedbackText(learningFeedback);
            metadata.learningFeedback = {
              items: learningFeedback,
              text: learningFeedbackText,
            };
            broadcastEvent("webchat:learning-feedback", {
              sessionId,
              items: learningFeedback,
              text: learningFeedbackText,
            });
          }
        } catch (learningError) {
          log.warn("Learning capture failed", { error: String(learningError) });
        }

        const { isTurnAborted: checkAborted } = await import("@/lib/channels/turn-abort-registry");
        if (clientTurnId && checkAborted(clientTurnId)) {
          broadcastEvent("webchat:status", {
            clientTurnId,
            sessionId,
            phase: "cancelled",
            label: "Request was cancelled",
            createdAt: new Date().toISOString(),
          });
          flushTurnStream(clientTurnId);
          db.prepare(
            `UPDATE channel_session_turns
             SET status = 'cancelled', worker_id = NULL, lease_expires_at = NULL, updated_at = ?, completed_at = ?
             WHERE client_turn_id = ?`,
          ).run(new Date().toISOString(), new Date().toISOString(), clientTurnId);
          return NextResponse.json({ success: true, data: { cancelled: true } });
        }

        flushTurnStream(clientTurnId);
        const guardedResponse = guardEmptyAnswer(response);
        db.prepare(
          `UPDATE channel_session_turns
           SET status = 'completed', response = ?, metadata = ?, provenance = ?, worker_id = NULL, lease_expires_at = NULL, updated_at = ?, completed_at = ?
           WHERE client_turn_id = ?`,
        ).run(guardedResponse, JSON.stringify(metadata), JSON.stringify(trace), new Date().toISOString(), new Date().toISOString(), clientTurnId);
        broadcastEvent("webchat:message", {
          sessionId,
          clientTurnId,
          role: "assistant",
          content: guardedResponse,
          metadata,
          provenance: trace,
          createdAt: new Date().toISOString(),
        });

        return NextResponse.json({ success: true, data: { response, metadata, provenance: trace, clientTurnId } });
      } catch (chatError) {
        flushTurnStream(clientTurnId);
        db.prepare(
          `UPDATE channel_session_turns
           SET status = 'failed', error = ?, worker_id = NULL, lease_expires_at = NULL, updated_at = ?, completed_at = ?
           WHERE client_turn_id = ?`,
        ).run(String(chatError), new Date().toISOString(), new Date().toISOString(), clientTurnId);
        throw chatError;
      } finally {
        sessionProcessing.delete(sessionId);
      }
    }

    if (body.action === "session-settings") {
      const sessionId = String(body.sessionId || "").trim();
      if (!sessionId) {
        return NextResponse.json(
          { success: false, error: "sessionId is required" },
          { status: 400 },
        );
      }
      const fastMode =
        body.fastMode === null || body.fastMode === undefined
          ? null
          : body.fastMode === true;
      const settings = upsertChannelSessionSettings({
        sessionId,
        fastMode,
        agentId: body.agentId === undefined ? undefined : String(body.agentId || "").trim() || null,
        modelRef: body.modelRef === undefined ? undefined : String(body.modelRef || "").trim() || null,
        workspacePath: body.workspacePath === undefined ? undefined : String(body.workspacePath || "").trim() || null,
        toolMode:
          body.toolMode === "restricted" || body.toolMode === "full"
            ? body.toolMode
            : body.toolMode === undefined || body.toolMode === null
              ? undefined
              : "default",
      });
      return NextResponse.json({ success: true, data: settings });
    }

    if (body.action === "update-pending-app-action-plan") {
      const sessionId = String(body.sessionId || "").trim();
      if (!sessionId) {
        return NextResponse.json(
          { success: false, error: "sessionId is required" },
          { status: 400 },
        );
      }
      const result = updatePendingAppActionPlan(sessionId, body.plan);
      if (!result.success) {
        return NextResponse.json({ success: false, error: result.error }, { status: 400 });
      }
      return NextResponse.json({
        success: true,
        data: {
          summary: result.summary,
          plan: result.plan,
        },
      });
    }

    if (body.action === "delete-session") {
      const sessionId = String(body.sessionId || "").trim();
      if (!sessionId) {
        return NextResponse.json(
          { success: false, error: "sessionId is required" },
          { status: 400 },
        );
      }
      db.prepare("DELETE FROM messages WHERE session_id = ?").run(sessionId);
      db.prepare("DELETE FROM channel_session_settings WHERE session_id = ?").run(sessionId);
      db.prepare("DELETE FROM channel_session_app_state WHERE session_id = ?").run(sessionId);
      db.prepare("DELETE FROM channel_session_turns WHERE session_id = ?").run(sessionId);
      db.prepare("DELETE FROM session_todos WHERE session_id = ?").run(sessionId);
      return NextResponse.json({ success: true, data: { sessionId } });
    }

    if (body.action === "session-todos") {
      const sessionId = String(body.sessionId || "").trim();
      const todoAction = String(body.todoAction || "list").trim().toLowerCase();
      if (!sessionId) {
        return NextResponse.json(
          { success: false, error: "sessionId is required" },
          { status: 400 },
        );
      }
      if (todoAction === "list") {
        return NextResponse.json({ success: true, data: listSessionTodos(sessionId) });
      }
      if (todoAction === "add") {
        const content = String(body.content || "").trim();
        if (!content) {
          return NextResponse.json({ success: false, error: "content is required" }, { status: 400 });
        }
        const item = createSessionTodo(sessionId, content);
        return NextResponse.json({ success: true, data: { item, items: listSessionTodos(sessionId) } });
      }
      if (todoAction === "update") {
        // Explicit empty-string content → reject; undefined → no change; non-empty → update
        if (body.content !== undefined && String(body.content || "").trim() === "") {
          return NextResponse.json({ success: false, error: "content cannot be empty" }, { status: 400 });
        }
        const contentArg = body.content === undefined ? undefined : String(body.content).trim();
        const updated = updateSessionTodo({
          sessionId,
          todoId: String(body.todoId || ""),
          content: contentArg,
          isDone: body.isDone === undefined ? undefined : body.isDone === true,
          sortOrder: Number.isFinite(Number(body.sortOrder)) ? Number(body.sortOrder) : undefined,
        });
        if (!updated) {
          return NextResponse.json({ success: false, error: "Todo item not found" }, { status: 404 });
        }
        return NextResponse.json({ success: true, data: { item: updated, items: listSessionTodos(sessionId) } });
      }
      if (todoAction === "remove") {
        const removed = deleteSessionTodo(sessionId, String(body.todoId || ""));
        return NextResponse.json({ success: true, data: { removed, items: listSessionTodos(sessionId) } });
      }
      if (todoAction === "clear-completed") {
        const removed = clearCompletedSessionTodos(sessionId);
        return NextResponse.json({ success: true, data: { removed, items: listSessionTodos(sessionId) } });
      }
      return NextResponse.json({ success: false, error: "Unknown todoAction" }, { status: 400 });
    }

    if (body.action === "set-channel-access-mode") {
      const modeRaw = String(body.mode || "").trim().toLowerCase();
      if (modeRaw !== "open" && modeRaw !== "allowlist" && modeRaw !== "pairing") {
        return NextResponse.json(
          { success: false, error: "mode must be open, allowlist, or pairing" },
          { status: 400 },
        );
      }
      const mode = setChannelAccessMode(modeRaw);
      return NextResponse.json({ success: true, data: getChannelAccessOverview(), mode });
    }

    if (body.action === "approve-channel-sender") {
      const channel = String(body.channel || "").trim();
      const subjectKey = String(body.subjectKey || "").trim();
      const subjectLabel = String(body.subjectLabel || "").trim() || null;
      if (!channel || !subjectKey) {
        return NextResponse.json(
          { success: false, error: "channel and subjectKey are required" },
          { status: 400 },
        );
      }
      const approved = approveChannelSender({ channel, subjectKey, subjectLabel });
      return NextResponse.json({ success: true, data: { approved, overview: getChannelAccessOverview() } });
    }

    if (body.action === "revoke-channel-sender") {
      const channel = String(body.channel || "").trim();
      const subjectKey = String(body.subjectKey || "").trim();
      if (!channel || !subjectKey) {
        return NextResponse.json(
          { success: false, error: "channel and subjectKey are required" },
          { status: 400 },
        );
      }
      const removed = revokeChannelSender({ channel, subjectKey });
      return NextResponse.json({ success: true, data: { removed, overview: getChannelAccessOverview() } });
    }

    if (body.action === "approve-channel-pairing") {
      const code = String(body.code || "").trim();
      if (!code) {
        return NextResponse.json({ success: false, error: "code is required" }, { status: 400 });
      }
      const approved = approveChannelPairing(code);
      if (!approved) {
        return NextResponse.json({ success: false, error: "Pairing code not found or expired" }, { status: 404 });
      }
      return NextResponse.json({ success: true, data: { approved, overview: getChannelAccessOverview() } });
    }

    if (body.action === "deny-channel-pairing") {
      const code = String(body.code || "").trim();
      if (!code) {
        return NextResponse.json({ success: false, error: "code is required" }, { status: 400 });
      }
      const deniedPairing = denyChannelPairing(code);
      return NextResponse.json({ success: true, data: { denied: deniedPairing, overview: getChannelAccessOverview() } });
    }

    if (body.action === "connect-telegram") {
      const { token } = body;
      if (!token) return NextResponse.json({ success: false, error: "Token required" }, { status: 400 });
      upsertSecret({ name: "TELEGRAM_BOT_TOKEN", value: String(token), source: "settings:channels" });
      process.env.TELEGRAM_BOT_TOKEN = String(token);
      bindTelegramHandler();
      const result = await startTelegram(token);
      return NextResponse.json({ success: true, data: result });
    }

    if (body.action === "disconnect-telegram") {
      await stopTelegram();
      deleteSecret("TELEGRAM_BOT_TOKEN");
      delete process.env.TELEGRAM_BOT_TOKEN;
      return NextResponse.json({ success: true, data: { disconnected: true } });
    }

    if (body.action === "connect-discord") {
      const { token } = body;
      if (!token) return NextResponse.json({ success: false, error: "Token required" }, { status: 400 });
      bindDiscordHandler();
      const result = await startDiscord(token);
      return NextResponse.json({ success: true, data: result });
    }

    if (body.action === "disconnect-discord") {
      await stopDiscord();
      return NextResponse.json({ success: true, data: { disconnected: true } });
    }

    if (body.action === "connect-whatsapp") {
      await connectWhatsApp();
      bindWhatsAppHandler();

      return NextResponse.json({ success: true, data: getWhatsAppStatus() });
    }

    if (body.action === "disconnect-whatsapp") {
      await disconnectWhatsApp();
      return NextResponse.json({ success: true, data: getWhatsAppStatus() });
    }

    if (body.action === "relink-whatsapp") {
      await disconnectWhatsApp();
      resetWhatsAppAuth();
      await connectWhatsApp();
      bindWhatsAppHandler();
      return NextResponse.json({ success: true, data: getWhatsAppStatus() });
    }

    if (body.action === "connect-slack") {
      const { botToken, appToken } = body;
      if (!botToken || !appToken) return NextResponse.json({ success: false, error: "botToken and appToken required" }, { status: 400 });
      bindSlackHandler();
      const result = await startSlack(botToken, appToken);
      return NextResponse.json({ success: true, data: result });
    }

    if (body.action === "disconnect-slack") {
      await stopSlack();
      return NextResponse.json({ success: true, data: { disconnected: true } });
    }

    if (body.action === "connect-bluebubbles") {
      const { serverUrl, password } = body;
      if (!serverUrl || !password) return NextResponse.json({ success: false, error: "serverUrl and password required" }, { status: 400 });
      bindBlueBubblesHandler();
      const result = await startBlueBubbles(serverUrl, password);
      return NextResponse.json({ success: true, data: result });
    }

    if (body.action === "disconnect-bluebubbles") {
      await stopBlueBubbles();
      return NextResponse.json({ success: true, data: { disconnected: true } });
    }

    if (body.action === "configure-teams") {
      const { appId, appPassword } = body;
      if (!appId || !appPassword) return NextResponse.json({ success: false, error: "appId and appPassword required" }, { status: 400 });
      configureTeams(appId, appPassword);
      bindTeamsHandler();
      return NextResponse.json({ success: true, data: getTeamsStatus() });
    }

    if (body.action === "send") {
      const channel = String(body.channel || "").trim().toLowerCase();
      const text = String(body.text || "").trim();
      const recipient = String(body.recipient || "").trim();
      const blocks = body.blocks;
      if (!channel || !text) {
        return NextResponse.json(
          { success: false, error: "channel and text are required" },
          { status: 400 },
        );
      }

      if (channel === "webchat") {
        broadcastEvent("webchat:message", {
          content: presentChannelResponse("webchat", text),
          executionId: `tool-send-${Date.now()}`,
        });
        return NextResponse.json({ success: true, data: { sent: true, channel } });
      }

      if (!recipient) {
        return NextResponse.json(
          { success: false, error: "recipient is required for this channel" },
          { status: 400 },
        );
      }

      if (channel === "telegram") {
        await sendTelegramMessage(recipient, text);
        return NextResponse.json({ success: true, data: { sent: true, channel } });
      }
      if (channel === "discord") {
        await sendDiscordMessage(recipient, text);
        return NextResponse.json({ success: true, data: { sent: true, channel } });
      }
      if (channel === "whatsapp") {
        await sendWhatsAppMessage(recipient, text);
        return NextResponse.json({ success: true, data: { sent: true, channel } });
      }
      if (channel === "slack") {
        await sendSlackMessage(recipient, text, { blocks });
        return NextResponse.json({ success: true, data: { sent: true, channel } });
      }
      if (channel === "bluebubbles") {
        await sendBlueBubblesMessage(recipient, text);
        return NextResponse.json({ success: true, data: { sent: true, channel } });
      }
      if (channel === "teams") {
        const serviceUrl = String(body.serviceUrl || "").trim();
        if (!serviceUrl) return NextResponse.json({ success: false, error: "serviceUrl required for Teams" }, { status: 400 });
        await sendTeamsMessage(serviceUrl, recipient, text);
        return NextResponse.json({ success: true, data: { sent: true, channel } });
      }

      return NextResponse.json({ success: false, error: `Unsupported channel: ${channel}` }, { status: 400 });
    }

    if (body.action === "compress-session") {
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : null;
      if (!sessionId) {
        return NextResponse.json({ success: false, error: "sessionId required" }, { status: 400 });
      }
      try {
        const { compactSessionContext } = await import("@/lib/agents/context/compaction");
        const result = await compactSessionContext(sessionId);
        return NextResponse.json({ success: true, data: result });
      } catch (err) {
        return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
      }
    }

    if (body.action === "cancel-turn") {
      if (!body.clientTurnId || typeof body.clientTurnId !== "string") {
        return NextResponse.json({ success: false, error: "clientTurnId is required" }, { status: 400 });
      }
      try {
        const turn = db.prepare(
          "SELECT client_turn_id, status FROM channel_session_turns WHERE client_turn_id = ? AND session_id = ?"
        ).get(body.clientTurnId, body.sessionId) as { client_turn_id: string; status: string } | undefined;
        if (!turn) {
          return NextResponse.json({ success: false, error: "Turn not found" }, { status: 404 });
        }
        if (turn.status === "completed" || turn.status === "failed" || turn.status === "cancelled") {
          return NextResponse.json({ success: false, error: "Turn already completed" }, { status: 400 });
        }
        abortTurn(turn.client_turn_id);
        flushTurnStream(turn.client_turn_id);
        db.prepare("UPDATE channel_session_turns SET status = 'cancelled', updated_at = ? WHERE client_turn_id = ? AND session_id = ?")
          .run(new Date().toISOString(), body.clientTurnId, body.sessionId);
        broadcastEvent("webchat:status", {
          clientTurnId: body.clientTurnId,
          sessionId: body.sessionId,
          phase: "cancelled",
          label: "Request cancelled",
          createdAt: new Date().toISOString(),
        });
        return NextResponse.json({ success: true, data: { cancelled: true } });
      } catch (err) {
        return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
      }
    }

    return NextResponse.json({ success: false, error: "Unknown action" }, { status: 400 });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 413 });
    }
    log.error("POST /api/channels failed", { error: String(error) });
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
