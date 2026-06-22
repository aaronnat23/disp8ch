# Migration Planner

Plan risky system moves in controlled phases with rollback and validation checkpoints.

## Use when
- Moving providers, schemas, storage paths, or deployment workflows.
- A change needs staged rollout and safe fallback.

## Workflow
1. Define the current state, target state, and non-negotiable constraints.
2. Break the migration into reversible phases.
3. List data risks, compatibility gaps, and user-facing blast radius.
4. Add validation checks for each phase and a rollback trigger.
5. Call out what must be tested before, during, and after cutover.

## Deliverable
- Phase plan, risks, rollback steps, and validation checklist.
