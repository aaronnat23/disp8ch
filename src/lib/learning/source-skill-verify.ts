/**
 * Deterministic verification for a compiled source-skill candidate. Runs BEFORE
 * any install. Hard gates block install; warnings surface for human review. The
 * model proposes; this module decides whether the proposal is safe and grounded.
 */
import { scanSkillContent } from "@/lib/learning/skill-guard";

export type CompiledSkill = {
  skill_name: string;
  title: string;
  description: string;
  category?: string;
  skill_markdown: string;
  support_files?: Array<{ path: string; content: string }>;
  test_plan?: string[];
  verification_commands?: string[];
  source_evidence?: Array<{ section: string; sources: string[] }>;
  uncertainties?: string[];
  blocked_claims?: string[];
};

export type SourceSkillVerifyResult = {
  passed: boolean;
  checks: string[]; // human-readable pass/fail lines
  failures: string[];
  warnings: string[];
  riskyCommands: string[];
  ungroundedClaims: string[];
};

const SECRET_PATTERNS = [
  /\bsk-[a-z0-9]{16,}\b/i,
  /\bghp_[a-z0-9]{20,}\b/i,
  /\bxox[abprs]-[a-z0-9-]{10,}\b/i,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

const RISKY_COMMAND_PATTERNS = [
  /\brm\s+-rf\b/i,
  /\bsudo\b/i,
  /\bcurl\b[^\n|]*\|\s*(sh|bash)\b/i,
  /\bwget\b[^\n|]*\|\s*(sh|bash)\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\bchmod\s+777\b/i,
  /\b(DROP|TRUNCATE)\s+TABLE\b/i,
];

function frontmatterHasNameAndDescription(markdown: string): boolean {
  const m = markdown.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!m) return false;
  const body = m[1];
  return /(^|\n)name\s*:/.test(body) && /(^|\n)description\s*:/.test(body);
}

function extractUrls(text: string): string[] {
  return Array.from(new Set((text.match(/https?:\/\/[^\s)"'`]+/gi) || []).map((u) => u.replace(/[.,)]+$/, ""))));
}

export function verifyCompiledSkill(compiled: CompiledSkill, sourceText: string): SourceSkillVerifyResult {
  const checks: string[] = [];
  const failures: string[] = [];
  const warnings: string[] = [];
  const riskyCommands: string[] = [];
  const ungroundedClaims: string[] = [];
  const lowerSource = sourceText.toLowerCase();

  function gate(name: string, ok: boolean, failMessage: string): void {
    if (ok) checks.push(`PASS ${name}`);
    else {
      checks.push(`FAIL ${name}`);
      failures.push(failMessage);
    }
  }

  // 1. Frontmatter
  gate("frontmatter", frontmatterHasNameAndDescription(compiled.skill_markdown), "SKILL.md frontmatter missing name/description");

  // 2. Description concise + routeable
  const desc = String(compiled.description || "").trim();
  gate("description", desc.length > 0 && desc.length <= 240, "Description must be a concise non-empty sentence (<=240 chars)");

  // 3. Safe skill name + support file paths
  const nameOk = /^[a-z0-9][a-z0-9-]{1,60}$/.test(compiled.skill_name || "");
  const pathsOk = (compiled.support_files ?? []).every((f) => {
    const p = String(f.path || "");
    return p.length > 0 && !p.includes("..") && !p.startsWith("/") && !/[:\\]/.test(p);
  });
  gate("safe_names", nameOk && pathsOk, "Skill name or support file path is unsafe");

  // 4. No secrets anywhere
  const allContent = [compiled.skill_markdown, ...(compiled.support_files ?? []).map((f) => f.content)].join("\n");
  const secretHit = SECRET_PATTERNS.some((re) => re.test(allContent));
  const guard = scanSkillContent(compiled.skill_markdown);
  gate("no_secrets", !secretHit, "Compiled skill contains a secret-shaped token");
  gate("guard_clean", guard.safe, `Skill blocked by security scan: ${guard.threats.join(", ")}`);

  // 5. At least one verification check
  const hasVerification =
    (compiled.verification_commands ?? []).some((c) => String(c).trim().length > 0) ||
    /##?\s*verif/i.test(compiled.skill_markdown);
  gate("has_verification", hasVerification, "Skill has no verification check");

  // 6. Source evidence present
  const hasEvidence = (compiled.source_evidence ?? []).some((e) => (e.sources ?? []).length > 0);
  gate("has_source_evidence", hasEvidence, "Skill has no source evidence");

  // 7. No invented URLs/endpoints (every URL must appear in the sources)
  const urls = extractUrls(compiled.skill_markdown);
  const ungroundedUrls = urls.filter((u) => !lowerSource.includes(u.toLowerCase()));
  ungroundedClaims.push(...ungroundedUrls);
  gate("grounded_urls", ungroundedUrls.length === 0, `Skill references URLs not in sources: ${ungroundedUrls.slice(0, 3).join(", ")}`);

  // Warnings (do not block, surface for review):
  for (const re of RISKY_COMMAND_PATTERNS) {
    const m = compiled.skill_markdown.match(re);
    if (m) riskyCommands.push(m[0]);
  }
  if (riskyCommands.length > 0) warnings.push(`Risky commands flagged for review: ${riskyCommands.join(", ")}`);
  if ((compiled.blocked_claims ?? []).length > 0) {
    warnings.push(`Model reported ${compiled.blocked_claims!.length} ungroundable claim(s).`);
  }

  return {
    passed: failures.length === 0,
    checks,
    failures,
    warnings,
    riskyCommands,
    ungroundedClaims,
  };
}
