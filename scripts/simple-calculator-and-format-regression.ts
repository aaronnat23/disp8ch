import { evaluateSimpleCalculation } from "../src/lib/channels/simple-calculator";
import { enforceExplicitFormat, extractExplicitFormatConstraint } from "../src/lib/channels/universal-answer-shape";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.error(`FAIL ${name}${detail ? ` - ${detail}` : ""}`); }
}

check("symbol arithmetic", evaluateSimpleCalculation("what is 2+2?") === "4");
check("word arithmetic", evaluateSimpleCalculation("calculate two plus two for me") === "4");
check("percentage arithmetic", evaluateSimpleCalculation("what is 20 percent of 50?") === "10");
check("non-math text rejected", evaluateSimpleCalculation("compare local and cloud models") === null);
check("non-finite result rejected", evaluateSimpleCalculation("calculate 1 / 0") === null);

const message = "Shorten each bullet to under 12 words. Keep exactly 3 bullets.";
const constraint = extractExplicitFormatConstraint(message);
check("strong bullet count outranks word limit", Boolean(constraint?.startsWith("3 bullets")), String(constraint));
const formatted = enforceExplicitFormat([
  "Here are the revised bullets:",
  "- one two three four five six seven eight nine ten eleven twelve thirteen",
  "- second concise point",
  "- third concise point",
  "- unwanted fourth point",
].join("\n"), constraint);
const lines = formatted.answer.split("\n");
check("enforcement returns exactly three bullet-only lines", lines.length === 3 && lines.every((line) => /^- /.test(line)), formatted.answer);
check("per-bullet under-word limit enforced", lines.every((line) => line.replace(/^- /, "").split(/\s+/).length < 12), formatted.answer);

const proseFormatted = enforceExplicitFormat([
  "Use: Optimized processing reduces response latency; streamlined request handling speeds replies.",
  "Proven: The draft contained three distinct technical improvements.",
  "Unknown: Exact production latency still depends on deployment conditions.",
].join("\n"), constraint);
const proseLines = proseFormatted.answer.split("\n");
check("prose is converted to requested bullets", proseLines.length === 3 && proseLines.every((line) => /^- /.test(line)), proseFormatted.answer);
check("converted prose obeys per-bullet word limit", proseLines.every((line) => line.replace(/^- /, "").split(/\s+/).length < 12), proseFormatted.answer);

console.log(`\nsimple-calculator-and-format-regression: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
