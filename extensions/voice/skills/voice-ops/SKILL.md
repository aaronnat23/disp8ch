---
required_env: [OPENAI_API_KEY]
platforms: [linux, macos, windows]
setup_notes:
  - Configure an active OpenAI model before using STT or TTS routes.
  - Use voice mode for short operator interactions, not large document dumps.
---

# Voice Ops

Use voice features when an operator needs speech input, spoken output, or hands-busy interaction from WebChat.

- Keep spoken responses shorter than typical text responses.
- Fall back to text if the active OpenAI voice model is missing or quota-limited.
- Confirm the target language when transcribing mixed-language audio.
