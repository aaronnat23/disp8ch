/**
 * MCP Registry
 * Manages active connections to multiple MCP servers configured in app_config.
 */

import {
  MCPServerConnection,
  type MCPServerConfig,
  type MCPApprovalMode,
  normalizeMCPServerConfig,
} from "./client";
import { logger } from "@/lib/utils/logger";

const log = logger.child("mcp:registry");

// In-memory registry of active server connections
const connections = new Map<string, MCPServerConnection>();

type MCPAccessContext = {
  agentId?: string;
};

type MCPToolRecord = {
  name: string;
  description: string;
  parameters: any;
  _mcpServer: string;
  _mcpTool: string;
  _mcpTrustTier: string;
  _mcpApprovalMode: MCPApprovalMode;
  _mcpReadonly: boolean | null;
};

function readConfiguredMCPServers(raw: string | undefined): MCPServerConfig[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((entry) => normalizeMCPServerConfig(entry))
    .filter((entry): entry is MCPServerConfig => Boolean(entry));
}

function getServerConfig(serverName: string): MCPServerConfig {
  const conn = connections.get(serverName);
  if (!conn) {
    throw new Error(`MCP server not found: ${serverName}. Add it in MCP Servers`);
  }
  return conn.config;
}

function assertServerAgentAccess(config: MCPServerConfig, context?: MCPAccessContext): void {
  const allowedAgents = config.allowedAgents || [];
  if (allowedAgents.length === 0) return;
  const agentId = String(context?.agentId || "").trim();
  if (!agentId || !allowedAgents.includes(agentId)) {
    throw new Error(`MCP server '${config.name}' is not allowed for agent '${agentId || "unknown"}'.`);
  }
}

function isToolAllowed(config: MCPServerConfig, toolName: string): boolean {
  const include = config.tools?.include || [];
  const exclude = config.tools?.exclude || [];
  if (include.length > 0 && !include.includes(toolName)) return false;
  if (exclude.includes(toolName)) return false;
  if (config.tools?.policies?.[toolName]?.enabled === false) return false;
  return true;
}

function getToolApprovalMode(config: MCPServerConfig, toolName: string): MCPApprovalMode {
  return config.tools?.policies?.[toolName]?.approvalMode || config.defaultApprovalMode || "off";
}

function getToolReadonly(config: MCPServerConfig, toolName: string): boolean | null {
  const policy = config.tools?.policies?.[toolName];
  return typeof policy?.readonly === "boolean" ? policy.readonly : null;
}

/**
 * Syncs the active connections with the current database app_config.mcp_servers
 */
export async function syncMCPServers(): Promise<void> {
  try {
    const { getSqlite } = await import("@/lib/db");
    const db = getSqlite();
    const row = db.prepare("SELECT mcp_servers FROM app_config WHERE id = 'default'").get() as { mcp_servers?: string } | undefined;
    
    const configs = readConfiguredMCPServers(row?.mcp_servers).filter((config) => config.enabled !== false);

    const newNames = new Set(configs.map(c => c.name));

    // Remove old servers
    for (const [name, conn] of connections.entries()) {
      if (!newNames.has(name)) {
        log.info("Removing MCP server", { server: name });
        conn.disconnect().catch(() => {});
        connections.delete(name);
      }
    }

    // Add or update servers
    for (const config of configs) {
      if (!connections.has(config.name)) {
        log.info("Adding MCP server", { server: config.name });
        const conn = new MCPServerConnection(config);
        connections.set(config.name, conn);
        // Fire and forget connect
        if (config.autoConnect !== false) {
          conn.connect().catch(() => {});
        }
      } else {
        // Update connection if config changed (naive compare)
        const existing = connections.get(config.name)!;
        if (JSON.stringify(existing.config) !== JSON.stringify(config)) {
          log.info("Updating MCP server", { server: config.name });
          await existing.disconnect();
          const newConn = new MCPServerConnection(config);
          connections.set(config.name, newConn);
          if (config.autoConnect !== false) {
            newConn.connect().catch(() => {});
          }
        }
      }
    }
  } catch (err) {
    log.error("Failed to sync MCP servers", { error: String(err) });
  }
}

/**
 * Resolves a tool to a specific server by name.
 * We prepend tool names with `mcp_<serverName>_` to avoid conflicts.
 */
export async function executeMCPTool(serverName: string, toolName: string, args: any, context?: MCPAccessContext): Promise<any> {
  const conn = connections.get(serverName);
  const config = getServerConfig(serverName);
  assertServerAgentAccess(config, context);
  if (!conn) {
    throw new Error(`MCP server not found: ${serverName}. Add it in MCP Servers`);
  }
  if (!isToolAllowed(config, toolName)) {
    throw new Error(`MCP tool '${toolName}' is disabled by policy on server '${serverName}'.`);
  }
  return await conn.callTool(toolName, args);
}

function getConnection(serverName: string): MCPServerConnection {
  const conn = connections.get(serverName);
  if (!conn) {
    throw new Error(`MCP server not found: ${serverName}. Add it in MCP Servers`);
  }
  return conn;
}

export async function listMCPResources(serverName: string, cursor?: string, context?: MCPAccessContext) {
  const config = getServerConfig(serverName);
  assertServerAgentAccess(config, context);
  if (config.tools?.resources === false) {
    throw new Error(`MCP resources are disabled by policy on server '${serverName}'.`);
  }
  return await getConnection(serverName).listResources(cursor);
}

export async function readMCPResource(serverName: string, uri: string, context?: MCPAccessContext) {
  const config = getServerConfig(serverName);
  assertServerAgentAccess(config, context);
  if (config.tools?.resources === false) {
    throw new Error(`MCP resources are disabled by policy on server '${serverName}'.`);
  }
  return await getConnection(serverName).readResource(uri);
}

export async function listMCPPrompts(serverName: string, cursor?: string, context?: MCPAccessContext) {
  const config = getServerConfig(serverName);
  assertServerAgentAccess(config, context);
  if (config.tools?.prompts === false) {
    throw new Error(`MCP prompts are disabled by policy on server '${serverName}'.`);
  }
  return await getConnection(serverName).listPrompts(cursor);
}

export async function getMCPPrompt(serverName: string, name: string, args?: Record<string, unknown>, context?: MCPAccessContext) {
  const config = getServerConfig(serverName);
  assertServerAgentAccess(config, context);
  if (config.tools?.prompts === false) {
    throw new Error(`MCP prompts are disabled by policy on server '${serverName}'.`);
  }
  return await getConnection(serverName).getPrompt(name, args);
}

/**
 * Returns a list of all tools from all connected MCP servers, formatted for the agent.
 */
export async function getMCPTools(context?: MCPAccessContext): Promise<MCPToolRecord[]> {
  const tools: MCPToolRecord[] = [];
  
  for (const [serverName, conn] of connections.entries()) {
    try {
      assertServerAgentAccess(conn.config, context);
      const serverTools = await conn.discoverTools();
      for (const t of serverTools) {
        if (!isToolAllowed(conn.config, t.name)) continue;
        tools.push({
          name: `mcp_${serverName}_${t.name}`.replace(/[^a-zA-Z0-9_-]/g, '_'),
          description: `[MCP: ${serverName}] ${t.description}`,
          parameters: t.parameters,
          _mcpServer: serverName,
          _mcpTool: t.name,
          _mcpTrustTier: conn.config.trustTier || "medium",
          _mcpApprovalMode: getToolApprovalMode(conn.config, t.name),
          _mcpReadonly: getToolReadonly(conn.config, t.name),
        });
      }
    } catch (err) {
      log.warn("Failed to discover tools for server", {
        server: serverName,
        error: String(err),
        agentId: context?.agentId,
      });
    }
  }

  return tools;
}

/**
 * Returns the plain list of configured servers and their connection statuses for the UI
 */
export function getMCPServerStatuses(context?: MCPAccessContext): Array<{
  name: string;
  transport: string;
  status: string;
  lastError?: string;
  trustTier: string;
  defaultApprovalMode: MCPApprovalMode;
  allowedAgents: string[];
  resourcesEnabled: boolean;
  promptsEnabled: boolean;
  toolIncludeCount: number;
  toolExcludeCount: number;
}> {
  return Array.from(connections.values())
    .filter((connection) => {
      try {
        assertServerAgentAccess(connection.config, context);
        return true;
      } catch {
        return false;
      }
    })
    .map(c => ({
      name: c.config.name,
      transport: c.config.transport,
      status: c.status,
      lastError: c.lastError,
      trustTier: c.config.trustTier || "medium",
      defaultApprovalMode: c.config.defaultApprovalMode || "off",
      allowedAgents: c.config.allowedAgents || [],
      resourcesEnabled: c.config.tools?.resources !== false,
      promptsEnabled: c.config.tools?.prompts !== false,
      toolIncludeCount: c.config.tools?.include?.length || 0,
      toolExcludeCount: c.config.tools?.exclude?.length || 0,
    }));
}

/**
 * Test a connection manually
 */
export async function testMCPConnection(serverName: string): Promise<{ success: boolean; error?: string }> {
  const conn = connections.get(serverName);
  if (!conn) return { success: false, error: "Server not registered" };
  
  try {
    await conn.disconnect(); // force reconnect
    await conn.connect();
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}
