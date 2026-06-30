/**
 * Computer-use capability state regression (temp DB, no driver).
 *
 * Proves Phase 4 capability honesty:
 *  - computer use is implemented but disabled by default,
 *  - enabling without an installed driver stays not-ready (honest reason),
 *  - the capability never reports ready while disabled or uninstalled,
 *  - the global capability state reflects the same computer_use entry.
 *
 * Run: pnpm exec tsx scripts/computer-use-capability-regression.ts
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const tmp = path.join(os.tmpdir(), `disp8ch_cu_cap_${Date.now()}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.DATABASE_PATH = path.join(tmp, "cu.db");
process.env.MEMORY_PATH = path.join(tmp, "memories");
process.env.WORKSPACE_PATH = path.join(tmp, "workspace");
// Ensure no driver override leaks in.
delete process.env.DISP8CH_CUA_DRIVER_CMD;

let passed = 0,
  failed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {
  const { initializeDatabase } = await import("../src/lib/db");
  const { getComputerUseCapability, computerUseEnabled } = await import("../src/lib/computer-use/adapter");
  const { getCapabilityState } = await import("../src/lib/capabilities/capability-state");

  initializeDatabase();

  console.log("\n[1] Disabled by default");
  delete process.env.DISP8CH_ENABLE_COMPUTER_USE;
  check("not enabled by default", !computerUseEnabled());
  const disabled = await getComputerUseCapability();
  const disabledCached = await getComputerUseCapability();
  check("implemented true (code exists)", disabled.implemented);
  check("not ready when disabled", !disabled.ready);
  check("reason mentions enabling", /enable/i.test(disabled.reason));
  check("unchanged readiness probe reuses bounded cache", disabledCached === disabled);

  // The assertions below must hold whether or not a real Cua driver happens to
  // be installed on the host (a dev machine may have one on PATH; CI usually
  // does not). We branch on the honestly-reported install state instead of
  // assuming "no driver", so the capability-honesty invariants are verified in
  // both environments.
  console.log("\n[2] Enabled → readiness is honest about the installed driver");
  process.env.DISP8CH_ENABLE_COMPUTER_USE = "1";
  const enabled = await getComputerUseCapability();
  check("enablement change invalidates capability cache key", enabled !== disabled);
  check("enabled flag true", enabled.enabled);
  if (!enabled.installed) {
    check("not configured without driver", !enabled.configured);
    check("not ready without driver", !enabled.ready);
    check("reason mentions install", /install/i.test(enabled.reason));
  } else {
    console.log("  (a real cua-driver is installed on this host)");
    check("configured when driver installed", enabled.configured);
    check(
      "ready only when doctor passes or is accepted-degraded",
      !enabled.ready || enabled.doctorStatus === "pass" || enabled.doctorStatus === "degraded",
      `doctor=${enabled.doctorStatus} ready=${enabled.ready}`,
    );
    check("reason is a non-empty honest statement", enabled.reason.trim().length > 0);
  }

  console.log("\n[3] Never ready while not configured");
  check("ready implies configured", !enabled.ready || enabled.configured);

  console.log("\n[4] Global capability state reflects computer_use");
  const state = await getCapabilityState();
  const entry = state.capabilities.computer_use;
  check("computer_use entry present", Boolean(entry));
  check("entry implemented", entry.implemented === true);
  check("entry not ready unless a driver is configured", entry.ready === false || enabled.installed);

  delete process.env.DISP8CH_ENABLE_COMPUTER_USE;
  console.log(`\ncomputer-use-capability: ${passed}/${passed + failed} passed`);
  if (failed > 0) {
    console.error(`Failures: ${failures.join(", ")}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
