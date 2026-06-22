---
platforms: [linux, macos, windows]
setup_notes:
  - Source: skills.sh / vercel-labs/agent-skills web-design-guidelines. Added as an optional Disp8ch skill and disabled by default.
---

# Web Design Guidelines

Apply practical web interface standards for spacing, typography, interaction, accessibility, and responsive layout.

## Use When

- Building or reviewing web pages, dashboards, forms, navigation, documentation, or settings screens.
- A frontend task needs disciplined UI decisions rather than only visual taste.
- You need a checklist for accessibility and interaction quality.

## Playbook

1. Start with content hierarchy and task flow.
2. Define predictable spacing, alignment, and responsive constraints.
3. Ensure each interactive element has hover, focus, disabled, loading, and error states where relevant.
4. Use semantic HTML and accessible labels.
5. Keep forms scannable: labels, help text, validation, and save/cancel behavior.
6. Test at mobile, common laptop, and wide desktop widths.

## Guardrails

- Do not add decorative complexity to operational pages.
- Do not hide primary actions behind clever interactions.
- Do not enable this by default for non-frontend agents.

