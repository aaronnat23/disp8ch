import { getSqlite, initializeDatabase } from "@/lib/db";
import { logger } from "@/lib/utils/logger";

const log = logger.child("execution-lanes");

export type WorkflowExecutionLane = "main" | "cron" | "subflow";

type TriggerType = "message" | "webhook" | "manual" | "cron";

type LaneConfig = Record<WorkflowExecutionLane, number>;

type QueueEntry<T> = {
  task: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  enqueuedAt: number;
  warnAfterMs: number;
  workflowId?: string;
  triggerType?: string;
};

type LaneState = {
  lane: WorkflowExecutionLane;
  maxConcurrent: number;
  activeCount: number;
  queue: Array<QueueEntry<any>>;
  draining: boolean;
};

const DEFAULT_LANE_CONCURRENCY: LaneConfig = {
  main: 4,
  cron: 1,
  subflow: 8,
};

const MAX_LANE_CONCURRENCY: LaneConfig = {
  main: 32,
  cron: 16,
  subflow: 64,
};

const LANE_CONFIG_CACHE_MS = 5000;

const lanes = new Map<WorkflowExecutionLane, LaneState>();
let cachedConfig: LaneConfig = { ...DEFAULT_LANE_CONCURRENCY };
let cachedConfigAt = 0;

function clampConcurrency(
  lane: WorkflowExecutionLane,
  value: unknown,
): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_LANE_CONCURRENCY[lane];
  const rounded = Math.floor(numeric);
  if (rounded < 1) return 1;
  return Math.min(rounded, MAX_LANE_CONCURRENCY[lane]);
}

function getLaneState(lane: WorkflowExecutionLane): LaneState {
  const existing = lanes.get(lane);
  if (existing) return existing;
  const created: LaneState = {
    lane,
    maxConcurrent: cachedConfig[lane],
    activeCount: 0,
    queue: [],
    draining: false,
  };
  lanes.set(lane, created);
  return created;
}

function readLaneConfigFromDb(): LaneConfig {
  try {
    initializeDatabase();
    const db = getSqlite();
    const row = db
      .prepare(
        "SELECT lane_main_max_concurrent, lane_cron_max_concurrent, lane_subflow_max_concurrent FROM app_config WHERE id = 'default'",
      )
      .get() as
      | {
          lane_main_max_concurrent?: number | null;
          lane_cron_max_concurrent?: number | null;
          lane_subflow_max_concurrent?: number | null;
        }
      | undefined;

    return {
      main: clampConcurrency("main", row?.lane_main_max_concurrent),
      cron: clampConcurrency("cron", row?.lane_cron_max_concurrent),
      subflow: clampConcurrency("subflow", row?.lane_subflow_max_concurrent),
    };
  } catch {
    return { ...DEFAULT_LANE_CONCURRENCY };
  }
}

function applyLaneConfig(config: LaneConfig): void {
  cachedConfig = config;
  cachedConfigAt = Date.now();
  const laneNames: WorkflowExecutionLane[] = ["main", "cron", "subflow"];
  for (const lane of laneNames) {
    const state = getLaneState(lane);
    state.maxConcurrent = config[lane];
  }
}

function refreshLaneConfigIfNeeded(force = false): void {
  const now = Date.now();
  if (!force && now - cachedConfigAt < LANE_CONFIG_CACHE_MS) {
    return;
  }
  applyLaneConfig(readLaneConfigFromDb());
}

function drainLane(lane: WorkflowExecutionLane): void {
  const state = getLaneState(lane);
  if (state.draining) return;
  state.draining = true;

  const pump = () => {
    try {
      while (state.activeCount < state.maxConcurrent && state.queue.length > 0) {
        const entry = state.queue.shift() as QueueEntry<any>;
        state.activeCount += 1;
        const waitedMs = Date.now() - entry.enqueuedAt;
        if (waitedMs >= entry.warnAfterMs) {
          log.warn("Lane wait exceeded", {
            lane,
            waitedMs,
            queuedAhead: state.queue.length,
            workflowId: entry.workflowId,
            triggerType: entry.triggerType,
          });
        }

        void (async () => {
          try {
            const result = await entry.task();
            entry.resolve(result);
          } catch (error) {
            entry.reject(error);
          } finally {
            state.activeCount = Math.max(0, state.activeCount - 1);
            pump();
          }
        })();
      }
    } finally {
      state.draining = false;
    }
  };

  pump();
}

export function resolveExecutionLane(triggerType: TriggerType): WorkflowExecutionLane {
  if (triggerType === "cron") return "cron";
  return "main";
}

export function enqueueExecutionInLane<T>(
  lane: WorkflowExecutionLane,
  task: () => Promise<T>,
  opts?: {
    warnAfterMs?: number;
    workflowId?: string;
    triggerType?: string;
  },
): Promise<T> {
  refreshLaneConfigIfNeeded();
  const state = getLaneState(lane);
  return new Promise<T>((resolve, reject) => {
    state.queue.push({
      task,
      resolve,
      reject,
      enqueuedAt: Date.now(),
      warnAfterMs: opts?.warnAfterMs ?? 2500,
      workflowId: opts?.workflowId,
      triggerType: opts?.triggerType,
    });
    drainLane(lane);
  });
}

export type ExecutionLaneSnapshot = {
  lane: WorkflowExecutionLane;
  maxConcurrent: number;
  active: number;
  queued: number;
};

function readActiveLaneCountsFromDb(): Record<WorkflowExecutionLane, number> {
  const counts: Record<WorkflowExecutionLane, number> = {
    main: 0,
    cron: 0,
    subflow: 0,
  };
  try {
    initializeDatabase();
    const db = getSqlite();
    const rows = db
      .prepare("SELECT lane, COUNT(*) AS count FROM running_executions GROUP BY lane")
      .all() as Array<{ lane: string; count: number }>;
    for (const row of rows) {
      const lane = String(row.lane || "");
      if (lane === "main" || lane === "cron" || lane === "subflow") {
        counts[lane] = Number(row.count || 0);
      }
    }
  } catch {
    // best effort only
  }
  return counts;
}

export function listExecutionLaneSnapshots(): ExecutionLaneSnapshot[] {
  refreshLaneConfigIfNeeded();
  const dbActive = readActiveLaneCountsFromDb();
  const laneNames: WorkflowExecutionLane[] = ["main", "cron", "subflow"];
  return laneNames.map((lane) => {
    const state = getLaneState(lane);
    return {
      lane,
      maxConcurrent: state.maxConcurrent,
      active: dbActive[lane],
      queued: state.queue.length,
    };
  });
}
