import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SurfaceHeader } from "@/components/app/surface-header";
import { WebChatDraftButton } from "@/components/app/webchat-draft-button";
import { latestRelease, releaseNotes } from "@/lib/release-notes";

const quickstartSteps = [
  {
    title: "Add an LLM",
    body:
      "Open Settings -> Models and add at least one active provider. Use a direct hosted provider, route many hosted models through OpenRouter, or point disp8ch at a local OpenAI-compatible server such as Ollama, llama.cpp, LM Studio, vLLM, or SGLang.",
    href: "/settings",
    label: "Open Settings",
  },
  {
    title: "Create or inspect your first agent",
    body:
      "Open Agents and confirm the default agent is active. This is where you tune model overrides, roles, tool access, extensions, skills, and workspace files.",
    href: "/agents",
    label: "Open Agents",
  },
  {
    title: "Connect a channel",
    body:
      "Open Channels and connect Telegram, WhatsApp, Slack, Discord, Teams, or use WebChat. All of them route through the same core command/workflow path.",
    href: "/channels",
    label: "Open Channels",
  },
  {
    title: "Run a workflow or board task",
    body:
      "Use Workflows to create a template-based flow, inspect Dynamic Runs, or use Boards to create workflow-backed tasks that agents can run from chat or the UI.",
    href: "/workflows",
    label: "Open Workflows",
  },
  {
    title: "Use Hierarchy when work needs structure",
    body:
      "Open Hierarchy to assign organizations, goals, owners, source packs, related workflows, heartbeats, and spend tracking. Use it when work needs company-style structure instead of only a chat thread.",
    href: "/hierarchy",
    label: "Open Hierarchy",
  },
];

const installPaths = [
  {
    name: "One-Line Install",
    badge: "Easiest",
    summary: "Use this for non-technical users. The scripts download a managed Node.js 22 runtime if needed, use Corepack or npx pnpm, install dependencies, initialize a clean workspace, start Disp8ch, and open onboarding.",
    bullets: [
      "Linux/macOS/WSL: `curl -fsSL https://raw.githubusercontent.com/<user>/<repo>/main/scripts/install.sh | bash -s -- --repo https://github.com/<user>/<repo>.git`.",
      "Windows PowerShell: set `DISP8CH_SOURCE_ZIP_URL` to the repo zip URL, then run `iex (irm \"https://raw.githubusercontent.com/<user>/<repo>/main/scripts/install-windows.ps1\")`.",
      "Use `--no-start` or `-NoStart` when you only want to install and configure without starting the server.",
      "Replace `<user>/<repo>` with the final GitHub owner/repo after publishing.",
    ],
  },
  {
    name: "Desktop Installer",
    badge: "Release",
    summary: "Use the platform installer when public desktop releases are available. Local Windows NSIS builds are verified, but public signing/notarization is still the release gate.",
    bullets: [
      "Windows local build: `pnpm.cmd desktop:dist -- --win` creates `dist/desktop/disp8ch AI-Setup-1.0.0-x64.exe` plus checksums.",
      "The desktop app creates `%LOCALAPPDATA%\\disp8ch AI`, opens onboarding, and exposes Run Doctor, Check For Updates, and Import Existing Database from the native menu.",
      "Update checks read `DISP8CH_DESKTOP_UPDATE_URL` or `DISP8CH_UPDATE_MANIFEST_URL`; URL-bearing artifacts can be downloaded and SHA-256 verified when enabled. Running the installer and restarting remain manual until signed auto-update releases are configured.",
    ],
  },
  {
    name: "Manual Source Install",
    badge: "Developer",
    summary: "Use this when editing the repo or running benchmark harnesses.",
    bullets: [
      "Requires Node 22.13+ and pnpm 10.30.2.",
      "Run Node, pnpm, DB commands, and local server curl checks from Windows `cmd.exe` or PowerShell when doing benchmark-quality local comparisons.",
      "Use `dpc health`, `dpc doctor --json`, and `dpc update --dry-run --json` to inspect install state without mutating files.",
    ],
  },
];

const coreTabs = [
  {
    name: "Boards",
    href: "/boards",
    badge: "Operate",
    summary: "Turn requests into tracked work, assign owners, and run workflow-backed tasks.",
    bullets: [
      "Use quick tasks for lightweight queueing and template tasks when work should spin up a real workflow.",
      "Board tasks can be created from Data Sources, chat commands, hierarchy follow-ups, or workflow outputs.",
      "Use this tab when you want a visible queue, ownership, and run history instead of leaving work in chat.",
    ],
  },
  {
    name: "Workflows",
    href: "/workflows",
    badge: "Automate",
    summary: "Create visual flows, start from templates, and wire triggers, agents, tools, memory, and channels together.",
    bullets: [
      "Templates are the fastest starting point. Use them for scheduler jobs, board helpers, research, docs crawling, and crew orchestration.",
      "Agent nodes respect the selected agent profile, including enabled skills, extensions, model override, and workspace instructions.",
      "Dry-run now reports graph order, trigger detection, node compatibility, mutating-node simulation, and lint findings before execution.",
      "Dynamic Runs are the long-running orchestration layer: `/loop <objective>` creates phase/worker runs, `/loop status` inspects progress, and `/loop pause|resume|cancel` controls execution.",
      "Use the Project Manager Agent Harness when a repo task needs triage, research, implementation or recommendation, review, command checks, browser checks, screenshots, and final synthesis.",
      "Use Workflows when the same task should run repeatedly or needs explicit branching, tools, or channel delivery.",
    ],
  },
  {
    name: "Agents",
    href: "/agents",
    badge: "Configure",
    summary: "Define who does the work: model choice, tool scope, skills, extensions, cron, channels, roles, and workspace files.",
    bullets: [
      "This is the main control plane for per-agent behavior.",
      "Use Skills and Extensions here to turn on the exact capabilities an agent should carry into runtime.",
      "The Files tab exposes the internal markdown files like `SOUL.md`, `MEMORY.md`, and `HEARTBEAT.md`.",
    ],
  },
  {
    name: "Automations",
    href: "/scheduler",
    badge: "Trigger",
    summary: "Manage cron schedules and signed webhooks for workflow execution.",
    bullets: [
      "Cron jobs appear when workflows contain cron-trigger nodes and the scheduler has been resynced.",
      "Webhook management supports create, list, enable/disable, delete, rotate secret, HMAC examples, replay controls, and live trigger state.",
      "WebChat can list automations and explain webhook signing from actual app state.",
    ],
  },
  {
    name: "Hierarchy",
    href: "/hierarchy",
    badge: "Organize",
    summary: "Manage organizations, goals, reporting lines, source packs, spend, activity, and linked workflows.",
    bullets: [
      "Use Hierarchy when work should be scoped to a company, org, or goal instead of only to a board task.",
      "Goal source packs connect data sources to Boards, Workflows, and Council in one place.",
      "Long-horizon `/goal` work now records run ledgers and judge verdicts so continuation, blockers, and completion claims are inspectable.",
      "This is the strongest tab for company-style structure and cross-tab visibility.",
    ],
  },
  {
    name: "Data Sources",
    href: "/documents",
    badge: "Ground",
    summary: "Upload files, scrape sites, crawl docs portals, and route source context into other tabs.",
    bullets: [
      "Use this before asking agents to reason over external material. Data Sources stores searchable, citable context for answers.",
      "Use Notebooks when several sources belong together and need notes, citation previews, timelines, mind maps, or other generated outputs.",
      "Use `/learn from document <id>` or `/learn from notebook <id>` only when the material should become a reviewable reusable skill, not just a cited answer.",
      "Open a source directly in WebChat, Boards, Workflows, or Council from the same page.",
      "Deep links like `/documents?documentId=...` are supported for source-pack style flows.",
    ],
  },
  {
    name: "Designs",
    href: "/designs",
    badge: "Create",
    summary: "Create, save, inspect, and iterate design artifacts from WebChat or the visual design workspace.",
    bullets: [
      "Use this for landing pages, UI concepts, diagrams, posters, app screens, and HTML design drafts.",
      "Artifacts can be saved into projects and inspected in preview/source modes.",
      "Design generation uses the same agentic runtime, model setup, memory, documents, and workflow context as WebChat.",
    ],
  },
  {
    name: "Channels",
    href: "/channels",
    badge: "Connect",
    summary: "Connect Telegram, WhatsApp, Slack, Discord, Teams, BlueBubbles, Google Chat, and WebChat.",
    bullets: [
      "All major channel commands pass through the same router, so behavior stays consistent across surfaces.",
      "Use this tab to connect, verify status, and test the path before going live.",
      "If you only want local testing first, WebChat is the simplest path.",
    ],
  },
  {
    name: "Activity",
    href: "/activity",
    badge: "Observe",
    summary: "Watch live executions, lane concurrency, telemetry events, and runtime pressure.",
    bullets: [
      "Use this first when a workflow appears stuck, slow, or unexpectedly noisy.",
      "Activity complements Metrics, Usage, Costs, Logs, and Maintenance.",
      "This is the fastest way to confirm whether something is actively running right now.",
    ],
  },
  {
    name: "Maintenance",
    href: "/maintenance",
    badge: "Clean",
    summary: "Inspect workspace bloat, cron state, stale executions, locked tasks, and approval backlog.",
    bullets: [
      "Use this when the app feels heavy, stateful, or inconsistent after many runs.",
      "It is especially useful for large `MEMORY.md` files, stale workflows, or cron drift.",
      "The page also gives cleanup and resync suggestions instead of only raw counters.",
    ],
  },
];

const supportingTabs = [
  { name: "Council", href: "/council", summary: "Run structured multi-agent votes and compare positions." },
  { name: "Skills", href: "/skills", summary: "Inspect skill packs, per-agent enablement, usage provenance, and compounding evaluations." },
  { name: "Extensions", href: "/extensions", summary: "Manage globally enabled extension modules and config." },
  { name: "Memory", href: "/memory", summary: "Inspect memory storage, search behavior, and long-term context." },
  { name: "Computer Use (beta)", href: "/settings/computer-use", summary: "Optional, off-by-default desktop control via the Cua driver; normal install does not add Cua. Install later, run Doctor, enable, then try an observe-only task." },
  { name: "Metrics / Usage / Costs / Logs", href: "/metrics", summary: "Use these together for health, throughput, cost, and debugging." },
  { name: "Settings", href: "/settings", summary: "Configure models, channels, memory, security, secrets, backups, and runtime behavior." },
];

const useCases = [
  {
    name: "Personal chief-of-staff",
    summary: "Track goals, remember preferences, schedule recurring checks, summarize documents, and keep a live board.",
    prompts: ["Create a board task for each blocker in this launch note.", "Schedule a daily 9 AM status digest for my active goals."],
  },
  {
    name: "Research analyst",
    summary: "Gather current sources, compare products, separate confirmed facts from assumptions, and produce cited briefs.",
    prompts: ["Compare three local model runtimes for an 8 GB VRAM laptop. Use current sources.", "Find the strongest evidence for and against this vendor choice."],
  },
  {
    name: "Coding operator",
    summary: "Inspect repos, propose patches, edit files when asked, run verification, and explain changed files.",
    prompts: ["Audit API-key handling in this repo and cite exact files.", "Edit this function and run focused verification before finalizing."],
  },
  {
    name: "Workflow builder",
    summary: "Build webhook-to-LLM-to-channel flows, scheduled reports, triage workflows, and document pipelines.",
    prompts: ["Create a webhook workflow that validates JSON and sends a summary to WebChat.", "Build a docs crawler workflow that stores sources and creates follow-up tasks."],
  },
  {
    name: "Autonomous company dashboard",
    summary: "Create organizations, goals, roles, boards, budgets, heartbeats, approvals, and audit trails.",
    prompts: ["Create an AI development team org with a goal, two agents, and a review board.", "Show which agents are blocked and what they need next."],
  },
  {
    name: "Decision council",
    summary: "Ask multiple agents to debate a product, security, architecture, hiring, or budget question.",
    prompts: ["Start a council vote on reliability versus feature velocity.", "Run a security review council using this uploaded architecture doc."],
  },
  {
    name: "Design lab",
    summary: "Generate UI concepts, landing page drafts, diagrams, posters, and saved HTML artifacts.",
    prompts: ["Generate a landing page concept for a local-first AI workspace and save it as a design.", "Create a dashboard mockup for monitoring agent costs."],
  },
];

const guidedWorkflows = [
  {
    name: "Data Sources",
    href: "/documents",
    summary: "Use this tab whenever agents should work from real files or crawled pages instead of only prompt text.",
    steps: [
      "Upload a file, scrape a page, or crawl a docs site.",
      "Ask in WebChat when you want a cited answer, summary, comparison, task, workflow, council session, or design grounded in that source.",
      "Group related sources into a Notebook when you want notes, citation previews, timelines, mind maps, and generated outputs.",
      "Open the document directly or deep-link it into Hierarchy source packs.",
      "Create a board task, launch a workflow, or run a council vote from the source.",
    ],
  },
  {
    name: "Learn From Sources",
    href: "/skills",
    summary: "Use this when source material describes a repeatable procedure that should become an agent skill after review.",
    steps: [
      "Start from Skills -> Learn from sources, or type `/learn from document <id>` or `/learn from notebook <id>` in WebChat.",
      "disp8ch builds a bounded source pack, compiles a skill candidate with the active model, and verifies safe structure, grounded source evidence, and a verification step.",
      "Review the pending candidate before installing it. `/learn` never auto-installs a skill and never scans an arbitrary whole drive from chat.",
      "Use Data Sources instead when you only need searchable context and cited answers.",
    ],
  },
  {
    name: "Automations",
    href: "/scheduler",
    summary: "Use Automations for recurring cron schedules and external webhook triggers.",
    steps: [
      "Cron: add a cron-trigger node to a workflow, then Resync Cron so it appears in the schedule list.",
      "Webhooks: click New Webhook, pick a workflow, and copy the URL + secret shown once on creation.",
      "Use Maintenance if a cron trigger looks out of sync; use Rotate Secret if a webhook secret is compromised.",
    ],
  },
  {
    name: "Migration And Imports",
    href: "/skills",
    summary: "Use this when bringing existing local-agent assets into Disp8ch without copying private runtime state.",
    steps: [
      "Install external skill packs from a local folder or git URL with `pnpm dpc skills install <source>`.",
      "Import/export native organization packs with `pnpm dpc orgs export <org-id> ./company-pack.json` and `pnpm dpc orgs import ./company-pack.json`.",
      "Use compatibility-specific importers only for known source layouts, and review imported skills before enabling them.",
      "Compatible workflow JSON imports are handled from the Workflows UI/API; unsupported nodes remain visible placeholders.",
      "Secrets, chat history, uploaded private documents, auth sessions, and runtime databases are not imported silently.",
    ],
  },
  {
    name: "Skills",
    href: "/skills",
    summary: "Use Skills to give agents reusable operating patterns like proactive memory, release management, or team coordination.",
    steps: [
      "Inspect what a skill pack does before enabling it.",
      "Enable skills per agent based on the job instead of enabling everything globally.",
      "Use the Compounding Evidence panel to see which skills were loaded, used, proposed, applied, dismissed, stale, or active.",
      "Test with channel commands like `find skills for ...` to confirm the right skill is discoverable.",
    ],
  },
  {
    name: "Extensions",
    href: "/extensions",
    summary: "Use Extensions for globally installed capability modules like hierarchy, data-sources, memory-core, or release-ops.",
    steps: [
      "Enable the extension globally first.",
      "Then enable the matching extension or skill pack on the target agent.",
      "Use the Extensions tab and `/api/extensions` runtime status if behavior seems inconsistent.",
    ],
  },
  {
    name: "Computer Use (beta)",
    href: "/settings/computer-use",
    summary:
      "Optional desktop control through the open-source Cua driver. It is off by default and stays disabled until you install the driver and explicitly enable it. Every action is policy-checked and audited; sensitive actions need approval.",
    steps: [
      "Default disp8ch install does not install Cua. During first install, opt in with `--with-computer-use`, `-WithComputerUse`, or `DISP8CH_WITH_COMPUTER_USE=1`; otherwise add it later from this settings page.",
      "Install Cua Driver — Windows: `irm https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/scripts/install.ps1 | iex`; macOS/Linux: `/bin/bash -c \"$(curl -fsSL https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/scripts/install.sh)\"`.",
      "Ensure `cua-driver` is on PATH, or set `DISP8CH_CUA_DRIVER_CMD` to the full path (e.g. `C:\\Users\\<you>\\AppData\\Local\\Programs\\Cua\\cua-driver\\bin\\cua-driver.exe`) when a WSL shell doesn't see the installer PATH update.",
      "Enable it with `DISP8CH_ENABLE_COMPUTER_USE=1` and restart, then run Doctor in Settings → Computer Use.",
      "The driver must run in the same interactive Windows desktop session as the apps you control; from WSL/SSH it will report a Doctor failure instead of ready.",
      "Try a safe observe-only task before any action that changes state. Upstream Cua telemetry is off unless you set `DISP8CH_CUA_TELEMETRY=1`.",
    ],
  },
];

const llmSetups = [
  {
    name: "DeepSeek Direct",
    badge: "Online",
    href: "/settings",
    summary: "Use this when you want DeepSeek models without an OpenRouter gateway.",
    steps: [
      "Set `DEEPSEEK_API_KEY` in the Windows environment or add it through Settings -> Models.",
      "Add a DeepSeek model entry with provider `deepseek` and the exact model ID you want to run.",
      "For comparison runs, set `BENCH_PROVIDER=deepseek`, `BENCH_DISP8CH_PROVIDER=deepseek`, and `BENCH_MODEL` to the same model ID.",
      "Run app servers and harness commands from Windows `cmd.exe` or PowerShell when doing benchmark-quality local comparisons.",
    ],
    command: "pnpm.cmd exec tsx scripts\\cli.ts models add deepseek env:DEEPSEEK_API_KEY --model deepseek-v4-flash",
  },
  {
    name: "Claude Code OAuth",
    badge: "OAuth",
    href: "/settings",
    summary: "Use this when you already have Claude Code signed in and want Anthropic models without managing a separate Anthropic API key.",
    steps: [
      "Install Claude Code and sign in on the same Windows user that runs disp8ch.",
      "Keep `.claude`, OAuth token files, and auth JSON private. Do not copy them into the repo or `.env.local`.",
      "Select or add an Anthropic model in Settings -> Models.",
      "If the model form asks for a credential, use an environment or secret reference such as `env:ANTHROPIC_TOKEN`, `env:ANTHROPIC_OAUTH_TOKEN`, `env:CLAUDE_CODE_OAUTH_TOKEN`, or `secret:CLAUDE_CODE_OAUTH_TOKEN`.",
      "Run the model test before using the model in WebChat or workflows. disp8ch resolves the credential at runtime and refreshes Claude Code credentials when possible.",
    ],
    command: "claude --version",
  },
  {
    name: "Codex CLI Sign-In",
    badge: "OAuth",
    href: "/settings",
    summary: "Use this for optional coding-agent delegation through the installed Codex CLI. Normal WebChat still uses the active provider or local model.",
    steps: [
      "Install the Codex CLI and sign in locally with the account you want to use for coding-agent work.",
      "Keep Codex auth files and tokens outside the repo and outside `.env.local`.",
      "Leave WebChat on your selected hosted provider or local model unless you explicitly want the Codex coding-agent backend.",
      "Use Codex only for delegated coding work that you intentionally route to that backend; default async/background work keeps the configured disp8ch model.",
      "Test with a harmless read-only delegation before granting write access.",
    ],
    command: "codex exec \"Reply with hello\"",
  },
  {
    name: "Ollama Local",
    badge: "Local",
    href: "/settings",
    summary: "Use this for the simplest private local setup. Chat runs through Ollama; memory uses disp8ch's built-in local embedding model by default.",
    steps: [
      "Install Ollama for Windows and start it before opening onboarding.",
      "Pull or run a chat model, for example `ollama run llama3.1:8b` or a Qwen model that fits your hardware.",
      "In onboarding choose Local AI -> Ollama, keep `http://127.0.0.1:11434`, select the model, run the test, and save. No API key is needed.",
      "Memory semantic search defaults to the built-in local `Xenova/all-MiniLM-L6-v2` embedding model, so users do not need to choose a memory provider.",
      "Optional: if you specifically want Ollama embeddings, run `ollama pull nomic-embed-text`, then set Settings -> Memory -> Embedding model to `nomic-embed-text` and rebuild the index.",
    ],
    command: "ollama run llama3.1:8b",
  },
  {
    name: "Gemini Direct",
    badge: "Online",
    href: "/settings",
    summary: "Use this when you want Google Gemini models directly through a Google AI API key.",
    steps: [
      "Set `GOOGLE_API_KEY` in Windows or add it through Settings -> Models.",
      "Use provider `google` and the exact Gemini model ID supported by the Google API.",
      "For CLI setup, pipe the key through `dpc secrets set GOOGLE_API_KEY --stdin` and then reference `secret:GOOGLE_API_KEY`.",
      "Run the model test before using WebChat; do not paste keys into docs, prompts, or benchmark artifacts.",
      "For comparison runs, keep every app and the harness on the same Gemini model ID.",
    ],
    command: "pnpm.cmd exec tsx scripts\\cli.ts models add google secret:GOOGLE_API_KEY --model gemini-3-flash-preview",
  },
  {
    name: "OpenRouter Gateway",
    badge: "Online",
    href: "/settings",
    summary: "Use this when you want one OpenRouter key and model IDs such as `minimax/minimax-m3`.",
    steps: [
      "Set `OPENROUTER_API_KEY` in Windows or add it through Settings -> Models.",
      "Use provider `openrouter` and the OpenRouter model slug exactly as listed by OpenRouter.",
      "For OpenCode in this repo, `opencode.json` uses `openrouter/minimax/minimax-m3` for both main and small model.",
      "For comparison runs, keep every app and the harness on the same model slug before judging output quality.",
    ],
    command: "pnpm.cmd exec tsx scripts\\cli.ts models add openrouter env:OPENROUTER_API_KEY --model minimax/minimax-m3",
  },
  {
    name: "LM Studio",
    badge: "Local",
    href: "/settings",
    summary: "Use this for local models served from LM Studio's OpenAI-compatible local server.",
    steps: [
      "Start the LM Studio local server from Windows and load the model before starting Disp8ch benchmark runs.",
      "Use the OpenAI-compatible provider with a base URL like `http://127.0.0.1:1234/v1`.",
      "Verify `http://127.0.0.1:1234/v1/models` from Windows `curl.exe` before saving.",
      "Expect tool calling to depend on the loaded local model; use the live tool probe when available.",
    ],
    command: "pnpm.cmd exec tsx scripts\\cli.ts models add openai-compatible http://127.0.0.1:1234 --model <loaded-model-id> --allow-unsupported-model",
  },
  {
    name: "Local llama.cpp Server",
    badge: "Local",
    href: "/settings",
    summary: "Use this for GGUF models exposed through llama.cpp's OpenAI-compatible `/v1` API.",
    steps: [
      "Start `llama-server.exe` from Windows, not WSL, so all apps use the same host path and timing baseline.",
      "Use `http://127.0.0.1:8080/v1` for app/provider config, but the CLI add command should use the base `http://127.0.0.1:8080`.",
      "Verify `http://127.0.0.1:8080/v1/models` before starting either app benchmark.",
      "For the Qwen3.6 Q4 redo, the known stable llama.cpp flags are `-ngl 20 -c 65536 -np 1 --reasoning off --host 0.0.0.0 --port 8080 --timeout 3600 --spec-type draft-mtp`.",
    ],
    command: "pnpm.cmd exec tsx scripts\\cli.ts models add openai-compatible http://127.0.0.1:8080 --model Qwen3.6-35B-A3B-UD-Q4_K_M.gguf --allow-unsupported-model",
  },
];

const windowsRunRules = [
  "Run Disp8ch, local model servers, pnpm, node, and curl from Windows `cmd.exe` or PowerShell for benchmark-quality timing.",
  "Back up and clear app databases before major comparison or regression runs.",
  "Stop stale WSL or duplicate server processes before launching Windows-native app servers.",
  "Reach local servers as Windows sees them: `http://127.0.0.1:3100`, `http://127.0.0.1:8787`, and `http://127.0.0.1:8080/v1`.",
  "Restart Disp8ch after editing files under `src/lib` or other server-side modules.",
];

const workspaceFiles = [
  ["AGENTS.md", "Workspace startup instructions. A repo-root AGENTS.md may also exist for coding agents, but app profile context defaults to data/workspace."],
  ["SOUL.md", "Core values, tone, and decision style. Change this when you want personality or judgment changes."],
  ["USER.md", "User-specific preferences, habits, and operating context."],
  ["IDENTITY.md", "How the agent should describe its role, boundaries, and self-concept."],
  ["TOOLS.md", "Instructions for how the agent should use tools, when to avoid them, and what good tool use looks like."],
  ["HOOKS.md", "Event-specific guidance for runtime hooks, follow-up automations, or trigger-specific behavior."],
  ["MEMORY.md", "Durable working memory. Keep it concise. If it grows too large, Maintenance will flag it."],
  ["HEARTBEAT.md", "Periodic check-in behavior for heartbeat-driven runs or follow-up loops."],
  ["BOOT.md", "Always-loaded startup context for the agent."],
  ["BOOTSTRAP.md", "One-time or setup-oriented context used when shaping a new agent or workspace."],
];

const channelExamples = [
  "`list tasks`",
  "`run the simple chat task`",
  "`find skills for hierarchy source packs and follow-up memory`",
  "`show config`",
  "`channel status`",
  "`list schedules`",
];

const sharedObjects = [
  {
    name: "Agents",
    summary: "Used by WebChat, Hierarchy, Council, Workflows, Boards, Skills, Extensions, and Channels.",
  },
  {
    name: "Organizations and goals",
    summary: "Scope Council sessions, board tasks, goal source packs, agent roles, approvals, budgets, and org execution.",
  },
  {
    name: "Data sources",
    summary: "Ground Council debates, workflow document pipelines, board follow-ups, and hierarchy source packs.",
  },
  {
    name: "Workflows",
    summary: "Run from Boards, Channels, WebChat, cron/webhooks, or workflow nodes, and can call agents, tools, memory, Council, and channels.",
  },
  {
    name: "Council sessions",
    summary: "Use agents, orgs, goals, and sources to make a decision, then create board tasks or follow-up WebChat prompts.",
  },
  {
    name: "Board tasks",
    summary: "Track follow-up work from Council, Hierarchy, Data Sources, WebChat, and workflow outputs.",
  },
];

const tabConnections = [
  {
    from: "WebChat",
    to: "Hierarchy / Council / Workflows / Boards",
    summary: "Ask in plain English. WebChat proposes confirmation-gated app actions, then creates orgs, updates goals, runs Council, creates/schedules workflows, and creates board tasks.",
    examples: [
      "Create a product launch org, assign a goal, run a 4-round ranked Council debate, then create a board task from the verdict.",
      "Fix the failing workflow node and explain the config change before applying it.",
    ],
    href: "/chat",
  },
  {
    from: "Hierarchy",
    to: "Data Sources / Boards / Workflows / Council",
    summary: "Goal source packs are the clearest cross-tab bridge: one linked document can open as a source, become a board follow-up, seed a document workflow, or start a Council vote scoped to the goal.",
    examples: [
      "Open a goal source pack, then choose Boards, Workflows, or Council from the source card.",
      "Ask WebChat to assign a goal to all org agents or link sources to a goal.",
    ],
    href: "/hierarchy",
  },
  {
    from: "Council",
    to: "Hierarchy / Data Sources / Boards / WebChat",
    summary: "Council can debate with org-scoped agents, use goal documents, show dissent, and turn the verdict into a board task or WebChat follow-up.",
    examples: [
      "Run a Council debate using this org and goal documents.",
      "Create a board task from this verdict or ask dissenting agents to expand risks.",
    ],
    href: "/council",
  },
  {
    from: "Workflows",
    to: "Agents / Boards / Channels / Data Sources / Council / WebChat",
    summary: "Workflows are the repeatable execution layer. Nodes can call agents, create board tasks, use documents, send channel messages, call Council, and expose repair context to WebChat.",
    examples: [
      "Use the Inspector's Ask WebChat action to repair a failed node.",
      "Create a workflow from a template, attach credentials, schedule it, then track output on Boards.",
    ],
    href: "/workflows",
  },
  {
    from: "Boards",
    to: "Agents / Workflows / Hierarchy / Council",
    summary: "Boards keep work visible. Tasks can be assigned to agents or orgs, linked to goals, created from Council verdicts, or backed by workflows.",
    examples: [
      "Create a task from a Council verdict and link it to the goal.",
      "Run a workflow-backed board task and inspect the result.",
    ],
    href: "/boards",
  },
  {
    from: "Channels",
    to: "WebChat / Workflows / Boards",
    summary: "Telegram, WhatsApp, Slack, Discord, Teams, and WebChat route through the same command/workflow path, so channel requests can create tasks, run workflows, and report status.",
    examples: [
      "Send `list tasks` from a channel.",
      "Run a workflow-backed board task from chat after the channel doctor passes.",
    ],
    href: "/channels",
  },
  {
    from: "Activity / Metrics / Logs / Maintenance",
    to: "Everything running",
    summary: "These are the shared observability tabs. Use them when a workflow, Council run, WebChat action, cron, webhook, approval, or org execution feels stuck or expensive.",
    examples: [
      "Check Activity for live runtime pressure.",
      "Use Maintenance for stale workflow runs, oversized memory, cron drift, or approval backlog.",
    ],
    href: "/activity",
  },
];

const webChatChangeCoverage = [
  "Hierarchy: create/update/switch organizations, apply org templates, create/update goals, update roles, assign agents, set budget/approval policies, link goal sources, assign goals, export org packages.",
  "Council: run rich Council debates, preserve mode/rounds/options/decision method/docs/moderator, rerun sessions, delete sessions, and create verdict board tasks.",
  "Workflows: list/get/run workflows, inspect status, toggle active state, duplicate, update node config, set agent model, create/attach credentials, update schedules, delete workflows, and create template workflows.",
  "Boards: create tasks and link them to agents, organizations, and goals.",
  "Agents: create one or many agents, assign skills/extensions, and update model/profile settings through agent or hierarchy context.",
];

// Node palette grouped around a familiar automation-builder flow: a trigger starts the flow, then
// data flows left-to-right through the nodes you connect. Every node shows its config in
// the right-hand inspector and its inputs/outputs as connectable handles on the canvas.
const workflowNodeCategories = [
  {
    group: "Triggers (start the flow)",
    summary: "Every workflow begins with a trigger. Use one or several; Manual Trigger is best for testing.",
    nodes: "manual-trigger, message-trigger (WebChat/Telegram/Discord/...), webhook-trigger, cron-trigger, telegram-trigger, discord-trigger",
  },
  {
    group: "AI & Agents",
    summary: "The intelligence layer. Agent nodes use your configured model, tools, skills, and memory.",
    nodes: "claude-agent, integration-agent (call any API in natural language), parallel-agents (fan-out workers), council (multi-agent debate), spawn-coding-agent",
  },
  {
    group: "Logic & Flow",
    summary: "Branch, loop, gate, and recombine. Connect from the matching output handle (e.g. If/Else true vs false).",
    nodes: "if-else, switch, filter, loop, merge, aggregate, delay, rate-limiter, wait-for-input, error-handler",
  },
  {
    group: "Data & Transform",
    summary: "Shape data between nodes. Reference upstream output with {{node.field}} expressions.",
    nodes: "set-variables, json-transform, split-text, regex-extract, compare-text, date-time, run-code (JS), database-query (SQLite)",
  },
  {
    group: "Files, System & Memory",
    summary: "Read/write the workspace, run system actions, and persist knowledge for later recall.",
    nodes: "read-file, write-file, system-command, git-operation, archive, clipboard, memory-store, memory-recall, document-tool, rss-read",
  },
  {
    group: "Channels & Notify (send results out)",
    summary: "Deliver output to people. These are side-effecting message-send nodes, flagged in dry-run before they fire.",
    nodes: "send-webchat, send-email, send-telegram, send-slack, send-discord, send-teams, send-whatsapp, send-bluebubbles, notification",
  },
  {
    group: "Integrations & Voice",
    summary: "Reach external services and convert speech. http-request is the universal connector for any REST API.",
    nodes: "http-request, google-sheets, notion, airtable, voice-stt, voice-tts",
  },
  {
    group: "Orchestration & Board",
    summary: "Compose workflows and write into other tabs so automations span Boards, Hierarchy, and other flows.",
    nodes: "call-workflow, workflow-template, board-task, scheduler-job, webhook-response, channel-status",
  },
];

const workflowBuildingGuide = [
  {
    title: "Start from a template",
    summary: "Templates are pre-wired, valid graphs — the fastest way to a working flow.",
    steps: [
      "In Workflows, click New -> From Template and pick one of the built-in templates (research, docs crawler, cron board creator, daily digest, crew orchestrator, short video, trading cycle, and more).",
      "The template lands on the canvas fully connected with a trigger and example node config you can edit.",
      "Run the Manual Trigger to test immediately, then swap in your own values.",
    ],
  },
  {
    title: "Build or customize node-by-node",
    summary: "Add nodes from the palette, connect their handles, and configure each in the inspector.",
    steps: [
      "Drag a node from the left palette onto the canvas, then drag from a node's output handle to the next node's input handle to connect them.",
      "Click any node to open the right-hand inspector and fill in its config; use {{trigger.message}} or {{nodeName.field}} to pass data forward.",
      "Use Dry-Run to preview graph order, trigger detection, node compatibility, missing required fields, and which nodes are mutating before anything executes.",
    ],
  },
  {
    title: "Ask WebChat to build it for you (the agentic way)",
    summary: "Describe the automation in plain language and confirm a gated plan.",
    steps: [
      'Tell WebChat what you want, e.g. "Create a workflow that triggers on a webchat message, summarizes it with an agent, and replies."',
      "WebChat returns a confirmation-gated plan; nothing is created until you reply confirm.",
      'Keep editing in chat: "add an HTTP request node", "set the agent model to deepseek-v4-flash", "activate it", or "run it" — each change is applied to the real workflow.',
    ],
  },
  {
    title: "Schedule & automate",
    summary: "Turn a workflow into a recurring or externally-triggered automation.",
    steps: [
      "Add a cron-trigger node for recurring runs, then open Automations and Resync Cron so the schedule goes live.",
      "Add a webhook-trigger (or create a webhook in Automations) to fire the workflow from an external system with an HMAC-signed request.",
      "Use board-task / call-workflow nodes so one automation feeds Boards or chains into other workflows.",
    ],
  },
  {
    title: "Import Workflow JSON",
    summary: "Bring existing compatible flows in; supported nodes are converted, the rest stay visible.",
    steps: [
      "Use Import Workflow JSON in the Workflows UI or POST the JSON to /api/workflows.",
      "Recognized nodes are mapped to disp8ch equivalents; unsupported nodes import as visible placeholders so the graph shape is preserved.",
      "Review converted Sheets/Notion/Airtable/HTTP nodes and re-attach credentials before running.",
    ],
  },
];

export default function DocsPage() {
  return (
    <main className="flex-1 overflow-y-auto" data-perf-ready="docs">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-6 py-6">
          <SurfaceHeader
            title="Docs"
            subtitle="Quickstart guidance, tab-by-tab explanations, and workspace-file references for agents."
            statusItems={[
              { label: "Guides", value: quickstartSteps.length + guidedWorkflows.length + workflowBuildingGuide.length },
              { label: "Tabs", value: coreTabs.length },
              { label: "Bridges", value: tabConnections.length, tone: "ok" },
              { label: "Release", value: latestRelease.version, tone: "ok" },
            ]}
            secondaryActions={(
              <div className="flex flex-wrap items-center gap-2">
                <Button asChild size="sm" variant="outline">
                  <a href="#release-notes">Release notes</a>
                </Button>
                <WebChatDraftButton draft="Explain how the main Disp8ch tabs work together and recommend where I should start." label="Ask WebChat" />
              </div>
            )}
          />

          <Card>
            <CardHeader>
              <CardTitle>Quickstart</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 lg:grid-cols-5">
              {quickstartSteps.map((step, index) => (
                <div key={step.title} className="rounded-lg border border-border bg-card/60 p-4">
                  <div className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-terminal-red">
                    Step {index + 1}
                  </div>
                  <div className="mb-2 text-sm font-semibold">{step.title}</div>
                  <p className="mb-4 text-xs leading-5 text-muted-foreground">{step.body}</p>
                  <Button asChild size="sm" variant="outline">
                    <Link href={step.href}>{step.label}</Link>
                  </Button>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card id="release-notes" className="scroll-mt-6">
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <CardTitle>Release Notes</CardTitle>
                <Badge variant="secondary">
                  {latestRelease.version === "Unreleased" ? "Next release" : `Latest ${latestRelease.version}`}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {releaseNotes.map((release) => (
                <section key={release.version} className="rounded-lg border border-border p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold">{release.version} - {release.title}</div>
                      <p className="mt-1 max-w-4xl text-xs leading-5 text-muted-foreground">{release.summary}</p>
                    </div>
                    <Badge variant="outline">{release.date}</Badge>
                  </div>
                  <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                    {release.sections.map((section) => (
                      <details key={section.title} className="rounded-lg border border-border bg-card/40 p-3">
                        <summary className="cursor-pointer text-xs font-semibold">
                          {section.title} ({section.items.length})
                        </summary>
                        <ul className="mt-3 space-y-2 text-xs leading-5 text-muted-foreground">
                          {section.items.map((item) => <li key={item}>- {item}</li>)}
                        </ul>
                      </details>
                    ))}
                  </div>
                </section>
              ))}
              <p className="text-xs leading-5 text-muted-foreground">
                Update availability and installer verification remain separate from this history. Use the desktop menu or installation tools to check for a newer build.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Tabs Are Connected By Shared Objects</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
              {sharedObjects.map((item) => (
                <div key={`quick-${item.name}`} className="rounded-lg border border-border p-3">
                  <div className="mb-1 text-xs font-semibold">{item.name}</div>
                  <p className="line-clamp-3 text-[11px] leading-5 text-muted-foreground">{item.summary}</p>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>What You Can Use Disp8ch For</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {useCases.map((useCase) => (
                <div key={useCase.name} className="rounded-lg border border-border p-4">
                  <div className="mb-2 text-sm font-semibold">{useCase.name}</div>
                  <p className="mb-3 text-xs leading-5 text-muted-foreground">{useCase.summary}</p>
                  <div className="space-y-2">
                    {useCase.prompts.map((prompt) => (
                      <div key={prompt} className="rounded border border-border bg-muted/30 px-3 py-2 font-mono text-[11px] leading-5 text-muted-foreground">
                        {prompt}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Install And Updates</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 lg:grid-cols-3">
              {installPaths.map((item) => (
                <div key={item.name} className="rounded-lg border border-border p-4">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <div className="text-sm font-semibold">{item.name}</div>
                    <Badge variant="secondary">{item.badge}</Badge>
                  </div>
                  <p className="mb-3 text-xs leading-5 text-muted-foreground">{item.summary}</p>
                  <ul className="space-y-2 text-xs leading-5 text-muted-foreground">
                    {item.bullets.map((bullet) => (
                      <li key={bullet}>- {bullet}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Building Workflows: The Node Palette</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              {workflowNodeCategories.map((cat) => (
                <div key={cat.group} className="rounded-lg border border-border p-4">
                  <div className="mb-2 text-sm font-semibold">{cat.group}</div>
                  <p className="mb-3 text-xs leading-5 text-muted-foreground">{cat.summary}</p>
                  <div className="rounded border border-border bg-muted/30 px-3 py-2 font-mono text-[11px] leading-5 text-muted-foreground">
                    {cat.nodes}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Building & Customizing Workflows</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {workflowBuildingGuide.map((guide) => (
                <div key={guide.title} className="rounded-lg border border-border p-4">
                  <div className="mb-2 text-sm font-semibold">{guide.title}</div>
                  <p className="mb-3 text-xs leading-5 text-muted-foreground">{guide.summary}</p>
                  <ol className="space-y-2 text-xs leading-5 text-muted-foreground">
                    {guide.steps.map((step, i) => (
                      <li key={step}>{i + 1}. {step}</li>
                    ))}
                  </ol>
                </div>
              ))}
              <div className="rounded-lg border border-border bg-card/60 p-4 md:col-span-2 xl:col-span-1">
                <div className="mb-2 text-sm font-semibold">Try it now</div>
                <p className="mb-3 text-xs leading-5 text-muted-foreground">
                  Ask WebChat to draft a workflow for you, then confirm the gated plan.
                </p>
                <WebChatDraftButton
                  draft="Create a workflow that triggers on a webchat message, uses an agent to summarize it, and replies over webchat. Show me the plan to confirm first."
                  label="Draft a workflow in WebChat"
                />
              </div>
            </CardContent>
          </Card>

          <div className="grid gap-6 xl:grid-cols-[1.8fr,1fr]">
            <Card>
              <CardHeader>
                <CardTitle>Most Important Tabs</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-2">
                {coreTabs.map((tab) => (
                  <div key={tab.name} className="rounded-lg border border-border p-4">
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <div className="text-sm font-semibold">{tab.name}</div>
                      <Badge variant="secondary">{tab.badge}</Badge>
                    </div>
                    <p className="mb-3 text-xs leading-5 text-muted-foreground">{tab.summary}</p>
                    <ul className="space-y-2 text-xs leading-5 text-muted-foreground">
                      {tab.bullets.map((bullet) => (
                        <li key={bullet}>- {bullet}</li>
                      ))}
                    </ul>
                    <div className="mt-4">
                      <Button asChild size="sm" variant="ghost">
                        <Link href={tab.href}>Open {tab.name}</Link>
                      </Button>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>

            <div className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle>Supporting Tabs</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {supportingTabs.map((tab) => (
                    <div key={tab.name} className="rounded-lg border border-border p-3">
                      <div className="mb-1 text-sm font-medium">{tab.name}</div>
                      <p className="mb-2 text-xs leading-5 text-muted-foreground">{tab.summary}</p>
                      <Button asChild size="sm" variant="ghost">
                        <Link href={tab.href}>Open</Link>
                      </Button>
                    </div>
                  ))}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Fastest Test Commands</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-xs text-muted-foreground">
                  {channelExamples.map((example) => (
                    <div key={example} className="rounded border border-border bg-muted/30 px-3 py-2 font-mono">
                      {example}
                    </div>
                  ))}
                </CardContent>
              </Card>
            </div>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Internal Workspace Files</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="mb-4 text-xs leading-5 text-muted-foreground">
                Startup files are loaded from the selected workspace. The default Disp8ch profile files live in
                `data/workspace`; selecting another workspace can intentionally override them, and Settings {"->"} Memory
                shows a hygiene warning when `USER.md`, `MEMORY.md`, or related startup files diverge.
              </p>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {workspaceFiles.map(([name, description]) => (
                  <div key={name} className="rounded-lg border border-border p-4">
                    <div className="mb-2 font-mono text-sm font-semibold">{name}</div>
                    <p className="text-xs leading-5 text-muted-foreground">{description}</p>
                  </div>
                ))}
              </div>
              <p className="mt-4 text-xs leading-5 text-muted-foreground">
                Edit these from <Link href="/agents" className="underline underline-offset-4">Agents</Link> {"->"} Files.
                Use Maintenance to catch oversized workspace files, especially `MEMORY.md`. Keep root `AGENTS.md` for
                repo development instructions and avoid treating root `MEMORY.md` or `USER.md` as app durable memory.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Detailed Guides</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-2">
              {guidedWorkflows.map((guide) => (
                <div key={guide.name} className="rounded-lg border border-border p-4">
                  <div className="mb-2 text-sm font-semibold">{guide.name}</div>
                  <p className="mb-3 text-xs leading-5 text-muted-foreground">{guide.summary}</p>
                  <ul className="space-y-2 text-xs leading-5 text-muted-foreground">
                    {guide.steps.map((step) => (
                      <li key={step}>- {step}</li>
                    ))}
                  </ul>
                  <div className="mt-4">
                    <Button asChild size="sm" variant="ghost">
                      <Link href={guide.href}>Open {guide.name}</Link>
                    </Button>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>LLM Provider Setup</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm leading-6 text-muted-foreground">
                Disp8ch can run direct hosted providers, OpenRouter-routed models, or local OpenAI-compatible model servers.
                Keep the provider, model ID, and base URL identical across every app and harness before comparing results.
              </p>
              <div className="grid gap-4 lg:grid-cols-3">
                {llmSetups.map((setup) => (
                  <div key={setup.name} className="rounded-lg border border-border p-4">
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <div className="text-sm font-semibold">{setup.name}</div>
                      <Badge variant="secondary">{setup.badge}</Badge>
                    </div>
                    <p className="mb-3 text-xs leading-5 text-muted-foreground">{setup.summary}</p>
                    <ul className="space-y-2 text-xs leading-5 text-muted-foreground">
                      {setup.steps.map((step) => (
                        <li key={step}>- {step}</li>
                      ))}
                    </ul>
                    <div className="mt-3 rounded border border-border bg-muted/30 px-3 py-2 font-mono text-[11px] leading-5 text-muted-foreground">
                      {setup.command}
                    </div>
                    <div className="mt-4">
                      <Button asChild size="sm" variant="ghost">
                        <Link href={setup.href}>Open Models</Link>
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
              <div className="rounded-lg border border-border p-4">
                <div className="mb-2 text-sm font-semibold">Windows-Native Comparison Rules</div>
                <ul className="space-y-2 text-xs leading-5 text-muted-foreground">
                  {windowsRunRules.map((rule) => (
                    <li key={rule}>- {rule}</li>
                  ))}
                </ul>
                <p className="mt-3 text-xs leading-5 text-muted-foreground">
                  The full benchmark setup lives in the Windows-native comparison setup notes.
                </p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>How Tabs Work Together</CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              <div>
                <p className="max-w-4xl text-sm leading-6 text-muted-foreground">
                  Disp8ch is organized as one operator console, not separate apps. The shared objects below are what make
                  tabs connect: agents do the work, goals/orgs scope the work, sources ground the work, workflows repeat
                  the work, Council decides, and Boards track the follow-up.
                </p>
              </div>

              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {sharedObjects.map((item) => (
                  <div key={item.name} className="rounded-lg border border-border p-4">
                    <div className="mb-2 text-sm font-semibold">{item.name}</div>
                    <p className="text-xs leading-5 text-muted-foreground">{item.summary}</p>
                  </div>
                ))}
              </div>

              <div className="grid gap-4 lg:grid-cols-2">
                {tabConnections.map((connection) => (
                  <div key={`${connection.from}-${connection.to}`} className="rounded-lg border border-border p-4">
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <Badge variant="secondary">{connection.from}</Badge>
                      <span className="text-xs text-muted-foreground">works with</span>
                      <Badge variant="outline">{connection.to}</Badge>
                    </div>
                    <p className="mb-3 text-xs leading-5 text-muted-foreground">{connection.summary}</p>
                    <div className="space-y-2">
                      {connection.examples.map((example) => (
                        <div key={example} className="rounded border border-border bg-muted/30 px-3 py-2 font-mono text-[11px] leading-5 text-muted-foreground">
                          {example}
                        </div>
                      ))}
                    </div>
                    <div className="mt-4">
                      <Button asChild size="sm" variant="ghost">
                        <Link href={connection.href}>Open {connection.from.split(" / ")[0]}</Link>
                      </Button>
                    </div>
                  </div>
                ))}
              </div>

              <div className="rounded-lg border border-border p-4">
                <div className="mb-2 text-sm font-semibold">What WebChat Can Change</div>
                <p className="mb-3 text-xs leading-5 text-muted-foreground">
                  WebChat can already make cross-tab changes through confirmation-gated app actions and workflow tools.
                  Use it when you know the outcome you want but do not want to click through several tabs.
                </p>
                <ul className="grid gap-2 text-xs leading-5 text-muted-foreground lg:grid-cols-2">
                  {webChatChangeCoverage.map((item) => (
                    <li key={item}>- {item}</li>
                  ))}
                </ul>
              </div>

              <div className="rounded-lg border border-border p-4">
                <div className="mb-2 text-sm font-semibold">Cross-Tab Work Trail</div>
                <p className="mb-3 text-xs leading-6 text-muted-foreground">
                  A single WebChat prompt can become one linked plan that spans tabs. Plans can create or update agents,
                  organizations, goals, workflows, schedules, council sessions, and board tasks. WebChat only changes
                  state after you confirm the plan — nothing is created from a draft.
                </p>
                <p className="mb-3 text-xs leading-6 text-muted-foreground">
                  Every confirmed plan opens a <span className="font-medium text-foreground">work trail</span>: a compact
                  record of what happened, in order. The trail shows up right after execution in the WebChat result, in
                  the Activity tab (with the full timeline and raw plan), and links the objects each step created. It is
                  compact by default — open it for timestamps, status, and the raw plan JSON.
                </p>
                <div className="mb-3 rounded border border-border bg-muted/30 px-3 py-2 font-mono text-[11px] leading-5 text-muted-foreground">
                  WebChat prompt<br />
                  -&gt; Created Launch Readiness Org<br />
                  -&gt; Ran council debate: Launch risk<br />
                  -&gt; Created Daily Monitoring Workflow<br />
                  -&gt; Scheduled workflow: daily 9am<br />
                  -&gt; Created board task: Review blockers
                </div>
                <div className="space-y-2">
                  {[
                    "Build a launch readiness org, have them debate risks, create a daily monitoring workflow, and add follow-up tasks.",
                    "Use my active org to debate the best OCR approach, then turn the verdict into a workflow and board task.",
                    "Attach the pricing docs to the launch goal, run a council review, and track unresolved questions on the board.",
                  ].map((example) => (
                    <div key={example} className="rounded border border-border bg-muted/30 px-3 py-2 font-mono text-[11px] leading-5 text-muted-foreground">
                      {example}
                    </div>
                  ))}
                </div>
                <div className="mt-4">
                  <Button asChild size="sm" variant="ghost">
                    <Link href="/activity">Open Activity</Link>
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </main>
  );
}
