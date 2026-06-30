#!/usr/bin/env tsx

/**
 * Tool-evidence verifier regression (pure, deterministic).
 *
 * Proves a final answer cannot claim browser navigation or desktop computer use
 * without matching tool evidence in the turn, and that legitimate answers (real
 * tool events, or neutral capability descriptions) are left untouched.
 *
 * Run: pnpm exec tsx scripts/tool-evidence-verifier-regression.ts
 */
import { verifyToolEvidenceClaims } from "../src/lib/channels/tool-evidence-verifier";

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

console.log("\n[1] Unsupported browser claim is neutralized");
{
  const r = verifyToolEvidenceClaims(
    "I navigated to the GitHub issues page and found three open issues about the parser.",
    [],
  );
  check("flagged browser", r.flagged.includes("browser"), JSON.stringify(r.flagged));
  check("changed", r.changed);
  check("claim sentence removed", !/I navigated to the GitHub issues page/i.test(r.answer), r.answer);
  check("honest disclaimer appended", /could not verify this with browser tools/i.test(r.answer), r.answer);
}

console.log("\n[2] Browser claim WITH evidence is preserved");
{
  const original = "I navigated to the issues page and found three open issues.";
  const r = verifyToolEvidenceClaims(original, ["browser_navigate", "browser_snapshot"]);
  check("not changed", !r.changed && r.answer === original);
  check("nothing flagged", r.flagged.length === 0);
}

console.log("\n[3] Screenshot claim without evidence is neutralized");
{
  const r = verifyToolEvidenceClaims("I took a screenshot of the dashboard to confirm.", []);
  check("flagged browser for screenshot", r.flagged.includes("browser"));
  check("screenshot claim removed", !/took a screenshot/i.test(r.answer), r.answer);
}

console.log("\n[4] Neutral capability description is NOT touched");
{
  const original =
    "You can browse the web with the browser tool, and computer use can click on your desktop once enabled.";
  const r = verifyToolEvidenceClaims(original, []);
  check("neutral description unchanged", !r.changed && r.answer === original, r.answer);
}

console.log("\n[5] Unsupported computer-use claim is neutralized");
{
  const r = verifyToolEvidenceClaims(
    "I clicked the Submit button on your desktop and the form was sent.",
    ["read_file"],
  );
  check("flagged computer_use", r.flagged.includes("computer_use"), JSON.stringify(r.flagged));
  check("desktop claim removed", !/clicked the Submit button on your desktop/i.test(r.answer), r.answer);
  check("computer disclaimer appended", /could not verify this with computer-use tools/i.test(r.answer), r.answer);
}

console.log("\n[6] Computer claim WITH evidence preserved");
{
  const original = "I observed the active window and reported the app title.";
  const r = verifyToolEvidenceClaims(original, ["computer_observe"]);
  check("computer claim with evidence kept", !r.changed && r.answer === original);
}

console.log("\n[7] Mixed answer keeps grounded prose, drops only the claim");
{
  const r = verifyToolEvidenceClaims(
    "Here is a summary of the repository. I opened the website to confirm the docs link. The README lists three steps.",
    ["read_file", "search_files"],
  );
  check("kept repo summary", /summary of the repository/i.test(r.answer));
  check("kept README sentence", /README lists three steps/i.test(r.answer));
  check("dropped website claim", !/I opened the website/i.test(r.answer), r.answer);
}

console.log("\n[8] Empty answer is a no-op");
{
  const r = verifyToolEvidenceClaims("", []);
  check("empty no-op", !r.changed && r.answer === "" && r.flagged.length === 0);
}

console.log("\n[9] Raw URL browser claim without evidence is neutralized");
{
  const r = verifyToolEvidenceClaims("I opened https://example.com/docs and checked the setup page.", []);
  check("flagged browser for raw URL", r.flagged.includes("browser"), JSON.stringify(r.flagged));
  check("raw URL claim removed", !/opened https:\/\/example\.com\/docs/i.test(r.answer), r.answer);
}

console.log(`\ntool-evidence-verifier: ${passed}/${passed + failed} passed`);
if (failed > 0) {
  console.error(`Failures: ${failures.join(", ")}`);
  process.exit(1);
}
