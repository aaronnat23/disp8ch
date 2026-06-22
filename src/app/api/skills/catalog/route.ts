import { NextRequest, NextResponse } from "next/server";
import { requireOperatorAccess } from "@/lib/security/admin";
import { getSkillCatalogPreview, listSkillCatalog, type SkillCatalogSource } from "@/lib/skills/catalog";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;
  try {
    const { searchParams } = new URL(request.url);
    const name = searchParams.get("name");
    const sourceRaw = searchParams.get("source");
    const source = sourceRaw === "bundled" || sourceRaw === "optional" ? sourceRaw as SkillCatalogSource : undefined;
    if (name) {
      const preview = getSkillCatalogPreview(name, source);
      if (!preview) return NextResponse.json({ success: false, error: "Not found" }, { status: 404 });
      return NextResponse.json({ success: true, data: preview });
    }
    const query = searchParams.get("q") || undefined;
    return NextResponse.json({ success: true, data: listSkillCatalog({ query, source }) });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
