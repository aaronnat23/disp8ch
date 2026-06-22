import { registerWebProvider } from "@/lib/web/providers/registry";
import type { WebProvider } from "@/lib/web/providers/types";

export function registerExaProvider(): void {
  registerWebProvider({
    name: "exa",
    supports: { search: true, extract: true, crawl: false },
    async health() { return { ok: Boolean(process.env.EXA_API_KEY), reason: process.env.EXA_API_KEY ? undefined : "EXA_API_KEY missing" }; },
  } as WebProvider);
}

