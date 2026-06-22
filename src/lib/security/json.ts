const BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function sanitizeStructuredJson<T>(value: T): T {
  return sanitizeValue(value, new WeakMap()) as T;
}

function sanitizeValue(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, seen));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  if (seen.has(value as object)) {
    return seen.get(value as object);
  }

  const output: Record<string, unknown> = {};
  seen.set(value as object, output);

  for (const [key, nextValue] of Object.entries(value as Record<string, unknown>)) {
    if (BLOCKED_KEYS.has(key)) continue;
    output[key] = sanitizeValue(nextValue, seen);
  }

  return output;
}
