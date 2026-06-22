# GitHub PR Workflow

Handle pull-request work as a clean sequence: inspect, review, patch, verify, and summarize.

## Use when
- A user asks for PR review, follow-up commits, or merge-readiness checks.
- GitHub issues, PRs, and repo state all matter to the answer.

## Workflow
1. Identify the repo, branch, PR, or issue context first.
2. Read the diff and classify risk before proposing changes.
3. Prefer concrete findings: bug risk, missing tests, rollback risk, or docs drift.
4. If code changes are needed, patch the smallest safe scope and verify locally.
5. End with a concise PR-style summary: findings, fixes, tests, and open risks.

## Deliverable
- Clear review findings or implementation outcome.
- Relevant repo/PR references.
- Verification summary.
- Remaining blockers before merge.
