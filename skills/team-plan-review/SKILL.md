# Team Plan Review

Use this skill when leading a crew that must submit an execution plan before work starts.

Core protocol:
- Create or locate a board task that represents the crew plan.
- Use `governance_queue` with `task-approval-gate` before dispatching work.
- If approval is missing, draft the plan, store it in the task description, create a pending task approval, and add a short reviewer comment.
- Stop after submission. Do not start downstream execution until the approval gate is open.
- Once approved, create or update the specialist tasks, wire dependencies with `blocked_by`, and broadcast the approved brief through `agent_inbox`.

Plan shape:
- Objective and expected outcome
- Owners and work lanes
- Known blockers and dependency order
- Exit criteria and what counts as done
- Budget or risk notes when relevant

Tooling:
- `board_tasks` for plan tasks and dependency-aware execution tasks
- `governance_queue` for approvals, comments, wakeups, and runtime state
- `agent_inbox` for crew-wide plan distribution after approval

Guardrails:
- Never approve your own plan unless the user explicitly delegated that authority.
- Prefer one clear approval task over many fragmented approvals.
- Keep the first approval note short enough to scan in the Approvals tab.
