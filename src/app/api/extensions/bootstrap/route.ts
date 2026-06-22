import { NextResponse } from "next/server";
import { getSqlite } from "@/lib/db";
import { requireOperatorAccess } from "@/lib/security/admin";
import { getCached, API_TTL } from "@/lib/api-cache";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;

    const data = await getCached("extensions-bootstrap", async () => {
      const db = getSqlite();

      // ── extensions ────────────────────────────────────────────────────────
      let extTotal = 0;
      let extEnabled = 0;
      let extDisabled = 0;
      try {
        extTotal = (
          db
            .prepare("SELECT COUNT(*) AS c FROM extension_installs")
            .get() as { c: number }
        )?.c ?? 0;
      } catch {
        /* extension_installs table may not exist yet */
      }

      try {
        const {
          buildGlobalExtensionEntries,
        } = require("@/lib/extensions/state") as {
          buildGlobalExtensionEntries: () => Array<{
            globallyEnabled: boolean;
          }>;
        };
        const entries = buildGlobalExtensionEntries?.() ?? [];
        extTotal = Math.max(extTotal, entries.length);
        extEnabled = entries.filter((e) => e.globallyEnabled).length;
        extDisabled = entries.filter((e) => !e.globallyEnabled).length;
      } catch {
        /* extension state module may not be available */
      }

      // ── skills ────────────────────────────────────────────────────────────
      let skillTotal = 0;
      try {
        skillTotal = (
          db
            .prepare("SELECT COUNT(*) AS c FROM skill_steward_state")
            .get() as { c: number }
        )?.c ?? 0;
      } catch {
        /* skill_steward_state table may not exist yet */
      }

      return {
        extensions: { total: extTotal, enabled: extEnabled, disabled: extDisabled },
        skills: { total: skillTotal },
      };
    }, API_TTL.bootstrap);

    return NextResponse.json({ success: true, data });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: String(err) },
      { status: 500 },
    );
  }
}
