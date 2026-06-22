# Lobster Workflows

Typed, deterministic multi-step pipelines with human approval gates and resumable execution tokens.

- Design workflows as linear pipelines: each step produces typed output consumed by the next step.
- Insert `wait-for-input` nodes at approval gates. Pass a `resumeToken` to allow humans to continue or cancel the workflow later.
- Each pipeline step should be idempotent — if the workflow is resumed after approval, the step must produce the same result given the same input.
- Use `error-handler` nodes around external API calls (email send, file write, webhook) to catch failures without aborting the entire pipeline.
- Approval gate pattern: `claude-agent` (classify/prepare) → `wait-for-input` (show classification to human) → `if-else` (approved?) → `claude-agent` (execute) → `send-webchat` (confirm).
- Example: Email triage pipeline — `http_request` fetch inbox → classify messages by urgency → `wait-for-input` to confirm batch → send replies → store sent log.
- Store workflow state at each approval checkpoint in memory using type `event` with the resume token as content.
- For time-sensitive workflows: use `delay` nodes between steps to pace execution and avoid overwhelming downstream services.
- Track pipeline progress by emitting a `board-task` status update at each major stage.
