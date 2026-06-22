import { NextResponse } from "next/server";
import { getSqlite } from "@/lib/db";
import { logger } from "@/lib/utils/logger";
import { requireOperatorAccess } from "@/lib/security/admin";

export async function POST(request: Request) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;
  try {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : null;

    if (!sessionId) {
      return NextResponse.json({ success: false, error: "sessionId is required" }, { status: 400 });
    }

    const db = getSqlite();
    const lastAssistant = db.prepare(
      "SELECT id, content, metadata, created_at FROM messages WHERE session_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 1"
    ).get(sessionId) as { id: string; content: string; metadata: string; created_at: string } | undefined;

    if (!lastAssistant) {
      return NextResponse.json({ success: false, error: "Nothing to undo — no assistant messages found" });
    }

    db.prepare(
      "DELETE FROM messages WHERE session_id = ? AND role = 'system' AND created_at > ?"
    ).run(sessionId, lastAssistant.created_at);

    db.prepare("DELETE FROM messages WHERE id = ?").run(lastAssistant.id);

    logger.info("[undo] Reverted last assistant message", { sessionId, messageId: lastAssistant.id });
    return NextResponse.json({
      success: true,
      data: {
        undone: true,
        checkpointRolledBack: false,
        messagePreview: lastAssistant.content.slice(0, 120),
      },
    });
  } catch (err) {
    logger.error("[undo] Failed", { error: String(err) });
    return NextResponse.json({ success: false, error: String(err) });
  }
}
