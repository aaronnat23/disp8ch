import { logger } from "@/lib/utils/logger";
import type { ImageGenProvider, ImageGenerationRequest, ImageGenerationResult } from "@/lib/image-gen/provider";
import { resolveImageCapabilities, validateImageRequest } from "@/lib/image-gen/provider";
import { falProvider } from "@/lib/image-gen/providers/fal";
import { openaiImageProvider } from "@/lib/image-gen/providers/openai";
import { xaiImageProvider } from "@/lib/image-gen/providers/xai";

const log = logger.child("image-gen:registry");

export type ImageAspectRatio = "landscape" | "square" | "portrait";

type ProviderId = "fal" | "openai" | "xai";

const BUILTIN_PROVIDERS: Record<ProviderId, ImageGenProvider> = {
  fal: falProvider,
  openai: openaiImageProvider,
  xai: xaiImageProvider,
};

export function listProviders(): Array<{ id: string; displayName: string }> {
  return Object.entries(BUILTIN_PROVIDERS).map(([id, p]) => ({
    id,
    displayName: p.displayName,
  }));
}

export function getProvider(id: string): ImageGenProvider | null {
  return (BUILTIN_PROVIDERS as Record<string, ImageGenProvider>)[id] ?? null;
}

export async function getActiveProvider(preferredId?: string | null, mode: "generate" | "edit" = "generate"): Promise<{
  provider: ImageGenProvider;
  providerId: string;
} | null> {
  if (preferredId) {
    const p = getProvider(preferredId);
    const caps = p ? resolveImageCapabilities(p) : null;
    if (p && (mode === "edit" ? caps?.supportsEditing : caps?.supportsGeneration) && (await p.isAvailable())) {
      return { provider: p, providerId: preferredId };
    }
  }
  for (const [id, p] of Object.entries(BUILTIN_PROVIDERS)) {
    const caps = resolveImageCapabilities(p);
    if ((mode === "edit" ? caps.supportsEditing : caps.supportsGeneration) && await p.isAvailable()) {
      return { provider: p, providerId: id as ProviderId };
    }
  }
  return null;
}

export async function generateImage(
  request: ImageGenerationRequest & { providerId?: string | null },
): Promise<ImageGenerationResult> {
  const active = await getActiveProvider(request.providerId, request.mode ?? "generate");
  if (!active) {
    return {
      success: false,
      provider: "none",
      prompt: request.prompt,
      aspectRatio: request.aspectRatio,
      errorType: "missing_config",
      error: "No image generation provider is configured. Set FAL_API_KEY, OPENAI_API_KEY, or XAI_API_KEY as a secret, then configure the matching API key in Settings > General > Image Generation.",
    };
  }
  // Validate the request (esp. edit mode) against the provider's capabilities so
  // an unsupported edit returns a truthful error instead of silently generating
  // an unrelated image.
  const caps = resolveImageCapabilities(active.provider);
  const validation = validateImageRequest(request, caps);
  if (!validation.ok) {
    return {
      success: false,
      provider: active.providerId,
      prompt: request.prompt,
      aspectRatio: request.aspectRatio,
      errorType: validation.errorType ?? "validation_error",
      error: validation.error,
    };
  }
  log.info("generating image", {
    provider: active.providerId,
    mode: request.mode ?? "generate",
    aspectRatio: request.aspectRatio,
    promptLength: request.prompt.length,
  });
  const result = await active.provider.generate(request);
  return { ...result, provider: active.providerId };
}

export async function getImageGenerationConfigStatus(): Promise<{
  availableProviders: string[];
  activeProvider: string | null;
  configured: boolean;
  /** Per-provider capability metadata (generation/editing support). */
  capabilities: Record<string, { supportsGeneration: boolean; supportsEditing: boolean; maxReferenceImages: number }>;
  activeSupportsEditing: boolean;
}> {
  const available: string[] = [];
  let active: string | null = null;
  const capabilities: Record<string, { supportsGeneration: boolean; supportsEditing: boolean; maxReferenceImages: number }> = {};
  for (const [id, p] of Object.entries(BUILTIN_PROVIDERS)) {
    const caps = resolveImageCapabilities(p);
    capabilities[id] = {
      supportsGeneration: caps.supportsGeneration,
      supportsEditing: caps.supportsEditing,
      maxReferenceImages: caps.maxReferenceImages,
    };
    if (await p.isAvailable()) {
      available.push(id);
      if (!active) active = id;
    }
  }
  return {
    availableProviders: available,
    activeProvider: active,
    configured: available.length > 0,
    capabilities,
    activeSupportsEditing: active ? Boolean(capabilities[active]?.supportsEditing) : false,
  };
}
