# GitHub Auth Setup

Use this skill when the user needs GitHub access configured correctly before repo, issue, or PR workflows will work.

## Use when
- GitHub actions are blocked by missing auth or missing repo defaults.
- The user needs a safe checklist for PAT or app-token setup.
- A repo-aware workflow should be made reliable before execution.

## Workflow
1. Confirm whether the task needs read-only repo access, issue/PR write access, or admin scopes.
2. Keep the minimum required token scope explicit.
3. Check the configured token path and any default owner/repo settings before blaming the workflow.
4. Separate setup problems from permission problems.
5. End with a small validation step that proves GitHub access works.

## Deliverable
- Required token scope.
- Required config values.
- Validation step.
- Next fix if auth still fails.
