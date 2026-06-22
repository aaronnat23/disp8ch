# Codebase Inspection

Inspect a codebase quickly enough to answer concrete questions without drifting into a full audit.

## Use when
- A user asks where something lives, how a path works, or what code is responsible for behavior.
- You need fast architectural context before making a change.

## Workflow
1. Start with the narrowest file or symbol search that can answer the question.
2. Prefer code paths actually reached in runtime over nearby dead code.
3. Summarize findings in terms of behavior, not just filenames.
4. Call out uncertainty when the evidence is indirect.
