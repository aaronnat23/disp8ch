const MEMORY_CONTEXT_BLOCK = /<memory-context\b[^>]*>[\s\S]*?<\/memory-context>/gi;
const MEMORY_CONTEXT_LINE = /^\s*(?:Injected\s+)?memory\s+context\s*:\s*.*$/gim;
const MEMORY_CONTEXT_BLOCK_TEST = /<memory-context\b[^>]*>[\s\S]*?<\/memory-context>/i;
const MEMORY_CONTEXT_LINE_TEST = /^\s*(?:Injected\s+)?memory\s+context\s*:\s*.*$/im;

export function stripMemoryContextBlocks(text: string): string {
  return String(text || "")
    .replace(MEMORY_CONTEXT_BLOCK, "")
    .replace(MEMORY_CONTEXT_LINE, "")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

export function hasMemoryContextLeak(text: string): boolean {
  return MEMORY_CONTEXT_BLOCK_TEST.test(String(text || "")) || MEMORY_CONTEXT_LINE_TEST.test(String(text || ""));
}
