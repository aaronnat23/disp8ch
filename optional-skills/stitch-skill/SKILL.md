# Stitch Skill — Google Stitch Semantic Design System

Use this skill when generating DESIGN.md files for Google Stitch, or when creating agent-friendly design specifications that will drive multi-step UI generation. Translates premium design principles into semantic design language.

## Use when
- The task involves creating a DESIGN.md or design specification for AI-driven UI generation.
- Using Google Stitch or similar prompt-driven design tools.
- Needing a shareable design system document that agents can interpret unambiguously.
- Standardizing design decisions across a project before coding begins.

## DESIGN.md Structure

Generate a `DESIGN.md` file containing these sections:

### Atmosphere Calibration
Specify on 1–10 scales:
- **Density**: Airy (1) → Dense (10). Default: 4.
- **Variance**: Symmetric (1) → Chaotic (10). Default: 8.
- **Motion**: Static (1) → Cinematic (10). Default: 6.

### Color System
- Base: Zinc or Slate neutral.
- Maximum one accent color, saturation below 80%.
- Explicitly ban AI purple/neon.
- No pure black — specify Off-Black or Zinc-950.
- List exact hex values for all palette entries.

### Typography Rules
- Specify exact font family for: display/hero, body, UI labels, monospace.
- Forbidden: Inter (always prohibited for premium contexts).
- Recommended: Geist, Outfit, Cabinet Grotesk, or Fraunces for editorial.
- Serif fonts: only in editorial contexts (Fraunces, Editorial New).
- Dashboards: sans-serif only.

### Layout Directives
- Specify grid system (columns, gutter width, max-width).
- State variance level and resulting layout pattern (symmetric/asymmetric/bento).
- Centered hero: only permitted for variance ≤ 4.
- High variance: asymmetric split layouts required.
- No absolute-positioned element stacks — every element in its own grid zone.

### Component Defaults
- Button shapes (border-radius), sizes, and hover behaviors.
- Card padding, border-radius, and shadow policy.
- Form field styling and focus state.
- Icon library and sizing convention.

### Motion Specification
- Easing: Spring physics (stiffness: 100, damping: 20) or cubic-bezier value.
- Allowed properties: transform and opacity only.
- Scroll animation: fade + translate or none.
- Duration range: 300–800ms.

### Anti-Pattern Blocklist
List explicitly:
- Emojis in UI (banned).
- Generic placeholder names ("John Doe", "user@example.com").
- Filler copy ("Scroll to explore", "Get started today").
- Neon glows, oversaturated accents.
- Common AI design tells to avoid.

## Deliverable
- A complete `DESIGN.md` file ready for Stitch or agent consumption.
- All values explicitly specified — no ranges or "choose one of" ambiguity.
- The document serves as the single source of truth for the project's visual language.
