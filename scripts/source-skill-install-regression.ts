/**
 * Source-skill install regression (temp DB + fixture pack + mocked output).
 *
 * Proves Phase 2 review-first install:
 *  - a pending candidate is NOT installed until explicitly applied,
 *  - applying installs a SKILL.md plus support files into the workspace,
 *  - provenance.json points back to the originating source pack,
 *  - the candidate status becomes applied.
 *
 * Run: pnpm exec tsx scripts/source-skill-install-regression.ts
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const tmp = path.join(os.tmpdir(), `disp8ch_source_skill_install_${Date.now()}`);
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

const MARKDOWN = `---
name: example-api
description: Call the Example API safely with setup and verification.
---
# Example API

## Setup
Call https://api.example.com/v1/things to list things.

## Verification
Run: curl https://api.example.com/v1/things and confirm a 200.
`;

async function main() {
  const { initializeDatabase } = await import("../src/lib/db");
  const { buildSourcePackFromFolder } = await import("../src/lib/source-packs/build");
  const { finalizeSourceSkillCandidate } = await import("../src/lib/learning/source-skill-compiler");
  const { applySelfImprovementProposal, getSelfImprovementProposal } = await import(
    "../src/lib/channels/self-improvement-proposals"
  );
  const { getWorkspaceDir } = await import("../src/lib/workspace/files");

  initializeDatabase();
  const fixture = path.join(tmp, "api-docs");
  fs.mkdirSync(fixture, { recursive: true });
  fs.writeFileSync(
    path.join(fixture, "README.md"),
    "# Example API\n\nCall https://api.example.com/v1/things to list things.\n",
  );
  const built = buildSourcePackFromFolder({ name: "Example API docs", folderPath: fixture });

  const candidate = finalizeSourceSkillCandidate({
    sourcePackId: built.pack.id,
    sessionId: "install-test",
    compiled: {
      skill_name: "example-api",
      title: "Example API",
      description: "Call the Example API safely with setup and verification.",
      skill_markdown: MARKDOWN,
      verification_commands: ["curl https://api.example.com/v1/things"],
      support_files: [{ path: "references/notes.md", content: "# Notes\n\nSee README for endpoints." }],
      source_evidence: [{ section: "Setup", sources: ["README.md"] }],
    },
  });
  check("candidate created", Boolean(candidate.proposal));
  const proposalId = candidate.proposal!.id;

  console.log("\n[1] Pending until applied");
  const workspaceDir = getWorkspaceDir();
  const skillsDir = path.join(workspaceDir, "skills");
  const before = fs.existsSync(skillsDir) ? fs.readdirSync(skillsDir) : [];
  check("no skill installed before apply", !before.some((d) => d.includes("example-api")));
  check("candidate still pending", getSelfImprovementProposal(proposalId)?.status === "pending");

  console.log("\n[2] Apply installs the skill + support files");
  const applied = applySelfImprovementProposal(proposalId);
  check("candidate now applied", applied.status === "applied");
  const after = fs.readdirSync(skillsDir);
  const skillDirName = after.find((d) => d.includes("example-api"));
  check("skill directory created", Boolean(skillDirName), `dirs: ${after.join(", ")}`);
  const skillDir = path.join(skillsDir, skillDirName || "");
  check("SKILL.md written", fs.existsSync(path.join(skillDir, "SKILL.md")));
  check("support file written", fs.existsSync(path.join(skillDir, "references", "notes.md")));

  console.log("\n[3] Provenance points back to the source pack");
  const provenance = JSON.parse(fs.readFileSync(path.join(skillDir, "proposal.json"), "utf8")) as {
    sourcePackId?: string;
    verification?: unknown;
  };
  check("provenance records source pack", provenance.sourcePackId === built.pack.id);
  check("provenance records verification", Boolean(provenance.verification));

  console.log(`\nsource-skill-install: ${passed}/${passed + failed} passed`);
  if (failed > 0) {
    console.error(`Failures: ${failures.join(", ")}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
