# Contributing

Thanks for helping improve disp8ch.

## Development

Use Node.js 22.13+ and pnpm 10.30.2.

```bash
corepack enable
pnpm install
pnpm dev
```

For benchmark-quality local app checks on this repo, run Node, pnpm, app servers, and harnesses from Windows-native `cmd.exe` or PowerShell when working from a Windows checkout.

## Before Opening A PR

Run:

```bash
pnpm exec tsc --noEmit
```

Also run focused regression scripts for the area you changed.

Do not commit:

- API keys or `.env` files
- `data/` runtime databases
- local memories, logs, or chat history
- screenshots containing private data

## Coding Guidelines

- Keep changes scoped.
- Prefer existing app patterns.
- Preserve confirmation gates for side effects.
- Do not add benchmark-specific production branches.
- Document user-visible behavior changes in README or relevant docs.
