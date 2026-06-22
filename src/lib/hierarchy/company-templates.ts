import { nanoid } from "nanoid";
import {
  createAgent,
  getAgentById,
  getDefaultAgent,
  updateAgent,
  type AgentRecord,
} from "@/lib/agents/registry";
import { updateAgentRole, type AgentRoleType } from "@/lib/agents/roles";
import {
  getBundledIntegrationPreset,
  type IntegrationPresetEntry,
} from "@/lib/extensions/registry";
import {
  createHierarchyGoal,
  type HierarchyGoalRecord,
} from "@/lib/hierarchy/goals";
import {
  applyHierarchyOrganization,
  saveHierarchyOrganizationSnapshot,
  type HierarchyOrganizationRecord,
  type HierarchyOrganizationSnapshotMember,
} from "@/lib/hierarchy/organizations";

type CompanyTemplateRoleSpec = {
  key: string;
  agentId?: string;
  roleType: AgentRoleType;
  roleTitle: string;
  roleDescription: string;
  reportsTo: string | null;
  capabilities: string[];
  spendCapUsd?: number | null;
  spendWindowDays?: number;
  budgetAction?: "warn" | "block";
  presetIds?: string[];
  disabledTools?: string[];
};

type CompanyTemplateGoalSpec = {
  key: string;
  name: string;
  description: string;
  parentKey?: string;
};

export type CompanyTemplateDefinition = {
  id: string;
  name: string;
  description: string;
  mission: string;
  tags: string[];
  roles: CompanyTemplateRoleSpec[];
  goals: CompanyTemplateGoalSpec[];
};

export type AppliedCompanyTemplate = {
  template: CompanyTemplateDefinition;
  organization: HierarchyOrganizationRecord;
  goals: HierarchyGoalRecord[];
  createdAgents: AgentRecord[];
};

const COMPANY_TEMPLATES: CompanyTemplateDefinition[] = [
  {
    id: "saas-launch",
    name: "SaaS Launch Company",
    description: "Product, growth, support, and operations structure for a shipping software company.",
    mission: "Ship a reliable SaaS product, grow qualified demand, and keep launch operations under control.",
    tags: ["launch", "product", "growth"],
    roles: [
      {
        key: "founder",
        agentId: "main",
        roleType: "orchestrator",
        roleTitle: "Founder / GM",
        roleDescription: "Owns company direction, approves launches, and breaks strategy into team goals.",
        reportsTo: null,
        capabilities: ["strategy", "delegation", "decision making"],
        presetIds: ["hierarchy-lead", "launch-manager"],
      },
      {
        key: "product",
        roleType: "operations",
        roleTitle: "Product Lead",
        roleDescription: "Owns roadmap, releases, and customer-facing priorities.",
        reportsTo: "founder",
        capabilities: ["roadmap", "requirements", "launch planning"],
        spendCapUsd: 2,
        presetIds: ["launch-manager"],
        disabledTools: ["bash_exec", "write_file"],
      },
      {
        key: "growth",
        roleType: "specialist",
        roleTitle: "Growth Lead",
        roleDescription: "Runs messaging, demand-generation experiments, and campaign tracking.",
        reportsTo: "founder",
        capabilities: ["positioning", "campaigns", "analytics"],
        spendCapUsd: 1,
        presetIds: ["research-analyst", "community-ops"],
        disabledTools: ["bash_exec", "run_python"],
      },
      {
        key: "support",
        roleType: "support",
        roleTitle: "Support Lead",
        roleDescription: "Handles issue intake, triage, and customer follow-through.",
        reportsTo: "product",
        capabilities: ["support", "triage", "knowledge base"],
        spendCapUsd: 1,
        presetIds: ["community-ops"],
        disabledTools: ["bash_exec", "run_python", "write_file"],
      },
      {
        key: "ops",
        roleType: "worker",
        roleTitle: "Ops Analyst",
        roleDescription: "Tracks launch readiness, QA, and handoff hygiene.",
        reportsTo: "product",
        capabilities: ["qa", "operations", "delivery"],
        spendCapUsd: 1,
        presetIds: ["ops-commander"],
      },
    ],
    goals: [
      {
        key: "launch",
        name: "Launch Readiness",
        description: "Coordinate launch criteria, rollout timing, and operational readiness.",
      },
      {
        key: "issues",
        name: "Customer Issue Documents",
        description: "Build issue-specific source packs and response playbooks for support and launch review.",
        parentKey: "launch",
      },
      {
        key: "growth",
        name: "Pipeline Experiments",
        description: "Run demand experiments tied to launch messaging and measured outcomes.",
        parentKey: "launch",
      },
    ],
  },
  {
    id: "client-services",
    name: "Client Services Company",
    description: "Consulting and delivery template with strategy, research, and execution roles.",
    mission: "Run a disciplined client-services company with scoped delivery, reusable research, and visible operations.",
    tags: ["agency", "consulting", "delivery"],
    roles: [
      {
        key: "director",
        agentId: "main",
        roleType: "orchestrator",
        roleTitle: "Managing Director",
        roleDescription: "Owns client portfolio strategy, staffing, and executive reviews.",
        reportsTo: null,
        capabilities: ["portfolio planning", "delegation", "governance"],
        presetIds: ["hierarchy-lead", "ops-commander"],
      },
      {
        key: "strategist",
        roleType: "operations",
        roleTitle: "Client Strategist",
        roleDescription: "Turns incoming work into scoped engagements, deliverables, and board tasks.",
        reportsTo: "director",
        capabilities: ["scoping", "client strategy", "briefing"],
        spendCapUsd: 2,
        presetIds: ["launch-manager"],
      },
      {
        key: "research",
        roleType: "specialist",
        roleTitle: "Research Lead",
        roleDescription: "Pulls data sources, produces client research briefs, and maintains reusable docs.",
        reportsTo: "strategist",
        capabilities: ["research", "documents", "analysis"],
        spendCapUsd: 1,
        presetIds: ["research-analyst"],
        disabledTools: ["bash_exec"],
      },
      {
        key: "delivery",
        roleType: "worker",
        roleTitle: "Delivery Manager",
        roleDescription: "Runs workflows, follow-ups, and milestone tracking for active engagements.",
        reportsTo: "strategist",
        capabilities: ["delivery", "workflows", "status reporting"],
        spendCapUsd: 1,
        presetIds: ["launch-manager", "ops-commander"],
      },
    ],
    goals: [
      {
        key: "portfolio",
        name: "Portfolio Health",
        description: "Keep active engagements on track with clear owners, deliverables, and follow-up documents.",
      },
      {
        key: "docs",
        name: "Issue Documents",
        description: "Attach and summarize source documents for each client issue or project request.",
        parentKey: "portfolio",
      },
    ],
  },
  {
    id: "support-ops",
    name: "Support Operations Company",
    description: "Support-heavy org with incident, triage, and automation coverage.",
    mission: "Resolve customer issues quickly, keep incident loops tight, and automate repetitive support work.",
    tags: ["support", "incidents", "automation"],
    roles: [
      {
        key: "head",
        agentId: "main",
        roleType: "orchestrator",
        roleTitle: "Head of Support",
        roleDescription: "Owns service quality, escalations, and operating cadence.",
        reportsTo: null,
        capabilities: ["support leadership", "escalations", "governance"],
        presetIds: ["hierarchy-lead", "ops-commander"],
      },
      {
        key: "incident",
        roleType: "operations",
        roleTitle: "Incident Commander",
        roleDescription: "Coordinates active incidents, response timelines, and escalation paths.",
        reportsTo: "head",
        capabilities: ["incident response", "coordination", "communications"],
        spendCapUsd: 2,
        presetIds: ["ops-commander"],
      },
      {
        key: "knowledge",
        roleType: "specialist",
        roleTitle: "Knowledge Curator",
        roleDescription: "Maintains issue documents, runbooks, and source-grounded support answers.",
        reportsTo: "incident",
        capabilities: ["knowledge base", "documents", "summaries"],
        spendCapUsd: 1,
        presetIds: ["research-analyst"],
        disabledTools: ["bash_exec", "run_python"],
      },
      {
        key: "automation",
        roleType: "worker",
        roleTitle: "Automation Analyst",
        roleDescription: "Builds and maintains support workflows, routing, and escalation automations.",
        reportsTo: "incident",
        capabilities: ["workflow automation", "triage", "handoffs"],
        spendCapUsd: 1,
        presetIds: ["ops-commander", "launch-manager"],
      },
    ],
    goals: [
      {
        key: "sla",
        name: "SLA Discipline",
        description: "Track issue queues, escalations, and completion times without losing source context.",
      },
      {
        key: "docs",
        name: "Issue Documents",
        description: "Create source-backed issue packets for every escalation and recurring support problem.",
        parentKey: "sla",
      },
      {
        key: "auto",
        name: "Auto-mode Support Loops",
        description: "Automate repetitive support triage and follow-up tasks while keeping approvals visible.",
        parentKey: "sla",
      },
    ],
  },
  {
    id: "research-lab",
    name: "AI Research Lab",
    description: "Autonomous research pipeline inspired by AutoResearchDisp8ch — literature discovery, hypothesis generation, experiment execution, and paper writing.",
    mission: "Turn research ideas into validated results with reproducible experiments, real citations, and publication-ready outputs.",
    tags: ["research", "ai", "experiments", "papers"],
    roles: [
      {
        key: "pi",
        agentId: "main",
        roleType: "orchestrator",
        roleTitle: "Principal Investigator",
        roleDescription: "Sets research direction, reviews hypotheses, approves experiment designs, and makes publish/pivot decisions.",
        reportsTo: null,
        capabilities: ["research strategy", "hypothesis validation", "paper review", "delegation"],
        presetIds: ["hierarchy-lead", "autonomous-researcher"],
      },
      {
        key: "literature",
        roleType: "specialist",
        roleTitle: "Literature Analyst",
        roleDescription: "Searches arXiv, Semantic Scholar, and OpenAlex for related work. Screens papers for relevance, extracts key findings, and builds structured literature reviews.",
        reportsTo: "pi",
        capabilities: ["literature search", "citation verification", "knowledge synthesis"],
        spendCapUsd: 2,
        presetIds: ["autonomous-researcher", "research-analyst"],
        disabledTools: ["bash_exec", "write_file"],
      },
      {
        key: "experiment",
        roleType: "specialist",
        roleTitle: "Experiment Engineer",
        roleDescription: "Designs experiments, generates executable code, runs benchmarks in sandboxed environments, and handles self-healing when code fails.",
        reportsTo: "pi",
        capabilities: ["experiment design", "code generation", "benchmarking", "self-healing"],
        spendCapUsd: 3,
        presetIds: ["coding-agent"],
      },
      {
        key: "analyst",
        roleType: "worker",
        roleTitle: "Data Analyst",
        roleDescription: "Analyzes experiment results, generates comparison charts, runs statistical tests, and decides whether to proceed, refine, or pivot.",
        reportsTo: "experiment",
        capabilities: ["statistical analysis", "data visualization", "result interpretation"],
        spendCapUsd: 1,
        presetIds: ["research-analyst"],
        disabledTools: ["bash_exec"],
      },
      {
        key: "writer",
        roleType: "worker",
        roleTitle: "Technical Writer",
        roleDescription: "Drafts paper sections, conducts internal peer review, checks evidence-methodology consistency, and formats final outputs in markdown and LaTeX.",
        reportsTo: "pi",
        capabilities: ["academic writing", "peer review", "citation formatting", "LaTeX"],
        spendCapUsd: 1,
        presetIds: ["research-analyst"],
        disabledTools: ["bash_exec", "run_python"],
      },
    ],
    goals: [
      {
        key: "pipeline",
        name: "Research Pipeline",
        description: "Complete the end-to-end research cycle: literature review, hypothesis, experiments, analysis, and written report.",
      },
      {
        key: "literature",
        name: "Literature Review",
        description: "Discover and synthesize relevant papers from arXiv, Semantic Scholar, and other sources with verified citations.",
        parentKey: "pipeline",
      },
      {
        key: "experiments",
        name: "Experiment Validation",
        description: "Design, execute, and analyze experiments with reproducible code and statistical rigor.",
        parentKey: "pipeline",
      },
      {
        key: "paper",
        name: "Paper Draft",
        description: "Write a publication-ready paper with proper structure, citations, figures, and peer-reviewed quality.",
        parentKey: "pipeline",
      },
    ],
  },
  {
    id: "optimization-lab",
    name: "Optimization Lab",
    description: "Metric-driven experiment loop inspired by pi-autoresearch — continuous benchmarking, optimization, and automated keep/revert decisions.",
    mission: "Iteratively optimize any measurable target through disciplined experiment cycles with statistical confidence tracking.",
    tags: ["optimization", "benchmarks", "experiments", "metrics"],
    roles: [
      {
        key: "lead",
        agentId: "main",
        roleType: "orchestrator",
        roleTitle: "Optimization Lead",
        roleDescription: "Defines optimization objectives, sets benchmark commands and target metrics, reviews experiment results, and decides when to stop.",
        reportsTo: null,
        capabilities: ["objective setting", "experiment review", "keep/revert decisions", "delegation"],
        presetIds: ["hierarchy-lead", "coding-agent"],
      },
      {
        key: "implementer",
        roleType: "specialist",
        roleTitle: "Implementation Engineer",
        roleDescription: "Proposes code changes, implements optimizations, and commits changes. Handles self-healing when experiments crash or produce invalid results.",
        reportsTo: "lead",
        capabilities: ["code optimization", "implementation", "self-healing", "git operations"],
        spendCapUsd: 3,
        presetIds: ["coding-agent"],
      },
      {
        key: "benchmarker",
        roleType: "worker",
        roleTitle: "Benchmark Runner",
        roleDescription: "Executes benchmark commands, parses METRIC output, runs backpressure checks (tests, type-checks), and logs results to the experiment journal.",
        reportsTo: "implementer",
        capabilities: ["benchmarking", "metric parsing", "test execution", "result logging"],
        spendCapUsd: 2,
        presetIds: ["coding-agent"],
      },
    ],
    goals: [
      {
        key: "optimize",
        name: "Optimization Cycle",
        description: "Run iterative experiment loops: propose change, benchmark, analyze, keep or revert, repeat until target is met.",
      },
      {
        key: "baseline",
        name: "Establish Baseline",
        description: "Run initial benchmarks to establish baseline metrics and confidence intervals before optimization begins.",
        parentKey: "optimize",
      },
      {
        key: "iterate",
        name: "Iterative Improvement",
        description: "Execute optimization iterations with statistical confidence tracking (MAD scoring after 3+ runs) and automatic keep/revert.",
        parentKey: "optimize",
      },
    ],
  },
  {
    id: "content-studio",
    name: "Content Studio",
    description: "Social media content pipeline — plan, write, design, schedule, and post across channels with analytics tracking.",
    mission: "Produce consistent, high-quality content across social platforms with a repeatable planning-to-publishing workflow.",
    tags: ["content", "social-media", "marketing", "publishing"],
    roles: [
      {
        key: "director",
        agentId: "main",
        roleType: "orchestrator",
        roleTitle: "Content Director",
        roleDescription: "Owns the content calendar, approves posts before publishing, sets brand voice guidelines, and reviews performance reports.",
        reportsTo: null,
        capabilities: ["content strategy", "brand voice", "editorial review", "delegation"],
        presetIds: ["hierarchy-lead", "content-curator"],
      },
      {
        key: "strategist",
        roleType: "specialist",
        roleTitle: "Content Strategist",
        roleDescription: "Researches trending topics, analyzes competitor content, plans the weekly content calendar, and identifies high-engagement opportunities.",
        reportsTo: "director",
        capabilities: ["trend research", "competitor analysis", "content planning", "SEO"],
        spendCapUsd: 2,
        presetIds: ["content-curator", "research-analyst"],
        disabledTools: ["bash_exec", "run_python"],
      },
      {
        key: "writer",
        roleType: "worker",
        roleTitle: "Copywriter",
        roleDescription: "Writes post captions, blog drafts, video scripts, and newsletter copy. Adapts tone per platform (professional for LinkedIn, casual for Twitter, visual-first for Instagram).",
        reportsTo: "strategist",
        capabilities: ["copywriting", "caption writing", "blog drafts", "platform adaptation"],
        spendCapUsd: 2,
        presetIds: ["content-curator"],
        disabledTools: ["bash_exec", "run_python"],
      },
      {
        key: "scheduler",
        roleType: "worker",
        roleTitle: "Publishing Scheduler",
        roleDescription: "Formats approved content for each platform, schedules posts at optimal times, manages the publishing queue, and tracks post-publish engagement.",
        reportsTo: "director",
        capabilities: ["scheduling", "cross-posting", "engagement tracking", "analytics"],
        spendCapUsd: 1,
        presetIds: ["community-ops", "ops-commander"],
        disabledTools: ["run_python"],
      },
    ],
    goals: [
      {
        key: "pipeline",
        name: "Content Pipeline",
        description: "Maintain a full plan-to-publish pipeline: ideation, writing, review, scheduling, and performance tracking.",
      },
      {
        key: "calendar",
        name: "Weekly Content Calendar",
        description: "Plan and fill the weekly content calendar with platform-specific posts, stories, and threads.",
        parentKey: "pipeline",
      },
      {
        key: "engagement",
        name: "Engagement & Analytics",
        description: "Track post performance, identify top-performing formats, and feed insights back into the content strategy.",
        parentKey: "pipeline",
      },
    ],
  },
  {
    id: "sales-outreach",
    name: "Sales Outreach Team",
    description: "Automated prospecting and outreach — research leads, personalize messages, manage follow-ups, and track pipeline.",
    mission: "Build a repeatable outbound sales pipeline with researched leads, personalized outreach, and disciplined follow-up cadences.",
    tags: ["sales", "outreach", "leads", "crm"],
    roles: [
      {
        key: "manager",
        agentId: "main",
        roleType: "orchestrator",
        roleTitle: "Sales Manager",
        roleDescription: "Sets target accounts and ICPs, reviews outreach sequences before sending, monitors pipeline metrics, and decides when to escalate or pause campaigns.",
        reportsTo: null,
        capabilities: ["pipeline management", "target setting", "campaign review", "delegation"],
        presetIds: ["hierarchy-lead", "ops-commander"],
      },
      {
        key: "researcher",
        roleType: "specialist",
        roleTitle: "Lead Researcher",
        roleDescription: "Finds and qualifies prospect companies and contacts. Gathers firmographic data, tech stack info, recent news, and pain-point signals to build lead profiles.",
        reportsTo: "manager",
        capabilities: ["prospect research", "lead qualification", "firmographics", "signal detection"],
        spendCapUsd: 2,
        presetIds: ["research-analyst", "content-curator"],
        disabledTools: ["bash_exec", "run_python", "write_file"],
      },
      {
        key: "copywriter",
        roleType: "worker",
        roleTitle: "Outreach Copywriter",
        roleDescription: "Writes personalized cold emails, LinkedIn messages, and follow-up sequences using lead research data. A/B tests subject lines and CTAs.",
        reportsTo: "manager",
        capabilities: ["cold email", "personalization", "A/B testing", "follow-up sequences"],
        spendCapUsd: 1,
        presetIds: ["content-curator"],
        disabledTools: ["bash_exec", "run_python"],
      },
      {
        key: "ops",
        roleType: "worker",
        roleTitle: "Sales Ops Analyst",
        roleDescription: "Tracks pipeline metrics (open rates, reply rates, meetings booked), manages the CRM board, and produces weekly pipeline reports.",
        reportsTo: "manager",
        capabilities: ["pipeline analytics", "CRM management", "reporting", "forecasting"],
        spendCapUsd: 1,
        presetIds: ["ops-commander", "research-analyst"],
        disabledTools: ["bash_exec"],
      },
    ],
    goals: [
      {
        key: "pipeline",
        name: "Outbound Pipeline",
        description: "Build and maintain a healthy outbound pipeline from research through qualification to booked meetings.",
      },
      {
        key: "leads",
        name: "Lead Research & Qualification",
        description: "Identify and qualify target accounts with enriched profiles, pain-point signals, and engagement scoring.",
        parentKey: "pipeline",
      },
      {
        key: "sequences",
        name: "Outreach Sequences",
        description: "Run personalized multi-touch outreach campaigns with A/B tested messaging and automated follow-ups.",
        parentKey: "pipeline",
      },
    ],
  },
  {
    id: "devops-crew",
    name: "DevOps & SRE Crew",
    description: "Infrastructure monitoring, incident response, and deployment automation with on-call coordination.",
    mission: "Keep systems reliable with proactive monitoring, fast incident response, and safe automated deployments.",
    tags: ["devops", "sre", "monitoring", "incidents"],
    roles: [
      {
        key: "lead",
        agentId: "main",
        roleType: "orchestrator",
        roleTitle: "SRE Lead",
        roleDescription: "Owns reliability targets and SLOs, coordinates incident response, approves deployment rollouts, and reviews post-mortems.",
        reportsTo: null,
        capabilities: ["SLO management", "incident coordination", "deployment approval", "delegation"],
        presetIds: ["hierarchy-lead", "ops-commander"],
      },
      {
        key: "monitor",
        roleType: "specialist",
        roleTitle: "Monitoring Engineer",
        roleDescription: "Watches dashboards and alerting systems, detects anomalies, triages incoming alerts, and escalates genuine incidents to the on-call responder.",
        reportsTo: "lead",
        capabilities: ["monitoring", "alerting", "anomaly detection", "triage"],
        spendCapUsd: 2,
        presetIds: ["ops-commander"],
        disabledTools: ["write_file"],
      },
      {
        key: "responder",
        roleType: "specialist",
        roleTitle: "Incident Responder",
        roleDescription: "Diagnoses active incidents, runs remediation playbooks, performs rollbacks when needed, and writes post-incident summaries.",
        reportsTo: "lead",
        capabilities: ["incident diagnosis", "remediation", "rollback", "post-mortems"],
        spendCapUsd: 3,
        presetIds: ["coding-agent", "ops-commander"],
      },
      {
        key: "deployer",
        roleType: "worker",
        roleTitle: "Deploy Automation",
        roleDescription: "Manages CI/CD pipelines, runs pre-deployment checks, executes staged rollouts, and verifies deployment health after release.",
        reportsTo: "lead",
        capabilities: ["CI/CD", "staged rollout", "health checks", "deployment verification"],
        spendCapUsd: 2,
        presetIds: ["coding-agent"],
      },
    ],
    goals: [
      {
        key: "reliability",
        name: "System Reliability",
        description: "Maintain uptime SLOs, minimize MTTR, and keep deployment failure rate below target thresholds.",
      },
      {
        key: "monitoring",
        name: "Proactive Monitoring",
        description: "Detect and triage issues before they become user-facing incidents through dashboards, alerts, and anomaly detection.",
        parentKey: "reliability",
      },
      {
        key: "deployments",
        name: "Safe Deployments",
        description: "Automate deployment pipelines with pre-checks, staged rollouts, and automated rollback on failure.",
        parentKey: "reliability",
      },
    ],
  },
  {
    id: "trading-research-desk",
    name: "Trading Research Desk",
    description: "Multi-asset research team that turns natural-language finance questions into strategies, backtests, risk reports, and sim-only trade proposals. Research-only — never places live orders.",
    mission: "Generate evidence-backed investment theses across equities, crypto, futures, and forex, with reproducible backtests, explicit risk framing, and simulated execution artifacts only.",
    tags: ["finance", "research", "quant", "multi-agent", "trading"],
    roles: [
      {
        key: "pm",
        agentId: "main",
        roleType: "orchestrator",
        roleTitle: "Portfolio Manager / Research Director",
        roleDescription: "Frames research questions, picks which specialists to dispatch, runs the daily decision cycle, and synthesizes the final investment memo. Reviews all sim-only execution proposals before any human action.",
        reportsTo: null,
        capabilities: ["thesis framing", "delegation", "memo synthesis", "daily cycle ownership"],
        presetIds: ["hierarchy-lead"],
      },
      {
        key: "quant",
        roleType: "specialist",
        roleTitle: "Quant Analyst",
        roleDescription: "Builds factor screens, runs reproducible backtests, and scores candidates with technical, momentum, and volume signals. Uses run_python_script for pandas, yfinance, and ccxt.",
        reportsTo: "pm",
        capabilities: ["factor analysis", "backtesting", "statistics", "candidate scoring"],
        spendCapUsd: 5,
        spendWindowDays: 30,
        budgetAction: "warn",
      },
      {
        key: "macro",
        roleType: "specialist",
        roleTitle: "Macro Analyst",
        roleDescription: "Tracks rates, FX, commodities, and macro regimes. Uses web_search and fetch_url for live news and central-bank releases. Never executes shell commands.",
        reportsTo: "pm",
        capabilities: ["macro", "regime detection", "news synthesis"],
        spendCapUsd: 3,
        spendWindowDays: 30,
        budgetAction: "warn",
        disabledTools: ["bash_exec"],
      },
      {
        key: "crypto",
        roleType: "specialist",
        roleTitle: "Crypto Analyst",
        roleDescription: "Funding rates, on-chain flow, liquidation maps, and stablecoin movement. Calls OKX and CCXT via http_request or run_python_script. Research-only.",
        reportsTo: "pm",
        capabilities: ["crypto", "on-chain", "perp funding", "DEX flow"],
        spendCapUsd: 3,
        spendWindowDays: 30,
        budgetAction: "warn",
      },
      {
        key: "risk",
        roleType: "specialist",
        roleTitle: "Risk Manager",
        roleDescription: "Sizes positions, computes drawdown, VaR, and Monte Carlo CI, and gates every execution artifact. No artifact ships without risk sign-off. Cannot write files or run shell commands.",
        reportsTo: "pm",
        capabilities: ["position sizing", "VaR", "drawdown", "Monte Carlo"],
        spendCapUsd: 2,
        spendWindowDays: 30,
        budgetAction: "warn",
        disabledTools: ["bash_exec", "write_file"],
      },
      {
        key: "data-eng",
        roleType: "worker",
        roleTitle: "Data Engineer",
        roleDescription: "Owns data freshness, source fallback from yfinance to AKShare to CCXT, reproducible fixtures, and timestamp provenance for all research artifacts.",
        reportsTo: "pm",
        capabilities: ["data pipelines", "source fallback", "fixtures", "provenance"],
        spendCapUsd: 2,
        spendWindowDays: 30,
        budgetAction: "warn",
      },
      {
        key: "exec-sim",
        roleType: "worker",
        roleTitle: "Execution Sim",
        roleDescription: "Writes proposed_orders.json artifacts from Risk-Manager-approved candidates. Has NO exchange or broker access. Can only write_file under data/research/. Never places live orders.",
        reportsTo: "risk",
        capabilities: ["order sim", "artifact emit"],
        spendCapUsd: 1,
        spendWindowDays: 30,
        budgetAction: "block",
        disabledTools: ["bash_exec", "http_request", "fetch_url", "browser_action", "send_message", "web_search", "web_extract", "web_crawl"],
      },
    ],
    goals: [
      {
        key: "g1",
        name: "Idea Generation Cycle",
        description: "Weekly screen produces top-5 ideas and at least one investment memo.",
      },
      {
        key: "g2",
        name: "Backtest Discipline",
        description: "Every memo carries a reproducible backtest with Monte Carlo CI and explicit data source citations.",
        parentKey: "g1",
      },
      {
        key: "g3",
        name: "Risk Gate",
        description: "No proposed_orders.json artifact ships without Risk Manager sign-off. All artifacts include a data_fetched_at timestamp.",
      },
      {
        key: "g4",
        name: "Multi-Asset Coverage",
        description: "Equities, crypto, futures, and FX are each reviewed at least once per quarter.",
      },
      {
        key: "g5",
        name: "Reproducibility",
        description: "All notebooks, SQL, and scripts are saved under data/research/ for audit and replay.",
        parentKey: "g3",
      },
      {
        key: "g6",
        name: "Execution Sim-Only",
        description: "Execution Sim role is sandboxed to write_file only — never places live broker or exchange orders.",
        parentKey: "g3",
      },
    ],
  },
];

function uniq(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = String(value || "").trim();
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function mergePresetConfig(presetIds: string[] | undefined): {
  enabledExtensions: string[];
  enabledSkills: string[];
} {
  const presets = (presetIds ?? [])
    .map((presetId) => getBundledIntegrationPreset(presetId))
    .filter(Boolean) as IntegrationPresetEntry[];
  return {
    enabledExtensions: uniq(presets.flatMap((preset) => preset.extensions)),
    enabledSkills: uniq(presets.flatMap((preset) => preset.skills)),
  };
}

/**
 * Build a readable, short template agent display name from the role title.
 * Org association is preserved via the organization snapshot, not by embedding
 * the org name in every agent's display name (which made topology cards
 * unreadable). Falls back to an org-scoped label only when no role title exists.
 */
function buildTemplateAgentName(roleTitle: string, organizationName: string): string {
  return roleTitle.trim() || `${organizationName} Agent`;
}

function normalizeTemplateAgentId(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || `agent-${nanoid(6).toLowerCase()}`;
}

/**
 * Produce a unique display name + id for a template agent. On collision, append
 * a short numeric suffix to the display name (e.g. "Product Lead 2") rather than
 * embedding the full organization name.
 */
function buildUniqueTemplateAgent(baseName: string): { name: string; id: string } {
  let candidate = baseName;
  let candidateId = normalizeTemplateAgentId(candidate);
  let suffix = 2;
  while (getAgentById(candidateId)) {
    candidate = `${baseName} ${suffix}`;
    candidateId = normalizeTemplateAgentId(candidate);
    suffix += 1;
  }
  return { name: candidate, id: candidateId };
}

function buildSnapshotMember(params: {
  agent: AgentRecord;
  roleType: AgentRoleType;
  roleTitle: string;
  roleDescription: string;
  reportsTo: string | null;
  capabilities: string[];
}): HierarchyOrganizationSnapshotMember {
  return {
    agent: {
      id: params.agent.id,
      name: params.agent.name,
      workspacePath: params.agent.workspacePath,
      modelRef: params.agent.modelRef,
      disabledTools: params.agent.disabledTools,
      enabledExtensions: params.agent.enabledExtensions,
      enabledSkills: params.agent.enabledSkills,
      isDefault: params.agent.isDefault,
      isActive: params.agent.isActive,
    },
    role: {
      roleType: params.roleType,
      roleTitle: params.roleTitle,
      roleDescription: params.roleDescription,
      reportsTo: params.reportsTo,
      capabilities: params.capabilities,
      voteWeight: params.roleType === "orchestrator" ? 2 : 1,
    },
  };
}

export function listCompanyTemplates(): CompanyTemplateDefinition[] {
  return COMPANY_TEMPLATES.slice();
}

export function getCompanyTemplate(templateIdRaw: string): CompanyTemplateDefinition | null {
  const templateId = String(templateIdRaw || "").trim();
  if (!templateId) return null;
  return COMPANY_TEMPLATES.find((template) => template.id === templateId) ?? null;
}

export function applyCompanyTemplate(input: {
  templateId: string;
  organizationName?: string | null;
  activate?: boolean;
}): AppliedCompanyTemplate {
  const template = getCompanyTemplate(input.templateId);
  if (!template) {
    throw new Error(`Unknown company template: ${input.templateId}`);
  }

  const organizationName =
    String(input.organizationName || "").trim() ||
    `${template.name} ${new Date().toISOString().slice(0, 10)}`;
  const defaultAgent = getDefaultAgent();
  const createdAgents: AgentRecord[] = [];
  const snapshotMembers: HierarchyOrganizationSnapshotMember[] = [];
  const agentIdsByRoleKey = new Map<string, string>();
  const pendingRoles: Array<{
    agent: AgentRecord;
    spec: CompanyTemplateRoleSpec;
  }> = [];

  for (const spec of template.roles) {
    const merged = mergePresetConfig(spec.presetIds);
    let agent: AgentRecord;
    if (spec.agentId === "main") {
      agent = getAgentById(defaultAgent.id) ?? defaultAgent;
      agent = updateAgent(agent.id, {
        enabledExtensions: uniq([...merged.enabledExtensions]),
        enabledSkills: uniq([...merged.enabledSkills]),
        disabledTools: uniq(spec.disabledTools ?? []),
        isActive: true,
        isDefault: true,
      });
    } else {
      const baseName = buildTemplateAgentName(spec.roleTitle, organizationName);
      const unique = buildUniqueTemplateAgent(baseName);
      agent = createAgent({
        name: unique.name,
        id: unique.id,
        enabledExtensions: merged.enabledExtensions,
        enabledSkills: merged.enabledSkills,
        disabledTools: uniq(spec.disabledTools ?? []),
        spendCapUsd: spec.spendCapUsd ?? null,
        spendWindowDays: spec.spendWindowDays ?? 30,
        budgetAction: spec.budgetAction ?? "warn",
      });
      createdAgents.push(agent);
    }
    agentIdsByRoleKey.set(spec.key, agent.id);
    pendingRoles.push({ agent, spec });
  }

  for (const entry of pendingRoles) {
    const reportsTo =
      entry.spec.reportsTo && agentIdsByRoleKey.has(entry.spec.reportsTo)
        ? agentIdsByRoleKey.get(entry.spec.reportsTo) ?? null
        : null;
    updateAgentRole(entry.agent.id, {
      roleType: entry.spec.roleType,
      roleTitle: entry.spec.roleTitle,
      roleDescription: entry.spec.roleDescription,
      reportsTo,
      capabilities: entry.spec.capabilities,
    });
    const refreshed = getAgentById(entry.agent.id) ?? entry.agent;
    snapshotMembers.push(
      buildSnapshotMember({
        agent: refreshed,
        roleType: entry.spec.roleType,
        roleTitle: entry.spec.roleTitle,
        roleDescription: entry.spec.roleDescription,
        reportsTo,
        capabilities: entry.spec.capabilities,
      }),
    );
  }

  const organization = saveHierarchyOrganizationSnapshot({
    name: organizationName,
    description: template.description,
    mission: template.mission,
    activate: input.activate !== false,
    snapshot: snapshotMembers,
  });

  const goals: HierarchyGoalRecord[] = [];
  const goalIdsByKey = new Map<string, string>();
  for (const goal of template.goals) {
    const created = createHierarchyGoal({
      name: goal.name,
      description: goal.description,
      organizationId: organization.id,
      parentGoalId: goal.parentKey ? goalIdsByKey.get(goal.parentKey) ?? null : null,
    });
    goals.push(created);
    goalIdsByKey.set(goal.key, created.id);
  }

  const activeOrganization =
    input.activate === false ? organization : applyHierarchyOrganization(organization.id);

  return {
    template,
    organization: activeOrganization,
    goals,
    createdAgents,
  };
}
