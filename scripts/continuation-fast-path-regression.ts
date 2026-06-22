#!/usr/bin/env node
import { shouldUseConversationContinuationFastPath } from "../src/lib/channels/agentic-turn-runner";

type Case = {
  name: string;
  message: string;
  expected: boolean;
  toolPolicy?: "forbidden" | "optional" | "required";
  taskHints?: Record<string, unknown>;
};

const cases: Case[] = [
  {
    name: "prior answer to compact table",
    message: "Continue from the previous answer. Assume the tests passed and produce a compact comparison table.",
    expected: true,
  },
  {
    name: "release comparison turn two",
    message: [
      "Continue from the previous answer.",
      "Assume the clean export install tests, TypeScript, production build, and secret/data scans all passed, but the final GitHub repository URL is still unknown.",
      "Produce a compact release risk table and a first-run checklist for a non-technical GitHub user.",
      "Carry forward the earlier constraints: no file edits, no unsupported timing claims, and flag unknowns.",
    ].join("\n"),
    expected: true,
    taskHints: { safetyBoundary: "confirmed_mutation" },
  },
  {
    name: "discussion summary",
    message: "Now summarize our discussion as five release recommendations.",
    expected: true,
  },
  {
    name: "rewrite without new evidence",
    message: "Rewrite the previous response for a non-technical user.",
    expected: true,
    toolPolicy: "forbidden",
  },
  {
    name: "continue implementation is not synthesis",
    message: "Continue implementing the async provider changes and run the tests.",
    expected: false,
  },
  {
    name: "fresh repo verification",
    message: "Summarize the answer, but first inspect the repository and verify the implementation.",
    expected: false,
  },
  {
    name: "latest web state",
    message: "Turn the prior answer into a table using the latest documentation.",
    expected: false,
  },
  {
    name: "required evidence overrides",
    message: "Summarize the prior comparison.",
    expected: false,
    toolPolicy: "required",
  },
  {
    name: "negated edit wording does not force tools",
    message: "Continue from the prior answer and produce a compact table. Preserve the no file edits constraint.",
    expected: true,
    taskHints: { likelyNeedsCodeEdit: true, safetyBoundary: "confirmed_mutation" },
  },
  {
    name: "no history",
    message: "Summarize the prior answer.",
    expected: false,
  },
];

let failed = 0;
for (const item of cases) {
  const actual = shouldUseConversationContinuationFastPath({
    message: item.message,
    hasConversationContext: item.name !== "no history",
    toolPolicy: item.toolPolicy,
    taskHints: item.taskHints,
  });
  const passed = actual === item.expected;
  if (!passed) failed += 1;
  console.log(`${passed ? "PASS" : "FAIL"} ${item.name} :: expected=${item.expected} actual=${actual}`);
}

console.log(`\n${cases.length - failed}/${cases.length} checks passed`);
if (failed) process.exitCode = 1;
