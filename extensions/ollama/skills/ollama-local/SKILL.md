---
platforms: [linux, macos, windows]
setup_notes:
  - Run a local Ollama server before expecting model discovery.
  - Use baseUrl if Ollama is not on the default localhost port.
---

# Ollama Local

Use Ollama when the user wants self-hosted local models, local network inference, or offline-friendly provider setup.

- Discover available models before suggesting a specific local model.
- Prefer smaller reasoning-safe models for quick UI validation flows.
- Mention context-window differences when comparing local models.
