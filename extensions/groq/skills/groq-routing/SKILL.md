---
required_env: [GROQ_API_KEY]
platforms: [macos, linux, windows]
setup_notes:
  - Set the Groq API key before enabling Groq-specific routing guidance.
  - Choose a default model if the agent should prefer a low-latency path.
---

# Groq Routing

Use Groq when the user wants very low latency inference and the available model family is a good fit for the task.

- Favor Groq for fast iteration loops, short-turn chat, and latency-sensitive agent work.
- Make the model family explicit because Groq capability varies by hosted model.
- Surface any tradeoff between speed, context, and tool behavior before switching.
