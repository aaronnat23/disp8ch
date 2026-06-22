import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getSqlite } from "@/lib/db";
import { resolveSecretValue } from "@/lib/secrets/store";
import { ASPECT_PRESETS, resolveImageCapabilities, type ImageGenProvider, type ImageGenerationRequest, type ImageGenerationResult } from "@/lib/image-gen/provider";
import { resolveImageAsset } from "@/lib/image-gen/assets";

function resolveOpenAIKey(): string {
  try {
    const row = getSqlite()
      .prepare("SELECT image_generation_api_key FROM app_config WHERE id = 'default'")
      .get() as { image_generation_api_key?: string } | undefined;
    let raw = String(row?.image_generation_api_key ?? "").trim();
    if (raw.startsWith("secret:OPENAI")) {
      raw = resolveSecretValue(raw.slice(7).trim().toUpperCase()) ?? "";
    } else if (raw.startsWith("secret:")) {
      raw = resolveSecretValue(raw.slice(7).trim().toUpperCase()) ?? "";
    }
    if (raw) return raw;
    return resolveSecretValue("OPENAI_API_KEY") ?? process.env["OPENAI_API_KEY"] ?? "";
  } catch {
    return resolveSecretValue("OPENAI_API_KEY") ?? process.env["OPENAI_API_KEY"] ?? "";
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

export const openaiImageProvider: ImageGenProvider = {
  name: "openai",
  displayName: "OpenAI",

  async isAvailable(): Promise<boolean> {
    return Boolean(resolveOpenAIKey());
  },

  async listModels(): Promise<Array<{ id: string; label: string; capabilities?: string[] }>> {
    return [
      { id: "dall-e-3", label: "DALL-E 3", capabilities: ["png", "1024x1024", "1792x1024", "1024x1792"] },
      { id: "dall-e-2", label: "DALL-E 2", capabilities: ["png", "1024x1024", "512x512", "256x256"] },
      { id: "gpt-image-1", label: "GPT Image 1", capabilities: ["png", "high_quality"] },
      { id: "gpt-image-2", label: "GPT Image 2", capabilities: ["png", "high_quality"] },
    ];
  },

  defaultModel(): string {
    return "dall-e-3";
  },

  capabilities() {
    // OpenAI's image API supports edits (gpt-image-1 / dall-e-2 edit endpoint).
    return {
      supportsGeneration: true,
      supportsEditing: true,
      maxReferenceImages: 16,
      acceptedMimeTypes: ["image/png", "image/jpeg", "image/webp"],
      maxInputBytes: 25 * 1024 * 1024,
    };
  },

  async generate(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    const apiKey = resolveOpenAIKey();
    if (!apiKey) {
      return {
        success: false,
        provider: "openai",
        prompt: request.prompt,
        aspectRatio: request.aspectRatio,
        errorType: "missing_config",
        error: "No OpenAI API key configured. Set OPENAI_API_KEY as a secret, then configure Settings > General > Image Generation to use the OpenAI provider.",
      };
    }

    const preset = ASPECT_PRESETS[request.aspectRatio];
    const width = request.width || preset.width;
    const height = request.height || preset.height;
    const mode = request.mode ?? "generate";
    const requestedModel = request.model || this.defaultModel();
    const model = mode === "edit" && requestedModel !== "gpt-image-1" && requestedModel !== "dall-e-2"
      ? "gpt-image-1"
      : requestedModel;

    try {
      const openaiSdk = await import("openai");
      const client = new openaiSdk.OpenAI({ apiKey });
      const size = model.startsWith("gpt-image")
        ? width === height
          ? "1024x1024"
          : width > height
            ? "1536x1024"
            : "1024x1536"
        : width === height
          ? "1024x1024"
          : width > height
            ? "1792x1024"
            : "1024x1792";

      const isBase64Model = model.startsWith("gpt-image");
      const response = mode === "edit"
        ? await (async () => {
            const refs = request.inputImages ?? [];
            const caps = resolveImageCapabilities(this);
            const assets = await Promise.all(refs.map((ref) => resolveImageAsset(ref, caps)));
            const uploads = await Promise.all(
              assets.map((asset) => openaiSdk.toFile(asset.buffer, asset.fileName, { type: asset.mimeType })),
            );
            return client.images.edit({
              model,
              image: uploads.length === 1 ? uploads[0]! : uploads,
              prompt: request.prompt,
              n: 1,
              size: size as "1024x1024" | "1536x1024" | "1024x1536",
              quality: request.quality === "high" || request.quality === "medium" || request.quality === "low"
                ? request.quality
                : "auto",
              ...(isBase64Model ? {} : { response_format: "b64_json" as const }),
            });
          })()
        : await client.images.generate({
            model,
            prompt: request.prompt,
            n: 1,
            size: size as "1024x1024" | "1536x1024" | "1024x1536" | "1792x1024" | "1024x1792",
            response_format: isBase64Model ? "b64_json" : "url",
          });

      let imgBuffer: Buffer;
      let imageUrl = response.data?.[0]?.url;

      if (isBase64Model && response.data?.[0]?.b64_json) {
        imgBuffer = Buffer.from(response.data[0].b64_json, "base64");
      } else if (imageUrl) {
        const imgResponse = await fetch(imageUrl);
        if (!imgResponse.ok) {
          return {
            success: false,
            provider: "openai",
            model,
            prompt: request.prompt,
            aspectRatio: request.aspectRatio,
            errorType: "download_error",
            error: `Failed to download generated image: HTTP ${imgResponse.status}`,
          };
        }
        imgBuffer = Buffer.from(await imgResponse.arrayBuffer());
      } else {
        return {
          success: false,
          provider: "openai",
          model,
          prompt: request.prompt,
          aspectRatio: request.aspectRatio,
          errorType: "provider_error",
          error: "OpenAI returned no image URL or base64 data.",
        };
      }

      const outputDir = path.resolve("data", "generated-images");
      fs.mkdirSync(outputDir, { recursive: true });
      const generatedId = `${Date.now()}-${crypto.randomUUID()}.png`;
      const outputPath = path.join(outputDir, generatedId);
      const outputPathError = validateWorkspacePath(outputPath);
      if (outputPathError) {
        return {
          success: false,
          provider: "openai",
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
        provider: "openai",
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
          provider: "openai",
          model,
          prompt: request.prompt,
          aspectRatio: request.aspectRatio,
          errorType: "missing_config",
          error: `OpenAI generation failed — authentication error: ${msg.slice(0, 300)}`,
        };
      }
      return {
        success: false,
        provider: "openai",
        model,
        prompt: request.prompt,
        aspectRatio: request.aspectRatio,
        errorType: "provider_error",
        error: `OpenAI generation failed: ${msg.slice(0, 500)}`,
      };
    }
  },
};
