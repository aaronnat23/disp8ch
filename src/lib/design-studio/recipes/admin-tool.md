---
label: Admin Tool
canvas: responsive
sections: [nav, filters, table, detail-panel, bulk-actions]
qualityChecks: [predictable-controls, keyboard-scannable, no-marketing-hero, consistent-spacing]
outputContract: standalone-html-with-edit-markers
---

When to use: an internal admin / CRUD tool with restrained, work-focused UI.

## Required sections
- Navigation (no marketing hero).
- A filter row.
- A primary data table with selectable rows.
- A detail / edit panel.
- Bulk actions for selected rows.

## Seed HTML instructions
One standalone HTML document with CSS variables and `data-disp8ch-id` markers on
the nav, filter row, table, detail panel, and bulk-action bar.

## Quality checklist
- Controls are predictable and consistently placed.
- Dense but readable information; no decorative hero.
- Interactive controls have visible states.

## Output contract
Return only standalone HTML/CSS. Editable `data-disp8ch-id` markers required.
