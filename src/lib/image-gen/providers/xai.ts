import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { resolveSecretValue } from "@/lib/secrets/store";
import { ASPECT_PRESETS, type ImageGenProvider, type ImageGenerationRequest, type ImageGenerationResult } from "@/lib/image-gen/provider";

function resolveXAIKey(): string {
  return resolveSecretValue("XAI_API_KEY") ?? process.env["XAI_API_KEY"] ?? "";
}

function validateWorkspacePath(filePath: string): string | null {
  try {
    const resolved = path.resolve(filePath);
    const root = path.resolve(process.cwd());
    const normalized = resolved.replace(/\\/g, "/");
    const rootNormalized = root.replace(/\\/g, "/") + "/";
    if (!normalized.startsWith(rootNormalized)) return "Error: path escapes workspace";
    return null;
  } catch {
    return "Error: invalid file path";
  }
}

export const xaiImageProvider: ImageGenProvider = {
  name: "xai",
  displayName: "xAI (Grok)",

  async isAvailable(): Promise<boolean> {
    return Boolean(resolveXAIKey());
  },

  async listModels(): Promise<Array<{ id: string; label: string; capabilities?: string[] }>> {
    return [
      { id: "grok-2-image", label: "Grok 2 Image", capabilities: ["png"] },
    ];
  },

  defaultModel(): string {
    return "grok-2-image";
  },

  async generate(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    const apiKey = resolveXAIKey();
    if (!apiKey) {
      return {
        success: false,
        provider: "xai",
        prompt: request.prompt,
        aspectRatio: request.aspectRatio,
        errorType: "missing_config",
        error: "No xAI API key configured. Set secret:XAI_API_KEY and set image_generation_provider to 'xai' in Settings > General.",
      };
    }

    const preset = ASPECT_PRESETS[request.aspectRatio];
    const width = request.width || preset.width;
    const height = request.height || preset.height;
    const model = request.model || this.defaultModel();

    try {
      const importOpenai = await import("openai");
      const client = new importOpenai.OpenAI({ baseURL: "https://api.x.ai/v1", apiKey });
      const size = `${width}x${height}`;

      const response = await client.images.generate({
        model,
        prompt: request.prompt,
        n: 1,
        size: size as "1024x1024",
        response_format: "url",
      });

      const imageUrl = response.data?.[0]?.url;
      if (!imageUrl) {
        return {
          success: false,
          provider: "xai",
          model,
          prompt: request.prompt,
          aspectRatio: request.aspectRatio,
          errorType: "provider_error",
          error: "xAI returned no image URL.",
        };
      }

      const imgResponse = await fetch(imageUrl);
      if (!imgResponse.ok) {
        return {
          success: false,
          provider: "xai",
          model,
          prompt: request.prompt,
          aspectRatio: request.aspectRatio,
          errorType: "download_error",
          error: `Failed to download image: HTTP ${imgResponse.status}`,
        };
      }

      const imgBuffer = Buffer.from(await imgResponse.arrayBuffer());
      const outputDir = path.resolve("data", "generated-images");
      fs.mkdirSync(outputDir, { recursive: true });
      const generatedId = `${Date.now()}-${crypto.randomUUID()}.png`;
      const outputPath = path.join(outputDir, generatedId);
      const outputPathError = validateWorkspacePath(outputPath);
      if (outputPathError) {
        return {
          success: false,
          provider: "xai",
          model,
          prompt: request.prompt,
          aspectRatio: request.aspectRatio,
          errorType: "validation_error",
          error: outputPathError,
        };
      }
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, imgBuffer);

      const publicId = path.basename(outputPath);
      const publicUrl = `/api/generated-images?id=${encodeURIComponent(publicId)}`;

      return {
        success: true,
        imagePath: outputPath,
        imageUrl: publicUrl,
        provider: "xai",
        model,
        prompt: request.prompt,
        aspectRatio: request.aspectRatio,
        mimeType: "image/png",
        width,
        height,
        sizeBytes: imgBuffer.length,
      };
    } catch (err) {
      const msg = String(err);
      if (msg.toLowerCase().includes("api key") || msg.toLowerCase().includes("auth") || msg.includes("401")) {
        return {
          success: false,
          provider: "xai",
          model,
          prompt: request.prompt,
          aspectRatio: request.aspectRatio,
          errorType: "missing_config",
          error: `xAI generation failed — authentication error: ${msg.slice(0, 300)}`,
        };
      }
      return {
        success: false,
        provider: "xai",
        model,
        prompt: request.prompt,
        aspectRatio: request.aspectRatio,
        errorType: "provider_error",
        error: `xAI generation failed: ${msg.slice(0, 500)}`,
      };
    }
  },
};
