# Systematic Debugging

Debug failures methodically instead of jumping between guesses.

## Use when
- A bug is reproducible but the root cause is unclear.
- A fix was attempted already and did not hold.

## Workflow
1. State the expected behavior, actual behavior, and the smallest known failing path.
2. Check logs, recent changes, and nearby state before editing code.
3. Form one concrete hypothesis at a time and test it with direct evidence.
4. Narrow the fault to a file, branch, config edge, or integration boundary.
5. Fix the specific cause, then rerun the failing path and one nearby non-regression path.

## Deliverable
- Root cause.
- Evidence that confirmed it.
- Exact fix.
- Verification steps and residual risk.
