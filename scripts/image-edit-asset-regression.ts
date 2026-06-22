/** Controlled image-asset resolution regression (temp DB/files, no paid API). */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";

const originalCwd = process.cwd();
const tmp = path.join(os.tmpdir(), `disp8ch_image_asset_${Date.now()}`);
fs.mkdirSync(tmp, { recursive: true });
process.chdir(tmp);
process.env.DATABASE_PATH = path.join(tmp, "image-assets.db");

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed++;
    console.log(`  PASS ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.error(`  FAIL ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

async function rejects(fn: () => Promise<unknown>): Promise<boolean> {
  try { await fn(); return false; } catch { return true; }
}

function cleanupTempDirectory(): void {
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (error) {
    // Native image/SQLite handles can be released slightly after close on Windows.
    console.warn(`Temporary cleanup deferred: ${String(error)}`);
  }
}

async function main() {
  const { initializeDatabase, getSqlite } = await import("../src/lib/db");
  const { resolveImageAsset } = await import("../src/lib/image-gen/assets");
  const { resolveImageCapabilities } = await import("../src/lib/image-gen/provider");
  const { openaiImageProvider } = await import("../src/lib/image-gen/providers/openai");
  initializeDatabase();
  const caps = resolveImageCapabilities(openaiImageProvider);

  console.log("\nGenerated assets");
  const generatedDir = path.join(tmp, "data", "generated-images");
  fs.mkdirSync(generatedDir, { recursive: true });
  const generatedPath = path.join(generatedDir, "sample.png");
  await sharp({ create: { width: 4, height: 4, channels: 4, background: "#336699" } }).png().toFile(generatedPath);
  const generated = await resolveImageAsset({ assetId: "sample.png" }, caps);
  check("generated image resolves by controlled basename", generated.mimeType === "image/png" && generated.sizeBytes > 0);
  check("raw path traversal is rejected", await rejects(() => resolveImageAsset({ assetId: "../sample.png" }, caps)));

  console.log("\nUploaded assets");
  const uploadDir = path.join(tmp, "data", "uploads", "chat");
  fs.mkdirSync(uploadDir, { recursive: true });
  const uploadPath = path.join(uploadDir, "upload-1.webp");
  await sharp({ create: { width: 3, height: 3, channels: 3, background: "#ffffff" } }).webp().toFile(uploadPath);
  const size = fs.statSync(uploadPath).size;
  getSqlite().prepare(
    "INSERT INTO chat_attachments(id, session_id, file_name, mime_type, size_bytes, path, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run("upload_1", "session", "upload.webp", "image/webp", size, uploadPath, "{}", new Date().toISOString());
  const upload = await resolveImageAsset({ assetId: "upload_1", mimeType: "image/webp" }, caps);
  check("chat upload resolves inside its controlled root", upload.mimeType === "image/webp" && upload.fileName === "upload.webp");

  const outside = path.join(tmp, "outside.png");
  fs.copyFileSync(generatedPath, outside);
  getSqlite().prepare(
    "INSERT INTO chat_attachments(id, session_id, file_name, mime_type, size_bytes, path, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run("upload_outside", "session", "outside.png", "image/png", fs.statSync(outside).size, outside, "{}", new Date().toISOString());
  check("database path outside upload root is rejected", await rejects(() => resolveImageAsset({ assetId: "upload_outside" }, caps)));
  check("declared MIME mismatch is rejected", await rejects(() => resolveImageAsset({ assetId: "upload_1", mimeType: "image/png" }, caps)));

  console.log("\nProvider dispatch source");
  const providerSource = fs.readFileSync(path.join(originalCwd, "src", "lib", "image-gen", "providers", "openai.ts"), "utf8");
  check("edit mode dispatches to images.edit", providerSource.includes("client.images.edit"));
  check("edit mode resolves controlled assets", providerSource.includes("resolveImageAsset"));
  sharp.cache(false);
  getSqlite().close();
}

main().then(() => {
  process.chdir(originalCwd);
  cleanupTempDirectory();
  console.log(`\nimage-edit-asset-regression: ${passed} passed, ${failed} failed`);
  if (failed) {
    console.error(`Failed: ${failures.join(", ")}`);
    process.exit(1);
  }
}).catch((error) => {
  process.chdir(originalCwd);
  cleanupTempDirectory();
  console.error(error);
  process.exit(1);
});
