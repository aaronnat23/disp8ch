import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { initializeDatabase, getSqlite } from "@/lib/db";
import { requireOperatorAccess } from "@/lib/security/admin";

export const dynamic = "force-dynamic";

function normalizeWorkspacePath(value: unknown): string | null {
  const raw = String(value || "").trim();
  if (!raw) return null;
  return path.resolve(raw);
}

export async function GET(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    initializeDatabase();
    const db = getSqlite();
    const { searchParams } = new URL(request.url);
    if (searchParams.get("action") === "preview") {
      const workspacePath = normalizeWorkspacePath(searchParams.get("path"));
      if (!workspacePath) return NextResponse.json({ success: false, error: "path required" }, { status: 400 });
      const trusted = db
        .prepare("SELECT path FROM trusted_workspaces WHERE path = ?")
        .get(workspacePath) as { path: string } | undefined;
      if (!trusted && workspacePath !== process.cwd()) {
        return NextResponse.json({ success: false, error: "workspace is not trusted" }, { status: 403 });
      }
      const files = fs.existsSync(workspacePath)
        ? fs.readdirSync(workspacePath, { withFileTypes: true })
          .filter((entry) => entry.isFile() && /\.(md|txt|json|yaml|yml)$/i.test(entry.name))
          .slice(0, 20)
          .map((entry) => {
            const filePath = path.join(workspacePath, entry.name);
            const stat = fs.statSync(filePath);
            let preview = "";
            try {
              preview = fs.readFileSync(filePath, "utf8").slice(0, 500);
            } catch {
              preview = "";
            }
            return { name: entry.name, path: filePath, sizeBytes: stat.size, preview };
          })
        : [];
      return NextResponse.json({ success: true, data: { path: workspacePath, files } });
    }
    const now = new Date().toISOString();
    const cwd = process.cwd();
    db.prepare(
      `INSERT INTO trusted_workspaces(path, label, source, created_at, updated_at)
       VALUES(?, ?, 'local', ?, ?)
       ON CONFLICT(path) DO UPDATE SET updated_at = excluded.updated_at`,
    ).run(cwd, "App workspace", now, now);

    const agentRows = db
      .prepare("SELECT name, workspace_path FROM agents WHERE workspace_path IS NOT NULL AND trim(workspace_path) != '' LIMIT 100")
      .all() as Array<{ name: string; workspace_path: string }>;
    for (const row of agentRows) {
      const workspacePath = normalizeWorkspacePath(row.workspace_path);
      if (!workspacePath) continue;
      db.prepare(
        `INSERT INTO trusted_workspaces(path, label, source, created_at, updated_at)
         VALUES(?, ?, 'agent', ?, ?)
         ON CONFLICT(path) DO UPDATE SET label = COALESCE(trusted_workspaces.label, excluded.label), updated_at = excluded.updated_at`,
      ).run(workspacePath, row.name, now, now);
    }

    const rows = db
      .prepare("SELECT path, label, source, updated_at FROM trusted_workspaces ORDER BY updated_at DESC LIMIT 50")
      .all() as Array<{ path: string; label: string | null; source: string; updated_at: string }>;
    return NextResponse.json({
      success: true,
      data: rows.map((row) => ({
        path: row.path,
        label: row.label || path.basename(row.path) || row.path,
        source: row.source,
        updatedAt: row.updated_at,
      })),
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    initializeDatabase();
    const body = await request.json() as { path?: unknown; label?: unknown };
    const workspacePath = normalizeWorkspacePath(body.path);
    if (!workspacePath) return NextResponse.json({ success: false, error: "path required" }, { status: 400 });
    const label = String(body.label || path.basename(workspacePath) || workspacePath).slice(0, 120);
    const now = new Date().toISOString();
    getSqlite().prepare(
      `INSERT INTO trusted_workspaces(path, label, source, created_at, updated_at)
       VALUES(?, ?, 'manual', ?, ?)
       ON CONFLICT(path) DO UPDATE SET label = excluded.label, updated_at = excluded.updated_at`,
    ).run(workspacePath, label, now, now);
    return NextResponse.json({ success: true, data: { path: workspacePath, label } });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
