import { NextResponse } from "next/server";
import { getSqlite } from "@/lib/db";
import { getCached, API_TTL } from "@/lib/api-cache";
import { requireOperatorAccess } from "@/lib/security/admin";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;
  try {
    const data = await getCached("maintenance-bootstrap", async () => {
      const db = getSqlite();

      let hooks = { enabled: false, count: 0 };
      try {
        const configRow = db
          .prepare("SELECT hooks_enabled FROM app_config WHERE id = 'default'")
          .get() as { hooks_enabled?: number | null } | undefined;
        hooks.enabled = (configRow?.hooks_enabled ?? 1) !== 0;

        try {
          hooks.count = (
            db
              .prepare("SELECT COUNT(*) AS c FROM hook_events")
              .get() as { c: number }
          )?.c ?? 0;
        } catch {
          /* hook_events table may not exist yet */
        }
      } catch {
        /* app_config table may not exist yet */
      }

      let backup = {
        lastRunAt: null as string | null,
        policyEnabled: false,
      };
      try {
        const configRow = db
          .prepare(
            "SELECT backup_enabled, backup_last_run_at FROM app_config WHERE id = 'default'",
          )
          .get() as
          | { backup_enabled?: number | null; backup_last_run_at?: string | null }
          | undefined;
        backup.policyEnabled =
          (configRow?.backup_enabled ?? 0) === 1;
        backup.lastRunAt =
          String(configRow?.backup_last_run_at || "").trim() || null;
      } catch {
        /* app_config may not exist yet */
      }

      let learning = { mode: "review" };
      try {
        const configRow = db
          .prepare(
            "SELECT learning_mode FROM app_config WHERE id = 'default'",
          )
          .get() as { learning_mode?: string | null } | undefined;
        const raw = String(configRow?.learning_mode ?? "review")
          .trim()
          .toLowerCase();
        learning.mode = ["off", "review", "auto"].includes(raw)
          ? raw
          : "review";
      } catch {
        /* app_config may not exist yet */
      }

      let skills = { curated: 0, stale: 0 };
      try {
        skills.curated = (
          db
            .prepare(
              "SELECT COUNT(*) AS c FROM skill_steward_state WHERE status IN ('active','proposed','promoted')",
            )
            .get() as { c: number }
        )?.c ?? 0;

        skills.stale = (
          db
            .prepare(
              "SELECT COUNT(*) AS c FROM skill_steward_state WHERE status = 'stale'",
            )
            .get() as { c: number }
        )?.c ?? 0;
      } catch {
        /* skill_steward_state table may not exist yet */
      }

      return { hooks, backup, learning, skills };
    }, API_TTL.bootstrap);

    return NextResponse.json({ success: true, data });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: String(err) },
      { status: 500 },
    );
  }
}
