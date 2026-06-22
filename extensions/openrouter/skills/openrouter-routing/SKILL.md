---
required_env: [OPENROUTER_API_KEY]
platforms: [macos, linux, windows]
setup_notes:
  - Set the OpenRouter API key before enabling provider-specific routing guidance.
  - Configure a default model if the agent should prefer one family consistently.
---

# OpenRouter Routing

Use OpenRouter when the user wants a single provider gateway that can switch between model families while keeping one credential path.

- Prefer it for provider consolidation, fallback planning, and model comparison workflows.
- Keep the chosen default model explicit so behavior is predictable.
- Call out when a task would be better served by a direct provider instead of a shared gateway.
