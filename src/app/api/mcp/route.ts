import { NextRequest, NextResponse } from "next/server";
import { getSqlite } from "@/lib/db";
import { requireOperatorAccess } from "@/lib/security/admin";
import { getMCPCatalogEntry, instantiateMCPCatalogEntry, MCP_CATALOG } from "@/lib/mcp/catalog";
import { getMCPServerStatuses, getMCPTools, syncMCPServers, testMCPConnection } from "@/lib/mcp/registry";
import { normalizeMCPServerConfig, type MCPServerConfig } from "@/lib/mcp/client";

export const dynamic = "force-dynamic";

function readServers(): MCPServerConfig[] {
  const db = getSqlite();
  const row = db.prepare("SELECT mcp_servers FROM app_config WHERE id = 'default'").get() as { mcp_servers?: string } | undefined;
  try {
    const parsed = JSON.parse(row?.mcp_servers || "[]");
    return Array.isArray(parsed)
      ? parsed.map((entry) => normalizeMCPServerConfig(entry)).filter((entry): entry is MCPServerConfig => Boolean(entry))
      : [];
  } catch {
    return [];
  }
}

async function writeServers(servers: MCPServerConfig[]) {
  const db = getSqlite();
  db.prepare("UPDATE app_config SET mcp_servers = ?, updated_at = ? WHERE id = 'default'").run(JSON.stringify(servers), new Date().toISOString());
  await syncMCPServers();
}

export async function GET(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const { searchParams } = new URL(request.url);
    const servers = readServers();
    if (searchParams.get("catalog") === "1") {
      return NextResponse.json({ success: true, data: MCP_CATALOG });
    }
    if (searchParams.get("tools") === "1") {
      await syncMCPServers();
      return NextResponse.json({ success: true, data: { statuses: getMCPServerStatuses(), tools: await getMCPTools() } });
    }
    await syncMCPServers();
    return NextResponse.json({ success: true, data: { servers, statuses: getMCPServerStatuses(), catalog: MCP_CATALOG } });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const denied = await requireOperatorAccess(request);
    if (denied) return denied;
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const action = String(body.action || "").trim().toLowerCase();
    const servers = readServers();

    if (action === "add-from-catalog") {
      const entry = getMCPCatalogEntry(String(body.catalogId || ""));
      if (!entry) return NextResponse.json({ success: false, error: "Catalog entry not found" }, { status: 404 });
      const values = body.values && typeof body.values === "object" && !Array.isArray(body.values)
        ? body.values as Record<string, string>
        : {};
      for (const env of entry.env) {
        if (env.required && !String(values[env.key] || "").trim()) {
          return NextResponse.json({ success: false, error: `${env.key} is required` }, { status: 400 });
        }
      }
      const config = instantiateMCPCatalogEntry(entry, values, servers.map((server) => server.name));
      await writeServers([...servers, config]);
      return NextResponse.json({ success: true, data: config }, { status: 201 });
    }

    if (action === "set-tool-policy") {
      const serverName = String(body.serverName || "").trim();
      const toolName = String(body.toolName || "").trim();
      if (!serverName || !toolName) return NextResponse.json({ success: false, error: "serverName and toolName are required" }, { status: 400 });
      const next = servers.map((server) => {
        if (server.name !== serverName) return server;
        return {
          ...server,
          tools: {
            ...(server.tools || {}),
            policies: {
              ...(server.tools?.policies || {}),
              [toolName]: {
                ...(server.tools?.policies?.[toolName] || {}),
                ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
                ...(typeof body.readonly === "boolean" ? { readonly: body.readonly } : {}),
                ...(body.approvalMode ? { approvalMode: String(body.approvalMode) as any } : {}),
              },
            },
          },
        };
      });
      await writeServers(next);
      return NextResponse.json({ success: true, data: next.find((server) => server.name === serverName) });
    }

    if (action === "test") {
      await syncMCPServers();
      const result = await testMCPConnection(String(body.serverName || ""));
      return NextResponse.json({ success: result.success, data: result, error: result.error });
    }

    return NextResponse.json({ success: false, error: "Unknown MCP action" }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}

