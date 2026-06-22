export type WebCapability = "search" | "extract" | "crawl";

export type SearchOptions = { maxResults?: number };
export type ExtractOptions = { maxCharsPerUrl?: number; format?: "json" | "text" };
export type CrawlOptions = { maxPages?: number; maxDepth?: number };

export type SearchResult = {
  success: boolean;
  provider: string;
  data?: { web: Array<{ title?: string; url: string; description?: string; position?: number }> };
  raw?: string;
  error?: string;
};

export type ExtractResult = {
  success: boolean;
  provider: string;
  data?: Array<{ url: string; finalUrl?: string; title?: string; content: string; metadata?: Record<string, unknown> }>;
  raw?: string;
  error?: string;
};

export type CrawlResult = {
  success: boolean;
  provider: string;
  data?: ExtractResult["data"];
  raw?: string;
  error?: string;
};

export type WebProvider = {
  name: string;
  supports: Record<WebCapability, boolean>;
  health(): Promise<{ ok: boolean; reason?: string }>;
  search?(query: string, opts: SearchOptions): Promise<SearchResult>;
  extract?(urls: string[], opts: ExtractOptions): Promise<ExtractResult>;
  crawl?(url: string, opts: CrawlOptions): Promise<CrawlResult>;
};

