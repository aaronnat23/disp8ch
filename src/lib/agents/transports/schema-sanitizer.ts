const UNSUPPORTED_JSON_SCHEMA_KEYS = new Set([
  "$schema", "$comment", "$defs", "definitions",
  "default", "examples", "deprecated",
  "allOf", "anyOf", "oneOf", "not",
  "if", "then", "else",
  "patternProperties", "additionalProperties",
  "minProperties", "maxProperties",
  "uniqueItems", "contains",
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
  "multipleOf", "minLength", "maxLength", "pattern",
  "format", "contentEncoding", "contentMediaType",
  "dependentRequired", "dependentSchemas",
]);

function stripUnsupportedKeys(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(stripUnsupportedKeys);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (UNSUPPORTED_JSON_SCHEMA_KEYS.has(key)) continue;
    result[key] = stripUnsupportedKeys(value);
  }
  return result;
}

function toSnakeCase(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`).replace(/^_/, "");
}

export type SanitizeTarget = "openai" | "anthropic" | "gemini" | "openai-compatible";

export function sanitizeToolSchema(
  schema: Record<string, unknown>,
  target: SanitizeTarget,
): Record<string, unknown> {
  const sanitized = stripUnsupportedKeys(schema) as Record<string, unknown>;

  if (target === "anthropic") {
    return { ...sanitized, type: "object" as const };
  }

  if (target === "gemini") {
    const result: Record<string, unknown> = {};
    if (sanitized.type) result.type = toSnakeCase(String(sanitized.type).toUpperCase());
    if (sanitized.properties) {
      const props: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(sanitized.properties as Record<string, unknown> || {})) {
        const prop = value as Record<string, unknown>;
        const converted: Record<string, unknown> = {};
        if (prop.type) converted.type = toSnakeCase(String(prop.type).toUpperCase());
        if (prop.description) converted.description = prop.description;
        if (prop.enum) {
          if (Array.isArray(prop.enum) && prop.enum.every((e) => typeof e === "string")) {
            converted.enum = prop.enum;
          }
        }
        if (prop.nullable) converted.nullable = true;
        props[key] = converted;
      }
      result.properties = props;
    }
    if (Array.isArray(sanitized.required)) result.required = sanitized.required;
    return result;
  }

  if (target === "openai-compatible") {
    return sanitized;
  }

  return sanitized;
}
