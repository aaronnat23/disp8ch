# Subagent-Driven Development

Use this skill when the work should be decomposed into parallel, well-scoped tracks instead of handled as one monolithic task.

## Use when
- The task spans multiple independent implementation or verification slices.
- The user wants speed from parallel work without losing coordination.
- One agent should own orchestration while others own bounded subtasks.

## Workflow
1. Break the task into independent write scopes or investigation scopes.
2. Keep the immediate critical path local and delegate only sidecar work that will not block the very next step.
3. Give each worker a clear responsibility, expected output, and file or module boundary.
4. Reconcile results into one coherent outcome instead of pasting them together blindly.
5. Verify the integrated result with focused regression checks.

## Deliverable
- Subtask breakdown.
- Ownership boundaries.
- Integration notes.
- Final verification summary.
