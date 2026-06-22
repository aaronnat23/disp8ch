import { NextRequest, NextResponse } from "next/server";
import { requireOperatorAccess } from "@/lib/security/admin";
import { z } from "zod";
import { createResearchDepartment } from "@/lib/research-department/setup";
import { getDepartmentDetail, listDepartments } from "@/lib/research-department/store";
import type { CreateResearchDepartmentInput } from "@/lib/research-department/types";

export const dynamic = "force-dynamic";

const sourceSchema = z.object({
  keywords: z.array(z.string()).default([]),
  rssFeeds: z.array(z.string()).default([]),
  arxivCategories: z.array(z.string()).default([]),
  competitorUrls: z.array(z.string()).default([]),
});

const createSchema = z.object({
  name: z.string().min(1).max(120),
  tier: z.enum(["basic", "standard", "advanced"]),
  focusArea: z.string().min(1).max(500),
  sources: sourceSchema.default({ keywords: [], rssFeeds: [], arxivCategories: [], competitorUrls: [] }),
  delivery: z
    .object({
      channel: z.enum(["webchat", "telegram", "slack", "discord"]).default("webchat"),
      channelId: z.string().nullable().optional(),
    })
    .optional(),
  models: z
    .object({
      scout: z.string().nullable().optional(),
      analyst: z.string().nullable().optional(),
      briefer: z.string().nullable().optional(),
    })
    .optional(),
  safety: z
    .object({
      perRunTokenCap: z.number().optional(),
      maxSourcesPerRun: z.number().optional(),
      noDelete: z.boolean().optional(),
      analystMcpServer: z.string().nullable().optional(),
    })
    .optional(),
  vaultRoot: z.string().optional(),
  allowCustomVaultPath: z.boolean().optional(),
  inactive: z.boolean().optional(),
});

export async function GET(request: NextRequest) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;
  try {
    const departments = listDepartments().map((d) => getDepartmentDetail(d.id) ?? d);
    return NextResponse.json({ success: true, data: departments });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;
  try {
    const body = await request.json();
    const parsed = createSchema.parse(body);
    const result = createResearchDepartment(parsed as CreateResearchDepartmentInput);
    const detail = getDepartmentDetail(result.departmentId);
    return NextResponse.json({ success: true, data: { ...result, detail } });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ success: false, error: "Invalid input", issues: error.issues }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: String(error) }, { status: 400 });
  }
}
