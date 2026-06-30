---
label: Mobile App
canvas: portrait
sections: [status-bar, header, content, list, tab-bar]
qualityChecks: [thumb-reachable, mobile-first, clear-hierarchy, no-fake-claims]
outputContract: standalone-html-with-edit-markers
---

When to use: a mobile app screen or flow mockup.

## Required sections
- Simulated status bar.
- Screen header with title and optional back action.
- Main content area.
- A scrollable list or card stack.
- A bottom tab bar with primary destinations.

## Seed HTML instructions
One standalone HTML document constrained to a phone-width frame, CSS variables,
and `data-disp8ch-id` markers on the header, content, list, and tab bar.

## Quality checklist
- Primary actions are within thumb reach.
- Tap targets are large enough; text is legible.
- No invented metrics or brand assets.

## Output contract
Return only standalone HTML/CSS. Editable `data-disp8ch-id` markers required.
