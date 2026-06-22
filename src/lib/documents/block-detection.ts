export type BlockClassification =
  | "ok"
  | "http_error"
  | "rate_limited"
  | "captcha"
  | "cloudflare_challenge"
  | "access_denied"
  | "login_required"
  | "paywall"
  | "robots_denied"
  | "unsupported_content_type"
  | "empty_or_script_shell";

export type BlockDetectionResult = {
  classification: BlockClassification;
  confidence: "high" | "medium" | "low";
  reason: string;
  suggestedAction: "retry_with_delay" | "switch_to_static" | "try_dynamic" | "stop" | "retry_after" | "use_provider_if_configured";
  retryAfterSeconds?: number;
};

const CLOUDFLARE_PATTERNS = [
  /checking your browser/i,
  /please wait while we verify/i,
  /cloudflare/i,
  /cf-browser-verification/i,
  /cf-chl-/i,
  /__cf_chl_/i,
  /just a moment/i,
  /ddos protection/i,
];

const CAPTCHA_PATTERNS = [
  /captcha/i,
  /are you a robot/i,
  /not a robot/i,
  /prove you are human/i,
  /recaptcha/i,
  /hcaptcha/i,
  /turnstile/i,
  /g-recaptcha/i,
];

const ACCESS_DENIED_PATTERNS = [
  /access denied/i,
  /forbidden/i,
  /you do not have permission/i,
  /you don't have permission/i,
  /unauthorized/i,
  /not authorized/i,
];

const LOGIN_REQUIRED_PATTERNS = [
  /log\s*in/i,
  /sign\s*in/i,
  /please authenticate/i,
  /login required/i,
  /authentication required/i,
];

const PAYWALL_PATTERNS = [
  /subscribe to continue/i,
  /premium content/i,
  /this article is reserved/i,
  /paywall/i,
  /metered paywall/i,
  /you have reached your free/i,
  /upgrade to read/i,
];

const SCRIPT_SHELL_PATTERNS = [
  /id="__next"/i,
  /id="__nuxt"/i,
  /id="app"/i,
  /id="root"/i,
  /window\.__/i,
  /enable javascript/i,
  /enable js/i,
];

function testPatterns(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

function extractRetryAfter(headers: Record<string, string> | null): number | undefined {
  const raw = headers?.["retry-after"] ?? headers?.["Retry-After"];
  if (!raw) return undefined;
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) return Math.min(numeric, 300);
  return undefined;
}

export function detectBlock(
  params: {
    status?: number;
    headers?: Record<string, string> | null;
    body?: string;
    contentType?: string;
    robotsDenied?: boolean;
  },
): BlockDetectionResult {
  const status = params.status ?? 0;
  const body = params.body ?? "";
  const lowerBody = body.toLowerCase();
  const headers = params.headers ?? null;

  if (params.robotsDenied) {
    return {
      classification: "robots_denied",
      confidence: "high",
      reason: "robots.txt disallows this path",
      suggestedAction: "stop",
    };
  }

  if (status === 429) {
    const retryAfter = extractRetryAfter(headers);
    return {
      classification: "rate_limited",
      confidence: "high",
      reason: `HTTP 429 Too Many Requests${retryAfter ? `; Retry-After: ${retryAfter}s` : ""}`,
      suggestedAction: retryAfter ? "retry_after" : "retry_with_delay",
      retryAfterSeconds: retryAfter,
    };
  }

  if (status === 503) {
    const retryAfter = extractRetryAfter(headers);
    return {
      classification: "rate_limited",
      confidence: "high",
      reason: `HTTP 503 Service Unavailable${retryAfter ? `; Retry-After: ${retryAfter}s` : ""}`,
      suggestedAction: retryAfter ? "retry_after" : "retry_with_delay",
      retryAfterSeconds: retryAfter,
    };
  }

  if (status === 403) {
    if (testPatterns(lowerBody, ACCESS_DENIED_PATTERNS)) {
      return {
        classification: "access_denied",
        confidence: "high",
        reason: "HTTP 403 with access-denied message",
        suggestedAction: "stop",
      };
    }
    return {
      classification: "access_denied",
      confidence: "medium",
      reason: "HTTP 403 Forbidden",
      suggestedAction: "stop",
    };
  }

  if (status === 401) {
    return {
      classification: "login_required",
      confidence: "high",
      reason: "HTTP 401 Unauthorized",
      suggestedAction: "stop",
    };
  }

  if (status >= 400 && status < 500) {
    return {
      classification: "http_error",
      confidence: "high",
      reason: `HTTP ${status}`,
      suggestedAction: "stop",
    };
  }

  if (status >= 500) {
    return {
      classification: "http_error",
      confidence: "medium",
      reason: `HTTP ${status} Server Error`,
      suggestedAction: "retry_with_delay",
    };
  }

  if (lowerBody.length < 30 && status === 200) {
    return {
      classification: "empty_or_script_shell",
      confidence: "medium",
      reason: "Response body is nearly empty",
      suggestedAction: "try_dynamic",
    };
  }

  if (testPatterns(lowerBody, CLOUDFLARE_PATTERNS)) {
    return {
      classification: "cloudflare_challenge",
      confidence: "high",
      reason: "Cloudflare challenge page detected",
      suggestedAction: "try_dynamic",
    };
  }

  if (testPatterns(lowerBody, CAPTCHA_PATTERNS)) {
    return {
      classification: "captcha",
      confidence: "high",
      reason: "CAPTCHA page detected",
      suggestedAction: "stop",
    };
  }

  if (testPatterns(lowerBody, PAYWALL_PATTERNS)) {
    return {
      classification: "paywall",
      confidence: "high",
      reason: "Paywall content detected",
      suggestedAction: "stop",
    };
  }

  if (testPatterns(lowerBody, LOGIN_REQUIRED_PATTERNS)) {
    return {
      classification: "login_required",
      confidence: "high",
      reason: "Login required message detected",
      suggestedAction: "stop",
    };
  }

  if (testPatterns(lowerBody, ACCESS_DENIED_PATTERNS)) {
    return {
      classification: "access_denied",
      confidence: "medium",
      reason: "Access denied message in response body",
      suggestedAction: "stop",
    };
  }

  const scriptCount = (body.match(/<script\b/gi) || []).length;
  const textLen = body.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().length;
  if (testPatterns(lowerBody, SCRIPT_SHELL_PATTERNS) && textLen < 300) {
    return {
      classification: "empty_or_script_shell",
      confidence: "medium",
      reason: "JavaScript shell detected; page likely requires dynamic rendering",
      suggestedAction: "try_dynamic",
    };
  }

  if (params.contentType && !/text\/html|application\/xhtml|text\/plain|application\/json|application\/xml/i.test(params.contentType)) {
    return {
      classification: "unsupported_content_type",
      confidence: "medium",
      reason: `Unsupported content type: ${params.contentType}`,
      suggestedAction: "stop",
    };
  }

  return {
    classification: "ok",
    confidence: "high",
    reason: "No blocking pattern detected",
    suggestedAction: "stop",
  };
}
