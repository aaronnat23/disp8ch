---
platforms: [linux, macos, windows]
setup_notes:
  - Source: skills.sh / vercel-labs/skills find-skills. Added as an optional Disp8ch skill and disabled by default.
---

# Find Skills

Discover useful optional skills without bloating the default agent prompt.

## Use When

- The user asks whether a skill exists for a task.
- A specialist agent needs a reusable workflow, but no installed skill clearly fits.
- You need to compare candidate skills before recommending installation.

## Playbook

1. Start from the user's task, not from a broad skill shopping list.
2. Search installed Disp8ch skills first.
3. If needed, search public skill directories such as skills.sh and prefer reputable sources, high install count, clear `SKILL.md`, and active repositories.
4. Recommend a small shortlist with source, purpose, risks, and whether it should be enabled by default.
5. Default recommendation should be disabled until a user or agent role needs it.

## Guardrails

- Do not install skills automatically without user confirmation.
- Do not recommend broad always-on skill bundles.
- Do not install skills that require unknown external tools, credentials, or risky scripts without review.

