function hostnameFor(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function resolveOpenAIFastServiceTier(params: {
  provider: string;
  baseUrl?: string;
  fastMode?: boolean;
}): "flex" | undefined {
  if (params.provider !== "openai" || params.fastMode !== true) {
    return undefined;
  }
  const hostname = hostnameFor(params.baseUrl);
  if (hostname && hostname !== "api.openai.com") {
    return undefined;
  }
  return "flex";
}

export function resolveAnthropicFastServiceTier(params: {
  provider: string;
  baseUrl?: string;
  fastMode?: boolean;
}): "auto" | undefined {
  if (params.provider !== "anthropic" || params.fastMode !== true) {
    return undefined;
  }
  const hostname = hostnameFor(params.baseUrl);
  if (hostname && hostname !== "api.anthropic.com") {
    return undefined;
  }
  return "auto";
}
