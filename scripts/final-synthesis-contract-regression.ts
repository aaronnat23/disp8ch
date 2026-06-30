import fs from "node:fs";
import path from "node:path";
import {
  detectSynthesisContract,
  validateFinalSynthesisShape,
} from "../src/lib/channels/final-synthesis-contract";
import { rankEvidenceForFinalAnswer } from "../src/lib/channels/evidence-ranking";
import type { UniversalEvidenceDossier } from "../src/lib/channels/universal-evidence-dossier";

let passed = 0;
let failed = 0;

function check(name: string, condition: unknown, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`PASS ${name}${detail ? ` :: ${detail}` : ""}`);
  } else {
    failed += 1;
    console.error(`FAIL ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

const repoContract = detectSynthesisContract({
  message: "Inspect this repository implementation and tests for release readiness.",
});
check("repo audit detected", repoContract.type === "repo_audit", repoContract.type);
check(
  "repo audit without file evidence is flagged",
  validateFinalSynthesisShape("Recommendation: release. Everything looks good.", repoContract).missingSignals.includes("file_or_no_file_evidence"),
);
check(
  "repo audit with file evidence and tests passes",
  validateFinalSynthesisShape(
    "Recommendation: release with caveats. Proven: src/lib/channels/router.ts implements routing. Inferred: current route shape should handle normal WebChat paths. Unknown: no live timing. Next tests: pnpm.cmd exec tsc --noEmit and pnpm.cmd exec tsx scripts/router-regression.ts.",
    repoContract,
  ).ok,
);

const webContract = detectSynthesisContract({
  message: "Research the current best local model setup. Separate official docs, runtime docs, community reports, and unknowns.",
});
check("web research detected", webContract.type === "web_research", webContract.type);
check(
  "web research without source categories is flagged",
  validateFinalSynthesisShape("Use the newest model. It should work well.", webContract).missingSignals.includes("source_categories"),
);
check(
  "web research with source categories and URLs passes",
  validateFinalSynthesisShape(
    "Recommendation: test the documented local runtime first. Official/source-of-truth: https://example.com/docs. Product/runtime docs: https://runtime.example/docs. Community/third-party: weak. Proven: official docs exist. Inferred: runtime fit depends on local hardware. Unknown: exact VRAM fit is not verified.",
    webContract,
  ).ok,
);

const capabilityContract = detectSynthesisContract({
  message: "Tell me whether MCP and image generation are implemented, configured now, planned, or missing in this app.",
});
check("capability audit detected", capabilityContract.type === "capability_audit", capabilityContract.type);
check(
  "capability audit requires implemented/configured/planned/missing",
  !validateFinalSynthesisShape("MCP exists.", capabilityContract).ok,
);
check(
  "capability audit complete shape passes",
  validateFinalSynthesisShape(
    "Capability | Implemented | Configured/callable now | Planned/missing | Evidence\nMCP | implemented in src/lib/engine/tools.ts | configured via Settings if servers exist | missing server config by default | source evidence.",
    capabilityContract,
  ).ok,
);

const workflowContract = detectSynthesisContract({
  message: "Review my workflow list and suggest what to consolidate without changing anything.",
});
check("workflow review detected", workflowContract.type === "workflow_review", workflowContract.type);
check(
  "workflow review requires no-mutation boundary",
  validateFinalSynthesisShape("Workflow inventory: 3 active workflows. Recommendation: consolidate duplicates.", workflowContract).missingSignals.includes("no_mutation_boundary"),
);

const computerContract = detectSynthesisContract({
  message: "Inspect the native window titled Computer Use Pair Test and report its exact status.",
  taskHints: { originalMode: "computer_use", requestedSurfaces: ["computer_use"] },
});
check("computer observation overrides incidental repo-like words", computerContract.type === "computer_observation", computerContract.type);
check(
  "computer observation accepts a concise verified result",
  validateFinalSynthesisShape(
    "Observed the requested window in read-only mode. Heading: Computer Use Pair Test. Status: SAFE_EMPTY. The current UI state is verified by computer_observe.",
    computerContract,
  ).ok,
);
check(
  "workflow review complete shape passes",
  validateFinalSynthesisShape(
    "I have not created, edited, run, scheduled, deleted, or saved anything. Workflow inventory from live app state: active workflows: 3. Recommendations: consolidate duplicate research workflows. Next actions: inspect duplicates first.",
    workflowContract,
  ).ok,
);

const ranked = rankEvidenceForFinalAnswer({
  request: "Check MCP implementation",
  items: [],
  sourceMap: [
    { id: "a", kind: "repo", label: "docs improvement", filePath: "docs/improvements/old.md" },
    { id: "b", kind: "repo", label: "runtime source", filePath: "src/lib/engine/tools.ts" },
    { id: "c", kind: "web", label: "official docs", url: "https://example.com/docs/mcp" },
  ],
  coverage: { repo: 1, web: 1, app_state: 0, runtime: 0, memory: 0, document: 0, execution: 0, design: 0, unknown: 0 },
  toolFailures: [],
  contradictions: [],
  unknowns: [],
} as unknown as UniversalEvidenceDossier);
check("evidence ranking prefers official/source/runtime over docs artifacts", ranked[0]?.source !== "docs/improvements/old.md", JSON.stringify(ranked.slice(0, 2)));

const runtimeFiles = [
  "src/lib/channels/final-synthesis-contract.ts",
  "src/lib/channels/universal-agentic-runtime.ts",
  "src/lib/channels/universal-final-synthesizer.ts",
  "src/lib/channels/evidence-ranking.ts",
];
const forbidden = /\b(?:H5|H6|H8|H9|H11|H13|VR-REPO|VR-CAP|benchmark-scenario)\b/;
for (const file of runtimeFiles) {
  const src = fs.readFileSync(path.resolve(file), "utf8");
  check(`no benchmark token in ${file}`, !forbidden.test(src));
}

console.log(`\n${passed}/${passed + failed} checks passed`);
if (failed > 0) process.exitCode = 1;
