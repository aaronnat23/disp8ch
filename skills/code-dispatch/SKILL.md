# Code Dispatch (ACP-style Coding Agent Delegation)

Delegate coding, file-system, and research tasks to a real CLI agent running on the user's machine.
The orchestrator stays clean — no token overhead, no context window bloat. The specialist executes.

## When to use

- Complex coding tasks that require multi-file edits, running tests, or reading the repo
- File-system operations beyond simple read/write (refactors, scaffolding, migrations)
- Research tasks that benefit from live CLI tools (git, grep, compilers, package managers)
- Any task where Claude Code's local tools + MCP servers give better results than inline agent calls

## Rules

**Agent ID:** Always `agent: "claude"` (not "claude-code"). Use `"gemini"` or `"codex"` only when explicitly requested.

**Mode selection by channel:**
- Discord: `mode: "session"` + `thread: true` for multi-step work; `mode: "run"` for one-shot
- Telegram / WhatsApp / Slack / Teams / BlueBubbles / WebChat: Always `mode: "run"` — async thread binding is not available on these channels

**Permission mode:**
- `permission_mode: "approve-reads"` (default): allows reads, prompts for writes/exec — safe for most tasks
- `permission_mode: "approve-all"`: auto-approves all tool calls — only use for trusted, well-defined tasks
- `permission_mode: "deny-all"`: read-only (Read, Glob, Grep, LS only) — use for audits or safe exploration

**Timeout:** Always set `timeout_seconds` (default 120, max 300). For complex refactors use 300.

**Never nest:** Do not call `sessions_spawn` from within a spawned session. The orchestrator dispatches; the specialist does the work.

**Working directory:** Always specify `cwd` pointing to the relevant project directory.

## Example — Discord multi-step session

```json
{
  "tool": "sessions_spawn",
  "agent": "claude",
  "mode": "session",
  "thread": true,
  "permission_mode": "approve-all",
  "cwd": "/path/to/project",
  "task": "Refactor the auth module to use JWT. Run tests after each file change.",
  "timeout_seconds": 300,
  "label": "Auth JWT refactor"
}
```

## Example — one-shot on any channel

```json
{
  "tool": "sessions_spawn",
  "agent": "claude",
  "mode": "run",
  "stream_to": "parent",
  "permission_mode": "approve-all",
  "cwd": "/path/to/project",
  "task": "Add a greet() function to src/utils.ts and export it.",
  "timeout_seconds": 120
}
```

## After dispatch

- Confirm task receipt to the user: "Dispatched to Claude Code — working on it."
- On `mode: "run"`: relay the result directly in your reply.
- On `mode: "session"` + Discord: tell the user they can continue in the created thread.
- On error: summarize the failure and suggest breaking the task into smaller steps.
