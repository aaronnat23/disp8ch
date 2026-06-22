import type { ImageAspectRatio } from "@/lib/image-gen/registry";

export type ImageGenerationMode = "generate" | "edit";

/** Reference to an input image for edit mode — a controlled asset id, never an
 * arbitrary remote URL or unrestricted filesystem path. */
export interface ImageAssetReference {
  /** Controlled asset id (e.g. an uploaded/generated image record). */
  assetId: string;
  mimeType?: string;
}

export interface ImageGenerationRequest {
  prompt: string;
  aspectRatio: ImageAspectRatio;
  model?: string;
  quality?: string;
  width?: number;
  height?: number;
  /** "generate" (default) or "edit". */
  mode?: ImageGenerationMode;
  /** Input images for edit mode (resolved from controlled asset ids). */
  inputImages?: ImageAssetReference[];
}

/** Per-provider capability metadata so the common request maps safely and an
 * unsupported provider returns a truthful error instead of silently generating
 * an unrelated image. */
export interface ImageProviderCapabilities {
  supportsGeneration: boolean;
  supportsEditing: boolean;
  maxReferenceImages: number;
  acceptedMimeTypes: string[];
  maxInputBytes: number;
}

export const DEFAULT_IMAGE_CAPABILITIES: ImageProviderCapabilities = {
  supportsGeneration: true,
  supportsEditing: false,
  maxReferenceImages: 0,
  acceptedMimeTypes: ["image/png", "image/jpeg", "image/webp"],
  maxInputBytes: 10 * 1024 * 1024,
};

export interface ImageGenerationResult {
  success: boolean;
  imagePath?: string;
  imageUrl?: string;
  provider: string;
  model?: string;
  prompt: string;
  aspectRatio: ImageAspectRatio;
  mimeType?: string;
  width?: number;
  height?: number;
  sizeBytes?: number;
  error?: string;
  errorType?: "missing_config" | "provider_error" | "download_error" | "validation_error";
}

export interface ImageGenProvider {
  name: string;
  displayName: string;
  isAvailable(): Promise<boolean>;
  listModels(): Promise<Array<{ id: string; label: string; capabilities?: string[] }>>;
  defaultModel(): string;
  generate(request: ImageGenerationRequest): Promise<ImageGenerationResult>;
  /** Optional capability metadata; defaults to generation-only when absent. */
  capabilities?(): ImageProviderCapabilities;
}

/** Resolve a provider's capabilities, falling back to generation-only. */
export function resolveImageCapabilities(provider: Pick<ImageGenProvider, "capabilities">): ImageProviderCapabilities {
  try {
    return provider.capabilities?.() ?? DEFAULT_IMAGE_CAPABILITIES;
  } catch {
    return DEFAULT_IMAGE_CAPABILITIES;
  }
}

export interface ImageRequestValidation {
  ok: boolean;
  error?: string;
  errorType?: ImageGenerationResult["errorType"];
}

/**
 * Validate an image request against a provider's capabilities. Pure + reusable —
 * used before dispatching so an unsupported edit returns a clear capability error
 * rather than silently generating an unrelated image.
 */
export function validateImageRequest(
  request: ImageGenerationRequest,
  caps: ImageProviderCapabilities,
): ImageRequestValidation {
  const mode = request.mode ?? "generate";
  if (mode === "generate") {
    if (!caps.supportsGeneration) {
      return { ok: false, errorType: "validation_error", error: "This provider does not support image generation." };
    }
    return { ok: true };
  }
  // edit
  if (!caps.supportsEditing) {
    return { ok: false, errorType: "validation_error", error: "This provider does not support image editing. Choose an edit-capable image provider." };
  }
  const refs = request.inputImages ?? [];
  if (refs.length === 0) {
    return { ok: false, errorType: "validation_error", error: "Edit mode requires at least one input image." };
  }
  if (refs.length > caps.maxReferenceImages) {
    return { ok: false, errorType: "validation_error", error: `This provider accepts at most ${caps.maxReferenceImages} reference image(s).` };
  }
  for (const ref of refs) {
    if (!ref.assetId || /^https?:|\.\.\/|^\//.test(ref.assetId)) {
      return { ok: false, errorType: "validation_error", error: "Input images must be referenced by a controlled asset id (no raw URLs or filesystem paths)." };
    }
    if (ref.mimeType && !caps.acceptedMimeTypes.includes(ref.mimeType)) {
      return { ok: false, errorType: "validation_error", error: `Unsupported input type ${ref.mimeType}. Accepted: ${caps.acceptedMimeTypes.join(", ")}.` };
    }
  }
  return { ok: true };
}

export const ASPECT_PRESETS: Record<ImageAspectRatio, { width: number; height: number }> = {
  square: { width: 1024, height: 1024 },
  landscape: { width: 1344, height: 768 },
  portrait: { width: 768, height: 1024 },
};
