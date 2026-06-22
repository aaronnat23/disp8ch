import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { getSqlite, initializeDatabase } from "@/lib/db";
import { getHookFileState, getHooksDir, isHooksEnabled, listHookFiles, runHooksWithReport, setHookFileEnabled } from "@/lib/hooks";
import { requireOperatorAccess } from "@/lib/security/admin";
import { readCappedJson } from "@/lib/security/body";

export const dynamic = "force-dynamic";

const EVENT_SUMMARIES: Record<string, string> = {
  "workflow:start": "Workflow execution started",
  "workflow:complete": "Workflow completed successfully",
  "workflow:failed": "Workflow failed",
  "tool:approval:requested": "Tool execution approval requested",
  "tool:approved": "Tool execution approved",
  "tool:denied": "Tool execution denied",
  "backup:start": "Backup started",
  "backup:complete": "Backup completed successfully",
  "backup:failed": "Backup failed",
  "skill:archived": "Skill archived",
  "skill:proposed": "Skill proposed for promotion",
  "skill:promoted": "Skill promoted",
  "model:failure": "Model provider call failed",
  "channel:message": "Channel message received",
  "channel:error": "Channel delivery failed",
  "memory:store": "Memory stored",
  "memory:search": "Memory searched",
  "compaction:complete": "Context compaction completed",
  "debug:dry-run": "Hook dry-run test executed",
};

function readHookSummary(filePath: string) {
  const stat = fs.statSync(filePath);
  const state = (() => {
    try {
      return getSqlite()
        .prepare("SELECT last_event_type, last_status, last_error, last_duration_ms, last_run_at FROM hook_run_state WHERE hook_path = ?")
        .get(filePath) as {
          last_event_type: string | null;
          last_status: string;
          last_error: string | null;
          last_duration_ms: number | null;
          last_run_at: string | null;
        } | undefined;
    } catch {
      return undefined;
    }
  })();
  const fileState = getHookFileState(filePath);
  let source = "";
  try {
    source = fs.readFileSync(filePath, "utf-8").slice(0, 12_000);
  } catch {
    source = "";
  }
  const handler =
    /export\s+default\s+(async\s+)?function|export\s+default\s+async\s*\(|module\.exports\s*=/.test(source)
      ? "default"
      : /export\s+(async\s+)?function\s+onEvent|exports\.onEvent\s*=/.test(source)
        ? "onEvent"
        : "unknown";
  const eventHints = Array.from(source.matchAll(/(?:event\.type|type)\s*={0,2}={0,1}\s*["'`]([^"'`]+)["'`]/g))
    .map((match) => String(match[1]))
    .slice(0, 8);
  return {
    fileName: path.basename(filePath),
    path: filePath,
    sizeBytes: stat.size,
    updatedAt: stat.mtime.toISOString(),
    handler,
    eventHints,
    enabled: fileState.enabled,
    stateUpdatedAt: fileState.updatedAt,
    lastRun: state ? {
      eventType: state.last_event_type,
      status: state.last_status,
      error: state.last_error,
      durationMs: state.last_duration_ms,
      ranAt: state.last_run_at,
    } : null,
  };
}

export async function GET(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    initializeDatabase();
    const db = getSqlite();
    const dir = getHooksDir();
    const hooks = listHookFiles().map(readHookSummary).map((hook) => ({
      ...hook,
      eventSummary: hook.lastRun?.eventType
        ? (EVENT_SUMMARIES[hook.lastRun.eventType] || hook.lastRun.eventType)
        : "No recent events",
      eventFriendly: hook.lastRun?.eventType
        ? (EVENT_SUMMARIES[hook.lastRun.eventType] || hook.lastRun.eventType)
        : "No events yet",
    }));
    const eventGroups = new Map<string, { event: string; hookCount: number; enabledCount: number }>();
    for (const hook of hooks) {
      const events = hook.eventHints.length > 0 ? hook.eventHints : ["any"];
      for (const event of events) {
        const current = eventGroups.get(event) ?? { event, hookCount: 0, enabledCount: 0 };
        current.hookCount += 1;
        if (hook.enabled) current.enabledCount += 1;
        eventGroups.set(event, current);
      }
    }
    // Enrich event groups with per-event last-run diagnostics
    const eventLastRuns = new Map<string, { status: string; ranAt: string | null; durationMs: number | null; error: string | null }>();
    try {
      const runRows = db
        .prepare(
          `SELECT last_event_type, last_status, last_run_at, last_duration_ms, last_error
           FROM hook_run_state
           WHERE last_event_type IS NOT NULL
           ORDER BY last_run_at DESC`,
        )
        .all() as Array<{ last_event_type: string; last_status: string; last_run_at: string | null; last_duration_ms: number | null; last_error: string | null }>;
      for (const row of runRows) {
        if (!eventLastRuns.has(row.last_event_type)) {
          eventLastRuns.set(row.last_event_type, { status: row.last_status, ranAt: row.last_run_at, durationMs: row.last_duration_ms, error: row.last_error });
        }
      }
    } catch {
      // non-fatal
    }
    const enrichedEventGroups = Array.from(eventGroups.values())
      .sort((a, b) => b.hookCount - a.hookCount || a.event.localeCompare(b.event))
      .map((g) => ({ ...g, lastRun: eventLastRuns.get(g.event) ?? null }));

    return NextResponse.json({
      success: true,
      data: {
        enabled: isHooksEnabled(),
        directory: dir,
        supportedEvents: [
          "tool:call:start",
          "tool:call:end",
          "tool:approval:requested",
          "workflow:execution:start",
          "workflow:execution:end",
          "debug:dry-run",
        ],
        eventGroups: enrichedEventGroups,
        hooks,
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
    initializeDatabase();
    const body = await readCappedJson<Record<string, unknown>>(request, 32 * 1024);
    const action = String(body.action || "dry-run");
    if (action === "set-enabled") {
      const hookPath = String(body.path || "");
      if (!hookPath) {
        return NextResponse.json({ success: false, error: "Missing hook path" }, { status: 400 });
      }
      setHookFileEnabled(hookPath, body.enabled !== false);
      return NextResponse.json({
        success: true,
        data: {
          hooks: listHookFiles().map(readHookSummary),
        },
      });
    }
    const type = String(body.type || "debug:dry-run").trim() || "debug:dry-run";
    const payload = body.payload && typeof body.payload === "object" && !Array.isArray(body.payload)
      ? body.payload as Record<string, unknown>
      : {};
    const startedAt = Date.now();
    const results = await runHooksWithReport(type, {
      dryRun: true,
      source: "api/hooks",
      ...payload,
    });
    return NextResponse.json({
      success: true,
      data: {
        type,
        elapsedMs: Date.now() - startedAt,
        hookCount: listHookFiles().length,
        results,
        ranAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
