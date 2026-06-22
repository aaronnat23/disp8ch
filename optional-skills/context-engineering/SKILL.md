---
platforms: [linux, macos, windows]
setup_notes:
  - Sources: skills.sh context-engineering-collection and filesystem-context skills. Added as an optional Disp8ch skill and disabled by default.
---

# Context Engineering

Design agent context so the model receives the right information at the right time without stuffing every instruction, file, and tool result into the prompt.

## Use When

- Building or debugging agentic runtimes, memory systems, tool loops, retrieval, compaction, or multi-agent workflows.
- A model forgets changed files, loses goals after compaction, overuses stale memory, or drowns in tool output.
- Designing skills, prompt indexes, evidence dossiers, scratch files, or session summaries.

## Playbook

1. Separate static context from dynamic context. Static context should contain stable rules and compact catalogs; dynamic context should be retrieved on demand.
2. Put critical instructions, current task, decisions, and final constraints near the beginning or end of context.
3. Store large tool outputs, logs, research notes, and intermediate plans as files or structured records, then cite or retrieve them selectively.
4. Prefer skill names and descriptions in static context; load full skill bodies only when relevant.
5. Preserve task state during compaction: objective, changed files, commands run, failures, open questions, and next action.
6. Track context failure modes: missing context, too much irrelevant context, stale context, poisoned context, and lost-in-the-middle.
7. Evaluate context changes by task success and total tokens per completed task, not by prompt size alone.

## Patterns

- Filesystem scratchpad for large evidence and work logs.
- Evidence dossier for tool results and source maps.
- Skill catalog plus lazy skill loading.
- Anchored summaries with stable sections for goal, decisions, changed files, tests, blockers, and next steps.
- Multi-agent handoff packets that include only role-relevant context.

## Guardrails

- Do not hide important safety constraints during compression.
- Do not save transient failures as durable context.
- Do not enable this by default for all agents; use it for agent-runtime, architecture, memory, and long-horizon work.

