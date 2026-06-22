import { NextRequest, NextResponse } from "next/server";
import { evaluateExpressionValue, resolveTemplate } from "@/lib/engine/expressions";
import { requireOperatorAccess } from "@/lib/security/admin";
import { sanitizeStructuredJson } from "@/lib/security/json";

export const dynamic = "force-dynamic";

const FORBIDDEN = /\b(?:process|require|globalThis|constructor|prototype|Function|eval|import)\b/;

function getPath(source: unknown, path: string): unknown {
  const parts = path.split(".").filter(Boolean);
  let current = source as any;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = current[part];
  }
  return current;
}

export async function POST(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const expression = String(body.expression || "").trim();
    if (!expression) return NextResponse.json({ success: false, error: "expression is required" }, { status: 400 });
    if (FORBIDDEN.test(expression)) {
      return NextResponse.json({ success: false, error: "Expression contains a blocked runtime token" }, { status: 400 });
    }
    const data = sanitizeStructuredJson(
      body.data && typeof body.data === "object" && !Array.isArray(body.data)
        ? body.data as Record<string, unknown>
        : {},
    ) as Record<string, unknown>;
    const mode = String(body.mode || (expression.includes("{{") ? "template" : "expression"));
    const value = mode === "template"
      ? resolveTemplate(expression, { get: (path) => getPath(data, path) })
      : evaluateExpressionValue(expression.replace(/^\{\{|\}\}$/g, "").trim(), data);
    return NextResponse.json({ success: true, data: { value, preview: typeof value === "string" ? value : JSON.stringify(value, null, 2) } });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

