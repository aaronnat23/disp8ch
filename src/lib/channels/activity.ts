type AsyncAction = () => Promise<void>;

export type ChannelActivityController = {
  run: <T>(task: () => Promise<T>) => Promise<T>;
};

export function createChannelActivityController(params: {
  label: string;
  start: AsyncAction;
  stop?: AsyncAction;
  keepaliveMs?: number;
  maxConsecutiveFailures?: number;
  maxDurationMs?: number;
  onStartFailure?: (error: unknown, failureCount: number) => void;
  onStopFailure?: (error: unknown) => void;
}): ChannelActivityController {
  const keepaliveMs = Math.max(0, params.keepaliveMs ?? 0);
  const maxConsecutiveFailures = Math.max(1, params.maxConsecutiveFailures ?? 2);
  const maxDurationMs = Math.max(0, params.maxDurationMs ?? 90_000);

  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  let ttlTimer: ReturnType<typeof setTimeout> | null = null;
  let startInFlight = false;
  let closed = false;
  let stopSent = false;
  let failureCount = 0;

  const clearTimers = () => {
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
    if (ttlTimer) {
      clearTimeout(ttlTimer);
      ttlTimer = null;
    }
  };

  const fireStart = async () => {
    if (closed || startInFlight) {
      return;
    }
    startInFlight = true;
    try {
      await params.start();
      failureCount = 0;
    } catch (error) {
      failureCount += 1;
      params.onStartFailure?.(error, failureCount);
      if (failureCount >= maxConsecutiveFailures) {
        clearTimers();
      }
    } finally {
      startInFlight = false;
    }
  };

  const fireStop = async () => {
    clearTimers();
    closed = true;
    if (!params.stop || stopSent) {
      return;
    }
    stopSent = true;
    try {
      await params.stop();
    } catch (error) {
      params.onStopFailure?.(error);
    }
  };

  const armTimers = () => {
    if (keepaliveMs > 0 && failureCount < maxConsecutiveFailures && !keepaliveTimer) {
      keepaliveTimer = setInterval(() => {
        void fireStart();
      }, keepaliveMs);
    }
    if (maxDurationMs > 0 && !ttlTimer) {
      ttlTimer = setTimeout(() => {
        void fireStop();
      }, maxDurationMs);
    }
  };

  return {
    run: async <T>(task: () => Promise<T>) => {
      clearTimers();
      closed = false;
      stopSent = false;
      failureCount = 0;
      await fireStart();
      armTimers();
      try {
        return await task();
      } finally {
        await fireStop();
      }
    },
  };
}
