import { registerWebProvider } from "@/lib/web/providers/registry";
import type { WebProvider } from "@/lib/web/providers/types";

export function registerTavilyProvider(): void {
  registerWebProvider({
    name: "tavily",
    supports: { search: true, extract: true, crawl: false },
    async health() { return { ok: Boolean(process.env.TAVILY_API_KEY), reason: process.env.TAVILY_API_KEY ? undefined : "TAVILY_API_KEY missing" }; },
  } as WebProvider);
}

