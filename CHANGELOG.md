# Release Notes

## Unreleased

### Cross-surface memory candidates

- Context can move into durable memory from chat, a workflow result, a Board
  task, a Council verdict, or a notebook finding through one evidence-linked,
  reviewable path. Candidates are not memory: nothing is retrievable until a
  candidate is explicitly applied.
- Promotion reuses the exact `applyMemoryOperations` + visibility code that
  direct workflow memory uses, so workflow-private scope stays private (enforced
  before ranking) and broader agent sharing remains explicit. Scope, workflow
  id, execution id, and node id come from runtime context, never from model
  arguments.
- The Memory Store node gains a "Review before saving" option that proposes a
  candidate instead of writing; the default stays direct-save so deliberate
  user-authored nodes are unchanged. WebChat self-learning memory proposals now
  become candidates (skill/test proposals keep their existing queue). Boards,
  Council, and notebooks expose a compact "Propose memory" action.
- Deterministic conflict and freshness checks classify and flag only — never
  auto-resolve: exact duplicates offer "Reinforce existing"; a semantically
  similar candidate that contradicts an existing preference/fact is flagged as a
  possible conflict and requires the operator to choose Keep both, Replace,
  Mark superseded, or Reject. Fact-like candidates get a review window;
  preferences and identity facts never auto-expire.
- Review lives in the existing Memory Explorer ("Review candidates" section,
  not a new tab) with source/scope badges, evidence, conflict state, an exact
  write preview, and a direct link back to the originating surface. Candidate
  state transitions are audited through `memory_promotion_events`.

## 1.1.1 - 2026-06-24

### Workflow approval and memory scope

- Every material workflow side effect is classified by a single canonical effect
  model and checked immediately before its handler runs — normal nodes, loop
  bodies, retries, partial runs, sub-workflows, and dynamic runs all pass through
  one executor guard. No side-effect-capable path bypasses it.
- Configuration-sensitive nodes are classified by their actual settings: an HTTP
  GET is a read while a POST is an external write and a DELETE is destructive;
  SQL is classified by verb with unbounded UPDATE/DELETE and schema changes
  treated as destructive; git, system command, clipboard, document, scheduler,
  and board actions are classified per action.
- Approval modes: `balanced` (reads run automatically, low-risk reversible local
  writes run automatically, external writes/sends need approval, destructive/
  credential/financial need just-in-time human approval, unknown is denied),
  `strict` (every write/send needs human approval), and `custom` (per-node
  auto/human/deny). Existing workflows without a policy keep working but surface
  audit warnings.
- Approvals are durable, hash-bound, and one-time: a grant authorizes the exact
  workflow version, node, target, and payload, so a changed action cannot reuse
  an old approval and a completed side effect cannot be repeated. They appear on
  the existing Approvals surface and Attention Center beside tool/MCP/task
  approvals.
- Tools called inside an AI Agent inherit the workflow's effect policy, so an
  HTTP write, browser mutation, message send, or destructive tool cannot bypass
  the boundary by being nested inside an agent node. The approval UI names the
  workflow and step, shows a redacted exact-action preview, and offers only
  Deny or Allow Once.
- A small hardline floor blocks catastrophic host operations (raw-disk writes,
  filesystem-root deletion, host shutdown, fork bombs) that no approval — human,
  model, saved grant, cron, or retry — can authorize.
- Unattended cron/webhook/background runs fail closed for high-risk and
  irreversible effects unless a bound pre-authorization matches.
- Workflow memory is now scoped: a workflow's saved memory is private to that
  workflow by default for new nodes, and is shared with an agent only when
  "This agent" is selected. Scope is enforced before ranking and derived from
  runtime context, never from model arguments. The AI Agent node can run with no
  durable memory, this-workflow memory, or full agent memory; "this workflow" and
  "no durable memory" exclude the agent-wide MEMORY.md. Existing nodes normalize
  to agent scope for compatibility.
- The Security audit reports unknown-effect nodes, legacy agent-wide workflow
  memory, and external sends that can run unattended without an approval policy.
  The pre-run dry-run now summarizes automatic, approval, and blocked steps plus
  each node's effect badge and memory scope.

### Model setup documentation

- README and Help & Docs now explain all supported first-model setup paths:
  online API keys, fully local models, Claude account OAuth for Anthropic model
  access, and Codex account sign-in for optional coding-agent delegation.
- OAuth guidance now emphasizes local auth state, secret references, validation,
  and the distinction between primary chat providers and optional coding-agent
  backends.
- Public-release validation allows intentional Codex OAuth documentation while
  still blocking private backend markers, credential-shaped values, local auth
  files, databases, and private workspace state.

## 1.1.0 - 2026-06-23

Hardware-aware local model setup, governed MCP execution, stronger browser navigation, and professional public-release automation.

### Local model setup

- Hardware-aware quality, balanced, and speed recommendations from installed GGUF files, exact Ollama tags, detected runtimes, and current RAM/VRAM evidence.
- MoE-aware GGUF metadata, native llama.cpp fit evidence, honest hybrid and memory-risk classifications, and already-loaded model detection.
- Already-running llama-server recommendations now show one concise readiness message instead of repeating status text and launch commands on every card.
- Confirmation-gated local calibration and non-blocking post-connection advice without automatic downloads or model replacement.

### MCP governance

- Agent and organization scope applied consistently to MCP discovery and execution.
- Open, guarded, and strict approval postures with a human floor for write and unknown tools.
- Redacted, one-time approval records with scope rechecks, originating-session delivery, audit history, and Attention Center visibility.

### Design, WebChat, and release quality

- Design briefs containing feature cards or follow-up wording no longer misroute as board mutations.
- Natural requests for browser navigation or other tool families now reach the agent tool loop instead of being mistaken for workflow names or app-action plans.
- Browser navigation now puts compact semantic headings, articles, and list items before page chrome while preserving visible page order, improving local-model accuracy on dynamic pages.
- XML-style direct tool-call elements are blocked from user-visible answers.
- Help & Docs includes a permanent, collapsible release history.
- The README now gives non-technical users a guided Speed, Balanced, or Quality local-model setup path.
- Public exports include this changelog and the associated release regressions.

## 1.0.0 - 2026-06-23

Initial public release of the local-first disp8ch AI workspace.

### Highlights

- Agentic WebChat, background agents, Activity, Work Monitor, and attention notifications.
- Hosted and local providers with hardware-aware quality, balanced, and speed recommendations.
- Visual workflows, schedules, signed webhooks, approvals, queues, replay, versions, and run history.
- Boards, Hierarchy, Council, Dynamic Runs, and reusable research departments.
- Data Sources, notebooks, local memory, reviewable learning, skills, extensions, and MCP servers.
- Persistent Design Studio artifacts with uploads, preview, source editing, versions, validation, and export.
- Hardened desktop shell with shortcuts, native notifications, deep links, update verification, and database import.
- Secret references, redaction, operator-gated APIs, approval boundaries, and clean public-release export checks.

The in-app version is available under **Help & Docs -> Release Notes**.
