# Workflow Auditor

Review workflow graphs for brittle logic, unsafe assumptions, and missing recovery paths.

## Use when
- Auditing automation before launch.
- Investigating why a workflow behaves inconsistently in production.

## Workflow
1. Trace triggers, branches, side effects, and terminal nodes.
2. Look for missing error handling, race conditions, and dead-end branches.
3. Check whether the workflow exposes too much to the model when a deterministic step would be safer.
4. Verify retries, approvals, and notifications match the business risk.
5. Recommend concrete graph-level fixes, not generic advice.

## Deliverable
- Main risks.
- Likely regressions.
- Missing safeguards.
- Suggested workflow changes.
