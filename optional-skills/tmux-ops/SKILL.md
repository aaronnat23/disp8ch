# Tmux Ops

Use tmux-style session management when a task needs parallel terminal work, durable panes, or resumable long-running commands.

## Use when
- The work benefits from multiple concurrent terminal views.
- A long-running server, watcher, or test loop should stay attached in the background.
- The user wants a reproducible terminal layout for an investigation or rollout.

## Workflow
1. Name the purpose of each pane or session before creating or reusing it.
2. Keep one pane for the main app, one for logs, and one for validation where possible.
3. Prefer idempotent commands so a pane can be recreated safely.
4. Record the commands and expected signals that indicate the session is healthy.
5. Tear down or hand off the session cleanly when the task ends.

## Deliverable
- Session layout.
- Commands running in each pane.
- Health signals to watch.
- Cleanup or handoff notes.
