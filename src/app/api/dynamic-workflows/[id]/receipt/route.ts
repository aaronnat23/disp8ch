import { NextRequest, NextResponse } from "next/server";
import { requireOperatorAccess } from "@/lib/security/admin";
import { buildDynamicWorkflowReceipt, receiptToMarkdown } from "@/lib/dynamic-workflows/receipt";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;
  try {
    const receipt = buildDynamicWorkflowReceipt(params.id);
    if (new URL(request.url).searchParams.get("format") === "markdown") {
      return new NextResponse(receiptToMarkdown(receipt), {
        headers: {
          "Content-Type": "text/markdown; charset=utf-8",
          "Content-Disposition": `attachment; filename="run-${params.id}-receipt.md"`,
        },
      });
    }
    return NextResponse.json({ success: true, data: receipt });
  } catch (error) {
    const status = String(error).includes("not found") ? 404 : 500;
    return NextResponse.json({ success: false, error: String(error) }, { status });
  }
}
