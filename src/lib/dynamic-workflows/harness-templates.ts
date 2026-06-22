import type {
  DynamicWorkflowHarnessTemplate,
  DynamicWorkflowPlan,
  HarnessTemplateInput,
  DynamicWorkflowPhase,
  DynamicWorkflowWorkerSpec,
} from "./types";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function resolvePlaceholders(
  template: string,
  inputs: Record<string, unknown>,
): string {
  return template.replace(/\{\{input\.(\w+)\}\}/g, (_match, key) => {
    const value = inputs[key];
    if (value === undefined || value === null) return `{{input.${key}}}`;
    return String(value);
  });
}

function resolveInputs(
  inputDefs: HarnessTemplateInput[],
  rawValues: Record<string, unknown>,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const def of inputDefs) {
    const val = rawValues[def.id] !== undefined ? rawValues[def.id] : def.default;
    if (val !== undefined) {
      resolved[def.id] = val;
    }
  }
  for (const def of inputDefs) {
    if (def.required && resolved[def.id] === undefined) {
      const tmplId = "[inline]";
      throw new Error(
        `Harness template "${tmplId}" requires input "${def.id}" (${def.label})`,
      );
    }
  }
  return resolved;
}

function getNum(inputs: Record<string, unknown>, key: string, fallback: number): number {
  const v = inputs[key];
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (!Number.isNaN(n)) return n;
  }
  return fallback;
}

function resolvePhase(
  phase: DynamicWorkflowPhase,
  resolve: (s: string) => string,
): DynamicWorkflowPhase {
  return {
    id: resolve(phase.id),
    name: resolve(phase.name),
    instructions: resolve(phase.instructions),
    strategy: phase.strategy,
    workers: phase.workers.map((w): DynamicWorkflowWorkerSpec => ({
      id: resolve(w.id),
      role: resolve(w.role),
      prompt: resolve(w.prompt),
      agentKind: w.agentKind,
      modelRef: w.modelRef ? resolve(w.modelRef) : undefined,
      toolsets: w.toolsets,
      requiresScreenshot: w.requiresScreenshot,
      expectedOutputSchema: w.expectedOutputSchema,
    })),
    dependsOn: phase.dependsOn ? phase.dependsOn.map(resolve) : undefined,
  };
}

// ---------------------------------------------------------------------------
// Template Input Definitions
// ---------------------------------------------------------------------------

const PROJECT_MANAGER_INPUTS: HarnessTemplateInput[] = [
  {
    id: "projectName",
    label: "Project Name",
    required: true,
    type: "string",
    description: "Human-readable name of the project being managed.",
  },
  {
    id: "repoLocalPath",
    label: "Repository Local Path",
    required: true,
    type: "string",
    description: "Absolute path to the local Git repository clone.",
  },
  {
    id: "githubOwnerRepo",
    label: "GitHub Owner/Repo",
    required: false,
    type: "string",
    description: "Full GitHub slug, e.g. owner/repo. Required for issue/PR triage.",
  },
  {
    id: "schedule",
    label: "Cron Schedule",
    required: false,
    type: "string",
    default: "0 9 * * 1-5",
    description: "Cron expression. Defaults to weekday mornings at 09:00 UTC.",
  },
  {
    id: "managerModelRef",
    label: "Manager Model Reference",
    required: false,
    type: "string",
    description: "Provider/model ref for the manager agent. Falls back to system default.",
  },
  {
    id: "workerModelRef",
    label: "Worker Model Reference",
    required: false,
    type: "string",
    description: "Provider/model ref for worker agents. Falls back to system default.",
  },
  {
    id: "maxConcurrency",
    label: "Max Concurrency",
    required: false,
    type: "number",
    default: 4,
    description: "Maximum concurrent workers across all phases.",
  },
  {
    id: "budgetLimitUsd",
    label: "Budget Limit (USD)",
    required: false,
    type: "number",
    default: 5.0,
    description: "Soft USD budget cap per run cycle.",
  },
  {
    id: "defaultBranch",
    label: "Default Branch",
    required: false,
    type: "string",
    default: "main",
    description: "Default Git branch to target for diffs, PRs, and verifications.",
  },
  {
    id: "appUrl",
    label: "App URL",
    required: false,
    type: "string",
    description: "Live deploy URL for UI browser checks and screenshots.",
  },
  {
    id: "screenshotOutputFolder",
    label: "Screenshot Output Folder",
    required: false,
    type: "string",
    default: "screenshot/agent-harness",
    description: "Relative folder path where browser screenshots are saved.",
  },
];

const REPO_AUDIT_INPUTS: HarnessTemplateInput[] = [
  {
    id: "projectName",
    label: "Project Name",
    required: true,
    type: "string",
    description: "Human-readable name of the repo being audited.",
  },
  {
    id: "repoLocalPath",
    label: "Repository Local Path",
    required: true,
    type: "string",
    description: "Absolute path to the local Git repository clone.",
  },
  {
    id: "githubOwnerRepo",
    label: "GitHub Owner/Repo",
    required: false,
    type: "string",
    description: "Full GitHub slug for retrieving issue/PR context.",
  },
  {
    id: "maxConcurrency",
    label: "Max Concurrency",
    required: false,
    type: "number",
    default: 2,
    description: "Maximum concurrent workers.",
  },
  {
    id: "defaultBranch",
    label: "Default Branch",
    required: false,
    type: "string",
    default: "main",
    description: "Default Git branch for diffs and file references.",
  },
  {
    id: "workerModelRef",
    label: "Worker Model Reference",
    required: false,
    type: "string",
    description: "Provider/model ref for workers. Falls back to system default.",
  },
];

// ---------------------------------------------------------------------------
// Template Plan Blueprints (private – with placeholders)
// ---------------------------------------------------------------------------

const PROJECT_MANAGER_PHASES: DynamicWorkflowPhase[] = [
  {
    id: "triage-planning",
    name: "Triage & Planning",
    instructions:
      "Check GitHub issues and PRs, deduplicate known reports, and create board tasks for new or actionable items.",
    strategy: "single",
    workers: [
      {
        id: "triage-worker",
        role: "Triage Agent",
        prompt:
          "You are a triage agent for {{input.projectName}}.\n" +
          "Repository: {{input.repoLocalPath}}\n" +
          "GitHub: {{input.githubOwnerRepo}}\n\n" +
          "1. Fetch open issues and recent PRs from {{input.githubOwnerRepo}}.\n" +
          "2. Identify duplicates, stale items, and items that overlap with existing board tasks.\n" +
          "3. For each new actionable issue, create a board task with:\n" +
          "   - Summary of the issue\n" +
          "   - Priority (high / medium / low)\n" +
          "   - Suggested assignee or category\n" +
          "   - Link back to the GitHub issue\n" +
          "4. Report the triage summary: total issues, new tasks created, duplicates skipped.",
        agentKind: "internal",
      },
    ],
  },
  {
    id: "research-and-analysis",
    name: "Research & Analysis",
    instructions:
      "Deep-dive analysis of selected issues with two parallel research workers covering codebase context and external references.",
    strategy: "fanout",
    dependsOn: ["triage-planning"],
    workers: [
      {
        id: "research-worker-codebase",
        role: "Codebase Research Agent",
        prompt:
          "You are a codebase research agent for {{input.projectName}}.\n" +
          "Repository: {{input.repoLocalPath}} (branch: {{input.defaultBranch}})\n\n" +
          "For each open board task / issue:\n" +
          "1. Search the repo for relevant source files, tests, and configuration.\n" +
          "2. Trace the code paths that would need to change.\n" +
          "3. Identify existing tests, fixtures, or docs related to the area.\n" +
          "4. Note any breaking change risks, dependency conflicts, or architectural concerns.\n" +
          "5. Produce a structured research note per issue with file paths, line ranges, and risk flags.",
        agentKind: "internal",
      },
      {
        id: "research-worker-external",
        role: "External Context Research Agent",
        prompt:
          "You are an external-context research agent for {{input.projectName}}.\n" +
          "GitHub: {{input.githubOwnerRepo}}\n\n" +
          "For each open board task / issue:\n" +
          "1. Search the web for related library changelogs, security advisories, and upstream discussions.\n" +
          "2. Check for existing community solutions, dependency updates, or framework migration guides.\n" +
          "3. Collect relevant docs, blog posts, or reference implementations.\n" +
          "4. Flag any upstream deprecations, CVEs, or breaking changes that affect the fix.\n" +
          "5. Produce a structured research note per issue with URLs, version constraints, and upstream status.",
        agentKind: "internal",
      },
    ],
  },
  {
    id: "implementation-or-recommendation",
    name: "Implementation or Recommendation",
    instructions:
      "Produce concrete code patches, design docs, or implementation recommendations based on research findings.",
    strategy: "synthesize",
    dependsOn: ["research-and-analysis"],
    workers: [
      {
        id: "impl-worker-code",
        role: "Implementation Agent",
        prompt:
          "You are an implementation agent for {{input.projectName}}.\n" +
          "Repository: {{input.repoLocalPath}} (branch: {{input.defaultBranch}})\n" +
          "Use the research notes from the previous phase.\n\n" +
          "For each actionable issue:\n" +
          "1. Write concrete code changes (patches) that address the issue.\n" +
          "2. Ensure changes follow the existing code conventions of the repo.\n" +
          "3. Include or update relevant tests.\n" +
          "4. Document any new configuration, environment variables, or migration steps.\n" +
          "5. Produce a clean patch file or diff summary with rationale.",
        agentKind: "internal",
      },
      {
        id: "impl-worker-design",
        role: "Design / Recommendation Agent",
        prompt:
          "You are a design/recommendation agent for {{input.projectName}}.\n" +
          "Use the research notes from the previous phase.\n\n" +
          "For issues that are better addressed by design or architectural changes:\n" +
          "1. Write a concise design document or RFC describing the proposed change.\n" +
          "2. Include trade-off analysis, alternatives considered, and rollout plan.\n" +
          "3. Identify cross-cutting concerns: performance, security, observability, data migration.\n" +
          "4. Produce a markdown artifact in the repo docs or a top-level proposal.\n" +
          "5. Cross-reference any related issues or PRs that are blocked by or dependent on this work.",
        agentKind: "internal",
      },
    ],
  },
  {
    id: "review",
    name: "Review",
    instructions:
      "Review all outputs from the implementation phase for correctness, style consistency, and safety.",
    strategy: "review",
    dependsOn: ["implementation-or-recommendation"],
    workers: [
      {
        id: "review-worker",
        role: "Review Agent",
        prompt:
          "You are a code and design review agent for {{input.projectName}}.\n" +
          "Review every patch, design doc, and recommendation produced in the previous phase.\n\n" +
          "Checklist:\n" +
          "1. Does each patch actually fix the reported issue?\n" +
          "2. Is the code style consistent with the rest of the repo?\n" +
          "3. Are there any obvious regressions, missing edge cases, or untested paths?\n" +
          "4. Are security, performance, and data-integrity concerns addressed?\n" +
          "5. Do design docs have clear rationale, alternatives, and rollout plans?\n" +
          "6. Flag anything that should block merge vs. can be addressed in follow-up.\n\n" +
          "Produce a review summary with approval status per item.",
        agentKind: "internal",
      },
    ],
  },
  {
    id: "verification-and-report",
    name: "Verification & Report",
    instructions:
      "Verify changes via shell commands, browser checks, and screenshots; produce a summary report.",
    strategy: "verify",
    dependsOn: ["review"],
    workers: [
      {
        id: "verify-worker-commands",
        role: "Command Verification Agent",
        prompt:
          "You are a command-verification agent for {{input.projectName}}.\n" +
          "Repository: {{input.repoLocalPath}} (branch: {{input.defaultBranch}})\n\n" +
          "1. Run the project's linter and type-checker on the changed files.\n" +
          "2. Execute the project's test suite (or the subset relevant to the changes).\n" +
          "3. If a build step exists, perform a clean build.\n" +
          "4. Report pass/fail for each command with raw output summaries.\n" +
          "5. If any command fails, include the relevant error lines and suggest a fix.",
        agentKind: "internal",
      },
      {
        id: "verify-worker-browser",
        role: "Browser Verification Agent",
        prompt:
          "You are a browser-verification agent for {{input.projectName}}.\n" +
          "App URL: {{input.appUrl}}\n" +
          "Screenshot output: {{input.screenshotOutputFolder}}\n\n" +
          "1. If appUrl is set, open the live application in a headless browser.\n" +
          "2. Navigate to key pages (home, dashboard, settings, or as relevant to the changes).\n" +
          "3. Check for visible errors, broken layouts, or console errors.\n" +
          "4. Capture screenshots of each key page and save to {{input.screenshotOutputFolder}}.\n" +
          "5. Produce a short UI-health summary: pages checked, screenshots saved, errors found.\n\n" +
          "If no appUrl is configured, skip browser checks and note that UI verification was deferred.",
        agentKind: "internal",
        requiresScreenshot: true,
      },
      {
        id: "verify-worker-report",
        role: "Summary Report Agent",
        prompt:
          "You are a summary-report agent for {{input.projectName}}.\n" +
          "Gather outputs from all phases and produce a concise cycle report.\n\n" +
          "Report structure:\n" +
          "1. Cycle overview: date, project, branch, issues triaged.\n" +
          "2. Research summary: key findings from codebase and external research.\n" +
          "3. Implementation: patches produced, design docs written.\n" +
          "4. Review status: approved / blocked / needs-follow-up.\n" +
          "5. Verification: lint/build/test results, browser/screenshot results.\n" +
          "6. Budget: estimated token usage and cost vs the ${{input.budgetLimitUsd}} limit.\n" +
          "7. Next-cycle recommendations: items to revisit, escalate, or close.",
        agentKind: "internal",
      },
    ],
  },
];

const REPO_AUDIT_PHASES: DynamicWorkflowPhase[] = [
  {
    id: "research",
    name: "Research",
    instructions:
      "Parallel research of repo structure/dependencies and code quality/security posture.",
    strategy: "fanout",
    workers: [
      {
        id: "research-worker-structure",
        role: "Repo Structure Research Agent",
        prompt:
          "You are a repo-structure research agent for {{input.projectName}}.\n" +
          "Repository: {{input.repoLocalPath}} (branch: {{input.defaultBranch}})\n\n" +
          "1. Inspect top-level files: package.json (or equivalent), tsconfig, linter config, CI config.\n" +
          "2. Map the directory layout and identify key source modules.\n" +
          "3. List all dependencies with versions; flag any that are outdated, unmaintained, or have known vulnerabilities.\n" +
          "4. Count and categorize tests (unit, integration, e2e). Identify any missing test categories.\n" +
          "5. Report build scripts, dev tooling, and automation scripts.",
        agentKind: "internal",
      },
      {
        id: "research-worker-quality",
        role: "Code Quality & Security Research Agent",
        prompt:
          "You are a code-quality and security research agent for {{input.projectName}}.\n" +
          "Repository: {{input.repoLocalPath}} (branch: {{input.defaultBranch}})\n\n" +
          "1. Scan for hardcoded secrets, API keys, or credentials in source files.\n" +
          "2. Check for common security anti-patterns: unsanitized inputs, eval usage, insecure defaults.\n" +
          "3. Review error-handling patterns: try/catch coverage, error boundaries, graceful degradation.\n" +
          "4. Inspect recent Git history: frequency of commits, PR merge patterns, hotfix frequency.\n" +
          "5. Flag any files that are exceptionally large, deeply nested, or appear to be dead code.",
        agentKind: "internal",
      },
    ],
  },
  {
    id: "analysis",
    name: "Analysis",
    instructions:
      "Synthesize research findings into a consolidated gap and risk analysis.",
    strategy: "review",
    dependsOn: ["research"],
    workers: [
      {
        id: "analysis-worker",
        role: "Gap & Risk Analysis Agent",
        prompt:
          "You are an analysis agent for the {{input.projectName}} repo audit.\n" +
          "Combine the findings from both research workers into a consolidated analysis.\n\n" +
          "1. Cross-reference structure findings with quality findings.\n" +
          "2. Identify the top 5-10 gaps or risks ranked by severity.\n" +
          "3. For each gap, provide: severity (critical/high/medium/low), affected files/modules, and a concrete recommendation.\n" +
          "4. Note any quick wins (low-effort, high-impact fixes).\n" +
          "5. Produce a structured analysis markdown document.",
        agentKind: "internal",
      },
    ],
  },
  {
    id: "report",
    name: "Report",
    instructions:
      "Produce a verified audit report with shell-command backing where applicable.",
    strategy: "verify",
    dependsOn: ["analysis"],
    workers: [
      {
        id: "report-worker",
        role: "Audit Reporting Agent",
        prompt:
          "You are a reporting agent for the {{input.projectName}} repo audit.\n" +
          "Repository: {{input.repoLocalPath}} (branch: {{input.defaultBranch}})\n\n" +
          "Produce the final audit report:\n\n" +
          "1. Executive summary: repo health score (1-10), key strengths, critical risks.\n" +
          "2. Dependency health: outdated packages, vulnerability count, license compliance.\n" +
          "3. Test coverage: counts by category, coverage gaps, test-run pass/fail status.\n" +
          "4. Security findings: secrets found (none / count), anti-pattern count, severity breakdown.\n" +
          "5. Code quality: dead code estimate, large-file count, error-handling gaps.\n" +
          "6. Recommendations: top 5 actionable items with effort estimates.\n\n" +
          "Where possible, back each claim with a shell command output, file reference, or line number.\n" +
          "Run the project's own linter (if any) and include the result.",
        agentKind: "internal",
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Exported Templates
// ---------------------------------------------------------------------------

export const PROJECT_MANAGER_HARNESS: DynamicWorkflowHarnessTemplate = {
  id: "project-manager-harness",
  name: "Project Manager Agent Harness",
  description:
    "One long-running manager agent monitors a project, dispatches subagents, connects GitHub, runs on schedule, verifies changes, captures UI screenshots, uses project-specific prompts, and compacts context automatically.",
  category: "project-management",
  defaultMaxConcurrency: 4,
  requiresGithub: true,
  requiresSchedule: true,
  requiresScreenshots: true,
  inputs: PROJECT_MANAGER_INPUTS,
  populate: (values: Record<string, unknown>): DynamicWorkflowPlan => {
    const inputs = resolveInputs(PROJECT_MANAGER_INPUTS, values);
    const resolve = (s: string) => resolvePlaceholders(s, inputs);

    return {
      objective:
        "Project Manager Agent Harness — {{input.projectName}}\n\n" +
        "Run a full project-management cycle for {{input.projectName}}.\n" +
        "Repository: {{input.repoLocalPath}} (branch: {{input.defaultBranch}})\n" +
        "Schedule: {{input.schedule}}\n\n" +
        "Cycle steps:\n" +
        "1. Triage open GitHub issues and PRs for {{input.githubOwnerRepo}}, deduplicate, and create board tasks.\n" +
        "2. Research and analyze selected issues with parallel workers.\n" +
        "3. Generate concrete implementation patches, design documents, or actionable recommendations.\n" +
        "4. Review all outputs for correctness, style consistency, and safety.\n" +
        "5. Verify changes via shell commands, browser checks, and screenshots; produce a summary report.\n\n" +
        "Manager constraints:\n" +
        "- Soft budget limit: ${{input.budgetLimitUsd}} per cycle.\n" +
        "- Max concurrency: {{input.maxConcurrency}} workers.\n" +
        "- Context compaction should run before each new cycle to keep token usage under control.\n" +
        "- If appUrl is set ({{input.appUrl}}), include live UI screenshots in the verification phase.\n" +
        "- Save screenshots under {{input.screenshotOutputFolder}}.",
      acceptanceCriteria: [
        "All five phases complete without fatal errors.",
        "Each phase produces documented outputs accessible to the manager agent.",
        "Report includes actionable items with file paths and line references.",
        "Screenshots are captured if appUrl is configured.",
        "No secret or credential material appears in any worker output.",
        "Estimated cost does not exceed the budget limit.",
      ].map(resolve),
      sourceRefs: [
        { type: "repo", label: resolve("{{input.projectName}} repository"), id: resolve("{{input.repoLocalPath}}") },
      ],
      phases: PROJECT_MANAGER_PHASES.map((p) => resolvePhase(p, resolve)),
      verification: {
        commands: ["lint", "typecheck", "build", "test"].map(resolve),
        browserChecks: [
          {
            url: resolve("{{input.appUrl}}"),
            instruction: resolve("Verify the home page loads without errors"),
            screenshotName: "home-page",
          },
        ],
        requireScreenshots: true,
        requireFinalSynthesis: true,
      },
      limits: {
        maxConcurrency: getNum(inputs, "maxConcurrency", 4),
        maxWorkers: 9,
        maxRuntimeSeconds: 3600,
        budgetLimitUsd: getNum(inputs, "budgetLimitUsd", 5.0),
      },
    };
  },
};

export const REPO_AUDIT_HARNESS: DynamicWorkflowHarnessTemplate = {
  id: "repo-audit-harness",
  name: "Repo Audit Harness",
  description:
    "A lightweight audit harness for quick repository health checks. Researches the codebase with parallel workers, analyzes findings, and produces a verification-backed report.",
  category: "audit",
  defaultMaxConcurrency: 2,
  inputs: REPO_AUDIT_INPUTS,
  populate: (values: Record<string, unknown>): DynamicWorkflowPlan => {
    const inputs = resolveInputs(REPO_AUDIT_INPUTS, values);
    const resolve = (s: string) => resolvePlaceholders(s, inputs);

    return {
      objective:
        "Repo Audit — {{input.projectName}}\n\n" +
        "Run a structured audit of the repository at {{input.repoLocalPath}}.\n" +
        "Branch: {{input.defaultBranch}}\n\n" +
        "Audit steps:\n" +
        "1. Research the repo structure, dependencies, testing, and security posture with two parallel workers.\n" +
        "2. Analyze the combined findings for gaps, risks, and recommendations.\n" +
        "3. Produce a verified report with shell-command backing and a summary scorecard.",
      acceptanceCriteria: [
        "All three phases complete without fatal errors.",
        "Research phase covers both structure/dependencies and quality/security.",
        "Analysis identifies top risks ranked by severity with file references.",
        "Report is backed by shell-command verification output.",
        "Report includes a clear repo health scorecard.",
      ].map(resolve),
      sourceRefs: [
        { type: "repo", label: resolve("{{input.projectName}} repository"), id: resolve("{{input.repoLocalPath}}") },
      ],
      phases: REPO_AUDIT_PHASES.map((p) => resolvePhase(p, resolve)),
      limits: {
        maxConcurrency: getNum(inputs, "maxConcurrency", 2),
        maxWorkers: 4,
        maxRuntimeSeconds: 1800,
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const TEMPLATES: DynamicWorkflowHarnessTemplate[] = [
  PROJECT_MANAGER_HARNESS,
  REPO_AUDIT_HARNESS,
];

export function getAllHarnessTemplates(): DynamicWorkflowHarnessTemplate[] {
  return [...TEMPLATES];
}

export function getHarnessTemplate(
  id: string,
): DynamicWorkflowHarnessTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

export function applyHarnessTemplate(
  templateId: string,
  inputs: Record<string, unknown>,
): DynamicWorkflowPlan {
  const template = getHarnessTemplate(templateId);
  if (!template) {
    throw new Error(`Harness template not found: ${templateId}`);
  }
  return template.populate(inputs);
}
