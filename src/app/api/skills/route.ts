import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSqlite, initializeDatabase } from "@/lib/db";
import { TOOL_LABELS } from "@/lib/engine/tools";
import { listInstalledExtensions, listInstalledSkillCatalog } from "@/lib/extensions/registry";
import {
  installExternalSkillPack,
  listExternalSkillPacks,
  uninstallExternalSkillPack,
  updateExternalSkillPack,
} from "@/lib/skills/installer";
import { ensureCustomToolsTable } from "@/lib/tools/custom-tools";
import { requireOperatorAccess } from "@/lib/security/admin";
import { listAgents, pruneSkillPackReferences } from "@/lib/agents/registry";
import type { AgentSkillEntry } from "@/lib/extensions/registry";

export const dynamic = "force-dynamic";

type CustomToolRow = {
  id: string;
  name: string;
  description: string;
  type: "bash" | "javascript";
  parameters: string;
  is_active: number;
  created_at: string;
  updated_at: string;
};

type SkillUsage = {
  id: string;
  label: string;
  source: string;
  extensionId: string | null;
  stewardStatus: string;
  stewardNote: string | null;
  agentCount: number;
  workflowCount: number;
  agents: Array<{ id: string; name: string }>;
  workflows: Array<{ id: string; name: string }>;
};

function normalizedWords(value: string): Set<string> {
  const stop = new Set(["the", "and", "for", "with", "from", "skill", "agent", "tool", "tools"]);
  return new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 2 && !stop.has(word)),
  );
}

function overlapScore(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) {
    if (b.has(word)) shared += 1;
  }
  return shared / Math.min(a.size, b.size);
}

function buildConsolidationProposals(
  catalog: AgentSkillEntry[],
  usage: Map<string, SkillUsage>,
  stewardState: Map<string, { status: string; note: string | null; updatedAt: string }>,
) {
  const mutableSkills = catalog.filter((skill) =>
    skill.source !== "core" &&
    skill.source !== "optional" &&
    stewardState.get(skill.id)?.status !== "archived",
  );
  const proposals: Array<{
    id: string;
    primary: { id: string; label: string; source: string; usageCount: number };
    candidate: { id: string; label: string; source: string; usageCount: number };
    confidence: number;
    reasons: string[];
    recommendedAction: string;
  }> = [];

  for (let i = 0; i < mutableSkills.length; i += 1) {
    for (let j = i + 1; j < mutableSkills.length; j += 1) {
      const left = mutableSkills[i];
      const right = mutableSkills[j];
      const leftText = normalizedWords(`${left.name} ${left.label} ${left.description}`);
      const rightText = normalizedWords(`${right.name} ${right.label} ${right.description}`);
      const nameScore = overlapScore(normalizedWords(`${left.name} ${left.label}`), normalizedWords(`${right.name} ${right.label}`));
      const purposeScore = overlapScore(leftText, rightText);
      const leftUsage = usage.get(left.id);
      const rightUsage = usage.get(right.id);
      const leftCount = (leftUsage?.agentCount ?? 0) + (leftUsage?.workflowCount ?? 0);
      const rightCount = (rightUsage?.agentCount ?? 0) + (rightUsage?.workflowCount ?? 0);
      const lowUsage = Math.min(leftCount, rightCount) === 0;
      const sameExtension = Boolean(left.extensionId && left.extensionId === right.extensionId);
      const confidence = Math.round(Math.min(0.98, (nameScore * 0.45) + (purposeScore * 0.4) + (sameExtension ? 0.1 : 0) + (lowUsage ? 0.08 : 0)) * 100);
      if (confidence < 45) continue;

      const reasons = [];
      if (nameScore >= 0.5) reasons.push("similar name");
      if (purposeScore >= 0.45) reasons.push("overlapping description");
      if (sameExtension) reasons.push("same extension");
      if (lowUsage) reasons.push("one skill has no detected usage");
      if (reasons.length === 0) reasons.push("similar catalog metadata");

      const [primary, candidate, primaryCount, candidateCount] =
        leftCount >= rightCount
          ? [left, right, leftCount, rightCount]
          : [right, left, rightCount, leftCount];
      proposals.push({
        id: `${primary.id}__${candidate.id}`,
        primary: { id: primary.id, label: primary.label, source: primary.source, usageCount: primaryCount },
        candidate: { id: candidate.id, label: candidate.label, source: candidate.source, usageCount: candidateCount },
        confidence,
        reasons,
        recommendedAction: candidateCount === 0
          ? "Review and archive the unused candidate if the primary skill covers the same job."
          : "Review both skills before merging or disabling either one.",
      });
    }
  }

  return proposals
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 12);
}

const InstallSkillPackSchema = z.object({
  action: z.literal("install"),
  source: z.string().min(1),
  ref: z.string().optional(),
});

const UpdateSkillPackSchema = z.object({
  action: z.literal("update"),
  skillPackId: z.string().min(1),
});

const UninstallSkillPackSchema = z.object({
  action: z.literal("uninstall"),
  skillPackId: z.string().min(1),
});

const StewardStateSchema = z.object({
  action: z.literal("steward-state"),
  skillId: z.string().min(1),
  status: z.enum(["active", "pinned", "stale", "archived"]),
  note: z.string().max(500).optional(),
});

const SkillPackActionSchema = z.discriminatedUnion("action", [
  InstallSkillPackSchema,
  UpdateSkillPackSchema,
  UninstallSkillPackSchema,
  StewardStateSchema,
]);

export async function GET(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    initializeDatabase();
    const db = ensureCustomToolsTable(getSqlite());
    const { searchParams } = new URL(request.url);

    if (searchParams.get("action") === "steward") {
      const catalog = listInstalledSkillCatalog();
      const catalogById = new Map(catalog.map((skill) => [skill.id, skill]));
      const stewardRows = db
        .prepare("SELECT skill_id, status, note, updated_at FROM skill_steward_state")
        .all() as Array<{ skill_id: string; status: string; note: string | null; updated_at: string }>;
      const stewardState = new Map(stewardRows.map((row) => [row.skill_id, {
        status: row.status,
        note: row.note,
        updatedAt: row.updated_at,
      }]));
      let agents: ReturnType<typeof listAgents> = [];
      try {
        agents = listAgents();
      } catch (agentError) {
        if (!String(agentError).includes("no such table: agents")) throw agentError;
        initializeDatabase();
        try {
          agents = listAgents();
        } catch {
          agents = [];
        }
      }
      const usage = new Map<string, SkillUsage>();
      for (const agent of agents) {
        const enabledSkills = agent.enabledSkills;
        for (const skillId of enabledSkills) {
          const catalogEntry = catalogById.get(skillId);
          const current = usage.get(skillId) ?? {
            id: skillId,
            label: catalogEntry?.label ?? skillId,
            source: catalogEntry?.source ?? "unknown",
            extensionId: catalogEntry?.extensionId ?? null,
            stewardStatus: stewardState.get(skillId)?.status ?? "active",
            stewardNote: stewardState.get(skillId)?.note ?? null,
            agentCount: 0,
            workflowCount: 0,
            agents: [],
            workflows: [],
          };
          current.agentCount += 1;
          current.agents.push({ id: agent.id, name: agent.name });
          usage.set(skillId, current);
        }
      }
      const workflowRows = db
        .prepare("SELECT id, name, nodes FROM workflows ORDER BY updated_at DESC LIMIT 200")
        .all() as Array<{ id: string; name: string; nodes: string }>;
      for (const workflow of workflowRows) {
        const haystack = workflow.nodes || "";
        for (const skill of catalog) {
          if (!haystack.includes(skill.id) && !haystack.includes(skill.name)) continue;
          const current = usage.get(skill.id) ?? {
            id: skill.id,
            label: skill.label,
            source: skill.source,
            extensionId: skill.extensionId ?? null,
            stewardStatus: stewardState.get(skill.id)?.status ?? "active",
            stewardNote: stewardState.get(skill.id)?.note ?? null,
            agentCount: 0,
            workflowCount: 0,
            agents: [],
            workflows: [],
          };
          current.workflowCount += 1;
          if (current.workflows.length < 5) current.workflows.push({ id: workflow.id, name: workflow.name });
          usage.set(skill.id, current);
        }
      }
      const unused = catalog
        .filter((skill) => !usage.has(skill.id) && stewardState.get(skill.id)?.status !== "archived")
        .slice(0, 20)
        .map((skill) => ({
          id: skill.id,
          label: skill.label,
          source: skill.source,
          extensionId: skill.extensionId ?? null,
          stewardStatus: stewardState.get(skill.id)?.status ?? "active",
          stewardNote: stewardState.get(skill.id)?.note ?? null,
        }));
      const archived = catalog
        .filter((skill) => stewardState.get(skill.id)?.status === "archived")
        .slice(0, 50)
        .map((skill) => ({
          id: skill.id,
          label: skill.label,
          source: skill.source,
          extensionId: skill.extensionId ?? null,
          stewardStatus: "archived",
          stewardNote: stewardState.get(skill.id)?.note ?? null,
          updatedAt: stewardState.get(skill.id)?.updatedAt ?? null,
        }));
      return NextResponse.json({
        success: true,
        data: {
          summary: {
            catalogSkills: catalog.length,
            enabledSkills: usage.size,
            unusedSkills: unused.length,
            agents: agents.length,
            workflowsScanned: workflowRows.length,
          },
          mostUsed: Array.from(usage.values())
            .filter((skill) => skill.stewardStatus !== "archived")
            .sort((a, b) => b.agentCount - a.agentCount)
            .slice(0, 12),
          unused,
          archived,
          externalPacks: listExternalSkillPacks().map((pack) => ({
            id: pack.id,
            name: pack.name,
            scanStatus: pack.scanStatus ?? null,
            scanSummary: pack.scanSummary ?? null,
            skillCount: pack.skillCount,
            updatedAt: pack.updatedAt,
          })),
          proposals: buildConsolidationProposals(catalog, usage, stewardState),
          stewardState: Object.fromEntries(stewardState),
        },
      });
    }

    const rows = db.prepare("SELECT * FROM custom_tools ORDER BY created_at DESC").all() as CustomToolRow[];
    const builtIn = Object.entries(TOOL_LABELS)
      .map(([name, meta]) => ({
        name,
        label: meta.label,
        description: meta.description,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));

    const custom = rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      type: row.type,
      isActive: row.is_active === 1,
      parameters: JSON.parse(row.parameters) as Record<string, unknown>,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));

    return NextResponse.json({
      success: true,
      data: {
        builtIn,
        custom,
        packaged: listInstalledSkillCatalog().map((skill) => ({
          id: skill.id,
          name: skill.name,
          label: skill.label,
          description: skill.description,
          source: skill.source,
          extensionId: skill.extensionId,
          requiredEnv: skill.requiredEnv ?? [],
          platforms: skill.platforms ?? [],
          setupNotes: skill.setupNotes ?? [],
        })),
        packs: listExternalSkillPacks(),
        extensions: listInstalledExtensions(),
      },
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const body = await request.json();
    const parsed = SkillPackActionSchema.parse(body);

    if (parsed.action === "steward-state") {
      initializeDatabase();
      const db = getSqlite();
      const now = new Date().toISOString();
      const catalogEntry = listInstalledSkillCatalog().find((skill) => skill.id === parsed.skillId);
      if ((catalogEntry?.source === "core" || catalogEntry?.source === "optional") && parsed.status === "archived") {
        return NextResponse.json({ success: false, error: "Bundled core skills cannot be archived by the steward." }, { status: 409 });
      }
      const skillName = catalogEntry?.label ?? parsed.skillId;
      db.prepare(
        `INSERT INTO skill_steward_state(skill_id, name, status, note, updated_at)
         VALUES(?, ?, ?, ?, ?)
         ON CONFLICT(skill_id) DO UPDATE SET name = excluded.name, status = excluded.status, note = excluded.note, updated_at = excluded.updated_at`,
      ).run(parsed.skillId, skillName, parsed.status, parsed.note ?? null, now);
    } else if (parsed.action === "install") {
      installExternalSkillPack({
        source: parsed.source,
        ref: parsed.ref ?? null,
      });
    } else if (parsed.action === "update") {
      updateExternalSkillPack(parsed.skillPackId);
    } else {
      const removed = uninstallExternalSkillPack(parsed.skillPackId);
      if (!removed) {
        return NextResponse.json({ success: false, error: "External skill pack not found" }, { status: 404 });
      }
      pruneSkillPackReferences(parsed.skillPackId);
    }

    return NextResponse.json({
      success: true,
      data: {
        packs: listExternalSkillPacks(),
        packaged: listInstalledSkillCatalog().map((skill) => ({
          id: skill.id,
          name: skill.name,
          label: skill.label,
          description: skill.description,
          source: skill.source,
          extensionId: skill.extensionId,
          requiredEnv: skill.requiredEnv ?? [],
          platforms: skill.platforms ?? [],
          setupNotes: skill.setupNotes ?? [],
        })),
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
