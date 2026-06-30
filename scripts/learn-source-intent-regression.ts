/**
 * Learn-source intent detection regression (pure, no DB/model).
 *
 * Proves the WebChat learn-from-source detector (Phase 3):
 *  - explicit "/learn from <id>" and "learn the document <id> as a skill" match,
 *  - notebook + folder requests are recognized,
 *  - reference id extraction works,
 *  - ordinary chat is NOT hijacked.
 *
 * Run: pnpm exec tsx scripts/learn-source-intent-regression.ts
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
  const { detectLearnSourceIntent } = await import("../src/lib/channels/learn-source-intent");

  console.log("\n[1] Explicit slash command matches and extracts ref");
  const a = detectLearnSourceIntent("/learn from document doc-12345");
  check("slash matched", a.matched);
  check("ref extracted", a.rawRef === "doc-12345", `got ${a.rawRef}`);
  check("not a notebook", !a.notebook);

  console.log("\n[2] id: form");
  const b = detectLearnSourceIntent("/learn from source id: abc-9988");
  check("id form matched", b.matched && b.rawRef === "abc-9988", `got ${b.rawRef}`);

  console.log("\n[3] Notebook NL form");
  const c = detectLearnSourceIntent("learn the notebook nb-777 as a reusable skill please");
  check("notebook NL matched", c.matched);
  check("notebook flag set", c.notebook);
  check("notebook ref extracted", c.rawRef === "nb-777", `got ${c.rawRef}`);

  console.log("\n[4] Folder request flagged");
  const d = detectLearnSourceIntent("/learn this folder C:/docs/api as a skill");
  check("folder matched", d.matched);
  check("folder flag set", d.folderRequested);

  console.log("\n[5] Ordinary chat is NOT hijacked");
  const e = detectLearnSourceIntent("How do I learn React as a skill for my career?");
  check("ordinary chat not matched", !e.matched);
  const f = detectLearnSourceIntent("Summarize the latest AI news");
  check("unrelated chat not matched", !f.matched);

  console.log("\n[6] NL with document keyword matches");
  const g = detectLearnSourceIntent('learn the document "Acme API" as a reusable skill');
  check("NL document matched", g.matched);
  check("quoted ref extracted", g.rawRef === "Acme API", `got ${g.rawRef}`);

  console.log(`\nlearn-source-intent: ${passed}/${passed + failed} passed`);
  if (failed > 0) {
    console.error(`Failures: ${failures.join(", ")}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
