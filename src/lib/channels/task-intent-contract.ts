export type TaskOperation =
  | "answer"
  | "compare"
  | "summarize"
  | "transform"
  | "compose"
  | "research"
  | "inspect"
  | "plan"
  | "design"
  | "act";

export type EvidenceSource =
  | "provided_text"
  | "session_history"
  | "memory"
  | "repo_files"
  | "app_state"
  | "benchmark_artifacts"
  | "current_web"
  | "general_knowledge";

export type ToolPolicy = "forbidden" | "optional" | "required";

export type TaskIntentContract = {
  operation: TaskOperation;
  evidenceSources: EvidenceSource[];
  toolPolicy: ToolPolicy;
  readOnly: boolean;
  requiresCurrentFacts: boolean;
  requiresRepoEvidence: boolean;
  requiresAppState: boolean;
  requiresSessionHistory: boolean;
  requiresProvidedTextOnly: boolean;
  confidence: "low" | "medium" | "high";
  reasons: string[];
};

export function hasProvidedOnlyBoundary(message: string): boolean {
  const text = String(message || "").trim();
  return (
    /\bbased\s+only\s+on\b/i.test(text) ||
    /\busing\s+only\s+(?:these|those|the|provided|the\s+following)\b/i.test(text) ||
    /\bfrom\s+this\s+prompt\b/i.test(text) ||
    /\bonly\s+(?:these|the|following|provided)\s+facts?\b/i.test(text) ||
    /\bwithout\s+(?:any|further)\s+(?:research|search|lookup|web\s+search)\b/i.test(text) ||
    /\bdo\s+not\s+(?:search|browse|look\s+up|fetch|inspect|read|use\s+tools?|research)\b/i.test(text)
  );
}

export function hasSessionOnlyBoundary(message: string): boolean {
  const text = String(message || "").trim();
  if (hasLocalContextAllowance(text)) return false;
  return (
    /\bbased\s+only\s+on\s+what\s+you\s+know\s+from\s+this\s+session\b/i.test(text) ||
    /\bbased\s+only\s+on\s+(?:this|our)\s+(?:session|conversation|chat)\b/i.test(text) ||
    /\bfrom\s+(?:this|our)\s+(?:session|conversation|chat)\s+only\b/i.test(text) ||
    /\busing\s+only\s+(?:this|our)\s+(?:session|conversation|chat)\b/i.test(text) ||
    /\buse\s+only\s+(?:this|our)\s+(?:session|conversation|chat)\b/i.test(text)
  );
}

function hasLocalContextAllowance(message: string): boolean {
  const text = String(message || "").trim();
  return (
    /\b(?:and|plus|with)\s+(?:any\s+)?(?:local\s+)?(?:app|repo|repository|codebase|workspace|files?)\s+(?:context|evidence|files?)\b/i.test(text) ||
    /\b(?:local\s+)?(?:app|repo|repository|codebase|workspace|files?)\/(?:repo|app)\s+context\b/i.test(text) ||
    /\b(?:local\s+)?(?:app|repo|repository|codebase|workspace|files?)\s+(?:or|and)\s+(?:local\s+)?(?:app|repo|repository|codebase|workspace|files?)\s+context\b/i.test(text)
  );
}

export function hasPlanOnlyResponseBoundary(message: string): boolean {
  const text = String(message || "").trim();
  return (
    /\b(?:inspection|implementation|verification|release|action|test|fix)\s+plan\s+only\b/i.test(text) ||
    /\b(?:give|provide|draft|write|outline|restate|return)\b[\s\S]{0,100}\b(?:plan|acceptance\s+criteria|checklist)\s+only\b/i.test(text) ||
    /\bfor\s+this\s+turn\b[\s\S]{0,120}\b(?:plan|acceptance\s+criteria|checklist)\s+only\b/i.test(text)
  );
}

export function hasExternalResearchRequest(message: string): boolean {
  const text = String(message || "").trim();
  return (
    /\b(?:search|browse|look\s+up|fetch|crawl|find)\b[\s\S]{0,80}\b(?:web|online|internet|source\s+links?|public\s+discussion)\b/i.test(text) ||
    /\b(?:latest|current|recent)\b[\s\S]{0,60}\b(?:discussion|news|updates?|developments?|trends?|public|release\s+notes?|changelog)\b/i.test(text) ||
    /\b(?:search\s+the\s+web|web\s+search|google\s+this|find\s+online)\b/i.test(text) ||
    /\b(?:public\s+discussion|community\s+reaction|what\s+(?:are|is)\s+people\s+(?:saying|using))\b/i.test(text) ||
    /\b(?:cite\s+sources?|source\s+links?)\b[\s\S]{0,40}\b(?:link|url|href|source)\b/i.test(text) ||
    /\b(?:latest|current)\s+(?:docs?|documentation|public|version)\b/i.test(text)
  );
}

export function hasRepoEvidenceRequest(message: string): boolean {
  const text = String(message || "").trim();
  return (
    hasLocalContextAllowance(text) ||
    /\b(?:inspect|review|analy[sz]e|examine)\b[\s\S]{0,80}\b(?:this\s+)?(?:codebase|repo|workspace|repository|code|files?)\b/i.test(text) ||
    /\b(?:find|show|tell\s+me)\b[\s\S]{0,80}\b(?:where|how)\b[\s\S]{0,80}\b(?:repo|codebase|workspace|repository|code|src\/|grounding|contract|quality\s+gate)\b/i.test(text) ||
    /\b(?:repo[-\s]?inspection|grounding|evidence\s+contract|quality\s+gate)\b[\s\S]{0,80}\b(?:enforced|implemented|checked|validated|codebase|repo|files?)\b/i.test(text) ||
    /\b(?:read|show|find)\b[\s\S]{0,60}\b(?:file|code|implementation|src\/)\b/i.test(text) ||
    /\b(?:implementation\s+plan|fix\s+plan|upgrade\s+plan)\b/i.test(text) ||
    /\b(?:files?\s+to\s+touch|code\s+review|audit)\b/i.test(text)
  );
}

export function hasBenchmarkArtifactRequest(message: string): boolean {
  const text = String(message || "")
    .replace(
      /\b(?:do\s+not|don't|without|avoid|exclude|ignore|not\s+using)\b[^.!?\n]{0,180}\b(?:benchmark|comparison)\b[^.!?\n]*(?=[.!?\n]|$)/gi,
      " ",
    )
    .trim();
  return (
    /\b(?:benchmark\s+results?|test\s+results?|run\s+reports?|tps|local_llm.*md)\b/i.test(text) ||
    /\b(?:benchmark|performance|latency|throughput)\b[\s\S]{0,40}\b(?:scores?|timings?|results?|reports?)\b/i.test(text) ||
    /\b(?:benchmark|reference\s+(?:app|agent))\b[\s\S]{0,80}\b(?:results?|tests?|scores?|timings?|runs?|reports?|\.md|benchmark)\b/i.test(text) ||
    /\b(?:comparison|compare|contrast)\b[\s\S]{0,80}\b(?:benchmark\s+results?|test\s+results?|scores?|timings?|run\s+reports?|[^\s]+\.md)\b/i.test(text) ||
    /\b(?:compare|contrast)\b[\s\S]{0,80}\b(?:reference\s+(?:app|agent)|apps?|agents?|systems?|implementations?)\b[\s\S]{0,40}\b(?:result|test|benchmark|md)\b/i.test(text)
  );
}

export function hasConversationContinuationReference(message: string): boolean {
  const text = String(message || "").trim();
  return (
    /\b(?:preserve|keep|retain|use|apply|follow)\b[\s\S]{0,80}\b(?:constraints?|criteria|evidence|findings?|requirements?)\b[\s\S]{0,50}\b(?:turn\s*\d+|previous|prior|earlier|above)\b/i.test(text) ||
    /\b(?:from|in)\s+(?:turn\s*\d+|the\s+previous\s+turn|the\s+prior\s+turn)\b/i.test(text) ||
    /\b(?:based\s+on|using)\b[\s\S]{0,50}\b(?:prior|previous|earlier)\s+(?:evidence|findings?|inspection|answer|response)\b/i.test(text)
  );
}

export function hasTransformationReference(message: string): boolean {
  const text = String(message || "").trim();
  return isPriorTurnReference(message) ||
    /\b(?:compare|contrast)\b[\s\S]{0,60}\b(?:above|prior|previous)\b/i.test(text) ||
    /\b(?:the\s+(?:two|release\s+notes?|paragraphs?|snippets?|versions?|texts?))\s+(?:above|below|prior|previous)\b/i.test(text) ||
    /\b(?:make|turn|convert|change)\s+(?:the\s+)?(?:first|second|above|prior|previous)\b/i.test(text);
}

function isPriorTurnReference(message: string): boolean {
  return /^(?:it|this|that|the\s+(?:answer|response|one|update|draft|text))\b/i.test(message.trim()) ||
    /\b(?:make|turn|convert|change|transform|reduce|shorten|trim|cut)\s+(?:it|this|that|the\s+(?:answer|response|one|update|draft|text))\b/i.test(message.trim()) ||
    /^that'?s\s+too\s+(?:long|verbose|detailed|marketing)\b/i.test(message.trim());
}

export function hasWritingArtifactReference(message: string): boolean {
  const text = String(message || "").trim();
  return (
    /\b(?:release\s+note|product\s+update|announcement|blog\s+post|changelog)\b/i.test(text) &&
    !/\b(?:online|web|search|find|look\s+up|latest|current)\b/i.test(text)
  ) || /\b(?:draft|write|compose)\b/i.test(text);
}

function hasExplicitReadOnlyBoundary(message: string): boolean {
  return /\b(?:do\s+not|don't)\s+(?:create|save|edit|update|modify|change|run|execute|schedule|send|start)\b/i.test(message) ||
    /\bwithout\s+(?:creating|saving|editing|updating|modifying|changing|running|executing|scheduling|sending|starting)\b/i.test(message) ||
    /\b(?:plan|proposal|propose|describe|design)\s+only\b/i.test(message) ||
    /\bask\s+(?:me\s+)?before\b/i.test(message);
}

function hasExplicitAppMutationRequest(message: string): boolean {
  if (hasProvidedOnlyBoundary(message) || hasSessionOnlyBoundary(message) || hasExplicitReadOnlyBoundary(message)) return false;
  const hasMutationVerb = /\b(?:create|build|make|generate|save|edit|update|modify|change|run|execute|schedule|send|configure|set\s+up|enable|disable|toggle|rotate|delete|remove)\b/i.test(message);
  if (!hasMutationVerb) return false;
  return /\b(?:design\s+studio|designs?\s+tab|design\s+artifact|workflow|automation|webhook|cron|schedule|board|task|council|agent|memory|settings?)\b/i.test(message);
}

export function hasExternalResearchRequestOnly(message: string): boolean {
  return hasExternalResearchRequest(message) &&
    !hasProvidedOnlyBoundary(message) &&
    !hasSessionOnlyBoundary(message);
}

export function determineTaskIntentContract(message: string): TaskIntentContract {
  const text = String(message || "").trim();
  const lowered = text.toLowerCase();
  const reasons: string[] = [];

  let operation: TaskOperation = "answer";
  const evidenceSources: EvidenceSource[] = [];
  let toolPolicy: ToolPolicy = "optional";
  let confidence: "low" | "medium" | "high" = "medium";

  if (/\bcompare\b/i.test(lowered) || /\bcomparison\b/i.test(lowered) || /\bversus\b/i.test(lowered) || /\bvs\.?\b/i.test(lowered) || /\bdifference\s+between\b/i.test(lowered) || /\bcontrast\b/i.test(lowered)) {
    operation = "compare";
  } else if (/\bresearch\b|\binvestigate\b|\bsynthesi[sz]e\b/i.test(lowered)) {
    operation = "research";
  } else if (/\b(?:draft|write|compose)\b/i.test(lowered)) {
    operation = "compose";
  } else if (/\b(?:rewrite|rephrase|summarize|make\s+(?:it|this)|turn\s+(?:it|this))\b/i.test(lowered)) {
    operation = "transform";
  } else if (/\b(?:design|blueprint|diagram)\b/i.test(lowered)) {
    operation = "design";
  } else if (/\bplan\b/i.test(lowered) || /\bimplementation\s+plan\b/i.test(lowered)) {
    operation = "plan";
  } else if (/\b(?:inspect|review|analy[sz]e|examine|audit)\b/i.test(lowered)) {
    operation = "inspect";
  }

  if (hasPlanOnlyResponseBoundary(text)) {
    toolPolicy = "forbidden";
    evidenceSources.push("provided_text");
    evidenceSources.push("session_history");
    reasons.push("explicit plan-only response boundary");
    confidence = "high";
  } else if (hasProvidedOnlyBoundary(text) || hasSessionOnlyBoundary(text)) {
    toolPolicy = "forbidden";
    if (hasSessionOnlyBoundary(text)) {
      evidenceSources.push("session_history");
      reasons.push("explicit session-only boundary");
    } else {
      evidenceSources.push("provided_text");
      reasons.push("explicit provided-only boundary");
    }
    confidence = "high";
  } else if (hasConversationContinuationReference(text) && !hasExternalResearchRequest(text) && !hasRepoEvidenceRequest(text)) {
    toolPolicy = "optional";
    evidenceSources.push("session_history");
    reasons.push("explicit continuation of prior-turn constraints or evidence");
    confidence = "high";
  } else if (hasExternalResearchRequest(text)) {
    toolPolicy = "required";
    evidenceSources.push("current_web");
    reasons.push("explicit external/current-fact research request");
    confidence = "high";
  } else if (hasBenchmarkArtifactRequest(text)) {
    toolPolicy = "required";
    evidenceSources.push("benchmark_artifacts");
    evidenceSources.push("repo_files");
    reasons.push("benchmark artifact evidence needed");
    confidence = "high";
  } else if (hasRepoEvidenceRequest(text)) {
    toolPolicy = "required";
    evidenceSources.push("repo_files");
    reasons.push("repo evidence needed");
    confidence = "high";
  } else if (
    operation === "compare" &&
    /\b(?:these|those)\s+(?:(?:two|2)\s+)?(?:approaches|options|items|snippets|paragraphs|versions|texts|ideas|examples)\b/i.test(text) &&
    !/\b(?:above|below|prior|previous|earlier|from\s+this\s+session)\b/i.test(text)
  ) {
    toolPolicy = "forbidden";
    evidenceSources.push("provided_text");
    reasons.push("comparison over items provided in the prompt");
    confidence = "high";
  } else if (hasTransformationReference(text)) {
    toolPolicy = "forbidden";
    evidenceSources.push("session_history");
    evidenceSources.push("provided_text");
    reasons.push("transformation over prior turns or provided text");
    confidence = "high";
  } else if (hasWritingArtifactReference(text) && operation === "compose") {
    toolPolicy = "forbidden";
    evidenceSources.push("general_knowledge");
    reasons.push("writing artifact request without inspection/search indicators");
    confidence = "high";
  } else if (operation === "compare") {
    reasons.push("comparison without explicit source boundary — inferring from message");
    if (
      /\b(?:token|identifier|code|key|value|version(?:s)?)\b/i.test(lowered) &&
      /\b(?:old|mid|current|new|latest|previous|history|lineage)\b/i.test(lowered)
    ) {
      toolPolicy = "optional";
      evidenceSources.push("memory");
      evidenceSources.push("session_history");
      reasons.push("identifier/version comparison implies memory or session evidence");
    } else if (
      /\b(?:current|latest|recent|today|public|community|discussion)\b/i.test(lowered) ||
      /\b(?:docs?|documentation|model\s+card)\b/i.test(lowered)
    ) {
      toolPolicy = "required";
      evidenceSources.push("current_web");
      reasons.push("comparison implies current-fact grounding");
    } else if (/\b(?:repo|codebase|workspace|files?|src\/|implementation|inspect)\b/i.test(lowered)) {
      toolPolicy = "required";
      evidenceSources.push("repo_files");
      reasons.push("comparison implies repo grounding");
    } else if (/\b(?:benchmark|test\s+results?|LOCAL_LLM|timing|score|tps)\b/i.test(lowered)) {
      toolPolicy = "required";
      evidenceSources.push("benchmark_artifacts");
      reasons.push("comparison implies benchmark evidence");
    } else if (/\b(?:what\s+(?:is|are)|explain|describe|define)\s+(?:the\s+)?(?:difference|distinction)\b/i.test(lowered)) {
      toolPolicy = "forbidden";
      evidenceSources.push("general_knowledge");
      reasons.push("definition-style comparison — no tool evidence required");
    } else if (
      /\b(?:from\s+this\s+session|from\s+what\s+you\s+know|without\s+(?:research|search|web|online|tools?))\b/i.test(lowered)
    ) {
      toolPolicy = "forbidden";
      evidenceSources.push("session_history");
      reasons.push("comparison with implicit session-only source");
    } else {
      toolPolicy = "optional";
      evidenceSources.push("general_knowledge");
      reasons.push("comparison without explicit source — tools optional");
    }
  }

  const requiresCurrentFacts = evidenceSources.includes("current_web");
  const requiresRepoEvidence = evidenceSources.includes("repo_files");
  const requiresAppState = evidenceSources.includes("app_state");
  const requiresSessionHistory = evidenceSources.includes("session_history");
  const requiresProvidedTextOnly = evidenceSources.length === 1 && (evidenceSources[0] === "provided_text");
  const readOnly = !hasExplicitAppMutationRequest(text);

  return {
    operation,
    evidenceSources,
    toolPolicy,
    readOnly,
    requiresCurrentFacts,
    requiresRepoEvidence,
    requiresAppState,
    requiresSessionHistory,
    requiresProvidedTextOnly,
    confidence,
    reasons,
  };
}
