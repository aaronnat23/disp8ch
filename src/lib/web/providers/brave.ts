import { registerWebProvider } from "@/lib/web/providers/registry";
import type { WebProvider } from "@/lib/web/providers/types";

export function registerBraveProvider(): void {
  registerWebProvider({
    name: "brave",
    supports: { search: true, extract: false, crawl: false },
    async health() { return { ok: Boolean(process.env.BRAVE_SEARCH_API_KEY), reason: process.env.BRAVE_SEARCH_API_KEY ? undefined : "BRAVE_SEARCH_API_KEY missing" }; },
  } as WebProvider);
}

