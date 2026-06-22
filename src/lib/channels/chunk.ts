export function chunkMessage(text: string, limit: number): string[] {
  const safeLimit = Math.max(50, limit | 0);
  const input = String(text || "");
  if (input.length <= safeLimit) return [input];

  const chunks: string[] = [];
  let remaining = input;

  while (remaining.length > safeLimit) {
    let splitAt = remaining.lastIndexOf("\n", safeLimit);
    if (splitAt <= 0) {
      splitAt = remaining.lastIndexOf(" ", safeLimit);
    }
    if (splitAt <= 0) {
      splitAt = safeLimit;
    }

    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}
