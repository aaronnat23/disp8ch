import { normalizeProviderId } from "@/lib/agents/provider-normalization";

const LOCAL_TIMEOUT_DEFAULT_MS = 900_000;
const CLOUD_TIMEOUT_DEFAULT_MS = 90_000;

const LOCAL_OR_SELF_HOSTED_PROVIDERS = new Set([
  "openai-compatible",
  "ollama",
  "vllm",
  "sglang",
  "lmstudio",
]);

function readPositiveEnv(names: string[]): number | null {
  for (const name of names) {
    const raw = process.env[name];
    if (!raw) continue;
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function isLocalOrPrivateHost(baseUrl?: string): boolean {
  if (!baseUrl) return false;
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "0.0.0.0" ||
      hostname === "::1" ||
      hostname === "host.docker.internal" ||
      hostname.startsWith("10.") ||
      hostname.startsWith("192.168.") ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)
    );
  } catch {
    return false;
  }
}

export function resolveOpenAIRequestTimeoutMs(params: {
  provider: string;
  baseUrl?: string;
}): number {
  const globalOverride = readPositiveEnv(["OPENAI_REQUEST_TIMEOUT_MS"]);
  if (globalOverride) return globalOverride;

  const provider = normalizeProviderId(params.provider) ?? params.provider.trim().toLowerCase();
  const localish = LOCAL_OR_SELF_HOSTED_PROVIDERS.has(provider) || isLocalOrPrivateHost(params.baseUrl);
  if (localish) {
    return readPositiveEnv([
      "LOCAL_OPENAI_COMPATIBLE_TIMEOUT_MS",
      "LOCAL_MODEL_TIMEOUT_MS",
      "OPENAI_COMPATIBLE_TIMEOUT_MS",
    ]) ?? LOCAL_TIMEOUT_DEFAULT_MS;
  }

  return readPositiveEnv(["OPENAI_COMPATIBLE_TIMEOUT_MS"]) ?? CLOUD_TIMEOUT_DEFAULT_MS;
}
