# Crew Lifecycle

Use this skill when coordinating a live crew across hierarchy, approvals, and boards.

Lifecycle states:
- `planning`: define scope, create the plan task, request approval
- `ready`: approval granted, dependencies created, wakeups queued
- `executing`: specialists are working and blocked tasks are tracked
- `waiting`: crew is paused on approval, blockers, or missing input
- `closing`: synthesis, handoff, and cleanup

Operating pattern:
- Keep one board task for the mission and separate child tasks for the active work lanes.
- Use `blocked_by` so synthesis or rollout tasks do not start too early.
- Use `governance_queue enqueue-wakeup` when a teammate should resume work.
- Use `agent_inbox` to broadcast mission changes or decisions to the crew.
- Check `governance_queue agent-runtime` when a member appears stalled or failed.

What to report:
- Pending approvals
- Blocked tasks
- Queued wakeups
- Members with unread inbox items
- Last failed agent or workflow

Avoid:
- Starting execution without a plan or approval when one is required
- Leaving blocked tasks without visible blockers
- Spamming wakeups without changing the task state or message context
