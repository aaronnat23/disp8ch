import { NextResponse } from "next/server";
import { getSqlite, initializeDatabase, withSqliteWriteRecovery } from "@/lib/db";
import { requireOperatorAccess } from "@/lib/security/admin";

export async function GET() {
  try {
    initializeDatabase();
    const db = getSqlite();
    const row = db.prepare("SELECT onboarding_done FROM app_config WHERE id = 'default'").get() as { onboarding_done: number } | undefined;
    return NextResponse.json({ onboardingDone: row?.onboarding_done === 1 });
  } catch {
    return NextResponse.json({ onboardingDone: false });
  }
}

export async function POST(request: Request) {
  try {
    initializeDatabase();
    const db = getSqlite();
    const existing = db.prepare("SELECT onboarding_done FROM app_config WHERE id = 'default'").get() as { onboarding_done?: number } | undefined;
    if (existing?.onboarding_done === 1) {
      const denied = await requireOperatorAccess(request);
      if (denied) return denied;
    }
    const now = new Date().toISOString();
    let body: Record<string, unknown> = {};
    try {
      body = await request.json() as Record<string, unknown>;
    } catch {
      body = {};
    }
    withSqliteWriteRecovery("onboarding:save-learning-config", (writer) => {
      const result = writer.prepare(`
        UPDATE app_config
        SET onboarding_done = 1,
            learning_enabled = ?,
            learning_mode = ?,
            learning_capture_preferences = ?,
            learning_capture_playbooks = ?,
            learning_auto_promote_threshold = ?,
            updated_at = ?
        WHERE id = 'default'
      `).run(
        body.learning_enabled === 1 ? 1 : 0,
        String(body.learning_mode || "review"),
        body.learning_capture_preferences === 0 ? 0 : 1,
        body.learning_capture_playbooks === 0 ? 0 : 1,
        Math.max(1, Math.min(10, Number(body.learning_auto_promote_threshold || 2))),
        now,
      );
      if (result.changes === 0) {
        writer.prepare(`
          INSERT INTO app_config (
            id, onboarding_done, learning_enabled, learning_mode,
            learning_capture_preferences, learning_capture_playbooks,
            learning_auto_promote_threshold, created_at, updated_at
          ) VALUES ('default', 1, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          body.learning_enabled === 1 ? 1 : 0,
          String(body.learning_mode || "review"),
          body.learning_capture_preferences === 0 ? 0 : 1,
          body.learning_capture_playbooks === 0 ? 0 : 1,
          Math.max(1, Math.min(10, Number(body.learning_auto_promote_threshold || 2))),
          now,
          now,
        );
      }
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
