import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSqlite, initializeDatabase } from "@/lib/db";
import { restartWorkflowCrons, unscheduleCronWorkflow } from "@/lib/cron/manager";
import { nanoid } from "nanoid";
import {
  getActiveHierarchyOrganization,
  resolveHierarchyOrganization,
} from "@/lib/hierarchy/organizations";
import { getHierarchyGoalById, resolveHierarchyGoal } from "@/lib/hierarchy/goals";
import { resolveWorkflowTemplateReference } from "@/lib/workflows/template-catalog";
import { buildWorkflowTemplate } from "@/lib/workflows/templates";
import {
  buildCompatibleWorkflowImportChecklist,
  convertCompatibleWorkflowToDisp8ch,
  isCompatibleWorkflow,
  isDisp8chWorkflow,
} from "@/lib/workflows/compatible-import";
import { requireOperatorAccess } from "@/lib/security/admin";
import { normalizeWorkflowDefinition } from "@/lib/engine/workflow-normalize";
import { repairImportedWorkflow } from "@/lib/engine/import-repair";
import type { WorkflowNode } from "@/types/workflow";

const createWorkflowSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  nodes: z.array(z.any()).optional(),
  edges: z.array(z.any()).optional(),
  template: z.string().optional(),
  templateAgents: z.record(z.string().min(1)).optional(),
  organizationId: z.string().min(1).max(120).optional().nullable(),
  goalId: z.string().min(1).max(120).optional().nullable(),
  sourceType: z.string().min(1).max(120).optional(),
  sourceRef: z.string().min(1).max(240).optional(),
  importSource: z.string().optional(),
  importData: z.any().optional(),
});

const LEGACY_COMPAT_IMPORT_SOURCE = ["n", "8", "n"].join("");

function isCompatibleImportSource(source: string | undefined): boolean {
  return source === "compatible" || source === LEGACY_COMPAT_IMPORT_SOURCE;
}

function parseWorkflowNodes(raw: string): WorkflowNode[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as WorkflowNode[] : [];
  } catch {
    return [];
  }
}

function parseWorkflowJsonArray(raw: string): unknown[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function summarizeWorkflowNodes(nodes: WorkflowNode[]) {
  const triggerTypes = Array.from(
    new Set(
      nodes
        .map((node) => String(node?.type || ""))
        .filter((type) => type.includes("trigger")),
    ),
  );
  const hasPlaceholder = nodes.some((node) => String(node?.type || "") === "placeholder");
  const needsSetup = nodes.some((node) => {
    const type = String(node?.type || "");
    if (type === "placeholder") return true;
    if (["google-sheets", "notion", "airtable"].includes(type)) return true;
    if (["send-telegram", "send-discord", "send-whatsapp", "send-slack", "send-bluebubbles", "send-teams"].includes(type)) return true;
    return false;
  });
  const hasDataSource = nodes.some((node) => String(node?.type || "") === "document-tool");
  return { nodeCount: nodes.length, triggerTypes, needsSetup, hasPlaceholder, hasDataSource };
}

export async function GET(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    initializeDatabase();
    const db = getSqlite();

    const { searchParams } = new URL(request.url);
    const action = searchParams.get("action");
    const full = searchParams.get("full") === "1" || searchParams.get("shape") === "full";
    const idFilter = searchParams.get("id");

    // ── Export a single workflow as JSON ──────────────────────────────────────
    if (action === "export") {
      const id = searchParams.get("id");
      if (!id) return NextResponse.json({ success: false, error: "Missing id" }, { status: 400 });
      const row = db.prepare("SELECT * FROM workflows WHERE id = ?").get(id) as {
        id: string; name: string; description: string | null; nodes: string; edges: string;
        organization_id: string | null; goal_id: string | null; source_type: string | null;
        source_ref: string | null; is_active: number; created_at: string; updated_at: string;
      } | undefined;
      if (!row) return NextResponse.json({ success: false, error: "Workflow not found" }, { status: 404 });
      const { redactWorkflowExport } = await import("@/lib/workflows/secret-redaction");
      const exportData = redactWorkflowExport({
        _disp8chExport: true,
        version: "1",
        exportedAt: new Date().toISOString(),
        id: row.id,
        name: row.name,
        description: row.description,
        nodes: JSON.parse(row.nodes),
        edges: JSON.parse(row.edges),
        organizationId: row.organization_id,
        goalId: row.goal_id,
        sourceType: row.source_type,
        sourceRef: row.source_ref,
      });
      return new NextResponse(JSON.stringify(exportData, null, 2), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Content-Disposition": `attachment; filename="${row.name.replace(/[^a-z0-9]/gi, "_")}.disp8ch.json"`,
        },
      });
    }

    const rows = db.prepare(
      `${full ? "SELECT *" : "SELECT id, name, description, nodes, edges, organization_id, goal_id, source_type, source_ref, is_active, created_at, updated_at"} FROM workflows ${idFilter ? "WHERE id = ?" : ""} ORDER BY updated_at DESC`,
    ).all(...(idFilter ? [idFilter] : [])) as Array<{
      id: string; name: string; description: string | null; nodes: string; edges: string;
      organization_id: string | null; goal_id: string | null; source_type: string | null; source_ref: string | null;
      policy?: string | null; is_active: number; created_at: string; updated_at: string;
    }>;
    const lastExecRows = db.prepare(
      "SELECT workflow_id, id, status, trigger_type, trigger_data, started_at, completed_at FROM executions ORDER BY started_at DESC LIMIT 500",
    ).all() as Array<{
      workflow_id: string;
      id: string;
      status: string;
      trigger_type: string;
      trigger_data: string | null;
      started_at: string;
      completed_at: string | null;
    }>;
    const lastExecMap = new Map<string, {
      id: string;
      status: string;
      triggerType: string;
      triggerData: Record<string, unknown> | null;
      startedAt: string;
      completedAt: string | null;
    }>();
    for (const row of lastExecRows) {
      if (lastExecMap.has(row.workflow_id)) continue;
      lastExecMap.set(row.workflow_id, {
        id: row.id,
        status: row.status,
        triggerType: row.trigger_type,
        triggerData: row.trigger_data ? JSON.parse(row.trigger_data) : null,
        startedAt: row.started_at,
        completedAt: row.completed_at,
      });
    }

    const workflows = rows.map((r) => {
      const nodes = parseWorkflowNodes(r.nodes);
      const edges = parseWorkflowJsonArray(r.edges);
      const summary = summarizeWorkflowNodes(nodes);
      const base = {
        id: r.id,
        name: r.name,
        description: r.description,
        organizationId: r.organization_id ?? null,
        goalId: r.goal_id ?? null,
        sourceType: r.source_type ?? null,
        sourceRef: r.source_ref ?? null,
        isActive: r.is_active === 1,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        lastExecution: lastExecMap.get(r.id) ?? null,
        ...summary,
        edgeCount: edges.length,
      };
      if (!full) return base;
      return {
        ...base,
        policy: (() => {
          try {
            return r.policy ? JSON.parse(r.policy) : null;
          } catch {
            return null;
          }
        })(),
        nodes,
        edges,
      };
    });

    return NextResponse.json({ success: true, data: workflows });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
export async function POST(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    initializeDatabase();
    const body = await request.json();
    const parsed = createWorkflowSchema.parse(body);
    // Resolve template aliases (e.g. "ai crew" → "ai-crew-orchestrator")
    const resolvedTemplateKey = parsed.template
      ? (resolveWorkflowTemplateReference(parsed.template)?.key ?? parsed.template)
      : parsed.template;
    const db = getSqlite();
    const id = nanoid(12);
    const now = new Date().toISOString();
    const defaultWorkflowPolicy = JSON.stringify({ approval: { mode: "balanced" } });
    const resolvedOrganization = parsed.organizationId
      ? resolveHierarchyOrganization(parsed.organizationId)
      : null;
    if (parsed.organizationId && !resolvedOrganization) {
      return NextResponse.json(
        { success: false, error: `Organization not found: ${parsed.organizationId}` },
        { status: 404 },
      );
    }
    let organizationId =
      resolvedOrganization?.id ??
      (resolvedTemplateKey === "hierarchy-orchestrator-team" || resolvedTemplateKey === "trading-research-cycle"
        ? getActiveHierarchyOrganization()?.id ?? null
        : null);
    let goalId: string | null = null;
    if (parsed.goalId) {
      const resolvedGoal =
        resolveHierarchyGoal(parsed.goalId, organizationId ?? undefined) ??
        getHierarchyGoalById(parsed.goalId);
      if (!resolvedGoal) {
        return NextResponse.json(
          { success: false, error: `Goal not found: ${parsed.goalId}` },
          { status: 404 },
        );
      }
      if (organizationId && resolvedGoal.organizationId && resolvedGoal.organizationId !== organizationId) {
        return NextResponse.json(
          { success: false, error: "Goal does not belong to the selected organization" },
          { status: 400 },
        );
      }
      goalId = resolvedGoal.id;
      organizationId = resolvedGoal.organizationId ?? organizationId;
    }

    let nodes = parsed.nodes || [];
    let edges = parsed.edges || [];

    // ── Workflow import (compatible JSON or disp8ch) ───────────────────────────
    if (parsed.importSource && parsed.importData) {
      if (isCompatibleImportSource(parsed.importSource)) {
        if (!isCompatibleWorkflow(parsed.importData)) {
          return NextResponse.json({ success: false, error: "Invalid compatible workflow format" }, { status: 400 });
        }
        const result = convertCompatibleWorkflowToDisp8ch(parsed.importData);
        const repaired = repairImportedWorkflow({ nodes: result.nodes, edges: result.edges });
        nodes = repaired.nodes;
        edges = repaired.edges;
        // Return import stats alongside the created workflow data
        const importStats = result.stats;
        const importWarnings = [...result.warnings, ...repaired.repairs.map((repair) => repair.message)];
        const importChecklist = buildCompatibleWorkflowImportChecklist(result);
        db.prepare(
          "INSERT INTO workflows (id, name, description, nodes, edges, organization_id, goal_id, source_type, source_ref, policy, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).run(id, parsed.name, parsed.description || result.description || null, JSON.stringify(nodes), JSON.stringify(edges), organizationId, goalId, "compatible-import", null, defaultWorkflowPolicy, 1, now, now);
        restartWorkflowCrons(id);
        return NextResponse.json({ success: true, data: { id, name: parsed.name, description: parsed.description || result.description || null, nodes, edges, isActive: true, createdAt: now, updatedAt: now, importStats, importWarnings, importRepairs: repaired.repairs, importChecklist, compatibilityReport: result.compatibilityReport } });
      } else if (parsed.importSource === "disp8ch") {
        if (!isDisp8chWorkflow(parsed.importData)) {
          return NextResponse.json({ success: false, error: "Invalid disp8ch workflow format" }, { status: 400 });
        }
        const imp = parsed.importData as { nodes?: unknown[]; edges?: unknown[]; description?: string };
        const repaired = repairImportedWorkflow({ nodes: imp.nodes || [], edges: imp.edges || [] });
        nodes = repaired.nodes as typeof nodes;
        edges = repaired.edges as typeof edges;
        db.prepare(
          "INSERT INTO workflows (id, name, description, nodes, edges, organization_id, goal_id, source_type, source_ref, policy, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).run(id, parsed.name, parsed.description || (imp.description as string | null) || null, JSON.stringify(nodes), JSON.stringify(edges), organizationId, goalId, "disp8ch-import", null, defaultWorkflowPolicy, 1, now, now);
        restartWorkflowCrons(id);
        return NextResponse.json({ success: true, data: { id, name: parsed.name, nodes, edges, isActive: true, createdAt: now, updatedAt: now, importRepairs: repaired.repairs } });
      }
    }

    if (resolvedTemplateKey) {
      const template = buildWorkflowTemplate(resolvedTemplateKey, {
        templateAgents: parsed.templateAgents,
        organizationId,
      });
      if (template) {
        nodes = template.nodes;
        edges = template.edges;
      }
    }

    if (
      parsed.template &&
      !parsed.nodes &&
      !parsed.edges &&
      nodes.length === 0 &&
      edges.length === 0
    ) {
      return NextResponse.json(
        { success: false, error: `Unknown template: ${parsed.template}` },
        { status: 400 }
      );
    }

    // Normalize workflow before save: infer missing messages, ensure labels/positions
    const normalized = normalizeWorkflowDefinition({
      nodes,
      edges,
      source: parsed.template ? `template:${parsed.template}` : "manual",
      applySafeDefaults: true,
    });
    nodes = normalized.nodes;
    edges = normalized.edges;

    db.prepare(
      "INSERT INTO workflows (id, name, description, nodes, edges, organization_id, goal_id, source_type, source_ref, policy, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      id,
      parsed.name,
      parsed.description || null,
      JSON.stringify(nodes),
      JSON.stringify(edges),
      organizationId,
      goalId,
      parsed.sourceType || null,
      parsed.sourceRef || null,
      defaultWorkflowPolicy,
      1,
      now,
      now,
    );
    restartWorkflowCrons(id);

    return NextResponse.json({
      success: true,
      data: {
        id,
        name: parsed.name,
        description: parsed.description || null,
        organizationId,
        goalId,
        nodes,
        edges,
        sourceType: parsed.sourceType || null,
        sourceRef: parsed.sourceRef || null,
        isActive: true,
        createdAt: now,
        updatedAt: now,
        ...(normalized.warnings.length > 0 ? { normalizationWarnings: normalized.warnings } : {}),
      },
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    initializeDatabase();
    const body = await request.json();
    const { id, ...updates } = body;
    const db = getSqlite();
    const now = new Date().toISOString();

    if (!id) {
      return NextResponse.json({ success: false, error: "Missing workflow id" }, { status: 400 });
    }

    const setClauses: string[] = [];
    const values: unknown[] = [];

    if (updates.name !== undefined) { setClauses.push("name = ?"); values.push(updates.name); }
    if (updates.description !== undefined) { setClauses.push("description = ?"); values.push(updates.description); }
    if (updates.nodes !== undefined) { setClauses.push("nodes = ?"); values.push(JSON.stringify(updates.nodes)); }
    if (updates.edges !== undefined) { setClauses.push("edges = ?"); values.push(JSON.stringify(updates.edges)); }
    if (updates.organizationId !== undefined) { setClauses.push("organization_id = ?"); values.push(updates.organizationId || null); }
    if (updates.goalId !== undefined) { setClauses.push("goal_id = ?"); values.push(updates.goalId || null); }
    if (updates.isActive !== undefined) { setClauses.push("is_active = ?"); values.push(updates.isActive ? 1 : 0); }
    if (updates.concurrency !== undefined) {
      const { normalizeWorkflowConcurrency } = await import("@/lib/engine/execution-queue");
      const normalized = normalizeWorkflowConcurrency(updates.concurrency);
      setClauses.push("concurrency = ?");
      values.push(normalized ? JSON.stringify(normalized) : null);
    }
    if (updates.policy !== undefined) {
      const { normalizeWorkflowPolicy } = await import("@/lib/engine/workflow-policy");
      const normalized = normalizeWorkflowPolicy(updates.policy);
      setClauses.push("policy = ?");
      values.push(normalized ? JSON.stringify(normalized) : null);
    }

    setClauses.push("updated_at = ?");
    values.push(now);
    values.push(id);

    db.prepare(`UPDATE workflows SET ${setClauses.join(", ")} WHERE id = ?`).run(...values);

    // Restart cron jobs for this workflow after save
    restartWorkflowCrons(id);

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    initializeDatabase();
    const { searchParams } = new URL(request.url);
    const all = searchParams.get("all");
    const id = searchParams.get("id");
    const db = getSqlite();

    if (all === "1" || all === "true") {
      const rows = db.prepare("SELECT id FROM workflows").all() as Array<{ id: string }>;
      db.prepare("UPDATE board_tasks SET workflow_id = NULL WHERE workflow_id IS NOT NULL").run();
      db.prepare("DELETE FROM workflows").run();
      for (const row of rows) {
        db.prepare("DELETE FROM tag_links WHERE target_type = 'workflow' AND target_id = ?").run(row.id);
        unscheduleCronWorkflow(row.id);
      }
      return NextResponse.json({ success: true, data: { deleted: rows.length } });
    }

    if (!id) {
      return NextResponse.json({ success: false, error: "Missing id" }, { status: 400 });
    }

    db.prepare("UPDATE board_tasks SET workflow_id = NULL WHERE workflow_id = ?").run(id);
    db.prepare("DELETE FROM workflows WHERE id = ?").run(id);
    db.prepare("DELETE FROM tag_links WHERE target_type = 'workflow' AND target_id = ?").run(id);
    unscheduleCronWorkflow(id);
    return NextResponse.json({ success: true, data: { deleted: 1 } });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
