# Parallel CLI

Use multiple independent CLI checks in parallel when the question is bottlenecked on I/O rather than reasoning.

## Use when
- Several bounded shell checks can run at the same time.
- You want faster repository or environment inspection without changing behavior.

## Workflow
1. Split only independent commands into parallel work.
2. Keep each command narrow and easy to interpret.
3. Recombine the results into one clear conclusion.
4. Avoid parallel writes or destructive operations.
