type MemoryGuardSeverity = "medium" | "high";

type MemoryGuardFinding = {
  label: string;
  severity: MemoryGuardSeverity;
};

type MemoryGuardTarget = "memory" | "user";

const MEMORY_GUARD_PATTERNS: Array<{
  label: string;
  severity: MemoryGuardSeverity;
  pattern: RegExp;
  targets?: MemoryGuardTarget[];
}> = [
  {
    label: "prompt-injection:ignore-instructions",
    severity: "high",
    pattern: /\b(?:ignore|disregard|forget)\b.{0,40}\b(?:previous|prior|earlier|above)\b.{0,40}\binstructions?\b/i,
  },
  {
    label: "prompt-injection:override-role",
    severity: "high",
    pattern: /\b(?:you are|act as|from now on you are)\b.{0,60}\b(?:system|developer|assistant)\b/i,
  },
  {
    label: "prompt-injection:reveal-prompt",
    severity: "high",
    pattern: /\b(?:reveal|print|show|leak)\b.{0,50}\b(?:system prompt|developer message|hidden instructions?)\b/i,
  },
  {
    label: "prompt-injection:tagged-role-block",
    severity: "high",
    pattern: /<\/?(?:system|developer|assistant|tool)>\s*/i,
  },
  {
    label: "prompt-injection:must-comply",
    severity: "medium",
    pattern: /\byou must\b.{0,50}\b(?:always|never|ignore|reveal|exfiltrate|send)\b/i,
  },
  {
    label: "exfiltration:network-fetch",
    severity: "high",
    pattern: /\b(?:curl|wget)\b.{0,120}https?:\/\//i,
  },
  {
    label: "exfiltration:webhook",
    severity: "high",
    pattern: /(?:webhook\.site|discord\.com\/api\/webhooks|api\.telegram\.org\/bot|requestbin|pipedream\.net|ngrok\.(?:io|com))/i,
  },
  {
    label: "exfiltration:secret-access",
    severity: "high",
    pattern: /\b(?:process\.env|api[_ -]?key|access[_ -]?token|secret|password)\b/i,
    targets: ["memory"],
  },
  {
    label: "stale-memory:task-progress",
    severity: "medium",
    pattern: /\b(?:fixed|implemented|completed|finished|submitted|merged|opened|closed|created)\b.{0,80}\b(?:bug|issue|pr|pull request|phase|task|ticket|commit|branch)\b/i,
    targets: ["memory"],
  },
  {
    label: "stale-memory:ephemeral-id",
    severity: "medium",
    pattern: /\b(?:PR\s*#?\d+|issue\s*#?\d+|commit\s+(?:sha\s*)?[0-9a-f]{7,40}|[0-9a-f]{40})\b/i,
    targets: ["memory"],
  },
  {
    label: "stale-memory:temporary-todo",
    severity: "medium",
    pattern: /\b(?:todo|next step|remaining work|phase\s+\d+\s+(?:done|complete)|done today|this session)\b/i,
    targets: ["memory"],
  },
];

export type LearningMemoryGuardResult = {
  safe: boolean;
  findings: MemoryGuardFinding[];
};

export function scanLearningWrite(target: MemoryGuardTarget, content: string): LearningMemoryGuardResult {
  const findings: MemoryGuardFinding[] = [];
  for (const rule of MEMORY_GUARD_PATTERNS) {
    if (rule.targets && !rule.targets.includes(target)) continue;
    if (!rule.pattern.test(content)) continue;
    findings.push({
      label: rule.label,
      severity: rule.severity,
    });
  }
  return {
    safe: findings.length === 0,
    findings,
  };
}
