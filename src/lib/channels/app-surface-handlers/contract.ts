export function isNoMutationRequest(msg: string): boolean {
  return /\b(do not|don't|never)\s+(create|save|run|start|execute|schedule|launch|begin)\b/i.test(msg)
    || /\bwithout\s+(?:creating|saving|changing|editing|running|executing|scheduling|starting)\b/i.test(msg)
    || /\b(?:compare|research|evaluate|assess|investigate|how\s+can\s+we\s+improve|close\s+the\s+gap)\b/i.test(msg)
    || (/\b(draft|design|plan|propose|outline|sketch)\b/i.test(msg) && !/\b(then|and)\s+(create|save|run|start|execute|schedule)\b/i.test(msg));
}

export function hasQualityGap(prompt: string, draft: string): boolean {
  const asks = [
    { pattern: /acceptance criteria/i, label: "acceptance criteria" },
    { pattern: /\brisks?\b/i, label: "risks" },
    { pattern: /\btests?\b/i, label: "tests" },
    { pattern: /data flow/i, label: "data flow" },
    { pattern: /\broles?\b/i, label: "roles" },
    { pattern: /\brounds?\b/i, label: "rounds" },
  ];
  for (const ask of asks) {
    if (ask.pattern.test(prompt) && !new RegExp(ask.pattern.source, "i").test(draft)) {
      return true;
    }
  }
  return false;
}

export function shouldModelEnrichAppSurface(input: {
  message: string;
  deterministicResponse: string;
}): boolean {
  if (!/\b(draft|design|proposal|plan|debate|compare|roles|criteria|strategy|improve|how would|how can)\b/i.test(input.message)) {
    return false;
  }
  if (hasQualityGap(input.message, input.deterministicResponse)) return true;
  return input.deterministicResponse.split(/\s+/).filter(Boolean).length < 140;
}
