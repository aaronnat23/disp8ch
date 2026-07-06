import type { ToolDefinition } from "../types";

export const DOCUMENT_TOOL_CATALOG: Record<string, ToolDefinition> = {
  documents_list: {
    name: "documents_list",
    description:
      "List uploaded, scraped, and connected data sources from the Data Sources tab. Returns id, source type, and excerpt.",
    parameters: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Maximum number of documents to return (default 10, max 50).",
        },
      },
      required: [],
    },
  },

  documents_search: {
    name: "documents_search",
    description:
      "Search extracted document content (PDF/DOCX/PPTX/scraped pages) by natural-language query.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "What to search for in the stored documents.",
        },
        limit: {
          type: "number",
          description: "Maximum number of hits to return (default 8, max 25).",
        },
      },
      required: ["query"],
    },
  },

  documents_semantic_search: {
    name: "documents_semantic_search",
    description:
      "Hybrid semantic + full-text search over indexed document chunks. Returns chunk text with document-level citations, optionally scoped to a notebook.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Question or paraphrased topic to search for in stored document chunks.",
        },
        notebookId: {
          type: "string",
          description: "Optional notebook id. Sources with context_mode=off are excluded.",
        },
        documentIds: {
          type: "array",
          description: "Optional explicit document ids to search.",
        },
        limit: {
          type: "number",
          description: "Maximum chunk hits to return (default 8, max 25).",
        },
      },
      required: ["query"],
    },
  },

  document_get: {
    name: "document_get",
    description:
      "Read one stored document by id or exact name and return extracted text plus metadata.",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Document id from documents_list/documents_search.",
        },
        name: {
          type: "string",
          description: "Exact document name fallback if id is not provided.",
        },
      },
      required: [],
    },
  },

  document_ingest: {
    name: "document_ingest",
    description:
      "Create a new data source from a website scrape so it becomes available in the Data Sources tab and document tools.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Website or docs URL to scrape.",
        },
        name: {
          type: "string",
          description: "Optional document name override.",
        },
        strategy: {
          type: "string",
          description: "Scrape strategy.",
          enum: ["auto", "static", "dynamic"],
        },
        max_pages: {
          type: "number",
          description: "Maximum pages to crawl when the URL is a docs site.",
        },
        max_depth: {
          type: "number",
          description: "Maximum crawl depth when using multi-page scraping.",
        },
      },
      required: ["url"],
    },
  },

};
