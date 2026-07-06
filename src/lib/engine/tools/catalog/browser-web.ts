import type { ToolDefinition } from "../types";

export const BROWSER_WEB_TOOL_CATALOG: Record<string, ToolDefinition> = {
  fetch_url: {
    name: "fetch_url",
    description:
      "Fetch the content of a URL as text. Use for reading web pages, APIs returning text/JSON, or downloading files. " +
      "When the URL returns HTML, the response is converted to readable plain text. " +
      "Use this for simple URL reads; use http_request when you need custom headers, POST/PUT, or raw response handling.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The URL to fetch (must be a public http/https URL)",
        },
        max_chars: {
          type: "number",
          description: "Maximum characters to return. Defaults to 5000.",
        },
      },
      required: ["url"],
    },
  },

  http_request: {
    name: "http_request",
    description: "Make an HTTP request to any public URL and return the response body.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The URL to request (must be a public internet URL)",
        },
        method: {
          type: "string",
          description: "HTTP method. Defaults to GET.",
          enum: ["GET", "POST", "PUT", "DELETE", "PATCH"],
        },
        body: {
          type: "string",
          description: "Request body string (for POST/PUT/PATCH)",
        },
        headers: {
          type: "string",
          description: 'JSON object of headers, e.g. {"Authorization":"Bearer ..."}',
        },
      },
      required: ["url"],
    },
  },

  web_search: {
    name: "web_search",
    description:
      "Search the web and return a list of result URLs + snippets. " +
      "When to use: discovery — finding which URLs exist on a topic before fetching them; current/changing facts (versions, news, prices). " +
      "When NOT to use: as a source citation by itself — snippets are NOT evidence. Always follow up with web_extract or fetch_url on the actual URLs before quoting any claim. " +
      "Uses configured provider (DuckDuckGo / Tavily / Exa / Brave). Example: `{query: 'named product quickstart docs', maxResults: 6}`.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query",
        },
        max_results: {
          type: "number",
          description: "Maximum number of results to return (default 5, max 10)",
        },
      },
      required: ["query"],
    },
  },

  tool_docs_search: {
    name: "tool_docs_search",
    description:
      "Search the separate tool-knowledge index for built-in and custom tool usage guidance. " +
      "Use this to discover which tool fits a task or to understand how a tool works. " +
      "This searches tool documentation only, not user memory.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "What you need to do or the tool you want help with",
        },
        limit: {
          type: "number",
          description: "Maximum number of matching tools to return (default 5, max 8)",
        },
      },
      required: ["query"],
    },
  },

  recommend_local_models: {
    name: "recommend_local_models",
    description:
      "Detect this machine's hardware (RAM, CPU, GPU, VRAM) and recommend which local LLM models it can run, " +
      "with fit (full GPU / partial offload / CPU only), estimated speed, reasons, warnings, and ready-to-run " +
      "Ollama and llama.cpp commands. Read-only; installs nothing. Use when a user asks what local model they can run.",
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          enum: ["coding", "chat", "reasoning", "vision", "general"],
          description: "What the user wants the model for (default general).",
        },
        context_tokens: {
          type: "number",
          description: "Desired context window in tokens (default 8192).",
        },
      },
      required: [],
    },
  },

  youtube_transcript: {
    name: "youtube_transcript",
    description:
      "Fetch the transcript/captions for a YouTube video URL. Returns timestamps, language, title, and full transcript text. " +
      "When to use: the user provides a YouTube URL and asks for a summary, analysis, or transcript extraction. " +
      "When NOT to use: when the user wants to download a video (not supported); when transcript exists elsewhere in conversation context. " +
      "The tool is read-only and fetches only publicly available captions data. " +
      "Example: `{url: 'https://www.youtube.com/watch?v=abc123'}`.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Full YouTube video URL (youtube.com/watch?v=... or youtu.be/...)",
        },
      },
      required: ["url"],
    },
  },

  browser_action: {
    name: "browser_action",
    description:
      "Control a headless browser. Actions: navigate (go to URL), click/type/get_text (CSS selector), " +
      "snapshot (list interactive elements as @e1,@e2,...; full=true includes page text/links), get_links/get_images, click_ref/fill_ref/scrollintoview (interact by ref), " +
      "press/back/wait/status for session control, screenshot, vision, cdp, dialog, pdf, download_image, evaluate (run JS), close_session, connect_existing. Use snapshot first, then click_ref/fill_ref for robust interaction. " +
      "Backend is selected from app config: Playwright by default, with optional CDP-first attach to an existing browser.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "Action to perform",
          enum: ["navigate", "click", "type", "get_text", "get_links", "get_images", "screenshot", "vision", "evaluate", "console", "cdp", "dialog", "snapshot", "click_ref", "fill_ref", "scrollintoview", "press", "back", "wait", "status", "pdf", "download_image", "close_session", "connect_existing"],
        },
        url: {
          type: "string",
          description: "URL to navigate to, or an explicit CDP endpoint for 'connect_existing'",
        },
        selector: {
          type: "string",
          description: "CSS selector for element (required for click/type/get_text)",
        },
        ref: {
          type: "string",
          description: "Element ref from snapshot, e.g. @e1 (required for click_ref/fill_ref)",
        },
        text: {
          type: "string",
          description: "Text to type (required for 'type' and 'fill_ref' actions)",
        },
        key: {
          type: "string",
          description: "Keyboard key for 'press' action, e.g. Enter, Tab, Escape, ArrowDown",
        },
        script: {
          type: "string",
          description: "JavaScript to evaluate in page context (required for 'evaluate' action)",
        },
        output_path: {
          type: "string",
          description: "File path to save screenshot/PDF/downloaded image to",
        },
        image_url: {
          type: "string",
          description: "Direct image URL for download_image. If omitted, the tool picks a visible image from the current page.",
        },
        alt_text: {
          type: "string",
          description: "Optional text used by download_image to prefer an image whose alt/src/title contains this text.",
        },
        port: {
          type: "number",
          description: "CDP remote debugging port for 'connect_existing' action (default: 9222). Start Chrome with: chrome --remote-debugging-port=9222",
        },
        full: {
          type: "boolean",
          description: "For snapshot: when true, include full visible page text and links, not only compact interactive refs.",
        },
        limit: {
          type: "number",
          description: "Maximum number of links/elements to return for get_links/snapshot.",
        },
        timeout_ms: {
          type: "number",
          description: "Timeout for wait/navigation helpers in milliseconds.",
        },
        wait_until: {
          type: "string",
          description: "For wait action: selector, text, timeout, load, domcontentloaded, networkidle.",
        },
        question: {
          type: "string",
          description: "For vision action: what to analyze in the screenshot.",
        },
        analyze: {
          type: "boolean",
          description: "For vision action: set false to capture screenshot without calling a model.",
        },
        method: {
          type: "string",
          description: "For cdp action: allowed Chrome DevTools Protocol method, e.g. Runtime.evaluate or Accessibility.getFullAXTree.",
        },
        params: {
          type: "object",
          description: "For cdp action: JSON parameters for the CDP method.",
        },
        dialog_id: {
          type: "string",
          description: "For dialog action: pending dialog id from browser_dialog list.",
        },
        accept: {
          type: "boolean",
          description: "For dialog action: true to accept, false to dismiss.",
        },
      },
      required: ["action"],
    },
  },

  // ── Browser tool aliases (Part 1) — separate tool names that dispatch to browser_action ──
  browser_navigate: {
    name: "browser_navigate",
    description:
      "Drive a headless browser to a URL. Returns page title, final URL, body text excerpt, and interactive element refs. " +
      "When to use: JS-heavy pages, login-walled pages, sites where web_extract returns empty; YouTube/Reddit/GitHub when the static HTML is insufficient. " +
      "When NOT to use: simple static docs (web_extract is cheaper and faster); when only the URL list is needed (web_search). " +
      "After navigate, call browser_snapshot for element refs you can click/type on. Example: `{url: 'https://github.com/example/project/issues/123'}`.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to navigate to" },
      },
      required: ["url"],
    },
  },
  browser_snapshot: {
    name: "browser_snapshot",
    description: "Capture current browser page state. Default compact mode returns interactive refs (@e1, @e2, ...). Set full=true to include page text, links, counts, and warnings for research.",
    parameters: {
      type: "object",
      properties: {
        full: { type: "boolean", description: "If true, include full visible text and links." },
        limit: { type: "number", description: "Maximum interactive elements/links to include." },
      },
      required: [],
    },
  },
  browser_click: {
    name: "browser_click",
    description: "Click an interactive element on the current browser page identified by its ref from a previous browser_snapshot.",
    parameters: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Element ref from snapshot, e.g. @e1" },
      },
      required: ["ref"],
    },
  },
  browser_type: {
    name: "browser_type",
    description: "Type text into an input/textarea element on the current browser page identified by its ref from a previous browser_snapshot.",
    parameters: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Element ref from snapshot, e.g. @e3" },
        text: { type: "string", description: "Text to type" },
      },
      required: ["ref", "text"],
    },
  },
  browser_scroll: {
    name: "browser_scroll",
    description: "Scroll an element into view on the current browser page, identified by its ref from a previous browser_snapshot, or by a CSS selector.",
    parameters: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Element ref from snapshot, e.g. @e5" },
        selector: { type: "string", description: "CSS selector (optional, prefer ref)" },
      },
      required: [],
    },
  },
  browser_back: {
    name: "browser_back",
    description: "Navigate the browser back to the previous page in history.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  browser_press: {
    name: "browser_press",
    description: "Press a keyboard key on the current browser page (e.g. Enter, Tab, Escape, ArrowDown).",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string", description: "Keyboard key to press, e.g. Enter, Tab, Escape, ArrowDown" },
      },
      required: ["key"],
    },
  },
  browser_get_text: {
    name: "browser_get_text",
    description: "Get structured visible text content for the current browser page or a specific element by CSS selector. Returns JSON with title, URL, text length, and warnings.",
    parameters: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector for element (defaults to body for full page text)" },
      },
      required: [],
    },
  },
  browser_screenshot: {
    name: "browser_screenshot",
    description: "Take a full-page screenshot of the current browser page and save it to a file.",
    parameters: {
      type: "object",
      properties: {
        output_path: { type: "string", description: "File path to save the screenshot" },
      },
      required: [],
    },
  },
  browser_console: {
    name: "browser_console",
    description: "Read browser console logs/page errors/request failures, and optionally evaluate JavaScript in the current page context.",
    parameters: {
      type: "object",
      properties: {
        expression: { type: "string", description: "Optional JavaScript expression to evaluate in the page" },
        clear: { type: "boolean", description: "Clear captured console/error/request-failure buffers after reading." },
      },
      required: [],
    },
  },
  browser_get_links: {
    name: "browser_get_links",
    description: "Extract structured links from the current browser page. Use after navigating to search/index pages to turn leads into real source URLs.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Maximum number of links to return (default 200)." },
      },
      required: [],
    },
  },
  browser_get_images: {
    name: "browser_get_images",
    description: "Extract structured image metadata from the current browser page, including src, absolute URL, alt/title, dimensions, and visibility.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Maximum number of images to return (default 100)." },
      },
      required: [],
    },
  },
  browser_vision: {
    name: "browser_vision",
    description: "Take a screenshot of the current browser page and analyze it with the active vision-capable model. Returns the screenshot path and model analysis.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "What to inspect visually on the current page." },
        annotate: { type: "boolean", description: "Reserved for future element annotation; currently captures a normal screenshot." },
        analyze: { type: "boolean", description: "Set false to capture the screenshot without model analysis." },
      },
      required: ["question"],
    },
  },
  browser_cdp: {
    name: "browser_cdp",
    description: "Run an allowlisted Chrome DevTools Protocol inspection command against the current page. Intended for diagnostics, DOM/accessibility inspection, layout metrics, and read-only runtime evaluation.",
    parameters: {
      type: "object",
      properties: {
        method: { type: "string", description: "Allowed CDP method, e.g. Runtime.evaluate, DOM.getDocument, Accessibility.getFullAXTree." },
        params: { type: "object", description: "Parameters for the CDP method." },
      },
      required: ["method"],
    },
  },
  browser_dialog: {
    name: "browser_dialog",
    description: "List, accept, or dismiss pending browser dialogs captured from the current page.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", description: "list, accept, or dismiss." },
        dialog_id: { type: "string", description: "Pending dialog id from list output." },
        accept: { type: "boolean", description: "Alternative to action: true accepts, false dismisses." },
        text: { type: "string", description: "Optional prompt text when accepting a prompt dialog." },
      },
      required: [],
    },
  },
  browser_wait: {
    name: "browser_wait",
    description: "Wait for selector/text/load/networkidle/timeout on the current browser page before extracting dynamic content.",
    parameters: {
      type: "object",
      properties: {
        wait_until: { type: "string", description: "selector, text, timeout, load, domcontentloaded, or networkidle." },
        selector: { type: "string", description: "CSS selector when wait_until=selector." },
        text: { type: "string", description: "Text to wait for when wait_until=text." },
        timeout_ms: { type: "number", description: "Timeout in milliseconds (default 5000)." },
      },
      required: [],
    },
  },

  // ── web_extract (Part 3) — higher-level version of fetch_url with structured output ──
  web_extract: {
    name: "web_extract",
    description:
      "Fetch one or more URLs and return structured readable content (title, final URL, body text, content-type, verified flag). " +
      "When to use: after web_search returns candidate URLs — extract them to get the actual evidence; for known docs URLs the user provided; when you need to cite text as a source. " +
      "When NOT to use: search-engine result pages (those are discovery hints only — never cite a search index URL as evidence); for HTML-app pages with JS-rendered content (use browser_navigate). " +
      "If extraction returns empty/error for a URL, retry once with browser_navigate before giving up. Example: `{urls: ['https://example.com/docs/getting-started'], max_chars_per_url: 1200}`.",
    parameters: {
      type: "object",
      properties: {
        urls: {
          type: "array",
          description: "Array of URLs to extract. Max 5 per call.",
        },
        max_chars_per_url: {
          type: "number",
          description: "Maximum characters per extracted URL. Default 5000.",
        },
        format: {
          type: "string",
          description: "Output format",
          enum: ["text", "markdown", "json"],
        },
      },
      required: ["urls"],
    },
  },

  // ── web_crawl (Part 4) — read-only multi-page crawl ──
  web_crawl: {
    name: "web_crawl",
    description:
      "Crawl a starting URL and follow same-origin links up to a configured depth and page limit. " +
      "Returns structured results with titles, URLs, and extracted snippets for each crawled page. " +
      "Read-only — does not persist crawled content to Data Sources.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Starting URL to crawl",
        },
        max_pages: {
          type: "number",
          description: "Maximum pages to crawl (default 5, max 10)",
        },
        max_depth: {
          type: "number",
          description: "Maximum crawl depth from seed (default 1, max 2)",
        },
        include_patterns: {
          type: "string",
          description: "Comma-separated URL patterns to include (e.g. '/docs/,/blog/')",
        },
        exclude_patterns: {
          type: "string",
          description: "Comma-separated URL patterns to exclude",
        },
      },
      required: ["url"],
    },
  },

};
