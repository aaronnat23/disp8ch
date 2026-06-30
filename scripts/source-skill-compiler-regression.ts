/**
 * Source-skill compiler regression (temp DB + fixture pack + mocked model output).
 *
 * Proves Phase 2 verification + candidate gating WITHOUT calling an LLM:
 *  - a grounded, verified candidate becomes a PENDING proposal (not installed),
 *  - the candidate carries source-pack provenance + verification checks,
 *  - an invented URL not in the sources fails verification (no candidate),
 *  - a secret-bearing skill fails verification,
 *  - a skill with no verification check fails verification.
 *
 * Run: pnpm exec tsx scripts/source-skill-compiler-regression.ts
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const tmp = path.join(os.tmpdir(), `disp8ch_source_skill_${Date.now()}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.DATABASE_PATH = path.join(tmp, "skill.db");
process.env.MEMORY_PATH = path.join(tmp, "memories");
process.env.WORKSPACE_PATH = path.join(tmp, "workspace");

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

const GOOD_MARKDOWN = `---
name: example-api
description: Call the Example API safely with setup and verification.
---
# Example API

## Setup
Set BASE_URL and call https://api.example.com/v1/things to list things.

## Common calls
GET https://api.example.com/v1/things returns the collection.

## Verification
Run: curl https://api.example.com/v1/things and confirm a 200 response.
`;

async function main() {
  const { initializeDatabase } = await import("../src/lib/db");
  const { buildSourcePackFromFolder } = await import("../src/lib/source-packs/build");
  const { finalizeSourceSkillCandidate } = await import("../src/lib/learning/source-skill-compiler");
  const { getSelfImprovementProposal } = await import("../src/lib/channels/self-improvement-proposals");

  initializeDatabase();

  // Fixture folder grounded with the endpoint the good skill references.
  const fixture = path.join(tmp, "api-docs");
  fs.mkdirSync(fixture, { recursive: true });
  fs.writeFileSync(
    path.join(fixture, "README.md"),
    "# Example API\n\nSet BASE_URL. Call https://api.example.com/v1/things to list things.\n",
  );
  const built = buildSourcePackFromFolder({ name: "Example API docs", folderPath: fixture });

  console.log("\n[1] Grounded + verified candidate becomes a pending proposal");
  const good = finalizeSourceSkillCandidate({
    sourcePackId: built.pack.id,
    sessionId: "test-good",
    compiled: {
      skill_name: "example-api",
      title: "Example API",
      description: "Call the Example API safely with setup and verification.",
      skill_markdown: GOOD_MARKDOWN,
      verification_commands: ["curl https://api.example.com/v1/things"],
      source_evidence: [{ section: "Setup", sources: ["README.md"] }],
      uncertainties: ["rate limits"],
    },
  });
  check("verification passed", good.verification.passed, good.verification.failures.join("; "));
  check("candidate proposal created", Boolean(good.proposal));
  check("candidate is pending (not installed)", good.proposal?.status === "pending");
  check("candidate carries source pack provenance", good.proposal?.sourcePackId === built.pack.id);
  check("candidate stores verification checks", (good.proposal?.verification?.checks?.length ?? 0) > 0);
  check("evidence links back to source pack", (good.proposal?.evidence ?? []).some((e) => e.includes(built.pack.id)));

  console.log("\n[2] Not installed: no skill written to workspace yet");
  const skillsDir = path.join(tmp, "workspace", "skills");
  const installedBefore = fs.existsSync(skillsDir) ? fs.readdirSync(skillsDir) : [];
  check("no installed skill dir before approval", installedBefore.every((d) => !d.startsWith("proposed-example-api")));

  console.log("\n[3] Invented URL not in sources fails verification");
  const invented = finalizeSourceSkillCandidate({
    sourcePackId: built.pack.id,
    sessionId: "test-invented",
    compiled: {
      skill_name: "example-api",
      title: "Example API",
      description: "Call the API.",
      skill_markdown: GOOD_MARKDOWN.replace(
        "https://api.example.com/v1/things",
        "https://totally-made-up-endpoint.invalid/secret",
      ),
      verification_commands: ["curl x"],
      source_evidence: [{ section: "Setup", sources: ["README.md"] }],
    },
  });
  check("invented-URL candidate fails verification", !invented.verification.passed);
  check("invented-URL candidate creates no proposal", invented.proposal === null);
  check("grounded_urls check failed", invented.verification.checks.some((c) => c.startsWith("FAIL grounded_urls")));

  console.log("\n[4] Secret-bearing skill fails verification");
  const secret = finalizeSourceSkillCandidate({
    sourcePackId: built.pack.id,
    sessionId: "test-secret",
    compiled: {
      skill_name: "example-api",
      title: "Example API",
      description: "Call the API.",
      skill_markdown: `${GOOD_MARKDOWN}\nUse key ${["sk", "abcd1234efgh5678ijkl"].join("-")} to authenticate.`,
      verification_commands: ["curl https://api.example.com/v1/things"],
      source_evidence: [{ section: "Setup", sources: ["README.md"] }],
    },
  });
  check("secret candidate fails verification", !secret.verification.passed);
  check("secret candidate creates no proposal", secret.proposal === null);

  console.log("\n[5] Missing verification check fails");
  const noVerify = finalizeSourceSkillCandidate({
    sourcePackId: built.pack.id,
    sessionId: "test-noverify",
    compiled: {
      skill_name: "example-api",
      title: "Example API",
      description: "Call the API.",
      skill_markdown: `---\nname: example-api\ndescription: Call the API.\n---\n# Example API\n\n## Setup\nCall https://api.example.com/v1/things\n`,
      source_evidence: [{ section: "Setup", sources: ["README.md"] }],
    },
  });
  check("no-verification candidate fails", !noVerify.verification.passed);
  check("has_verification check failed", noVerify.verification.checks.some((c) => c.startsWith("FAIL has_verification")));

  void getSelfImprovementProposal;
  console.log(`\nsource-skill-compiler: ${passed}/${passed + failed} passed`);
  if (failed > 0) {
    console.error(`Failures: ${failures.join(", ")}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
