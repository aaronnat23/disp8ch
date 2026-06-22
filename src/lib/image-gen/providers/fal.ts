import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getSqlite } from "@/lib/db";
import { resolveSecretValue } from "@/lib/secrets/store";
import { ASPECT_PRESETS, type ImageGenProvider, type ImageGenerationRequest, type ImageGenerationResult } from "@/lib/image-gen/provider";

function resolveFalKey(): string {
  try {
    const row = getSqlite()
      .prepare("SELECT image_generation_api_key FROM app_config WHERE id = 'default'")
      .get() as { image_generation_api_key?: string } | undefined;
    let raw = String(row?.image_generation_api_key ?? "").trim();
    if (raw.startsWith("secret:")) {
      raw = resolveSecretValue(raw.slice(7).trim().toUpperCase()) ?? "";
    }
    return raw;
  } catch {
    return process.env["FAL_KEY"] || process.env["FAL_API_KEY"] || "";
  }
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

export const falProvider: ImageGenProvider = {
  name: "fal",
  displayName: "FAL.ai",

  async isAvailable(): Promise<boolean> {
    return Boolean(resolveFalKey());
  },

  async listModels(): Promise<Array<{ id: string; label: string; capabilities?: string[] }>> {
    return [
      { id: "fal-ai/flux-pro/v1.1-ultra", label: "FLUX Pro v1.1 Ultra", capabilities: ["png"] },
      { id: "fal-ai/flux/dev", label: "FLUX Dev", capabilities: ["png"] },
      { id: "fal-ai/flux/schnell", label: "FLUX Schnell", capabilities: ["png"] },
    ];
  },

  defaultModel(): string {
    return "fal-ai/flux-pro/v1.1-ultra";
  },

  async generate(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    const apiKey = resolveFalKey();
    if (!apiKey) {
      return {
        success: false,
        provider: "fal",
        prompt: request.prompt,
        aspectRatio: request.aspectRatio,
        errorType: "missing_config",
        error: "No FAL API key configured. Add your key in Settings > General > Image Generation, or set secret:FAL_API_KEY.",
      };
    }

    const preset = ASPECT_PRESETS[request.aspectRatio];
    const width = request.width || preset.width;
    const height = request.height || preset.height;
    const model = request.model || this.defaultModel();

    try {
      const response = await fetch(`https://queue.fal.run/${model}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Key ${apiKey}`,
        },
        body: JSON.stringify({
          prompt: request.prompt,
          image_size: { width, height },
          num_images: 1,
          output_format: "png",
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return {
          success: false,
          provider: "fal",
          model,
          prompt: request.prompt,
          aspectRatio: request.aspectRatio,
          errorType: "provider_error",
          error: `FAL.ai error (HTTP ${response.status}): ${errorText.slice(0, 500)}`,
        };
      }

      const data = await response.json() as {
        images?: Array<{ url?: string; content_type?: string }>;
        error?: string;
      };
      if (data.error) {
        return {
          success: false,
          provider: "fal",
          model,
          prompt: request.prompt,
          aspectRatio: request.aspectRatio,
          errorType: "provider_error",
          error: `FAL.ai API error: ${String(data.error)}`,
        };
      }

      const imageUrl = data.images?.[0]?.url;
      if (!imageUrl) {
        return {
          success: false,
          provider: "fal",
          model,
          prompt: request.prompt,
          aspectRatio: request.aspectRatio,
          errorType: "provider_error",
          error: "FAL.ai returned no image URL.",
        };
      }

      const imgResponse = await fetch(imageUrl);
      if (!imgResponse.ok) {
        return {
          success: false,
          provider: "fal",
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
          provider: "fal",
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
        provider: "fal",
        model,
        prompt: request.prompt,
        aspectRatio: request.aspectRatio,
        mimeType: "image/png",
        width,
        height,
        sizeBytes: imgBuffer.length,
      };
    } catch (err) {
      return {
        success: false,
        provider: "fal",
        model,
        prompt: request.prompt,
        aspectRatio: request.aspectRatio,
        errorType: "provider_error",
        error: `FAL.ai generation failed: ${String(err)}`,
      };
    }
  },
};
