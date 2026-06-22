---
platforms: [linux, macos, windows]
setup_notes:
  - Source: skills.sh / anthropics/skills frontend-design. Added as an optional Disp8ch skill and disabled by default.
---

# Frontend Design

Create distinctive, production-grade frontend interfaces that avoid generic AI design patterns.

## Use When

- Building a new frontend page, component, dashboard, tool, or artifact.
- Improving an existing UI that feels generic, unclear, or visually weak.
- The user asks for strong taste, product-grade polish, or a design that stands out.

## Playbook

1. Understand the audience, task frequency, product category, and emotional tone.
2. Pick a clear design direction before coding.
3. Use the existing app's component system and conventions unless asked to create a new system.
4. Prioritize typography, spacing, hierarchy, real content, and interaction states.
5. Use visual assets when the surface is a website, game, venue, product, or object-focused page.
6. Verify on desktop and mobile. Check text fit, overlap, scroll, loading, and empty states.

## Anti-Patterns

- Default Inter/Roboto plus purple gradient hero.
- Symmetric three-card layouts for every section.
- Decorative orbs, stock-like blurred backgrounds, fake app screenshots, or placeholder copy.
- Hero pages when the user asked for an actual app/tool.

## Guardrails

- Do not override Disp8ch's frontend design rules or existing app conventions.
- Do not enable this by default for every agent; enable for frontend/design roles.

