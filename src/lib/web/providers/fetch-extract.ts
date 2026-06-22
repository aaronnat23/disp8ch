import { registerWebProvider } from "@/lib/web/providers/registry";
import type { WebProvider } from "@/lib/web/providers/types";

export function registerFetchExtractProvider(executeTool: (name: string, args: Record<string, unknown>) => Promise<string>): void {
  const provider: WebProvider = {
    name: "fetch-extract",
    supports: { search: false, extract: true, crawl: false },
    async health() { return { ok: true }; },
    async extract(urls, opts) {
      try {
        const raw = await executeTool("web_extract", {
          urls,
          max_chars_per_url: opts.maxCharsPerUrl ?? 6000,
          format: opts.format ?? "json",
        });
        return { success: true, provider: "fetch-extract", raw };
      } catch (error) {
        return { success: false, provider: "fetch-extract", error: String(error) };
      }
    },
  };
  registerWebProvider(provider);
}

