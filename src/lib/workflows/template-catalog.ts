export type WorkflowTemplateCatalogEntry = {
  key: string;
  name: string;
  aliases: string[];
};

const TEMPLATE_CATALOG: WorkflowTemplateCatalogEntry[] = [
  { key: "simple-chat", name: "Simple Chat Assistant", aliases: ["simple chat assistant", "simple chat"] },
  { key: "gmail-drive-bridge", name: "Google Workspace Bridge (Gmail/Drive)", aliases: ["gmail drive bridge", "google workspace bridge"] },
  { key: "pc-specs-tool-use", name: "Local PC Specs Assistant", aliases: ["pc specs", "local pc specs assistant", "pc specs assistant"] },
  { key: "devops-monitor", name: "DevOps System Monitor", aliases: ["devops monitor", "system monitor"] },
  { key: "smart-command-runner", name: "Smart Command Runner", aliases: ["smart command runner", "command runner"] },
  { key: "scheduled-health-check", name: "Scheduled Health Check", aliases: ["scheduled health check", "health check"] },
  { key: "cron-board-task-creator", name: "Cron Board Task Creator", aliases: ["cron board task creator", "cron board creator", "cron creator"] },
  { key: "google-api-integration", name: "Google API Integration (Gmail + Drive)", aliases: ["google api integration"] },
  { key: "integration-agent-bridge", name: "Integration Agent Bridge", aliases: ["integration agent bridge", "api integration agent", "generic integration agent", "integration bridge"] },
  { key: "hierarchy-orchestrator-team", name: "Hierarchy Team: Orchestrator + 2 Workers", aliases: ["hierarchy orchestrator team", "hierarchy team"] },
  { key: "code-runner-pipeline", name: "Code Runner Pipeline", aliases: ["code runner pipeline"] },
  { key: "file-processor", name: "File Processor Pipeline", aliases: ["file processor", "file processor pipeline"] },
  { key: "api-monitor", name: "API Monitor with Alerts", aliases: ["api monitor", "api monitor with alerts"] },
  { key: "email-summarizer", name: "Email Summarizer", aliases: ["email summarizer"] },
  { key: "daily-email-digest", name: "Daily Email Digest", aliases: ["daily email digest"] },
  { key: "smart-file-organizer", name: "Smart File Organizer", aliases: ["smart file organizer", "file organizer"] },
  { key: "code-reviewer", name: "Code Reviewer", aliases: ["code reviewer"] },
  { key: "research-assistant", name: "Research Assistant", aliases: ["research assistant"] },
  { key: "local-lead-enrichment", name: "Local Lead Enrichment", aliases: ["local lead enrichment", "lead enrichment", "lead research", "company enrichment"] },
  { key: "docs-site-crawler-summary", name: "Docs Site Crawler + Summary", aliases: ["docs site crawler summary", "docs site crawler", "docs crawler", "docs summary"] },
  { key: "document-intelligence", name: "Document Intelligence", aliases: ["document intelligence", "document analysis"] },
  { key: "automated-backup", name: "Automated Backup Monitor", aliases: ["automated backup", "backup monitor"] },
  { key: "multi-channel-router", name: "Multi-Channel Router", aliases: ["multi channel router", "channel router"] },
  { key: "telegram-board-intake", name: "Channel Board Assistant (Task Intake + List)", aliases: ["channel board assistant", "telegram board intake", "board intake"] },
  { key: "screenshot-analyzer", name: "Screenshot Analyzer", aliases: ["screenshot analyzer"] },
  { key: "git-status-reporter", name: "Git Status Reporter", aliases: ["git status reporter"] },
  { key: "local-api-tester", name: "Local API Tester", aliases: ["local api tester", "api tester", "api test"] },
  { key: "clipboard-to-memory", name: "Clipboard to Memory", aliases: ["clipboard to memory"] },
  { key: "error-resilient-pipeline", name: "Error-Resilient Pipeline", aliases: ["error resilient pipeline"] },
  { key: "text-processing-pipeline", name: "Text Processing Pipeline", aliases: ["text processing pipeline"] },
  { key: "db-query-dashboard", name: "Database Query Dashboard", aliases: ["database query dashboard", "db query dashboard", "database dashboard", "db dashboard"] },
  { key: "ops-control-tower", name: "Ops Control Tower", aliases: ["ops control tower", "control tower"] },
  { key: "hierarchy-board-briefing", name: "Hierarchy Board Briefing", aliases: ["hierarchy board briefing", "board briefing"] },
  { key: "general-task-executor", name: "General Task Executor", aliases: ["general task executor", "task executor", "general executor"] },
  { key: "channel-workspace-assistant", name: "Channel Workspace Assistant", aliases: ["channel workspace assistant", "workspace assistant", "channel assistant", "general assistant"] },
  { key: "autonomous-research-pipeline", name: "Autonomous Research Pipeline", aliases: ["autonomous research pipeline", "research pipeline", "arxiv pipeline", "auto research"] },
  { key: "experiment-loop", name: "Experiment Loop", aliases: ["experiment loop", "benchmark loop", "autoresearch", "pi autoresearch", "metric optimization", "optimization loop"] },
  { key: "ai-crew-orchestrator", name: "AI Crew Orchestrator (Disp8chTeam)", aliases: ["ai crew orchestrator", "disp8chteam orchestrator", "crew orchestrator", "multi-agent crew", "agent crew", "ai crew"] },
  { key: "parallel-spawn-crew", name: "Parallel Spawn Crew (Disp8chTeam)", aliases: ["parallel spawn crew", "disp8chteam parallel", "parallel crew", "fan-out crew", "spawn crew", "parallel workers"] },
  { key: "plan-gated-crew", name: "Plan-Gated Crew (Disp8chTeam)", aliases: ["plan gated crew", "plan approval crew", "crew plan review", "crew approval workflow"] },
  { key: "live-research-assistant", name: "Live Research Assistant", aliases: ["live research assistant", "live research", "web research assistant", "search assistant", "research with search"] },
  { key: "subconscious-loop", name: "Subconscious Self-Improvement Loop", aliases: ["subconscious loop", "subconscious agent", "self-improvement loop", "self improving agent", "agent self improvement", "improvement loop", "subconscious"] },
  { key: "short-video-generator", name: "Short Video Generator", aliases: ["short video generator", "video generator", "moneyprinter", "ai short video", "tiktok video", "reels generator", "shorts generator", "faceless video"] },
  { key: "trading-research-cycle", name: "Trading Research Cycle", aliases: ["trading research cycle", "trading cycle", "daily trading research", "autohedge cycle", "trading pipeline", "research cycle", "finance cycle"] },
  { key: "issue-triage-scheduler", name: "Issue Triage Scheduler", aliases: ["issue triage scheduler", "issue triage", "backlog triage", "nightly triage"] },
  { key: "pull-request-reviewer", name: "Pull Request Reviewer", aliases: ["pull request reviewer", "pr reviewer", "pr review webhook", "review pull request"] },
  { key: "docs-drift-detector", name: "Docs Drift Detector", aliases: ["docs drift detector", "docs drift", "documentation drift", "stale docs detector"] },
  { key: "dependency-vulnerability-scanner", name: "Dependency Vulnerability Scanner", aliases: ["dependency vulnerability scanner", "dependency security audit", "cve scan", "dependency audit", "vulnerability scanner"] },
  { key: "deploy-smoke-verifier", name: "Deploy Smoke Verifier", aliases: ["deploy smoke verifier", "deploy verification", "deployment verification", "smoke test deploy"] },
  { key: "incident-alert-correlator", name: "Incident Alert Correlator", aliases: ["incident alert correlator", "alert triage", "alert correlation", "incident triage"] },
  { key: "endpoint-uptime-watch", name: "Endpoint Uptime Watch", aliases: ["endpoint uptime watch", "uptime monitor", "uptime watch", "endpoint monitor"] },
  { key: "competitor-repo-watcher", name: "Competitor Repo Watcher", aliases: ["competitor repo watcher", "competitive repo scout", "repo scout", "competitor monitor"] },
  { key: "weekly-news-digest", name: "Weekly News Digest", aliases: ["weekly news digest", "news digest", "weekly ai news", "ai news digest"] },
  { key: "research-paper-scanner", name: "Research Paper Scanner", aliases: ["research paper scanner", "arxiv scan", "paper scanner", "daily arxiv scan", "arxiv digest"] },
  { key: "overnight-autonomy-briefing", name: "Overnight Autonomy Briefing", aliases: ["overnight autonomy", "overnight autonomy briefing", "while you sleep", "morning autonomy brief", "morning brief"] },
  { key: "strategy-hardening-loop", name: "Strategy Hardening Loop", aliases: ["strategy hardening", "strategy review loop", "research plan review", "adversarial plan review", "plan critique"] },
  { key: "support-signal-triage", name: "Support Signal Triage", aliases: ["support triage", "customer signal triage", "community signal triage", "support reply draft", "inbound signal review"] },
];

function normalizeReference(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

export function listWorkflowTemplateCatalog(): WorkflowTemplateCatalogEntry[] {
  return TEMPLATE_CATALOG.slice();
}

export function resolveWorkflowTemplateReference(reference: string): WorkflowTemplateCatalogEntry | null {
  const normalized = normalizeReference(reference);
  if (!normalized) return null;

  const exact =
    TEMPLATE_CATALOG.find((entry) => entry.key === normalized) ??
    TEMPLATE_CATALOG.find((entry) => normalizeReference(entry.name) === normalized) ??
    TEMPLATE_CATALOG.find((entry) => entry.aliases.some((alias) => normalizeReference(alias) === normalized));
  if (exact) {
    return exact;
  }

  return (
    TEMPLATE_CATALOG.find((entry) => {
      const haystacks = [entry.key, entry.name, ...entry.aliases].map(normalizeReference);
      return haystacks.some((candidate) => candidate.includes(normalized) || normalized.includes(candidate));
    }) ?? null
  );
}
