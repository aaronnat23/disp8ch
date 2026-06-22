import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { requireOperatorAccess } from "@/lib/security/admin";

export const dynamic = "force-dynamic";

const MIME_BY_EXT: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
};

export async function GET(request: NextRequest) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;

  const id = new URL(request.url).searchParams.get("id") || "";
  if (!id) {
    return NextResponse.json({ success: false, error: "Missing generated video id" }, { status: 400 });
  }

  // Only allow a safe relative sub-path (e.g. "jobId/final/final.mp4") — no traversal
  const normalized = path.normalize(id).replace(/^(\.\.(\/|\\|$))+/, "");
  if (!normalized || normalized !== id.replace(/\\/g, "/")) {
    return NextResponse.json({ success: false, error: "Invalid generated video path" }, { status: 400 });
  }
  if (!/\.(?:mp4|webm|mov)$/i.test(normalized)) {
    return NextResponse.json({ success: false, error: "Unsupported video format" }, { status: 400 });
  }

  const root = path.resolve(process.cwd(), "data", "generated-videos");
  const filePath = path.resolve(root, normalized);
  if (!filePath.startsWith(root + path.sep) && filePath !== root) {
    return NextResponse.json({ success: false, error: "Invalid generated video path" }, { status: 400 });
  }
  if (!fs.existsSync(filePath)) {
    return NextResponse.json({ success: false, error: "Generated video not found" }, { status: 404 });
  }

  const ext = path.extname(filePath).toLowerCase();
  const stat = fs.statSync(filePath);
  return new NextResponse(fs.readFileSync(filePath), {
    headers: {
      "content-type": MIME_BY_EXT[ext] ?? "video/mp4",
      "content-length": String(stat.size),
      "cache-control": "private, max-age=3600",
      "accept-ranges": "bytes",
    },
  });
}
