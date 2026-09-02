import type { CapabilityState } from "@/lib/capabilities/capability-state";

export type DiscoverySuggestion = {
  id: string;
  title: string;
  description: string;
  reason: string;
  href: string;
  actionLabel: string;
  capabilityId?: string;
  score: number;
  tags: string[];
};

type DiscoveryContext = {
  pathname: string;
  intent?: string | null;
  capabilities: CapabilityState;
  agentCount: number;
};

type Candidate = Omit<DiscoverySuggestion, "score" | "reason"> & {
  paths: string[];
  intents: string[];
  base: number;
};

const CANDIDATES: Candidate[] = [
  { id: "agent-teammates", title: "Work with a specialist agent", description: "Open a durable chat with an agent configured for this kind of work.", href: "/chat?teammates=1", actionLabel: "Choose teammate", paths: ["/chat", "/agents", "/hierarchy"], intents: ["delegate", "research", "review", "team", "agent"], base: 18, tags: ["agents", "handoff", "chat"] },
  { id: "context-files", title: "Attach exact workspace context", description: "Use @file:, @folder:, @diff, @git:N, or @url: in WebChat instead of pasting large blocks.", href: "/chat?draft=%40file%3A", actionLabel: "Add file context", paths: ["/chat", "/files", "/workbench"], intents: ["file", "code", "repo", "diff", "git", "url", "context"], base: 16, tags: ["context", "files", "composer"] },
  { id: "workflow-draft", title: "Turn repeated work into a workflow", description: "Draft a reviewable automation from an existing process or computer-use session.", href: "/workflows?new=1", actionLabel: "Draft workflow", paths: ["/workflows", "/scheduler", "/chat"], intents: ["repeat", "automate", "routine", "workflow", "schedule"], base: 15, tags: ["workflow", "automation", "routine"] },
  { id: "council-review", title: "Compare multiple agent perspectives", description: "Use Council for bounded debate or voting when a decision benefits from disagreement.", href: "/council", actionLabel: "Open Council", paths: ["/agents", "/hierarchy", "/boards"], intents: ["compare", "decision", "debate", "review", "options"], base: 11, tags: ["council", "decision"] },
  { id: "background-work", title: "Let long work continue in the background", description: "Monitor running jobs, delegated sessions, failures, and completed work in Activity.", href: "/activity", actionLabel: "Open Activity", paths: ["/chat", "/workflows", "/agents"], intents: ["background", "long", "monitor", "running", "progress"], base: 12, tags: ["background", "activity"] },
  { id: "learning-review", title: "Capture a reusable skill", description: "Ask WebChat to review the conversation and draft a reusable skill for approval.", href: "/chat?draft=%2Freview-skill", actionLabel: "Review conversation", paths: ["/chat", "/skills"], intents: ["learn", "reuse", "skill", "procedure"], base: 10, tags: ["learning", "skills"] },
  { id: "browser-setup", title: "Finish browser automation setup", description: "Configure and test browser automation before asking an agent to operate websites.", href: "/settings?tab=general", actionLabel: "Open setup", capabilityId: "browser_automation", paths: ["/chat", "/settings", "/workflows"], intents: ["browser", "website", "scrape", "navigate"], base: 8, tags: ["browser", "setup"] },
  { id: "computer-use", title: "Use audited desktop control", description: "Run Computer Use doctor, then start a visible and approval-gated desktop session.", href: "/settings/computer-use", actionLabel: "Check Computer Use", capabilityId: "computer_use", paths: ["/chat", "/settings", "/workflows"], intents: ["desktop", "computer", "click", "application", "teach"], base: 8, tags: ["computer-use", "setup"] },
  { id: "mcp-tools", title: "Connect an MCP server", description: "Add external tools with explicit agent scope and approval policies.", href: "/mcp", actionLabel: "Open MCP Servers", paths: ["/agents", "/skills", "/settings"], intents: ["integration", "mcp", "external", "tool", "server"], base: 7, tags: ["mcp", "tools"] },
];

function words(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9_-]+/).filter((token) => token.length > 1);
}

export function rankCapabilitySuggestions(context: DiscoveryContext, limit = 5): DiscoverySuggestion[] {
  const pathname = context.pathname || "/";
  const intentWords = new Set(words(context.intent || ""));
  return CANDIDATES.map((candidate) => {
    const pathMatch = candidate.paths.some((path) => pathname === path || pathname.startsWith(`${path}/`));
    const matchingIntents = candidate.intents.filter((term) => intentWords.has(term) || (context.intent || "").toLowerCase().includes(term));
    const capability = candidate.capabilityId ? context.capabilities.capabilities[candidate.capabilityId] : null;
    const setupBoost = capability && !capability.ready ? 18 : 0;
    const agentPenalty = candidate.id === "agent-teammates" && context.agentCount < 2 ? -8 : 0;
    const score = candidate.base + (pathMatch ? 24 : 0) + matchingIntents.length * 12 + setupBoost + agentPenalty;
    const reason = matchingIntents.length > 0
      ? `Matches your current task: ${matchingIntents.slice(0, 3).join(", ")}.`
      : capability && !capability.ready
        ? capability.reason
        : pathMatch
          ? "Useful on the page you are viewing now."
          : "Available in your current Disp8ch setup.";
    return { ...candidate, reason, score };
  }).sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, Math.max(1, Math.min(10, limit)));
}
