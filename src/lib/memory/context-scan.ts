const INJECTION_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /[\u200B-\u200F\u2028-\u202F\u2060-\u2069\uFEFF]/g, label: "invisible Unicode characters" },
  { pattern: /[\u202A-\u202E\u2066-\u2069]/g, label: "BiDi override characters" },
  { pattern: /\bignore\s+(?:previous|all|above|prior)\s+instructions\b/i, label: "'ignore previous instructions'" },
  { pattern: /\bdo\s+not\s+tell\s+the\s+user\b/i, label: "'do not tell the user'" },
  { pattern: /\bdisregard\s+(?:your|all|any)\s+(?:instructions|rules)\b/i, label: "'disregard instructions'" },
  { pattern: /\bsystem\s+prompt\s+override\b/i, label: "'system prompt override'" },
  { pattern: /<!--[\s\S]*?(?:ignore|override|secret|hidden)[\s\S]*?-->/i, label: "hidden HTML comment" },
  { pattern: /<div\s[^>]*?style\s*=\s*"[^"]*display\s*:\s*none/i, label: "hidden div" },
  { pattern: /\bcurl\b[\s\S]{0,60}\$\{?\w*(?:KEY|TOKEN|SECRET|PASSWORD)/gi, label: "credential exfiltration via curl" },
  { pattern: /\bcat\b\s+\S*(?:\.env|credentials|\.netrc)\b/i, label: "secret file read via cat" },
];

export interface ScanResult {
  safe: boolean;
  content: string;
  blocked?: string;
}

export function scanContextContent(content: string, _filename?: string): ScanResult {
  if (!content || content.trim().length === 0) {
    return { safe: true, content };
  }

  const found: string[] = [];

  for (const { pattern, label } of INJECTION_PATTERNS) {
    const cleaned = content.replace(/```[\s\S]*?```/g, "");
    if (pattern.test(cleaned)) {
      found.push(label);
      pattern.lastIndex = 0;
    }
  }

  if (found.length > 0) {
    const uniqueLabels = Array.from(new Set(found));
    return {
      safe: false,
      content: "",
      blocked: `[BLOCKED: contained potential prompt injection — ${uniqueLabels.join(", ")}]`,
    };
  }

  return { safe: true, content };
}
