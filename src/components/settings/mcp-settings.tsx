"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Save, Trash2, Plus, Server, Wrench } from "lucide-react";

interface MCPServerConfig {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  enabled?: boolean;
  allowedAgents?: string[];
  trustTier?: "low" | "medium" | "high";
  defaultApprovalMode?: "off" | "model" | "human";
  tools?: {
    policies?: Record<string, { enabled?: boolean; readonly?: boolean; approvalMode?: "off" | "model" | "human" }>;
  };
}

type AgentOption = {
  id: string;
  name: string;
  isActive?: boolean;
};

type CatalogEntry = {
  id: string;
  name: string;
  description: string;
  env: Array<{ key: string; label: string; description: string; required: boolean }>;
  trustTier: string;
  defaultApprovalMode: "off" | "model" | "human";
};

type MCPStatus = {
  name: string;
  transport: string;
  status: string;
  lastError?: string;
  trustTier: string;
  defaultApprovalMode: "off" | "model" | "human";
};

type MCPTool = {
  name: string;
  description: string;
  _mcpServer: string;
  _mcpTool: string;
  _mcpApprovalMode: "off" | "model" | "human";
  _mcpReadonly: boolean | null;
};

export function MCPSettings() {
  const [servers, setServers] = useState<MCPServerConfig[]>([]);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [statuses, setStatuses] = useState<MCPStatus[]>([]);
  const [tools, setTools] = useState<MCPTool[]>([]);
  const [catalogValues, setCatalogValues] = useState<Record<string, Record<string, string>>>({});
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const load = () => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((j) => {
        if (j.success && j.data && j.data.mcp_servers) {
          try {
            setServers(JSON.parse(j.data.mcp_servers));
          } catch {
            setServers([]);
          }
        }
      })
      .catch((err) => { console.error("[mcp-settings] Failed to load mcp config:", String(err)); });
    fetch("/api/mcp")
      .then((r) => r.json())
      .then((j) => {
        if (j.success && j.data) {
          setCatalog(j.data.catalog ?? []);
          setStatuses(j.data.statuses ?? []);
        }
      })
      .catch(() => {});
    fetch("/api/mcp?tools=1")
      .then((r) => r.json())
      .then((j) => {
        if (j.success && j.data) {
          setStatuses(j.data.statuses ?? []);
          setTools(j.data.tools ?? []);
        }
      })
      .catch(() => {});
    fetch("/api/agents")
      .then((r) => r.json())
      .then((j) => {
        if (j.success && Array.isArray(j.data?.agents)) {
          setAgents(j.data.agents);
        }
      })
      .catch(() => {});
  };

  useEffect(() => {
    load();
  }, []);

  const save = async () => {
    setSaving(true);
    setStatus(null);
    try {
      const res = await fetch("/api/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mcp_servers: JSON.stringify(servers) }),
      });
      const j = await res.json();
      setStatus(j.success ? "Saved." : `Error: ${j.error}`);
      if (j.success) load();
    } catch (err) {
      setStatus(`Error: ${String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const addServer = () => {
    setServers([...servers, { name: `server-${servers.length + 1}`, transport: "stdio", command: "", args: [] }]);
  };

  const removeServer = (index: number) => {
    const next = [...servers];
    next.splice(index, 1);
    setServers(next);
  };

  const updateServer = (index: number, config: MCPServerConfig) => {
    const next = [...servers];
    next[index] = config;
    setServers(next);
  };

  const setAgentScope = (index: number, agentId: string, allowed: boolean) => {
    const server = servers[index];
    const current = new Set(server.allowedAgents || []);
    if (allowed) current.add(agentId);
    else current.delete(agentId);
    updateServer(index, { ...server, allowedAgents: [...current] });
  };

  const addFromCatalog = async (entry: CatalogEntry) => {
    setSaving(true);
    setStatus(null);
    try {
      const res = await fetch("/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "add-from-catalog",
          catalogId: entry.id,
          values: catalogValues[entry.id] || {},
        }),
      });
      const j = await res.json();
      setStatus(j.success ? `Installed ${entry.name}.` : `Error: ${j.error}`);
      load();
    } finally {
      setSaving(false);
    }
  };

  const setToolPolicy = async (
    serverName: string,
    toolName: string,
    patch: { enabled?: boolean; readonly?: boolean; approvalMode?: "off" | "model" | "human" },
  ) => {
    await fetch("/api/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set-tool-policy", serverName, toolName, ...patch }),
    });
    load();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Model Context Protocol (MCP)</CardTitle>
        <CardDescription>
          Connect disp8ch to external tools via Model Context Protocol servers. Agents will automatically discover and use the tools from connected servers.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {catalog.length > 0 && (
          <div className="rounded-md border p-4">
            <div className="mb-3 flex items-center gap-2">
              <Plus className="h-4 w-4 text-muted-foreground" />
              <h4 className="text-sm font-semibold">Add from catalog</h4>
            </div>
            <div className="grid gap-3 lg:grid-cols-2">
              {catalog.map((entry) => (
                <div key={entry.id} className="rounded-md border bg-muted/20 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold">{entry.name}</div>
                      <p className="mt-1 text-xs text-muted-foreground">{entry.description}</p>
                      <div className="mt-2 flex gap-1">
                        <span className="rounded border px-1.5 py-0.5 text-[10px]">trust: {entry.trustTier}</span>
                        <span className="rounded border px-1.5 py-0.5 text-[10px]">approval: {entry.defaultApprovalMode}</span>
                      </div>
                    </div>
                    <Button size="sm" onClick={() => void addFromCatalog(entry)} disabled={saving}>
                      Add
                    </Button>
                  </div>
                  {entry.env.length > 0 ? (
                    <div className="mt-3 space-y-2">
                      {entry.env.map((env) => (
                        <div key={env.key}>
                          <Label className="text-xs">{env.label}</Label>
                          <Input
                            className="mt-1"
                            value={catalogValues[entry.id]?.[env.key] || ""}
                            onChange={(event) => setCatalogValues((current) => ({
                              ...current,
                              [entry.id]: { ...(current[entry.id] || {}), [env.key]: event.target.value },
                            }))}
                            placeholder={env.description}
                            type={env.key.includes("TOKEN") || env.key.includes("KEY") ? "password" : "text"}
                          />
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        )}

        {servers.map((server, i) => (
          <div key={i} className="rounded-md border p-4 space-y-4 bg-muted/20">
            <div className="flex items-start justify-between">
              <div className="flex gap-2 items-center">
                <Server className="w-5 h-5 text-muted-foreground" />
                <h4 className="font-medium text-sm">Server Configuration</h4>
                <span className="rounded border px-2 py-0.5 text-xs">
                  {statuses.find((s) => s.name === server.name)?.status || "not connected"}
                </span>
              </div>
              <Button variant="ghost" size="sm" onClick={() => removeServer(i)}>
                <Trash2 className="w-4 h-4 text-destructive" />
              </Button>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Server Name</Label>
                <Input
                  value={server.name}
                  onChange={(e) => updateServer(i, { ...server, name: e.target.value })}
                  placeholder="e.g. github-mcp"
                  className="mt-1"
                />
              </div>
              <div>
                <Label>Transport</Label>
                <Select
                  value={server.transport}
                  onValueChange={(v: "stdio" | "http") => updateServer(i, { ...server, transport: v })}
                >
                  <SelectTrigger className="mt-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="stdio">Stdio (Local Command)</SelectItem>
                    <SelectItem value="http">HTTP/SSE (Remote)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {server.transport === "stdio" ? (
              <div className="grid grid-cols-1 gap-4">
                <div>
                  <Label>Command</Label>
                  <Input
                    value={server.command || ""}
                    onChange={(e) => updateServer(i, { ...server, command: e.target.value })}
                    placeholder="e.g. npx"
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label>Arguments (space separated)</Label>
                  <Input
                    value={(server.args || []).join(" ")}
                    onChange={(e) => updateServer(i, { ...server, args: e.target.value.split(" ").filter(Boolean) })}
                    placeholder="-y @modelcontextprotocol/server-postgres"
                    className="mt-1"
                  />
                  <p className="text-xs text-muted-foreground mt-1">If args contain spaces or quotes, edit via JSON manually.</p>
                </div>
              </div>
            ) : (
              <div>
                <Label>SSE URL</Label>
                <Input
                  value={server.url || ""}
                  onChange={(e) => updateServer(i, { ...server, url: e.target.value })}
                  placeholder="http://localhost:3000/sse"
                  className="mt-1"
                />
              </div>
            )}
            {statuses.find((s) => s.name === server.name)?.lastError ? (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
                {statuses.find((s) => s.name === server.name)?.lastError}
              </div>
            ) : null}
            <div className="rounded-md border p-3">
              <Label>Who can use this server?</Label>
              <p className="mt-1 text-xs text-muted-foreground">
                Choose all agents for a shared integration, or limit access to specific agents. This controls tool discovery, resources, prompts, and calls.
              </p>
              <label className="mt-3 flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name={`mcp-agent-scope-${i}`}
                  checked={!server.allowedAgents?.length}
                  onChange={() => updateServer(i, { ...server, allowedAgents: [] })}
                />
                <span>All agents</span>
              </label>
              <label className="mt-2 flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name={`mcp-agent-scope-${i}`}
                  checked={Boolean(server.allowedAgents?.length)}
                  onChange={() => {
                    const firstAgent = agents.find((agent) => agent.isActive !== false);
                    updateServer(i, { ...server, allowedAgents: firstAgent ? [firstAgent.id] : [] });
                  }}
                  disabled={agents.length === 0}
                />
                <span>Only selected agents</span>
              </label>
              {server.allowedAgents?.length ? (
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  {agents.map((agent) => (
                    <label key={agent.id} className="flex items-center gap-2 rounded border bg-background px-3 py-2 text-sm">
                      <input
                        type="checkbox"
                        checked={server.allowedAgents?.includes(agent.id) ?? false}
                        onChange={(event) => setAgentScope(i, agent.id, event.target.checked)}
                      />
                      <span className="min-w-0">
                        <span className="block truncate">{agent.name}</span>
                        <span className="block truncate text-xs text-muted-foreground">{agent.id}</span>
                      </span>
                    </label>
                  ))}
                </div>
              ) : null}
              {(server.allowedAgents || []).filter((agentId) => !agents.some((agent) => agent.id === agentId)).length > 0 ? (
                <p className="mt-2 text-xs text-amber-600">
                  Unknown saved agent IDs: {(server.allowedAgents || []).filter((agentId) => !agents.some((agent) => agent.id === agentId)).join(", ")}
                </p>
              ) : null}
            </div>
            <div className="rounded-md border p-3">
              <div className="mb-2 flex items-center gap-2 text-xs font-semibold">
                <Wrench className="h-3.5 w-3.5" /> Tools
              </div>
              {tools.filter((tool) => tool._mcpServer === server.name).length === 0 ? (
                <p className="text-xs text-muted-foreground">No tools discovered yet. Save and test the server connection.</p>
              ) : (
                <div className="space-y-2">
                  {tools.filter((tool) => tool._mcpServer === server.name).map((tool) => {
                    const policy = server.tools?.policies?.[tool._mcpTool] || {};
                    const enabled = policy.enabled !== false;
                    return (
                      <div key={tool.name} className="flex flex-wrap items-center justify-between gap-2 rounded border bg-background p-2">
                        <div className="min-w-0">
                          <div className="truncate text-xs font-medium">{tool._mcpTool}</div>
                          <div className="line-clamp-1 text-[11px] text-muted-foreground">{tool.description}</div>
                        </div>
                        <div className="flex items-center gap-2">
                          <label className="flex items-center gap-1 text-xs">
                            <input
                              type="checkbox"
                              checked={enabled}
                              onChange={(event) => void setToolPolicy(server.name, tool._mcpTool, { enabled: event.target.checked })}
                            />
                            enabled
                          </label>
                          <Select
                            value={policy.approvalMode || tool._mcpApprovalMode || server.defaultApprovalMode || "off"}
                            onValueChange={(value: "off" | "model" | "human") => void setToolPolicy(server.name, tool._mcpTool, { approvalMode: value })}
                          >
                            <SelectTrigger className="h-7 w-28 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="off">off</SelectItem>
                              <SelectItem value="model">model</SelectItem>
                              <SelectItem value="human">human</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        ))}

        {servers.length === 0 && (
          <div className="text-center py-8 text-muted-foreground bg-muted/10 rounded-md border border-dashed">
            No MCP servers configured yet.
          </div>
        )}

        <div className="flex gap-2 justify-between">
          <Button variant="outline" onClick={addServer}>
            <Plus className="mr-2 h-4 w-4" /> Add Server
          </Button>

          <div className="flex items-center gap-2">
            <Button onClick={save} disabled={saving}>
              <Save className="mr-2 h-4 w-4" />
              {saving ? "Saving..." : "Save Settings"}
            </Button>
            {status && (
              <span className={`text-sm ${status.startsWith("Error") ? "text-destructive" : "text-muted-foreground"}`}>
                {status}
              </span>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
