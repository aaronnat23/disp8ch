import type { ToolDefinition } from "../types";

export const FILE_TOOL_CATALOG: Record<string, ToolDefinition> = {
  read_file: {
    name: "read_file",
    description:
      "Read a file from the filesystem and return its contents with line numbers (cat -n style). " +
      "When to use: before claiming behavior about a file (cite path:line-range from the read result); to verify dependency declarations (package.json, requirements.txt); to inspect config (.env, yaml). " +
      "When NOT to use: keyword search across many files (use search_files); listing a directory (use list_files). " +
      "Prefer relative paths from the workspace root. Example: `{path: 'src/lib/foo.ts'}` → cite as `src/lib/foo.ts:12-34`.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute or relative path to the file",
        },
      },
      required: ["path"],
    },
  },

  write_file: {
    name: "write_file",
    description:
      "Write content to a file. Creates the file and any missing parent directories. " +
      "Use mode 'append' to add to an existing file without overwriting it. " +
      "Use mode 'patch' to do a targeted search-and-replace edit: provide 'search' (the block to find) " +
      "and 'replace' (the replacement block). Fuzzy matching handles minor whitespace/indentation drift.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to write to",
        },
        content: {
          type: "string",
          description: "Content to write (used for overwrite/append modes, ignored in patch mode)",
        },
        mode: {
          type: "string",
          description: "Write mode: 'overwrite' (default) replaces the file, 'append' adds to it, 'patch' does targeted search-and-replace",
          enum: ["overwrite", "append", "patch"],
        },
        search: {
          type: "string",
          description: "(patch mode only) The exact block of text to find in the existing file. Include surrounding context lines for better matching.",
        },
        replace: {
          type: "string",
          description: "(patch mode only) The replacement text to substitute for the search block.",
        },
      },
      required: ["path"],
    },
  },

  edit_file: {
    name: "edit_file",
    description:
      "Surgically edit a file using search/replace patterns. Creates a checkpoint before applying. " +
      "Safer than write_file for targeted changes. Uses fuzzy matching to find the right location " +
      "even when line numbers or whitespace drift.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative or absolute path to the file to edit",
        },
        search: {
          type: "string",
          description: "Text to find (exact match or fuzzy). Include surrounding context lines for better matching.",
        },
        replace: {
          type: "string",
          description: "Replacement text to substitute for the search block",
        },
      },
      required: ["path", "search", "replace"],
    },
  },

  code_review: {
    name: "code_review",
    description:
      "Review current workspace changes or a supplied diff. Read-only advisory review with exact findings, " +
      "severity, and suggested fixes. Does not edit files.",
    parameters: {
      type: "object",
      properties: {
        diff: {
          type: "string",
          description: "Optional diff text to review. If omitted, the tool reviews the current git diff when available.",
        },
        scope: {
          type: "string",
          description: "Optional review scope such as 'uncommitted', a file path, or a short task description.",
        },
      },
      required: [],
    },
  },

  list_files: {
    name: "list_files",
    description: "List files and directories at a given path. Returns names, sizes, and types.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Directory path to list. Defaults to current working directory.",
        },
        recursive: {
          type: "string",
          description: "Set to 'true' to list files recursively (max 2 levels deep)",
          enum: ["true", "false"],
        },
      },
      required: [],
    },
  },

  find_files: {
    name: "find_files",
    description: "Find files by name pattern or extension within a directory.",
    parameters: {
      type: "object",
      properties: {
        directory: {
          type: "string",
          description: "Directory to search in. Defaults to current working directory.",
        },
        pattern: {
          type: "string",
          description: "Filename pattern to match (e.g. '*.ts', '*.log', 'config.*')",
        },
        max_results: {
          type: "number",
          description: "Maximum number of results to return (default 50)",
        },
      },
      required: ["pattern"],
    },
  },

  search_files: {
    name: "search_files",
    description:
      "Grep-style content search across the workspace. Returns `path:line: match` for every hit. " +
      "When to use: locate function definitions, callers, imports, config keys, or any token across many files; pair with read_file to confirm behavior. " +
      "When NOT to use: when you already know the file (use read_file); for fuzzy/semantic search (this is literal regex). " +
      "Search results are CANDIDATES for behavior claims — you still need read_file on the file before stating what it does. Example: `{pattern: 'classifyResearchTaskSpec', path: 'src/'}`.",
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Regex pattern to search for",
        },
        path: {
          type: "string",
          description: "Directory or file to search in. Defaults to workspace root.",
        },
        maxResults: {
          type: "number",
          description: "Maximum results to return (default 20, max 50)",
        },
      },
      required: ["pattern"],
    },
  },

};
