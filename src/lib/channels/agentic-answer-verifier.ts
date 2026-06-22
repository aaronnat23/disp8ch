import type { AgenticMode } from "@/lib/channels/agentic-routing-policy";

export type AgenticVerificationResult = {
  ok: boolean;
  severity: "pass" | "repair" | "fail";
  issues: string[];
  repairInstruction?: string;
};

/**
 * Verifies an agentic answer against structural quality checks.
 * Uses evidence signals, not benchmark IDs.
 */
export function verifyAgenticAnswer(params: {
  message: string;
  mode: AgenticMode;
  answer: string;
  toolsUsed: string[];
}): AgenticVerificationResult {
  const { message, mode, answer, toolsUsed } = params;
  const issues: string[] = [];
  const instructions: string[] = [];

  // ── Generic checks ────────────────────────────────────────────────────

  // Empty or trivially short answer
  if (!answer || answer.trim().length < 50) {
    issues.push("Answer is empty or trivially short.");
    instructions.push("Provide a substantive answer using the evidence gathered.");
  }

  if (mode !== "none" && toolsUsed.length === 0) {
    issues.push("Agentic route completed without using any tools.");
    instructions.push("Use the available tools first, then answer from the evidence. Do not answer from model memory alone.");
  }

  // Generic fallback when tools were used
  if (toolsUsed.length > 0) {
    const fallbackPatterns = [
      /i\s+was\s+unable\s+to\s+(?:complete|produce|provide)/i,
      /request\s+covered:/i,
      /unable\s+to\s+(?:complete|fulfill|process)/i,
      /no\s+(?:relevant|useful)\s+(?:information|evidence)\s+(?:was\s+)?found/i,
    ];
    for (const pattern of fallbackPatterns) {
      if (pattern.test(answer)) {
        issues.push("Generic fallback detected despite tools being used.");
        instructions.push("Use the evidence gathered by the tools to provide a specific answer. Do not return generic fallbacks.");
        break;
      }
    }
  }

  // ── Mode-specific checks ──────────────────────────────────────────────

  if (mode === "web_research") {
    if (!toolsUsed.includes("web_search") && !toolsUsed.includes("web_extract")) {
      issues.push("Web research answer has no web tool evidence.");
      instructions.push("Run web_search to discover sources and web_extract to verify the pages before answering.");
    }

    if (toolsUsed.includes("web_search") && !toolsUsed.includes("web_extract")) {
      issues.push("Web research used search results but did not extract source pages.");
      instructions.push("Use web_extract on the most relevant result URLs. Search snippets are discovery hints, not citation evidence.");
    }

    // No source URLs in a research answer
    if (!/https?:\/\/[^\s)]+/.test(answer) && toolsUsed.includes("web_search")) {
      issues.push("Web research answer has no source URLs despite using web_search.");
      instructions.push("Include the URLs of sources you fetched or searched. Cite specific pages, not just search snippets.");
    }

    // Only one source category (e.g., only official, no community)
    const hasOfficial = /\b(?:official|docs?\.|documentation|github\.com\/[a-zA-Z]+\/[a-zA-Z]+(?:\/(?:blob|tree|wiki))?)\b/i.test(answer);
    const hasCommunity = /\b(?:github\.com\/(?:issues|discussions)|reddit|forum|community|hn\b|hacker\s*news|stack\s*overflow)\b/i.test(answer);
    if (hasOfficial && !hasCommunity && /\b(?:community|issue|discussion|report|practical)\b/i.test(message)) {
      issues.push("Prompt asked for community reports but answer only has official sources.");
      instructions.push("Search for GitHub issues, discussions, Reddit, or forum posts about this topic. Include at least one non-official source.");
    }
  }

  if (mode === "repo_inspection" || mode === "capability_audit") {
    if (!toolsUsed.includes("search_files") && !toolsUsed.includes("read_file")) {
      issues.push("Repo/audit route has no repo tool evidence.");
      instructions.push("Use search_files to locate relevant implementation files, then read_file before making claims.");
    }

    // No file paths in a repo/audit answer
    const hasFilePaths = /\b(?:src|server|scripts|lib|components|app)\/[A-Za-z0-9._/-]+\.(?:ts|tsx|js|jsx)\b/.test(answer);
    if (!hasFilePaths && toolsUsed.includes("read_file")) {
      issues.push("Repo/audit answer has no file paths despite reading files.");
      instructions.push("Include the file paths and function names from the files you read. Cite specific file:line references.");
    }

    // Only repo-map/list evidence, no actual reads
    const hasReads = toolsUsed.includes("read_file");
    if (!hasReads && toolsUsed.includes("list_files")) {
      issues.push("Answer based only on file listing, not actual file reads.");
      instructions.push("Read the relevant files with read_file to understand the implementation. Do not answer from file names alone.");
    }
  }

  if (mode === "capability_audit") {
    // Does not separate implemented/configured/callable
    const hasImplemented = /\bimplemented\b/i.test(answer);
    const hasConfigured = /\bconfigured\b/i.test(answer);
    const hasCallable = /\bcallable\b/i.test(answer) || /\bavailable\s+now\b/i.test(answer);
    if (!hasImplemented || !hasConfigured || !hasCallable) {
      issues.push("Capability audit does not clearly separate implemented vs configured.");
      instructions.push("For each capability, report: Implemented (code exists), Configured now (credential/setting present), Callable now (can be used without missing setup).");
    }

    if (
      !/\b(?:benchmark|comparison|raw-results|test\s+results?)\b/i.test(message) &&
      /\b(?:docs\/improvements|raw-results\.md|variation-robustness|benchmark|comparison\s+outputs?|run-logs)\b/i.test(answer)
    ) {
      issues.push("Capability audit cites benchmark/run-output artifacts for current capability state.");
      instructions.push("Remove benchmark/run-output citations. Use current source files, channel_status, tool catalog, node registry, channel modules, and non-secret config surfaces instead.");
    }

    const asksCurrentConfig =
      /\b(?:currently|right\s+now|configured\s+with\s+credentials|configured\s+now|callable\s+now)\b/i.test(message);
    if (asksCurrentConfig && toolsUsed.includes("channel_status")) {
      if (/\b(?:cannot\s+verify\s+from\s+code\s+alone|depends\s+on\s+[\w_]+\s*(?:and|\+)\s*[\w_]+\s+env\s+vars?)\b/i.test(answer)) {
        issues.push("Capability audit asked for current configuration but answered from code-only uncertainty after channel_status was available.");
        instructions.push("Use channel_status for current runtime/configured/callable state. If a channel is disconnected or a required active model is absent, say that directly instead of saying it cannot be verified from code alone.");
      }

      if (/\bconfigured(?:\s+with\s+credentials)?\s+right\s+now\b[\s\S]{0,180}\b(?:✅|yes)\b[\s\S]{0,220}\bif\s+(?:an?\s+)?active\b/i.test(answer)) {
        issues.push("Capability audit marks a capability configured now while also making it conditional on an active provider.");
        instructions.push("Do not mark 'Configured now' as yes when the current status is conditional. Use the runtime status from channel_status to mark yes/no/unknown, then put prerequisites under Callable now or Caveats.");
      }

      if (
        /\b(?:speech-to-text|STT|transcription)\b/i.test(message) &&
        (
          /\b(?:\/api\/voice\/stt|STT\s+route|speech-to-text\s+route)\b[\s\S]{0,240}\b(?:either|or)\b[\s\S]{0,160}\bvoice_stt_api_key\b/i.test(answer) ||
          /\bselected\s+provider\s*\(?\s*OpenAI\s+Whisper\s*\)?\s+requires\s+either\b[\s\S]{0,180}\bvoice_stt_api_key\b/i.test(answer)
        )
      ) {
        issues.push("Capability audit claims the STT API route can use voice_stt_api_key even though the current route requires an active OpenAI model row.");
        instructions.push("Use channel_status and the STT code paths carefully: with selectedProvider=openai-whisper, STT requires an active OpenAI model row with a resolved key. voice_stt_api_key only applies after switching to provider paths that read it, such as deepgram/local-whisper workflow handling.");
      }
    }
  }

  if (mode === "design_studio") {
    const usedCreateOrUpdate = toolsUsed.includes("design_artifact_create") || toolsUsed.includes("design_artifact_update");
    if (!usedCreateOrUpdate) {
      issues.push("Design Studio route did not create or update a design artifact.");
      instructions.push("Use design_artifact_create for new persistent artifacts or design_artifact_update for edits. If the user only asked for a plan, explain that no artifact was saved.");
    }
    if (!/\bdesart_[A-Za-z0-9_-]+|\/designs\?/i.test(answer)) {
      issues.push("Design Studio answer does not include an artifact id or Designs tab link.");
      instructions.push("Include the project/artifact IDs and a /designs link returned by the design tool.");
    }
  }

  // ── Determine severity ────────────────────────────────────────────────
  if (issues.length === 0) {
    return { ok: true, severity: "pass", issues: [] };
  }

  const hasCriticalFail = issues.some((i) =>
    /empty|generic fallback|no file paths|no source urls/i.test(i),
  );

  return {
    ok: false,
    severity: hasCriticalFail ? "repair" : "repair",
    issues,
    repairInstruction: instructions.join("\n"),
  };
}
