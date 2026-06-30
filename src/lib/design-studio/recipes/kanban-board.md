---
label: Kanban Board
canvas: wide
sections: [toolbar, columns, card, block-badge, escalation-counter, detail-panel]
qualityChecks: [dense-but-scannable, clear-status-columns, accessible-badges, no-fake-live-data]
outputContract: standalone-html-with-edit-markers
---

When to use: a Kanban / task board mockup, especially for human-in-the-loop
blocked tasks with typed reasons and escalation.

## Required sections
- Toolbar with board name and a filter row (include a "Needs human" filter).
- Status columns (Inbox, In Progress, Review, Blocked, Done).
- Cards with title, priority, and assignee.
- Typed block badge on blocked cards (dependency, needs input, capability, transient).
- Recurrence / escalation counter on repeated blocks.
- A detail panel showing block reason and recovery actions.

## Seed HTML instructions
One standalone HTML document. Use a CSS grid for columns and `data-disp8ch-id`
markers on the toolbar, each column, and the card template.

## Quality checklist
- Columns are visually distinct and scannable.
- Block badges use color plus text (not color alone).
- Sample data is clearly illustrative, not presented as live metrics.

## Output contract
Return only standalone HTML/CSS. Editable `data-disp8ch-id` markers required.
