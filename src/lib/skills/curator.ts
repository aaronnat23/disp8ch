import { getSqlite } from "@/lib/db";
import { logger } from "@/lib/utils/logger";

interface CuratorState {
  lastRunAt: string | null;
  lastRunResult: string | null;
  skillsReviewed: number;
  skillsPromoted: number;
  skillsArchived: number;
}

export function initSkillCurator() {
  if (typeof globalThis !== "undefined" && (globalThis as Record<string, unknown>).__disp8chSkillCurator) {
    return;
  }
  (globalThis as Record<string, unknown>).__disp8chSkillCurator = true;

  const runCycle = async () => {
    try {
      const db = getSqlite();

      // Guard: skip if skill_steward_state table doesn't exist yet (clean DB)
      const tableCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='skill_steward_state'").get() as { name: string } | undefined;
      if (!tableCheck) return;

      // Ensure curator state table exists
      db.exec(`
        CREATE TABLE IF NOT EXISTS skill_curator_state (
          key TEXT PRIMARY KEY,
          value TEXT
        )
      `);

      const getState = (): CuratorState => {
        const row = db.prepare("SELECT value FROM skill_curator_state WHERE key = 'curator'").get() as { value: string } | undefined;
        if (row) {
          try { return JSON.parse(row.value) as CuratorState; } catch { /* fall through */ }
        }
        return {
          lastRunAt: null,
          lastRunResult: null,
          skillsReviewed: 0,
          skillsPromoted: 0,
          skillsArchived: 0,
        };
      };

      const saveState = (state: CuratorState) => {
        db.prepare("INSERT OR REPLACE INTO skill_curator_state (key, value) VALUES ('curator', ?)").run(JSON.stringify(state));
      };

      const state = getState();
      const now = new Date().toISOString();

      // Only run every 30 minutes
      if (state.lastRunAt) {
        const elapsed = Date.now() - new Date(state.lastRunAt).getTime();
        if (elapsed < 30 * 60 * 1000) return;
      }

      // Find candidate skills that are stale (not updated in 7+ days, status=active but no workflow usage)
      const staleSkills = db.prepare(`
        SELECT skill_id, name, status, last_used_at, usage_count
        FROM skill_steward_state
        WHERE status = 'active'
          AND (last_used_at IS NULL OR last_used_at < datetime('now', '-7 days'))
          AND (usage_count IS NULL OR usage_count = 0)
        LIMIT 5
      `).all() as Array<{ skill_id: string; name: string; status: string; last_used_at: string | null; usage_count: number | null }>;

      let promoted = 0;
      let archived = 0;

      for (const skill of staleSkills) {
        // Auto-archive skills with no usage and no recent activity
        db.prepare(`
          UPDATE skill_steward_state
          SET status = 'stale', updated_at = datetime('now')
          WHERE skill_id = ?
        `).run(skill.skill_id);
        archived++;
      }

      // Find proposed/promoted skills that haven't been used in 14+ days and demote
      const unusedSkills = db.prepare(`
        SELECT skill_id, name, status, last_used_at, usage_count
        FROM skill_steward_state
        WHERE status IN ('proposed', 'promoted')
          AND (last_used_at IS NULL OR last_used_at < datetime('now', '-14 days'))
        LIMIT 5
      `).all() as Array<{ skill_id: string; name: string; status: string }>;

      for (const skill of unusedSkills) {
        db.prepare(`
          UPDATE skill_steward_state
          SET status = 'stale', updated_at = datetime('now')
          WHERE skill_id = ?
        `).run(skill.skill_id);
        archived++;
      }

      state.lastRunAt = now;
      state.lastRunResult = `Reviewed ${staleSkills.length + unusedSkills.length} skills: archived ${archived}`;
      state.skillsReviewed += staleSkills.length + unusedSkills.length;
      state.skillsArchived += archived;
      saveState(state);

      if (archived > 0) {
        logger.info("[skill-curator] Cycle complete", { archived, reviewed: staleSkills.length + unusedSkills.length });
      }
    } catch (err) {
      logger.error("[skill-curator] Cycle failed", { error: String(err) });
    }
  };

  // Run immediately, then every 5 minutes
  runCycle();
  setInterval(runCycle, 5 * 60 * 1000);
  logger.info("[skill-curator] initialized");
}
