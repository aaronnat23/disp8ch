import { logger } from "@/lib/utils/logger";
import { runStandingGoalDaemonTick } from "@/lib/goals/standing-goals";

const log = logger.child("goals:standing-daemon");

type StandingGoalDaemonGlobal = typeof globalThis & {
  __disp8chStandingGoalDaemon?: {
    timer: ReturnType<typeof setInterval> | null;
    running: boolean;
    lastTickAt: string | null;
    lastProcessedTasks: number;
    lastError: string | null;
  };
};

const daemonGlobal = globalThis as StandingGoalDaemonGlobal;
const state = daemonGlobal.__disp8chStandingGoalDaemon ?? {
  timer: null,
  running: false,
  lastTickAt: null,
  lastProcessedTasks: 0,
  lastError: null,
};
daemonGlobal.__disp8chStandingGoalDaemon = state;

function readIntervalMs(): number {
  const raw = Number(process.env.DISP8CH_STANDING_GOAL_TICK_MS || 60_000);
  if (!Number.isFinite(raw)) return 60_000;
  return Math.max(15_000, Math.min(10 * 60_000, Math.floor(raw)));
}

function daemonEnabled(): boolean {
  const raw = String(process.env.DISP8CH_STANDING_GOAL_DAEMON ?? "1").trim().toLowerCase();
  return !["0", "false", "off", "disabled", "no"].includes(raw);
}

async function tickOnce(): Promise<void> {
  if (state.running) return;
  state.running = true;
  state.lastTickAt = new Date().toISOString();
  try {
    const result = await runStandingGoalDaemonTick({
      maxTasks: 1,
      workerId: "standing-goal-daemon",
      workspacePath: process.cwd(),
    });
    state.lastProcessedTasks = result.processedTasks;
    state.lastError = null;
    if (!result.idle || result.warnings?.length) {
      log.info("Standing-goal daemon tick complete", {
        processedTasks: result.processedTasks,
        scannedGoals: result.scannedGoals,
        scannedTasks: result.scannedTasks,
        warnings: result.warnings?.length ?? 0,
      });
    }
  } catch (err) {
    state.lastError = err instanceof Error ? err.message : String(err);
    log.warn("Standing-goal daemon tick failed", { error: state.lastError });
  } finally {
    state.running = false;
  }
}

export function initStandingGoalDaemon(): void {
  stopStandingGoalDaemon();
  if (!daemonEnabled()) {
    log.info("Standing-goal daemon disabled");
    return;
  }
  const intervalMs = readIntervalMs();
  state.timer = setInterval(() => {
    void tickOnce();
  }, intervalMs);
  log.info("Standing-goal daemon initialized", { intervalMs });
}

export function stopStandingGoalDaemon(): void {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
}

export function getStandingGoalDaemonStatus() {
  return {
    enabled: daemonEnabled(),
    scheduled: Boolean(state.timer),
    running: state.running,
    lastTickAt: state.lastTickAt,
    lastProcessedTasks: state.lastProcessedTasks,
    lastError: state.lastError,
    intervalMs: readIntervalMs(),
  };
}

export const __standingGoalDaemonTestHooks = {
  tickOnce,
  readIntervalMs,
  daemonEnabled,
};
