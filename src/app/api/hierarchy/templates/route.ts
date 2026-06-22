import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  applyCompanyTemplate,
  listCompanyTemplates,
} from "@/lib/hierarchy/company-templates";
import { requireOperatorAccess } from "@/lib/security/admin";

export const dynamic = "force-dynamic";

const ApplyTemplateSchema = z.object({
  templateId: z.string().min(1).max(120),
  organizationName: z.string().max(160).optional().nullable(),
  activate: z.boolean().optional(),
});

export async function GET(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    return NextResponse.json({ success: true, data: listCompanyTemplates() });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const body = await request.json();
    const parsed = ApplyTemplateSchema.parse(body);
    const applied = applyCompanyTemplate(parsed);
    return NextResponse.json({ success: true, data: applied }, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
