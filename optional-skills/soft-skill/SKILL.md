# Soft Skill — Premium Whitespace & Cinematic Motion Design

Use this skill when the task calls for an agency-tier, editorial, or luxury aesthetic. Produces premium interfaces with micro-interactions, spatial rhythm, and cinematic motion.

## Use when
- Building high-end SaaS UIs, portfolio sites, or lifestyle brand pages.
- The design goal is Awwwards-quality output ($150k+ agency standard).
- Avoiding Bootstrap-style symmetrical grids and generic component libraries.
- Any design requiring spring physics, scroll-triggered reveals, or custom easing.

## Design Archetypes (choose one)
- **Ethereal Glass** — Backdrop blur, translucent surfaces, tech-forward aesthetic.
- **Editorial Luxury** — Large typography, editorial split layouts, lifestyle/fashion feel.
- **Soft Structuralism** — Clean geometry, warm palette, health/portfolio positioning.

## Layout Patterns
- **Asymmetrical Bento grids** — Unequal cells, masonry-style density.
- **Z-Axis card stacking** — Depth hierarchy through overlapping layers.
- **Editorial Split Typography** — Text blocks spanning unusual grid columns.
- **Double-Bezel architecture** — Nested container structures mimicking physical hardware.
- Mobile: collapses to single-column with full-width components.

## Typography Rules
- Never use Inter, Roboto, or Open Sans.
- No standard icon libraries (Lucide, Feather, Heroicons).
- SF Pro Display, Geist Sans, or Helvetica Neue for UI.
- Generous tracking and leading; body text in charcoal, not pure black.

## Motion Rules
- Only cubic-bezier transitions — never linear easing.
- Scroll-triggered reveals: fade + translate over 400–800ms.
- Animate only `transform` and `opacity` for performance.
- `backdrop-blur` restricted to fixed/sticky elements only.
- Hardware-accelerated transforms mandatory.

## Forbidden Patterns
- Generic borders/shadows.
- Symmetrical Bootstrap grids.
- Basic CSS transitions.
- Standard icon sets.
- Generic font choices.

## Deliverable
- Complete, production-ready UI code with all interaction states.
- Custom motion curves included.
- Full mobile responsiveness with graceful degradation.
