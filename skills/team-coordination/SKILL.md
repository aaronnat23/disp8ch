# Team Coordination Skill (Disp8chTeam-style)

Inspired by the Disp8chTeam multi-agent coordination framework — enables you to organize AI agents into collaborative crews with workspace isolation, P2P messaging, and dependency-aware task management.

---

## Core Capabilities

### 1. Agent Inbox — Point-to-Point Messaging

Agents can send and receive structured messages to coordinate work without polling or shared state.

**Actions:**
- `send` — deliver a message to another agent
- `receive` — pop the oldest unread message from your inbox
- `peek` — read without consuming
- `list` — show unread counts for all inboxes
- `broadcast` — send the same message to all known agents

**Example: Orchestrator sends task to analyst**
```
agent_inbox(action="send", to="analyst-agent", from="orchestrator",
  subject="Research task", content="Please analyze NVIDIA's technical moat. Write output to ./crew-output/cto.md")
```

**Example: Worker signals completion**
```
agent_inbox(action="send", to="orchestrator", from="cto-agent",
  subject="Done", content="CTO analysis complete. File: ./crew-output/cto.md")
```

**Example: Orchestrator collects results**
```
agent_inbox(action="receive", recipient="orchestrator")
```

Messages persist to `data/inbox/<agentId>/` and survive server restarts.

---

### 2. Workspace Isolation (Git Worktrees)

Each spawned coding agent can run in its own isolated git worktree — a separate branch so parallel agents don't conflict on the same files.

**Usage in sessions_spawn:**
```
sessions_spawn(task="Implement OAuth2 module", agent="claude",
  worktree=true, cleanup="delete")
```

- Creates a branch: `disp8chteam/session/<uuid>`
- Agent runs in `/tmp/disp8ch-wt-<id>/`
- On `cleanup=delete`, worktree is removed automatically
- Output appears in the worktree directory; merge back manually

**When to use:** When 3+ agents are working on different files in the same repo simultaneously. Prevents git conflicts.

---

### 3. Task Dependencies (`blocked_by`)

Board tasks can declare dependencies on other tasks. A task with `blocked_by` starts in `blocked` status and auto-transitions to `inbox` when all blockers complete.

**Create a dependent task via API:**
```json
POST /api/boards/tasks
{
  "boardId": "main-board",
  "title": "CEO Executive Briefing",
  "description": "Synthesize analyst reports into executive brief",
  "blockedBy": ["task-id-cfo", "task-id-cto", "task-id-strategy"]
}
```

**Auto-unblock:** When a task moves to `done`, any tasks that listed it in `blockedBy` are automatically checked — if all their blockers are done, they transition to `inbox`.

**Status values:** `inbox` | `in_progress` | `review` | `done` | `blocked`

---

### 4. Workflow Templates

Two Disp8chTeam-inspired workflow templates available:

**`ai-crew-orchestrator`** — Single orchestrator agent that uses `sessions_spawn` to spawn role-specific workers (CFO, CTO, Strategy, Product, CEO). Each worker writes to a shared output directory. Workers run in isolated worktrees. Orchestrator synthesizes the results. Best for complex multi-perspective analysis tasks.

**`parallel-spawn-crew`** — Visual node-based fan-out: parallel-agents node spawns 3 workers (Research Analyst, Risk Analyst, Strategy Consultant) simultaneously. An aggregate node collects results. A synthesis agent writes the executive brief. Best for structured 3-perspective analysis workflows.

---

## Team Patterns

### Pattern 1: Dispatch and Collect
```
1. Orchestrator: agent_inbox broadcast mission to all workers
2. Orchestrator: sessions_spawn each worker (worktree=true, mode=run)
3. Workers: write output files to shared directory
4. Workers: agent_inbox send "Done" to orchestrator
5. Orchestrator: agent_inbox receive all messages
6. Orchestrator: read_file each output, synthesize
```

### Pattern 2: CEO-Last Synthesis
```
1. Spawn 4 specialists in parallel (CFO/CTO/Strategy/Product)
2. Each specialist writes ./crew-output/<role>.md
3. CEO agent reads all 4 files, writes executive-brief.md
4. Send brief to notification channel
```

### Pattern 3: Dependency Chain
```
1. Create tasks with blockedBy for sequential dependencies
2. Task A (research) → unblocks Task B (analysis) → unblocks Task C (synthesis)
3. Each task auto-activates when predecessors complete
```

---

## Best Practices

- **Worktrees for parallel writes:** Always use `worktree=true` when multiple agents write to the same repo
- **Inbox for async coordination:** Prefer agent_inbox over polling files — it's designed for P2P
- **cleanup=delete for one-shot workers:** Prevents worktree accumulation
- **Shared output directory:** Workers write to a common dir; orchestrator reads from it — the "shared filing cabinet" pattern from the article
- **Spawn depth guard:** sessions_spawn enforces max depth = 1; spawned agents cannot re-spawn
- **Discord threading:** In Discord, use `thread=true` with `mode=session` to get a named thread per worker — teams can then communicate with individual workers directly
