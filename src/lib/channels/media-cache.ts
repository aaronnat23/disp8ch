import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "@/lib/utils/logger";

const CACHE_DIR = path.join(process.cwd(), "data", "cache", "channel-media");
const MAX_AGE_MS = 24 * 3600_000; // 24 hours

try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch { /* exists */ }

export async function cacheChannelImage(
  url: string,
  channel: string,
  msgId: string,
  headers?: Record<string, string>,
): Promise<string | null> {
  try {
    const ext = url.match(/\.(png|jpg|jpeg|gif|webp)(\?|$)/i)?.[1] || "jpg";
    const fileName = `${channel}-${String(msgId).slice(0, 12)}-${Date.now()}.${ext}`;
    const filePath = path.join(CACHE_DIR, fileName);

    const response = await fetch(url, { headers });
    if (!response.ok) return null;

    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(filePath, buffer);
    return filePath;
  } catch (err) {
    logger.warn("[media-cache] Failed to cache image", { url, error: String(err) });
    return null;
  }
}

export function cleanupMediaCache(): void {
  try {
    const now = Date.now();
    const files = fs.readdirSync(CACHE_DIR);
    for (const file of files) {
      const filePath = path.join(CACHE_DIR, file);
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > MAX_AGE_MS) {
        fs.unlinkSync(filePath);
      }
    }
  } catch { /* best-effort */ }
}

// Run cleanup every hour
setInterval(cleanupMediaCache, 3600_000);
