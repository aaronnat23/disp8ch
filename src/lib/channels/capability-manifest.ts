export type CapabilityManifestEntry = {
  id: string;
  label: string;
  description: string;
  examples: string[];
  evidenceProvided: string[];
  mutatesState: boolean;
  requiresConfirmation: boolean;
  toolGroups: string[];
  failureModes: string[];
};

const WEB_RESEARCH: CapabilityManifestEntry = {
  id: "web_research",
  label: "Web Research",
  description: "Search the web for current public facts, fetch/extract source pages, and cite verified URLs as evidence.",
  examples: [
    "What is the latest Qwen model version?",
    "Find the official setup docs for the named product.",
    "Search for community discussion about the named integration."
  ],
  evidenceProvided: ["current_web", "source_urls", "source_dates"],
  mutatesState: false,
  requiresConfirmation: false,
  toolGroups: ["web", "browser"],
  failureModes: ["No search results found.", "Source extraction blocked.", "Paywalled content."],
};

const REPO_INSPECTION: CapabilityManifestEntry = {
  id: "repo_inspection",
  label: "Repo Inspection",
  description: "Search, list, and read files in the current workspace to ground claims in real code and file paths.",
  examples: [
    "Inspect the WebChat route for latency bottlenecks.",
    "Find all files related to toast notifications.",
    "Read the implementation of classifyBroadTask."
  ],
  evidenceProvided: ["repo_files", "file_paths", "line_ranges", "function_names"],
  mutatesState: false,
  requiresConfirmation: false,
  toolGroups: ["filesystem", "browser"],
  failureModes: ["File not found.", "File too large to read.", "Path outside workspace."],
};

const APP_STATE_READ: CapabilityManifestEntry = {
  id: "app_state_read",
  label: "App State Read",
  description: "Read disp8ch AI's current app state: workflows, boards, agents, hierarchy, council sessions, channel config, and memory.",
  examples: [
    "Show me the active workflows.",
    "What are the current board tasks?",
    "List all configured agents.",
    "Read the current org hierarchy."
  ],
  evidenceProvided: ["app_state"],
  mutatesState: false,
  requiresConfirmation: false,
  toolGroups: ["workflows", "boards", "memory", "messaging"],
  failureModes: ["Toolset not enabled for this session.", "State is empty."],
};

const APP_MUTATION: CapabilityManifestEntry = {
  id: "app_mutation",
  label: "App Mutation",
  description: "Create, update, or delete disp8ch AI app state after explicit confirmation.",
  examples: [
    "Create a board task for the comparison benchmark.",
    "Save this workflow design.",
    "Schedule a daily digest cron job."
  ],
  evidenceProvided: ["app_state", "mutation_result"],
  mutatesState: true,
  requiresConfirmation: true,
  toolGroups: ["workflows", "boards", "governance", "messaging", "unsafe_exec"],
  failureModes: [
    "User did not confirm the mutation.",
    "Mutation safety policy forbids this operation.",
    "Target entity does not exist.",
  ],
};

const SESSION_RECALL: CapabilityManifestEntry = {
  id: "session_recall",
  label: "Session Recall",
  description: "Recall facts, preferences, and decisions from this session's conversation history or durable memory.",
  examples: [
    "What was the codename from earlier?",
    "Remember that I prefer pnpm over npm.",
    "Recall the test fact I stored."
  ],
  evidenceProvided: ["session_history", "durable_memory"],
  mutatesState: false,
  requiresConfirmation: false,
  toolGroups: ["memory"],
  failureModes: ["Memory not found.", "Session context is empty.", "Stored fact was overwritten."],
};

const COMPOSITION: CapabilityManifestEntry = {
  id: "composition",
  label: "Composition & Transformation",
  description: "Write, draft, edit, transform, or summarize text using provided context, session history, or general knowledge. No tools required.",
  examples: [
    "Write a product update.",
    "Rewrite this paragraph more concisely.",
    "Draft a two-sentence release note.",
    "Summarize the above text."
  ],
  evidenceProvided: ["provided_text", "general_knowledge"],
  mutatesState: false,
  requiresConfirmation: false,
  toolGroups: [],
  failureModes: ["User expects tool-backed facts but provided no source."],
};

const BENCHMARK_ARTIFACTS: CapabilityManifestEntry = {
  id: "benchmark_artifacts",
  label: "Benchmark Artifact Analysis",
  description: "Read local benchmark result files and compare run reports.",
  examples: [
    "Compare based on results in BENCHMARK.md.",
    "Analyze the latest test run output.",
    "Read the reference comparison results."
  ],
  evidenceProvided: ["benchmark_artifacts", "repo_files"],
  mutatesState: false,
  requiresConfirmation: false,
  toolGroups: ["filesystem"],
  failureModes: ["Benchmark file not found.", "Results format is unexpected."],
};

const CAPABILITIES: CapabilityManifestEntry[] = [
  WEB_RESEARCH,
  REPO_INSPECTION,
  APP_STATE_READ,
  APP_MUTATION,
  SESSION_RECALL,
  COMPOSITION,
  BENCHMARK_ARTIFACTS,
];

export function getCapabilityById(id: string): CapabilityManifestEntry | undefined {
  return CAPABILITIES.find((cap) => cap.id === id);
}

export function listAllCapabilities(): CapabilityManifestEntry[] {
  return CAPABILITIES;
}

export function listReadOnlyCapabilities(): CapabilityManifestEntry[] {
  return CAPABILITIES.filter((cap) => !cap.mutatesState);
}

export function buildCapabilityManifestPrompt(availableToolGroups?: Set<string>): string {
  const filtered = availableToolGroups
    ? CAPABILITIES.filter((cap) =>
        cap.toolGroups.length === 0 || cap.toolGroups.some((group) => availableToolGroups.has(group))
      )
    : CAPABILITIES;

  if (filtered.length === 0) return "";

  const lines: string[] = [
    "## Available Capabilities",
    "These are the things disp8ch AI can do for you. Use them to ground your answer in real app features.",
    "",
  ];

  for (const cap of filtered) {
    const mutationNote = cap.mutatesState ? " (REQUIRES CONFIRMATION before executing)" : "";
    lines.push(`### ${cap.label}${mutationNote}`);
    lines.push(cap.description);
    if (cap.examples.length > 0) {
      lines.push("Examples:");
      for (const example of cap.examples.slice(0, 2)) {
        lines.push(`  - "${example}"`);
      }
    }
    if (cap.failureModes.length > 0) {
      lines.push("Limitations:");
      for (const fm of cap.failureModes.slice(0, 2)) {
        lines.push(`  - ${fm}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}
