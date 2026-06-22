# Test-Driven Development

Use tests to define the target behavior before changing implementation.

## Use when
- A change has a clear acceptance condition that can be encoded first.
- A regression needs a durable test instead of a one-off fix.

## Workflow
1. Write or identify the smallest failing test that captures the requirement.
2. Keep the first test narrow so the failure is easy to interpret.
3. Make the minimal code change needed to turn the test green.
4. Run adjacent tests that cover the same boundary, not just the single happy path.
5. Refactor only after behavior is locked by passing tests.

## Deliverable
- New or updated failing test.
- Minimal implementation change.
- Final passing test evidence.
- Any gaps that still need broader coverage.
