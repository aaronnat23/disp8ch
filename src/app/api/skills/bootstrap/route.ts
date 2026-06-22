import { NextResponse } from "next/server";
import { getSqlite } from "@/lib/db";
import { requireOperatorAccess } from "@/lib/security/admin";
import { getCached, API_TTL } from "@/lib/api-cache";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;

    const data = await getCached("skills-bootstrap", async () => {
      const db = getSqlite();

      // ── skill steward state ───────────────────────────────────────────────
      let skillsTotal = 0;
      try {
        skillsTotal = (
          db
            .prepare("SELECT COUNT(*) AS c FROM skill_steward_state")
            .get() as { c: number }
        )?.c ?? 0;
      } catch {
        /* skill_steward_state table may not exist yet */
      }

      // ── skill breakdown by source ─────────────────────────────────────────
      let bundled = 0;
      let optional = 0;
      let workspace = 0;
      let external = 0;
      try {
        const {
          listInstalledSkillCatalog,
        } = require("@/lib/extensions/registry") as {
          listInstalledSkillCatalog: () => Array<{
            source: string;
          }>;
        };
        const catalog = listInstalledSkillCatalog?.() ?? [];
        for (const skill of catalog) {
          switch (skill.source) {
            case "core":
            case "optional":
              if (skill.source === "optional") optional += 1;
              else bundled += 1;
              break;
            case "workspace":
              workspace += 1;
              break;
            case "agent":
              bundled += 1;
              break;
            case "extension":
            case "external":
              external += 1;
              break;
          }
        }
        // Use catalog length as total if larger than steward count
        if (catalog.length > skillsTotal) {
          skillsTotal = catalog.length;
        }
      } catch {
        /* skill registry may not be available */
      }

      // ── extensions ────────────────────────────────────────────────────────
      let extTotal = 0;
      let extEnabled = 0;
      try {
        extTotal = (
          db
            .prepare("SELECT COUNT(*) AS c FROM extension_installs")
            .get() as { c: number }
        )?.c ?? 0;

        try {
          const {
            buildGlobalExtensionEntries,
          } = require("@/lib/extensions/state") as {
            buildGlobalExtensionEntries: () => Array<{
              globallyEnabled: boolean;
            }>;
          };
          const entries = buildGlobalExtensionEntries?.() ?? [];
          extEnabled = entries.filter((e) => e.globallyEnabled).length;
        } catch {
          /* extension state module may not be available */
        }
      } catch {
        /* extension_installs table may not exist yet */
      }

      return {
        skills: { total: skillsTotal, bundled, optional, workspace, external },
        extensions: { total: extTotal, enabled: extEnabled },
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
