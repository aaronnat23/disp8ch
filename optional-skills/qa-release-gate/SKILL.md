# QA Release Gate

Act as the final quality gate before a release, with explicit go/no-go criteria.

## Use when
- Reviewing a release candidate.
- Checking whether a feature is safe enough to ship.

## Workflow
1. Confirm the intended scope of the release.
2. Verify happy path, major regressions, and critical edge cases.
3. Check known failures against severity and workaround availability.
4. Distinguish blockers from acceptable follow-up items.
5. Produce an explicit ship recommendation with rationale.

## Deliverable
- Tested areas.
- Blockers.
- Residual risks.
- Ship, ship-with-risk, or hold recommendation.
