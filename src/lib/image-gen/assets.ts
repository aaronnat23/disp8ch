import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { getSqlite, initializeDatabase } from "@/lib/db";
import type { ImageAssetReference, ImageProviderCapabilities } from "@/lib/image-gen/provider";

export interface ResolvedImageAsset {
  assetId: string;
  buffer: Buffer;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

const FORMAT_TO_MIME: Record<string, string> = {
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function readVerifiedImage(
  ref: ImageAssetReference,
  filePath: string,
  fileName: string,
  declaredMime: string,
  caps: ImageProviderCapabilities,
): Promise<ResolvedImageAsset> {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error(`Image asset not found: ${ref.assetId}`);
  if (stat.size > caps.maxInputBytes) {
    throw new Error(`Input image exceeds the provider limit of ${caps.maxInputBytes} bytes.`);
  }
  const metadata = await sharp(filePath).metadata();
  const detectedMime = FORMAT_TO_MIME[String(metadata.format || "").toLowerCase()] || "";
  if (!detectedMime || !caps.acceptedMimeTypes.includes(detectedMime)) {
    throw new Error(`Unsupported input image type. Accepted: ${caps.acceptedMimeTypes.join(", ")}.`);
  }
  if (declaredMime && declaredMime !== detectedMime) {
    throw new Error("Input image metadata does not match its file content.");
  }
  return {
    assetId: ref.assetId,
    buffer: fs.readFileSync(filePath),
    fileName,
    mimeType: detectedMime,
    sizeBytes: stat.size,
  };
}

/** Resolve only app-owned upload/generated-image ids. Raw URLs and paths never enter providers. */
export async function resolveImageAsset(
  ref: ImageAssetReference,
  caps: ImageProviderCapabilities,
): Promise<ResolvedImageAsset> {
  initializeDatabase();
  const assetId = String(ref.assetId || "").trim();
  if (!assetId || assetId.includes("/") || assetId.includes("\\") || assetId.includes("..")) {
    throw new Error("Invalid controlled image asset id.");
  }

  const upload = getSqlite()
    .prepare("SELECT file_name, mime_type, size_bytes, path FROM chat_attachments WHERE id = ?")
    .get(assetId) as { file_name: string; mime_type: string; size_bytes: number; path: string } | undefined;
  if (upload) {
    if (!String(upload.mime_type || "").startsWith("image/")) {
      throw new Error("The selected upload is not an image.");
    }
    if (ref.mimeType && ref.mimeType !== upload.mime_type) {
      throw new Error("Input image metadata does not match the upload record.");
    }
    const root = path.resolve(process.cwd(), "data", "uploads", "chat");
    const resolved = path.resolve(upload.path);
    if (!isInside(root, resolved)) throw new Error("Upload path is outside the controlled image root.");
    return readVerifiedImage(ref, resolved, upload.file_name, upload.mime_type, caps);
  }

  const generatedRoot = path.resolve(process.cwd(), "data", "generated-images");
  const generatedPath = path.resolve(generatedRoot, assetId);
  if (!isInside(generatedRoot, generatedPath) || !fs.existsSync(generatedPath)) {
    throw new Error(`Controlled image asset not found: ${assetId}`);
  }
  return readVerifiedImage(ref, generatedPath, path.basename(generatedPath), ref.mimeType || "", caps);
}
