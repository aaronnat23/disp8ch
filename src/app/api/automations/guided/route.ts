import { NextRequest, NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { requireOperatorAccess } from "@/lib/security/admin";
import { getSqlite, initializeDatabase } from "@/lib/db";
import { restartWorkflowCrons } from "@/lib/cron/manager";
import { normalizeWorkflowDefinition } from "@/lib/engine/workflow-normalize";
import {
  buildGuidedAutomationWorkflow,
  cadenceToCron,
  describeCadence,
  GuidedAutomationError,
  type GuidedAutomationDefinition,
} from "@/lib/automations/guided-setup";

export const dynamic = "force-dynamic";

/**
 * Create a normal workflow + cron schedule from a guided automation definition.
 * No second scheduler: this inserts a standard workflow record (with a
 * cron-trigger) and registers it through the existing cron manager.
 */
export async function POST(request: NextRequest) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;
  try {
    initializeDatabase();
    const def = (await request.json()) as GuidedAutomationDefinition;
    const built = buildGuidedAutomationWorkflow(def);
    const { expression, timezone } = cadenceToCron(def);

    const normalized = normalizeWorkflowDefinition({
      nodes: built.nodes as never,
      edges: built.edges as never,
      source: "automation:guided",
    });

    const db = getSqlite();
    const id = `wf-auto-${nanoid(8)}`;
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO workflows (id, name, description, nodes, edges, organization_id, goal_id, source_type, source_ref, schedule_profile, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      id,
      built.name,
      built.description,
      JSON.stringify(normalized.nodes),
      JSON.stringify(normalized.edges),
      null,
      null,
      "guided-automation",
      def.kind,
      JSON.stringify({
        overlapPolicy: def.allowOverlap === true ? "allow" : "skip-if-running",
        retryPolicy: def.retryOnFailure === false ? "none" : "once",
        ...(def.cadence === "one-time" ? { oneShotDate: def.date } : {}),
      }),
      1,
      now,
      now,
    );
    restartWorkflowCrons(id);

    return NextResponse.json({
      success: true,
      data: { workflowId: id, name: built.name, cron: expression, timezone, cadence: describeCadence(def) },
    });
  } catch (error) {
    const status = error instanceof GuidedAutomationError ? 400 : 500;
    return NextResponse.json(
      { success: false, error: String(error instanceof Error ? error.message : error) },
      { status },
    );
  }
}
