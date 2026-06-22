/**
 * MCP (Model Context Protocol) Client Connection.
 * Connects to external MCP servers via stdio or SSE transports.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { logger } from "@/lib/utils/logger";

const log = logger.child("mcp:client");

export type MCPTransportType = "stdio" | "http";
export type MCPTrustTier = "low" | "medium" | "high";
export type MCPApprovalMode = "off" | "model" | "human";

export interface MCPToolPolicyConfig {
  enabled?: boolean;
  readonly?: boolean;
  approvalMode?: MCPApprovalMode;
}

export interface MCPToolControlsConfig {
  include?: string[];
  exclude?: string[];
  resources?: boolean;
  prompts?: boolean;
  policies?: Record<string, MCPToolPolicyConfig>;
}

export interface MCPServerConfig {
  name: string;
  transport: MCPTransportType;
  // stdio fields
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // http fields
  url?: string;
  autoConnect?: boolean;
  enabled?: boolean;
  trustTier?: MCPTrustTier;
  defaultApprovalMode?: MCPApprovalMode;
  allowedAgents?: string[];
  tools?: MCPToolControlsConfig;
}

export class MCPServerConnection {
  public config: MCPServerConfig;
  private client: Client;
  private transport?: StdioClientTransport | SSEClientTransport;
  private connectPromise?: Promise<void>;
  public status: "disconnected" | "connecting" | "connected" | "error" = "disconnected";
  public lastError?: string;

  constructor(config: MCPServerConfig) {
    this.config = config;
    this.client = new Client(
      { name: "disp8ch-mcp-client", version: "1.0.0" },
      { capabilities: {} }
    );
  }

  async connect(): Promise<void> {
    if (this.status === "connected") return;
    if (this.connectPromise) return this.connectPromise;
    this.status = "connecting";
    this.connectPromise = (async () => {
      try {
        if (this.config.transport === "stdio") {
          if (!this.config.command) throw new Error("Missing command for stdio transport");

          this.transport = new StdioClientTransport({
            command: this.config.command,
            args: this.config.args || [],
            env: sanitizeEnv({ ...process.env, ...(this.config.env || {}) }),
          });

        } else if (this.config.transport === "http") {
          if (!this.config.url) throw new Error("Missing url for http/sse transport");
          this.transport = new SSEClientTransport(new URL(this.config.url));
        } else {
          throw new Error(`Unsupported transport: ${this.config.transport}`);
        }

        await this.client.connect(this.transport);
        this.status = "connected";
        this.lastError = undefined;
        log.info("MCP server connected", { server: this.config.name });
      } catch (err) {
        this.status = "error";
        this.lastError = String(err);
        log.error("Failed to connect MCP server", { server: this.config.name, error: this.lastError });
        throw err;
      } finally {
        this.connectPromise = undefined;
      }
    })();
    return this.connectPromise;
  }

  async disconnect(): Promise<void> {
    try {
      if (this.connectPromise) {
        await this.connectPromise.catch(() => {});
      }
    } catch {
      // ignore connect wait failures during teardown
    }
    this.status = "disconnected";
    try {
      if (this.transport && "close" in this.transport) {
        await this.transport.close();
      }
    } catch { /* ignore */ }
    this.transport = undefined;
  }

  /**
   * Discovers tools from the MCP server and formats them into OpenAI tool schemas
   */
  async discoverTools(): Promise<{ name: string; description: string; parameters: any }[]> {
    if (this.status !== "connected") await this.connect();

    try {
      const resp = await this.client.listTools();
      return (resp.tools || []).map((t: Tool) => ({
        name: t.name,
        description: t.description || `MCP Tool: ${t.name}`,
        parameters: t.inputSchema || { type: "object", properties: {} },
      }));
    } catch (err) {
      log.error("Failed to list tools", { server: this.config.name, error: String(err) });
      return [];
    }
  }

  /**
   * Executes a specific tool on the MCP server
   */
  async callTool(name: string, args: any): Promise<any> {
    if (this.status !== "connected") await this.connect();

    try {
      const resp = await this.client.callTool({
        name,
        arguments: args,
      });

      // Format response
      if (resp.content && Array.isArray(resp.content)) {
        const textParts = resp.content
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text);
        
        if (resp.isError) {
          return `Error: ${textParts.join("\n")}`;
        }
        return textParts.join("\n") || "Success (no text output)";
      }

      return JSON.stringify(resp);
    } catch (err) {
      log.error("Tool execution failed", { server: this.config.name, tool: name, error: String(err) });
      throw err;
    }
  }

  async listResources(cursor?: string): Promise<Array<{ uri: string; name: string; description?: string; mimeType?: string }>> {
    if (this.status !== "connected") await this.connect();

    try {
      const resp = await this.client.listResources(cursor ? { cursor } : undefined);
      return (resp.resources || []).map((resource: any) => ({
        uri: String(resource.uri),
        name: String(resource.name || resource.title || resource.uri),
        description: typeof resource.description === "string" ? resource.description : undefined,
        mimeType: typeof resource.mimeType === "string" ? resource.mimeType : undefined,
      }));
    } catch (err) {
      log.error("Failed to list resources", { server: this.config.name, error: String(err) });
      throw err;
    }
  }

  async readResource(uri: string): Promise<string> {
    if (this.status !== "connected") await this.connect();

    try {
      const resp = await this.client.readResource({ uri });
      const parts = (resp.contents || []).map((entry: any) => {
        if (typeof entry.text === "string") return entry.text;
        if (typeof entry.blob === "string") return `[binary data, ${entry.blob.length} bytes base64]`;
        return JSON.stringify(entry);
      });
      return parts.join("\n\n").trim();
    } catch (err) {
      log.error("Failed to read resource", { server: this.config.name, uri, error: String(err) });
      throw err;
    }
  }

  async listPrompts(cursor?: string): Promise<Array<{ name: string; description?: string; arguments?: Array<{ name: string; description?: string; required?: boolean }> }>> {
    if (this.status !== "connected") await this.connect();

    try {
      const resp = await this.client.listPrompts(cursor ? { cursor } : undefined);
      return (resp.prompts || []).map((prompt: any) => ({
        name: String(prompt.name),
        description: typeof prompt.description === "string" ? prompt.description : undefined,
        arguments: Array.isArray(prompt.arguments)
          ? prompt.arguments.map((arg: any) => ({
              name: String(arg.name),
              description: typeof arg.description === "string" ? arg.description : undefined,
              required: typeof arg.required === "boolean" ? arg.required : undefined,
            }))
          : undefined,
      }));
    } catch (err) {
      log.error("Failed to list prompts", { server: this.config.name, error: String(err) });
      throw err;
    }
  }

  async getPrompt(name: string, args?: Record<string, unknown>): Promise<{ description?: string; messages: Array<{ role?: string; content: string }> }> {
    if (this.status !== "connected") await this.connect();

    try {
      const resp = await this.client.getPrompt({
        name,
        arguments: sanitizePromptArgs(args),
      });
      return {
        description: typeof resp.description === "string" ? resp.description : undefined,
        messages: (resp.messages || []).map((message: any) => ({
          role: typeof message.role === "string" ? message.role : undefined,
          content: formatPromptContent(message.content),
        })),
      };
    } catch (err) {
      log.error("Failed to get prompt", { server: this.config.name, name, error: String(err) });
      throw err;
    }
  }
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value
    .map((entry) => String(entry || "").trim())
    .filter(Boolean);
  return entries.length > 0 ? Array.from(new Set(entries)) : undefined;
}

function normalizeApprovalMode(value: unknown): MCPApprovalMode | undefined {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "off" || normalized === "model" || normalized === "human") {
    return normalized;
  }
  return undefined;
}

function normalizeTrustTier(value: unknown): MCPTrustTier | undefined {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "low" || normalized === "medium" || normalized === "high") {
    return normalized;
  }
  return undefined;
}

function normalizeToolPolicies(value: unknown): Record<string, MCPToolPolicyConfig> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>)
    .map(([toolName, rawPolicy]) => {
      const normalizedName = String(toolName || "").trim();
      if (!normalizedName || !rawPolicy || typeof rawPolicy !== "object" || Array.isArray(rawPolicy)) {
        return null;
      }
      const policyRecord = rawPolicy as Record<string, unknown>;
      const policy: MCPToolPolicyConfig = {};
      if (typeof policyRecord.enabled === "boolean") policy.enabled = policyRecord.enabled;
      if (typeof policyRecord.readonly === "boolean") policy.readonly = policyRecord.readonly;
      const approvalMode = normalizeApprovalMode(policyRecord.approvalMode);
      if (approvalMode) policy.approvalMode = approvalMode;
      return Object.keys(policy).length > 0 ? [normalizedName, policy] as const : null;
    })
    .filter((entry): entry is readonly [string, MCPToolPolicyConfig] => Array.isArray(entry));
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function normalizeMCPServerConfig(raw: unknown): MCPServerConfig | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const name = String(record.name || "").trim();
  const transport = String(record.transport || "").trim().toLowerCase();
  if (!name || (transport !== "stdio" && transport !== "http")) {
    return null;
  }

  const toolsRecord =
    record.tools && typeof record.tools === "object" && !Array.isArray(record.tools)
      ? (record.tools as Record<string, unknown>)
      : null;

  const config: MCPServerConfig = {
    name,
    transport,
    autoConnect: record.autoConnect !== false,
    enabled: record.enabled !== false,
    trustTier: normalizeTrustTier(record.trustTier) || "medium",
    defaultApprovalMode: normalizeApprovalMode(record.defaultApprovalMode) || "off",
  };

  if (transport === "stdio") {
    const command = String(record.command || "").trim();
    if (!command) return null;
    config.command = command;
    config.args = Array.isArray(record.args)
      ? record.args.map((entry) => String(entry ?? "")).filter((entry) => entry.length > 0)
      : [];
    if (record.env && typeof record.env === "object" && !Array.isArray(record.env)) {
      config.env = Object.fromEntries(
        Object.entries(record.env as Record<string, unknown>)
          .filter(([, value]) => value !== undefined && value !== null)
          .map(([key, value]) => [key, String(value)]),
      );
    }
  } else {
    const url = String(record.url || "").trim();
    if (!url) return null;
    config.url = url;
  }

  const allowedAgents = normalizeStringArray(record.allowedAgents);
  if (allowedAgents) config.allowedAgents = allowedAgents;

  if (toolsRecord) {
    const tools: MCPToolControlsConfig = {};
    const include = normalizeStringArray(toolsRecord.include);
    const exclude = normalizeStringArray(toolsRecord.exclude);
    const policies = normalizeToolPolicies(toolsRecord.policies);
    if (include) tools.include = include;
    if (exclude) tools.exclude = exclude;
    if (typeof toolsRecord.resources === "boolean") tools.resources = toolsRecord.resources;
    if (typeof toolsRecord.prompts === "boolean") tools.prompts = toolsRecord.prompts;
    if (policies) tools.policies = policies;
    if (Object.keys(tools).length > 0) {
      config.tools = tools;
    }
  }

  return config;
}

function sanitizeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function sanitizePromptArgs(args?: Record<string, unknown>): Record<string, string> | undefined {
  if (!args) return undefined;
  const entries = Object.entries(args)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)] as const);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function formatPromptContent(content: unknown): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (typeof content === "object") {
    const typed = content as Record<string, unknown>;
    if (typed.type === "text" && typeof typed.text === "string") {
      return typed.text;
    }
    if (typed.type === "resource" && typed.resource && typeof typed.resource === "object") {
      const resource = typed.resource as Record<string, unknown>;
      if (typeof resource.text === "string") {
        return resource.text;
      }
      if (typeof resource.blob === "string") {
        return `[resource blob ${resource.blob.length} bytes base64]`;
      }
    }
  }
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}
