---
platforms: [linux, macos, windows]
setup_notes:
  - Source: skills.sh / hardikpandya/stop-slop. Added as an optional Disp8ch skill and disabled by default.
---

# Stop Slop

Remove generic AI writing patterns from prose while preserving the user's actual meaning and voice.

## Use When

- Drafting, editing, or reviewing prose, docs, blog posts, release notes, marketing copy, or executive summaries.
- The user asks for writing to sound less generic, less AI-written, more direct, or more human.
- A final answer has filler, throat-clearing, formulaic contrast, vague praise, or over-polished phrasing.

## Playbook

1. Cut filler phrases, throat-clearing, vague setup, and padded transitions.
2. Prefer active voice with a real actor doing the action.
3. Replace abstract claims with named components, concrete behavior, numbers, or examples.
4. Vary sentence length and paragraph endings.
5. Remove pull-quote style one-liners unless the user explicitly wants a punchy style.
6. Preserve technical precision. Do not simplify away caveats, file names, commands, or evidence.
7. Use direct wording instead of explaining that you are about to explain something.

## Checks

- Is any sentence announcing the answer instead of giving it?
- Is any claim vague enough that it could fit any product or team?
- Are there repeated three-item lists, binary contrasts, or dramatic fragments?
- Can a reader tell which person, system, file, or process did the action?
- Can a paragraph be shorter without losing meaning?

## Guardrails

- Do not remove legally or technically necessary caveats.
- Do not force casual voice into formal documents.
- Do not rewrite user-provided quotes unless asked.
- Do not use this as a default for every answer; enable it for writing-heavy agents or content review work.

