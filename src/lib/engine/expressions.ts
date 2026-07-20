import jsep from "jsep";

type ExpressionNode = {
  type: string;
  operator?: string;
  value?: unknown;
  name?: string;
  raw?: string;
  left?: ExpressionNode;
  right?: ExpressionNode;
  argument?: ExpressionNode;
  object?: ExpressionNode;
  property?: ExpressionNode;
  computed?: boolean;
  elements?: ExpressionNode[];
  test?: ExpressionNode;
  consequent?: ExpressionNode;
  alternate?: ExpressionNode;
};

const BLOCKED_PROPERTIES = new Set(["__proto__", "prototype", "constructor"]);

jsep.addBinaryOp("and", 2);
jsep.addBinaryOp("or", 1);
jsep.addBinaryOp("contains", 6);

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
    const parsed = parseExpression(expression);
    validateNode(parsed);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export function evaluateExpressionValue(
  expression: string,
  variables: Record<string, unknown>
): unknown {
  const parsed = parseExpression(expression);
  validateNode(parsed);
  return evaluateNode(parsed, {
    ...flattenObject(variables),
    ...variables,
  });
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

function parseExpression(expression: string): ExpressionNode {
  const input = String(expression || "").trim();
  if (!input) throw new Error("Expression is empty");
  if (input.length > 2000) throw new Error("Expression exceeds 2000 characters");
  return jsep(input) as ExpressionNode;
}

function validateNode(node: ExpressionNode, depth = 0): void {
  if (depth > 64) throw new Error("Expression is too deeply nested");

  switch (node.type) {
    case "Literal":
    case "Identifier":
      return;
    case "UnaryExpression":
      requireNode(node.argument, "unary argument");
      validateNode(node.argument, depth + 1);
      return;
    case "BinaryExpression":
    case "LogicalExpression":
      requireNode(node.left, "left operand");
      requireNode(node.right, "right operand");
      validateNode(node.left, depth + 1);
      validateNode(node.right, depth + 1);
      return;
    case "MemberExpression":
      requireNode(node.object, "member object");
      requireNode(node.property, "member property");
      validateNode(node.object, depth + 1);
      validateNode(node.property, depth + 1);
      return;
    case "ArrayExpression":
      for (const element of node.elements ?? []) validateNode(element, depth + 1);
      return;
    case "ConditionalExpression":
      requireNode(node.test, "conditional test");
      requireNode(node.consequent, "conditional consequent");
      requireNode(node.alternate, "conditional alternate");
      validateNode(node.test, depth + 1);
      validateNode(node.consequent, depth + 1);
      validateNode(node.alternate, depth + 1);
      return;
    default:
      throw new Error(`Unsupported expression construct: ${node.type}`);
  }
}

function evaluateNode(node: ExpressionNode, variables: Record<string, unknown>): unknown {
  switch (node.type) {
    case "Literal":
      return node.value;
    case "Identifier":
      return resolveIdentifier(node.name, variables);
    case "UnaryExpression":
      return evaluateUnary(node.operator, evaluateNode(required(node.argument), variables));
    case "BinaryExpression":
    case "LogicalExpression":
      return evaluateBinary(node, variables);
    case "MemberExpression":
      return evaluateMember(node, variables);
    case "ArrayExpression":
      return (node.elements ?? []).map((element) => evaluateNode(element, variables));
    case "ConditionalExpression":
      return evaluateNode(
        Boolean(evaluateNode(required(node.test), variables))
          ? required(node.consequent)
          : required(node.alternate),
        variables,
      );
    default:
      throw new Error(`Unsupported expression construct: ${node.type}`);
  }
}

function evaluateUnary(operator: string | undefined, value: unknown): unknown {
  switch (operator) {
    case "!": return !value;
    case "+": return +Number(value);
    case "-": return -Number(value);
    default: throw new Error(`Unsupported unary operator: ${operator || "unknown"}`);
  }
}

function evaluateBinary(node: ExpressionNode, variables: Record<string, unknown>): unknown {
  const operator = node.operator;
  const leftNode = required(node.left);
  const rightNode = required(node.right);
  const left = evaluateNode(leftNode, variables);

  if (operator === "and" || operator === "&&") {
    return left && evaluateNode(rightNode, variables);
  }
  if (operator === "or" || operator === "||") {
    return left || evaluateNode(rightNode, variables);
  }

  const right = evaluateNode(rightNode, variables);
  switch (operator) {
    case "==": return left == right; // Workflow conditions intentionally support coercive equality.
    case "!=": return left != right;
    case "===": return left === right;
    case "!==": return left !== right;
    case ">": return compare(left, right) > 0;
    case ">=": return compare(left, right) >= 0;
    case "<": return compare(left, right) < 0;
    case "<=": return compare(left, right) <= 0;
    case "+": return typeof left === "string" || typeof right === "string"
      ? String(left ?? "") + String(right ?? "")
      : Number(left) + Number(right);
    case "-": return Number(left) - Number(right);
    case "*": return Number(left) * Number(right);
    case "/": return Number(left) / Number(right);
    case "%": return Number(left) % Number(right);
    case "**": return Number(left) ** Number(right);
    case "contains": return contains(left, right);
    case "in": return contains(right, left);
    default: throw new Error(`Unsupported binary operator: ${operator || "unknown"}`);
  }
}

function evaluateMember(node: ExpressionNode, variables: Record<string, unknown>): unknown {
  const object = evaluateNode(required(node.object), variables);
  if (object === null || object === undefined) return undefined;

  const propertyValue = node.computed
    ? evaluateNode(required(node.property), variables)
    : required(node.property).name;
  const property = String(propertyValue ?? "");
  if (!property || BLOCKED_PROPERTIES.has(property)) {
    throw new Error(`Blocked property access: ${property || "empty"}`);
  }

  const boxed = Object(object) as Record<string, unknown>;
  return Object.prototype.hasOwnProperty.call(boxed, property) ? boxed[property] : undefined;
}

function resolveIdentifier(name: string | undefined, variables: Record<string, unknown>): unknown {
  if (!name) throw new Error("Identifier is missing a name");
  if (BLOCKED_PROPERTIES.has(name)) throw new Error(`Blocked identifier: ${name}`);
  if (name === "true") return true;
  if (name === "false") return false;
  if (name === "null") return null;
  return Object.prototype.hasOwnProperty.call(variables, name) ? variables[name] : undefined;
}

function compare(left: unknown, right: unknown): number {
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left ?? "").localeCompare(String(right ?? ""));
}

function contains(container: unknown, value: unknown): boolean {
  if (typeof container === "string") return container.includes(String(value ?? ""));
  if (Array.isArray(container)) return container.includes(value);
  if (container && typeof container === "object") {
    return Object.prototype.hasOwnProperty.call(container, String(value ?? ""));
  }
  return false;
}

function required(node: ExpressionNode | undefined): ExpressionNode {
  if (!node) throw new Error("Expression operand is missing");
  return node;
}

function requireNode(node: ExpressionNode | undefined, label: string): asserts node is ExpressionNode {
  if (!node) throw new Error(`Expression ${label} is missing`);
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
