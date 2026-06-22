---
platforms: [linux, macos, windows]
setup_notes:
  - Start with the health endpoint and recent logs before digging into deeper traces.
---

# Healthcheck

Run a fast operational health pass before deeper debugging.

## Use when
- A user asks whether the app is healthy after a change.
- You need a quick readiness snapshot before a release or demo.

## Workflow
1. Check health endpoints and recent error logs.
2. Verify critical channels, workflow execution, and storage reachability.
3. Separate hard failures from warnings or degraded dependencies.
4. Return a short summary with blockers first.
