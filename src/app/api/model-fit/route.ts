import { NextResponse } from "next/server";
import { requireOperatorAccess } from "@/lib/security/admin";
import { recommendLocalModelsV2, type ModelTask, type Preference } from "@/lib/model-fit/recommend-v2";

export const dynamic = "force-dynamic";

const TASKS: ModelTask[] = ["coding", "chat", "reasoning", "vision", "general"];
const PREFS: Preference[] = ["quality", "balanced", "speed"];

export async function GET(request: Request) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;
  try {
    const { searchParams } = new URL(request.url);
    const taskRaw = (searchParams.get("task") || "general").toLowerCase();
    const task = (TASKS.includes(taskRaw as ModelTask) ? taskRaw : "general") as ModelTask;
    const prefRaw = (searchParams.get("preference") || "balanced").toLowerCase();
    const preference = (PREFS.includes(prefRaw as Preference) ? prefRaw : "balanced") as Preference;
    const contextTokens = Math.min(262144, Math.max(512, Number(searchParams.get("context")) || 8192));
    const result = await recommendLocalModelsV2({
      task,
      preference,
      contextTokens,
      visionRequired: searchParams.get("vision") === "1",
      toolsRequired: searchParams.get("tools") === "1",
    });
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
