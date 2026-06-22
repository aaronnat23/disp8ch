export type ProviderErrorClass =
  | "rate_limit"
  | "quota_exhausted"
  | "auth_missing"
  | "auth_expired"
  | "unsupported_model"
  | "unsupported_model_for_tools"
  | "context_length_exceeded"
  | "schema_rejected"
  | "malformed_tool_call"
  | "server_timeout"
  | "server_unreachable"
  | "unknown";

export type ProviderErrorDiagnostic = {
  errorClass: ProviderErrorClass;
  retryable: boolean;
  message: string;
  setupHint?: string;
};

export function classifyProviderError(
  error: unknown,
  provider: string,
): ProviderErrorDiagnostic {
  const msg = String(
    (error instanceof Error ? error.message : "") ||
    (typeof error === "object" && error !== null ? JSON.stringify(error).slice(0, 400) : "") ||
    ""
  );
  const lower = msg.toLowerCase();

  // Rate limit
  if (
    lower.includes("rate limit") || lower.includes("ratelimit") ||
    lower.includes("too many requests") || lower.includes("429") ||
    lower.includes("resource_exhausted")
  ) {
    return {
      errorClass: "rate_limit",
      retryable: true,
      message: `Rate limit hit on ${provider}.`,
      setupHint: "Wait and retry, or reduce request frequency.",
    };
  }

  // Quota
  if (
    lower.includes("quota") || lower.includes("billing") ||
    lower.includes("free tier") || lower.includes("free tier") ||
    lower.includes("exceeded your current quota")
  ) {
    return {
      errorClass: "quota_exhausted",
      retryable: false,
      message: `Quota exhausted on ${provider}.`,
      setupHint: provider === "google"
        ? "Check your Google AI Studio billing tier. Free tier has daily limits."
        : "Check billing and quota limits for this provider.",
    };
  }

  // Auth
  if (
    lower.includes("api key") || lower.includes("apikey") ||
    lower.includes("unauthorized") || lower.includes("401") ||
    lower.includes("authentication") || lower.includes("invalid key") ||
    lower.includes("permission denied") || lower.includes("403")
  ) {
    const isExpired = lower.includes("expired") || lower.includes("revoked");
    return {
      errorClass: isExpired ? "auth_expired" : "auth_missing",
      retryable: false,
      message: `Authentication failed for ${provider}.`,
      setupHint: isExpired
        ? "Your API key appears to have expired or been revoked."
        : "Add a valid API key in Settings > Models, or set it as an encrypted secret.",
    };
  }

  // Unsupported model
  if (
    lower.includes("model") && (
      lower.includes("not found") || lower.includes("not available") ||
      lower.includes("not supported") || lower.includes("404") ||
      lower.includes("deprecated") || lower.includes("no longer")
    )
  ) {
    const forTools = lower.includes("tool") || lower.includes("function");
    return {
      errorClass: forTools ? "unsupported_model_for_tools" : "unsupported_model",
      retryable: false,
      message: `Model not supported on ${provider}.`,
      setupHint: forTools
        ? "This model does not support tool/function calling."
        : "This model is deprecated or unavailable.",
    };
  }

  // Context length
  if (
    lower.includes("context") || lower.includes("too long") ||
    lower.includes("maximum context") || lower.includes("token limit") ||
    lower.includes("reduce the length")
  ) {
    return {
      errorClass: "context_length_exceeded",
      retryable: false,
      message: `Context length exceeded on ${provider}.`,
      setupHint: "Reduce prompt size or use a model with larger context window.",
    };
  }

  // Schema
  if (
    lower.includes("schema") || lower.includes("invalid") &&
    (lower.includes("parameter") || lower.includes("tool") || lower.includes("function"))
  ) {
    return {
      errorClass: "schema_rejected",
      retryable: false,
      message: `Tool schema rejected by ${provider}.`,
      setupHint: "The tool parameter schema is incompatible with this provider.",
    };
  }

  // Timeout
  if (lower.includes("timeout") || lower.includes("timed out")) {
    return {
      errorClass: "server_timeout",
      retryable: true,
      message: `Request timed out on ${provider}.`,
      setupHint: "The model server may be overloaded or the prompt is too large.",
    };
  }

  // Unreachable
  if (
    lower.includes("econnrefused") || lower.includes("enotfound") ||
    lower.includes("unreachable") || lower.includes("connection refused") ||
    lower.includes("cannot connect")
  ) {
    return {
      errorClass: "server_unreachable",
      retryable: true,
      message: `Cannot reach ${provider} server.`,
      setupHint: "Check that the server is running and the base URL is correct.",
    };
  }

  return {
    errorClass: "unknown",
    retryable: false,
    message: `Provider error on ${provider}: ${msg.slice(0, 200)}`,
  };
}
