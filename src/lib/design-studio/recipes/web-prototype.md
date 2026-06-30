---
label: Web Prototype
canvas: responsive
sections: [nav, hero, content, interaction, footer]
qualityChecks: [responsive, clear-hierarchy, real-interaction-states, no-fake-claims]
outputContract: standalone-html-with-edit-markers
---

When to use: a general interactive web page or prototype that is not a marketing
landing page or an operational dashboard.

## Required sections
- Navigation with a clear primary action.
- A focused hero or header that states the purpose.
- A main content area with realistic, non-placeholder structure.
- At least one interaction (form, toggle, tabs) with visible states.
- A footer with secondary links.

## Seed HTML instructions
Produce one standalone HTML document with a `<style>` block using CSS variables.
Put stable `data-disp8ch-id` attributes on each major section so later edits can
target them precisely.

## Quality checklist
- Works at mobile and desktop widths.
- No invented metrics, logos, or customer names.
- Interactive elements have hover/focus/disabled states.

## Output contract
Return only standalone HTML/CSS (optionally minimal JS). No external build step,
no framework runtime. Editable markers required.
