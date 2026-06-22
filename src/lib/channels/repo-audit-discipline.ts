import type { UniversalInvestigationPlan } from "@/lib/channels/universal-agentic-planner";

function compact(text: string): string {
  return String(text || "").replace(/\s+/g, " ").trim();
}

export function asksForRepoNativeVerificationCommands(text: string): boolean {
  const value = compact(text);
  if (!value) return false;
  const wantsCommands = /\b(?:windows[-\s]native|windows\s+cmd|cmd\.exe|commands?\s+to\s+run|tests?\s+to\s+run|verification\s+commands?|exact\s+(?:tests?|commands?)|run\s+next|rerun|re-run|typecheck|regression\s+scripts?)\b/i.test(value);
  const repoScope = /\b(?:repo|repository|codebase|workspace|this\s+app|this\s+project|implementation|tests?|scripts?|package\.json|pnpm|tsx|tsc)\b/i.test(value);
  return wantsCommands && repoScope;
}

export function isRepoCriterionAuditRequest(text: string, plan?: UniversalInvestigationPlan | null): boolean {
  const value = compact([
    text,
    plan?.taskSummary ?? "",
    plan?.finalAnswerCriteria.join(" ") ?? "",
    plan?.dimensions.map((dimension) => `${dimension.id} ${dimension.question} ${dimension.doneCriteria}`).join(" ") ?? "",
  ].join("\n"));
  if (!value) return false;

  const repoScope = /\b(?:repo|repository|codebase|workspace|source|files?|file[-\s]level|implementation|code\s+evidence|test\s+evidence|tests?|scripts?)\b/i.test(value) ||
    Boolean(plan?.dimensions.some((dimension) => dimension.evidenceNeeded.includes("repo") || dimension.evidenceNeeded.includes("files")));
  const criterionScope = /\b(?:acceptance\s+criteria|criterion|criteria|each\s+criterion|release\s+recommendation|release\s+readiness|ready\s+to\s+ship|go\/no[-\s]?go|ship\s+decision|residual\s+risks?|top\s+\d+\s+risks?)\b/i.test(value);
  const verificationScope = /\b(?:verify|validate|confirm|prove|evidence|inspect|audit|check|distinguish|not\s+proven|unknown|gap|risk)\b/i.test(value);
  const broadCreative = /\b(?:brainstorm|draft\s+ideas|write\s+copy|marketing|story|image|video|design\s+a\s+landing)\b/i.test(value);

  return repoScope && criterionScope && verificationScope && !broadCreative;
}

export function answerHasRepoNativeCommands(answer: string): boolean {
  const value = compact(answer);
  if (!value) return false;
  const hasWindowsPnpm = /\bpnpm\.cmd\b/i.test(value);
  const hasTypecheck = /\bpnpm\.cmd\s+exec\s+tsc\s+--noEmit\b/i.test(value);
  const hasTsxScript = /\bpnpm\.cmd\s+exec\s+tsx\s+scripts[\\/][A-Za-z0-9_.-]+\.ts\b/i.test(value);
  return hasWindowsPnpm && (hasTypecheck || hasTsxScript);
}

export function formatRepoNativeCommandGuidance(): string {
  return [
    "Repo-native verification command guidance:",
    "- Derive commands from `package.json`, discovered `scripts/*.ts` files, or prior measured commands in the current conversation.",
    "- On this Windows-native repo, prefer `pnpm.cmd exec tsc --noEmit` for typecheck and `pnpm.cmd exec tsx scripts\\<script>.ts` for TypeScript regression scripts.",
    "- Do not suggest Jest, `node --loader ts-node/esm`, Linux-only commands, or WSL loopback checks unless package/config evidence proves they are valid.",
    "- If no package/script evidence is available, label commands as unverified examples instead of presenting them as exact.",
    "- Separate tests already run in this session from tests recommended next.",
  ].join("\n");
}

export function formatRepoCriterionAuditGuidance(): string {
  return [
    "Criterion-audit discipline:",
    "- Convert the user's criteria into a compact checklist and gather one source/code evidence item plus one test/verification evidence item per criterion when available.",
    "- Search for exact criterion terms and likely regression/script names first; avoid broad directory walks after enough direct evidence exists.",
    "- Prefer current source, package/config, and live app-state evidence for current capability claims. Treat `docs/improvements` and prior comparison outputs as historical context, not proof that the current runtime works.",
    "- Stop once each criterion is marked proven, partially proven, not proven, or blocked with a concrete missing-evidence reason.",
    "- Final answer should lead with go/no-go or release recommendation, then a criterion evidence table, top residual risks, exact repo-native verification commands, and explicit unmeasured unknowns.",
    formatRepoNativeCommandGuidance(),
  ].join("\n");
}
