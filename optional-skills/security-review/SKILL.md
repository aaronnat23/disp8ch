---
platforms: [linux, macos, windows]
setup_notes:
  - Confirm the target environment, auth boundary, and any sensitive data paths before running the review.
  - Pair this skill with hierarchy or board context when the review is tied to a release decision.
---

# Security Review

Review flows, code paths, and configuration with a bias toward real exploit paths and practical mitigations.

## Use when
- Auditing APIs, auth flows, secrets handling, or external integrations.
- A change introduces trust boundaries or sensitive data handling.

## Workflow
1. Map trust boundaries, secrets, and externally reachable surfaces.
2. Look for auth gaps, injection risks, unsafe defaults, and privilege escalation paths.
3. Prioritize findings by exploitability and impact, not by quantity.
4. Recommend the narrowest effective mitigation first.
5. Note residual risk and missing verification coverage.

## Deliverable
- Findings ordered by severity.
- Evidence.
- Mitigation recommendation.
- Residual risk or testing gap.
