import fs from "node:fs";
import { listInstalledSkillCatalog } from "@/lib/extensions/registry";
import { recordSkillUsageEvent } from "@/lib/skills/usage-ledger";

export type SkillVerifySpec = {
  fixture: string;
  requiredSections: string[];
};

export type SkillVerifyResult = {
  ok: boolean;
  skillId: string;
  skillName: string;
  fixture: string;
  missingSections: string[];
  output: string;
  ms: number;
};

function parseInlineList(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed
      .slice(1, -1)
      .split(",")
      .map((item) => item.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }
  return trimmed
    .split(/\s*,\s*/)
    .map((item) => item.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

export function parseSkillVerifySpec(content: string): SkillVerifySpec | null {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  let inVerify = false;
  let fixture = "";
  const requiredSections: string[] = [];
  for (const line of lines) {
    if (/^verify:\s*$/i.test(line.trim())) {
      inVerify = true;
      continue;
    }
    if (!inVerify) continue;
    if (/^\S/.test(line) && line.trim() && !/^-\s/.test(line.trim())) break;
    const trimmed = line.trim();
    const fixtureMatch = trimmed.match(/^fixture:\s*(.+)$/i);
    if (fixtureMatch?.[1]) {
      fixture = fixtureMatch[1].trim().replace(/^["']|["']$/g, "");
      continue;
    }
    const sectionsMatch = trimmed.match(/^requiredSections:\s*(.*)$/i);
    if (sectionsMatch) {
      requiredSections.push(...parseInlineList(sectionsMatch[1] || ""));
      continue;
    }
    const listItem = trimmed.match(/^-\s*(.+)$/);
    if (listItem?.[1]) {
      requiredSections.push(listItem[1].trim().replace(/^["']|["']$/g, ""));
    }
  }
  const uniqueSections = Array.from(new Set(requiredSections.map((section) => section.trim()).filter(Boolean)));
  if (!fixture && uniqueSections.length === 0) return null;
  return { fixture, requiredSections: uniqueSections };
}

function hasSection(output: string, section: string): boolean {
  const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const heading = new RegExp(`(^|\\n)\\s{0,3}#{1,6}\\s+${escaped}\\b`, "i");
  if (heading.test(output)) return true;
  const label = new RegExp(`(^|\\n)\\s*(?:[-*]\\s*)?${escaped}\\s*:`, "i");
  if (label.test(output)) return true;
  return output.toLowerCase().includes(section.toLowerCase());
}

export async function verifySkill(
  skillId: string,
  opts?: { outputOverride?: string; sessionId?: string | null; agentId?: string | null },
): Promise<SkillVerifyResult> {
  const started = Date.now();
  const skill = listInstalledSkillCatalog().find((entry) => entry.id === skillId);
  if (!skill) {
    throw new Error(`Skill not found: ${skillId}`);
  }
  const content = fs.readFileSync(skill.skillPath, "utf8");
  const spec = parseSkillVerifySpec(content);
  if (!spec) {
    throw new Error(`Skill ${skillId} does not define a verify block`);
  }
  const output = opts?.outputOverride ?? content;
  const missingSections = spec.requiredSections.filter((section) => !hasSection(output, section));
  const result: SkillVerifyResult = {
    ok: missingSections.length === 0,
    skillId: skill.id,
    skillName: skill.label,
    fixture: spec.fixture,
    missingSections,
    output,
    ms: Date.now() - started,
  };
  recordSkillUsageEvent({
    skillId: skill.id,
    skillName: skill.label,
    skillSource: skill.source,
    eventKind: "evaluated",
    sessionId: opts?.sessionId ?? null,
    agentId: opts?.agentId ?? null,
    triggerText: spec.fixture,
    outcome: result.ok ? "passed" : "failed",
    evidence: missingSections.length ? [`missing: ${missingSections.join(", ")}`] : ["all required sections present"],
    metadata: { requiredSections: spec.requiredSections, ms: result.ms },
  });
  return result;
}
