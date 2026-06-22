type StartupGlobal = typeof globalThis & {
  __disp8chStartupPromise?: Promise<void>;
};

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const startupGlobal = globalThis as StartupGlobal;
    if (!startupGlobal.__disp8chStartupPromise) {
      startupGlobal.__disp8chStartupPromise = (async () => {
        const { initializeDatabase } = await import("@/lib/db");
        const { bootstrapChannelsFromEnv } = await import("@/lib/channels/runtime");
        const { initBackupManager } = await import("@/lib/backup/policy");
        const { initCronManager } = await import("@/lib/cron/manager");
        const { initHeartbeatManager } = await import("@/lib/governance/heartbeat");
        const { initStandingGoalDaemon } = await import("@/lib/goals/standing-goal-daemon");
        const { ensureHooksDirectory, runHooks } = await import("@/lib/hooks");
        const { getMemorySearchManager } = await import("@/lib/memory/manager");
        const { syncMCPServers } = await import("@/lib/mcp/registry");
        const { ensureExtensionRuntimeLoaded, runExtensionStartupHooks } = await import("@/lib/extensions/runtime");

        try {
          initializeDatabase();
          await ensureExtensionRuntimeLoaded();
          await bootstrapChannelsFromEnv();
          await syncMCPServers();
          initBackupManager();
          initCronManager();
          initStandingGoalDaemon();
          const { initDurableTurnWorker } = await import("@/lib/channels/turn-worker");
          initDurableTurnWorker();
          const { initSkillCurator } = await import("@/lib/skills/curator");
          initSkillCurator();
          initHeartbeatManager();
          try {
            const { recoverExecutionQueueOnBoot, drainWorkflowQueue } = await import("@/lib/engine/execution-queue");
            const recovered = recoverExecutionQueueOnBoot();
            for (const workflowId of recovered.workflowIds) {
              void drainWorkflowQueue(workflowId);
            }
          } catch {
            // Non-fatal: queue recovery retries on the next completion-driven drain.
          }
          ensureHooksDirectory();
          await getMemorySearchManager().ensureRuntimeStarted();
          await runExtensionStartupHooks();
          await runHooks("app.startup", { runtime: "nodejs" });
        } catch {
          // Non-fatal: cron init may fail if DB not ready yet
        }
      })();
    }
    await startupGlobal.__disp8chStartupPromise;
  }
}
