import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getAgentById, getDefaultAgent, pruneExtensionReferences } from "@/lib/agents/registry";
import { buildAgentSkillEntries } from "@/lib/extensions/registry";
import { getExtensionRuntimeStatus, loadExtensionRuntimeRegistry } from "@/lib/extensions/runtime";
import { buildGlobalExtensionEntries, clearGlobalExtensionState, setGlobalExtensionConfig, setGlobalExtensionEnabled } from "@/lib/extensions/state";
import { installExternalExtension, uninstallExternalExtension, updateExternalExtension } from "@/lib/extensions/installer";
import { requireOperatorAccess } from "@/lib/security/admin";

export const dynamic = "force-dynamic";

const UpdateExtensionSchema = z
  .object({
    extensionId: z.string().min(1),
    globallyEnabled: z.boolean().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((value) => value.globallyEnabled !== undefined || value.config !== undefined, {
    message: "Provide globallyEnabled and/or config",
  });

const InstallExtensionSchema = z.object({
  action: z.literal("install"),
  source: z.string().min(1),
  ref: z.string().optional(),
});

const UpdateInstalledExtensionSchema = z.object({
  action: z.literal("update"),
  extensionId: z.string().min(1),
});

const UninstallExtensionSchema = z.object({
  action: z.literal("uninstall"),
  extensionId: z.string().min(1),
});

const ExtensionActionSchema = z.discriminatedUnion("action", [
  InstallExtensionSchema,
  UpdateInstalledExtensionSchema,
  UninstallExtensionSchema,
]);

export async function GET(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const { searchParams } = new URL(request.url);
    const requestedAgentId = String(searchParams.get("agentId") || "").trim();
    const agent = requestedAgentId ? getAgentById(requestedAgentId) ?? getDefaultAgent() : getDefaultAgent();
    const runtime = await getExtensionRuntimeStatus();
    const extensions = buildGlobalExtensionEntries(agent.enabledExtensions);
    const globallyEnabled = new Set(
      extensions.filter((entry) => entry.globallyEnabled).map((entry) => entry.id),
    );
    return NextResponse.json({
      success: true,
      data: {
        agentId: agent.id,
        extensions,
        skills: buildAgentSkillEntries({
          enabledExtensions: agent.enabledExtensions.filter((entry) => globallyEnabled.has(entry)),
          enabledSkills: agent.enabledSkills,
          agentWorkspacePath: agent.workspacePath,
        }),
        runtime,
      },
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const body = await request.json();
    const parsed = UpdateExtensionSchema.parse(body);
    if (parsed.globallyEnabled !== undefined) {
      setGlobalExtensionEnabled(parsed.extensionId, parsed.globallyEnabled);
    }
    if (parsed.config !== undefined) {
      setGlobalExtensionConfig(parsed.extensionId, parsed.config);
    }
    const runtime = await getExtensionRuntimeStatus();
    return NextResponse.json({
      success: true,
      data: {
        extensions: buildGlobalExtensionEntries(),
        runtime,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    if (String(error).includes("not found")) {
      return NextResponse.json({ success: false, error: String(error) }, { status: 404 });
    }
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const body = await request.json();
    const parsed = ExtensionActionSchema.parse(body);

    if (parsed.action === "install") {
      const previousIds = new Set(buildGlobalExtensionEntries().map((entry) => entry.id));
      const installed = installExternalExtension({
        source: parsed.source,
        ref: parsed.ref ?? null,
      });
      if (!previousIds.has(installed.id)) {
        setGlobalExtensionEnabled(installed.id, false);
      }
    } else if (parsed.action === "update") {
      updateExternalExtension(parsed.extensionId);
    } else {
      const removed = uninstallExternalExtension(parsed.extensionId);
      if (!removed) {
        return NextResponse.json({ success: false, error: "External extension not found" }, { status: 404 });
      }
      clearGlobalExtensionState(parsed.extensionId);
      pruneExtensionReferences(parsed.extensionId);
    }

    await loadExtensionRuntimeRegistry();
    const runtime = await getExtensionRuntimeStatus();
    return NextResponse.json({
      success: true,
      data: {
        extensions: buildGlobalExtensionEntries(),
        runtime,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
