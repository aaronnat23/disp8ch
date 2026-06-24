export type ReleaseNoteSection = {
  title: string;
  items: string[];
};

export type ReleaseNote = {
  version: string;
  date: string;
  title: string;
  summary: string;
  sections: ReleaseNoteSection[];
};

export const releaseNotes: ReleaseNote[] = [
  {
    version: "1.1.1",
    date: "2026-06-24",
    title: "Workflow guardrails, reviewable memory, and OAuth setup",
    summary:
      "Workflow side effects now use a canonical approval boundary, durable memory proposals are reviewable and scope-safe, and first-model setup docs cover API keys, local models, Claude account OAuth, and optional Codex CLI delegation.",
    sections: [
      {
        title: "Workflow approval boundary",
        items: [
          "Every material workflow side effect is classified by one canonical effect model and checked immediately before its handler runs, including loops, retries, partial runs, sub-workflows, and dynamic runs.",
          "HTTP, SQL, git, system command, clipboard, document, scheduler, and board actions are classified from their actual configuration so read, write, external, destructive, and unknown effects get the correct policy.",
          "Durable approval grants are hash-bound to the exact workflow version, node, target, and payload, expire, are claimed once, and recheck policy before execution.",
          "Tools called inside AI Agent nodes inherit the workflow effect policy, so nested browser mutations, sends, HTTP writes, and destructive tools cannot bypass the workflow boundary.",
        ],
      },
      {
        title: "Workflow memory scope",
        items: [
          "New workflow nodes default to this-workflow memory, with agent-wide memory only when explicitly selected.",
          "Memory visibility is derived from runtime context before ranking, never from model-provided arguments.",
          "The AI Agent node can run with no durable memory, this-workflow memory, or full agent memory; this-workflow and no-durable modes exclude agent-wide MEMORY.md.",
          "Security audit now reports unknown-effect nodes, legacy agent-wide workflow memory, and unattended external sends without an approval policy.",
        ],
      },
      {
        title: "Reviewable memory candidates",
        items: [
          "WebChat learning, workflow results, Board tasks, Council verdicts, and notebook findings can create evidence-linked memory candidates instead of silently changing durable memory.",
          "Candidates stay out of retrieval until the operator applies them in Memory Explorer. Applying uses the same scoped atomic write path as direct memory, so workflow-private memory remains private.",
          "Duplicate candidates can reinforce an existing entry. Potentially conflicting facts or preferences are flagged for an explicit Keep both, Replace, Mark superseded, or Reject decision.",
          "Candidate reviews show the source, scope, evidence, an exact write preview, and an audit trail. WebChat candidates preserve the originating agent scope.",
        ],
      },
      {
        title: "Model setup docs",
        items: [
          "The README now explains the four first-model setup paths: online API key, local AI, Claude account OAuth, and Codex account sign-in.",
          "Help & Docs includes separate setup cards for Claude Code OAuth and Codex CLI sign-in, including what each path is for and how to test it safely.",
          "The public-release validator allows intentional Codex OAuth documentation while still rejecting private backend markers, local auth state, databases, and credential-shaped values.",
        ],
      },
    ],
  },
  {
    version: "1.1.0",
    date: "2026-06-23",
    title: "Local model intelligence and governed tools",
    summary:
      "Hardware-aware local model setup, governed MCP execution, stronger browser navigation, and a more rigorous public release process.",
    sections: [
      {
        title: "Local model setup",
        items: [
          "Check this PC now discovers installed GGUF files and local runtimes, reports hardware evidence, and recommends separate quality, balanced, and speed lanes.",
          "GGUF metadata and native llama.cpp fit evidence distinguish dense and MoE models, full-GPU fit, hybrid offload, memory risk, and already-loaded models.",
          "Already-running llama-server recommendations now use one concise readiness message instead of repeating status text and launch commands on every card.",
          "Successful connection tests can record measured calibration and show non-blocking model-fit advice without downloading, starting, or replacing a model automatically.",
        ],
      },
      {
        title: "MCP governance",
        items: [
          "MCP servers can be scoped to specific agents or organizations, and the same scope rules cover discovery and execution.",
          "Open, guarded, and strict postures control approval behavior without bypassing scope or the human floor for write and unknown tools.",
          "Pending MCP calls redact arguments, recheck scope before execution, run once, return results to the originating session, and appear in Attention Center.",
        ],
      },
      {
        title: "Design and WebChat reliability",
        items: [
          "Design requests containing feature cards or follow-up wording now remain in the Design Studio route instead of being mistaken for board work.",
          "Natural requests for browser navigation and other tool families now reach the agent tool loop instead of being mistaken for workflows or app-action plans.",
          "Browser navigation now presents compact semantic headings, articles, and list items before page chrome while preserving visible page order for local models.",
          "Single XML-style tool elements are detected before they can appear as user-facing WebChat answers.",
          "A paired live design run produced a persistent, responsive HTML artifact with preview, source, validation, and version history.",
        ],
      },
      {
        title: "Documentation and release quality",
        items: [
          "Help & Docs now includes this permanent, collapsible release history and links to the repository changelog.",
          "The README now explains the local model recommender as a simple Speed, Balanced, or Quality choice for non-technical users.",
          "The public exporter now includes the changelog and the release-note and tool-markup regression suites.",
          "The Windows-native release aggregate covers desktop, memory, automation, async delegation, MCP, model-fit, workflow, and public-release contracts.",
        ],
      },
    ],
  },
  {
    version: "1.0.0",
    date: "2026-06-23",
    title: "Initial public release",
    summary:
      "A local-first AI workspace that connects chat, agents, workflows, memory, source material, decisions, and tracked work.",
    sections: [
      {
        title: "Chat and agent work",
        items: [
          "Agentic WebChat can inspect app state, use tools, work across tabs, and return background-agent results to the same session.",
          "Short follow-up transformations reuse the active conversation and configured model without requiring a coding-account fallback.",
          "Work Monitor, Activity, attention notifications, and watch windows expose long-running work without blocking the main chat.",
        ],
      },
      {
        title: "Local and hosted models",
        items: [
          "Onboarding supports direct hosted providers, OpenRouter, Ollama, LM Studio, llama.cpp, vLLM, SGLang, and compatible endpoints.",
          "Check this PC reports CPU, RAM, GPU, and VRAM, then recommends quality, balanced, and speed lanes from installed or verified models.",
          "The advisor reads GGUF metadata, exact Ollama tags, native llama.cpp fit estimates, live calibration, and already-loaded local models.",
        ],
      },
      {
        title: "Workflows and operations",
        items: [
          "Visual workflows include templates, typed nodes, schedules, signed webhooks, approvals, replay, versions, queues, and run history.",
          "Boards, Hierarchy, Council, Dynamic Runs, and research departments turn requests into owned, auditable multi-agent work.",
          "Usage, costs, metrics, logs, Maintenance, and the Attention Center surface health, failures, and action needed.",
        ],
      },
      {
        title: "Knowledge and capabilities",
        items: [
          "Data Sources supports uploads, crawls, notebooks, notes, generated outputs, citations, and handoff into other tabs.",
          "Memory supports local embeddings, keyword fallback, reviewable learning, atomic updates, and cross-session recall.",
          "Skills, extensions, and MCP servers can be inspected, security-scanned, and scoped to agents or organizations.",
        ],
      },
      {
        title: "Design and desktop",
        items: [
          "Design Studio creates persistent HTML artifacts with uploads, preview, source editing, versions, validation, and export.",
          "The desktop shell adds hardened navigation, native notifications, command shortcuts, deep links, work monitoring, and database import.",
          "Update downloads remain checksum-gated; public installer signing and notarization are documented release-infrastructure steps.",
        ],
      },
      {
        title: "Security and release quality",
        items: [
          "Provider secrets use references and redaction, sensitive API routes require operator access, and mutating actions keep approval boundaries.",
          "Public-release export excludes databases, credentials, memories, auth state, generated user data, and private comparison artifacts.",
          "Windows-native release regressions cover desktop security, memory, automation, agent delegation, MCP, model fit, and workflow contracts.",
        ],
      },
    ],
  },
];

export const latestRelease = releaseNotes[0];
