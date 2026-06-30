---
label: Dashboard
canvas: responsive
sections: [sidebar, topbar, kpis, chart, table, empty-state]
qualityChecks: [dense-but-scannable, no-fake-live-data, responsive-table-state, clear-hierarchy]
outputContract: standalone-html-with-edit-markers
---

When to use: an operational dashboard or analytics surface.

## Required sections
- Sidebar navigation.
- Topbar with context and primary action.
- KPI row (clearly labeled as sample data).
- At least one chart placeholder (static, labeled sample).
- A data table with header, rows, and an empty state.

## Seed HTML instructions
One standalone HTML document with CSS variables and `data-disp8ch-id` markers on
the sidebar, topbar, KPI row, chart, and table.

## Quality checklist
- Dense but readable; consistent spacing and alignment.
- No invented live metrics; sample data labeled as sample.
- Table degrades gracefully at narrow widths.

## Output contract
Return only standalone HTML/CSS. Editable `data-disp8ch-id` markers required.
