import type { MCPServerConfig, MCPTrustTier } from "@/lib/mcp/client";

export type MCPCatalogEnvKey = {
  key: string;
  label: string;
  description: string;
  required: boolean;
};

export type MCPCatalogEntry = {
  id: string;
  name: string;
  description: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  env: MCPCatalogEnvKey[];
  trustTier: MCPTrustTier;
  defaultApprovalMode: "off" | "model" | "human";
};

export const MCP_CATALOG: MCPCatalogEntry[] = [
  {
    id: "filesystem",
    name: "Filesystem",
    description: "Read and write an explicitly scoped local directory through the official filesystem MCP server.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "{{ROOT_PATH}}"],
    env: [{ key: "ROOT_PATH", label: "Root Path", description: "Directory the server may access.", required: true }],
    trustTier: "high",
    defaultApprovalMode: "human",
  },
  {
    id: "github",
    name: "GitHub",
    description: "Inspect and modify GitHub issues, pull requests, and repository metadata.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: [{ key: "GITHUB_PERSONAL_ACCESS_TOKEN", label: "GitHub Token", description: "Token exposed only to the MCP server process.", required: true }],
    trustTier: "high",
    defaultApprovalMode: "human",
  },
  {
    id: "postgres",
    name: "Postgres",
    description: "Query a Postgres database through an MCP SQL server.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-postgres", "{{POSTGRES_CONNECTION_STRING}}"],
    env: [{ key: "POSTGRES_CONNECTION_STRING", label: "Connection String", description: "Postgres connection URL.", required: true }],
    trustTier: "high",
    defaultApprovalMode: "model",
  },
  {
    id: "browser-sse",
    name: "Remote MCP over SSE",
    description: "Connect to a locally hosted or remote MCP SSE endpoint.",
    transport: "http",
    url: "{{MCP_SSE_URL}}",
    env: [{ key: "MCP_SSE_URL", label: "SSE URL", description: "MCP server SSE endpoint.", required: true }],
    trustTier: "medium",
    defaultApprovalMode: "model",
  },
];

export function getMCPCatalogEntry(id: string): MCPCatalogEntry | undefined {
  return MCP_CATALOG.find((entry) => entry.id === id);
}

export function instantiateMCPCatalogEntry(
  entry: MCPCatalogEntry,
  values: Record<string, string>,
  existingNames: string[] = [],
): MCPServerConfig {
  const replace = (input: string) =>
    input.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_match, key) => values[key] ?? "");
  const baseName = entry.id.replace(/[^a-zA-Z0-9_-]+/g, "-");
  let name = baseName;
  let suffix = 2;
  while (existingNames.includes(name)) {
    name = `${baseName}-${suffix++}`;
  }
  return {
    name,
    transport: entry.transport,
    command: entry.transport === "stdio" ? entry.command : undefined,
    args: entry.transport === "stdio" ? (entry.args || []).map(replace).filter(Boolean) : undefined,
    url: entry.transport === "http" && entry.url ? replace(entry.url) : undefined,
    env: Object.fromEntries(entry.env.map((env) => [env.key, values[env.key] || ""]).filter(([, value]) => value)),
    enabled: true,
    autoConnect: true,
    trustTier: entry.trustTier,
    defaultApprovalMode: entry.defaultApprovalMode,
    tools: { resources: true, prompts: true, policies: {} },
  };
}

