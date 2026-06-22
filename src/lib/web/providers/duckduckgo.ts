import { registerWebProvider } from "@/lib/web/providers/registry";
import type { WebProvider } from "@/lib/web/providers/types";

export function registerDuckDuckGoProvider(executeTool: (name: string, args: Record<string, unknown>) => Promise<string>): void {
  const provider: WebProvider = {
    name: "duckduckgo",
    supports: { search: true, extract: false, crawl: false },
    async health() { return { ok: true }; },
    async search(query, opts) {
      try {
        const raw = await executeTool("web_search", { query, max_results: opts.maxResults ?? 6 });
        return { success: true, provider: "duckduckgo", raw };
      } catch (error) {
        return { success: false, provider: "duckduckgo", error: String(error) };
      }
    },
  };
  registerWebProvider(provider);
}
