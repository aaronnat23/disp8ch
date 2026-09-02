export type FailureCode =
  | "timeout"
  | "rate_limited"
  | "authentication"
  | "quota"
  | "context_overflow"
  | "conflict"
  | "not_found"
  | "permission"
  | "empty"
  | "blocked"
  | "unavailable"
  | "invalid_args"
  | "network"
  | "unknown";

export type FailureContract = {
  code: FailureCode;
  message: string;
  retryable: boolean;
  retryAfterMs: number | null;
  action: "retry" | "change_input" | "configure" | "ask_user" | "switch_approach" | "stop";
};

function parseRetryAfterMs(message: string): number | null {
  const match = message.match(/retry[- ]after[:= ]+(\d+(?:\.\d+)?)\s*(ms|s|seconds?)?/i);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  return match[2]?.toLowerCase() === "ms" ? Math.round(value) : Math.round(value * 1000);
}

export function classifyFailure(error: unknown): FailureContract {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  let code: FailureCode = "unknown";
  if (/429|rate.?limit|too many requests/.test(normalized)) code = "rate_limited";
  else if (/invalid api key|authentication|unauthorized|401/.test(normalized)) code = "authentication";
  else if (/quota|billing limit|insufficient credits/.test(normalized)) code = "quota";
  else if (/context (?:length|window)|maximum context|too many tokens|context_length_exceeded/.test(normalized)) code = "context_overflow";
  else if (/conflict|changed after it was loaded|409/.test(normalized)) code = "conflict";
  else if (/timed out|timeout|deadline|etimedout/.test(normalized)) code = "timeout";
  else if (/not found|no such file|enoent|does not exist|404/.test(normalized)) code = "not_found";
  else if (/permission|access denied|403/.test(normalized)) code = "permission";
  else if (/econnreset|ecanceled|network|socket hang up|temporarily unavailable/.test(normalized)) code = "network";
  else if (/\bempty(?: response| result)?\b|no results|0 results?/.test(normalized)) code = "empty";
  else if (/blocked|do not retry|stop|refused/.test(normalized)) code = "blocked";
  else if (/unavailable|not available|not installed|missing skill|unknown tool/.test(normalized)) code = "unavailable";
  else if (/invalid|argument|parameter|schema|type error/.test(normalized)) code = "invalid_args";

  const retryable = code === "timeout" || code === "rate_limited" || code === "network";
  const action: FailureContract["action"] = retryable
    ? "retry"
    : code === "invalid_args" || code === "context_overflow"
      ? "change_input"
      : code === "authentication" || code === "quota" || code === "unavailable"
        ? "configure"
        : code === "permission" || code === "conflict"
          ? "ask_user"
          : code === "blocked"
            ? "stop"
            : "switch_approach";
  return { code, message, retryable, retryAfterMs: parseRetryAfterMs(message), action };
}
