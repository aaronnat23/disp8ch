# GPT Taste Skill — Award-Winning Motion-First UI Engineering

Use this skill for premium frontend interfaces that require GSAP scroll animations, mathematically verified bento grids, and award-quality design. The most demanding taste variant.

## Use when
- The output needs to qualify for Awwwards, CSS Design Awards, or similar recognition.
- GSAP ScrollTrigger animations are required or expected.
- Building complex bento grids with mathematically verified column/row interlocking.
- Typography and layout must break standard LLM bias patterns at a measurable level.

## Pre-Flight Verification (run before coding)
1. Simulate component arsenal selection from: hero types, bento variants, scroll paradigms.
2. Choose typography stack from: Satoshi, Cabinet Grotesk, Outfit, or Geist — **never Inter**.
3. Choose GSAP paradigm: pin-scrub, text-reveal, card-stack, image-scale, or parallax.
4. Verify grid interlocking with `grid-flow-dense` — no empty cells allowed.

## Typography & Layout Mandates
- Headers: 2–3 line maximum using ultra-wide containers (`max-w-6xl` or wider).
- **6+ wrapped heading lines = failure state** — widen container before reducing font size.
- No meta-labels like "SECTION 01" or "QUESTION 05" — cheap and unprofessional.
- No emojis in code or UI copy.

## Grid Construction Rules
- All bento grids must use `grid-flow-dense`.
- Column/row span combinations must be mathematically verified to interlock without gaps.
- Allowed patterns: 2×1, 1×2, 2×2 spans mixed with 1×1 to fill efficiently.
- Test every grid permutation for empty cell scenarios before finalizing.

## GSAP ScrollTrigger Requirements
- **Pinning**: Hero sections pin during scroll while content reveals.
- **Scrub text reveals**: Characters or words reveal as viewport scrolls.
- **Image scaling**: `scale()` transitions triggered by scroll position.
- **Card stacking**: Cards layer on top of each other as user scrolls down.
- Scrub value: 0.5–2 for smooth progression.

## AIDA Page Structure (mandatory for full pages)
1. **Navigation** — Sticky, minimal, expands on scroll.
2. **Attention / Hero** — Pinned with GSAP, large asymmetric typography.
3. **Interest / Bento** — Dense `grid-flow-dense` grid with micro-interactions.
4. **Desire / GSAP Scroll** — Parallax, card stacks, scroll-triggered reveals.
5. **Action / Footer** — Huge vertical padding, editorial typography, CTA.

Between each section: "huge vertical padding" (min 120px).

## Motion Rules
- All animations via GSAP (not Framer Motion for this variant).
- Hardware-accelerated: only `transform` and `opacity`.
- Easing: `power2.out`, `expo.out`, or custom cubic-bezier — never linear.
- No auto-playing loops unless explicitly requested.

## Forbidden
- Inter font.
- Meta-section labels ("SECTION 01", "STEP 02").
- Emojis in UI or code.
- Empty cells in bento grids.
- 6+ line wrapped headings.
- Standard Lucide/Heroicons without customization.

## Deliverable
- Complete GSAP ScrollTrigger implementation.
- Mathematically verified bento grid layout.
- Full AIDA page structure for landing pages.
- All required GSAP imports verified against package.json.
