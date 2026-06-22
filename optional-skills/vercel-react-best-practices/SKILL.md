---
platforms: [linux, macos, windows]
setup_notes:
  - Source: skills.sh / vercel-labs/agent-skills vercel-react-best-practices. Added as an optional Disp8ch skill and disabled by default.
---

# Vercel React Best Practices

Build React and Next.js code that fits modern app-router, component, data-fetching, and deployment expectations.

## Use When

- Editing React, Next.js, server components, client components, route handlers, or UI state.
- Reviewing frontend architecture, hydration issues, bundle size, streaming, caching, or server/client boundaries.
- Adding production-grade React features to an existing app.

## Playbook

1. Inspect the existing project conventions before adding patterns.
2. Keep server-only code out of client components.
3. Keep client components focused on interactivity, browser APIs, and local UI state.
4. Prefer typed props and small components with clear ownership.
5. Avoid unnecessary global state; use URL state, server data, or local state when simpler.
6. Verify with TypeScript and the narrowest relevant UI/runtime check.

## Guardrails

- Do not migrate routing, styling, or state libraries unless the user explicitly asks.
- Do not add dependencies for problems the app already solves.
- Do not enable this by default for every agent; enable it for React/Next.js implementation roles.

