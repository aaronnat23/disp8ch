import { NextRequest, NextResponse } from "next/server";
import { getSqlite, initializeDatabase } from "@/lib/db";
import { requireOperatorAccess } from "@/lib/security/admin";
import crypto from "node:crypto";
import { nanoid } from "nanoid";

export const dynamic = "force-dynamic";

type WebhookRow = {
  id: string;
  name: string;
  workflow_id: string;
  is_active: number;
  created_at: string;
  workflow_name: string | null;
  workflow_active: number | null;
  workflow_nodes: string | null;
};

type ExecRow = {
  id: string;
  workflow_id: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  error: string | null;
};

export async function GET(request: NextRequest) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;

  try {
    initializeDatabase();
    const db = getSqlite();

    const rows = db.prepare(`
      SELECT w.id, w.name, w.workflow_id, w.is_active, w.created_at,
             wf.name as workflow_name, wf.is_active as workflow_active, wf.nodes as workflow_nodes
      FROM webhooks w
      LEFT JOIN workflows wf ON wf.id = w.workflow_id
      ORDER BY w.created_at DESC
    `).all() as WebhookRow[];

    const execRows = db.prepare(
      "SELECT id, workflow_id, status, started_at, completed_at, error FROM executions WHERE trigger_type = 'webhook' ORDER BY started_at DESC LIMIT 300"
    ).all() as ExecRow[];

    const lastExecMap = new Map<string, ExecRow>();
    for (const exec of execRows) {
      if (!lastExecMap.has(exec.workflow_id)) {
        lastExecMap.set(exec.workflow_id, exec);
      }
    }

    const host = request.headers.get("host") ?? "";
    const proto = request.headers.get("x-forwarded-proto") ?? "http";
    const origin = host ? `${proto}://${host}` : "";

    const webhooks = rows.map((row) => {
      let hasWebhookTrigger = false;
      try {
        const nodes = JSON.parse(row.workflow_nodes ?? "[]") as Array<{ type?: string }>;
        hasWebhookTrigger = nodes.some((n) => n.type === "webhook-trigger");
      } catch {
        // ignore
      }

      const lastExec = lastExecMap.get(row.workflow_id);

      return {
        id: row.id,
        name: row.name,
        url: `/api/webhooks/${row.id}`,
        absoluteUrl: origin ? `${origin}/api/webhooks/${row.id}` : `/api/webhooks/${row.id}`,
        workflowId: row.workflow_id,
        workflowName: row.workflow_name ?? "(deleted workflow)",
        workflowActive: row.workflow_active === 1,
        createdAt: row.created_at,
        isActive: row.is_active === 1,
        hasWebhookTrigger,
        lastExecution: lastExec
          ? {
              id: lastExec.id,
              status: lastExec.status,
              startedAt: lastExec.started_at,
              completedAt: lastExec.completed_at,
              error: lastExec.error,
            }
          : null,
      };
    });

    const active = webhooks.filter((w) => w.isActive).length;

    return NextResponse.json({
      success: true,
      data: {
        summary: { total: webhooks.length, active, inactive: webhooks.length - active },
        webhooks,
      },
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;

  try {
    initializeDatabase();
    const db = getSqlite();

    const body = await request.json() as {
      action: string;
      id?: string;
      workflowId?: string;
      name?: string;
      isActive?: boolean;
    };

    if (body.action === "create") {
      const { workflowId, name } = body;
      if (!workflowId || !name?.trim()) {
        return NextResponse.json({ error: "workflowId and name are required" }, { status: 400 });
      }
      if (name.trim().length > 120) {
        return NextResponse.json({ error: "name too long (max 120 chars)" }, { status: 400 });
      }

      const workflow = db
        .prepare("SELECT id, name FROM workflows WHERE id = ?")
        .get(workflowId) as { id: string; name: string } | undefined;
      if (!workflow) {
        return NextResponse.json({ error: "Workflow not found" }, { status: 404 });
      }

      const id = nanoid(12);
      const secret = crypto.randomBytes(32).toString("hex");
      const now = new Date().toISOString();
      const isActive = body.isActive !== false ? 1 : 0;

      db.prepare(
        "INSERT INTO webhooks (id, workflow_id, name, secret, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(id, workflowId, name.trim(), secret, isActive, now);

      return NextResponse.json({
        success: true,
        data: { id, url: `/api/webhooks/${id}`, secret, workflowId, workflowName: workflow.name, isActive: isActive === 1, createdAt: now },
      });
    }

    if (body.action === "toggle") {
      const { id, isActive } = body;
      if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

      const existing = db.prepare("SELECT id, is_active FROM webhooks WHERE id = ?").get(id) as {
        id: string; is_active: number;
      } | undefined;
      if (!existing) return NextResponse.json({ error: "Webhook not found" }, { status: 404 });

      const newActive = isActive !== undefined ? (isActive ? 1 : 0) : (existing.is_active ? 0 : 1);
      db.prepare("UPDATE webhooks SET is_active = ? WHERE id = ?").run(newActive, id);

      return NextResponse.json({ success: true, data: { id, isActive: newActive === 1 } });
    }

    if (body.action === "rotate-secret") {
      const { id } = body;
      if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

      const existing = db.prepare("SELECT id FROM webhooks WHERE id = ?").get(id);
      if (!existing) return NextResponse.json({ error: "Webhook not found" }, { status: 404 });

      const secret = crypto.randomBytes(32).toString("hex");
      db.prepare("UPDATE webhooks SET secret = ? WHERE id = ?").run(secret, id);

      return NextResponse.json({ success: true, data: { id, secret } });
    }

    if (body.action === "delete") {
      const { id } = body;
      if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

      const existing = db.prepare("SELECT id FROM webhooks WHERE id = ?").get(id);
      if (!existing) return NextResponse.json({ error: "Webhook not found" }, { status: 404 });

      db.prepare("DELETE FROM webhooks WHERE id = ?").run(id);

      return NextResponse.json({ success: true, data: { id, deleted: true } });
    }

    return NextResponse.json({ error: `Unknown action: ${String(body.action)}` }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
