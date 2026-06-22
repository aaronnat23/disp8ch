---
required_env: [BLUEBUBBLES_PASSWORD]
platforms: [macos, linux, windows]
setup_notes:
  - Point the extension at a reachable BlueBubbles server before enabling delivery.
  - Set a default chat GUID only for stable internal routing or demos.
---

# BlueBubbles Ops

Use BlueBubbles when the user wants iMessage-style delivery through a BlueBubbles bridge instead of direct Apple-only tooling.

- Treat the server URL and password as operator-managed channel config.
- Keep messages compact and easy to forward back into WebChat.
- Use it for delivery and follow-up, not as the source of truth for project state.
