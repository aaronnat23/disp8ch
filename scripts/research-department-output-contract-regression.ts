/**
 * Research Department output-contract regression (no DB, no model).
 *
 * Guards the reusable, template-agnostic validators: confidence tags, citations,
 * finding/wiki-note structure, brief length, and contradiction detection. These
 * validators are generic and can check any agent output, not just this pack.
 *
 * Run: pnpm exec tsx scripts/research-department-output-contract-regression.ts
 */

import fs from "node:fs";
import path from "node:path";
import {
  CONFIDENCE_TAGS,
  detectContradiction,
  extractConfidenceTags,
  isValidConfidenceTag,
  validateBrief,
  validateFinding,
  validateWikiNote,
} from "../src/lib/research-department/output-contracts";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    failures.push(name);
    if (process.env.GITHUB_ACTIONS) {
      const message = `${name}${detail ? ` - ${detail}` : ""}`.replace(/\r?\n/g, " ");
      console.error(`::error title=research output contract::${message}`);
    }
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const fixtureDir = path.join("fixtures", "research-department", "expected");
const read = (name: string) => fs.readFileSync(path.join(fixtureDir, name), "utf-8");

console.log("\nConfidence tags");
check("allowed set is exactly four", CONFIDENCE_TAGS.length === 4);
check("valid tag accepted", isValidConfidenceTag("[verified]") && isValidConfidenceTag("likely"));
check("invalid tag rejected", !isValidConfidenceTag("[true]") && !isValidConfidenceTag("certain"));
check("extracts tags from text", extractConfidenceTags("- [likely] x\n- [unverified] y").join(",") === "likely,unverified");

console.log("\nFinding contract");
{
  const good = read("finding.md");
  check("valid finding accepted", validateFinding(good).valid, validateFinding(good).errors.join("; "));
  const noUrl = good.replace(/source_url:.*\n/, "");
  check("missing source_url rejected", !validateFinding(noUrl).valid);
  const synth = good + "\n\nI recommend you adopt this immediately.";
  check("synthesis language rejected", !validateFinding(synth).valid);
  check("no frontmatter rejected", !validateFinding("# Title\n\nbody").valid);
}

console.log("\nWiki note contract");
{
  const good = read("wiki-note.md");
  check("valid wiki note accepted", validateWikiNote(good).valid, validateWikiNote(good).errors.join("; "));
  const noTags = good.replace(/\[likely\]|\[unverified\]/g, "");
  check("missing confidence tags rejected", !validateWikiNote(noTags).valid);
  const badClaim = "## Claims\n\n- [likely] Some claim with no citation at all.";
  check("uncited claim rejected", !validateWikiNote(badClaim).valid);
  const badTag = "## Claims\n\n- [certain] Some claim. Source: [x](https://x.com)";
  check("invalid confidence-style tag rejected", !validateWikiNote(badTag).valid);
}

console.log("\nBrief contract");
{
  const good = read("brief.md");
  check("valid brief accepted", validateBrief(good).valid, validateBrief(good).errors.join("; "));
  const sixBullets = "# Brief\n" + Array.from({ length: 6 }, (_, i) => `- bullet ${i}`).join("\n") + "\nUsage: 10 tokens";
  check("six bullets rejected (max 5)", !validateBrief(sixBullets).valid);
  const noBullets = validateBrief("# Brief\n\nNo bullets here.");
  check("no bullets rejected", !noBullets.valid);
  check("missing usage line warns", validateBrief("# Brief\n- one bullet").warnings.length > 0);
  const narrated = "I will now prepare the brief.\n\n1. [verified] Finding. Why it matters: impact. Action: review.\n\nUsage: 10 tokens";
  check("narration before brief rejected", !validateBrief(narrated).valid);
  const unlabelled = "1. Finding. Why it matters: impact. Action: review.\n\nUsage: 10 tokens";
  check("unlabelled brief item rejected", !validateBrief(unlabelled).valid);
  const trailing = "1. [verified] Finding. Why it matters: impact. Action: review.\n\nThis concludes the brief.\nUsage: 10 tokens";
  check("trailing narration rejected", !validateBrief(trailing).valid);
}

console.log("\nContradiction detection");
{
  const prior = "Competitor X starter plan is $20/month.";
  const conflict = "Competitor X starter plan is not $20/month.";
  const agree = "Competitor X added a wiki feature.";
  check("opposite polarity detected", detectContradiction(conflict, [prior]).contradiction);
  check("unrelated claim not flagged", !detectContradiction(agree, [prior]).contradiction);
}

console.log(`\n${"─".repeat(50)}`);
console.log(`research-department-output-contract-regression: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("Failed cases:", failures.join(", "));
  process.exit(1);
}
console.log("All output-contract regression tests passed.");
process.exit(0);
