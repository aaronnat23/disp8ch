import { Parser } from "expr-eval";

const parser = new Parser();

export function evaluateCondition(
  expression: string,
  variables: Record<string, unknown>
): boolean {
  try {
    return Boolean(evaluateExpressionValue(expression, variables));
  } catch {
    return false;
  }
}

export function parseExpressionSafe(expression: string): { ok: boolean; error?: string } {
  try {
    const expr = parser.parse(expression);
    // Parser.parse succeeds even with some issues; try an evaluation to catch runtime errors
    expr.evaluate({});
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export function evaluateExpressionValue(
  expression: string,
  variables: Record<string, unknown>
): unknown {
  // Support both legacy flattened keys (foo_bar) and object access (foo.bar).
  const flatVars = flattenObject(variables);
  const exprVars = {
    ...flatVars,
    ...variables,
  };
  const expr = parser.parse(expression);
  return expr.evaluate(exprVars as Parameters<typeof expr.evaluate>[0]);
}

export function resolveTemplate(
  template: string,
  context: { get: (path: string) => unknown }
): string {
  return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_, path: string) => {
    const value = context.get(path);
    if (value === null || value === undefined) return "";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  });
}

function flattenObject(
  obj: Record<string, unknown>,
  prefix = ""
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}_${key}` : key;

    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(result, flattenObject(value as Record<string, unknown>, fullKey));
    } else {
      result[fullKey] = value;
    }
  }

  return result;
}
