# AGENTS

## Repo Instructions

This root file is for coding agents working on the disp8ch AI repo.

Disp8ch's app profile/startup files live in `data/workspace/` by default:

- `data/workspace/SOUL.md`
- `data/workspace/USER.md`
- `data/workspace/IDENTITY.md`
- `data/workspace/TOOLS.md`
- `data/workspace/MEMORY.md`
- `data/workspace/BOOT.md`

Do not treat repo-root `MEMORY.md` or `USER.md` as app durable memory. Root startup-profile copies are archived when
they drift from `data/workspace`.

## Session Startup

1. Read the canonical files under `data/workspace/` when app profile context is needed.
2. When reading `MEMORY.md`, only treat entries as current facts if their status is active, updated, or absent.
   Skip entries marked status=replaced or status=deleted; they have been superseded.
3. Use memory search tools first when they are available.
4. Use exact file reads before quoting details.
