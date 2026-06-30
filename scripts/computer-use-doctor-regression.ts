/**
 * Computer-use doctor parsing regression (pure).
 *
 * Proves Phase 4 doctor normalization: pass, degraded, failed, and missing-driver
 * reports are classified correctly and a missing/unparseable driver is never
 * reported as pass.
 *
 * Run: pnpm exec tsx scripts/computer-use-doctor-regression.ts
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
  const { parseDoctorReport, buildMissingDriverReport, unwrapMcpCallResult } = await import("../src/lib/computer-use/doctor");

  console.log("\n[1] All-pass report");
  const pass = parseDoctorReport({
    driver: "/usr/bin/cua-driver",
    checks: [
      { name: "permissions", status: "pass", detail: "ok" },
      { name: "display", status: "pass", detail: "ok" },
    ],
  });
  check("overall pass", pass.overall === "pass");
  check("driver captured", pass.driver === "/usr/bin/cua-driver");

  console.log("\n[2] Degraded report (a warn present)");
  const degraded = parseDoctorReport({
    checks: [
      { name: "permissions", status: "pass" },
      { name: "accessibility", status: "warn", detail: "limited" },
    ],
  });
  check("overall degraded", degraded.overall === "degraded");

  console.log("\n[3] Failed report (a fail present)");
  const fail = parseDoctorReport({
    checks: [
      { name: "permissions", status: "fail", detail: "denied" },
      { name: "display", status: "pass" },
    ],
  });
  check("overall failed", fail.overall === "failed");

  console.log("\n[4] Flat boolean record");
  const flat = parseDoctorReport({ permissions: true, display: true, accessibility: false });
  check("flat record classified failed", flat.overall === "failed");
  check("flat record has checks", flat.checks.length === 3);

  console.log("\n[5] Cua 0.6.x probes payload");
  const probes = parseDoctorReport({
    ok: true,
    probes: [
      { label: "binary", status: "ok", message: "cua-driver 0.6.8" },
      { label: "interactive session", status: "warn", message: "desktop probe warning" },
      { label: "UI Automation", status: "ok", message: "ready" },
    ],
  });
  check("probes payload becomes degraded", probes.overall === "degraded", JSON.stringify(probes));
  check("probe labels are preserved", probes.checks.some((c) => c.name === "interactive session"));

  console.log("\n[6] Missing / unparseable never passes");
  const missing = buildMissingDriverReport("cua-driver not found");
  check("missing overall is missing", missing.overall === "missing");
  const empty = parseDoctorReport({});
  check("empty report not pass", empty.overall !== "pass");
  const garbage = parseDoctorReport("not an object");
  check("garbage report not pass", garbage.overall !== "pass");

  console.log("\n[7] MCP health_report unwrap (call output)");
  // MCP tool-result text content wrapping a JSON doctor payload.
  const mcpText = unwrapMcpCallResult(
    JSON.stringify({
      content: [{ type: "text", text: JSON.stringify({ ok: true, checks: [{ name: "display", status: "pass" }] }) }],
    }),
  );
  const mcpTextReport = parseDoctorReport(mcpText, "/usr/bin/cua-driver");
  check("mcp text-content health_report parses to pass", mcpTextReport.overall === "pass", JSON.stringify(mcpTextReport));
  // structuredContent wrapper.
  const mcpStructured = unwrapMcpCallResult({ structuredContent: { checks: [{ name: "permissions", status: "warn" }] } });
  check("mcp structuredContent unwraps to degraded", parseDoctorReport(mcpStructured).overall === "degraded");
  // result wrapper with a failing check.
  const mcpResult = unwrapMcpCallResult({ result: { checks: [{ name: "permissions", status: "fail" }] } });
  check("mcp result wrapper unwraps to failed", parseDoctorReport(mcpResult).overall === "failed");
  // Empty / unusable payloads return null so the caller falls back to CLI doctor.
  check("empty mcp payload returns null", unwrapMcpCallResult("") === null);
  check("non-json mcp text returns null", unwrapMcpCallResult("not json at all") === null);
  check("empty object mcp payload returns null", unwrapMcpCallResult({}) === null);
  // A bare already-shaped doctor object is passed through.
  const passthrough = unwrapMcpCallResult({ checks: [{ name: "display", status: "pass" }] });
  check("already-shaped doctor object passes through", parseDoctorReport(passthrough).overall === "pass");

  console.log("\n[8] Cua health_report platform skips are not failures");
  const windowsHealth = parseDoctorReport({
    overall: "ok",
    checks: [
      { name: "binary_version", status: "pass", message: "cua-driver 0.6.8" },
      { name: "bundle_identity", status: "skip", message: "not applicable on Windows" },
      { name: "tcc_accessibility", status: "skip", message: "not applicable on Windows" },
      { name: "ax_capability", status: "pass", message: "UIAutomation is reachable" },
    ],
  });
  check("skip checks keep healthy report passing", windowsHealth.overall === "pass", JSON.stringify(windowsHealth));

  const explicitFailed = parseDoctorReport({
    overall: "failed",
    checks: [{ name: "display", status: "pass" }],
  });
  check("explicit failed overall is respected", explicitFailed.overall === "failed", JSON.stringify(explicitFailed));

  console.log(`\ncomputer-use-doctor: ${passed}/${passed + failed} passed`);
  if (failed > 0) {
    console.error(`Failures: ${failures.join(", ")}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
