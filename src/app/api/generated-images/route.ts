import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { requireOperatorAccess } from "@/lib/security/admin";

export const dynamic = "force-dynamic";

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

export async function GET(request: NextRequest) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;

  const id = new URL(request.url).searchParams.get("id") || "";
  const basename = path.basename(id);
  if (!basename || basename !== id || !/\.(?:png|jpe?g|webp)$/i.test(basename)) {
    return NextResponse.json({ success: false, error: "Invalid generated image id" }, { status: 400 });
  }

  const root = path.resolve(process.cwd(), "data", "generated-images");
  const filePath = path.resolve(root, basename);
  if (filePath !== root && !filePath.startsWith(root + path.sep)) {
    return NextResponse.json({ success: false, error: "Invalid generated image path" }, { status: 400 });
  }
  if (!fs.existsSync(filePath)) {
    return NextResponse.json({ success: false, error: "Generated image not found" }, { status: 404 });
  }

  const ext = path.extname(filePath).toLowerCase();
  return new NextResponse(fs.readFileSync(filePath), {
    headers: {
      "content-type": MIME_BY_EXT[ext] ?? "application/octet-stream",
      "cache-control": "private, max-age=3600",
    },
  });
}

