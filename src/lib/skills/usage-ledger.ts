import { nanoid } from "nanoid";
import { getSqlite, initializeDatabase, withSqliteWriteRecovery } from "@/lib/db";
import type { PromptSkill } from "@/lib/skills/prompt-index";

export type SkillUsageEventKind =
  | "loaded"
  | "used"
  | "proposed_patch"
  | "applied_patch"
  | "dismissed"
  | "evaluated";

export type SkillUsageEvent = {
  id: string;
  skillId: string;
  skillName: string;
  skillSource: string;
  eventKind: SkillUsageEventKind;
  sessionId: string | null;
  agentId: string | null;
  triggerText: string | null;
  outcome: string | null;
  evidence: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type SkillUsageSummary = {
  skillId: string;
  skillName: string;
  skillSource: string;
  loadedCount: number;
  usedCount: number;
  proposedPatchCount: number;
  appliedPatchCount: number;
  dismissedCount: number;
  lastLoadedAt: string | null;
  lastUsedAt: string | null;
  lastPatchedAt: string | null;
  lastEventAt: string | null;
};

type SkillUsageRow = {
  id: string;
  skill_id: string;
  skill_name: string;
  skill_source: string;
  event_kind: SkillUsageEventKind;
  session_id: string | null;
  agent_id: string | null;
  trigger_text: string | null;
  outcome: string | null;
  evidence_json: string | null;
  metadata_json: string | null;
  created_at: string;
};

function skillId(input: { name: string; source: string; category?: string }): string {
  return `${input.source}:${input.category ?? "general"}:${input.name}`
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 180);
}

function parseArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function parseObject(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function eventFromRow(row: SkillUsageRow): SkillUsageEvent {
  return {
    id: row.id,
    skillId: row.skill_id,
    skillName: row.skill_name,
    skillSource: row.skill_source,
    eventKind: row.event_kind,
    sessionId: row.session_id,
    agentId: row.agent_id,
    triggerText: row.trigger_text,
    outcome: row.outcome,
    evidence: parseArray(row.evidence_json),
    metadata: parseObject(row.metadata_json),
    createdAt: row.created_at,
  };
}

export function promptSkillId(skill: PromptSkill): string {
  return skillId({ name: skill.name, source: skill.source, category: skill.category });
}

export function recordSkillUsageEvent(input: {
  skillId?: string;
  skillName: string;
  skillSource: string;
  skillCategory?: string;
  eventKind: SkillUsageEventKind;
  sessionId?: string | null;
  agentId?: string | null;
  triggerText?: string | null;
  outcome?: string | null;
  evidence?: string[];
  metadata?: Record<string, unknown>;
}): SkillUsageEvent {
  initializeDatabase();
  const now = new Date().toISOString();
  const id = nanoid(16);
  const resolvedSkillId = input.skillId ?? skillId({
    name: input.skillName,
    source: input.skillSource,
    category: input.skillCategory,
  });
  withSqliteWriteRecovery("skill-usage-event:record", (writer) => {
    writer.prepare(`
      INSERT INTO skill_usage_events (
        id, skill_id, skill_name, skill_source, event_kind, session_id, agent_id,
        trigger_text, outcome, evidence_json, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      resolvedSkillId,
      input.skillName,
      input.skillSource,
      input.eventKind,
      input.sessionId ?? null,
      input.agentId ?? null,
      input.triggerText ?? null,
      input.outcome ?? null,
      JSON.stringify(input.evidence ?? []),
      JSON.stringify(input.metadata ?? {}),
      now,
    );
  });
  return {
    id,
    skillId: resolvedSkillId,
    skillName: input.skillName,
    skillSource: input.skillSource,
    eventKind: input.eventKind,
    sessionId: input.sessionId ?? null,
    agentId: input.agentId ?? null,
    triggerText: input.triggerText ?? null,
    outcome: input.outcome ?? null,
    evidence: input.evidence ?? [],
    metadata: input.metadata ?? {},
    createdAt: now,
  };
}

export function recordLoadedPromptSkills(input: {
  skills: PromptSkill[];
  sessionId?: string | null;
  agentId?: string | null;
  triggerText?: string | null;
  lane?: string | null;
}): void {
  for (const skill of input.skills) {
    recordSkillUsageEvent({
      skillId: promptSkillId(skill),
      skillName: skill.name,
      skillSource: skill.source,
      skillCategory: skill.category,
      eventKind: "loaded",
      sessionId: input.sessionId ?? null,
      agentId: input.agentId ?? null,
      triggerText: input.triggerText ?? null,
      metadata: { lane: input.lane ?? null, requiresTools: skill.requiresTools },
    });
  }
}

export function listSkillUsageEvents(input: {
  skillId?: string | null;
  sessionId?: string | null;
  limit?: number;
} = {}): SkillUsageEvent[] {
  initializeDatabase();
  const where: string[] = [];
  const params: unknown[] = [];
  if (input.skillId) {
    where.push("skill_id = ?");
    params.push(input.skillId);
  }
  if (input.sessionId) {
    where.push("session_id = ?");
    params.push(input.sessionId);
  }
  params.push(Math.max(1, Math.min(500, Math.floor(input.limit ?? 100))));
  const rows = getSqlite().prepare(`
    SELECT * FROM skill_usage_events
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...params) as SkillUsageRow[];
  return rows.map(eventFromRow);
}

export function listSkillUsageSummaries(limit = 200): SkillUsageSummary[] {
  initializeDatabase();
  const rows = getSqlite().prepare(`
    SELECT
      skill_id,
      MAX(skill_name) AS skill_name,
      MAX(skill_source) AS skill_source,
      SUM(CASE WHEN event_kind = 'loaded' THEN 1 ELSE 0 END) AS loaded_count,
      SUM(CASE WHEN event_kind = 'used' THEN 1 ELSE 0 END) AS used_count,
      SUM(CASE WHEN event_kind = 'proposed_patch' THEN 1 ELSE 0 END) AS proposed_patch_count,
      SUM(CASE WHEN event_kind = 'applied_patch' THEN 1 ELSE 0 END) AS applied_patch_count,
      SUM(CASE WHEN event_kind = 'dismissed' THEN 1 ELSE 0 END) AS dismissed_count,
      MAX(CASE WHEN event_kind = 'loaded' THEN created_at ELSE NULL END) AS last_loaded_at,
      MAX(CASE WHEN event_kind = 'used' THEN created_at ELSE NULL END) AS last_used_at,
      MAX(CASE WHEN event_kind = 'applied_patch' THEN created_at ELSE NULL END) AS last_patched_at,
      MAX(created_at) AS last_event_at
    FROM skill_usage_events
    GROUP BY skill_id
    ORDER BY last_event_at DESC
    LIMIT ?
  `).all(Math.max(1, Math.min(500, Math.floor(limit)))) as Array<{
    skill_id: string;
    skill_name: string;
    skill_source: string;
    loaded_count: number | null;
    used_count: number | null;
    proposed_patch_count: number | null;
    applied_patch_count: number | null;
    dismissed_count: number | null;
    last_loaded_at: string | null;
    last_used_at: string | null;
    last_patched_at: string | null;
    last_event_at: string | null;
  }>;
  return rows.map((row) => ({
    skillId: row.skill_id,
    skillName: row.skill_name,
    skillSource: row.skill_source,
    loadedCount: row.loaded_count ?? 0,
    usedCount: row.used_count ?? 0,
    proposedPatchCount: row.proposed_patch_count ?? 0,
    appliedPatchCount: row.applied_patch_count ?? 0,
    dismissedCount: row.dismissed_count ?? 0,
    lastLoadedAt: row.last_loaded_at,
    lastUsedAt: row.last_used_at,
    lastPatchedAt: row.last_patched_at,
    lastEventAt: row.last_event_at,
  }));
}
