import type { ToolDefinition } from "../types";

export const MEMORY_TOOL_CATALOG: Record<string, ToolDefinition> = {
  memory_search: {
    name: "memory_search",
    description:
      "Search the user's persistent memory for relevant facts, preferences, prior decisions. Each hit includes Source `path#L<start>-L<end>` so you can read surrounding context with memory_get. " +
      "When to use: user references a prior session, asks about a stored preference, or task continuity depends on something the user said before. " +
      "When NOT to use: as a substitute for tool use on the current system — memory describes the user's preferences/setup, not live state. For 'what is my current X?' verify with the appropriate tool (read_file, bash_exec) instead of trusting memory alone. " +
      "Example: `{query: 'preferred testing framework', limit: 5}`.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "What to search for",
        },
        limit: {
          type: "number",
          description: "Maximum number of results (default 5)",
        },
        min_score: {
          type: "number",
          description: "Minimum relevance score 0–1 to include (optional). Use 0.3+ to filter weak matches.",
        },
      },
      required: ["query"],
    },
  },

  memory_store: {
    name: "memory_store",
    description:
      "Store a durable fact, preference, or note in the memory scope selected by the workflow author. " +
      "The model cannot broaden that scope. Use only for information that should remain useful after this turn.",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "Concise durable information to store" },
        type: { type: "string", enum: ["fact", "preference", "note"], description: "Memory type" },
        tags: { type: "string", description: "Optional comma-separated tags" },
      },
      required: ["content"],
    },
  },

  memory_gpt: {
    name: "memory_gpt",
    description:
      "Run model-assisted memory retrieval (GPT-ranked) over the memory store. " +
      "Use when standard memory_search returns too many loosely related matches. " +
      "Results include a Source citation (path#L<start>-L<end>).",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "What to search for",
        },
        limit: {
          type: "number",
          description: "Maximum number of ranked results (default 5)",
        },
        min_score: {
          type: "number",
          description: "Minimum relevance score 0–1 (optional).",
        },
      },
      required: ["query"],
    },
  },

  session_recall: {
    name: "session_recall",
    description:
      "Search past conversation sessions when you need transcript history rather than durable memory. " +
      "Use this for questions like what was discussed before, prior troubleshooting, or earlier decisions.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "What to recall from prior sessions",
        },
        limit: {
          type: "number",
          description: "Maximum number of matching sessions to return (default 4)",
        },
      },
      required: ["query"],
    },
  },

  memory_get: {
    name: "memory_get",
    description:
      "Read a specific memory markdown file (or line window) by path after using memory_search.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Memory file path (for example: MEMORY.md, memory/2026-02-28.md, mem_abc123.md)",
        },
        from: {
          type: "number",
          description: "Start line number (1-based, optional)",
        },
        lines: {
          type: "number",
          description: "Number of lines to read (optional)",
        },
      },
      required: ["path"],
    },
  },

};
