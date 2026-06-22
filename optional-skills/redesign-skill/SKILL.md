# Redesign Skill — Design Audit & Upgrade Framework

Use this skill when the task involves improving an existing website or application's visual quality. Works within the existing tech stack rather than rewriting from scratch.

## Use when
- A user shares existing code or a screenshot and asks for a design upgrade.
- The goal is to elevate visual quality without migrating frameworks.
- Auditing a project for generic AI design patterns and replacing them.
- Producing a design review with prioritized upgrade recommendations.

## Core Principle
Work with the existing tech stack. Do not migrate frameworks, styling libraries, or component systems. Preserve all functionality while elevating visual quality.

## Step 1 — Scan & Diagnose
Identify before making changes:
- Current framework (React, Vue, Svelte, plain HTML).
- Styling method (Tailwind, CSS modules, styled-components, inline).
- Existing design patterns and component library in use.
- Tech stack constraints (what can and cannot be changed).

## Step 2 — Design Audit

Run through each category:

**Typography**: Font choices (Inter? generic?), hierarchy gaps, spacing issues.
**Color & Surfaces**: AI purple/blue gradients, oversaturated palette, pure black overuse.
**Layout**: Centered symmetry, equal-column card grids, missing asymmetry.
**Interactivity**: Missing hover states, no transition animations, no loading states.
**Content Quality**: Generic placeholder names, clichéd copy ("Seamless," "Next-Gen").
**Components**: Card overuse in dashboards, modal bloat, generic carousels.
**Iconography**: Default Heroicons/Lucide with no personality, cliché metaphors.
**Code Quality**: Hardcoded color values, non-semantic HTML, missing ARIA labels.

## Step 3 — Strategic Gap Check
Identify commonly forgotten elements:
- 404 and error pages.
- Empty states for lists and data tables.
- Form validation feedback and error messages.
- Mobile breakpoints for all components.
- Accessibility: focus rings, alt text, color contrast.
- Legal links (privacy policy, terms).

## Step 4 — Prioritized Upgrades

Apply in this order (lowest risk → highest impact first):
1. **Font swap**: Replace Inter/Roboto with Geist, Outfit, or Cabinet Grotesk.
2. **Color refinement**: Replace pure black and AI purple with off-black and a single desaturated accent.
3. **Spacing correction**: Add consistent vertical rhythm and generous padding.
4. **Component upgrade**: Replace generic cards with asymmetric grid or varied bento layout.
5. **Motion layer**: Add scroll-triggered fade + translate animations (transform + opacity only).
6. **Typography polish**: Add editorial serif for headlines, tighten tracking, adjust line-height.

## High-Impact Upgrade Techniques
- Variable font weight animations on hover.
- Broken/asymmetric grid for hero sections.
- Glassmorphism (sparingly, only for overlay surfaces).
- Refined surface treatments: subtle texture, grain, or noise overlay.

## Deliverable
- Full design audit report with specific findings per category.
- Prioritized list of changes with code diffs or replacement snippets.
- Upgraded component code that works within the existing stack.
