import { getSqlite } from "@/lib/db";
import { resolveSecretValue } from "@/lib/secrets/store";

type ImageGenerationConfig = {
  configured: boolean;
  configuredReference: string | null;
  missingReason: string;
  availableProviders: string[];
  activeProvider: string | null;
};

export function isImageGenerationPrompt(message: string): boolean {
  return /\b(?:generate|create|make|render)\b[\s\S]{0,120}\b(?:image|picture|portrait|mockup|hero|visual)\b/i.test(message) ||
    /\b(?:image|portrait)\s+generation\b/i.test(message);
}

export async function resolveImageGenerationConfig(): Promise<ImageGenerationConfig> {
  try {
    const { getImageGenerationConfigStatus } = await import("@/lib/image-gen/registry");
    const status = await getImageGenerationConfigStatus();
    const configured = status.configured;
    const availableProviders = status.availableProviders;
    const activeProvider = status.activeProvider;

    let configuredReference: string | null = null;
    let missingReason = "";
    try {
      const row = getSqlite()
        .prepare("SELECT image_generation_api_key, image_generation_provider FROM app_config WHERE id = 'default'")
        .get() as { image_generation_api_key?: string | null; image_generation_provider?: string | null } | undefined;
      const raw = String(row?.image_generation_api_key ?? "").trim();
      if (raw) configuredReference = raw.startsWith("secret:") ? raw : "direct key";
      const provider = String(row?.image_generation_provider ?? "").trim();
      if (configured && provider) {
        configuredReference = `provider=${provider}, key configured`;
      }
      if (!configured) {
        missingReason = configuredReference
          ? `configured key (${configuredReference}) is not available for any provider`
          : "no image generation provider is configured with a working API key";
      }
    } catch {
      missingReason = "image_generation_api_key could not be read from app_config";
    }

    return { configured, configuredReference, missingReason, availableProviders, activeProvider };
  } catch {
    return {
      configured: false,
      configuredReference: null,
      missingReason: "image_generation_api_key could not be read from app_config",
      availableProviders: [],
      activeProvider: null,
    };
  }
}

// Synchronous fallback for deterministic preflights where async import is not possible
export function resolveImageGenerationConfigSync(): ImageGenerationConfig {
  let configuredReference: string | null = null;
  try {
    const row = getSqlite()
      .prepare("SELECT image_generation_api_key FROM app_config WHERE id = 'default'")
      .get() as { image_generation_api_key?: string | null } | undefined;
    const raw = String(row?.image_generation_api_key ?? "").trim();
    if (raw) configuredReference = raw.startsWith("secret:") ? raw : "direct key";
    if (raw.startsWith("secret:")) {
      const secretName = raw.slice(7).trim().toUpperCase();
      const resolved = resolveSecretValue(secretName);
      return {
        configured: Boolean(resolved),
        configuredReference: raw,
        missingReason: resolved ? "" : `configured secret ${raw} is missing or empty`,
        availableProviders: resolved ? ["fal"] : [],
        activeProvider: resolved ? "fal" : null,
      };
    }
    return {
      configured: Boolean(raw),
      configuredReference,
      missingReason: raw ? "" : "no FAL API key is configured",
      availableProviders: raw ? ["fal"] : [],
      activeProvider: raw ? "fal" : null,
    };
  } catch {
    return {
      configured: false,
      configuredReference,
      missingReason: "image_generation_api_key could not be read from app_config",
      availableProviders: [],
      activeProvider: null,
    };
  }
}

export function buildImageGenerationUnavailableResponse(message: string): string {
  const config = resolveImageGenerationConfigSync();
  const requestedShape = /\bportrait\b/i.test(message)
    ? "portrait"
    : /\bsquare\b/i.test(message)
      ? "square"
      : /\blandscape\b/i.test(message)
        ? "landscape"
        : "default";

  let localFallback = false;
  try {
    const { isLocalRenderEligible } = require("@/lib/image-gen/local-artifact-renderer") as {
      isLocalRenderEligible: (p: string) => boolean;
    };
    localFallback = isLocalRenderEligible(message);
  } catch {
    localFallback = false;
  }

  if (config.configured) {
    return [
      "Image generation is configured but the current request could not be completed with the available providers.",
      "",
      "## Configuration",
      `- Active provider: ${config.activeProvider ?? "unknown"}.`,
      `- Key reference: ${config.configuredReference ?? "present"}.`,
      `- Available providers: ${config.availableProviders.join(", ") || "none"}.`,
      "",
      "## Requested",
      `- Shape: ${requestedShape}.`,
      `- Prompt: ${message.slice(0, 200)}...`,
      "",
      "No paid image-generation request was run.",
    ].join("\n");
  }

  const providerTable = [
    "| Provider | Required env/secret | Where to set it |",
    "| --- | --- | --- |",
    "| FAL (default) | `FAL_API_KEY` | Settings > Secrets, or env var |",
    "| OpenAI | `OPENAI_API_KEY` | Settings > Secrets, or env var |",
    "| xAI | `XAI_API_KEY` | Settings > Secrets, or env var |",
  ].join("\n");

  const workaroundSection = [
    "## Workaround — Browser Fallback (No API Key Needed)",
    "",
    "I can produce a hero/mockup image right now using the browser rendering path:",
    "1. I draft an HTML+CSS page styled for the requested " + requestedShape + ".",
    "2. Open it with the browser tool and screenshot the rendered page.",
    "3. Save to `data/generated-images/` and link it as `/api/generated-images?id=...`.",
    "",
    "This produces a real PNG artifact without any paid API. Reply **yes, use the browser fallback** and I'll run it.",
  ].join("\n");

  const localFallbackNote = localFallback
    ? "\n\n**Local renderer:** eligible. Diagrams, mockups, and simple visuals can also be rendered as SVG-to-PNG locally."
    : "";

  return [
    "## Image Generation Is Not Configured",
    "",
    "The `image_generate` tool isn't available because no provider is configured.",
    "",
    providerTable,
    "",
    "To enable: Settings > General > Image Generation > pick provider > save API key.",
    "Then send a new prompt to pick up the change.",
    localFallbackNote,
    "",
    workaroundSection,
    "",
    "No paid image-generation request was run.",
  ].join("\n");
}

export function imageGenerationArgsForPrompt(message: string): Record<string, unknown> {
  const prompt = message
    .replace(/\buse the built-in image generation capability if available\b/ig, "")
    .replace(/\bthen show the generated image or a directly usable artifact link\b/ig, "")
    .trim();
  if (/\bportrait\b/i.test(message)) {
    return { prompt, aspect_ratio: "portrait" };
  }
  if (/\blandscape\b/i.test(message)) {
    return { prompt, aspect_ratio: "landscape" };
  }
  return { prompt, aspect_ratio: "square" };
}

export function isYoutubeTranscriptPrompt(message: string): boolean {
  return /(?:youtube\.com\/watch\?v=|youtu\.be\/)[\w-]+/i.test(message) &&
    /\b(?:transcript|caption|captions)\b/i.test(message);
}

export function buildYoutubeTranscriptUnavailableResponse(message: string): string {
  const idMatch = message.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]+)/i);
  const videoId = idMatch?.[1] ?? "unknown";
  const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;

  const workarounds = [
    "## Workarounds (pick one)",
    "",
    "1. Paste the transcript text directly and I'll summarize with the requested timestamps.",
    "2. Run `yt-dlp --write-auto-sub --skip-download <URL>` locally and share the .vtt file.",
    "3. Use an external service: youtubetotranscript.com or notegpt.io can extract auto-captions for English videos.",
  ].join("\n");

  const refusalExplanation = [
    "## Why I won't summarize from title/metadata",
    "",
    "The prompt required transcript-grounded timestamps. Title and channel metadata",
    "do not carry the time/content alignment needed to produce honest timestamped",
    "bullets, so I'm refusing instead of inventing them.",
  ].join("\n");

  return [
    `## Transcript Not Available`,
    "",
    `Video: \`${videoId}\` (${youtubeUrl})`,
    "",
    "No transcript segments were verified for this request. Runtime attempt details, when available, are reported separately from the actual strategy results.",
    "",
    workarounds,
    "",
    refusalExplanation,
    "",
    "Captions worked: no. Transcript retrieval worked: no.",

  ].join("\n");
}

export function isImageFallbackConfirm(message: string): boolean {
  return /^(?:yes|yeah|sure|go ahead|do it|run it|use the browser fallback|use browser|browser fallback)\b/i.test(message.trim());
}

export function isCapabilityAuditPrompt(message: string): boolean {
  const m = message.toLowerCase().trim();

  // Imperative "do X" requests are NOT audits — let them hit the feature/fallback path.
  // This prevents "generate an image of..." from being caught as a capability audit.
  if (/^\s*(generate|create|make|draw|render|produce|send|post|build|write|draft|summarize|transcribe)\b/.test(m)) {
    return false;
  }

  // Media-generation requests are feature requests, not audits — even when phrased
  // "try to generate X" or "generate X; if not configured, explain ...". A generation
  // verb anywhere + a media noun means: route to the image/feature path, not the audit.
  if (/\b(?:generate|create|make|draw|render|produce|design)\b[\s\S]{0,60}\b(?:image|icon|picture|photo|banner|logo|mockup|hero|illustration|artwork|portrait|graphic|visual|wallpaper|avatar|sticker|thumbnail)\b/i.test(m)) {
    return false;
  }

  // Structural detection: "can/does/is this app..." or "implemented/configured/planned" + capability noun
  const auditFraming = /\b(?:can|does|is|are|able\s+to|which|what|list|do\s+you\s+(?:have|support))\b[\s\S]{0,40}\b(?:this\s+app|disp8ch|you|it)\b/i.test(m)
    || /\b(?:implemented|configured|available|supported|planned|capabilit)\b/i.test(m);
  const hasCapabilityNoun = /\b(?:slack|voice|stt|tts|image\s+generat|local\s+model|video|youtube|transcript|memory|webhook|oauth|email|sms|send[-_])\b/i.test(m);

  // Original specific pattern for capability-status audits.
  const isSpecificAudit = /\b(?:currently\s+available|available\s+in\s+this\s+app|configured|implemented|merely\s+planned|planned\s+capabilit|capability\/runtime|capabilit(?:y|ies)\s+audit|distinguish\s+implemented)/i.test(m) &&
    /\b(?:image\s+generation|local\s+model|local\s+video|video\s+analysis|youtube|transcript|memory|session\s*recall|benchmark|tool|capabilit)/i.test(m);

  return isSpecificAudit || (auditFraming && hasCapabilityNoun);
}

function activeModelSummary(): string {
  try {
    const rows = getSqlite()
      .prepare("SELECT provider, model_id, base_url, is_active FROM models WHERE is_active = 1 ORDER BY priority DESC, created_at DESC LIMIT 5")
      .all() as Array<{ provider?: string | null; model_id?: string | null; base_url?: string | null; is_active?: number | null }>;
    if (rows.length === 0) return "no active model rows found";
    return rows
      .map((row) => {
        const base = row.base_url ? `, baseUrl=${row.base_url}` : "";
        return `${row.provider || "unknown"}/${row.model_id || "unknown"}${base}`;
      })
      .join("; ");
  } catch {
    return "model table could not be read";
  }
}

export function buildCapabilityAuditResponse(message = ""): string {
  const imageConfig = resolveImageGenerationConfigSync();
  const models = activeModelSummary();

  return [
    "## Capability Audit Recovery",
    "The model-led, query-specific capability audit did not complete. This recovery reports direct configuration signals only and does not fabricate implementation or availability verdicts for the requested capabilities.",
    "",
    `Request: ${String(message || "").trim().slice(0, 500) || "(not provided)"}`,
    "",
    "## Direct Configuration Signals",
    `- Active model rows: ${models}.`,
    `- Image generation provider: ${imageConfig.configured ? `configured (${imageConfig.activeProvider ?? "provider unknown"})` : `not configured (${imageConfig.missingReason})`}.`,
    "",
    "## Evidence Limits",
    "- No code-level capability verdict is asserted because the requested implementation files were not successfully inspected and synthesized.",
    "- Retry with an active model/provider. The query-specific audit must search and read the relevant registry, route, provider, and runtime files before answering.",
    "- No paid action, model download, state clear, or file edit was performed.",
  ].join("\n");
}
