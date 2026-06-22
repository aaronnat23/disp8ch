# Taste Skill — Premium Frontend Design System

Use this skill when the task involves building or improving any web UI, frontend component, dashboard, or landing page. Enforces high-end design standards and eliminates generic AI-generated interface patterns.

## Use when
- Building React/Next.js components, pages, or full interfaces.
- The output requires a visually distinctive, non-generic UI.
- Preventing "AI tells" — neon glows, Inter font, symmetrical card grids, broken image placeholders.
- Creating dashboards, landing pages, SaaS UIs, or portfolio sites.

## Core Parameters
- **DESIGN_VARIANCE: 8** — Asymmetric layouts over perfect symmetry; masonry-oriented grids.
- **MOTION_INTENSITY: 6** — Fluid CSS transitions and spring physics (stiffness: 100, damping: 20).
- **VISUAL_DENSITY: 4** — Balanced breathing room; not overcrowded, not sparse.

## Mandatory Rules

**Typography:**
- Use Geist, Outfit, or Cabinet Grotesk. Never use Inter.
- No serif fonts on dashboards.
- Limit to 1 accent color; ban "AI purple" and neon palettes.
- No pure black (#000000); use Off-Black or Zinc-950.

**Layout:**
- Force asymmetric layouts when VARIANCE > 4.
- Eliminate generic 3-column card grids on dense dashboards.
- Use `min-h-[100dvh]` instead of `h-screen` for mobile stability.
- No centered hero layouts for high-variance projects.

**Interactions:**
- Implement full state cycles: loading, empty, error, success.
- Animate only via `transform` and `opacity` — never `top`, `left`, `width`, `height`.
- Isolate perpetual animations in dedicated Client Components.
- Bento 2.0: perpetual micro-interactions with Framer Motion spring physics (Pulse, Typewriter, Carousel loops).

**Forbidden AI Tells:**
- No neon glows, oversaturated colors, or gradient abuse.
- No generic names ("John Doe"), broken image links, or filler copy ("Seamless," "Unleash," "Next-Gen").
- No clichéd icon choices or stock visual metaphors.

## Tech Stack Defaults
- React / Next.js with TypeScript.
- Tailwind CSS (check package.json before importing libraries).
- Phosphor or Radix icons only.
- Framer Motion for spring animations.

## Deliverable
- Complete, production-ready component code (no placeholders, no TODOs).
- Full state handling included.
- Mobile-responsive with CSS Grid fallbacks.
