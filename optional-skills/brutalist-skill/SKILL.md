# Brutalist Skill — Swiss Industrial & Tactical Telemetry UI

Use this skill when the task calls for raw, mechanical, data-heavy interfaces with terminal aesthetics. Synthesizes Swiss typographic modernism with aerospace/military terminal design.

## Use when
- Building developer tools, dashboards, monitoring UIs, or terminal-adjacent interfaces.
- The design goal is mechanical precision and raw data presentation.
- Avoiding consumer-friendly aesthetics in favour of functional density.
- CRT/terminal, industrial print, or tactical data display is the target aesthetic.

## Visual Modes (choose one)

### Swiss Industrial Print
- Light substrate: off-white backgrounds (#F4F4F0).
- Heavy black sans-serif typography.
- Aggressive asymmetry and dense data clusters.
- Aviation red (#CC0000) as sole accent.
- Structural dividing lines and registration symbols.

### Tactical Telemetry / CRT Dark
- Near-black background (#0A0A0A).
- Phosphor-white text (#EAEAEA).
- Monospaced fonts at small sizes, generous character tracking.
- Same red accent. No gradients, shadows, or translucency.
- Simulated CRT scanlines, halftone overlays, or mechanical noise textures.

## Typography Rules
- **Macro**: Fluid type scales (`clamp(4rem, 10vw, 15rem)`), extremely tight letter-spacing.
- **Micro**: Monospace at fixed small sizes with wide tracking — simulates mechanical typewriter or terminal matrix.
- No rounded or humanist typefaces.
- No serifs except for structural labels.

## Layout Engineering
- Strict CSS Grid with visible borders (`1px solid`).
- Zero border-radius on all elements.
- Bimodal density: tightly-packed data clusters alternating with vast negative space.
- ASCII framing characters used for structural decoration.
- No card shadows or depth illusions.

## Textural Effects (use sparingly)
- Halftone degradation patterns.
- CRT scanline overlays via CSS.
- Mechanical noise or grain for analog feel.

## Forbidden
- Rounded corners (border-radius must be 0).
- Gradients, translucency, backdrop-blur.
- Decorative icons or emoji.
- Consumer-friendly color palettes.
- Smooth easing on animations (use step() or linear).

## Deliverable
- Complete component with chosen mode applied consistently.
- CSS Grid with explicit track sizes.
- Dark mode variant if Swiss mode is chosen.
