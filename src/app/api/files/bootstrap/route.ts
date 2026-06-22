import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { getCached, API_TTL } from "@/lib/api-cache";
import { getWorkspaceDir } from "@/lib/workspace/files";
import { requireOperatorAccess } from "@/lib/security/admin";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = await requireOperatorAccess(request);
  if (denied) return denied;
  try {
    const data = await getCached("files-bootstrap", async () => {
      let workspacePath = "";
      try {
        workspacePath = getWorkspaceDir();
      } catch {
        workspacePath = path.resolve(process.env.WORKSPACE_PATH || "./data/workspace");
      }

      let workspace = {
        exists: false,
        path: workspacePath,
      };

      try {
        workspace.exists = fs.existsSync(workspacePath);
      } catch {
        /* workspace path may not be readable */
      }

      let rootFiles = { count: 0 };
      try {
        if (workspace.exists) {
          const entries = fs.readdirSync(workspacePath, { withFileTypes: true });
          rootFiles.count = entries.filter((e) => e.isFile()).length;
        }
      } catch {
        /* workspace directory may not be listable */
      }

      return { workspace, rootFiles };
    }, API_TTL.bootstrap);

    return NextResponse.json({ success: true, data });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: String(err) },
      { status: 500 },
    );
  }
}
