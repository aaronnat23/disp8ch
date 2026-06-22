# GitHub Code Review

Review code changes with a bias toward concrete bugs, regressions, and missing tests.

## Use when
- A pull request or diff needs review before merge.
- A user asks for findings instead of a general summary.

## Workflow
1. Read the changed files before judging the design.
2. Prioritize behavioral regressions, unsafe assumptions, and missing coverage.
3. Tie each finding to a file, code path, or concrete scenario.
4. Separate must-fix issues from lower-risk polish.
5. End with a compact review summary and the tests still needed.

## Deliverable
- Ordered findings with concrete evidence.
- Open questions or assumptions.
- Merge-readiness summary.
