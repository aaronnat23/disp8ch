/**
 * Source-pack extractors. Deterministic text extraction with explicit ignore
 * rules. Never recursively scan a whole drive: the folder walker is depth- and
 * count-bounded, skips VCS/dependency/build dirs, env/credential files, and
 * binary or oversized files. Only metadata + extracted text is stored.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { htmlToText, limitText } from "@/lib/documents/store";

export const MAX_FILE_BYTES = 512 * 1024; // 512KB per file for text extraction
export const MAX_FILES_PER_PACK = 200;
export const MAX_WALK_DEPTH = 8;

export const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  "out",
  "coverage",
  ".turbo",
  ".cache",
  "vendor",
  ".venv",
  "__pycache__",
  ".idea",
  ".vscode",
]);

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".ico", ".svg", ".tiff",
  ".mp3", ".wav", ".flac", ".ogg", ".mp4", ".mov", ".avi", ".mkv", ".webm",
  ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar", ".xz",
  ".exe", ".dll", ".so", ".dylib", ".bin", ".o", ".a", ".class", ".wasm",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".db", ".sqlite", ".sqlite3",
]);

const TEXTLIKE_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".rst", ".csv", ".tsv",
  ".json", ".jsonc", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".properties",
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rb", ".go", ".rs", ".java",
  ".c", ".h", ".cpp", ".hpp", ".cs", ".php", ".swift", ".kt", ".scala", ".sh", ".bash",
  ".sql", ".graphql", ".proto", ".xml", ".gradle", ".dockerfile",
]);

const HTML_EXTENSIONS = new Set([".html", ".htm", ".xhtml"]);

/** Filenames/patterns that must never be ingested even if text. */
export function isSensitiveFile(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower === ".env" || lower.startsWith(".env.")) {
    // .env.example / .env.sample / .env.template are safe templates.
    return !(lower.endsWith(".example") || lower.endsWith(".sample") || lower.endsWith(".template"));
  }
  if (/\.(pem|key|p12|pfx|keystore|jks)$/.test(lower)) return true;
  if (/(^|\/)id_(rsa|dsa|ed25519|ecdsa)$/.test(lower)) return true;
  if (lower === "credentials" || lower === ".npmrc" || lower === ".netrc") return true;
  return false;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export type ExtractedFile = {
  text: string | null;
  mimeType: string;
  skippedReason: string | null;
  sizeBytes: number;
};

function guessMime(ext: string): string {
  if (HTML_EXTENSIONS.has(ext)) return "text/html";
  if (ext === ".json" || ext === ".jsonc") return "application/json";
  if (ext === ".md" || ext === ".markdown") return "text/markdown";
  if (ext === ".csv") return "text/csv";
  if (TEXTLIKE_EXTENSIONS.has(ext)) return "text/plain";
  if (BINARY_EXTENSIONS.has(ext)) return "application/octet-stream";
  return "text/plain";
}

const NULL_BYTE = String.fromCharCode(0);

/** Extract text from a single file path with full safety gating. */
export function extractFile(filePath: string): ExtractedFile {
  const ext = path.extname(filePath).toLowerCase();
  const base = path.basename(filePath);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return { text: null, mimeType: "application/octet-stream", skippedReason: "unreadable", sizeBytes: 0 };
  }
  const sizeBytes = stat.size;
  if (isSensitiveFile(base)) {
    return { text: null, mimeType: "application/octet-stream", skippedReason: "credential or env file", sizeBytes };
  }
  if (BINARY_EXTENSIONS.has(ext)) {
    return { text: null, mimeType: guessMime(ext), skippedReason: "binary file", sizeBytes };
  }
  if (sizeBytes > MAX_FILE_BYTES) {
    return { text: null, mimeType: guessMime(ext), skippedReason: `oversized (${sizeBytes} bytes)`, sizeBytes };
  }
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return { text: null, mimeType: guessMime(ext), skippedReason: "unreadable", sizeBytes };
  }
  // Reject likely-binary content that slipped past the extension allowlist.
  if (raw.includes(NULL_BYTE)) {
    return { text: null, mimeType: "application/octet-stream", skippedReason: "binary content", sizeBytes };
  }
  const text = HTML_EXTENSIONS.has(ext) ? htmlToText(raw) : limitText(raw);
  return { text, mimeType: guessMime(ext), skippedReason: null, sizeBytes };
}

export type WalkedFile = { absPath: string; relPath: string };

/**
 * Bounded, ignore-aware recursive walk. Returns at most MAX_FILES_PER_PACK
 * files and never descends into ignored directories or beyond MAX_WALK_DEPTH.
 */
export function walkFolder(root: string, limit = MAX_FILES_PER_PACK): WalkedFile[] {
  const out: WalkedFile[] = [];
  const rootResolved = path.resolve(root);
  function walk(dir: string, depth: number): void {
    if (out.length >= limit || depth > MAX_WALK_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // Stable order so packs are deterministic.
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (out.length >= limit) return;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        walk(abs, depth + 1);
      } else if (entry.isFile()) {
        if (isSensitiveFile(entry.name)) continue;
        out.push({ absPath: abs, relPath: path.relative(rootResolved, abs) });
      }
    }
  }
  walk(rootResolved, 0);
  return out;
}
