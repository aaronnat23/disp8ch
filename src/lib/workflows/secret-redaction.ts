/**
 * Secret redaction for workflow trace previews, exports, and final answers.
 *
 * Workflow JSON should only ever store credential *references* (e.g.
 * `secret:my-token`), never raw secrets. As defence in depth, this utility
 * scrubs secret-like values from any object before it is shown to a user,
 * exported, or echoed back into a chat response — even if a raw secret slipped
 * into node config or trace output.
 */

const REDACTED = "[redacted]";

/** Config keys whose values are always secrets and must be fully redacted. */
const SECRET_KEY_PATTERN =
  /(?:^|[._-])(?:api[_-]?key|apikey|secret|secretvalue|password|passwd|pwd|token|auth[_-]?token|access[_-]?token|refresh[_-]?token|bearer|authorization|client[_-]?secret|private[_-]?key|signing[_-]?secret|webhook[_-]?secret|session[_-]?token|credential[_-]?value)(?:$|[._-])/i;

/** Keys that are safe references even though they contain "secret"/"token". */
const ALLOWED_REFERENCE_KEY = /(?:secretref|credentialref|credentialid|tokenname|secretname|maskedsecretref)$/i;

/** Value shapes that look like raw secrets regardless of their key. */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9]{16,}\b/, // OpenAI-style keys
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, // Slack tokens
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/, // GitHub tokens
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bBearer\s+[A-Za-z0-9._-]{20,}\b/i, // bearer headers
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, // JWTs
];

function isSecretReference(value: string): boolean {
  return /^secret:/i.test(value) || /^inline:masked$/i.test(value) || /^\{\{.*\}\}$/.test(value.trim());
}

function redactStringValue(value: string): string {
  if (isSecretReference(value)) return value;
  let next = value;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    next = next.replace(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g"), REDACTED);
  }
  return next;
}

/**
 * Returns true when `key` denotes a secret field whose value must be removed.
 */
export function isSecretKey(key: string): boolean {
  if (ALLOWED_REFERENCE_KEY.test(key)) return false;
  return SECRET_KEY_PATTERN.test(key);
}

/**
 * Recursively redact secret-like values from any JSON-serialisable value.
 * - Values under secret-like keys are replaced with `[redacted]`.
 * - String values that match known secret shapes are scrubbed in place.
 * - Credential references (`secret:...`, `inline:masked`, `{{...}}`) are kept.
 */
export function redactSecretsDeep<T>(value: T, depth = 0): T {
  if (depth > 12) return value;
  if (typeof value === "string") {
    return redactStringValue(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSecretsDeep(item, depth + 1)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      if (isSecretKey(key)) {
        // Preserve credential references; redact anything else.
        if (typeof raw === "string" && isSecretReference(raw)) {
          out[key] = raw;
        } else {
          out[key] = REDACTED;
        }
        continue;
      }
      out[key] = redactSecretsDeep(raw, depth + 1);
    }
    return out as unknown as T;
  }
  return value;
}

/** Convenience: redact a workflow export object (nodes/edges/config). */
export function redactWorkflowExport<T>(exportData: T): T {
  return redactSecretsDeep(exportData);
}
