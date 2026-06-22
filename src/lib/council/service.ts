import { listAgents, type AgentRecord } from "@/lib/agents/registry";
import { getAgentBudgetDecision, recordAgentSpendEvent } from "@/lib/agents/budgets";
import { listAgentRoles } from "@/lib/agents/roles";
import { getModelConfig } from "@/lib/agents/model-router";
import { callModel } from "@/lib/agents/multi-provider";
import { estimateCost } from "@/lib/agents/cost-estimator";
import { getDocumentById } from "@/lib/documents/store";
import { providerRequiresApiKey } from "@/lib/agents/provider-plugins";

export type CouncilDecisionMode = "majority" | "consensus" | "weighted" | "ranked";
export type CouncilMode = "poll" | "debate";

export type CouncilRequestInput = {
  topic: string;
  agentIds: string[];
  documentIds?: string[];
  options?: string[];
  decisionMode?: CouncilDecisionMode;
  // C1: multi-round debate
  mode?: CouncilMode;
  rounds?: number;
  // C2: moderator synthesis
  synthesizerAgentId?: string;
  // C3: option discovery
  discoverOptions?: boolean;
  // C10: cost cap
  costCapUsd?: number;
  // C4: streaming progress callback
  onOpinionComplete?: (opinion: CouncilOpinion) => void;
};

export type CouncilOpinion = {
  agentId: string;
  agentName: string;
  roleTitle: string;
  vote: string;
  rankedAlternatives?: string[];
  voteWeight?: number;
  decisionProcess: string[];
  stance: string;
  confidence: number;
  concerns: string;
  model: string;
  provider: string;
  tokensUsed: number;
  costUsd: number;
  simulated: boolean;
  error: string | null;
  round?: number;
  // ── Multi-round debate fields ──
  respondsTo?: string;
  changedMind?: "yes" | "no" | "partially" | null;
  remainingDisagreement?: string;
};

export type BlockedCouncilAgent = {
  agentId: string;
  agentName: string;
  reason: string;
};

export type CouncilDocumentContext = {
  id: string;
  name: string;
  sourceType: string;
  sourceUrl: string | null;
  excerpt: string;
};

// C5: dissent capture
export type CouncilDissent = {
  vote: string;
  agentNames: string[];
  summary: string;
};

export type CouncilRunResult = {
  topic: string;
  decisionMode: CouncilDecisionMode;
  options: string[];
  participants: number;
  blockedAgents: BlockedCouncilAgent[];
  tally: Array<{ option: string; votes: number }>;
  winner: string | null;
  reachedConsensus: boolean;
  conclusion: string;
  synthesis: string | null;
  dissent: CouncilDissent[];
  totalTokens: number;
  totalCostUsd: number;
  simulatedCount: number;
  documentsUsed: CouncilDocumentContext[];
  createdAt: string;
  opinions: CouncilOpinion[];
  rounds?: number;
  debateTranscript?: Array<{ round: number; agentId: string; agentName: string; response: string }>;
};

function clampConfidence(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 50;
  return Math.max(0, Math.min(100, Math.round(parsed)));
}

function pickVote(text: string, options: string[]): string {
  const lower = text.toLowerCase();
  const exact = options.find((option) => lower.includes(option.toLowerCase()));
  if (exact) return exact;
  return options[0];
}

function normalizeRankedAlternatives(value: unknown, options: string[], preferredVote: string): string[] {
  const exactOptions = new Map(options.map((option) => [option.toLowerCase(), option]));
  const rawValues = Array.isArray(value)
    ? value.map((entry) => String(entry || "").trim()).filter(Boolean)
    : String(value || "")
        .split(/\r?\n|,/)
        .map((entry) => entry.trim())
        .filter(Boolean);
  const ordered: string[] = [];
  const seen = new Set<string>();
  const preferred = exactOptions.get(preferredVote.toLowerCase()) ?? preferredVote;
  if (preferred && !seen.has(preferred.toLowerCase())) {
    seen.add(preferred.toLowerCase());
    ordered.push(preferred);
  }
  for (const entry of rawValues) {
    const matched = exactOptions.get(entry.toLowerCase());
    if (!matched || seen.has(matched.toLowerCase())) continue;
    seen.add(matched.toLowerCase());
    ordered.push(matched);
  }
  for (const option of options) {
    if (seen.has(option.toLowerCase())) continue;
    seen.add(option.toLowerCase());
    ordered.push(option);
  }
  return ordered.slice(0, options.length);
}

function tryParseJson(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;
    try {
      return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}

function looksLikeJsonPayload(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("{") || trimmed.startsWith("```")) return true;
  if (trimmed.includes("\"vote\"") || trimmed.includes("\"decision_process\"")) return true;
  return false;
}

function normalizeDecisionProcess(params: {
  value: unknown;
  stance: string;
  roleTitle: string;
  vote: string;
}): string[] {
  const defaultProcess = [
    `${params.roleTitle}: mapped decision criteria from role goals and topic constraints.`,
    "Compared all options on retrieval quality, latency, governance, and scalability.",
    `Selected "${params.vote}" as the strongest overall tradeoff.`,
    "Captured implementation caveats and validation checks for rollout.",
  ];

  const normalizedStance = params.stance.trim();

  if (Array.isArray(params.value)) {
    const steps = params.value
      .map((item) => String(item || "").trim())
      .filter(Boolean)
      .filter((step) => !looksLikeJsonPayload(step))
      .slice(0, 6);
    if (steps.length >= 2) return steps;
  }
  if (typeof params.value === "string") {
    const lines = params.value
      .split(/\r?\n|[.;]/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((step) => !looksLikeJsonPayload(step))
      .slice(0, 6);
    if (lines.length >= 2) return lines;
  }

  const fallback = normalizedStance
    .split(/[.;]/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((step) => !looksLikeJsonPayload(step))
    .slice(0, 4);

  if (fallback.length >= 2) return fallback;
  return defaultProcess;
}

function simulatedOpinion(params: {
  agentId: string;
  agentName: string;
  roleTitle: string;
  topic: string;
  options: string[];
  round?: number;
  decisionMode?: CouncilDecisionMode;
  voteWeight?: number;
}): CouncilOpinion {
  const hash = `${params.agentId}:${params.topic}`
    .split("")
    .reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const vote = params.options[hash % params.options.length] ?? params.options[0];
  return {
    agentId: params.agentId,
    agentName: params.agentName,
    roleTitle: params.roleTitle,
    vote,
    rankedAlternatives: params.decisionMode === "ranked" ? normalizeRankedAlternatives(params.options, params.options, vote) : undefined,
    voteWeight: params.voteWeight ?? 1,
    decisionProcess: [
      "No provider key available for this agent.",
      "Used deterministic simulation fallback.",
      `Defaulted vote to "${vote}".`,
    ],
    stance: "Simulated vote because no model API key is configured for this agent.",
    confidence: 40,
    concerns: "Configure provider API key to enable live council reasoning.",
    model: "none",
    provider: "none",
    tokensUsed: 0,
    costUsd: 0,
    simulated: true,
    error: null,
    round: params.round ?? 1,
  };
}

function tallyCouncilVotes(params: {
  finalOpinions: CouncilOpinion[];
  options: string[];
  decisionMode: CouncilDecisionMode;
}): {
  tally: Array<{ option: string; votes: number }>;
  top: { option: string; votes: number };
  tiedTop: Array<{ option: string; votes: number }>;
  participantCount: number;
  reached: boolean;
  winnerLabel: string;
} {
  const tallyMap = new Map(params.options.map((option) => [option, 0]));
  const participantCount = params.finalOpinions.length;

  if (params.decisionMode === "ranked") {
    for (const opinion of params.finalOpinions) {
      const ranking = normalizeRankedAlternatives(opinion.rankedAlternatives, params.options, opinion.vote);
      const totalChoices = ranking.length;
      for (let index = 0; index < ranking.length; index += 1) {
        const option = ranking[index];
        tallyMap.set(option, (tallyMap.get(option) ?? 0) + (totalChoices - index));
      }
    }
  } else if (params.decisionMode === "weighted") {
    for (const opinion of params.finalOpinions) {
      tallyMap.set(opinion.vote, (tallyMap.get(opinion.vote) ?? 0) + Math.max(1, Number(opinion.voteWeight ?? 1)));
    }
  } else {
    for (const opinion of params.finalOpinions) {
      tallyMap.set(opinion.vote, (tallyMap.get(opinion.vote) ?? 0) + 1);
    }
  }

  const tally = [...tallyMap.entries()]
    .map(([option, votes]) => ({ option, votes }))
    .sort((left, right) => right.votes - left.votes);
  const top = tally[0] ?? { option: params.options[0], votes: 0 };
  const tiedTop = tally.filter((entry) => entry.votes === top.votes);

  let reached = false;
  if (params.decisionMode === "consensus") {
    reached = top.votes === participantCount;
  } else if (params.decisionMode === "weighted") {
    const totalWeight = params.finalOpinions.reduce((sum, opinion) => sum + Math.max(1, Number(opinion.voteWeight ?? 1)), 0);
    reached = tiedTop.length === 1 && top.votes > totalWeight / 2;
  } else if (params.decisionMode === "ranked") {
    reached = tiedTop.length === 1;
  } else {
    const majorityThreshold = Math.floor(participantCount / 2) + 1;
    reached = tiedTop.length === 1 && top.votes >= majorityThreshold;
  }

  return {
    tally,
    top,
    tiedTop,
    participantCount,
    reached,
    winnerLabel:
      params.decisionMode === "weighted"
        ? `${top.votes} weighted votes`
        : params.decisionMode === "ranked"
          ? `${top.votes} ranked points`
          : `${top.votes}/${participantCount} votes`,
  };
}

function buildCouncilDocumentContext(documentIds: string[]): {
  documents: CouncilDocumentContext[];
  promptSection: string;
} {
  const uniqueIds = Array.from(
    new Set(
      documentIds
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    ),
  ).slice(0, 6);

  const documents = uniqueIds
    .map((id) => getDocumentById(id))
    .filter(Boolean)
    .map((document) => ({
      id: document!.id,
      name: document!.name,
      sourceType: document!.sourceType,
      sourceUrl: document!.sourceUrl,
      excerpt: document!.extractedText.slice(0, 1800).trim(),
    }));

  if (documents.length === 0) {
    return { documents: [], promptSection: "" };
  }

  return {
    documents,
    promptSection: documents
      .map((document, index) => [
        `Document ${index + 1}: ${document.name}`,
        `- id: ${document.id}`,
        `- source: ${document.sourceType}${document.sourceUrl ? ` (${document.sourceUrl})` : ""}`,
        "- excerpt:",
        document.excerpt || "(no extracted text available)",
      ].join("\n"))
      .join("\n\n"),
  };
}

// C3: option discovery — ask each agent to propose options (parallelized)
async function discoverOptionsFromAgents(params: {
  agents: AgentRecord[];
  roleMap: Map<string, { roleTitle: string; roleDescription: string | null; capabilities: string[]; voteWeight: number }>;
  topic: string;
  documentSection: string;
}): Promise<string[]> {
  const agentPromises = params.agents.slice(0, 6).map(async (agent) => {
    const role = params.roleMap.get(agent.id);
    const model = getModelConfig({ agentId: agent.id });
    if (!model.apiKey && providerRequiresApiKey(model.provider)) return [] as string[];
    try {
      const result = await callModel({
        provider: model.provider,
        modelId: model.modelId,
        apiKey: model.apiKey,
        baseUrl: model.baseUrl,
        fastMode: model.fastMode,
        systemPrompt: `You are ${agent.name}, a ${role?.roleTitle ?? "team member"}. Propose up to 3 distinct options for the decision topic. Return JSON: {"options": ["opt1","opt2"]}`,
        userMessage: `Topic: ${params.topic}\n\n${params.documentSection ? "Grounding:\n" + params.documentSection + "\n\n" : ""}Return JSON only.`,
        maxTokens: 300,
      });
      const parsed = tryParseJson(result.response);
      const opts = Array.isArray(parsed?.options) ? (parsed.options as unknown[]).map(String) : [];
      return opts.filter((o) => o.trim().length > 1 && o.trim().length <= 120);
    } catch {
      return [] as string[];
    }
  });
  const results = await Promise.all(agentPromises);
  const proposals = results.flat();
  // Deduplicate case-insensitively, keep first occurrence, cap at 8
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const opt of proposals) {
    const key = opt.trim().toLowerCase();
    if (!seen.has(key)) { seen.add(key); unique.push(opt.trim()); }
  }
  return unique.slice(0, 8);
}

// C1: one poll round (agents called in parallel via Promise.all)
async function runPollRound(params: {
  agents: AgentRecord[];
  roleMap: Map<string, { roleTitle: string; roleDescription: string | null; capabilities: string[]; voteWeight: number }>;
  topic: string;
  options: string[];
  documentSection: string;
  previousRoundContext?: string;
  round: number;
  spendSource: string;
  decisionMode: CouncilDecisionMode;
  mode?: CouncilMode;
  onOpinionComplete?: (opinion: CouncilOpinion) => void;
}): Promise<CouncilOpinion[]> {
  const opinions = await Promise.all(
    params.agents.map(async (agent) => {
      const role = params.roleMap.get(agent.id);
      const roleTitle = role?.roleTitle || "Team Member";
      const voteWeight = role?.voteWeight ?? 1;
      const model = getModelConfig({ agentId: agent.id });

      if (!model.apiKey && providerRequiresApiKey(model.provider)) {
        const simOp = simulatedOpinion({
          agentId: agent.id,
          agentName: agent.name,
          roleTitle,
          topic: params.topic,
          options: params.options,
          round: params.round,
          decisionMode: params.decisionMode,
          voteWeight,
        });
        params.onOpinionComplete?.(simOp);
        return simOp;
      }

      const isDebate = params.mode === "debate";
      const systemPrompt =
        `You are ${agent.name}, participating in a council ${isDebate ? "debate" : "vote"}.\n` +
        `Role: ${roleTitle}\n` +
        `Role description: ${role?.roleDescription || "N/A"}\n` +
        `Capabilities: ${(role?.capabilities ?? []).join(", ") || "N/A"}\n` +
        `Voting mode: ${params.decisionMode}\n` +
        `Vote weight: ${voteWeight}\n\n` +
        (isDebate
          ? `Return strict JSON only (no markdown) with keys: vote, ${params.decisionMode === "ranked" ? "rankedAlternatives, " : ""}decision_process, stance, confidence, concerns, responds_to, changed_mind, remaining_disagreement.\n`
          : `Return strict JSON only (no markdown) with keys: vote, ${params.decisionMode === "ranked" ? "rankedAlternatives, " : ""}decision_process, stance, confidence, concerns.\n`) +
        "decision_process must be an array of short strings, each representing one explicit reasoning step.";

      const prevContext = params.previousRoundContext
        ? `\nPrevious round positions from other participants:\n${params.previousRoundContext}\n\nConsider these positions. You may revise your stance if warranted.\n`
        : "";

      const debateConstraints = isDebate
        ? [
            "- responds_to: the strongest point from the other participant (1-2 sentences).",
            "- changed_mind: \"yes\", \"no\", or \"partially\" — state whether the previous round changed your view, and why.",
            "- remaining_disagreement: 1-2 sentences naming what you still disagree about after considering the other position.",
          ].join("\n") + "\n"
        : "";

      const debateExample = isDebate
        ? "{\"vote\":\"Approve\",\"decision_process\":[\"step 1\",\"step 2\",\"step 3\"],\"stance\":\"...\",\"confidence\":78,\"concerns\":\"...\",\"responds_to\":\"The strongest point from the other agent was...\",\"changed_mind\":\"partially because...\",\"remaining_disagreement\":\"We still disagree on...\"}"
        : params.decisionMode === "ranked"
          ? "{\"vote\":\"Approve\",\"rankedAlternatives\":[\"Approve\",\"Defer\",\"Reject\"],\"decision_process\":[\"step 1\",\"step 2\",\"step 3\"],\"stance\":\"...\",\"confidence\":78,\"concerns\":\"...\"}"
          : "{\"vote\":\"Approve\",\"decision_process\":[\"step 1\",\"step 2\",\"step 3\"],\"stance\":\"...\",\"confidence\":78,\"concerns\":\"...\"}";

      const userMessage =
        `Topic:\n${params.topic}\n\n` +
        (params.documentSection ? `Grounding documents:\n${params.documentSection}\n\n` : "") +
        prevContext +
        `Vote options:\n${params.options.map((o) => `- ${o}`).join("\n")}\n\n` +
        "Constraints:\n" +
        "- vote must exactly match one provided option\n" +
        (params.decisionMode === "ranked" ? "- rankedAlternatives must rank the options from strongest to weakest preference\n" : "") +
        "- decision_process must be an array with 3 to 5 concise steps\n" +
        "- stance max 120 words\n" +
        "- confidence is 0-100 integer\n" +
        "- concerns max 80 words\n" +
        debateConstraints +
        (params.documentSection ? "- use the grounding documents when forming the stance and concerns\n\n" : "\n") +
        "Output format example:\n" +
        debateExample;

      try {
        const result = await callModel({
          provider: model.provider,
          modelId: model.modelId,
          apiKey: model.apiKey,
          baseUrl: model.baseUrl,
          fastMode: model.fastMode,
          systemPrompt,
          userMessage,
          maxTokens: 900,
        });

        const parsedJson = tryParseJson(result.response);
        const vote = pickVote(String(parsedJson?.vote ?? result.response ?? ""), params.options);
        const rankedAlternatives = params.decisionMode === "ranked"
          ? normalizeRankedAlternatives(parsedJson?.rankedAlternatives, params.options, vote)
          : undefined;
        let stance = String(parsedJson?.stance ?? result.response ?? "").trim();
        if (!stance || looksLikeJsonPayload(stance) || stance.length < 24) {
          stance = `${roleTitle} recommends "${vote}" after comparing quality, latency, governance, and scaling tradeoffs for the proposed options.`;
        }
        stance = stance.slice(0, 1600);
        const decisionProcess = normalizeDecisionProcess({
          value: parsedJson?.decision_process ?? result.response,
          stance,
          roleTitle,
          vote,
        });
        const concerns = String(parsedJson?.concerns ?? "").trim().slice(0, 600);
        const confidence = clampConfidence(parsedJson?.confidence);
        const costUsd = estimateCost(model.modelId, result.tokensIn, result.tokensOut);
        const respondsTo = isDebate ? String(parsedJson?.responds_to ?? "").trim().slice(0, 400) || null : null;
        const changedMindRaw = isDebate ? String(parsedJson?.changed_mind ?? "").trim().toLowerCase() : null;
        const changedMind: CouncilOpinion["changedMind"] = isDebate
          ? (changedMindRaw === "yes" || changedMindRaw === "no" || changedMindRaw === "partially" ? changedMindRaw : null)
          : null;
        const remainingDisagreement = isDebate ? String(parsedJson?.remaining_disagreement ?? "").trim().slice(0, 400) || null : null;

        recordAgentSpendEvent({
          agentId: agent.id,
          provider: model.provider,
          modelId: model.modelId,
          source: params.spendSource,
          referenceId: params.topic.slice(0, 80),
          tokensUsed: result.tokensUsed,
          costUsd,
          metadata: { topic: params.topic, round: params.round, roleTitle },
        });

        const op: CouncilOpinion = {
          agentId: agent.id,
          agentName: agent.name,
          roleTitle,
          vote,
          rankedAlternatives,
          voteWeight,
          decisionProcess,
          stance: stance || "No stance provided.",
          confidence,
          concerns,
          model: model.modelId,
          provider: model.provider,
          tokensUsed: result.tokensUsed,
          costUsd,
          simulated: false,
          error: null,
          round: params.round,
          respondsTo: respondsTo ?? undefined,
          changedMind: changedMind ?? undefined,
          remainingDisagreement: remainingDisagreement ?? undefined,
        };
        params.onOpinionComplete?.(op);
        return op;
      } catch (error) {
        const errOp: CouncilOpinion = {
          agentId: agent.id,
          agentName: agent.name,
          roleTitle,
          vote: params.options[0],
          rankedAlternatives: params.decisionMode === "ranked" ? params.options : undefined,
          voteWeight,
          decisionProcess: ["Model call failed while generating opinion."],
          stance: "Vote failed due to model error.",
          confidence: 0,
          concerns: "",
          model: model.modelId,
          provider: model.provider,
          tokensUsed: 0,
          costUsd: 0,
          simulated: false,
          error: String(error),
          round: params.round,
        };
        params.onOpinionComplete?.(errOp);
        return errOp;
      }
    })
  );
  return opinions;
}

// C2: moderator synthesis
async function runModeratorSynthesis(params: {
  synthesizerAgentId: string;
  topic: string;
  options: string[];
  opinions: CouncilOpinion[];
  tally: Array<{ option: string; votes: number }>;
  winner: string | null;
  decisionMode: CouncilDecisionMode;
}): Promise<string> {
  const model = getModelConfig({ agentId: params.synthesizerAgentId });
  if (!model.apiKey && providerRequiresApiKey(model.provider)) {
    return "Synthesis skipped — no model configured for the synthesizer agent.";
  }
  const opinionSummary = params.opinions
    .map((o) => `${o.agentName} (${o.roleTitle}): voted "${o.vote}" with confidence ${o.confidence}. Stance: ${o.stance.slice(0, 200)}. Concerns: ${o.concerns.slice(0, 120)}`)
    .join("\n\n");
  const tallyStr = params.tally.map((t) => `${t.option}: ${t.votes} votes`).join(", ");
  try {
    const result = await callModel({
      provider: model.provider,
      modelId: model.modelId,
      apiKey: model.apiKey,
      baseUrl: model.baseUrl,
      fastMode: model.fastMode,
      systemPrompt: "You are a neutral council moderator. Write a clear, concise synthesis verdict in 200-400 words. Do not take sides; fairly represent all positions.",
      userMessage: `Topic: ${params.topic}\n\nTally: ${tallyStr}\nDecision mode: ${params.decisionMode}\nResult: ${params.winner ? `"${params.winner}" wins` : "No clear winner"}\n\nParticipant positions:\n${opinionSummary}\n\nWrite a synthesis that:\n1. Names the winning option (or split)\n2. States the strongest argument for the winner\n3. Captures the strongest dissent in 1-2 sentences\n4. Lists 2-4 follow-up risks or caveats`,
      maxTokens: 1200,
    });
    return result.response.trim();
  } catch (err) {
    return `Synthesis failed: ${String(err)}`;
  }
}

// C5: build dissent summary from non-winning opinions
function buildDissent(opinions: CouncilOpinion[], winner: string | null): CouncilDissent[] {
  if (!winner) return [];
  const dissentGroups = new Map<string, { names: string[]; stances: string[] }>();
  for (const op of opinions) {
    if (op.vote === winner || op.simulated || op.error) continue;
    const g = dissentGroups.get(op.vote) ?? { names: [], stances: [] };
    g.names.push(op.agentName);
    if (op.stance && op.stance.length > 20) g.stances.push(op.stance.slice(0, 200));
    dissentGroups.set(op.vote, g);
  }
  return Array.from(dissentGroups.entries()).map(([vote, g]) => ({
    vote,
    agentNames: g.names,
    summary: g.stances.length > 0
      ? g.stances.slice(0, 2).join(" | ").slice(0, 400)
      : `${g.names.join(", ")} voted "${vote}".`,
  }));
}

export async function runCouncilSession(input: CouncilRequestInput): Promise<CouncilRunResult> {
  const decisionMode = input.decisionMode ?? "majority";
  const councilMode = input.mode ?? "poll";
  const debateRounds = councilMode === "debate" ? Math.min(Math.max(input.rounds ?? 3, 2), 5) : 1;
  let options = input.options?.map((o) => o.trim()).filter(Boolean) ?? ["Approve", "Revise", "Reject"];
  const uniqueOptions = Array.from(new Set(options));
  if (uniqueOptions.length < 2) {
    throw new Error("At least two unique options are required.");
  }

  const documentContext = buildCouncilDocumentContext(input.documentIds ?? []);
  const agentMap = new Map(listAgents().filter((a) => a.isActive).map((a) => [a.id, a]));
  const selectedAgents = input.agentIds.map((id) => agentMap.get(id)).filter(Boolean) as AgentRecord[];
  if (selectedAgents.length < 2) throw new Error("Pick at least two active agents for council.");

  const roleRows = listAgentRoles();
  const roleMap = new Map(roleRows.map((r) => [r.agentId, r as { roleTitle: string; roleDescription: string | null; capabilities: string[]; voteWeight: number }]));
  const blockedAgents: BlockedCouncilAgent[] = [];
  const eligibleAgents = selectedAgents.filter((agent) => {
    const decision = getAgentBudgetDecision(agent);
    if (decision.allowed) return true;
    blockedAgents.push({ agentId: agent.id, agentName: agent.name, reason: decision.message || "Agent budget blocked this council run." });
    return false;
  });
  if (eligibleAgents.length < 2) {
    const errorText = blockedAgents.length > 0
      ? `Council blocked by agent budget limits: ${blockedAgents.map((e) => `${e.agentName} (${e.reason})`).join("; ")}`
      : "Pick at least two active agents for council.";
    throw new Error(errorText);
  }

  // C10: cost cap pre-flight
  if (typeof input.costCapUsd === "number" && input.costCapUsd > 0) {
    const APPROX_COST_PER_1K_TOKENS = 0.003;
    const estimatedTokens = eligibleAgents.length * 900 * debateRounds;
    const estimatedCost = (estimatedTokens / 1000) * APPROX_COST_PER_1K_TOKENS;
    if (estimatedCost > input.costCapUsd) {
      throw new Error(`Estimated cost $${estimatedCost.toFixed(4)} exceeds cost cap $${input.costCapUsd.toFixed(4)}. Reduce participants, rounds, or raise the cap.`);
    }
  }

  // C3: option discovery round
  let resolvedOptions = uniqueOptions;
  if (input.discoverOptions) {
    const discovered = await discoverOptionsFromAgents({
      agents: eligibleAgents,
      roleMap,
      topic: input.topic,
      documentSection: documentContext.promptSection,
    });
    if (discovered.length >= 2) {
      resolvedOptions = Array.from(new Set([...discovered, ...uniqueOptions])).slice(0, 8);
    }
  }

  // C1: debate rounds or single poll
  const allOpinions: CouncilOpinion[] = [];
  const debateTranscript: Array<{ round: number; agentId: string; agentName: string; response: string }> = [];

  let previousRoundContext: string | undefined;
  for (let round = 1; round <= debateRounds; round++) {
    const roundOpinions = await runPollRound({
      agents: eligibleAgents,
      roleMap,
      topic: input.topic,
      options: resolvedOptions,
      documentSection: documentContext.promptSection,
      previousRoundContext,
      round,
      spendSource: "council",
      decisionMode,
      mode: councilMode,
      onOpinionComplete: input.onOpinionComplete,
    });
    allOpinions.push(...roundOpinions);
    if (councilMode === "debate") {
      // Build context for next round: show each participant's stance
      previousRoundContext = roundOpinions
        .filter((o) => !o.simulated && !o.error)
        .map((o) => `${o.agentName} (${o.roleTitle}): voted "${o.vote}". ${o.stance.slice(0, 200)}`)
        .join("\n");
      for (const o of roundOpinions) {
        debateTranscript.push({ round, agentId: o.agentId, agentName: o.agentName, response: o.stance });
      }
    }
  }

  // Use final-round opinions for tallying
  const finalOpinions = councilMode === "debate"
    ? allOpinions.filter((o) => o.round === debateRounds)
    : allOpinions;

  const { tally, top, tiedTop, participantCount, reached, winnerLabel } = tallyCouncilVotes({
    finalOpinions,
    options: resolvedOptions,
    decisionMode,
  });
  const failedCount = finalOpinions.filter((o) => Boolean(o.error)).length;
  const reliableReached = failedCount === 0 && reached;

  const totalTokens = allOpinions.reduce((s, o) => s + o.tokensUsed, 0);
  const totalCostUsd = allOpinions.reduce((s, o) => s + o.costUsd, 0);
  const simulatedCount = finalOpinions.filter((o) => o.simulated).length;

  const baseConclusion = reached
    ? `Council ${decisionMode} reached: "${top.option}" with ${winnerLabel}.`
    : tiedTop.length > 1
      ? `Council split decision: ${tiedTop.map((e) => `"${e.option}"`).join(", ")} tied at ${top.votes}${decisionMode === "ranked" ? " ranked points" : decisionMode === "weighted" ? " weighted votes" : " votes"} each.`
      : `Council has no ${decisionMode}. Current lead is "${top.option}" (${winnerLabel}).`;
  const conclusion = failedCount === participantCount
    ? `Council degraded: all ${participantCount}/${participantCount} participant model calls failed, so no reliable verdict is available.`
    : failedCount > 0
      ? `${baseConclusion} Warning: ${failedCount}/${participantCount} participant model calls failed, so treat this result as partial.`
      : baseConclusion;

  // C5: dissent capture
  const dissent = buildDissent(finalOpinions, reliableReached ? top.option : null);

  // C2: moderator synthesis (opt-in)
  let synthesis: string | null = null;
  if (input.synthesizerAgentId) {
    synthesis = await runModeratorSynthesis({
      synthesizerAgentId: input.synthesizerAgentId,
      topic: input.topic,
      options: resolvedOptions,
      opinions: finalOpinions,
      tally,
      winner: reliableReached ? top.option : null,
      decisionMode,
    });
  }

  return {
    topic: input.topic,
    decisionMode,
    options: resolvedOptions,
    participants: participantCount,
    blockedAgents,
    tally,
    winner: reliableReached ? top.option : null,
    reachedConsensus: reliableReached,
    conclusion,
    synthesis,
    dissent,
    totalTokens,
    totalCostUsd: Number(totalCostUsd.toFixed(6)),
    simulatedCount,
    documentsUsed: documentContext.documents,
    createdAt: new Date().toISOString(),
    opinions: allOpinions,
    rounds: debateRounds,
    debateTranscript: councilMode === "debate" ? debateTranscript : undefined,
  };
}
