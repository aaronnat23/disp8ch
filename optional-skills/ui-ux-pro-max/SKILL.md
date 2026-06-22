---
platforms: [linux, macos, windows]
setup_notes:
  - Source: skills.sh / nextlevelbuilder/ui-ux-pro-max-skill. Added as an optional Disp8ch skill and disabled by default.
---

# UI/UX Pro Max

Apply advanced UI/UX judgment to web, mobile, dashboard, SaaS, admin, and design-system work.

## Use When

- Designing new pages, dashboards, tools, landing pages, mobile flows, or Design Studio artifacts.
- Refactoring UI components, navigation, forms, tables, charts, modals, or settings screens.
- Reviewing UI for usability, accessibility, visual hierarchy, responsive behavior, or polish.
- Choosing product-appropriate layout, color, typography, density, and interaction patterns.

## Playbook

1. Identify the product type, user role, primary workflow, and repeated actions.
2. Choose a visual direction that fits the domain. Operational tools should be dense, quiet, and scannable; brand pages can be more expressive.
3. Define information hierarchy before styling: primary action, secondary action, status, evidence, and risk.
4. Design responsive behavior explicitly. Check compact desktop, mobile, and wide screens.
5. Prefer real controls over decorative elements: tabs, segmented controls, toggles, sliders, menus, tables, and icon buttons.
6. Use accessible contrast, keyboard-visible states, clear focus order, and readable hit targets.
7. Verify the UI after implementation with screenshots or browser checks when possible.

## Quality Bar

- No generic three-card marketing grids for operational apps.
- No text overflow, incoherent overlap, or layout shift from dynamic labels.
- No one-note color palette or default AI purple gradient.
- No nested cards unless the inner card is a real repeated item, modal, or framed tool.
- Stable dimensions for toolbars, boards, grids, previews, tiles, and buttons.

## Guardrails

- Work within the existing stack and design system unless the user asks otherwise.
- Do not add animation that hides state or slows repeated workflows.
- Do not enable this by default for every agent; use it for design, frontend, and product-review roles.

