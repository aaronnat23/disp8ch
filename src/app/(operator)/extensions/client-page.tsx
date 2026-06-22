"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAfterUseful } from "@/lib/client/use-after-useful";

type AgentSummary = {
  id: string;
  name: string;
  isDefault: boolean;
};

type RuntimeEntry = {
  id: string;
  name: string;
  globallyEnabled: boolean;
  hasRuntime: boolean;
  hooks: string[];
  status: Record<string, unknown> | null;
};

type ExtensionEntry = {
  id: string;
  name: string;
  description: string;
  source: "bundled" | "external";
  skillCount: number;
  configurable: boolean;
  manifestPath: string;
  installed: boolean;
  installSource: "bundled" | "git" | "local";
  globallyEnabled: boolean;
  config: Record<string, unknown>;
  agentEnabled?: boolean;
  sourceRef?: string | null;
  sourceRevision?: string | null;
  runtimePath?: string | null;
  scanStatus?: "pass" | "warn" | "blocked" | null;
  scanSummary?: string | null;
  scanFindings?: Array<{
    ruleId: string;
    severity: "warn" | "error";
    title: string;
    summary: string;
    filePath: string;
    line: number | null;
    excerpt: string | null;
  }> | null;
  scannedAt?: string | null;
  installedAt?: string | null;
  updatedAt?: string | null;
};

function stringifyConfig(value: Record<string, unknown>): string {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return "{}";
  }
}

const EXTENSIONS_UI_STATE_KEY = "disp8ch:extensions-ui-state";

export default function ExtensionsPage() {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [extensions, setExtensions] = useState<ExtensionEntry[]>([]);
  const [runtime, setRuntime] = useState<RuntimeEntry[]>([]);
  const [filter, setFilter] = useState("");
  const [savingId, setSavingId] = useState<string | null>(null);
  const [configDrafts, setConfigDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [installSource, setInstallSource] = useState("");
  const [installRef, setInstallRef] = useState("");
  const [installing, setInstalling] = useState(false);
  const [hideGettingStarted, setHideGettingStarted] = useState(false);

  const loadAgents = async (): Promise<string> => {
    const response = await fetch("/api/agents");
    const json = await response.json();
    if (!json.success) return "";
    const nextAgents = (json.data?.agents ?? []) as AgentSummary[];
    const defaultId = (json.data?.defaultId as string | null) ?? nextAgents[0]?.id ?? "";
    setAgents(nextAgents);
    setSelectedAgentId((current) =>
      current && nextAgents.some((agent) => agent.id === current) ? current : defaultId,
    );
    return defaultId;
  };

  const loadExtensions = async (agentId: string) => {
    const query = agentId ? `?agentId=${encodeURIComponent(agentId)}` : "";
    const response = await fetch(`/api/extensions${query}`);
    const json = await response.json();
    if (!json.success) throw new Error(String(json.error || "Failed to load extensions"));
    const nextExtensions = (json.data?.extensions ?? []) as ExtensionEntry[];
    setExtensions(nextExtensions);
    setRuntime((((json.data?.runtime ?? {}) as { extensions?: RuntimeEntry[] }).extensions ?? []) as RuntimeEntry[]);
    setConfigDrafts(
      Object.fromEntries(nextExtensions.map((entry) => [entry.id, stringifyConfig(entry.config)])),
    );
  };

  // Defer agents + extensions list until after useful-ready.
  const extensionsInitDoneRef = useRef(false);
  useAfterUseful(() => {
    void (async () => {
      setLoading(true);
      try {
        const initialAgentId = await loadAgents();
        if (initialAgentId) await loadExtensions(initialAgentId);
      } finally {
        setLoading(false);
        extensionsInitDoneRef.current = true;
      }
    })();
  }, []);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(EXTENSIONS_UI_STATE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { hideGettingStarted?: boolean };
      setHideGettingStarted(Boolean(parsed.hideGettingStarted));
    } catch {
      // localStorage is optional; ignore malformed state.
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        EXTENSIONS_UI_STATE_KEY,
        JSON.stringify({ hideGettingStarted }),
      );
    } catch {
      // localStorage is optional.
    }
  }, [hideGettingStarted]);

  useEffect(() => {
    if (!extensionsInitDoneRef.current) return;
    if (!selectedAgentId) return;
    setLoading(true);
    setError(null);
    void loadExtensions(selectedAgentId)
      .catch((loadError) => setError(String(loadError)))
      .finally(() => setLoading(false));
  }, [selectedAgentId]);

  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return extensions;
    return extensions.filter((entry) =>
      `${entry.name} ${entry.id} ${entry.description} ${entry.sourceRef ?? ""}`.toLowerCase().includes(needle),
    );
  }, [extensions, filter]);

  const runtimeById = useMemo(
    () => new Map(runtime.map((entry) => [entry.id, entry])),
    [runtime],
  );

  const globalEnabledCount = extensions.filter((entry) => entry.globallyEnabled).length;
  const agentEnabledCount = extensions.filter((entry) => entry.agentEnabled).length;
  const externalCount = extensions.filter((entry) => entry.source === "external").length;

  const patchExtension = async (extensionId: string, payload: Record<string, unknown>) => {
    setSavingId(extensionId);
    setError(null);
    try {
      const response = await fetch("/api/extensions", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ extensionId, ...payload }),
      });
      const json = await response.json();
      if (!json.success) throw new Error(String(json.error || "Failed to update extension"));
      await loadExtensions(selectedAgentId);
    } catch (patchError) {
      setError(String(patchError));
    } finally {
      setSavingId(null);
    }
  };

  const patchAgentExtension = async (extensionId: string, enabled: boolean) => {
    if (!selectedAgentId) return;
    setSavingId(extensionId);
    setError(null);
    try {
      const response = await fetch("/api/agents/skills", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: selectedAgentId,
          extensionUpdates: [{ id: extensionId, enabled }],
        }),
      });
      const json = await response.json();
      if (!json.success) throw new Error(String(json.error || "Failed to update agent extension"));
      await loadExtensions(selectedAgentId);
    } catch (patchError) {
      setError(String(patchError));
    } finally {
      setSavingId(null);
    }
  };

  const runExtensionAction = async (payload: Record<string, unknown>) => {
    setError(null);
    setInstalling(true);
    try {
      const response = await fetch("/api/extensions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await response.json();
      if (!json.success) throw new Error(String(json.error || "Extension action failed"));
      if (payload.action === "install") {
        setInstallSource("");
        setInstallRef("");
      }
      await loadExtensions(selectedAgentId);
    } catch (actionError) {
      setError(String(actionError));
    } finally {
      setInstalling(false);
    }
  };

  return (
        <main className="flex-1 overflow-auto p-6" data-perf-ready="extensions">
          <div className="mb-6 flex items-center justify-between gap-3">
            <div>
              <h1 className="text-2xl font-bold">Extensions</h1>
              <p className="text-sm text-muted-foreground">
                Global extension lifecycle plus per-agent attachment, so tools can be enabled centrally and scoped per agent.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="outline">{externalCount} external</Badge>
              <Badge variant="outline">{globalEnabledCount}/{extensions.length} globally enabled</Badge>
            </div>
          </div>

          <div className="mb-6 grid gap-4 md:grid-cols-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Installed Extensions</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold">{extensions.length}</div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Globally Enabled</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold">{globalEnabledCount}</div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Enabled For Agent</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold">{agentEnabledCount}</div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">External Sources</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold">{externalCount}</div>
              </CardContent>
            </Card>
          </div>

          {hideGettingStarted ? (
            <div className="mb-6 flex items-center justify-between gap-3 rounded-md border border-dashed px-3 py-2">
              <p className="text-sm text-muted-foreground">
                Extension tips hidden. Global enablement must be on before an agent can use an extension.
              </p>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setHideGettingStarted(false)}
              >
                Show Tips
              </Button>
            </div>
          ) : (
            <div className="mb-6 rounded-md border bg-muted/20 p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                    Getting Started
                  </div>
                  <p className="mt-2 text-sm font-medium">Extensions have two gates: global availability and per-agent attachment.</p>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    Turn on <span className="font-medium text-foreground">global</span> to make an extension available to the runtime,
                    then turn on <span className="font-medium text-foreground">agent</span> for the selected agent. Runtime status,
                    hooks, config JSON, and external security scan results are shown on each registry row.
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setHideGettingStarted(true)}
                >
                  Hide Tips
                </Button>
              </div>
            </div>
          )}

          <Card className="mb-6">
            <CardHeader>
              <CardTitle>Install External Extension</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid gap-3 lg:grid-cols-[1.4fr,0.6fr,auto]">
                <Input
                  placeholder="GitHub repo, git URL, or local path"
                  value={installSource}
                  onChange={(event) => setInstallSource(event.target.value)}
                />
                <Input
                  placeholder="Optional ref or branch"
                  value={installRef}
                  onChange={(event) => setInstallRef(event.target.value)}
                />
                <Button
                  onClick={() => void runExtensionAction({ action: "install", source: installSource, ref: installRef || undefined })}
                  disabled={installing || !installSource.trim()}
                >
                  Install
                </Button>
              </div>
              <div className="text-xs text-muted-foreground">
                Installs are operator-only and tracked locally. Supported sources: local directories, full git URLs, or GitHub shorthand like <code>owner/repo</code>.
                New external installs are added with <code>global off</code> by default until you enable them explicitly.
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle>Extension Registry</CardTitle>
                <div className="flex items-center gap-2">
                  <Select value={selectedAgentId} onValueChange={setSelectedAgentId}>
                    <SelectTrigger className="w-[260px]">
                      <SelectValue placeholder="Select agent" />
                    </SelectTrigger>
                    <SelectContent>
                      {agents.map((agent) => (
                        <SelectItem key={agent.id} value={agent.id}>
                          {agent.name}
                          {agent.isDefault ? " (default)" : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => selectedAgentId && void loadExtensions(selectedAgentId)}
                  >
                    Refresh
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <Input
                placeholder="Filter extensions"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              />
              {error ? <div className="text-sm text-red-400">{error}</div> : null}
              {loading ? (
                <p className="text-sm text-muted-foreground">Loading extensions...</p>
              ) : filtered.length === 0 ? (
                <p className="text-sm text-muted-foreground">No extensions matched.</p>
              ) : (
                <div className="space-y-3">
                  {filtered.map((extension) => {
                    const runtimeEntry = runtimeById.get(extension.id);
                    const draft = configDrafts[extension.id] ?? stringifyConfig(extension.config);
                    return (
                      <div key={extension.id} className="rounded-lg border p-4">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                            <div className="space-y-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <div className="text-sm font-medium">{extension.name}</div>
                              <Badge variant="outline">{extension.source}</Badge>
                              <Badge variant="outline">{extension.installSource}</Badge>
                              <Badge variant={extension.globallyEnabled ? "default" : "secondary"}>
                                {extension.globallyEnabled ? "global on" : "global off"}
                              </Badge>
                              <Badge variant={extension.agentEnabled ? "secondary" : "outline"}>
                                {extension.agentEnabled ? "agent on" : "agent off"}
                              </Badge>
                            </div>
                            <div className="text-xs text-muted-foreground">{extension.description}</div>
                            <div className="text-[11px] text-muted-foreground">
                              {extension.id} • {extension.skillCount} skill pack{extension.skillCount === 1 ? "" : "s"} • {extension.manifestPath}
                            </div>
                            {extension.sourceRef ? (
                              <div className="text-[11px] text-muted-foreground break-all">
                                source: {extension.sourceRef}
                                {extension.installSource === "git" && extension.sourceRevision ? ` • rev ${extension.sourceRevision.slice(0, 12)}` : ""}
                              </div>
                            ) : null}
                            {extension.source === "external" && extension.scanStatus ? (
                              <div className="text-[11px] text-muted-foreground">
                                scan: {extension.scanStatus}
                                {extension.scannedAt ? ` • ${new Date(extension.scannedAt).toLocaleString()}` : ""}
                              </div>
                            ) : null}
                          </div>
                          <div className="flex flex-wrap items-center gap-3 text-xs">
                            <label className="flex items-center gap-2">
                              <input
                                type="checkbox"
                                checked={extension.globallyEnabled}
                                disabled={savingId === extension.id}
                                onChange={(event) =>
                                  void patchExtension(extension.id, { globallyEnabled: event.target.checked })
                                }
                                />
                              global
                            </label>
                            <label className="flex items-center gap-2">
                              <input
                                type="checkbox"
                                checked={Boolean(extension.agentEnabled)}
                                disabled={savingId === extension.id || !extension.globallyEnabled}
                                onChange={(event) =>
                                  void patchAgentExtension(extension.id, event.target.checked)
                                }
                                />
                              agent
                            </label>
                            {extension.source === "external" ? (
                              <>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={installing}
                                  onClick={() => void runExtensionAction({ action: "update", extensionId: extension.id })}
                                >
                                  Update
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={installing}
                                  onClick={() => void runExtensionAction({ action: "uninstall", extensionId: extension.id })}
                                >
                                  Uninstall
                                </Button>
                              </>
                            ) : null}
                          </div>
                        </div>

                        <div className="mt-3 grid gap-4 lg:grid-cols-[1.2fr,0.8fr]">
                          <div className="space-y-2">
                            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                              Config
                            </div>
                            <Textarea
                              className="min-h-[140px] font-mono text-xs"
                              value={draft}
                              onChange={(event) =>
                                setConfigDrafts((current) => ({ ...current, [extension.id]: event.target.value }))
                              }
                            />
                            <div className="flex items-center gap-2">
                              <Button
                                size="sm"
                                onClick={() => {
                                  try {
                                    const parsed = JSON.parse(configDrafts[extension.id] || "{}") as Record<string, unknown>;
                                    void patchExtension(extension.id, { config: parsed });
                                  } catch (parseError) {
                                    setError(`Invalid JSON for ${extension.name}: ${String(parseError)}`);
                                  }
                                }}
                                disabled={savingId === extension.id}
                              >
                                Save Config
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() =>
                                  setConfigDrafts((current) => ({
                                    ...current,
                                    [extension.id]: stringifyConfig(extension.config),
                                  }))
                                }
                              >
                                Reset
                              </Button>
                            </div>
                          </div>

                          <div className="space-y-2">
                            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                              Runtime
                            </div>
                            <div className="rounded-md border bg-muted/20 p-3 text-xs">
                              <div className="mb-1 font-medium">
                                {runtimeEntry?.hasRuntime ? "Loaded" : "No runtime"}
                              </div>
                              <div className="text-muted-foreground">
                                Hooks: {runtimeEntry?.hooks?.join(", ") || "none"}
                              </div>
                              <pre className="mt-2 overflow-auto whitespace-pre-wrap break-words">
                                {JSON.stringify(runtimeEntry?.status ?? {}, null, 2)}
                              </pre>
                            </div>
                            {extension.source === "external" ? (
                              <div className="rounded-md border bg-muted/20 p-3 text-xs">
                                <div className="mb-1 font-medium">
                                  Security Scan {extension.scanStatus ? `(${extension.scanStatus})` : ""}
                                </div>
                                <div className="text-muted-foreground">
                                  {extension.scanSummary || "No scan summary recorded."}
                                </div>
                                {extension.scanFindings && extension.scanFindings.length > 0 ? (
                                  <div className="mt-2 space-y-2">
                                    {extension.scanFindings.slice(0, 6).map((finding, index) => (
                                      <div key={`${extension.id}:scan:${index}`} className="rounded border bg-background/70 p-2">
                                        <div className="font-medium">
                                          {finding.severity} · {finding.title}
                                        </div>
                                        <div className="text-muted-foreground">
                                          {finding.filePath}
                                          {finding.line ? `:${finding.line}` : ""}
                                        </div>
                                        <div className="mt-1 text-muted-foreground">
                                          {finding.summary}
                                        </div>
                                        {finding.excerpt ? (
                                          <pre className="mt-1 overflow-auto whitespace-pre-wrap break-words">
                                            {finding.excerpt}
                                          </pre>
                                        ) : null}
                                      </div>
                                    ))}
                                  </div>
                                ) : null}
                              </div>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </main>
  );
}
