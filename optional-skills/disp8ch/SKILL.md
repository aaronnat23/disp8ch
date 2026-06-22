# disp8ch — Complete Product Reference Skill

Use this skill when the user asks about how to use disp8ch, needs help with configuration, wants to know what commands or nodes are available, is troubleshooting workflows, or needs guidance on any disp8ch feature.

## Use when
- User asks "how do I…", "what command…", "which node…", or "where do I find…" about disp8ch.
- User needs CLI, channel command, workflow node, or settings guidance.
- Debugging a workflow, memory issue, or channel connection problem.
- Explaining disp8ch architecture, data flow, or configuration to the user.

---

## Product Overview

disp8ch is a **single-user local-first personal AI assistant** with a visual workflow editor.

**Tech stack:** Next.js 14 (App Router), React Flow, SQLite + Drizzle ORM, Zustand, multi-provider LLM  
**Default port:** 3100 (WebSocket: 3101)  
**Start dev server:** `pnpm dev`  
**Build for production:** `npm run build` then `next start -p 3100`  
**Scope:** Single-user only — no multi-user orchestration

---

## Channel Commands

Works in all 8 channels: WebChat, Telegram, Discord, WhatsApp, Google Chat, Slack, BlueBubbles (iMessage), Microsoft Teams.

### Board Tasks
```
please add <title> to my board
Task: <title>
list tasks
please start task <id>
run task <id>
```

### Scheduler
```
list schedules
list cron jobs
show scheduler          → bullet list of all cron jobs with live/inactive status
run now "Workflow Name" → fires a cron workflow immediately
```

### Workflow Routing
```
use <workflow name> to <message>
run workflow: <workflow name> :: <message>
```

### Skills & System
```
find skills for <task>
is there a skill for <task>
/btw <side question>        → quick aside without disrupting the current flow
list agents
list models
list tools
list documents
show config
turn off telemetry
turn on hooks
help
status
channel status              → shows all 8 channel connection states
```

### Org & Hierarchy
```
show org                    → current active organization
switch to execution mode    → re-runs org ask as hierarchy orchestration
switch to council mode      → re-runs org ask as Leadership Council debate
```

---

## Workflow Engine

### Execution Flow
Lint → find trigger → BFS execution order → execute each node sequentially → `lastOutput` passed as input to next node → If/Else splices branch via `sourceHandle "true"/"false"` → emit WebSocket events.

### Template Syntax
Resolved by `resolveTemplate()` in `expressions.ts`. Use `{{namespace.field}}` in any node config field.

| Node type | Namespace | Key fields |
|-----------|-----------|-----------|
| `cron-trigger` | `cron` | `{{cron.triggeredAt}}`, `{{cron.expression}}` |
| `run-code` | `run` | `{{run.result}}`, `{{run.result.myField}}` |
| `message-trigger` | `message` | `{{message.text}}`, `{{message.sender}}`, `{{message.channel}}` |
| `http-request` | `http` | `{{http.body}}`, `{{http.status}}`, `{{http.headers}}` |
| `webhook-trigger` | `webhook` | `{{webhook.body}}`, `{{webhook.headers}}` |
| `memory-recall` | `memory` | `{{memory.results}}` |
| `claude-agent` | `agent` | `{{agent.response}}` |
| `board-task` | `board` | `{{board.response}}`, `{{board.task.id}}`, `{{board.task.title}}`, `{{board.total}}` |
| `set-variables` | `vars` | `{{vars.myKey}}` — accumulates across the whole workflow |
| `date-time` | `date` | `{{date.formatted}}`, `{{date.iso}}`, `{{date.unixSeconds}}` |
| `channel-status` | `channel` | `{{channel.response}}` |
| `scheduler-job` | `scheduler` | `{{scheduler.response}}` |
| `compare-text` | `compare` | `{{compare.identical}}`, `{{compare.diffSummary}}` |
| `database-query` | `database` | `{{database.rows}}` |
| `regex-extract` | `regex` | `{{regex.matches}}` |
| `council` | `council` | `{{council.response}}` |

**Important:** `set-variables` is the safe way to preserve values across nodes. After a `run-code` node, stage output into vars before write-file/memory-store/send-webchat so the values survive across subsequent nodes.

### Example: Preserve run-code output across nodes
```
run-code  →  set-variables (reportBody={{run.result.report}})  →  write-file (content={{vars.reportBody}})  →  memory-store (manualContent={{vars.reportBody}})
```

---

## Node Types (52 across 10 categories)

### Trigger
| Node | Key Config |
|------|------------|
| `message-trigger` | `channel` (webchat/telegram/discord/etc), `filter` (comma-separated keywords) |
| `webhook-trigger` | `path`, `secret` (HMAC-SHA256 verified) |
| `manual-trigger` | No config — fires via UI or `/api/execute` |
| `cron-trigger` | `expression` (cron syntax), `timezone` |

**Keyword filter tip:** `filter` on trigger nodes = comma-separated keywords. Blank = generic fallback (matches anything). Set but no match = workflow skipped. Keyword-matched workflows sort before generic ones.

### Agent
| Node | Key Config |
|------|------------|
| `claude-agent` | `systemPrompt`, `temperature`, `maxTokens`, `agentId`, `tools` (array) |
| `parallel-agents` | `workers` (array of agent configs) — fan-out, results in `workerReports` |
| `call-workflow` | `workflowId` — runs another workflow as a sub-call |

### Channel (Send)
`send-webchat`, `send-whatsapp` (requires `to`), `send-telegram`, `send-discord`, `send-email` (host/port/subject), `send-slack`, `send-bluebubbles`, `send-teams`

### Logic
| Node | Key Config |
|------|------------|
| `if-else` | `condition` (expr-eval expression, e.g. `vars.flag == "yes"`) — outputs `branch: "true"` or `"false"` |
| `switch` | `expression`, `cases` (array) — outputs to N handles |
| `delay` | `ms` — pauses execution |
| `set-variables` | `assignments` (array of `{key, value}`) — values support `{{templates}}` |
| `filter` | `condition` — stops execution if false |

**Condition expressions** use `expr-eval`. Access data as `vars.key`, `message.text`, `agent.response`, etc.

### Memory
| Node | Key Config |
|------|------------|
| `memory-recall` | `query` (supports `{{templates}}`), `limit` |
| `memory-store` | `extractMode` (auto/manual), `type` (fact/summary/etc), `manualContent` (supports `{{templates}}`) |

### Tool
| Node | Key Config |
|------|------------|
| `system-command` | `action` (pc-specs/list-files) |
| `http-request` | `url`, `method`, `headers`, `body` (supports `{{templates}}`) |
| `run-code` | `code` (JS sandbox — set `result` variable), `timeout` (ms) |
| `read-file` | `path` |
| `write-file` | `path` (supports `{{vars.ts}}`), `content` (supports templates), `mode` (overwrite/append) |
| `board-task` | `action` (list/create/update/delete/claim/release), `boardId`, `title`, `organizationId`, `goalId` |
| `document-tool` | `action` (list/search/get), `limit` |
| `workflow-template` | `action` (list-templates/list-workflows) |
| `scheduler-job` | `action` (list) |
| `date-time` | `operation` (now/add/subtract/format), `amount`, `unit`, `timezone`, `outputStyle` |
| `channel-status` | `format` (summary/full) |
| `council` | `topic` (supports templates), `decisionMode` (majority/consensus/weighted), `optionsText` |

**run-code sandbox:** Access `input` (previous node output), set `result` variable. No `require()`, no `process`, no `__dirname`. Use `JSON`, `Math`, `Date`, `String`, `Number`, `Array`, `Object`.

### Voice
`voice-stt` (language, model), `voice-tts`

### Advanced Logic
`loop`, `aggregate`, `merge` (2 inputs), `error-handler` (success/error handles), `wait-for-input`, `rate-limiter`

### Advanced Data
`json-transform` (expression field), `split-text` (text + delimiter + maxChunks), `regex-extract` (text + pattern + flags), `compare-text` (textA + textB + operator)

### Advanced Tool
`database-query` (raw SQL against disp8ch SQLite), `clipboard`, `notification`, `git-operation`, `archive`

---

## Built-In Agent Tools

Available to `claude-agent` nodes. Enable per-agent in Agents → node config → Tools tab.

| Tool | What it does |
|------|-------------|
| `bash_exec` | Run shell commands |
| `read_file` | Read file contents |
| `write_file` | Write/append to files |
| `list_files` | List directory contents |
| `http_request` | SSRF-guarded HTTP calls |
| `browser_action` | Playwright: navigate/click/type/screenshot/snapshot/click_ref/fill_ref/pdf |
| `memory_search` | Search memory (query/limit/min_score) |
| `session_recall` | Search indexed session transcripts |
| `memory_get` | Get specific memory file (path/lines) |
| `memory_store` | Store a memory entry (type/content/confidence) |
| `memory_gpt` | LLM-assisted memory reranking |
| `run_python` | Execute Python code |
| `schedule_task` | Create a cron job programmatically |
| `web_search` | Web search (provider configurable in Settings → General) |
| `take_screenshot` | Capture desktop screenshot |
| `pc_specs` | Get system hardware info |
| `documents_list` | List data sources |
| `documents_search` | Search data source content |
| `document_get` | Get a specific document |
| `get_clipboard` / `set_clipboard` | Read/write clipboard |
| `send_notification` | Desktop notification |
| `send_message` | Send to any of 8 channels (telegram/discord/whatsapp/webchat/google-chat/slack/bluebubbles/teams) |
| `sessions_spawn` | Spawn Claude Code / Gemini CLI / Codex sub-agent (permission_mode: ask/auto/full; worktree=true for git isolation) |
| `agent_inbox` | Disp8chTeam P2P messaging (send/receive/peek/list/broadcast) |
| `init_experiment` | Set up metric-driven optimization session |
| `run_experiment` | Execute benchmark, parse METRIC outputs |
| `log_experiment` | Commit/revert on keep/discard/crash |

**Tool approval policy** (set per agent node):
- `approvalMode`: off | model | human
- `execSecurity`: deny | allowlist | full
- `execAsk`: off | on-miss | always
- `execAllowlist`: array of allowed command names

---

## `disp8chn` CLI Reference

```bash
# Setup & Health
disp8chn init [--ensure-env] [--timezone <tz>] [--onboarding-done]
disp8chn status
disp8chn health
disp8chn doctor          # checks config, DB, models, env
disp8chn env
disp8chn help

# Models
disp8chn models list
disp8chn models recommend
disp8chn models add
disp8chn models probe
disp8chn models probe-tools
disp8chn models remove
disp8chn models set-priority

# Memory
disp8chn memory embedding-status
disp8chn memory stats
disp8chn memory list
disp8chn memory search
disp8chn memory clear
disp8chn memory rebuild-index
disp8chn memory index-sessions
disp8chn memory index-collections
disp8chn memory backfill

# Workflows
disp8chn workflows list
disp8chn workflows create
disp8chn workflows delete

# Agents
disp8chn agents list
disp8chn agents create
disp8chn agents update
disp8chn agents delete
disp8chn agents default

# Data Sources
disp8chn data-sources list
disp8chn data-sources search
disp8chn data-sources get
disp8chn data-sources upload
disp8chn data-sources scrape
disp8chn data-sources crawl
disp8chn data-sources delete

# Boards
disp8chn boards list
disp8chn boards create
disp8chn boards delete
disp8chn boards tasks
disp8chn boards create-task
disp8chn boards run-task
disp8chn boards claim-task
disp8chn boards release-task
disp8chn boards delete-task

# Hierarchy
disp8chn orgs list|current|save-current|switch|delete
disp8chn goals list|create|delete

# Extensions & Skills
disp8chn extensions list|status|enable|disable|config-get|config-set
disp8chn skills list
disp8chn skills install <source> [ref]   # e.g. github.com/user/repo
disp8chn skills update <id>
disp8chn skills uninstall <id>

# Config
disp8chn config show [--json]
disp8chn config get <key>
disp8chn config set <key> <value>
disp8chn config validate

# Key config keys:
# tool.output_limit · compaction.mode · compaction.threshold
# context.pruning.mode · memory.flush_enabled · memory.decay.enabled
# memory.embedding_model · memory.vector_weight · memory.text_weight
# memory.search_backend · memory.rerank_strategy
# web_search_provider · web_search_api_key · browser_cdp_url
# ratelimit.webhooks · ratelimit.execute · ratelimit.channels · log.max_days

# Secrets
disp8chn secrets list
disp8chn secrets set <name> <value>
disp8chn secrets remove <name>

# ACP (Agent Communication Protocol)
disp8chn acp status
disp8chn acp test
disp8chn acp sessions
disp8chn acp reset-session
disp8chn acp serve

# Backup
disp8chn backup create
disp8chn backup list
disp8chn backup verify

# Auth
disp8chn auth google
disp8chn auth status
disp8chn auth revoke
```

---

## Settings Tabs (`/settings`)

| Tab | What it configures |
|-----|--------------------|
| **Models** | Add/remove/prioritize providers; set API keys or `secret:NAME` refs |
| **Channels** | Enable Telegram/Discord/WhatsApp/Google Chat/Slack/BlueBubbles/Teams; view status |
| **Memory** | Embedding model; search backend/rerank; vector/text weights; citations mode; snippet/inject char caps; session indexing; startup files; custom collection paths |
| **Tools** | Add custom bash/JS tools; set per-tool config |
| **General** | Tool output limit; context pruning + compaction; retry policy; rate limits; log retention; telemetry + hooks toggles; memory flush + decay |
| **Secrets** | Create/view/delete encrypted `app_secrets` entries (referenced as `secret:NAME`) |
| **Google** | OAuth status; refresh/revoke Gmail access token |
| **Config (raw)** | Form + JSON editor with presets (Balanced/High Reliability/Throughput); import/export; per-field reset |
| **Validate** | Run runtime readiness check; shows missing keys, misconfigured fields |
| **Security** | Security posture audit: public API surface, auth boundaries, secrets posture, ingress trust, workflow exec risk |

---

## Sidebar Navigation

**Control:** Dashboard · Docs · Workflows · Boards · Data Sources · Files · Scheduler  
**Monitoring:** Activity · Approvals · Metrics · Usage · Logs · Debug · Maintenance  
**People:** Agents · Hierarchy · Council · Tags · Skills · Extensions · Memory  
**Connect:** Channels · WebChat  
**Settings:** Settings  

Redirects: `/live` → `/activity`, `/costs` → `/metrics`

---

## Boards

**Status values:** `inbox` | `in_progress` | `review` | `done` | `blocked`  
**Priority values:** `low` | `medium` | `high` | `urgent`

Board tasks auto-block when `blockedBy` task IDs are provided. They auto-unblock when all blocking tasks reach `done`.

**API:** `POST /api/boards/tasks` with `{ boardId, title, description?, status?, priority?, blockedBy?: string[] }`

**Run a task:** `POST /api/boards/tasks/run` with `{ taskId }` — creates and executes a workflow from the task.

**Layout:** Jira-style Kanban (Inbox / In Progress / Review / Done). Org/goal filters, "+ New Task" panel with Quick Task / From Template / From Document tabs. Drag-and-drop between columns.

---

## Memory System

**Storage:** Atomic `data/memories/*.md` + durable `MEMORY.md` + daily audit logs.  
**Search:** Hybrid FTS5 BM25 + cosine vector similarity (default weights: 0.7/0.3).  
**Embeddings:** `local` (Transformers.js offline), Google `gemini-embedding-001`, OpenAI, Ollama, Mistral, Voyage.

**API:**
```
GET  /api/memory?action=search&query=<q>&limit=5    # search memories
GET  /api/memory?action=list                         # list all memories
GET  /api/memory?action=journal                      # journal entries
GET  /api/memory?action=session-recall               # session transcript hits
POST /api/memory  { content, type, extractMode }    # store a memory
DELETE /api/memory?id=<id>                           # delete a memory
```

**Important:** Use `?action=search&query=...` — NOT `&q=...` (q param silently returns empty).

**Memory types:** `fact` · `summary` · `preference` · `skill` · `context` · `journal`

**Explorer UI** at `/memory`: user/agent/resource/skills splits + retrieval-explain visibility.

---

## Hierarchy & Council

**Hierarchy** (`/hierarchy`): Organizations → Goals → Board Tasks. Topology tree shows org structure. Goal Focus panel for status/level updates inline.

**Council** (`/council`): Multi-agent deliberation. Participants vote on a topic with configured options. Decision modes: majority / consensus / weighted.

**Org collaboration routing in WebChat:**
- Discussion/verdict/consensus asks → Leadership Council mode
- Investigate/analyze/plan/execute asks → Hierarchy execution orchestration
- Type `switch to execution mode` or `switch to council mode` to toggle

---

## Multi-Provider LLM

Supported providers: Anthropic · OpenAI · Google Gemini · Groq · Together · OpenRouter · Ollama · vLLM · SGLang · LM Studio · DeepSeek · Mistral · Zhipu · Moonshot · xAI

**Model aliases:** `opus` → Claude Opus, `sonnet` → Claude Sonnet, `gpt4` → GPT-4o, `gemini` → Gemini, `llama` → Llama via Ollama

Local providers (Ollama/vLLM/SGLang/LM Studio) don't need API keys. Ollama model discovery uses `/api/tags`; others use `/models`.

**Adding a provider via API:**
```
POST /api/models { provider, modelId, apiKey, priority }
```

**Secrets in model config:** Use `secret:NAME` as the API key value to reference encrypted secrets stored in `app_secrets`.

---

## Cron Scheduler

New cron workflows need `POST /api/cron { action: "resync" }` to be picked up by the in-memory scheduler.

**`/api/cron`:**
- `GET` — returns `{ summary: { totalJobs, activeJobs, liveCount }, jobs[] }`
- `POST { action: "run", workflowId }` — run immediately
- `POST { action: "toggle", workflowId }` — pause/resume
- `POST { action: "resync" }` — reload scheduler from DB

**Cron expression format:** `minute hour day-of-month month day-of-week`  
Examples: `0 9 * * *` (daily 9am) · `*/30 * * * *` (every 30m) · `0 9 * * 1-5` (weekdays 9am)

---

## Common Workflow Patterns

### Simple Chat
```
message-trigger → claude-agent → send-webchat
```

### Cron Report
```
cron-trigger → set-variables (seed context) → [gather data nodes] → run-code (build report) → set-variables (stage reportBody) → write-file → memory-store → send-webchat
```

### If/Else Branch
```
set-variables (flag=yes) → if-else (condition: vars.flag == "yes") → [true: send-webchat] / [false: memory-store]
```

### Error-Resilient Pipeline
```
cron-trigger → run-code → error-handler → [success: claude-agent → memory-store] / [error: send-webchat (alert)]
```

### Parallel Research
```
manual-trigger → parallel-agents (3 workers) → aggregate → claude-agent (synthesis) → memory-store → send-webchat
```

---

## Known Gotchas

- `executions` table uses `started_at` — NOT `created_at`
- Ollama embed endpoint is `/api/embed` — NOT `/v1/embeddings`
- Memory search API: use `?action=search&query=...` — NOT `&q=...` (silent empty return)
- New cron workflow not appearing in scheduler → call `POST /api/cron { action: "resync" }`
- `set-variables` stages values into `{{vars.key}}` — these persist across all subsequent nodes
- `memory-store` with `extractMode: manual` resolves `{{templates}}` in `manualContent`
- After `write-file`, the `run` namespace is still accessible via `{{run.result.*}}` — but staging into `vars` first is safer
- `run-code` sandbox: set `result` variable to return output; access previous data via `input`
- `if-else` condition uses expr-eval — use `==` not `===`; access `vars.key` or `message.text` directly
- `board_tasks.status`: 5 values only — `inbox` | `in_progress` | `review` | `done` | `blocked`
- Top-level `node:fs` in shared file → client bundle crash → use inline `require()` with `typeof window` guard
- WebChat POST: `{ action: "chat", sessionId, message }` — NOT `{ channel, message }`
- `handleBuiltinCommands()` runs before workflow matching — builtin commands always short-circuit

---

## Agent Workspace Files

Each agent in `/agents` has editable files in the Files tab:

| File | Purpose |
|------|---------|
| `SOUL.md` | Core personality and communication style |
| `USER.md` | User profile — preferences, habits, context |
| `IDENTITY.md` | Agent's self-description and capability boundaries |
| `TOOLS.md` | Instructions for how this agent should use tools |
| `MEMORY.md` | Durable memory entries (auto-updated by memory system) |
| `BOOT.md` | Startup instructions loaded on every conversation |
| `AGENTS.md` | Team context — other agents, roles, handoff rules |
| `HEARTBEAT.md` | Optional periodic check-in instructions |
| `BOOTSTRAP.md` | One-time setup context loaded on first run |

---

## Security Model

- No `eval()` — expressions via sandboxed `expr-eval`; custom JS via `vm.runInNewContext()`
- Webhook secrets: HMAC-SHA256, `crypto.timingSafeEqual` (not `!==`)
- API keys encrypted at rest: AES-256-GCM via `ENCRYPTION_KEY` in `app_secrets`
- Admin routes (`/api/debug`, `/api/logs`, `/api/secrets`) require session or `x-disp8ch-admin-token`
- Control-plane APIs require session or admin token
- SSRF guard on `http_request` tool — private IP ranges blocked
- Exec hardening: invisible-Unicode detection, null-byte rejection, timing-safe token checks

---

## Where to Find Things

| I want to… | Go to |
|------------|-------|
| Create/edit a workflow | `/workflows` → open editor |
| Browse templates | `/workflows` → Templates tab |
| Manage cron schedules | `/scheduler` |
| View live execution | `/activity` |
| Approve tool use | `/approvals` |
| See token/cost usage | `/usage` |
| Manage board tasks | `/boards` |
| Browse documents/data | `/documents` |
| Edit agent personality | `/agents` → select agent → Files tab |
| Enable skills per agent | `/agents` → select agent → Skills tab |
| Configure channels | `/settings` → Channels tab |
| Add/change AI models | `/settings` → Models tab |
| Manage encrypted secrets | `/settings` → Secrets tab |
| Configure memory/embeddings | `/settings` → Memory tab |
| Check system health | `disp8chn doctor` or `/settings` → Validate tab |
| Search memories | `/memory` or `disp8chn memory search` |
| View org/goal hierarchy | `/hierarchy` |
| Run a council debate | `/council` |
| Manage skill packs | `/skills` |
| Install external skills | `disp8chn skills install <github-url>` |
