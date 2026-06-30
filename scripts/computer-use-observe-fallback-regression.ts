/**
 * Computer-use observe fallback regression.
 *
 * Proves observe-only desktop calls can report a read-only active-window
 * fallback when Cua returns no OCR text. This is pure and does not control the
 * desktop.
 */
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
  const { appendActiveWindowSummary, mergeObservationWithActiveWindow, observationLooksEmpty } = await import("../src/lib/computer-use/observe-fallback");

  console.log("\n[1] Empty observation detection");
  check("null is empty", observationLooksEmpty(null));
  check("no text marker is empty", observationLooksEmpty("(no text observed)"));
  check("real OCR text is not empty", !observationLooksEmpty("Settings - Computer Use"));

  console.log("\n[2] Fallback merge");
  const merged = mergeObservationWithActiveWindow("(no text observed)", { app: "Chrome", title: "disp8ch - Settings" });
  check("fallback includes active window", /Chrome - disp8ch - Settings/.test(merged ?? ""), String(merged));
  check("fallback says OCR was missing", /did not return visible OCR text/i.test(merged ?? ""), String(merged));

  console.log("\n[3] Real observation wins");
  const real = mergeObservationWithActiveWindow("Visible button: Run doctor", { app: "Chrome", title: "ignored" });
  check("real text is preserved", real === "Visible button: Run doctor", String(real));
  const appended = appendActiveWindowSummary("Visible windows:\n1. Chrome", { app: "Chrome", title: "disp8ch" });
  check("foreground title is appended to real tree", /^Foreground window: Chrome - disp8ch/.test(appended ?? ""), String(appended));

  console.log("\n[4] No fallback stays honest");
  const none = mergeObservationWithActiveWindow("(no text observed)", null);
  check("empty marker preserved when no fallback exists", none === "(no text observed)", String(none));

  console.log(`\ncomputer-use-observe-fallback: ${passed}/${passed + failed} passed`);
  if (failed > 0) {
    console.error(`Failures: ${failures.join(", ")}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
