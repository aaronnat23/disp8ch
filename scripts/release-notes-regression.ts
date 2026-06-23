#!/usr/bin/env tsx
import fs from "node:fs";
import path from "node:path";
import { latestRelease, releaseNotes } from "@/lib/release-notes";

function check(name: string, ok: boolean) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  if (!ok) process.exitCode = 1;
}

const docsPath = path.resolve("src/app/(operator)/docs/client-page.tsx");
const docs = fs.readFileSync(docsPath, "utf8");
const changelog = fs.readFileSync(path.resolve("CHANGELOG.md"), "utf8");

check("notes.nonEmpty", releaseNotes.length > 0);
check("notes.latestMatchesFirst", latestRelease === releaseNotes[0]);
check("notes.currentReleaseFirst", latestRelease.version === "1.1.0");
check("notes.versionsUnique", new Set(releaseNotes.map((note) => note.version)).size === releaseNotes.length);
check("notes.sectionsPopulated", releaseNotes.every((note) => note.sections.length > 0 && note.sections.every((section) => section.items.length > 0)));
check("docs.hasReleaseAnchor", docs.includes('id="release-notes"'));
check("docs.hasHeaderShortcut", docs.includes('href="#release-notes"'));
check("docs.usesSharedData", docs.includes('from "@/lib/release-notes"'));
check("changelog.hasLatest", changelog.includes(`## ${latestRelease.version}`));

if (process.exitCode) process.exit(1);
console.log(`\nrelease-notes-regression: 9/9 passed`);
