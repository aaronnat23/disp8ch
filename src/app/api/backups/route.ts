import { NextRequest, NextResponse } from "next/server";
import { createBackup, listBackups, restoreBackup, verifyBackup } from "@/lib/backup/manager";
import { getBackupPolicyStatus, runBackupPolicy } from "@/lib/backup/policy";
import { requireOperatorAccess } from "@/lib/security/admin";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const { searchParams } = new URL(request.url);
    const action = String(searchParams.get("action") || "list").trim().toLowerCase();

    if (action === "status") {
      return NextResponse.json({ success: true, data: getBackupPolicyStatus() });
    }

    if (action === "verify") {
      const id = searchParams.get("id");
      const result = verifyBackup(id);
      return NextResponse.json({ success: true, data: result });
    }

    return NextResponse.json({ success: true, data: listBackups() });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const body = (await request.json().catch(() => ({}))) as {
      action?: string;
      id?: string;
      includeDocuments?: boolean;
      includeWorkspace?: boolean;
      includeMemories?: boolean;
      includeLogs?: boolean;
      targetDataDir?: string;
      dryRun?: boolean;
    };

    const action = String(body.action || "create").trim().toLowerCase();
    if (action === "run-policy") {
      const result = await runBackupPolicy("api", { ignoreDisabled: true });
      return NextResponse.json({ success: true, data: result }, { status: 201 });
    }

    if (action === "verify") {
      const result = verifyBackup(body.id);
      return NextResponse.json({ success: true, data: result });
    }

    if (action === "restore") {
      const result = restoreBackup(body.id, {
        targetDataDir: body.targetDataDir,
        dryRun: body.dryRun !== false,
      });
      return NextResponse.json({ success: true, data: result });
    }

    if (action !== "create") {
      return NextResponse.json(
        { success: false, error: `Unknown action '${action}'. Use create, verify, restore, or run-policy.` },
        { status: 400 },
      );
    }

    const backup = await createBackup({
      includeDocuments: body.includeDocuments,
      includeWorkspace: body.includeWorkspace,
      includeMemories: body.includeMemories,
      includeLogs: body.includeLogs,
    });

    return NextResponse.json({ success: true, data: backup }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
